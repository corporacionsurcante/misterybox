import Link from 'next/link';
import { Gift, Store, Wallet, CreditCard, UserRound } from 'lucide-react';
import { auth, signOut } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Barra de navegación presente en todo el sitio.
 *
 * Sin esto, /billetera y /suscripciones sólo eran alcanzables escribiendo la
 * URL a mano: alguien que ganaba saldo no tenía forma de llegar a verlo, y el
 * canal de ingresos recurrentes era invisible.
 */
export default async function Header() {
  const session = await auth();

  let cajasDisponibles = 0;
  if (session?.user?.id) {
    cajasDisponibles = await prisma.userBox.count({
      where: { userId: session.user.id, status: 'AVAILABLE' },
    });
  }

  const enlaces = [
    { href: '/tiendas', texto: 'Tiendas', icono: Store },
    { href: '/suscripciones', texto: 'Suscripciones', icono: CreditCard },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/85 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:gap-4 sm:px-6">
        <Link href="/" className="mr-auto flex items-center gap-2 font-bold text-white">
          <Gift className="h-5 w-5 text-amber-400" />
          <span className="hidden sm:inline">MisteryBox</span>
        </Link>

        {enlaces.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white sm:px-3"
          >
            <e.icono className="h-4 w-4" />
            <span className="hidden sm:inline">{e.texto}</span>
          </Link>
        ))}

        {session?.user ? (
          <>
            <Link
              href="/cajas"
              className="relative flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white sm:px-3"
            >
              <Gift className="h-4 w-4" />
              <span className="hidden sm:inline">Mis cajas</span>
              {cajasDisponibles > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-bold text-slate-900 sm:static sm:ml-1">
                  {cajasDisponibles}
                </span>
              )}
            </Link>

            <Link
              href="/billetera"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white sm:px-3"
            >
              <Wallet className="h-4 w-4" />
              <span className="hidden sm:inline">Billetera</span>
            </Link>

            <Link
              href="/cuenta"
              aria-label="Mi cuenta"
              className="rounded-lg px-2.5 py-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              <UserRound className="h-4 w-4" />
            </Link>

            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button
                type="submit"
                className="hidden rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/10 hover:text-white sm:block"
              >
                Salir
              </button>
            </form>
          </>
        ) : (
          <Link
            href="/login"
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-white/90"
          >
            Entrar
          </Link>
        )}
      </nav>
    </header>
  );
}
