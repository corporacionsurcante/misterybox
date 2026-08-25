// Simulación de verificación del motor de RTP (lógica pura extraída del servicio)
import { randomInt } from 'crypto';

function secureRandom() { const M = 2 ** 48 - 1; return randomInt(0, M) / M; }

function filterEligible(candidates, ctx) {
  return candidates.filter((p) => {
    if (p.stock !== -1 && p.stockClaimed >= p.stock) return false;
    if (p.realCost <= 0) return true;
    if (p.realCost > ctx.maxPayoutPerOpen) return false;
    if (p.isJackpot) return ctx.jackpotEnabled && ctx.jackpotBalance >= p.realCost;
    return (ctx.poolAvailable - ctx.reserveFloor) >= p.realCost * p.poolSafetyMultiplier;
  });
}

function applyRtpBudget(candidates, budget) {
  if (!candidates.length) return [];
  if (budget <= 0) {
    const free = candidates.filter(c => c.realCost <= 0);
    return (free.length ? free : candidates).map(prize => ({ prize, weight: prize.baseWeight }));
  }
  const expectedCost = (lambda) => {
    let tw = 0, tc = 0;
    for (const c of candidates) {
      const w = c.baseWeight * Math.exp(-lambda * (c.realCost / budget));
      tw += w; tc += w * c.realCost;
    }
    return tw === 0 ? 0 : tc / tw;
  };
  const baseline = expectedCost(0);
  if (Math.abs(baseline - budget) < budget * 0.001) return candidates.map(prize => ({ prize, weight: prize.baseWeight }));
  let lo = baseline > budget ? 0 : -24, hi = baseline > budget ? 64 : 0;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (expectedCost(mid) > budget) lo = mid; else hi = mid; }
  const weighted = candidates.map(prize => ({ prize, weight: prize.baseWeight * Math.exp(-hi * (prize.realCost / budget)) }))
                             .filter(x => Number.isFinite(x.weight) && x.weight > 1e-12);
  const tw = weighted.reduce((s, x) => s + x.weight, 0);
  const ev = weighted.reduce((s, x) => s + x.weight * x.prize.realCost, 0) / (tw || 1);
  if (ev > budget * 1.02) {
    const aff = candidates.filter(c => c.realCost <= budget);
    if (aff.length) return aff.map(prize => ({ prize, weight: prize.baseWeight }));
  }
  return weighted;
}

function weightedPick(items, r) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let t = r * total;
  for (const i of items) { t -= i.weight; if (t <= 0) return i.prize; }
  return items[items.length - 1].prize;
}

// Catálogo GOLD de ejemplo (pesos base "de marketing", deliberadamente generosos)
const prizes = [
  { id: 'p1', name: 'Cupón 10% tienda',   realCost: 0,    perceivedValue: 500,  baseWeight: 500, poolSafetyMultiplier: 3.5, isJackpot: false, stock: -1, stockClaimed: 0 },
  { id: 'p2', name: 'Cupón envío gratis', realCost: 0,    perceivedValue: 800,  baseWeight: 300, poolSafetyMultiplier: 3.5, isJackpot: false, stock: -1, stockClaimed: 0 },
  { id: 'p3', name: 'Saldo $200',         realCost: 200,  perceivedValue: 200,  baseWeight: 150, poolSafetyMultiplier: 3.5, isJackpot: false, stock: -1, stockClaimed: 0 },
  { id: 'p4', name: 'Saldo $1000',        realCost: 1000, perceivedValue: 1000, baseWeight: 60,  poolSafetyMultiplier: 3.5, isJackpot: false, stock: -1, stockClaimed: 0 },
  { id: 'p5', name: 'Auricular BT',       realCost: 8000, perceivedValue: 15000,baseWeight: 20,  poolSafetyMultiplier: 3.5, isJackpot: false, stock: -1, stockClaimed: 0 },
  { id: 'p6', name: 'JACKPOT $50.000',    realCost: 50000,perceivedValue: 50000,baseWeight: 5,   poolSafetyMultiplier: 3.5, isJackpot: true,  stock: -1, stockClaimed: 0 },
];

// Simulación: 200.000 compras, comisión promedio $1.200, poolShare 50%, RTP 50%
const N = 200000;
const TARGET_RTP = 0.5;
const POOL_SHARE = 0.5;
const JACKPOT_FEED = 0.05;

let pool = 0, jackpot = 0, totalCommission = 0, totalPayout = 0, totalPerceived = 0;
const wins = {};
let minPool = Infinity;

for (let i = 0; i < N; i++) {
  // comisión log-normal-ish entre ~200 y ~6000
  const commission = 200 + Math.exp(Math.random() * 3.4) * 150;
  totalCommission += commission;
  const contribution = commission * POOL_SHARE;
  const toJackpot = contribution * JACKPOT_FEED;
  pool += contribution - toJackpot;
  jackpot += toJackpot;

  const funding = contribution;
  const budget = funding * TARGET_RTP;

  const ctx = { poolAvailable: pool, reserveFloor: 0, maxPayoutPerOpen: 50000, jackpotBalance: jackpot, jackpotEnabled: true };
  let eligible = filterEligible(prizes, ctx);
  if (!eligible.length) eligible = prizes.filter(p => p.realCost <= 0);
  const won = weightedPick(applyRtpBudget(eligible, budget), secureRandom());

  wins[won.name] = (wins[won.name] || 0) + 1;
  totalPayout += won.realCost;
  totalPerceived += won.perceivedValue;
  if (won.isJackpot) jackpot -= won.realCost; else pool -= won.realCost;
  minPool = Math.min(minPool, pool);
}

const fmt = n => n.toLocaleString('es-AR', { maximumFractionDigits: 0 });
console.log('=== SIMULACIÓN', fmt(N), 'aperturas ===\n');
console.log('Comisión bruta total :', fmt(totalCommission));
console.log('Aporte al pool (50%) :', fmt(totalCommission * POOL_SHARE));
console.log('Margen plataforma    :', fmt(totalCommission * (1 - POOL_SHARE)));
console.log('Premios pagados      :', fmt(totalPayout));
console.log('Valor percibido dado :', fmt(totalPerceived));
console.log('\nRTP real vs pool     :', (totalPayout / (totalCommission * POOL_SHARE) * 100).toFixed(2) + '%  (objetivo ≤ 50%)');
console.log('RTP real vs comisión :', (totalPayout / totalCommission * 100).toFixed(2) + '%');
console.log('Margen neto final    :', fmt(totalCommission - totalPayout), '(', ((1 - totalPayout / totalCommission) * 100).toFixed(1) + '% )');
console.log('\nPool final           :', fmt(pool));
console.log('Jackpot final        :', fmt(jackpot));
console.log('Pool mínimo histórico:', fmt(minPool), minPool < 0 ? '❌ INSOLVENCIA' : '✅ nunca negativo');
console.log('\nDistribución de premios:');
for (const [k, v] of Object.entries(wins).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(7)}  ${(v / N * 100).toFixed(3)}%`);
}
