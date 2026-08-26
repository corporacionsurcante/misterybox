import Link from 'next/link';
import { Gift, Store, Wallet, Sparkles } from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await auth();

  let availableBoxes = 0;
  if (session?.user?.id) {
    availableBoxes = await prisma.userBox.count({
      where: { userId: session.user.id, status: 'AVAILABLE' },
    });
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <section className="mx-auto max-w-5xl px-6 py-24 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-amber-300">
          <Sparkles className="h-3.5 w-3.5" />
          Cada compra tiene premio
        </div>

        <h1 className="mb-5 text-balance text-4xl font-bold leading-tight sm:text-5xl md:text-6xl">
          Comprá donde ya comprás.
          <br />
          <span className="bg-gradient-to-r from-amber-300 to-fuchsia-400 bg-clip-text text-transparent">
            Ganá algo cada vez.
          </span>
        </h1>

        <p className="mx-auto mb-10 max-w-xl text-balance text-lg text-slate-400">
          Entrá a tus tiendas favoritas desde acá y cada compra te desbloquea una Mystery Box
          con premios reales: saldo, vouchers, entradas y productos.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/tiendas"
            className="rounded-full bg-gradient-to-r from-amber-500 to-amber-600 px-8 py-4 font-bold text-slate-900 shadow-[0_0_40px_-8px_rgba(245,158,11,0.7)] transition hover:brightness-110"
          >
            Ver tiendas
          </Link>
          {session ? (
            <Link
              href="/cajas"
              className="flex items-center gap-2 rounded-full border border-white/20 px-8 py-4 font-semibold transition hover:bg-white/10"
            >
              <Gift className="h-5 w-5" />
              Mis cajas
              {availableBoxes > 0 && (
                <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-slate-900">
                  {availableBoxes}
                </span>
              )}
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-full border border-white/20 px-8 py-4 font-semibold transition hover:bg-white/10"
            >
              Entrar
            </Link>
          )}
        </div>
      </section>

      <section className="mx-auto grid max-w-4xl gap-5 px-6 pb-24 sm:grid-cols-3">
        {[
          { icon: Store, title: 'Elegí la tienda', body: 'Entrá desde nuestro directorio y comprá normalmente.' },
          { icon: Gift, title: 'Abrí tu caja', body: 'Confirmada la compra, se acredita una Mystery Box.' },
          { icon: Wallet, title: 'Cobrá el premio', body: 'Saldo, cupón o producto, directo a tu billetera.' },
        ].map((s, i) => (
          <div key={s.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="mb-3 flex items-center gap-3">
              <s.icon className="h-5 w-5 text-amber-400" />
              <span className="text-xs font-semibold text-slate-500">PASO {i + 1}</span>
            </div>
            <h3 className="mb-1.5 font-semibold">{s.title}</h3>
            <p className="text-sm leading-relaxed text-slate-400">{s.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
