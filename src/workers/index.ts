/**
 * src/workers/index.ts — proceso worker (NO corre en Vercel)
 *
 * Vercel es serverless: no mantiene procesos vivos, así que este archivo se
 * despliega aparte (Railway, Render, Fly). Correr con: npm run worker
 *
 * Procesa:
 *  · cola `webhooks`  → conversiones de afiliados
 *  · cron interno     → liberación de escrow y expiración de cajas
 */
import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { getBullConnection } from '@/lib/redis';
import { prisma } from '@/lib/prisma';
import type { AffiliateWebhookJob } from '@/lib/queues';
import {
  contributeToPool,
  assignMysteryBoxToUser,
  releaseEscrowForTransaction,
  revokeEscrowForTransaction,
} from '@/services/mysteryBoxService';
import { TransactionStatus, TransactionType, UserBoxStatus } from '@/generated/prisma/client';

// ─────────────────── Normalización de payloads ───────────────────

/** Cada red manda campos distintos. Acá los llevamos a una forma única. */
function normalize(network: string, payload: Record<string, unknown>) {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (payload[k] !== undefined && payload[k] !== null) return payload[k];
    return undefined;
  };

  const rawStatus = String(pick('status', 'state', 'conversion_status') ?? 'pending').toLowerCase();

  const statusMap: Record<string, TransactionStatus> = {
    pending: TransactionStatus.PENDING,
    new: TransactionStatus.PENDING,
    approved: TransactionStatus.APPROVED,
    confirmed: TransactionStatus.APPROVED,
    validated: TransactionStatus.APPROVED,
    rejected: TransactionStatus.REJECTED,
    declined: TransactionStatus.REJECTED,
    refunded: TransactionStatus.REFUNDED,
    returned: TransactionStatus.REFUNDED,
    cancelled: TransactionStatus.CANCELLED,
  };

  // Los montos llegan como texto y cada red usa su propio formato. Un valor
  // como "1.234,56" o "$1200" produce NaN, y un NaN que entra al pool anula
  // para siempre la válvula de solvencia (toda comparación con NaN da false,
  // así que cualquier premio pasa el filtro). Se parsea con tolerancia y, si
  // aun así no da un número, se descarta el aporte.
  const toNumber = (raw: unknown): number => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
    if (typeof raw !== 'string') return NaN;
    let s = raw.trim().replace(/[^0-9.,-]/g, '');
    // Si al limpiar no queda ningún dígito, es un valor ilegible, no un cero.
    // Devolver 0 acá haría pasar una comisión rota como "comisión cero" en vez
    // de mandarla a revisión manual.
    if (!/[0-9]/.test(s)) return NaN;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // formato es-AR: 1.234,56 → el separador decimal es la coma
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  return {
    clickId: String(pick('subid1', 'sub_id', 'subId', 'click_id', 'clickId') ?? ''),
    orderId: String(pick('order_id', 'orderId', 'transaction_id', 'conversion_id') ?? ''),
    orderAmount: toNumber(pick('order_value', 'amount', 'sale_amount', 'order_amount') ?? 0),
    commission: toNumber(pick('commission_value', 'commission', 'payout', 'commission_amount') ?? 0),
    status: statusMap[rawStatus] ?? TransactionStatus.PENDING,
    network,
  };
}

// ─────────────────── Antifraude de conversiones ───────────────────

/** Techo absoluto por conversión. Arriba de esto va a revisión humana. */
const COMISION_MAXIMA_AUTOMATICA = Number(process.env.MAX_COMISION_AUTO ?? 500000);

/**
 * Verifica que la conversión reportada sea coherente con lo que la plataforma
 * sabe del comercio y del clic. Devuelve el motivo del rechazo, o null si pasa.
 */
function validarConversion(
  data: { orderAmount: number; commission: number; orderId: string },
  click: { expiresAt: Date; merchant: { network: string | null; commissionRate: unknown; minOrderAmount: unknown } },
  network: string,
): string | null {
  // El clic venció: la ventana de atribución del comercio ya pasó.
  if (click.expiresAt < new Date()) return 'clic-vencido';

  // La red que reporta tiene que ser la que gestiona ese comercio. Si no,
  // cualquier red con secreto válido podría reclamar clics de comercios ajenos.
  const redDelComercio = click.merchant.network;
  if (redDelComercio && redDelComercio !== 'direct' && redDelComercio !== network) {
    return 'red-no-coincide';
  }

  if (data.orderAmount < 0 || data.commission < 0) return 'montos-negativos';

  const minimo = Number(click.merchant.minOrderAmount ?? 0);
  if (data.orderAmount < minimo) return 'monto-bajo-el-minimo';

  // Techo absoluto: una comisión gigante es un error de la red o un ataque.
  if (data.commission > COMISION_MAXIMA_AUTOMATICA) return 'comision-sobre-el-techo';

  // La comisión tiene que guardar relación con la tasa pactada. Se permite
  // holgura porque las redes aplican bonus, promociones y comisiones por
  // categoría, pero no un múltiplo arbitrario.
  const tasa = Number(click.merchant.commissionRate ?? 0);
  if (tasa > 0 && data.orderAmount > 0) {
    const esperada = data.orderAmount * tasa;
    const techo = Math.max(esperada * 3, esperada + 1000);
    if (data.commission > techo) return 'comision-desproporcionada';
  }

  // Sin monto de orden no se puede validar nada: sólo se aceptan comisiones chicas.
  if (data.orderAmount === 0 && data.commission > 5000) return 'comision-sin-orden';

  return null;
}

// ─────────────────── Worker de webhooks ───────────────────

const webhookWorker = new Worker<AffiliateWebhookJob>(
  'webhooks',
  async (job: Job<AffiliateWebhookJob>) => {
    const { network, payload } = job.data;
    const data = normalize(network, payload);

    if (!data.orderId) throw new Error('Payload sin id de orden');

    if (!Number.isFinite(data.commission) || !Number.isFinite(data.orderAmount)) {
      console.error(
        `[webhooks] montos ilegibles en la orden ${data.orderId} (${network}). ` +
          'Queda en webhook_events para revisión manual.',
      );
      return { attributed: false, reason: 'montos-invalidos' };
    }

    // 1. Atribuir al usuario vía el click original
    const click = data.clickId
      ? await prisma.affiliateClick.findUnique({
          where: { id: data.clickId },
          include: { merchant: true },
        })
      : null;

    if (!click) {
      console.warn(`[webhooks] click_id no encontrado: ${data.clickId} (orden ${data.orderId})`);
      // No es un error reintentable: la comisión existe pero no sabemos de quién es.
      // Queda en webhook_events para revisión manual.
      return { attributed: false };
    }

    // ── Validación de la conversión reportada ──
    //
    // Sin estos controles, quien tenga el secreto de UNA red podía mandar
    // {commission: 5000000} sobre su propio click y acuñar saldo retirable:
    // el pool se inflaba, la válvula de solvencia dejaba de filtrar y la caja
    // pagaba un premio en efectivo contra plata que nunca existió.
    const problema = validarConversion(data, click, network);
    if (problema) {
      console.error(
        `[webhooks] conversión rechazada (${problema}) — orden ${data.orderId}, red ${network}, ` +
          `monto ${data.orderAmount}, comisión ${data.commission}. Queda para revisión manual.`,
      );
      return { attributed: false, reason: problema };
    }

    const poolShare = Number(click.merchant.poolShareRate);
    const poolContribution = data.commission * poolShare;

    // 2. Upsert idempotente de la transacción
    const existing = await prisma.transaction.findUnique({
      where: { source_externalOrderId: { source: network, externalOrderId: data.orderId } },
    });

    const escrowReleaseAt = new Date(
      Date.now() + click.merchant.approvalWindowDays * 24 * 60 * 60 * 1000,
    );

    const trx = existing
      ? await prisma.transaction.update({
          where: { id: existing.id },
          data: {
            // El status NO se toca acá: se persiste después de mover el dinero.
            commissionGross: data.commission,
            poolContribution,
            platformMargin: data.commission - poolContribution,
            rawPayload: payload as never,
          },
        })
      : await prisma.transaction.create({
          data: {
            userId: click.userId,
            type: TransactionType.AFFILIATE_ORDER,
            status: data.status,
            merchantId: click.merchantId,
            clickId: click.id,
            externalOrderId: data.orderId,
            source: network,
            orderAmount: data.orderAmount,
            commissionGross: data.commission,
            poolContribution,
            platformMargin: data.commission - poolContribution,
            escrowReleaseAt,
            rawPayload: payload as never,
          },
        });

    // 3. Mover el pool según el estado
    //
    // El estado nuevo se persiste DESPUÉS de mover el dinero, no antes.
    // Al revés, un fallo entre ambos pasos dejaba la transacción marcada como
    // aprobada (o reembolsada) sin que el pool se hubiera movido, y el reintento
    // de BullMQ veía `statusChanged === false` y salteaba el movimiento para
    // siempre. La plata quedaba en el limbo sin forma de recuperarla.
    //
    // `estadoPrevio` viaja explícito a la revocación: releerlo de la base
    // devolvería el estado nuevo y no diría de qué bucket sacar la comisión.
    const estadoPrevio = existing?.status;
    const statusChanged = estadoPrevio !== data.status;

    if (!existing) {
      await contributeToPool({
        transactionId: trx.id,
        amount: poolContribution,
        status: data.status,
        userId: click.userId,
      });
    } else if (statusChanged && data.status === TransactionStatus.APPROVED) {
      await contributeToPool({
        transactionId: trx.id,
        amount: poolContribution,
        status: TransactionStatus.APPROVED,
        userId: click.userId,
      });
      await releaseEscrowForTransaction(trx.id);
    } else if (
      statusChanged &&
      (data.status === TransactionStatus.REFUNDED ||
        data.status === TransactionStatus.REJECTED ||
        data.status === TransactionStatus.CANCELLED)
    ) {
      await revokeEscrowForTransaction(
        trx.id,
        `Estado ${data.status} reportado por ${network}`,
        estadoPrevio,
      );
    }

    // Recién ahora se persiste el estado nuevo: si algo de lo anterior falló,
    // la transacción sigue en su estado viejo y el reintento vuelve a entrar
    // por la misma rama.
    if (statusChanged) {
      await prisma.transaction.update({
        where: { id: trx.id },
        data: {
          status: data.status,
          approvedAt: data.status === TransactionStatus.APPROVED ? new Date() : trx.approvedAt,
          rejectedAt:
            data.status === TransactionStatus.REJECTED || data.status === TransactionStatus.REFUNDED
              ? new Date()
              : trx.rejectedAt,
        },
      });
    }

    // 4. Otorgar la caja (una sola vez, y solo si la orden no está caída)
    if (
      !trx.boxGranted &&
      (data.status === TransactionStatus.PENDING || data.status === TransactionStatus.APPROVED)
    ) {
      const boxId = await assignMysteryBoxToUser({
        userId: click.userId,
        transactionId: trx.id,
        commission: data.commission,
        orderAmount: data.orderAmount,
        poolShareRate: poolShare,
      });
      console.log(`[webhooks] caja ${boxId} otorgada a ${click.userId}`);
    }

    // La clave del evento incluye el estado (ver el route del webhook), así que
    // se marca por prefijo de orden para no dejar filas colgadas.
    await prisma.webhookEvent.updateMany({
      where: { source: network, externalId: { startsWith: `${data.orderId}:` } },
      data: { processed: true, processedAt: new Date() },
    });

    return { attributed: true, transactionId: trx.id };
  },
  { connection: getBullConnection(), concurrency: 5 },
);

webhookWorker.on('failed', (job, err) => {
  console.error(`[webhooks] job ${job?.id} falló:`, err.message);
});

webhookWorker.on('completed', (job) => {
  console.log(`[webhooks] job ${job.id} ok`);
});

// ─────────────────── Tareas periódicas ───────────────────

/**
 * Cada hora:
 *  · libera premios cuya ventana de devolución ya venció
 *  · expira cajas sin abrir
 */
async function runPeriodicTasks() {
  try {
    const now = new Date();

    const toRelease = await prisma.transaction.findMany({
      where: {
        status: TransactionStatus.APPROVED,
        escrowReleaseAt: { lte: now },
        userBoxes: { some: { reward: { status: 'LOCKED' } } },
      },
      select: { id: true },
      take: 200,
    });

    for (const t of toRelease) {
      const n = await releaseEscrowForTransaction(t.id);
      if (n > 0) console.log(`[cron] liberados ${n} premios de la tx ${t.id}`);
    }

    const expired = await prisma.userBox.updateMany({
      where: { status: UserBoxStatus.AVAILABLE, expiresAt: { lt: now } },
      data: { status: UserBoxStatus.EXPIRED },
    });
    if (expired.count > 0) console.log(`[cron] ${expired.count} cajas expiradas`);
  } catch (err) {
    console.error('[cron] error:', err);
  }
}

setInterval(runPeriodicTasks, 60 * 60 * 1000);
void runPeriodicTasks();

console.log('Worker MisteryBox arriba. Escuchando colas: webhooks, receipts.');

// Apagado limpio: termina los jobs en vuelo antes de morir.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    console.log(`\n${signal} recibido, cerrando worker…`);
    await webhookWorker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
