'use client';

// ============================================================================
// src/components/MysteryBoxUnboxer.tsx
// MisteryBox — Componente interactivo de apertura de caja
// React 18 + Tailwind CSS + Framer Motion
// ----------------------------------------------------------------------------
// Flujo: IDLE → SHAKING (suspenso, mientras el server decide) → BURST → REVEAL
// El servidor es la autoridad: el cliente NUNCA conoce las probabilidades.
// La animación arranca en paralelo al fetch para que el suspenso se sienta real
// aunque la API responda en 200ms.
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Gift, Lock, Sparkles, X, Copy, Check, Wallet, Ticket, Package, Percent } from 'lucide-react';

// ─────────────────────────── Tipos (espejo del backend) ───────────────────────────

export type PrizeType =
  | 'WALLET_CASH'
  | 'STORE_DISCOUNT'
  | 'DIGITAL_ASSET'
  | 'PHYSICAL_PRODUCT'
  | 'EVENT_PASS'
  | 'CASHBACK_REFUND'
  | 'JACKPOT';

export type BoxTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'VIP';

export interface UnboxResult {
  rewardId: string;
  prize: {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    type: PrizeType;
    perceivedValue: number;
  };
  status: 'LOCKED' | 'UNLOCKED';
  redemptionCode: string | null;
  unlockEstimateAt: string | null;
}

interface Props {
  userBoxId: string;
  tier: BoxTier;
  /** Override para tests/storybook; por defecto pega a /api/boxes/open */
  onOpen?: (userBoxId: string) => Promise<UnboxResult>;
  onRevealed?: (result: UnboxResult) => void;
  onClose?: () => void;
  /** Cuántas cajas sin abrir le quedan al usuario después de esta */
  cajasRestantes?: number;
}

type Phase = 'IDLE' | 'SHAKING' | 'BURST' | 'REVEAL' | 'ERROR';

// ─────────────────────────── Diseño por tier ───────────────────────────

const TIER_STYLE: Record<
  BoxTier,
  { label: string; ring: string; glow: string; grad: string; particle: string; chip: string }
> = {
  BRONZE: {
    label: 'Bronce',
    ring: 'ring-amber-700/50',
    glow: 'shadow-[0_0_60px_-10px_rgba(180,83,9,0.75)]',
    grad: 'from-amber-700 via-amber-600 to-amber-800',
    particle: 'bg-amber-400',
    chip: 'bg-amber-900/40 text-amber-200 border-amber-700/50',
  },
  SILVER: {
    label: 'Plata',
    ring: 'ring-slate-300/50',
    glow: 'shadow-[0_0_60px_-10px_rgba(203,213,225,0.7)]',
    grad: 'from-slate-400 via-slate-200 to-slate-500',
    particle: 'bg-slate-200',
    chip: 'bg-slate-700/50 text-slate-100 border-slate-400/40',
  },
  GOLD: {
    label: 'Oro',
    ring: 'ring-yellow-400/60',
    glow: 'shadow-[0_0_80px_-8px_rgba(250,204,21,0.85)]',
    grad: 'from-yellow-500 via-amber-300 to-yellow-600',
    particle: 'bg-yellow-300',
    chip: 'bg-yellow-900/40 text-yellow-200 border-yellow-500/50',
  },
  VIP: {
    label: 'VIP',
    ring: 'ring-fuchsia-400/60',
    glow: 'shadow-[0_0_90px_-8px_rgba(232,121,249,0.9)]',
    grad: 'from-fuchsia-600 via-purple-400 to-indigo-600',
    particle: 'bg-fuchsia-300',
    chip: 'bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-500/50',
  },
};

const PRIZE_ICON: Record<PrizeType, typeof Gift> = {
  WALLET_CASH: Wallet,
  CASHBACK_REFUND: Wallet,
  STORE_DISCOUNT: Percent,
  DIGITAL_ASSET: Sparkles,
  PHYSICAL_PRODUCT: Package,
  EVENT_PASS: Ticket,
  JACKPOT: Sparkles,
};

const fmtARS = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

// ─────────────────────────── Audio (WebAudio, sin assets externos) ───────────────────────────

function useSfx() {
  const ctxRef = useRef<AudioContext | null>(null);

  const ensure = () => {
    if (typeof window === 'undefined') return null;
    if (!ctxRef.current) {
      const AC = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return null;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume();
    return ctxRef.current;
  };

  const tone = useCallback((freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.12) => {
    const ctx = ensure();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }, []);

  return {
    tick: () => tone(220, 0.06, 'square', 0.05),
    burst: () => {
      tone(180, 0.35, 'sawtooth', 0.1);
      setTimeout(() => tone(520, 0.25, 'triangle', 0.09), 60);
    },
    win: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        setTimeout(() => tone(f, 0.28, 'triangle', 0.1), i * 110),
      );
    },
  };
}

// Vibración háptica en mobile (no-op donde no exista)
const haptic = (pattern: number | number[]) => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
};

// ─────────────────────────── Componente ───────────────────────────

export default function MysteryBoxUnboxer({
  userBoxId,
  tier,
  onOpen,
  onRevealed,
  onClose,
  cajasRestantes = 0,
}: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [result, setResult] = useState<UnboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const style = TIER_STYLE[tier];
  const sfx = useSfx();
  const reduceMotion = useReducedMotion();
  const inFlight = useRef(false);

  const defaultOpen = useCallback(async (id: string): Promise<UnboxResult> => {
    const res = await fetch('/api/boxes/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userBoxId: id }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? 'No pudimos abrir la caja. Probá de nuevo.');
    return body as UnboxResult;
  }, []);

  const handleOpen = useCallback(async () => {
    if (inFlight.current || phase !== 'IDLE') return; // anti doble-clic
    inFlight.current = true;
    setPhase('SHAKING');
    setError(null);
    haptic([30, 40, 30, 40, 60]);
    sfx.tick();

    // Suspenso mínimo garantizado, aunque la API conteste en 150ms
    const minSuspense = new Promise((r) => setTimeout(r, reduceMotion ? 300 : 1900));

    try {
      const [data] = await Promise.all([(onOpen ?? defaultOpen)(userBoxId), minSuspense]);
      setResult(data);
      setPhase('BURST');
      sfx.burst();
      haptic([80, 30, 120]);
      setTimeout(() => {
        setPhase('REVEAL');
        sfx.win();
        onRevealed?.(data);
      }, reduceMotion ? 100 : 620);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado');
      setPhase('ERROR');
    } finally {
      inFlight.current = false;
    }
  }, [phase, onOpen, defaultOpen, userBoxId, sfx, reduceMotion, onRevealed]);

  const copyCode = async () => {
    if (!result?.redemptionCode) return;
    try {
      await navigator.clipboard.writeText(result.redemptionCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // El portapapeles puede fallar dentro de una app o sin HTTPS. El código
      // igual se puede seleccionar a mano, así que no se bloquea nada.
      console.warn('No se pudo copiar al portapapeles');
    }
  };

  return (
    <div className="relative flex min-h-[560px] w-full flex-col items-center justify-center overflow-hidden rounded-3xl bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 p-8">
      <AmbientGlow tier={tier} active={phase !== 'IDLE'} />

      {/* Badge de tier */}
      <div className={`z-10 mb-8 rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-widest ${style.chip}`}>
        Caja {style.label}
      </div>

      {/* ── Escena de la caja ── */}
      <div className="relative z-10 flex h-64 w-64 items-center justify-center">
        <AnimatePresence mode="wait">
          {phase !== 'REVEAL' && (
            <motion.div
              key="box"
              className="relative"
              initial={{ scale: 0.85, opacity: 0 }}
              animate={
                phase === 'SHAKING' && !reduceMotion
                  ? {
                      scale: [1, 1.06, 0.97, 1.09, 1],
                      rotate: [0, -7, 7, -10, 10, -4, 4, 0],
                      opacity: 1,
                    }
                  : phase === 'BURST'
                  ? { scale: [1, 1.5, 0], opacity: [1, 1, 0], rotate: 0 }
                  : { scale: 1, opacity: 1, rotate: 0 }
              }
              exit={{ scale: 0, opacity: 0 }}
              transition={
                phase === 'SHAKING'
                  ? { duration: 0.55, repeat: Infinity, ease: 'easeInOut' }
                  : phase === 'BURST'
                  ? { duration: 0.6, ease: 'backIn' }
                  : { type: 'spring', stiffness: 260, damping: 18 }
              }
            >
              <div
                className={`flex h-44 w-44 items-center justify-center rounded-2xl bg-gradient-to-br ring-4 ${style.grad} ${style.ring} ${style.glow}`}
              >
                {/* Cinta */}
                <div className="absolute h-44 w-6 bg-white/25 backdrop-blur-sm" />
                <div className="absolute h-6 w-44 bg-white/25 backdrop-blur-sm" />
                <Gift className="relative z-10 h-16 w-16 text-white drop-shadow-lg" strokeWidth={1.5} />
              </div>

              {/* Sombra al piso */}
              <motion.div
                className="mx-auto mt-6 h-3 w-32 rounded-full bg-black/50 blur-md"
                animate={phase === 'SHAKING' ? { scaleX: [1, 0.8, 1] } : {}}
                transition={{ duration: 0.55, repeat: Infinity }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {(phase === 'BURST' || phase === 'REVEAL') && !reduceMotion && (
          <ParticleBurst colorClass={style.particle} />
        )}
      </div>

      {/* ── CTA / estado ── */}
      <div className="z-10 mt-10 flex h-24 flex-col items-center justify-start">
        {phase === 'IDLE' && (
          <motion.button
            onClick={handleOpen}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            // Texto oscuro: sobre los gradientes plata y oro el blanco quedaba
            // con contraste ~1,2:1, prácticamente invisible.
            className={`rounded-full bg-gradient-to-r px-10 py-4 text-lg font-bold text-slate-900 transition-shadow ${style.grad} ${style.glow}`}
          >
            Abrir Mystery Box
          </motion.button>
        )}

        {phase === 'SHAKING' && (
          <motion.p
            role="status"
            aria-live="polite"
            className="text-sm font-medium uppercase tracking-[0.3em] text-white/70"
            animate={{ opacity: [0.35, 1, 0.35] }}
            transition={{ duration: 1.1, repeat: Infinity }}
          >
            Abriendo…
          </motion.p>
        )}

        {phase === 'ERROR' && (
          <div className="text-center">
            <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>
            <button
              onClick={() => setPhase('IDLE')}
              className="rounded-full border border-white/20 px-5 py-2 text-sm text-white/80 hover:bg-white/10"
            >
              Reintentar
            </button>
          </div>
        )}
      </div>

      {/* ── Modal de revelación ── */}
      <AnimatePresence>
        {phase === 'REVEAL' && result && (
          <RevealModal
            result={result}
            tier={tier}
            copied={copied}
            onCopy={copyCode}
            cajasRestantes={cajasRestantes}
            onClose={() => {
              // No se vuelve a IDLE: eso dejaba al usuario frente al botón
              // "Abrir" de una caja que ya abrió, y al tocarlo el servidor le
              // respondía que la caja no era suya.
              onClose?.();
              router.push(cajasRestantes > 0 ? '/cajas' : '/billetera');
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────── Modal de premio ───────────────────────────

function RevealModal({
  result,
  tier,
  copied,
  onCopy,
  onClose,
  cajasRestantes,
}: {
  result: UnboxResult;
  tier: BoxTier;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
  cajasRestantes: number;
}) {
  const style = TIER_STYLE[tier];
  const Icon = PRIZE_ICON[result.prize.type] ?? Gift;
  const isLocked = result.status === 'LOCKED';

  // Cerrar con Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <motion.div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-6 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prize-title"
    >
      <motion.div
        className="relative max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-8 text-center"
        initial={{ scale: 0.6, y: 40, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 22 }}
      >
        <div className={`pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-gradient-to-br blur-3xl opacity-40 ${style.grad}`} />

        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="absolute right-4 top-4 rounded-full p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        <motion.div
          className={`relative mx-auto mb-5 flex h-24 w-24 items-center justify-center rounded-2xl bg-gradient-to-br ${style.grad} ${style.glow}`}
          initial={{ rotate: -12, scale: 0.5 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.15 }}
        >
          {result.prize.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.prize.imageUrl} alt="" className="h-16 w-16 object-contain" />
          ) : (
            <Icon className="h-12 w-12 text-white" strokeWidth={1.5} />
          )}
        </motion.div>

        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.25em] text-white/40">
          ¡Ganaste!
        </p>
        <h3 id="prize-title" className="mb-2 text-2xl font-bold leading-tight text-white">
          {result.prize.name}
        </h3>

        {result.prize.perceivedValue > 0 && (
          <p className="mb-3 text-sm font-medium text-emerald-400">
            Valor {fmtARS(result.prize.perceivedValue)}
          </p>
        )}

        {result.prize.description && (
          <p className="mb-5 text-sm leading-relaxed text-white/60">{result.prize.description}</p>
        )}

        {result.redemptionCode && (
          <button
            onClick={onCopy}
            className="mb-5 flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-white/25 bg-white/5 px-4 py-3 transition hover:bg-white/10"
          >
            <code className="select-all font-mono text-sm tracking-wider text-white">{result.redemptionCode}</code>
            {copied ? (
              <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4 shrink-0 text-white/50" />
            )}
          </button>
        )}

        {isLocked ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-300">
              <Lock className="h-4 w-4" /> Premio en verificación
            </div>
            <p className="text-xs leading-relaxed text-amber-100/70">
              Se libera cuando la tienda confirme tu compra
              {result.unlockEstimateAt
                ? ` (aprox. ${new Date(result.unlockEstimateAt).toLocaleDateString('es-AR')})`
                : ' (7 a 14 días)'}
              . Lo vas a ver en tu billetera automáticamente.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm font-medium text-emerald-300">
            ✓ Disponible ahora en tu billetera
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-5 w-full rounded-full bg-white py-3 font-semibold text-slate-900 transition hover:bg-white/90"
        >
          {cajasRestantes > 0
            ? `Abrir otra caja (${cajasRestantes})`
            : 'Ver mi billetera'}
        </button>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────── Efectos ───────────────────────────

function AmbientGlow({ tier, active }: { tier: BoxTier; active: boolean }) {
  const style = TIER_STYLE[tier];
  const quieto = useReducedMotion();
  return (
    <motion.div
      aria-hidden
      className={`pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br blur-[100px] ${style.grad}`}
      animate={
        quieto
          ? { opacity: 0.2, scale: 1 }
          : { opacity: active ? [0.25, 0.5, 0.25] : 0.18, scale: active ? [1, 1.15, 1] : 1 }
      }
      transition={quieto ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

function ParticleBurst({ colorClass }: { colorClass: string }) {
  // Determinístico: evita mismatch de hidratación en SSR
  const particles = Array.from({ length: 28 }, (_, i) => {
    const angle = (i / 28) * Math.PI * 2;
    const dist = 90 + ((i * 37) % 90);
    return {
      id: i,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      size: 5 + ((i * 13) % 8),
      delay: (i % 6) * 0.025,
    };
  });

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className={`absolute rounded-full ${colorClass}`}
          style={{ width: p.size, height: p.size }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: p.x, y: p.y, opacity: 0, scale: 0.2 }}
          transition={{ duration: 1.1, delay: p.delay, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}
