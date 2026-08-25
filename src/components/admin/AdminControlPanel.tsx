'use client';

// ============================================================================
// src/components/admin/AdminControlPanel.tsx
// MisteryBox — Super-Admin Control Plane
// ----------------------------------------------------------------------------
// Tres pestañas:
//   · Métricas   → GMV, comisión, pool, pasivo de premios, RTP real vs teórico
//   · Comercios  → feature flags por comercio + módulos globales
//   · Premios    → pesos, costos, stock, multiplicador de seguridad
//
// Todos los cambios son optimistas con rollback si la API falla, y quedan
// registrados en admin_audit_logs del lado del servidor.
// ============================================================================

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, Store, Gift, TrendingUp, TrendingDown, Wallet, Lock,
  AlertTriangle, Power, Save, RefreshCw, CreditCard,
} from 'lucide-react';

// ─────────────────────────── Tipos ───────────────────────────

export interface Metrics {
  gmv: number;
  commissionGross: number;
  commissionApproved: number;
  commissionPending: number;
  poolAvailable: number;
  poolReserved: number;
  jackpotBalance: number;
  /** Pasivo: premios UNLOCKED aún no canjeados + LOCKED */
  liabilityUnlocked: number;
  liabilityLocked: number;
  rtpTheoretical: number;   // 0..1
  rtpReal: number;          // 0..1
  netMargin: number;
  boxesOpened24h: number;
  activeUsers24h: number;
  receiptsInReview: number;
}

export interface MerchantRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  integrationType: string;
  isActive: boolean;
  commissionRate: number;
  poolShareRate: number;
  transactions30d: number;
  commission30d: number;
}

export interface PrizeRow {
  id: string;
  name: string;
  tier: string;
  type: string;
  realCost: number;
  perceivedValue: number;
  baseWeight: number;
  stock: number;
  stockClaimed: number;
  poolSafetyMultiplier: number;
  isActive: boolean;
  /** ¿El pool banca este premio ahora mismo? (calculado en el server) */
  eligibleNow: boolean;
}

export interface FlagRow {
  key: string;
  enabled: boolean;
  description: string | null;
}

interface Props {
  metrics: Metrics;
  merchants: MerchantRow[];
  prizes: PrizeRow[];
  flags: FlagRow[];
  onToggleMerchant: (id: string, enabled: boolean) => Promise<void>;
  onToggleFlag: (key: string, enabled: boolean) => Promise<void>;
  onUpdatePrize: (id: string, patch: Partial<PrizeRow>) => Promise<void>;
  onRefresh?: () => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ═══════════════════════════════════════════════════════════════════════════

export default function AdminControlPanel({
  metrics, merchants, prizes, flags,
  onToggleMerchant, onToggleFlag, onUpdatePrize, onRefresh,
}: Props) {
  const [tab, setTab] = useState<'metrics' | 'merchants' | 'prizes'>('metrics');

  const tabs = [
    { id: 'metrics' as const, label: 'Métricas', icon: Activity },
    { id: 'merchants' as const, label: 'Comercios y módulos', icon: Store },
    { id: 'prizes' as const, label: 'Premios y probabilidades', icon: Gift },
  ];

  const rtpDrift = metrics.rtpReal - metrics.rtpTheoretical;

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Control Plane</h1>
          <p className="text-sm text-slate-400">MisteryBox — panel de operación</p>
        </div>
        <div className="flex items-center gap-3">
          {metrics.receiptsInReview > 0 && (
            <a
              href="/admin/receipts"
              className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 hover:bg-amber-500/20"
            >
              <AlertTriangle className="h-4 w-4" />
              {metrics.receiptsInReview} comprobantes en revisión
            </a>
          )}
          <a
            href="/admin/planes"
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <CreditCard className="h-4 w-4" /> Planes de suscripción
          </a>
          <button
            onClick={onRefresh}
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" /> Actualizar
          </button>
        </div>
      </header>

      {/* Alerta de salud financiera */}
      {rtpDrift > 0.08 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
          <div className="text-sm">
            <p className="font-semibold text-red-300">RTP real por encima del objetivo</p>
            <p className="text-red-200/70">
              Real {pct(metrics.rtpReal)} vs teórico {pct(metrics.rtpTheoretical)}. Bajá el peso base de
              los premios caros o subí el multiplicador de seguridad.
            </p>
          </div>
        </div>
      )}

      <nav className="mb-6 flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              tab === t.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </nav>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {tab === 'metrics' && <MetricsTab m={metrics} />}
          {tab === 'merchants' && (
            <MerchantsTab
              merchants={merchants}
              flags={flags}
              onToggleMerchant={onToggleMerchant}
              onToggleFlag={onToggleFlag}
            />
          )}
          {tab === 'prizes' && <PrizesTab prizes={prizes} onUpdate={onUpdatePrize} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────── Tab: Métricas ───────────────────────────

function MetricsTab({ m }: { m: Metrics }) {
  const cards = [
    { label: 'GMV generado', value: fmt(m.gmv), icon: TrendingUp, tone: 'text-sky-400' },
    { label: 'Comisión bruta', value: fmt(m.commissionGross), sub: `${fmt(m.commissionPending)} pendiente`, icon: Wallet, tone: 'text-emerald-400' },
    { label: 'Pool disponible', value: fmt(m.poolAvailable), sub: `${fmt(m.poolReserved)} reservado`, icon: Gift, tone: 'text-violet-400' },
    { label: 'Jackpot', value: fmt(m.jackpotBalance), icon: Activity, tone: 'text-fuchsia-400' },
    { label: 'Pasivo desbloqueado', value: fmt(m.liabilityUnlocked), sub: 'premios por canjear', icon: AlertTriangle, tone: 'text-amber-400' },
    { label: 'Pasivo en escrow', value: fmt(m.liabilityLocked), sub: 'sin riesgo hasta aprobar', icon: Lock, tone: 'text-slate-400' },
    { label: 'Margen neto', value: fmt(m.netMargin), icon: m.netMargin >= 0 ? TrendingUp : TrendingDown, tone: m.netMargin >= 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Cajas abiertas 24h', value: m.boxesOpened24h.toLocaleString('es-AR'), sub: `${m.activeUsers24h} usuarios activos`, icon: Gift, tone: 'text-sky-400' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-slate-500">{c.label}</span>
              <c.icon className={`h-4 w-4 ${c.tone}`} />
            </div>
            <p className="text-xl font-bold tabular-nums">{c.value}</p>
            {c.sub && <p className="mt-1 text-xs text-slate-500">{c.sub}</p>}
          </div>
        ))}
      </div>

      {/* Barra de RTP */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Return to Player</h3>
          <span className="text-sm text-slate-400">
            real <b className="text-white">{pct(m.rtpReal)}</b> · objetivo {pct(m.rtpTheoretical)}
          </span>
        </div>
        <div className="relative h-4 overflow-hidden rounded-full bg-slate-800">
          <motion.div
            className={`h-full rounded-full ${
              m.rtpReal > m.rtpTheoretical + 0.05
                ? 'bg-red-500'
                : m.rtpReal > m.rtpTheoretical - 0.1
                ? 'bg-emerald-500'
                : 'bg-sky-500'
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, m.rtpReal * 100)}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
          <div
            className="absolute top-0 h-full w-0.5 bg-white"
            style={{ left: `${Math.min(100, m.rtpTheoretical * 100)}%` }}
            title={`Objetivo ${pct(m.rtpTheoretical)}`}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          La línea blanca es el objetivo. Por debajo = más rentable pero menos atractivo;
          por encima = estás pagando más premios de los que la comisión banca.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────── Tab: Comercios y módulos ───────────────────────────

function MerchantsTab({
  merchants, flags, onToggleMerchant, onToggleFlag,
}: {
  merchants: MerchantRow[];
  flags: FlagRow[];
  onToggleMerchant: (id: string, enabled: boolean) => Promise<void>;
  onToggleFlag: (key: string, enabled: boolean) => Promise<void>;
}) {
  const [localMerchants, setLocalMerchants] = useState(merchants);
  const [localFlags, setLocalFlags] = useState(flags);

  const toggleMerchant = useCallback(async (id: string, next: boolean) => {
    setLocalMerchants((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: next } : m)));
    try {
      await onToggleMerchant(id, next);
    } catch {
      setLocalMerchants((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: !next } : m)));
    }
  }, [onToggleMerchant]);

  const toggleFlag = useCallback(async (key: string, next: boolean) => {
    setLocalFlags((prev) => prev.map((f) => (f.key === key ? { ...f, enabled: next } : f)));
    try {
      await onToggleFlag(key, next);
    } catch {
      setLocalFlags((prev) => prev.map((f) => (f.key === key ? { ...f, enabled: !next } : f)));
    }
  }, [onToggleFlag]);

  return (
    <div className="space-y-6">
      {/* Módulos globales */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Power className="h-4 w-4 text-sky-400" /> Módulos globales
        </h3>
        <p className="mb-4 text-xs text-slate-500">
          Apagan funcionalidad completa al instante, sin deploy.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {localFlags.map((f) => (
            <div key={f.key} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 p-3">
              <div className="min-w-0 pr-3">
                <p className="truncate font-mono text-xs text-slate-300">{f.key}</p>
                {f.description && <p className="truncate text-xs text-slate-500">{f.description}</p>}
              </div>
              <Toggle checked={f.enabled} onChange={(v) => toggleFlag(f.key, v)} />
            </div>
          ))}
        </div>
      </section>

      {/* Comercios */}
      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 p-5">
          <h3 className="font-semibold">Comercios y servicios</h3>
          <p className="text-xs text-slate-500">
            Apagar un comercio lo oculta del directorio y bloquea nuevos clics de afiliado.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3 text-left">Comercio</th>
                <th className="px-5 py-3 text-left">Integración</th>
                <th className="px-5 py-3 text-right">Comisión</th>
                <th className="px-5 py-3 text-right">Al pool</th>
                <th className="px-5 py-3 text-right">Órdenes 30d</th>
                <th className="px-5 py-3 text-right">Generado 30d</th>
                <th className="px-5 py-3 text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {localMerchants.map((m) => (
                <tr key={m.id} className={m.isActive ? '' : 'opacity-45'}>
                  <td className="px-5 py-3">
                    <p className="font-medium">{m.name}</p>
                    <p className="font-mono text-xs text-slate-500">{m.slug}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                      {m.integrationType}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{pct(m.commissionRate)}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-violet-300">{pct(m.poolShareRate)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{m.transactions30d.toLocaleString('es-AR')}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-emerald-400">{fmt(m.commission30d)}</td>
                  <td className="px-5 py-3">
                    <div className="flex justify-center">
                      <Toggle checked={m.isActive} onChange={(v) => toggleMerchant(m.id, v)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────── Tab: Premios ───────────────────────────

function PrizesTab({
  prizes, onUpdate,
}: {
  prizes: PrizeRow[];
  onUpdate: (id: string, patch: Partial<PrizeRow>) => Promise<void>;
}) {
  const [rows, setRows] = useState(prizes);
  const [dirty, setDirty] = useState<Record<string, Partial<PrizeRow>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const edit = (id: string, patch: Partial<PrizeRow>) => {
    setRows((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setDirty((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const save = async (id: string) => {
    const patch = dirty[id];
    if (!patch) return;
    setSaving(id);
    try {
      await onUpdate(id, patch);
      setDirty((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setSaving(null);
    }
  };

  // Probabilidad teórica con pesos base, por tier
  const byTier = rows.reduce<Record<string, PrizeRow[]>>((acc, p) => {
    (acc[p.tier] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {Object.entries(byTier).map(([tier, list]) => {
        const totalWeight = list.filter((p) => p.isActive).reduce((s, p) => s + p.baseWeight, 0) || 1;
        const ev = list
          .filter((p) => p.isActive)
          .reduce((s, p) => s + (p.baseWeight / totalWeight) * p.realCost, 0);

        return (
          <section key={tier} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-5">
              <h3 className="font-semibold">Caja {tier}</h3>
              <span className="text-xs text-slate-400">
                E[costo] con pesos base: <b className="text-white tabular-nums">{fmt(ev)}</b>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-950/60 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Premio</th>
                    <th className="px-4 py-3 text-right">Costo real</th>
                    <th className="px-4 py-3 text-right">Valor percibido</th>
                    <th className="px-4 py-3 text-right">Peso</th>
                    <th className="px-4 py-3 text-right">Prob. base</th>
                    <th className="px-4 py-3 text-right">Mult. seg.</th>
                    <th className="px-4 py-3 text-right">Stock</th>
                    <th className="px-4 py-3 text-center">Activo</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {list.map((p) => (
                    <tr key={p.id} className={p.isActive ? '' : 'opacity-45'}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{p.name}</p>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-slate-500">{p.type}</span>
                          {!p.eligibleNow && p.realCost > 0 && (
                            <span
                              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
                              title="El pool no alcanza el multiplicador de seguridad; este premio no puede salir ahora"
                            >
                              pool insuficiente
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <NumInput value={p.realCost} onChange={(v) => edit(p.id, { realCost: v })} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                        {fmt(p.perceivedValue)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <NumInput value={p.baseWeight} step={1} onChange={(v) => edit(p.id, { baseWeight: v })} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-sky-300">
                        {p.isActive ? `${((p.baseWeight / totalWeight) * 100).toFixed(2)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <NumInput
                          value={p.poolSafetyMultiplier}
                          step={0.5}
                          onChange={(v) => edit(p.id, { poolSafetyMultiplier: v })}
                        />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                        {p.stock === -1 ? '∞' : `${p.stock - p.stockClaimed}/${p.stock}`}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center">
                          <Toggle checked={p.isActive} onChange={(v) => edit(p.id, { isActive: v })} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {dirty[p.id] && (
                          <button
                            onClick={() => save(p.id)}
                            disabled={saving === p.id}
                            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            <Save className="h-3.5 w-3.5" />
                            {saving === p.id ? '…' : 'Guardar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Primitivos ───────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-emerald-500' : 'bg-slate-700'
      }`}
    >
      <motion.span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow"
        animate={{ left: checked ? 22 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      />
    </button>
  );
}

function NumInput({
  value, onChange, step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right tabular-nums text-white focus:border-sky-500 focus:outline-none"
    />
  );
}
