import Link from 'next/link';
import { Compass } from 'lucide-react';

export default function NoEncontrada() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md text-center">
        <Compass className="mx-auto mb-5 h-14 w-14 text-slate-600" />
        <h1 className="mb-3 text-2xl font-bold text-white">No encontramos esta página</h1>
        <p className="mb-8 text-sm leading-relaxed text-slate-400">
          Puede que el enlace esté vencido, que la caja ya la hayas abierto, o que el contenido
          haya cambiado de lugar.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/cajas"
            className="rounded-full bg-white px-6 py-3 font-semibold text-slate-900 transition hover:bg-white/90"
          >
            Ver mis cajas
          </Link>
          <Link
            href="/"
            className="rounded-full border border-white/20 px-6 py-3 font-semibold text-white/80 transition hover:bg-white/10"
          >
            Ir al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}
