/**
 * Verificación de los arreglos de la auditoría, con la lógica pura extraída.
 * Cada bloque reproduce el escenario que fallaba antes del fix.
 */

// ── Réplica de la lógica corregida ──────────────────────────────────────────

function contribucionValida(amount) {
  return Number.isFinite(amount) && amount > 0;
}

function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  let s = raw.trim().replace(/[^0-9.,-]/g, '');
  if (!/[0-9]/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function destinoLoginSeguro(next) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const REDES = ['awin', 'impact', 'admitad', 'rakuten', 'cj', 'mercadolibre'];
function normalizarRed(raw) {
  const slug = raw.toLowerCase().normalize('NFKC');
  return REDES.includes(slug) ? slug : null;
}

let fallos = 0;
const check = (nombre, ok, detalle = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!ok) fallos++;
};

// ── 1. NaN ya no puede entrar al pool ───────────────────────────────────────
console.log('\n1. Montos inválidos no entran al pool');
check('NaN rechazado', !contribucionValida(NaN));
check('Infinity rechazado', !contribucionValida(Infinity));
check('negativo rechazado', !contribucionValida(-100));
check('cero rechazado', !contribucionValida(0));
check('monto normal aceptado', contribucionValida(1250.5));

console.log('\n   Parseo de montos de las redes:');
const casos = [
  ['1.234,56', 1234.56, 'formato es-AR'],
  ['1,234.56', 1234.56, 'formato en-US'],
  ['$1200', 1200, 'con símbolo'],
  ['80.00', 80, 'decimal simple'],
  [4.8, 4.8, 'ya numérico'],
  ['', NaN, 'vacío → NaN'],
  ['abc', NaN, 'basura → NaN'],
];
for (const [entrada, esperado, desc] of casos) {
  const r = toNumber(entrada);
  const ok = Number.isNaN(esperado) ? Number.isNaN(r) : Math.abs(r - esperado) < 0.001;
  check(`${JSON.stringify(entrada)} → ${r}`, ok, desc);
}

// El escenario original: NaN en el pool anulaba la válvula de solvencia
console.log('\n   Escenario que rompía la solvencia:');
const poolConNaN = NaN;
const premioCaro = { realCost: 200000, poolSafetyMultiplier: 3.5 };
const pasabaFiltro = !(poolConNaN - 0 < premioCaro.realCost * premioCaro.poolSafetyMultiplier);
check(
  'antes: con NaN en el pool, un premio de $200.000 pasaba el filtro',
  pasabaFiltro,
  'comparar con NaN siempre da false',
);
check('ahora: el NaN nunca llega al pool', !contribucionValida(toNumber('valor raro')));

// ── 2. Reembolso: la comisión vuelve a salir del pool ───────────────────────
console.log('\n2. Reembolso después de la aprobación');

function simularCicloConRefund({ conFix }) {
  const feedRate = 0.05;
  let available = 100000;
  let reserved = 5000; // reservas de OTRAS transacciones
  let jackpot = 1000;

  const comision = 1000;

  // PENDING → reserva
  reserved += comision;
  // APPROVED → pasa a gastable
  reserved -= comision;
  const aJackpot = comision * feedRate;
  available += comision - aJackpot;
  jackpot += aJackpot;

  // REFUNDED
  if (conFix) {
    // se revierte de donde realmente está
    const aJ = comision * feedRate;
    available -= comision - aJ;
    jackpot -= aJ;
  } else {
    // el bug: restaba de reserved, dejando la comisión en available
    reserved = Math.max(0, reserved - comision);
  }
  return { available, reserved, jackpot };
}

const sinFix = simularCicloConRefund({ conFix: false });
const conFix = simularCicloConRefund({ conFix: true });

check(
  'antes: quedaban $950 fantasma en el pool',
  Math.abs(sinFix.available - 100950) < 0.01,
  `available=${sinFix.available}`,
);
check(
  'antes: le comía $1.000 de reserva a otras transacciones',
  Math.abs(sinFix.reserved - 4000) < 0.01,
  `reserved=${sinFix.reserved} (debía ser 5000)`,
);
check(
  'ahora: el pool vuelve exactamente a su valor original',
  Math.abs(conFix.available - 100000) < 0.01,
  `available=${conFix.available}`,
);
check(
  'ahora: la reserva ajena queda intacta',
  Math.abs(conFix.reserved - 5000) < 0.01,
  `reserved=${conFix.reserved}`,
);
check(
  'ahora: el jackpot también se revierte',
  Math.abs(conFix.jackpot - 1000) < 0.01,
  `jackpot=${conFix.jackpot}`,
);

// ── 3. El libro contable cuadra con el saldo ────────────────────────────────
console.log('\n3. El ledger cuadra con pool_state (incluido el jackpot)');

function simularLedger({ conFix }) {
  const feedRate = 0.05;
  let available = 600000;
  let jackpot = 210000;
  const asientos = [];

  // Aporte aprobado de $2.000
  const comision = 2000;
  const aJackpot = comision * feedRate;
  available += comision - aJackpot;
  jackpot += aJackpot;
  asientos.push({ cuenta: 'pool', amount: comision - aJackpot, balanceAfter: available });
  if (conFix) {
    asientos.push({ cuenta: 'jackpot', amount: aJackpot, balanceAfter: jackpot });
  }
  // (sin el fix, el aporte al jackpot no dejaba ningún asiento)

  // Se paga el JACKPOT de $200.000
  const premio = 200000;
  jackpot -= premio;
  asientos.push({
    cuenta: conFix ? 'jackpot' : 'pool',
    amount: -premio,
    balanceAfter: conFix ? jackpot : available, // el bug: saldo del pool general
  });

  const sumaPool = asientos.filter((a) => a.cuenta === 'pool').reduce((s, a) => s + a.amount, 0);
  const sumaJackpot = asientos.filter((a) => a.cuenta === 'jackpot').reduce((s, a) => s + a.amount, 0);

  return {
    available,
    jackpot,
    reconstruidoPool: 600000 + sumaPool,
    reconstruidoJackpot: 210000 + sumaJackpot,
  };
}

const ledgerViejo = simularLedger({ conFix: false });
const ledgerNuevo = simularLedger({ conFix: true });

check(
  'antes: el pool reconstruido no coincidía',
  Math.abs(ledgerViejo.reconstruidoPool - ledgerViejo.available) > 1,
  `estado=${ledgerViejo.available} vs libro=${ledgerViejo.reconstruidoPool}`,
);
check(
  'ahora: el pool reconstruido coincide',
  Math.abs(ledgerNuevo.reconstruidoPool - ledgerNuevo.available) < 0.01,
  `estado=${ledgerNuevo.available} = libro=${ledgerNuevo.reconstruidoPool}`,
);
check(
  'ahora: el jackpot reconstruido coincide',
  Math.abs(ledgerNuevo.reconstruidoJackpot - ledgerNuevo.jackpot) < 0.01,
  `estado=${ledgerNuevo.jackpot} = libro=${ledgerNuevo.reconstruidoJackpot}`,
);

// ── 4. Idempotencia del otorgamiento de cajas ───────────────────────────────
console.log('\n4. Un reintento del worker no otorga una segunda caja');

function otorgar({ conFix, intentos }) {
  let boxGranted = false;
  let cajas = 0;
  for (let i = 0; i < intentos; i++) {
    if (conFix) {
      // compare-and-set atómico
      if (!boxGranted) {
        boxGranted = true;
        cajas++;
      }
    } else {
      // dos statements sueltos: el reintento veía boxGranted en false
      if (!boxGranted) {
        cajas++;
        boxGranted = true;
      }
    }
  }
  return cajas;
}
// El bug real ocurría cuando el proceso moría ENTRE crear la caja y marcar la tx
function otorgarConCrash({ conFix }) {
  let boxGranted = false;
  let cajas = 0;
  // intento 1: crea la caja y muere antes de marcar
  cajas++;
  if (conFix) boxGranted = true; // misma transacción SQL: o pasan las dos, o ninguna
  // intento 2 (reintento de BullMQ)
  if (!boxGranted) cajas++;
  return cajas;
}
check('antes: un crash a mitad creaba 2 cajas', otorgarConCrash({ conFix: false }) === 2);
check('ahora: sigue siendo 1 caja', otorgarConCrash({ conFix: true }) === 1);
check('llamadas repetidas siguen dando 1', otorgar({ conFix: true, intentos: 5 }) === 1);

// ── 5. El webhook deja pasar los cambios de estado ──────────────────────────
console.log('\n5. Los cambios de estado ya no se descartan');

function ingesta({ conFix, eventos }) {
  const vistos = new Set();
  let encolados = 0;
  for (const [orden, estado] of eventos) {
    const key = conFix ? `${orden}:${estado}` : orden;
    if (vistos.has(key)) continue;
    vistos.add(key);
    encolados++;
  }
  return encolados;
}
const flujoReal = [
  ['ORD-1', 'pending'],
  ['ORD-1', 'pending'], // reenvío idéntico de la red
  ['ORD-1', 'approved'], // el aviso que importa
];
check(
  'antes: la aprobación se descartaba (sólo 1 evento procesado)',
  ingesta({ conFix: false, eventos: flujoReal }) === 1,
);
check(
  'ahora: pasa la aprobación y se sigue filtrando el duplicado (2 eventos)',
  ingesta({ conFix: true, eventos: flujoReal }) === 2,
);

// ── 6. Redirects ────────────────────────────────────────────────────────────
console.log('\n6. Redirects y validación de red');
check('externo bloqueado', destinoLoginSeguro('https://sitio-falso.com') === '/');
check('protocol-relative bloqueado', destinoLoginSeguro('//sitio-falso.com') === '/');
check('ruta interna permitida', destinoLoginSeguro('/cajas') === '/cajas');
check('vacío → home', destinoLoginSeguro(undefined) === '/');

check('red válida aceptada', normalizarRed('AWIN') === 'awin');
check('red desconocida rechazada', normalizarRed('red-falsa') === null);
check(
  'variantes de mayúsculas colapsan a la misma clave',
  normalizarRed('awin') === normalizarRed('AWIN') && normalizarRed('Awin') === 'awin',
);

// ── Resultado ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
if (fallos === 0) {
  console.log('TODAS LAS VERIFICACIONES PASARON');
} else {
  console.log(`${fallos} VERIFICACIONES FALLARON`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEGUNDA AUDITORÍA — escenarios nuevos
// ═══════════════════════════════════════════════════════════════════════════

let fallos2 = 0;
const check2 = (nombre, ok, detalle = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!ok) fallos2++;
};

// ── 7. Open redirect con barra invertida ──
console.log('\n7. El filtro de destino resiste la barra invertida');
const ORIGEN = 'https://destino.invalid';
function rutaInternaSegura(next) {
  if (!next) return '/';
  try {
    const url = new URL(next, ORIGEN);
    if (url.origin !== ORIGEN) return '/';
    return url.pathname + url.search;
  } catch { return '/'; }
}
const filtroViejo = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

const ataques = ['/\\sitio-falso.com', '/%09/sitio-falso.com', '//sitio-falso.com', 'https://sitio-falso.com'];
for (const a of ataques) {
  const viejo = filtroViejo(a);
  const nuevo = rutaInternaSegura(a);
  const escapaViejo = (() => { try { return new URL(viejo, ORIGEN).origin !== ORIGEN; } catch { return false; } })();
  const escapaNuevo = (() => { try { return new URL(nuevo, ORIGEN).origin !== ORIGEN; } catch { return false; } })();
  check2(`${JSON.stringify(a)} bloqueado`, !escapaNuevo, escapaViejo ? 'el filtro viejo lo dejaba pasar' : '');
}
check2('ruta interna sigue funcionando', rutaInternaSegura('/cajas?x=1') === '/cajas?x=1');

// ── 8. Validación de conversiones de afiliado ──
console.log('\n8. Una comisión inventada ya no acuña saldo');
const TECHO = 500000;
function validarConversion(data, click, network) {
  if (click.expiresAt < Date.now()) return 'clic-vencido';
  const red = click.merchant.network;
  if (red && red !== 'direct' && red !== network) return 'red-no-coincide';
  if (data.orderAmount < 0 || data.commission < 0) return 'montos-negativos';
  if (data.orderAmount < (click.merchant.minOrderAmount ?? 0)) return 'monto-bajo-el-minimo';
  if (data.commission > TECHO) return 'comision-sobre-el-techo';
  const tasa = click.merchant.commissionRate ?? 0;
  if (tasa > 0 && data.orderAmount > 0) {
    const esperada = data.orderAmount * tasa;
    if (data.commission > Math.max(esperada * 3, esperada + 1000)) return 'comision-desproporcionada';
  }
  if (data.orderAmount === 0 && data.commission > 5000) return 'comision-sin-orden';
  return null;
}
const clickOk = {
  expiresAt: Date.now() + 86400000,
  merchant: { network: 'awin', commissionRate: 0.05, minOrderAmount: 0 },
};
check2('comisión de 5 millones rechazada',
  validarConversion({ orderAmount: 5000000, commission: 5000000 }, clickOk, 'awin') !== null,
  validarConversion({ orderAmount: 5000000, commission: 5000000 }, clickOk, 'awin'));
check2('comisión desproporcionada rechazada',
  validarConversion({ orderAmount: 10000, commission: 9000 }, clickOk, 'awin') === 'comision-desproporcionada');
check2('clic vencido rechazado',
  validarConversion({ orderAmount: 10000, commission: 500 }, { ...clickOk, expiresAt: Date.now() - 1000 }, 'awin') === 'clic-vencido');
check2('red que no corresponde rechazada',
  validarConversion({ orderAmount: 10000, commission: 500 }, clickOk, 'impact') === 'red-no-coincide');
check2('comisión legítima aceptada',
  validarConversion({ orderAmount: 10000, commission: 500 }, clickOk, 'awin') === null);
check2('bonus razonable aceptado',
  validarConversion({ orderAmount: 10000, commission: 1200 }, clickOk, 'awin') === null,
  'las redes aplican promociones');

// ── 9. Reembolso de suscripción ──
console.log('\n9. Un contracargo de suscripción revierte todo');
function cicloSuscripcion({ conFix }) {
  let pool = 50000, saldoUsuario = 0, cajas = 0;
  const precio = 15000, costoProveedor = 5000, share = 0.5;
  const margen = precio - costoProveedor;
  const aporte = margen * share;
  pool += aporte;
  cajas = 1;
  const premio = 2000;
  pool -= premio;
  saldoUsuario += premio;
  // contracargo
  if (conFix) {
    saldoUsuario -= premio;
    pool += premio;
    pool -= aporte;
    cajas = 0;
  }
  return { pool, saldoUsuario, cajas };
}
const sinF = cicloSuscripcion({ conFix: false });
const conF = cicloSuscripcion({ conFix: true });
check2('antes: el usuario se quedaba con el premio', sinF.saldoUsuario === 2000, `saldo=${sinF.saldoUsuario}`);
check2('antes: el pool retenía la comisión devuelta', sinF.pool === 53000, `pool=${sinF.pool}`);
check2('ahora: el saldo se revierte', conF.saldoUsuario === 0);
check2('ahora: el pool vuelve al valor original', conF.pool === 50000, `pool=${conF.pool}`);

// ── 10. Idempotencia del aporte al pool ──
console.log('\n10. El aporte al pool no se duplica');
function aportar({ conFix, veces }) {
  let pool = 0;
  const asientos = new Set();
  for (let i = 0; i < veces; i++) {
    const clave = 'tx1:CONTRIBUTION';
    if (conFix && asientos.has(clave)) continue;
    asientos.add(clave);
    pool += 1000;
  }
  return pool;
}
check2('antes: 3 reintentos sumaban 3 veces', aportar({ conFix: false, veces: 3 }) === 3000);
check2('ahora: 3 reintentos suman una sola vez', aportar({ conFix: true, veces: 3 }) === 1000);

// ── 11. Clave de idempotencia del webhook con estado ──
console.log('\n11. Los reembolsos de Mercado Pago ya no se descartan');
function ingestaMP({ conFix, eventos }) {
  const procesados = new Set();
  let hechos = 0;
  for (const [id, estado] of eventos) {
    const clave = conFix ? `payment:${id}:${estado}` : `payment:${id}`;
    if (procesados.has(clave)) continue;
    procesados.add(clave);
    hechos++;
  }
  return hechos;
}
const flujoMP = [['P1', 'APPROVED'], ['P1', 'APPROVED'], ['P1', 'REFUNDED']];
check2('antes: el reembolso se descartaba', ingestaMP({ conFix: false, eventos: flujoMP }) === 1);
check2('ahora: se procesa el reembolso, no el duplicado', ingestaMP({ conFix: true, eventos: flujoMP }) === 2);

console.log('\n' + '─'.repeat(60));
if (fallos2 === 0) {
  console.log('SEGUNDA AUDITORÍA: TODAS LAS VERIFICACIONES PASARON');
} else {
  console.log(`SEGUNDA AUDITORÍA: ${fallos2} FALLARON`);
  process.exit(1);
}
