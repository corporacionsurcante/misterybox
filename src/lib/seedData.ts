/**
 * src/lib/seedData.ts — siembra inicial, idempotente.
 *
 * Se puede correr desde el CLI (`npm run db:seed`) o desde el endpoint
 * protegido /api/setup. Llamarlo dos veces NO duplica nada: todo usa upsert o
 * chequea existencia previa. Eso importa porque el endpoint puede dispararse
 * más de una vez sin querer.
 */
import { prisma } from '@/lib/prisma';
import {
  BoxTier,
  PrizeType,
  IntegrationType,
  MerchantCategory,
  LedgerEntryType,
} from '@/generated/prisma/client';

export async function runSeed(): Promise<string[]> {
  const log: string[] = [];

  const SEED_POOL = Number(process.env.SEED_POOL_AMOUNT ?? 150000);

  // ── 1. Pool ──
  const existingPool = await prisma.poolState.findUnique({ where: { id: 'singleton' } });

  if (!existingPool) {
    await prisma.poolState.create({
      data: {
        id: 'singleton',
        availableBalance: SEED_POOL,
        reservedBalance: 0,
        lifetimeContributions: SEED_POOL,
        jackpotBalance: 0,
        jackpotFeedRate: 0.05,
        // El pool nunca baja de acá por un premio: colchón del 10% de la semilla
        reserveFloor: Math.round(SEED_POOL * 0.1),
      },
    });

    await prisma.prizePoolLedger.create({
      data: {
        type: LedgerEntryType.JACKPOT_SEED,
        amount: SEED_POOL,
        balanceAfter: SEED_POOL,
        description: 'Capital semilla inicial del pool',
      },
    });
    log.push(`Pool creado con $${SEED_POOL.toLocaleString('es-AR')}`);
  } else {
    log.push(`Pool ya existía (saldo: $${Number(existingPool.availableBalance).toLocaleString('es-AR')}) — sin cambios`);
  }

  // ── 2. Feature flags ──
  const flags = [
    { key: 'module.affiliates', enabled: true, description: 'Links de afiliado y postbacks' },
    { key: 'module.ticketing', enabled: true, description: 'Venta de entradas a eventos propios' },
    { key: 'module.receipts_ocr', enabled: false, description: 'Validación de comprobantes por foto' },
    { key: 'module.subscriptions', enabled: false, description: 'Alta de servicios recurrentes' },
    {
      key: 'module.cart_gamble',
      enabled: false,
      description: 'Carrito → caja paga. REQUIERE DICTAMEN LEGAL antes de encender',
    },
    { key: 'jackpot.enabled', enabled: false, description: 'Jackpot progresivo. Encender con pool > $500k' },
  ];
  for (const f of flags) {
    await prisma.featureFlag.upsert({ where: { key: f.key }, update: {}, create: f });
  }
  log.push(`${flags.length} feature flags`);

  // ── 3. Configuración ──
  const configs = [
    { key: 'rtp.global_target', value: 0.5 },
    { key: 'rtp.allow_boost', value: true },
    { key: 'fraud.max_receipts_per_day', value: 2 },
    { key: 'fraud.receipt_max_age_hours', value: 48 },
    { key: 'limits.box_opens_per_minute', value: 5 },
  ];
  for (const c of configs) {
    await prisma.systemConfig.upsert({ where: { key: c.key }, update: {}, create: c });
  }

  // ── 4. Catálogo de cajas ──
  const tiers = [
    { tier: BoxTier.BRONZE, name: 'Caja Bronce', targetRtp: 0.5, maxPayoutPerOpen: 2000, minCommission: 0, minOrderAmount: 0, colorHex: '#B45309' },
    { tier: BoxTier.SILVER, name: 'Caja Plata', targetRtp: 0.5, maxPayoutPerOpen: 10000, minCommission: 500, minOrderAmount: 5000, colorHex: '#CBD5E1' },
    { tier: BoxTier.GOLD, name: 'Caja Oro', targetRtp: 0.52, maxPayoutPerOpen: 50000, minCommission: 2000, minOrderAmount: 20000, colorHex: '#FACC15' },
    { tier: BoxTier.VIP, name: 'Caja VIP', targetRtp: 0.55, maxPayoutPerOpen: 200000, minCommission: 8000, minOrderAmount: 80000, colorHex: '#E879F9' },
  ];

  const catalogs: Record<string, string> = {};
  for (const t of tiers) {
    const c = await prisma.boxCatalog.upsert({
      where: { tier: t.tier },
      update: {},
      create: { ...t, description: `Recompensas nivel ${t.name}`, expiryDays: 30, isActive: true },
    });
    catalogs[t.tier] = c.id;
  }
  log.push(`${tiers.length} tiers de caja`);

  // ── 5. Premios ──
  // Los de costo 0 llevan el mayor peso: son el piso que garantiza que la caja
  // nunca quede vacía. El motor ajusta los pesos en runtime según el RTP.
  const prizes = [
    { tier: BoxTier.BRONZE, name: 'Cupón 5% en tu próxima compra', type: PrizeType.STORE_DISCOUNT, realCost: 0, perceivedValue: 500, baseWeight: 450, stock: -1 },
    { tier: BoxTier.BRONZE, name: 'Envío gratis', type: PrizeType.STORE_DISCOUNT, realCost: 0, perceivedValue: 1200, baseWeight: 300, stock: -1 },
    { tier: BoxTier.BRONZE, name: 'Saldo $100', type: PrizeType.WALLET_CASH, realCost: 100, perceivedValue: 100, baseWeight: 180, stock: -1 },
    { tier: BoxTier.BRONZE, name: 'Saldo $500', type: PrizeType.WALLET_CASH, realCost: 500, perceivedValue: 500, baseWeight: 60, stock: -1 },
    { tier: BoxTier.BRONZE, name: 'Saldo $2.000', type: PrizeType.WALLET_CASH, realCost: 2000, perceivedValue: 2000, baseWeight: 10, stock: -1 },

    { tier: BoxTier.SILVER, name: 'Cupón 10% en tu próxima compra', type: PrizeType.STORE_DISCOUNT, realCost: 0, perceivedValue: 1500, baseWeight: 400, stock: -1 },
    { tier: BoxTier.SILVER, name: '2x1 en entradas', type: PrizeType.EVENT_PASS, realCost: 0, perceivedValue: 8000, baseWeight: 250, stock: -1 },
    { tier: BoxTier.SILVER, name: 'Saldo $500', type: PrizeType.WALLET_CASH, realCost: 500, perceivedValue: 500, baseWeight: 200, stock: -1 },
    { tier: BoxTier.SILVER, name: 'Saldo $2.500', type: PrizeType.WALLET_CASH, realCost: 2500, perceivedValue: 2500, baseWeight: 80, stock: -1 },
    { tier: BoxTier.SILVER, name: 'Entrada gratis al próximo evento', type: PrizeType.EVENT_PASS, realCost: 3000, perceivedValue: 12000, baseWeight: 40, stock: 100 },
    { tier: BoxTier.SILVER, name: 'Saldo $10.000', type: PrizeType.WALLET_CASH, realCost: 10000, perceivedValue: 10000, baseWeight: 8, stock: -1 },

    { tier: BoxTier.GOLD, name: 'Cupón 15% en tu próxima compra', type: PrizeType.STORE_DISCOUNT, realCost: 0, perceivedValue: 4000, baseWeight: 350, stock: -1 },
    { tier: BoxTier.GOLD, name: 'Gift card digital $1.000', type: PrizeType.DIGITAL_ASSET, realCost: 1000, perceivedValue: 1000, baseWeight: 250, stock: -1 },
    { tier: BoxTier.GOLD, name: 'Saldo $5.000', type: PrizeType.WALLET_CASH, realCost: 5000, perceivedValue: 5000, baseWeight: 120, stock: -1 },
    { tier: BoxTier.GOLD, name: 'Reembolso total de tu compra', type: PrizeType.CASHBACK_REFUND, realCost: 20000, perceivedValue: 20000, baseWeight: 30, stock: -1 },
    { tier: BoxTier.GOLD, name: 'Auriculares Bluetooth', type: PrizeType.PHYSICAL_PRODUCT, realCost: 35000, perceivedValue: 60000, baseWeight: 12, stock: 25 },
    { tier: BoxTier.GOLD, name: 'Saldo $50.000', type: PrizeType.WALLET_CASH, realCost: 50000, perceivedValue: 50000, baseWeight: 3, stock: -1 },

    { tier: BoxTier.VIP, name: 'Cupón 25% en tu próxima compra', type: PrizeType.STORE_DISCOUNT, realCost: 0, perceivedValue: 15000, baseWeight: 300, stock: -1 },
    { tier: BoxTier.VIP, name: 'Saldo $15.000', type: PrizeType.WALLET_CASH, realCost: 15000, perceivedValue: 15000, baseWeight: 200, stock: -1 },
    { tier: BoxTier.VIP, name: 'Reembolso total de tu compra', type: PrizeType.CASHBACK_REFUND, realCost: 80000, perceivedValue: 80000, baseWeight: 40, stock: -1 },
    { tier: BoxTier.VIP, name: 'Smartwatch', type: PrizeType.PHYSICAL_PRODUCT, realCost: 120000, perceivedValue: 200000, baseWeight: 10, stock: 10 },
    { tier: BoxTier.VIP, name: 'JACKPOT progresivo', type: PrizeType.JACKPOT, realCost: 200000, perceivedValue: 200000, baseWeight: 2, stock: -1, isJackpot: true },
  ];

  let created = 0;
  for (const p of prizes) {
    const { tier, isJackpot, ...rest } = p as typeof p & { isJackpot?: boolean };
    const existing = await prisma.prize.findFirst({
      where: { boxCatalogId: catalogs[tier], name: rest.name },
    });
    if (existing) continue;
    await prisma.prize.create({
      data: {
        ...rest,
        boxCatalogId: catalogs[tier],
        isJackpot: isJackpot ?? false,
        poolSafetyMultiplier: 3.5,
        isActive: true,
      },
    });
    created++;
  }
  log.push(`${created} premios nuevos (${prizes.length - created} ya existían)`);

  // ── 6. Comercios ──
  const merchants = [
    { slug: 'mercadolibre', name: 'Mercado Libre', category: MerchantCategory.MARKETPLACE, integrationType: IntegrationType.AFFILIATE_API, network: 'direct', commissionRate: 0.045, approvalWindowDays: 21 },
    { slug: 'rappi', name: 'Rappi', category: MerchantCategory.DELIVERY, integrationType: IntegrationType.AFFILIATE_LINK, network: 'admitad', commissionRate: 0.06, approvalWindowDays: 14 },
    { slug: 'pedidosya', name: 'PedidosYa', category: MerchantCategory.DELIVERY, integrationType: IntegrationType.AFFILIATE_LINK, network: 'admitad', commissionRate: 0.055, approvalWindowDays: 14 },
    { slug: 'amazon', name: 'Amazon', category: MerchantCategory.MARKETPLACE, integrationType: IntegrationType.AFFILIATE_LINK, network: 'impact', commissionRate: 0.04, approvalWindowDays: 30 },
  ];

  for (const m of merchants) {
    await prisma.merchant.upsert({
      where: { slug: m.slug },
      update: {},
      create: {
        ...m,
        poolShareRate: 0.5,
        isActive: true,
        affiliateUrlTemplate: 'https://example.com/{{TARGET}}?aff_id=TU_ID&subid1={{CLICK_ID}}',
        cookieWindowDays: 30,
      },
    });
  }
  log.push(`${merchants.length} comercios`);

  return log;
}
