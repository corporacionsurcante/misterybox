import { redirect } from 'next/navigation';
import { Gift } from 'lucide-react';
import { auth, signIn } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // Sólo rutas internas. Sin este filtro, un link como
  // /login?next=https://sitio-falso.com sacaba al usuario del dominio real
  // desde una URL legítima — la base de un phishing convincente.
  // El doble slash inicial también hay que bloquearlo: //evil.com es una URL
  // protocol-relative y el navegador la trata como externa.
  const destino = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const session = await auth();
  if (session?.user) redirect(destino);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <Gift className="mx-auto mb-5 h-12 w-12 text-amber-400" />
        <h1 className="mb-2 text-2xl font-bold text-white">Entrá a MisteryBox</h1>
        <p className="mb-8 text-sm text-slate-400">
          Tus cajas y tu saldo quedan asociados a tu cuenta.
        </p>

        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: destino });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-full bg-white py-3.5 font-semibold text-slate-900 transition hover:bg-white/90"
          >
            Continuar con Google
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          Al entrar aceptás los términos y las bases y condiciones de los premios.
        </p>
      </div>
    </main>
  );
}
