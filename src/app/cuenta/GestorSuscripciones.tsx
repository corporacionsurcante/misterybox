'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Calendar, Gift, Loader2, X } from 'lucide-react';

export interface SuscripcionRow {
  id: string;
  planNombre: string;
  proveedor: string | null;
  precio: number;
  estado: string;
  cajasPorCiclo: number;
  proximoCobro: string | null;
  ciclosCobrados: number;
  desde: string | null;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

const ESTADO: Record<string, { texto: string; clase: string }> = {
  ACTIVE: { texto: 'Activa', clase: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  PENDING: { texto: 'Falta autorizar el pago', clase: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  PAUSED: { texto: 'Pausada', clase: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  CANCELLED: { texto: 'Dada de baja', clase: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  EXPIRED: { texto: 'Finalizada', clase: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

export default function GestorSuscripciones({ suscripciones }: { suscripciones: SuscripcionRow[] }) {
  const router = useRouter();
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [mensaje, setMensaje] = useState<{ texto: string; tipo: 'ok' | 'error' } | null>(null);

  const cancelar = async (id: string) => {
    setProcesando(true);
    setMensaje(null);
    try {
      const res = await fetch('/api/subscriptions/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'No pudimos dar de baja la suscripción');

      setMensaje({ texto: data.mensaje ?? 'Suscripción dada de baja.', tipo: 'ok' });
      setConfirmando(null);
      router.refresh();
    } catch (e) {
      setMensaje({ texto: e instanceof Error ? e.message : 'Error inesperado', tipo: 'error' });
    } finally {
      setProcesando(false);
    }
  };

  if (suscripciones.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center">
        <Gift className="mx-auto mb-4 h-10 w-10 text-slate-600" />
        <p className="mb-5 text-slate-400">Todavía no tenés ninguna suscripción.</p>
        <a
          href="/suscripciones"
          className="inline-block rounded-full bg-amber-500 px-6 py-3 font-semibold text-slate-900 transition hover:bg-amber-400"
        >
          Ver los planes
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {mensaje && (
        <div
          role="status"
          className={`rounded-xl border p-4 text-sm ${
            mensaje.tipo === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-red-500/40 bg-red-500/10 text-red-200'
          }`}
        >
          {mensaje.texto}
        </div>
      )}

      {suscripciones.map((s) => {
        const badge = ESTADO[s.estado] ?? ESTADO.EXPIRED;
        const viva = s.estado === 'ACTIVE' || s.estado === 'PENDING' || s.estado === 'PAUSED';

        return (
          <article key={s.id} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                {s.proveedor && (
                  <p className="text-xs uppercase tracking-wider text-slate-500">{s.proveedor}</p>
                )}
                <h3 className="text-lg font-semibold text-white">{s.planNombre}</h3>
                <p className="mt-1 text-sm text-slate-400">
                  {fmt(s.precio)} por mes · {s.cajasPorCiclo} caja
                  {s.cajasPorCiclo > 1 ? 's' : ''} en cada renovación
                </p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${badge.clase}`}>
                {badge.texto}
              </span>
            </div>

            <dl className="mt-4 grid gap-3 border-t border-white/10 pt-4 text-sm sm:grid-cols-3">
              {s.proximoCobro && s.estado === 'ACTIVE' && (
                <div>
                  <dt className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Calendar className="h-3.5 w-3.5" /> Próximo cobro
                  </dt>
                  <dd className="mt-0.5 text-slate-200">{fecha(s.proximoCobro)}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-slate-500">Meses pagados</dt>
                <dd className="mt-0.5 tabular-nums text-slate-200">{s.ciclosCobrados}</dd>
              </div>
              {s.desde && (
                <div>
                  <dt className="text-xs text-slate-500">Desde</dt>
                  <dd className="mt-0.5 text-slate-200">{fecha(s.desde)}</dd>
                </div>
              )}
            </dl>

            {viva && (
              <div className="mt-5 border-t border-white/10 pt-4">
                {confirmando === s.id ? (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                    <p className="mb-1 flex items-center gap-2 text-sm font-medium text-amber-200">
                      <AlertTriangle className="h-4 w-4" />
                      ¿Confirmás la baja de {s.planNombre}?
                    </p>
                    <p className="mb-4 text-xs leading-relaxed text-amber-100/70">
                      No se te va a cobrar de nuevo. Las cajas y el saldo que ya ganaste siguen
                      siendo tuyos. Dejás de recibir cajas nuevas a partir del mes que viene.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => cancelar(s.id)}
                        disabled={procesando}
                        className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
                      >
                        {procesando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Sí, dar de baja
                      </button>
                      <button
                        onClick={() => setConfirmando(null)}
                        disabled={procesando}
                        className="rounded-full border border-white/20 px-5 py-2.5 text-sm text-white/80 transition hover:bg-white/10"
                      >
                        Seguir suscripto
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmando(s.id)}
                    className="flex items-center gap-1.5 text-sm text-slate-400 underline underline-offset-4 transition hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                    Dar de baja esta suscripción
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
