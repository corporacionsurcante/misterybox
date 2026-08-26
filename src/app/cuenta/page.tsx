import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import GestorSuscripciones, { type SuscripcionRow } from './GestorSuscripciones';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Mi cuenta' };

export default async function CuentaPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/cuenta');

  const suscripcionesDb = await prisma.subscription.findMany({
    where: { userId: user.id },
    include: { plan: { include: { merchant: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });

  const suscripciones: SuscripcionRow[] = suscripcionesDb.map((s) => ({
    id: s.id,
    planNombre: s.plan.name,
    proveedor: s.plan.merchant?.name ?? null,
    precio: Number(s.plan.price),
    estado: s.status,
    cajasPorCiclo: s.plan.boxesPerCycle,
    proximoCobro: s.nextChargeAt?.toISOString() ?? null,
    ciclosCobrados: s.cyclesCharged,
    desde: s.startedAt?.toISOString() ?? null,
  }));

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold">Mi cuenta</h1>
          <p className="mt-1 text-slate-400">{user.email}</p>
        </header>

        <section>
          <h2 className="mb-4 text-lg font-semibold">Mis suscripciones</h2>
          <GestorSuscripciones suscripciones={suscripciones} />
        </section>
      </div>
    </main>
  );
}
