import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import AdminPanelClient from './AdminPanelClient';
import { TransactionStatus, RewardStatus } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

const num = (v: unknown) => Number(v ?? 0);

export default async function AdminPage() {
  const admin = await requireAdmin();
  if (!admin) redirect('/');

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pool, agg, approvedAgg, pendingAgg, unlocked, locked, payouts, boxes24h, users24h, receipts, merchantRows, prizeRows, flagRows, catalogs] =
    await Promise.all([
      prisma.poolState.findUnique({ where: { id: 'singleton' } }),
      prisma.transaction.aggregate({ _sum: { orderAmount: true, commissionGross: true } }),
      prisma.transaction.aggregate({ where: { status: TransactionStatus.APPROVED }, _sum: { commissionGross: true } }),
      prisma.transaction.aggregate({ where: { status: TransactionStatus.PENDING }, _sum: { commissionGross: true } }),
      prisma.userReward.aggregate({ where: { status: RewardStatus.UNLOCKED }, _sum: { realCost: true } }),
      prisma.userReward.aggregate({ where: { status: RewardStatus.LOCKED }, _sum: { realCost: true } }),
      prisma.userReward.aggregate({
        where: { status: { in: [RewardStatus.UNLOCKED, RewardStatus.CLAIMED] } },
        _sum: { realCost: true },
      }),
      prisma.boxOpening.count({ where: { createdAt: { gte: since24h } } }),
      prisma.boxOpening.findMany({
        where: { createdAt: { gte: since24h } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      prisma.receiptValidation.count({ where: { status: 'MANUAL_REVIEW' } }),
      prisma.merchant.findMany({ orderBy: { name: 'asc' } }),
      prisma.prize.findMany({ include: { boxCatalog: true }, orderBy: { realCost: 'asc' } }),
      prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
      prisma.boxCatalog.findMany({ where: { isActive: true } }),
    ]);

  // Órdenes y comisión de los últimos 30 días, por comercio
  const perMerchant = await prisma.transaction.groupBy({
    by: ['merchantId'],
    where: { createdAt: { gte: since30d }, merchantId: { not: null } },
    _count: { _all: true },
    _sum: { commissionGross: true },
  });
  const statsByMerchant = new Map(
    perMerchant.map((r) => [r.merchantId, { count: r._count._all, commission: num(r._sum.commissionGross) }]),
  );

  const poolAvailable = num(pool?.availableBalance);
  const reserveFloor = num(pool?.reserveFloor);
  const commissionGross = num(agg._sum.commissionGross);
  const totalPayout = num(payouts._sum.realCost);
  const lifetimeContributions = num(pool?.lifetimeContributions);

  const metrics = {
    gmv: num(agg._sum.orderAmount),
    commissionGross,
    commissionApproved: num(approvedAgg._sum.commissionGross),
    commissionPending: num(pendingAgg._sum.commissionGross),
    poolAvailable,
    poolReserved: num(pool?.reservedBalance),
    jackpotBalance: num(pool?.jackpotBalance),
    liabilityUnlocked: num(unlocked._sum.realCost),
    liabilityLocked: num(locked._sum.realCost),
    rtpTheoretical: catalogs.length
      ? catalogs.reduce((s, c) => s + num(c.targetRtp), 0) / catalogs.length
      : 0.5,
    rtpReal: lifetimeContributions > 0 ? totalPayout / lifetimeContributions : 0,
    netMargin: commissionGross - totalPayout,
    boxesOpened24h: boxes24h,
    activeUsers24h: users24h.length,
    receiptsInReview: receipts,
  };

  const merchants = merchantRows.map((m) => {
    const s = statsByMerchant.get(m.id);
    return {
      id: m.id,
      slug: m.slug,
      name: m.name,
      category: m.category,
      integrationType: m.integrationType,
      isActive: m.isActive,
      commissionRate: num(m.commissionRate),
      poolShareRate: num(m.poolShareRate),
      transactions30d: s?.count ?? 0,
      commission30d: s?.commission ?? 0,
    };
  });

  const prizes = prizeRows.map((p) => {
    const cost = num(p.realCost);
    const mult = num(p.poolSafetyMultiplier);
    return {
      id: p.id,
      name: p.name,
      tier: p.boxCatalog.tier,
      type: p.type,
      realCost: cost,
      perceivedValue: num(p.perceivedValue),
      baseWeight: p.baseWeight,
      stock: p.stock,
      stockClaimed: p.stockClaimed,
      poolSafetyMultiplier: mult,
      isActive: p.isActive,
      // Misma regla que aplica el motor en runtime
      eligibleNow: cost <= 0 || poolAvailable - reserveFloor >= cost * mult,
    };
  });

  const flags = flagRows.map((f) => ({
    key: f.key,
    enabled: f.enabled,
    description: f.description,
  }));

  return <AdminPanelClient metrics={metrics} merchants={merchants} prizes={prizes} flags={flags} />;
}
