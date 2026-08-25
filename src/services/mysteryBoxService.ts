// ============================================================================
// src/services/mysteryBoxService.ts
// MisteryBox — Unboxing Engine
// ----------------------------------------------------------------------------
// Responsabilidades:
//   1. Seleccionar un premio ponderado sin riesgo de insolvencia.
//   2. Respetar el RTP objetivo (E[costo] ≤ RTP × comisión que financió la caja).
//   3. Aplicar la válvula de jackpot (pool ≥ costo × safetyMultiplier).
//   4. Aplicar escrow: si la transacción origen está PENDING, el premio nace LOCKED.
//   5. Debitar el pool y escribir el asiento contable en la MISMA transacción SQL.
//
// Reglas duras:
//   - RNG criptográfico (nunca Math.random).
//   - Todo el unboxing corre dentro de una tx Serializable con lock sobre PoolState.
//   - La caja SIEMPRE entrega algo: si nada es elegible, cae a premios de costo 0.
//   - El cliente jamás ve la tabla de pesos; solo el resultado.
// ============================================================================

import { randomInt } from 'crypto';
import {
  Prisma,
  PrizeType,
  RewardStatus,
  UserBoxStatus,
  LedgerEntryType,
  TransactionStatus,
  WalletTxType,
} from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';

// ─────────────────────────── Tipos ───────────────────────────

export interface OpenBoxInput {
  userId: string;
  userBoxId: string;
  ip?: string;
}

export interface OpenBoxResult {
  rewardId: string;
  prize: {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    type: PrizeType;
    perceivedValue: number;
  };
  status: RewardStatus;             // LOCKED o UNLOCKED
  redemptionCode: string | null;
  unlockEstimateAt: Date | null;    // cuándo se libera si está LOCKED
  poolBalanceAfter: number;
  jackpotBalance: number;
}

export class UnboxingError extends Error {
  constructor(message: string, public code: string, public httpStatus = 400) {
    super(message);
    this.name = 'UnboxingError';
  }
}

/** Premio candidato ya normalizado a number para el cálculo */
interface Candidate {
  id: string;
  name: string;
  type: PrizeType;
  realCost: number;
  perceivedValue: number;
  baseWeight: number;
  poolSafetyMultiplier: number;
  isJackpot: boolean;
  stock: number;          // -1 = ilimitado
  stockClaimed: number;
  maxPerUser: number;
}

// ─────────────────────────── Utilidades numéricas ───────────────────────────

const d = (v: Prisma.Decimal | number | string): number => Number(v);
const money = (n: number): Prisma.Decimal => new Prisma.Decimal(n.toFixed(2));

/**
 * RNG criptográfico uniforme en [0, 1).
 * randomInt es rechazo-uniforme (sin sesgo de módulo), a diferencia de
 * derivar un float de bytes crudos.
 */
function secureRandom(): number {
  // 2^48 - 1 es el rango máximo que acepta randomInt en Node.
  // randomInt(0, R) devuelve [0, R-1], así que el resultado queda en [0, 1).
  const RANGE = 2 ** 48 - 1;
  return randomInt(0, RANGE) / RANGE;
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIÓN PURA 1 — Filtro de elegibilidad (solvencia + stock + límites)
// ═══════════════════════════════════════════════════════════════════════════

export interface EligibilityContext {
  poolAvailable: number;      // saldo gastable del pool
  reserveFloor: number;       // colchón intocable
  maxPayoutPerOpen: number;   // tope duro de la caja
  jackpotBalance: number;
  jackpotEnabled: boolean;
  userPrizeCounts: Record<string, number>; // prizeId -> veces que ya lo ganó
}

/**
 * Un premio es elegible si:
 *  a) tiene stock,
 *  b) el usuario no superó su límite personal,
 *  c) no supera el tope duro de la caja,
 *  d) el pool puede pagarlo con el multiplicador de seguridad Y sin perforar el floor.
 *
 * Premios de costo 0 (cupones propios, descuentos) son SIEMPRE elegibles:
 * son el piso que garantiza que la caja nunca quede vacía.
 */
export function filterEligible(candidates: Candidate[], ctx: EligibilityContext): Candidate[] {
  return candidates.filter((p) => {
    // a) stock
    if (p.stock !== -1 && p.stockClaimed >= p.stock) return false;

    // b) límite por usuario
    if (p.maxPerUser > 0 && (ctx.userPrizeCounts[p.id] ?? 0) >= p.maxPerUser) return false;

    // Costo cero: siempre entra (no toca el pool)
    if (p.realCost <= 0) return true;

    // c) tope duro por apertura
    if (p.realCost > ctx.maxPayoutPerOpen) return false;

    // d) válvula de solvencia
    if (p.isJackpot) {
      if (!ctx.jackpotEnabled) return false;
      // El jackpot se paga de su propia bolsa
      if (ctx.jackpotBalance < p.realCost) return false;
      return true;
    }

    const spendable = ctx.poolAvailable - ctx.reserveFloor;
    if (spendable < p.realCost * p.poolSafetyMultiplier) return false;

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIÓN PURA 2 — Ajuste de pesos por presupuesto de RTP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El presupuesto de premio de una caja es `fundingAmount × targetRtp`.
 * Ej: la compra dejó $10 de comisión y el RTP objetivo es 50% → presupuesto $5.
 *
 * Sin ajuste, un set de premios caros haría E[costo] > presupuesto y la
 * plataforma perdería plata en el largo plazo. La corrección:
 *
 *   1. Se calcula E[costo] con los pesos base.
 *   2. Si E[costo] > presupuesto, se penalizan exponencialmente los premios caros
 *      hasta que E[costo] converge al presupuesto (búsqueda binaria sobre λ).
 *
 *   peso_ajustado_i = peso_base_i × exp(−λ × costo_i / presupuesto)
 *
 * λ = 0 → pesos originales. λ alto → casi todo el peso va a los premios baratos.
 * Es monótona en λ, así que la búsqueda binaria converge siempre.
 *
 * Ventaja sobre "borrar premios caros": el premio caro sigue siendo posible
 * (marketing honesto: está en la tabla y puede salir), solo que con la
 * probabilidad exacta que el negocio puede sostener.
 */
export function applyRtpBudget(
  candidates: Candidate[],
  budget: number,
  options: { allowBoost?: boolean } = {},
): { prize: Candidate; weight: number }[] {
  const { allowBoost = true } = options;

  if (candidates.length === 0) return [];
  if (budget <= 0) {
    // Sin presupuesto: solo premios de costo cero
    const free = candidates.filter((c) => c.realCost <= 0);
    return (free.length ? free : candidates).map((prize) => ({ prize, weight: prize.baseWeight }));
  }

  const expectedCost = (lambda: number): number => {
    let totalW = 0;
    let totalC = 0;
    for (const c of candidates) {
      const w = c.baseWeight * Math.exp(-lambda * (c.realCost / budget));
      totalW += w;
      totalC += w * c.realCost;
    }
    return totalW === 0 ? 0 : totalC / totalW;
  };

  const baseline = expectedCost(0);

  // Empate perfecto: usar los pesos tal cual
  if (Math.abs(baseline - budget) < budget * 0.001) {
    return candidates.map((prize) => ({ prize, weight: prize.baseWeight }));
  }

  // Si la tabla es más barata que el presupuesto y no queremos boost, no tocamos nada.
  // (No boostear es "más rentable" pero entrega menos de lo que el RTP promete:
  //  el panel de admin muestra RTP real vs teórico justamente para calibrar esto.)
  if (baseline < budget && !allowBoost) {
    return candidates.map((prize) => ({ prize, weight: prize.baseWeight }));
  }

  // E[costo](λ) es monótona decreciente en λ → búsqueda binaria bidireccional.
  //   λ > 0 penaliza premios caros (tabla demasiado generosa)
  //   λ < 0 los favorece (tabla demasiado tacaña frente al RTP prometido)
  let lo = baseline > budget ? 0 : -24;
  let hi = baseline > budget ? 64 : 0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (expectedCost(mid) > budget) lo = mid;
    else hi = mid;
  }
  const lambda = hi;

  const weighted = candidates
    .map((prize) => ({
      prize,
      weight: prize.baseWeight * Math.exp(-lambda * (prize.realCost / budget)),
    }))
    .filter((x) => Number.isFinite(x.weight) && x.weight > 1e-12);

  // Guardarraíl: E[costo] resultante nunca puede exceder el presupuesto.
  const total = weighted.reduce((s, x) => s + x.weight, 0);
  const ev = weighted.reduce((s, x) => s + x.weight * x.prize.realCost, 0) / (total || 1);
  if (ev > budget * 1.02) {
    // No convergió (caso patológico: todos los premios cuestan más que el budget).
    // Degradamos a los premios que el presupuesto sí banca.
    const affordable = candidates.filter((c) => c.realCost <= budget);
    if (affordable.length) return affordable.map((prize) => ({ prize, weight: prize.baseWeight }));
  }

  return weighted;
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIÓN PURA 3 — Selección ponderada
// ═══════════════════════════════════════════════════════════════════════════

export function weightedPick<T>(
  items: { prize: T; weight: number }[],
  random: number,
): { picked: T; roll: number } {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) throw new UnboxingError('No hay premios elegibles', 'NO_ELIGIBLE_PRIZES', 500);

  let threshold = random * total;
  for (const item of items) {
    threshold -= item.weight;
    if (threshold <= 0) return { picked: item.prize, roll: random };
  }
  return { picked: items[items.length - 1].prize, roll: random };
}

/** Composición pura y testeable: dado el contexto, ¿qué premio sale? */
export function selectPrize(
  candidates: Candidate[],
  ctx: EligibilityContext,
  budget: number,
  random: number,
): { prize: Candidate; weights: { id: string; weight: number }[] } {
  let eligible = filterEligible(candidates, ctx);

  // Fallback: nunca dejamos la caja vacía
  if (eligible.length === 0) {
    eligible = candidates.filter(
      (c) => c.realCost <= 0 && (c.stock === -1 || c.stockClaimed < c.stock),
    );
    if (eligible.length === 0) {
      throw new UnboxingError(
        'No hay premios disponibles para esta caja. Contactá a soporte.',
        'NO_ELIGIBLE_PRIZES',
        503,
      );
    }
  }

  const weighted = applyRtpBudget(eligible, budget);
  const { picked } = weightedPick(weighted, random);

  return {
    prize: picked,
    weights: weighted.map((w) => ({ id: w.prize.id, weight: Number(w.weight.toFixed(6)) })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ORQUESTADOR — abre la caja dentro de una transacción SQL serializable
// ═══════════════════════════════════════════════════════════════════════════

export async function openMysteryBox(input: OpenBoxInput): Promise<OpenBoxResult> {
  const { userId, userBoxId, ip } = input;

  return prisma.$transaction(
    async (tx) => {
      // ── 1. Lock de la caja (evita doble apertura por doble clic / carrera) ──
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM user_boxes
        WHERE id = ${userBoxId}::uuid AND "userId" = ${userId}::uuid AND status = 'AVAILABLE'
        FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        throw new UnboxingError('La caja no existe, ya fue abierta o no te pertenece', 'BOX_UNAVAILABLE', 409);
      }

      const box = await tx.userBox.findUniqueOrThrow({
        where: { id: userBoxId },
        include: { boxCatalog: true, transaction: true },
      });

      if (box.expiresAt < new Date()) {
        await tx.userBox.update({ where: { id: box.id }, data: { status: UserBoxStatus.EXPIRED } });
        throw new UnboxingError('Esta caja expiró', 'BOX_EXPIRED', 410);
      }
      if (!box.boxCatalog.isActive) {
        throw new UnboxingError('Este tipo de caja está temporalmente deshabilitado', 'BOX_DISABLED', 423);
      }

      // ── 2. Lock del pool (serializa todas las aperturas concurrentes) ──
      await tx.$queryRaw`SELECT id FROM pool_state WHERE id = 'singleton' FOR UPDATE`;
      const pool = await tx.poolState.findUniqueOrThrow({ where: { id: 'singleton' } });

      const jackpotFlag = await tx.featureFlag.findUnique({ where: { key: 'jackpot.enabled' } });

      // ── 3. Candidatos + historial del usuario ──
      const now = new Date();
      const prizes = await tx.prize.findMany({
        where: {
          boxCatalogId: box.boxCatalogId,
          isActive: true,
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ validTo: null }, { validTo: { gte: now } }] },
          ],
        },
      });
      if (prizes.length === 0) {
        throw new UnboxingError('Esta caja no tiene premios configurados', 'NO_PRIZES_CONFIGURED', 503);
      }

      const previousWins = await tx.userReward.groupBy({
        by: ['prizeId'],
        where: { userId, status: { not: RewardStatus.REVOKED } },
        _count: { prizeId: true },
      });
      const userPrizeCounts: Record<string, number> = {};
      for (const w of previousWins) userPrizeCounts[w.prizeId] = w._count.prizeId;

      const candidates: Candidate[] = prizes.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        realCost: d(p.realCost),
        perceivedValue: d(p.perceivedValue),
        baseWeight: p.baseWeight,
        poolSafetyMultiplier: d(p.poolSafetyMultiplier),
        isJackpot: p.isJackpot,
        stock: p.stock,
        stockClaimed: p.stockClaimed,
        maxPerUser: p.maxPerUser,
      }));

      // ── 4. Selección ──
      const targetRtp = d(box.boxCatalog.targetRtp);
      const budget = d(box.fundingAmount) * targetRtp;
      const poolAvailable = d(pool.availableBalance);

      const ctx: EligibilityContext = {
        poolAvailable,
        reserveFloor: d(pool.reserveFloor),
        maxPayoutPerOpen: d(box.boxCatalog.maxPayoutPerOpen),
        jackpotBalance: d(pool.jackpotBalance),
        jackpotEnabled: jackpotFlag?.enabled ?? false,
        userPrizeCounts,
      };

      const roll = secureRandom();
      const { prize: won, weights } = selectPrize(candidates, ctx, budget, roll);
      const prizeRow = prizes.find((p) => p.id === won.id)!;

      // ── 5. Débito del pool + asiento contable ──
      let newAvailable = poolAvailable;
      let newJackpot = d(pool.jackpotBalance);

      if (won.realCost > 0) {
        if (won.isJackpot) newJackpot -= won.realCost;
        else newAvailable -= won.realCost;

        await tx.poolState.update({
          where: { id: 'singleton' },
          data: {
            availableBalance: money(newAvailable),
            jackpotBalance: money(newJackpot),
            lifetimePayouts: money(d(pool.lifetimePayouts) + won.realCost),
          },
        });

        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.PAYOUT,
            amount: money(-won.realCost),
            // Un premio de jackpot sale de `jackpotBalance`, no del pool general.
            // Asentar acá el saldo del pool general (que no se movió) rompía la
            // cadena del libro: reconstruir el saldo sumando asientos daba un
            // número distinto al de pool_state, y la contabilidad dejaba de cuadrar.
            balanceAfter: money(won.isJackpot ? newJackpot : newAvailable),
            userId,
            transactionId: box.sourceTransactionId,
            description: won.isJackpot
              ? `JACKPOT "${won.name}" (bolsa de jackpot)`
              : `Premio "${won.name}" (caja ${box.tier})`,
          },
        });
      }

      // ── 6. Stock ──
      if (won.stock !== -1) {
        await tx.prize.update({
          where: { id: won.id },
          data: { stockClaimed: { increment: 1 } },
        });
      }

      // ── 7. Escrow: ¿el premio nace LOCKED o UNLOCKED? ──
      //  - Premio de costo real 0 → UNLOCKED siempre (gratificación inmediata sin riesgo).
      //  - Premio con costo → depende del estado de la transacción que lo financió.
      const sourceApproved =
        !box.sourceTransactionId || box.transaction?.status === TransactionStatus.APPROVED;
      const rewardStatus =
        won.realCost <= 0 || sourceApproved ? RewardStatus.UNLOCKED : RewardStatus.LOCKED;

      const redemptionCode =
        won.type === PrizeType.STORE_DISCOUNT || won.type === PrizeType.DIGITAL_ASSET
          ? generateRedemptionCode()
          : null;

      const reward = await tx.userReward.create({
        data: {
          userId,
          prizeId: won.id,
          userBoxId: box.id,
          status: rewardStatus,
          realCost: money(won.realCost),
          perceivedValue: money(won.perceivedValue),
          redemptionCode,
          redemptionData: (prizeRow.payload ?? undefined) as Prisma.InputJsonValue | undefined,
          unlockedAt: rewardStatus === RewardStatus.UNLOCKED ? now : null,
          expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
        },
      });

      // ── 8. Si es saldo, acreditar en la billetera (available vs locked) ──
      if (won.type === PrizeType.WALLET_CASH || won.type === PrizeType.CASHBACK_REFUND) {
        const amount = won.realCost;
        if (rewardStatus === RewardStatus.UNLOCKED) {
          const user = await tx.user.update({
            where: { id: userId },
            data: { balanceAvailable: { increment: money(amount) } },
          });
          await tx.walletTransaction.create({
            data: {
              userId,
              type: 'PRIZE_CREDIT',
              amount: money(amount),
              balanceAfter: user.balanceAvailable,
              description: `Premio: ${won.name}`,
              rewardId: reward.id,
            },
          });
        } else {
          await tx.user.update({
            where: { id: userId },
            data: { balanceLocked: { increment: money(amount) } },
          });
        }
      }

      // ── 9. Auditoría inmutable de la apertura ──
      await tx.boxOpening.create({
        data: {
          userBoxId: box.id,
          userId,
          prizeId: won.id,
          poolBalanceBefore: money(poolAvailable),
          poolBalanceAfter: money(newAvailable),
          eligibleSnapshot: { budget, targetRtp, weights } as Prisma.InputJsonValue,
          randomValue: new Prisma.Decimal(roll.toFixed(18)),
          rtpAtOpen: new Prisma.Decimal(targetRtp.toFixed(4)),
          fundingAmount: box.fundingAmount,
          ip: ip ?? null,
        },
      });

      await tx.userBox.update({
        where: { id: box.id },
        data: { status: UserBoxStatus.OPENED, openedAt: now },
      });

      return {
        rewardId: reward.id,
        prize: {
          id: won.id,
          name: won.name,
          description: prizeRow.description,
          imageUrl: prizeRow.imageUrl,
          type: won.type,
          perceivedValue: won.perceivedValue,
        },
        status: rewardStatus,
        redemptionCode,
        unlockEstimateAt:
          rewardStatus === RewardStatus.LOCKED ? box.transaction?.escrowReleaseAt ?? null : null,
        poolBalanceAfter: newAvailable,
        jackpotBalance: newJackpot,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
  );
}

function generateRedemptionCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// APORTES AL POOL — llamado por el webhook handler / worker
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registra el aporte de una transacción al pool.
 *  - status PENDING  → RESERVE (apartado, no gastable)
 *  - status APPROVED → CONTRIBUTION (gastable) + alimenta jackpot
 */
export async function contributeToPool(params: {
  transactionId: string;
  amount: number;
  status: TransactionStatus;
  userId: string;
}): Promise<void> {
  const { transactionId, amount, status, userId } = params;

  // `amount` viene de parsear el payload de una red de afiliados. Un formato
  // inesperado ("1.234,56", "$1200") produce NaN, y `NaN <= 0` es false: sin
  // este chequeo el NaN entraba al saldo del pool y quedaba pegado ahí. A
  // partir de ese momento toda comparación de solvencia da false y CUALQUIER
  // premio pasa el filtro — la válvula anti-insolvencia queda anulada y no se
  // recupera sin cirugía manual en la base.
  if (!Number.isFinite(amount) || amount <= 0) {
    if (!Number.isFinite(amount)) {
      console.error(
        `[pool] aporte descartado por monto inválido (${amount}) en la tx ${transactionId}`,
      );
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM pool_state WHERE id = 'singleton' FOR UPDATE`;
    const pool = await tx.poolState.findUniqueOrThrow({ where: { id: 'singleton' } });

    if (status === TransactionStatus.PENDING) {
      const reserved = d(pool.reservedBalance) + amount;
      await tx.poolState.update({
        where: { id: 'singleton' },
        data: { reservedBalance: money(reserved) },
      });
      await tx.prizePoolLedger.create({
        data: {
          type: LedgerEntryType.RESERVE,
          amount: money(amount),
          balanceAfter: pool.availableBalance,
          transactionId,
          userId,
          description: 'Comisión pendiente apartada (ventana de devolución)',
        },
      });
      return;
    }

    if (status === TransactionStatus.APPROVED) {
      const toJackpot = amount * d(pool.jackpotFeedRate);
      const toPool = amount - toJackpot;
      const newJackpot = d(pool.jackpotBalance) + toJackpot;

      const newAvailable = d(pool.availableBalance) + toPool;

      // Sólo se libera reserva si esta transacción efectivamente tenía una.
      // Restar a ciegas del saldo global le comía la reserva a otras
      // transacciones pendientes cuando el primer postback llegaba ya aprobado.
      const hadReserve = await tx.prizePoolLedger.findFirst({
        where: { transactionId, type: LedgerEntryType.RESERVE },
      });
      const newReserved = hadReserve
        ? Math.max(0, d(pool.reservedBalance) - amount)
        : d(pool.reservedBalance);

      await tx.poolState.update({
        where: { id: 'singleton' },
        data: {
          availableBalance: money(newAvailable),
          reservedBalance: money(newReserved),
          jackpotBalance: money(newJackpot),
          lifetimeContributions: money(d(pool.lifetimeContributions) + amount),
        },
      });

      if (hadReserve) {
        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.RESERVE_RELEASE,
            amount: money(-amount),
            balanceAfter: money(newAvailable),
            transactionId,
            userId,
            description: 'Reserva liberada: comisión confirmada',
          },
        });
      }

      await tx.prizePoolLedger.create({
        data: {
          type: LedgerEntryType.CONTRIBUTION,
          amount: money(toPool),
          balanceAfter: money(newAvailable),
          transactionId,
          userId,
          description: 'Comisión aprobada al pool general',
        },
      });

      // El 5% que va al jackpot necesita su propio asiento: sin él, esa plata
      // entraba a pool_state sin dejar rastro en el libro y las dos fuentes
      // dejaban de cuadrar.
      if (toJackpot > 0) {
        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.JACKPOT_SEED,
            amount: money(toJackpot),
            balanceAfter: money(newJackpot),
            transactionId,
            userId,
            description: 'Aporte al jackpot progresivo',
          },
        });
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIBERACIÓN Y REVOCACIÓN DE ESCROW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La comisión se aprobó → los premios LOCKED de esa tx pasan a UNLOCKED.
 *
 * Cada premio se libera con un compare-and-set (`updateMany` filtrando por
 * status LOCKED). Sin eso, dos ejecuciones concurrentes —el cron horario
 * solapado con el webhook de aprobación, o dos réplicas del worker— leerían el
 * mismo premio LOCKED y ambas acreditarían el saldo: el usuario cobraría dos
 * veces y `balanceLocked` quedaría negativo.
 */
export async function releaseEscrowForTransaction(transactionId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rewards = await tx.userReward.findMany({
      where: { status: RewardStatus.LOCKED, userBox: { sourceTransactionId: transactionId } },
      include: { prize: true },
    });

    let released = 0;

    for (const r of rewards) {
      // Compare-and-set: sólo gana la primera ejecución que lo encuentre LOCKED.
      const claimed = await tx.userReward.updateMany({
        where: { id: r.id, status: RewardStatus.LOCKED },
        data: { status: RewardStatus.UNLOCKED, unlockedAt: new Date() },
      });
      if (claimed.count === 0) continue; // otra ejecución ya lo liberó

      released++;

      if (r.prize.type === PrizeType.WALLET_CASH || r.prize.type === PrizeType.CASHBACK_REFUND) {
        const amount = r.realCost;
        const user = await tx.user.update({
          where: { id: r.userId },
          data: {
            balanceLocked: { decrement: amount },
            balanceAvailable: { increment: amount },
          },
        });
        await tx.walletTransaction.create({
          data: {
            userId: r.userId,
            type: 'PRIZE_CREDIT',
            amount,
            balanceAfter: user.balanceAvailable,
            description: `Premio liberado: ${r.prize.name}`,
            rewardId: r.id,
          },
        });
      }
    }
    return released;
  });
}

/** La compra se reembolsó/rechazó → revocar premios no cobrados y revertir el pool. */
export async function revokeEscrowForTransaction(
  transactionId: string,
  reason = 'Compra cancelada o reembolsada por el comercio',
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM pool_state WHERE id = 'singleton' FOR UPDATE`;
    const pool = await tx.poolState.findUniqueOrThrow({ where: { id: 'singleton' } });

    const trx = await tx.transaction.findUnique({ where: { id: transactionId } });
    if (!trx) return;

    // Cajas todavía sin abrir → revocadas
    await tx.userBox.updateMany({
      where: { sourceTransactionId: transactionId, status: UserBoxStatus.AVAILABLE },
      data: { status: UserBoxStatus.REVOKED },
    });

    // Se revocan los premios LOCKED **y** los UNLOCKED que el usuario todavía no
    // canjeó. Limitarlo a LOCKED dejaba abierto el farmeo comprar-y-devolver:
    // si la comisión llegaba ya aprobada, el premio nacía UNLOCKED, el usuario
    // devolvía la compra y se quedaba con el saldo igual.
    // Los CLAIMED no se tocan: ya se entregaron, revertirlos sería quitarle al
    // usuario algo que ya usó. Esa pérdida se asume y queda registrada.
    const revocables = await tx.userReward.findMany({
      where: {
        status: { in: [RewardStatus.LOCKED, RewardStatus.UNLOCKED] },
        userBox: { sourceTransactionId: transactionId },
      },
      include: { prize: true },
    });

    let restored = d(pool.availableBalance);
    let restoredJackpot = d(pool.jackpotBalance);

    for (const r of revocables) {
      // Compare-and-set: no revocar algo que se canjeó mientras leíamos.
      const claimed = await tx.userReward.updateMany({
        where: { id: r.id, status: { in: [RewardStatus.LOCKED, RewardStatus.UNLOCKED] } },
        data: { status: RewardStatus.REVOKED, revokedReason: reason },
      });
      if (claimed.count === 0) continue;

      const cost = d(r.realCost);

      // Devolver el saldo acreditado, del bucket que corresponda
      if (r.prize.type === PrizeType.WALLET_CASH || r.prize.type === PrizeType.CASHBACK_REFUND) {
        if (r.status === RewardStatus.LOCKED) {
          await tx.user.update({
            where: { id: r.userId },
            data: { balanceLocked: { decrement: r.realCost } },
          });
        } else {
          const user = await tx.user.update({
            where: { id: r.userId },
            data: { balanceAvailable: { decrement: r.realCost } },
          });
          await tx.walletTransaction.create({
            data: {
              userId: r.userId,
              type: WalletTxType.REFUND,
              amount: money(-cost),
              balanceAfter: user.balanceAvailable,
              description: `Premio anulado: ${r.prize.name} (${reason})`,
              rewardId: r.id,
            },
          });
        }
      }

      // Devolver el stock consumido: un reembolso no debe quemar una unidad
      // de un premio con stock limitado.
      if (r.prize.stock !== -1) {
        await tx.prize.update({
          where: { id: r.prize.id },
          data: { stockClaimed: { decrement: 1 } },
        });
      }

      if (cost > 0) {
        if (r.prize.isJackpot) {
          restoredJackpot += cost;
        } else {
          restored += cost;
        }
        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.PAYOUT_REVERSAL,
            amount: money(cost),
            balanceAfter: money(restored),
            transactionId,
            userId: r.userId,
            description: `Reverso de premio revocado: ${r.prize.name}`,
          },
        });
      }
    }

    // ── Revertir el aporte de la comisión al pool ──
    // Según en qué estado estaba la transacción, ese aporte vive en un lugar
    // distinto. Restar siempre de `reservedBalance` (como se hacía antes) tenía
    // dos efectos malos a la vez: le comía reserva a transacciones ajenas, y
    // dejaba en `availableBalance` una comisión que el comercio ya recuperó —
    // o sea, el pool declaraba plata inexistente y la repartía en premios.
    const contribution = d(trx.poolContribution);
    let newReserved = d(pool.reservedBalance);

    if (contribution > 0) {
      if (trx.status === TransactionStatus.APPROVED) {
        // Ya había pasado a gastable (menos la parte que fue al jackpot)
        const toJackpot = contribution * d(pool.jackpotFeedRate);
        restored -= contribution - toJackpot;
        restoredJackpot -= toJackpot;

        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.ADJUSTMENT,
            amount: money(-(contribution - toJackpot)),
            balanceAfter: money(restored),
            transactionId,
            description: `Reverso de comisión ya acreditada: ${reason}`,
          },
        });
      } else {
        // Seguía apartada como reserva
        newReserved = Math.max(0, newReserved - contribution);
        await tx.prizePoolLedger.create({
          data: {
            type: LedgerEntryType.RESERVE_REVERSAL,
            amount: money(-contribution),
            balanceAfter: money(restored),
            transactionId,
            description: reason,
          },
        });
      }
    }

    await tx.poolState.update({
      where: { id: 'singleton' },
      data: {
        availableBalance: money(restored),
        reservedBalance: money(newReserved),
        jackpotBalance: money(Math.max(0, restoredJackpot)),
      },
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// OTORGAMIENTO DE CAJAS
// ═══════════════════════════════════════════════════════════════════════════

/** Elige el tier según la comisión generada y el monto de la orden. */
export async function resolveTier(commission: number, orderAmount: number) {
  const catalogs = await prisma.boxCatalog.findMany({
    where: { isActive: true },
    orderBy: { minCommission: 'desc' },
  });
  const match = catalogs.find(
    (c) => commission >= d(c.minCommission) && orderAmount >= d(c.minOrderAmount),
  );
  return match ?? catalogs[catalogs.length - 1] ?? null;
}

export async function assignMysteryBoxToUser(params: {
  userId: string;
  transactionId: string;
  commission: number;
  orderAmount: number;
  poolShareRate?: number;
}): Promise<string | null> {
  const { userId, transactionId, commission, orderAmount, poolShareRate = 0.5 } = params;

  if (!Number.isFinite(commission) || !Number.isFinite(orderAmount)) {
    console.error(`[cajas] montos inválidos en la tx ${transactionId}, no se otorga caja`);
    return null;
  }

  const catalog = await resolveTier(commission, orderAmount);
  if (!catalog) return null;

  // Lo que financia el premio es la parte de la comisión destinada al pool
  const fundingAmount = commission * poolShareRate;

  // Crear la caja y marcar la transacción van en la MISMA transacción SQL, y
  // el marcado es un compare-and-set sobre boxGranted.
  //
  // Antes eran dos statements sueltos: si el worker moría entre ambos, BullMQ
  // reintentaba el job, encontraba boxGranted todavía en false y creaba una
  // SEGUNDA caja con el presupuesto completo. Una comisión terminaba
  // financiando dos cajas, y el RTP efectivo se duplicaba en silencio.
  return prisma.$transaction(async (tx) => {
    const marked = await tx.transaction.updateMany({
      where: { id: transactionId, boxGranted: false },
      data: { boxGranted: true },
    });

    // Otra ejecución ya otorgó la caja de esta transacción.
    if (marked.count === 0) return null;

    const box = await tx.userBox.create({
      data: {
        userId,
        tier: catalog.tier,
        boxCatalogId: catalog.id,
        sourceTransactionId: transactionId,
        fundingAmount: money(fundingAmount),
        expiresAt: new Date(Date.now() + catalog.expiryDays * 24 * 60 * 60 * 1000),
      },
    });

    return box.id;
  });
}
