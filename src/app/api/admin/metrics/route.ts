import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { TransactionStatus, RewardStatus } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const num = (v: unknown) => Number(v ?? 0);

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [pool, agg, approvedAgg, pendingAgg, liabilityUnlocked, liabilityLocked, payouts, boxes24h, users24h, receipts] =
    await Promise.all([
      prisma.poolState.findUnique({ where: { id: 'singleton' } }),
      prisma.transaction.aggregate({ _sum: { orderAmount: true, commissionGross: true } }),
      prisma.transaction.aggregate({
        where: { status: TransactionStatus.APPROVED },
        _sum: { commissionGross: true },
      }),
      prisma.transaction.aggregate({
        where: { status: TransactionStatus.PENDING },
        _sum: { commissionGross: true },
      }),
      prisma.userReward.aggregate({
        where: { status: RewardStatus.UNLOCKED },
        _sum: { realCost: true },
      }),
      prisma.userReward.aggregate({
        where: { status: RewardStatus.LOCKED },
        _sum: { realCost: true },
      }),
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
    ]);

  const commissionGross = num(agg._sum.commissionGross);
  const totalPayout = num(payouts._sum.realCost);

  // RTP teórico ponderado por el objetivo de cada tier activo
  const catalogs = await prisma.boxCatalog.findMany({ where: { isActive: true } });
  const rtpTheoretical = catalogs.length
    ? catalogs.reduce((s, c) => s + num(c.targetRtp), 0) / catalogs.length
    : 0.5;

  const poolContributions = num(pool?.lifetimeContributions);

  return NextResponse.json({
    gmv: num(agg._sum.orderAmount),
    commissionGross,
    commissionApproved: num(approvedAgg._sum.commissionGross),
    commissionPending: num(pendingAgg._sum.commissionGross),
    poolAvailable: num(pool?.availableBalance),
    poolReserved: num(pool?.reservedBalance),
    jackpotBalance: num(pool?.jackpotBalance),
    liabilityUnlocked: num(liabilityUnlocked._sum.realCost),
    liabilityLocked: num(liabilityLocked._sum.realCost),
    rtpTheoretical,
    // RTP real = lo que efectivamente pagamos sobre lo que entró al pool
    rtpReal: poolContributions > 0 ? totalPayout / poolContributions : 0,
    netMargin: commissionGross - totalPayout,
    boxesOpened24h: boxes24h,
    activeUsers24h: users24h.length,
    receiptsInReview: receipts,
  });
}
