'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function BotonSuscribir({ slug, logueado }: { slug: string; logueado: boolean }) {
  const router = useRouter();
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suscribir = async () => {
    if (!logueado) {
      router.push(`/login?next=/suscripciones`);
      return;
    }

    setCargando(true);
    setError(null);

    try {
      const res = await fetch('/api/subscriptions/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planSlug: slug }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? 'No pudimos iniciar la suscripción');

      // Mercado Pago se encarga del resto: ahí se cargan los datos de la tarjeta
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado');
      setCargando(false);
    }
  };

  return (
    <div>
      <button
        onClick={suscribir}
        disabled={cargando}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-white py-3 font-semibold text-slate-900 transition hover:bg-white/90 disabled:opacity-60"
      >
        {cargando ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparando el pago…
          </>
        ) : logueado ? (
          'Suscribirme'
        ) : (
          'Entrar y suscribirme'
        )}
      </button>
      {error && <p className="mt-2 text-center text-xs text-red-300">{error}</p>}
    </div>
  );
}
