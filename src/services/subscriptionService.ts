// ============================================================================
// src/services/subscriptionService.ts
// MisteryBox — Suscripciones recurrentes
// ----------------------------------------------------------------------------
// Modelo "merchant of record": la plataforma le cobra el precio completo al
// suscriptor y después le liquida `providerCost` al proveedor del servicio.
//
// La regla financiera que ordena todo el módulo:
//
//     margen bruto  = precio − costo del proveedor
//     aporte al pool = margen bruto × poolShareRate
//     presupuesto por caja = aporte al pool ÷ cajas del ciclo
//
// El costo del proveedor NO es margen: es plata que ya está comprometida. Si
// se calcularan las cajas sobre el precio completo, se estarían repartiendo
// premios financiados con dinero que se le debe a otro.
// ============================================================================

import { Prisma, SubscriptionStatus, ChargeStatus, TransactionStatus, TransactionType } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { contributeToPool } from '@/services/mysteryBoxService';

const d = (v: Prisma.Decimal | number | string): number => Number(v);
const money = (n: number): Prisma.Decimal => new Prisma.Decimal(n.toFixed(2));

export interface ResultadoCobro {
  procesado: boolean;
  motivo?: string;
  cajasOtorgadas?: number;
  transactionId?: string;
}

/**
 * Procesa un cobro de suscripción aprobado: registra la transacción, aporta al
 * pool y otorga las cajas del ciclo.
 *
 * Idempotente por `mpPaymentId`, que tiene índice único. Mercado Pago reenvía
 * la misma notificación varias veces (y ante un error nuestro, reintenta), así
 * que sin esa garantía un solo cobro repartiría cajas cada vez que llega el
 * aviso.
 */
export async function procesarCobroDeSuscripcion(params: {
  mpPaymentId: string;
  mpPreapprovalId: string;
  monto: number;
  estado: ChargeStatus;
  payload?: unknown;
}): Promise<ResultadoCobro> {
  const { mpPaymentId, mpPreapprovalId, monto, estado, payload } = params;

  if (!Number.isFinite(monto) || monto < 0) {
    return { procesado: false, motivo: 'monto-invalido' };
  }

  const suscripcion = await prisma.subscription.findUnique({
    where: { mpPreapprovalId },
    include: { plan: true, user: true },
  });

  if (!suscripcion) {
    return { procesado: false, motivo: 'suscripcion-no-encontrada' };
  }

  // ── Idempotencia: ¿ya procesamos este pago? ──
  const cobroPrevio = await prisma.subscriptionCharge.findUnique({
    where: { mpPaymentId },
  });

  if (cobroPrevio) {
    // Si antes estaba pendiente y ahora se aprobó, seguimos; si no, cortamos.
    if (cobroPrevio.status === ChargeStatus.APPROVED || estado !== ChargeStatus.APPROVED) {
      return {
        procesado: false,
        motivo: 'cobro-ya-procesado',
        cajasOtorgadas: cobroPrevio.boxesGranted,
      };
    }
  }

  const plan = suscripcion.plan;

  // ── Cálculo del margen real ──
  const costoProveedor = d(plan.providerCost);
  const margenBruto = Math.max(0, monto - costoProveedor);
  const aporteAlPool = margenBruto * d(plan.poolShareRate);
  const margenPlataforma = margenBruto - aporteAlPool;

  // Un cobro rechazado o devuelto no otorga nada
  if (estado !== ChargeStatus.APPROVED) {
    await prisma.subscriptionCharge.upsert({
      where: { mpPaymentId },
      create: {
        subscriptionId: suscripcion.id,
        mpPaymentId,
        amount: money(monto),
        status: estado,
        rawPayload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: { status: estado },
    });

    // Un rechazo no cancela la suscripción: Mercado Pago reintenta el cobro.
    // Cancelar acá le cortaría el servicio a alguien por un problema temporal
    // de su tarjeta.
    return { procesado: true, motivo: `cobro-${estado.toLowerCase()}`, cajasOtorgadas: 0 };
  }

  // ── Cobro aprobado: transacción, pool y cajas, todo junto ──
  const resultado = await prisma.$transaction(async (tx) => {
    const transaccion = await tx.transaction.create({
      data: {
        userId: suscripcion.userId,
        type: TransactionType.SUBSCRIPTION,
        // El dinero ya está acreditado: no hay ventana de devolución como en
        // afiliados, así que la comisión entra aprobada y las cajas salen
        // desbloqueadas.
        status: TransactionStatus.APPROVED,
        merchantId: plan.merchantId,
        externalOrderId: mpPaymentId,
        source: 'mercadopago',
        orderAmount: money(monto),
        commissionGross: money(margenBruto),
        poolContribution: money(aporteAlPool),
        platformMargin: money(margenPlataforma),
        approvedAt: new Date(),
        notes: `Suscripción ${plan.name} — costo proveedor ${costoProveedor.toFixed(2)}`,
        rawPayload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    const cobro = await tx.subscriptionCharge.upsert({
      where: { mpPaymentId },
      create: {
        subscriptionId: suscripcion.id,
        transactionId: transaccion.id,
        mpPaymentId,
        amount: money(monto),
        status: ChargeStatus.APPROVED,
        boxesGranted: plan.boxesPerCycle,
        rawPayload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {
        transactionId: transaccion.id,
        status: ChargeStatus.APPROVED,
        boxesGranted: plan.boxesPerCycle,
      },
    });

    // ── Las cajas del ciclo ──
    const catalogo = await tx.boxCatalog.findUnique({ where: { tier: plan.boxTier } });
    if (!catalogo) throw new Error(`No existe el catálogo de cajas ${plan.boxTier}`);

    // El presupuesto se REPARTE entre las cajas del ciclo. Si el plan da 3
    // cajas, cada una vale un tercio: de lo contrario el RTP se multiplicaría
    // por la cantidad de cajas y el pool se vaciaría.
    const cantidad = Math.max(1, plan.boxesPerCycle);
    const presupuestoPorCaja = aporteAlPool / cantidad;
    const vence = new Date(Date.now() + catalogo.expiryDays * 24 * 60 * 60 * 1000);

    await tx.userBox.createMany({
      data: Array.from({ length: cantidad }, () => ({
        userId: suscripcion.userId,
        tier: plan.boxTier,
        boxCatalogId: catalogo.id,
        sourceTransactionId: transaccion.id,
        fundingAmount: money(presupuestoPorCaja),
        expiresAt: vence,
      })),
    });

    await tx.transaction.update({
      where: { id: transaccion.id },
      data: { boxGranted: true },
    });

    await tx.subscription.update({
      where: { id: suscripcion.id },
      data: {
        status: SubscriptionStatus.ACTIVE,
        cyclesCharged: { increment: 1 },
        startedAt: suscripcion.startedAt ?? new Date(),
      },
    });

    return { transactionId: transaccion.id, cajas: cantidad, cobroId: cobro.id };
  });

  // El pool se mueve fuera de la transacción anterior porque toma su propio
  // lock sobre pool_state. Anidarlos invertiría el orden de candados respecto
  // del unboxing y podría trabar las dos operaciones entre sí.
  await contributeToPool({
    transactionId: resultado.transactionId,
    amount: aporteAlPool,
    status: TransactionStatus.APPROVED,
    userId: suscripcion.userId,
  });

  return {
    procesado: true,
    cajasOtorgadas: resultado.cajas,
    transactionId: resultado.transactionId,
  };
}

/** Refleja un cambio de estado de la suscripción reportado por Mercado Pago. */
export async function actualizarEstadoSuscripcion(params: {
  mpPreapprovalId: string;
  estadoMP: string;
}): Promise<boolean> {
  const mapa: Record<string, SubscriptionStatus> = {
    pending: SubscriptionStatus.PENDING,
    authorized: SubscriptionStatus.ACTIVE,
    paused: SubscriptionStatus.PAUSED,
    cancelled: SubscriptionStatus.CANCELLED,
    finished: SubscriptionStatus.EXPIRED,
  };

  const estado = mapa[params.estadoMP.toLowerCase()];
  if (!estado) return false;

  const suscripcion = await prisma.subscription.findUnique({
    where: { mpPreapprovalId: params.mpPreapprovalId },
  });
  if (!suscripcion) return false;

  await prisma.subscription.update({
    where: { id: suscripcion.id },
    data: {
      status: estado,
      ...(estado === SubscriptionStatus.ACTIVE && !suscripcion.startedAt
        ? { startedAt: new Date() }
        : {}),
      ...(estado === SubscriptionStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
    },
  });

  return true;
}

/** Resumen para el panel de administración. */
export async function metricasDeSuscripciones() {
  const [activas, planes, ingresoMensual, cobrosUltimos30] = await Promise.all([
    prisma.subscription.count({ where: { status: SubscriptionStatus.ACTIVE } }),
    prisma.subscriptionPlan.count({ where: { isActive: true } }),
    prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE },
      include: { plan: true },
    }),
    prisma.subscriptionCharge.aggregate({
      where: {
        status: ChargeStatus.APPROVED,
        chargedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const mrr = ingresoMensual.reduce((s, sub) => s + d(sub.plan.price), 0);
  const costoMensual = ingresoMensual.reduce((s, sub) => s + d(sub.plan.providerCost), 0);

  return {
    suscripcionesActivas: activas,
    planesActivos: planes,
    ingresoRecurrenteMensual: mrr,
    costoProveedoresMensual: costoMensual,
    margenRecurrenteMensual: mrr - costoMensual,
    cobrados30d: d(cobrosUltimos30._sum.amount ?? 0),
    cantidadCobros30d: cobrosUltimos30._count._all,
  };
}
