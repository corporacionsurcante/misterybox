import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  MARKETPLACE: 'Marketplace',
  DELIVERY: 'Delivery',
  STREAMING: 'Streaming',
  INSURANCE: 'Seguros',
  TELECOM: 'Internet y telefonía',
  NIGHTLIFE: 'Boliches y fiestas',
  RETAIL: 'Tiendas',
  TRAVEL: 'Viajes',
  OTHER: 'Otros',
};

const MENSAJES_ERROR: Record<string, string> = {
  'comercio-no-disponible': 'Esa tienda no está disponible en este momento. Probá con otra.',
  'comercio-mal-configurado':
    'Esa tienda todavía no está lista para acreditar cajas. Ya estamos trabajando en eso.',
};

export default async function TiendasPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const mensajeError = error ? MENSAJES_ERROR[error] ?? null : null;
  const session = await auth();
  // Solo los comercios encendidos en el panel admin
  const merchants = await prisma.merchant.findMany({
    where: { isActive: true },
    orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  const byCategory = merchants.reduce<Record<string, typeof merchants>>((acc, m) => {
    (acc[m.category] ??= []).push(m);
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-3xl font-bold">Tiendas</h1>
        <p className="mb-6 text-slate-400">
          Entrá desde acá y comprá normalmente. Tu Mystery Box se acredita sola.
        </p>

        {mensajeError && (
          <p
            role="alert"
            className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200"
          >
            {mensajeError}
          </p>
        )}

        {!session?.user && (
          <p className="mb-10 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-200">
            <b>Entrá a tu cuenta antes de comprar.</b> Si no, no podemos saber que la compra fue
            tuya y no vas a recibir tu caja.
          </p>
        )}

        {merchants.length === 0 && (
          <p className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-slate-400">
            No hay tiendas disponibles en este momento.
          </p>
        )}

        {Object.entries(byCategory).map(([cat, list]) => (
          <section key={cat} className="mb-10">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-500">
              {CATEGORY_LABEL[cat] ?? cat}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {list.map((m) => (
                <Link
                  key={m.id}
                  href={`/go/${m.slug}?target=${encodeURIComponent('https://' + m.slug + '.com')}`}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4 transition hover:border-amber-500/40 hover:bg-white/10"
                >
                  <div>
                    <p className="font-semibold">{m.name}</p>
                    <p className="text-xs text-emerald-400">
                      Hasta caja {Number(m.commissionRate) >= 0.05 ? 'Oro' : 'Plata'}
                      <span className="text-slate-500"> según el monto</span>
                    </p>
                  </div>
                  <ExternalLink className="h-4 w-4 shrink-0 text-slate-500" />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
