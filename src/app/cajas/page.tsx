import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Gift, Clock } from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const TIER_COLOR: Record<string, string> = {
  BRONZE: 'from-amber-700 to-amber-800 ring-amber-600/40',
  SILVER: 'from-slate-400 to-slate-600 ring-slate-300/40',
  GOLD: 'from-yellow-500 to-amber-600 ring-yellow-400/50',
  VIP: 'from-fuchsia-600 to-indigo-600 ring-fuchsia-400/50',
};

export default async function CajasPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/cajas');

  const boxes = await prisma.userBox.findMany({
    where: { userId: session.user.id, status: 'AVAILABLE' },
    include: { boxCatalog: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-3xl font-bold">Mis cajas</h1>
        <p className="mb-8 text-slate-400">
          {boxes.length === 0
            ? 'Todavía no tenés cajas para abrir.'
            : `Tenés ${boxes.length} caja${boxes.length > 1 ? 's' : ''} esperando.`}
        </p>

        {boxes.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center">
            <Gift className="mx-auto mb-4 h-12 w-12 text-slate-600" />
            <p className="mb-5 text-slate-400">
              Comprá desde alguna de nuestras tiendas y tu caja aparece acá.
            </p>
            <Link
              href="/tiendas"
              className="inline-block rounded-full bg-amber-500 px-6 py-3 font-semibold text-slate-900 transition hover:bg-amber-400"
            >
              Ver tiendas
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boxes.map((b) => (
              <Link
                key={b.id}
                href={`/cajas/${b.id}`}
                className={`group rounded-2xl bg-gradient-to-br p-6 ring-2 transition hover:scale-[1.03] ${
                  TIER_COLOR[b.tier] ?? TIER_COLOR.BRONZE
                }`}
              >
                <Gift className="mb-4 h-10 w-10 text-white/90 transition group-hover:scale-110" />
                <h3 className="font-bold text-white">{b.boxCatalog.name}</h3>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-white/70">
                  <Clock className="h-3 w-3" />
                  Vence {b.expiresAt.toLocaleDateString('es-AR')}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
