import { redirect } from 'next/navigation';
import { Lock, Wallet, Check } from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  LOCKED: { text: 'En verificación', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  UNLOCKED: { text: 'Disponible', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  CLAIMED: { text: 'Canjeado', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  EXPIRED: { text: 'Vencido', cls: 'bg-slate-500/15 text-slate-500 border-slate-600/30' },
  REVOKED: { text: 'Anulado', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

export default async function BilleteraPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/billetera');

  const [user, rewards] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { balanceAvailable: true, balanceLocked: true },
    }),
    prisma.userReward.findMany({
      where: { userId: session.user.id },
      include: { prize: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-3xl font-bold">Mi billetera</h1>

        <div className="mb-10 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6">
            <div className="mb-2 flex items-center gap-2 text-sm text-emerald-300">
              <Wallet className="h-4 w-4" /> Disponible
            </div>
            <p className="text-3xl font-bold tabular-nums">{fmt(Number(user?.balanceAvailable ?? 0))}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6">
            <div className="mb-2 flex items-center gap-2 text-sm text-amber-300">
              <Lock className="h-4 w-4" /> En verificación
            </div>
            <p className="text-3xl font-bold tabular-nums">{fmt(Number(user?.balanceLocked ?? 0))}</p>
            <p className="mt-1 text-xs text-amber-200/60">
              Se libera cuando la tienda confirme tu compra
            </p>
          </div>
        </div>

        <h2 className="mb-4 text-lg font-semibold">Mis premios</h2>

        {rewards.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-slate-400">
            Todavía no ganaste ningún premio.
          </p>
        ) : (
          <ul className="space-y-3">
            {rewards.map((r) => {
              const badge = STATUS_LABEL[r.status] ?? STATUS_LABEL.CLAIMED;
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{r.prize.name}</p>
                    <p className="text-xs text-slate-500">
                      {r.createdAt.toLocaleDateString('es-AR')}
                      {r.redemptionCode && (
                        <>
                          {' · '}
                          <code className="font-mono text-slate-400">{r.redemptionCode}</code>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums text-slate-300">
                      {fmt(Number(r.perceivedValue))}
                    </span>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${badge.cls}`}>
                      {r.status === 'UNLOCKED' && <Check className="mr-1 inline h-3 w-3" />}
                      {badge.text}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
