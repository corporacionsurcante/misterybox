'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function ErrorGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] error no controlado:', error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md text-center">
        <AlertTriangle className="mx-auto mb-5 h-14 w-14 text-amber-400" />
        <h1 className="mb-3 text-2xl font-bold text-white">Algo salió mal de nuestro lado</h1>
        <p className="mb-8 text-sm leading-relaxed text-slate-400">
          No es culpa tuya y no perdiste nada: tus cajas, tu saldo y tus premios están a salvo.
          Probá de nuevo en un momento.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={reset}
            className="flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 font-semibold text-slate-900 transition hover:bg-white/90"
          >
            <RotateCcw className="h-4 w-4" />
            Reintentar
          </button>
          <Link
            href="/"
            className="rounded-full border border-white/20 px-6 py-3 font-semibold text-white/80 transition hover:bg-white/10"
          >
            Ir al inicio
          </Link>
        </div>

        {error.digest && (
          <p className="mt-8 font-mono text-xs text-slate-600">
            Código de referencia: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
