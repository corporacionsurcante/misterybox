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
import { bullConnection } from '@/lib/redis';
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

  return {
    clickId: String(pick('subid1', 'sub_id', 'subId', 'click_id', 'clickId') ?? ''),
    orderId: String(pick('order_id', 'orderId', 'transaction_id', 'conversion_id') ?? ''),
    orderAmount: Number(pick('order_value', 'amount', 'sale_amount', 'order_amount') ?? 0),
    commission: Number(pick('commission_value', 'commission', 'payout', 'commission_amount') ?? 0),
    status: statusMap[rawStatus] ?? TransactionStatus.PENDING,
    network,
  };
}

// ─────────────────── Worker de webhooks ───────────────────

const webhookWorker = new Worker<AffiliateWebhookJob>(
  'webhooks',
  async (job: Job<AffiliateWebhookJob>) => {
    const { network, payload } = job.data;
    const data = normalize(network, payload);

    if (!data.orderId) throw new Error('Payload sin id de orden');

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
            status: data.status,
            commissionGross: data.commission,
            poolContribution,
            platformMargin: data.commission - poolContribution,
            approvedAt: data.status === TransactionStatus.APPROVED ? new Date() : existing.approvedAt,
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
    const statusChanged = existing?.status !== data.status;

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
      await revokeEscrowForTransaction(trx.id, `Estado ${data.status} reportado por ${network}`);
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

    await prisma.webhookEvent.updateMany({
      where: { source: network, externalId: data.orderId },
      data: { processed: true, processedAt: new Date() },
    });

    return { attributed: true, transactionId: trx.id };
  },
  { connection: bullConnection, concurrency: 5 },
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
