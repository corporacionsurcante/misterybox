import { Check, Gift, Sparkles } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import BotonSuscribir from './BotonSuscribir';

export const dynamic = 'force-dynamic';

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

const TIER_STYLE: Record<string, string> = {
  BRONZE: 'from-amber-700 to-amber-800',
  SILVER: 'from-slate-400 to-slate-600',
  GOLD: 'from-yellow-500 to-amber-600',
  VIP: 'from-fuchsia-600 to-indigo-600',
};

const TIER_NOMBRE: Record<string, string> = {
  BRONZE: 'Bronce',
  SILVER: 'Plata',
  GOLD: 'Oro',
  VIP: 'VIP',
};

export default async function SuscripcionesPage() {
  const session = await auth();

  const [planes, misSuscripciones] = await Promise.all([
    prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { price: 'asc' }],
      include: { merchant: true },
    }),
    session?.user?.id
      ? prisma.subscription.findMany({
          where: { userId: session.user.id, status: { in: ['ACTIVE', 'PENDING'] } },
          select: { planId: true, status: true },
        })
      : Promise.resolve([]),
  ]);

  const yaSuscripto = new Map(misSuscripciones.map((s) => [s.planId, s.status]));

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-14 text-white">
      <div className="mx-auto max-w-5xl">
        <header className="mb-12 text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-fuchsia-300">
            <Sparkles className="h-3.5 w-3.5" />
            Cajas todos los meses
          </div>
          <h1 className="mb-4 text-balance text-4xl font-bold sm:text-5xl">
            Suscribite y ganá sin comprar nada
          </h1>
          <p className="mx-auto max-w-xl text-balance text-lg text-slate-400">
            Contratá un servicio y cada mes que se renueva te acreditamos tus Mystery Box.
            No es una vez: es todos los meses.
          </p>
        </header>

        {planes.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center text-slate-400">
            Todavía no hay planes disponibles. Volvé pronto.
          </p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {planes.map((plan) => {
              const estado = yaSuscripto.get(plan.id);
              const beneficios = Array.isArray(plan.benefits) ? (plan.benefits as string[]) : [];

              return (
                <article
                  key={plan.id}
                  className={`relative flex flex-col rounded-2xl border bg-white/5 p-6 ${
                    plan.isFeatured ? 'border-amber-500/50 shadow-[0_0_50px_-16px_rgba(245,158,11,.6)]' : 'border-white/10'
                  }`}
                >
                  {plan.isFeatured && (
                    <span className="absolute -top-3 left-6 rounded-full bg-amber-500 px-3 py-0.5 text-xs font-bold text-slate-900">
                      Más elegido
                    </span>
                  )}

                  {plan.merchant && (
                    <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                      {plan.merchant.name}
                    </p>
                  )}
                  <h2 className="mb-2 text-xl font-bold">{plan.name}</h2>

                  {plan.description && (
                    <p className="mb-5 text-sm leading-relaxed text-slate-400">{plan.description}</p>
                  )}

                  <div className="mb-5">
                    <span className="text-3xl font-bold tabular-nums">{fmt(Number(plan.price))}</span>
                    <span className="text-sm text-slate-500">
                      {plan.frequencyType === 'days' ? ' / día' : plan.frequency === 1 ? ' / mes' : ` / ${plan.frequency} meses`}
                    </span>
                  </div>

                  <div
                    className={`mb-5 flex items-center gap-3 rounded-xl bg-gradient-to-r p-3.5 ${
                      TIER_STYLE[plan.boxTier] ?? TIER_STYLE.SILVER
                    }`}
                  >
                    <Gift className="h-6 w-6 shrink-0 text-white" />
                    <div className="text-sm leading-tight text-white">
                      <b>
                        {plan.boxesPerCycle} caja{plan.boxesPerCycle > 1 ? 's' : ''}{' '}
                        {TIER_NOMBRE[plan.boxTier] ?? plan.boxTier}
                      </b>
                      <span className="block text-white/75">cada renovación</span>
                    </div>
                  </div>

                  {beneficios.length > 0 && (
                    <ul className="mb-6 space-y-2">
                      {beneficios.map((b) => (
                        <li key={b} className="flex items-start gap-2 text-sm text-slate-300">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-auto">
                    {estado === 'ACTIVE' ? (
                      <div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 py-3 text-center text-sm font-semibold text-emerald-300">
                        Ya estás suscripto
                      </div>
                    ) : estado === 'PENDING' ? (
                      <div className="rounded-full border border-amber-500/40 bg-amber-500/10 py-3 text-center text-sm font-semibold text-amber-300">
                        Falta autorizar el pago
                      </div>
                    ) : (
                      <BotonSuscribir slug={plan.slug} logueado={Boolean(session?.user)} />
                    )}
                  </div>

                  {plan.freeTrialDays ? (
                    <p className="mt-3 text-center text-xs text-slate-500">
                      {plan.freeTrialDays} días de prueba gratis
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

        <p className="mx-auto mt-12 max-w-lg text-center text-xs leading-relaxed text-slate-500">
          El cobro es automático con la tarjeta que autorices en Mercado Pago. Podés cancelar
          cuando quieras desde tu cuenta y no se te cobra el mes siguiente.
        </p>
      </div>
    </main>
  );
}
