'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Trash2, Save, X, AlertTriangle, TrendingUp, Gift, Users, Power,
} from 'lucide-react';

export interface ProveedorOpcion {
  id: string;
  name: string;
}

export interface PlanRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  merchantId: string | null;
  merchantName: string | null;
  price: number;
  providerCost: number;
  boxesPerCycle: number;
  boxTier: string;
  poolShareRate: number;
  freeTrialDays: number | null;
  benefits: string[];
  isActive: boolean;
  isFeatured: boolean;
  suscriptores: number;
  vinculadoAMP: boolean;
}

const TIERS = ['BRONZE', 'SILVER', 'GOLD', 'VIP'] as const;
const TIER_NOMBRE: Record<string, string> = {
  BRONZE: 'Bronce', SILVER: 'Plata', GOLD: 'Oro', VIP: 'VIP',
};

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

// ═══════════════════════════════════════════════════════════════════
// Calculadora: el corazón de la pantalla
// ═══════════════════════════════════════════════════════════════════

interface Numeros {
  margen: number;
  aportePool: number;
  gananciaNeta: number;
  porCaja: number;
  advertencia: string | null;
  error: string | null;
}

/**
 * Traduce precio, costo y cajas al único número que importa: cuánta plata
 * queda para financiar cada caja. Mostrarlo mientras se escribe es lo que
 * evita cargar un plan que pierde plata y descubrirlo tres meses después.
 */
function calcular(precio: number, costo: number, cajas: number, share: number): Numeros {
  const margen = precio - costo;
  const aportePool = Math.max(0, margen * share);
  const porCaja = cajas > 0 ? aportePool / cajas : 0;

  let error: string | null = null;
  let advertencia: string | null = null;

  if (costo >= precio && precio > 0) {
    error = 'El costo del proveedor se come todo el precio. No queda margen para financiar ningún premio.';
  } else if (porCaja > 0 && porCaja < 50) {
    advertencia = `Con ${fmt(porCaja)} por caja casi siempre van a salir cupones sin valor real. Subí el precio, bajá el costo o dá menos cajas.`;
  } else if (cajas > 5) {
    advertencia = `${cajas} cajas reparten el mismo presupuesto en más partes: cada una vale menos. A veces conviene una caja de mejor nivel que muchas flojas.`;
  }

  return { margen, aportePool, gananciaNeta: margen - aportePool, porCaja, advertencia, error };
}

function PanelNumeros({ n, cajas }: { n: Numeros; cajas: number }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
      <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <TrendingUp className="h-3.5 w-3.5" /> Qué pasa con cada cobro
      </h4>

      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-400">Tu margen bruto</dt>
          <dd className={`font-semibold tabular-nums ${n.margen > 0 ? 'text-white' : 'text-red-400'}`}>
            {fmt(n.margen)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Va al pool de premios</dt>
          <dd className="font-semibold tabular-nums text-violet-300">{fmt(n.aportePool)}</dd>
        </div>
        <div className="flex justify-between border-t border-slate-800 pt-1.5">
          <dt className="text-slate-300">Te queda</dt>
          <dd className="font-bold tabular-nums text-emerald-400">{fmt(n.gananciaNeta)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center gap-2 rounded-lg bg-slate-800/60 p-3">
        <Gift className="h-4 w-4 shrink-0 text-amber-400" />
        <p className="text-xs leading-tight text-slate-300">
          Presupuesto de cada caja: <b className="tabular-nums text-white">{fmt(n.porCaja)}</b>
          <span className="block text-slate-500">
            {fmt(n.aportePool)} repartido entre {cajas} caja{cajas > 1 ? 's' : ''}
          </span>
        </p>
      </div>

      {n.error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-500/15 p-3 text-xs leading-relaxed text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {n.error}
        </p>
      )}
      {!n.error && n.advertencia && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/15 p-3 text-xs leading-relaxed text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {n.advertencia}
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════

const VACIO = {
  slug: '', name: '', description: '', merchantId: '',
  price: 12000, providerCost: 7000, boxesPerCycle: 3,
  boxTier: 'GOLD', poolShareRate: 0.5, freeTrialDays: 0,
  benefits: '', isActive: true, isFeatured: false,
};

export default function GestorPlanes({
  planes, proveedores,
}: {
  planes: PlanRow[];
  proveedores: ProveedorOpcion[];
}) {
  const router = useRouter();
  const [creando, setCreando] = useState(false);
  const [form, setForm] = useState(VACIO);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<{ texto: string; tipo: 'ok' | 'error' } | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<Partial<PlanRow>>({});

  const numeros = useMemo(
    () => calcular(form.price, form.providerCost, form.boxesPerCycle, form.poolShareRate),
    [form.price, form.providerCost, form.boxesPerCycle, form.poolShareRate],
  );

  const set = <K extends keyof typeof VACIO>(k: K, v: (typeof VACIO)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const slugAuto = (nombre: string) =>
    nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const crear = async () => {
    setGuardando(true);
    setMensaje(null);
    try {
      const res = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: form.slug || slugAuto(form.name),
          name: form.name,
          description: form.description || undefined,
          merchantId: form.merchantId || null,
          price: form.price,
          providerCost: form.providerCost,
          boxesPerCycle: form.boxesPerCycle,
          boxTier: form.boxTier,
          poolShareRate: form.poolShareRate,
          freeTrialDays: form.freeTrialDays || null,
          benefits: form.benefits.split('\n').map((b) => b.trim()).filter(Boolean),
          isActive: form.isActive,
          isFeatured: form.isFeatured,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'No se pudo crear el plan');

      setMensaje({
        texto: data.advertencias?.length ? data.advertencias[0] : 'Plan creado. Ya aparece en la página de suscripciones.',
        tipo: 'ok',
      });
      setForm(VACIO);
      setCreando(false);
      router.refresh();
    } catch (e) {
      setMensaje({ texto: e instanceof Error ? e.message : 'Error inesperado', tipo: 'error' });
    } finally {
      setGuardando(false);
    }
  };

  const guardarEdicion = async (id: string) => {
    setGuardando(true);
    try {
      const res = await fetch(`/api/admin/plans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(borrador),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'No se pudo guardar');
      setMensaje({ texto: data.avisoPrecio ?? 'Cambios guardados.', tipo: 'ok' });
      setEditando(null);
      setBorrador({});
      router.refresh();
    } catch (e) {
      setMensaje({ texto: e instanceof Error ? e.message : 'Error', tipo: 'error' });
    } finally {
      setGuardando(false);
    }
  };

  const alternar = async (id: string, activo: boolean) => {
    await fetch(`/api/admin/plans/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: activo }),
    });
    router.refresh();
  };

  const eliminar = async (id: string, nombre: string) => {
    setGuardando(true);
    try {
      const res = await fetch(`/api/admin/plans/${id}`, { method: 'DELETE' });
      const data = await res.json();
      setMensaje({
        texto: data.mensaje ?? `"${nombre}" se eliminó.`,
        tipo: 'ok',
      });
      router.refresh();
    } finally {
      setGuardando(false);
    }
  };

  const input = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-600 focus:border-amber-500 focus:outline-none';
  const label = 'mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400';

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Planes de suscripción</h1>
            <p className="text-sm text-slate-400">
              Cada renovación mensual otorga cajas nuevas al suscriptor.
            </p>
          </div>
          <button
            onClick={() => { setCreando(!creando); setMensaje(null); }}
            className="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 font-semibold text-slate-900 transition hover:bg-amber-400"
          >
            {creando ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {creando ? 'Cancelar' : 'Nuevo plan'}
          </button>
        </header>

        <AnimatePresence>
          {mensaje && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`mb-6 rounded-xl border p-4 text-sm ${
                mensaje.tipo === 'ok'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-red-500/40 bg-red-500/10 text-red-200'
              }`}
            >
              {mensaje.texto}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Formulario ── */}
        <AnimatePresence>
          {creando && (
            <motion.section
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-8 overflow-hidden"
            >
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className={label} htmlFor="p-nombre">Nombre del plan</label>
                        <input
                          id="p-nombre" className={input} value={form.name}
                          onChange={(e) => { set('name', e.target.value); if (!form.slug) set('slug', slugAuto(e.target.value)); }}
                          placeholder="Club Assistur Premium"
                        />
                      </div>
                      <div>
                        <label className={label} htmlFor="p-prov">Proveedor</label>
                        <select id="p-prov" className={input} value={form.merchantId} onChange={(e) => set('merchantId', e.target.value)}>
                          <option value="">Sin proveedor</option>
                          {proveedores.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className={label} htmlFor="p-desc">Descripción</label>
                      <input
                        id="p-desc" className={input} value={form.description}
                        onChange={(e) => set('description', e.target.value)}
                        placeholder="Asistencia al viajero 24hs en todo el país"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className={label} htmlFor="p-precio">Precio al cliente</label>
                        <input
                          id="p-precio" type="number" min={0} className={input} value={form.price}
                          onChange={(e) => set('price', Number(e.target.value))}
                        />
                      </div>
                      <div>
                        <label className={label} htmlFor="p-costo">Costo del proveedor</label>
                        <input
                          id="p-costo" type="number" min={0} className={input} value={form.providerCost}
                          onChange={(e) => set('providerCost', Number(e.target.value))}
                        />
                        <p className="mt-1 text-xs text-slate-500">Lo que le liquidás por cada mes</p>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <label className={label} htmlFor="p-cajas">Cajas por mes</label>
                        <input
                          id="p-cajas" type="number" min={1} max={20} className={input} value={form.boxesPerCycle}
                          onChange={(e) => set('boxesPerCycle', Math.max(1, Number(e.target.value)))}
                        />
                      </div>
                      <div>
                        <label className={label} htmlFor="p-tier">Nivel</label>
                        <select id="p-tier" className={input} value={form.boxTier} onChange={(e) => set('boxTier', e.target.value)}>
                          {TIERS.map((t) => <option key={t} value={t}>{TIER_NOMBRE[t]}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className={label} htmlFor="p-prueba">Días de prueba</label>
                        <input
                          id="p-prueba" type="number" min={0} className={input} value={form.freeTrialDays}
                          onChange={(e) => set('freeTrialDays', Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div>
                      <label className={label} htmlFor="p-share">
                        Del margen, al pool de premios: {(form.poolShareRate * 100).toFixed(0)}%
                      </label>
                      <input
                        id="p-share" type="range" min={0} max={0.9} step={0.05}
                        value={form.poolShareRate}
                        onChange={(e) => set('poolShareRate', Number(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                      <p className="mt-1 text-xs text-slate-500">
                        Más alto = premios más atractivos y más retención. Más bajo = más ganancia por cobro.
                      </p>
                    </div>

                    <div>
                      <label className={label} htmlFor="p-benef">Beneficios (uno por línea)</label>
                      <textarea
                        id="p-benef" rows={4} className={input} value={form.benefits}
                        onChange={(e) => set('benefits', e.target.value)}
                        placeholder={'Asistencia médica 24hs\nAuxilio mecánico\nCobertura en todo el país'}
                      />
                    </div>

                    <div className="flex flex-wrap gap-5">
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} className="h-4 w-4 accent-emerald-500" />
                        Visible en la web
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={form.isFeatured} onChange={(e) => set('isFeatured', e.target.checked)} className="h-4 w-4 accent-amber-500" />
                        Destacar como &ldquo;Más elegido&rdquo;
                      </label>
                    </div>
                  </div>

                  <div className="lg:sticky lg:top-6 lg:self-start">
                    <PanelNumeros n={numeros} cajas={form.boxesPerCycle} />
                    <button
                      onClick={crear}
                      disabled={guardando || !form.name || Boolean(numeros.error)}
                      className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Save className="h-4 w-4" />
                      {guardando ? 'Creando…' : 'Crear plan'}
                    </button>
                  </div>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ── Lista ── */}
        {planes.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-12 text-center">
            <Gift className="mx-auto mb-4 h-12 w-12 text-slate-700" />
            <p className="mb-1 font-medium text-slate-300">Todavía no hay planes</p>
            <p className="text-sm text-slate-500">
              Creá el primero y va a aparecer solo en la página de suscripciones.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {planes.map((plan) => {
              const n = calcular(plan.price, plan.providerCost, plan.boxesPerCycle, plan.poolShareRate);
              const editandoEste = editando === plan.id;

              return (
                <article
                  key={plan.id}
                  className={`rounded-2xl border bg-slate-900 p-5 ${
                    plan.isActive ? 'border-slate-800' : 'border-slate-800 opacity-55'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{plan.name}</h3>
                        {plan.isFeatured && (
                          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
                            Destacado
                          </span>
                        )}
                        {!plan.vinculadoAMP && (
                          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300" title="Se crea en Mercado Pago con la primera suscripción">
                            Sin vincular a MP
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-xs text-slate-500">
                        {plan.slug}
                        {plan.merchantName ? ` · ${plan.merchantName}` : ''}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                        <span className="tabular-nums">
                          <span className="text-slate-500">Precio </span>
                          <b>{fmt(plan.price)}</b>
                        </span>
                        <span className="tabular-nums">
                          <span className="text-slate-500">Costo </span>
                          {fmt(plan.providerCost)}
                        </span>
                        <span className="tabular-nums text-emerald-400">
                          <span className="text-slate-500">Te queda </span>
                          <b>{fmt(n.gananciaNeta)}</b>
                        </span>
                        <span className="tabular-nums">
                          <span className="text-slate-500">Cajas </span>
                          {plan.boxesPerCycle} {TIER_NOMBRE[plan.boxTier]}
                          <span className="text-slate-500"> ({fmt(n.porCaja)} c/u)</span>
                        </span>
                        <span className="flex items-center gap-1.5 text-sky-300">
                          <Users className="h-3.5 w-3.5" />
                          {plan.suscriptores} suscripto{plan.suscriptores === 1 ? '' : 's'}
                        </span>
                      </div>

                      {n.advertencia && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {n.advertencia}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => alternar(plan.id, !plan.isActive)}
                        title={plan.isActive ? 'Ocultar de la web' : 'Publicar'}
                        className={`rounded-lg border p-2 transition ${
                          plan.isActive
                            ? 'border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10'
                            : 'border-slate-700 text-slate-500 hover:bg-slate-800'
                        }`}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditando(editandoEste ? null : plan.id);
                          setBorrador({ price: plan.price, providerCost: plan.providerCost, boxesPerCycle: plan.boxesPerCycle });
                        }}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                      >
                        {editandoEste ? 'Cerrar' : 'Ajustar'}
                      </button>
                      <button
                        onClick={() => eliminar(plan.id, plan.name)}
                        disabled={guardando}
                        title={plan.suscriptores > 0 ? 'Tiene suscriptores: se va a desactivar' : 'Eliminar'}
                        className="rounded-lg border border-red-900/50 p-2 text-red-400 transition hover:bg-red-500/10 disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {editandoEste && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-5 grid gap-4 border-t border-slate-800 pt-5 sm:grid-cols-4">
                          <div>
                            <label className={label}>Precio</label>
                            <input
                              type="number" className={input}
                              value={borrador.price ?? plan.price}
                              onChange={(e) => setBorrador((b) => ({ ...b, price: Number(e.target.value) }))}
                            />
                          </div>
                          <div>
                            <label className={label}>Costo proveedor</label>
                            <input
                              type="number" className={input}
                              value={borrador.providerCost ?? plan.providerCost}
                              onChange={(e) => setBorrador((b) => ({ ...b, providerCost: Number(e.target.value) }))}
                            />
                          </div>
                          <div>
                            <label className={label}>Cajas por mes</label>
                            <input
                              type="number" min={1} className={input}
                              value={borrador.boxesPerCycle ?? plan.boxesPerCycle}
                              onChange={(e) => setBorrador((b) => ({ ...b, boxesPerCycle: Math.max(1, Number(e.target.value)) }))}
                            />
                          </div>
                          <div className="flex items-end">
                            <button
                              onClick={() => guardarEdicion(plan.id)}
                              disabled={guardando}
                              className="w-full rounded-lg bg-emerald-600 py-2 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                            >
                              Guardar
                            </button>
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-slate-500">
                          Cambiar el precio no afecta a quienes ya están suscriptos: ellos siguen
                          pagando el monto que autorizaron en Mercado Pago.
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
