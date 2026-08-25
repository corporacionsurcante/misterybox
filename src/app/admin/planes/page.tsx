import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import GestorPlanes, { type PlanRow, type ProveedorOpcion } from './GestorPlanes';

export const dynamic = 'force-dynamic';

export default async function AdminPlanesPage() {
  const admin = await requireAdmin();
  if (!admin) redirect('/');

  const [planesDb, proveedoresDb] = await Promise.all([
    prisma.subscriptionPlan.findMany({
      include: {
        merchant: { select: { name: true } },
        _count: { select: { subscriptions: { where: { status: { in: ['ACTIVE', 'PENDING'] } } } } },
      },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    }),
    prisma.merchant.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const planes: PlanRow[] = planesDb.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    merchantId: p.merchantId,
    merchantName: p.merchant?.name ?? null,
    price: Number(p.price),
    providerCost: Number(p.providerCost),
    boxesPerCycle: p.boxesPerCycle,
    boxTier: p.boxTier,
    poolShareRate: Number(p.poolShareRate),
    freeTrialDays: p.freeTrialDays,
    benefits: Array.isArray(p.benefits) ? (p.benefits as string[]) : [],
    isActive: p.isActive,
    isFeatured: p.isFeatured,
    suscriptores: p._count.subscriptions,
    vinculadoAMP: Boolean(p.mpPreapprovalPlanId),
  }));

  const proveedores: ProveedorOpcion[] = proveedoresDb;

  return (
    <>
      <div className="bg-slate-950 px-6 pt-6">
        <div className="mx-auto max-w-5xl">
          <Link
            href="/admin"
            className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" /> Volver al panel
          </Link>
        </div>
      </div>
      <GestorPlanes planes={planes} proveedores={proveedores} />
    </>
  );
}
