import Link from 'next/link';
import { CheckCircle2, Clock, Gift } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Mercado Pago devuelve al usuario acá después de autorizar el débito.
 *
 * Importante: esta pantalla NO acredita nada. La suscripción se activa y las
 * cajas se otorgan cuando llega la notificación firmada de Mercado Pago al
 * webhook. Si acreditáramos por la vuelta del navegador, cualquiera podría
 * escribir esta URL a mano y regalarse cajas.
 */
export default async function GraciasPage({
  searchParams,
}: {
  searchParams: Promise<{ preapproval_id?: string; status?: string }>;
}) {
  const { status } = await searchParams;
  const rechazado = status === 'rejected' || status === 'cancelled';

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        {rechazado ? (
          <>
            <Clock className="mx-auto mb-5 h-14 w-14 text-amber-400" />
            <h1 className="mb-3 text-2xl font-bold text-white">No se completó el pago</h1>
            <p className="mb-8 text-sm leading-relaxed text-slate-400">
              La autorización no llegó a confirmarse. No se te cobró nada. Podés intentar de nuevo
              con otro medio de pago cuando quieras.
            </p>
            <Link
              href="/suscripciones"
              className="inline-block rounded-full bg-white px-8 py-3 font-semibold text-slate-900 transition hover:bg-white/90"
            >
              Volver a los planes
            </Link>
          </>
        ) : (
          <>
            <CheckCircle2 className="mx-auto mb-5 h-14 w-14 text-emerald-400" />
            <h1 className="mb-3 text-2xl font-bold text-white">¡Suscripción confirmada!</h1>
            <p className="mb-6 text-sm leading-relaxed text-slate-400">
              Mercado Pago está procesando el primer cobro. Apenas se acredite, tus cajas aparecen
              solas en tu cuenta — suele tardar menos de un minuto.
            </p>

            <div className="mb-8 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left">
              <Gift className="h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-xs leading-relaxed text-amber-100/80">
                Cada mes que se renueve tu suscripción vas a recibir cajas nuevas,
                automáticamente.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <Link
                href="/cajas"
                className="rounded-full bg-white px-8 py-3 font-semibold text-slate-900 transition hover:bg-white/90"
              >
                Ver mis cajas
              </Link>
              <Link
                href="/"
                className="rounded-full border border-white/20 px-8 py-3 font-semibold text-white/80 transition hover:bg-white/10"
              >
                Ir al inicio
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
