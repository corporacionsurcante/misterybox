# MisteryBox — Arquitectura del Sistema (MVP)

**Stack elegido:** Next.js 14+ (App Router) como monolito full-stack · PostgreSQL + Prisma · Redis + BullMQ (worker Node aparte en el mismo repo) · Mercado Pago + Stripe · Cloudflare R2/S3 para comprobantes · Deploy: Vercel (web) + Railway/Fly (Postgres, Redis, worker).

---

## 1. Visión de módulos

Un solo principio unifica todo el sistema: **toda actividad económica se normaliza a una fila en `transactions`**, sin importar el canal. A partir de ahí, un único pipeline decide comisión → aporte al pool → otorgamiento de caja → premio → redención.

```
┌──────────────────────────── CANALES DE INGESTA ────────────────────────────┐
│                                                                            │
│  A. AFILIADOS            B. SUSCRIPCIONES       C. TICKETING NATIVO        │
│  (ML, Amazon, Rappi,     (streaming, seguros,   (discotecas, fiestas,      │
│   PedidosYa)              membresías)            festivales)               │
│  click → subID →         postback CPA /         Checkout propio            │
│  postback S2S            recurrente             (MercadoPago/Stripe)       │
│                                                                            │
│  D. OCR OFFLINE          E. CART-TO-MYSTERY GAMBLE                         │
│  (comprobantes foto)     (carrito → caja personalizada paga)               │
│  upload → cola OCR →     pricing engine → pago → caja                      │
│  antifraude pHash                                                          │
└───────────────┬────────────────────────────────────────────────────────────┘
                │  (todos convergen aquí)
                ▼
      ┌───────────────────────┐        ┌──────────────────────────┐
      │  TRANSACTION ENGINE   │───────►│  PRIZE POOL LEDGER       │
      │  transactions          │ % com. │  (doble partida:         │
      │  PENDING → APPROVED   │        │   CONTRIBUTION / PAYOUT /│
      │  → REJECTED/REFUNDED  │        │   RESERVE / ADJUSTMENT)  │
      └──────────┬────────────┘        └────────────┬─────────────┘
                 │ otorga                            │ saldo disponible
                 ▼                                   ▼
      ┌───────────────────────┐        ┌──────────────────────────┐
      │  BOX GRANT SERVICE    │        │  UNBOXING ENGINE         │
      │  user_boxes (tier     │───────►│  RTP 40–60% + válvula    │
      │  según monto/comisión)│  abre  │  jackpot (pool ≥ 3.5×C)  │
      └───────────────────────┘        └────────────┬─────────────┘
                                                    │ premio elegido
                                                    ▼
      ┌─────────────────────────────────────────────────────────────┐
      │  USER REWARDS + WALLET                                      │
      │  LOCKED (tx origen PENDING) → UNLOCKED (tx APPROVED)        │
      │  → CLAIMED (canjeado/retirado)                              │
      │  Si tx REFUNDED → premio REVOKED + reverso en pool          │
      └─────────────────────────────────────────────────────────────┘
```

## 2. Topología de servicios (monolito + worker)

```
[Browser Next.js/React]
   │  HTTPS / SSE (revelación en vivo, notificaciones)
   ▼
[Next.js App Router]
   ├── /api/webhooks/affiliate/[network]   ← postbacks S2S (Awin, Impact, ML, Admitad…)
   ├── /api/webhooks/mercadopago | stripe  ← pagos nativos (tickets, cart-gamble)
   ├── /api/receipts/presign               ← URL prefirmada R2/S3 para subir foto
   ├── /api/boxes/open                     ← unboxing (transacción SERIALIZABLE)
   ├── /api/admin/*                        ← control plane (RBAC ADMIN/STAFF)
   └── /api/events/scan                    ← validación QR en puerta (rol STAFF)
   │
   ├──► PostgreSQL (Prisma) — fuente de verdad
   ├──► Redis
   │      ├── BullMQ: cola `webhooks` (ingesta idempotente, reintentos)
   │      ├── BullMQ: cola `receipts` (OCR multimodal + antifraude)
   │      └── rate limiting (sliding window por user/IP)
   └──► R2/S3 (comprobantes, assets de premios)

[Worker Node (mismo repo, proceso aparte)]
   ├── procesa `webhooks`: upsert conversión → aporte pool → otorga caja
   ├── procesa `receipts`: pHash → Vision/OCR → reglas fraude → aprueba/rechaza/manual
   └── cron: reconciliación de reportes de afiliados (ML API), expiración de premios,
             liberación de escrow al vencer ventana de devolución
```

**Por qué webhooks pasan por cola y no se procesan inline:** las redes reintentan y duplican postbacks; la cola da idempotencia (jobId = `network:order_id`), reintentos con backoff y aísla picos sin tumbar la web.

## 3. Flujo de estados y escrow (regla de oro financiera)

| Evento origen | Estado tx | Caja | Premio | Pool |
|---|---|---|---|---|
| Postback `pending` (afiliado en ventana de devolución) | `PENDING` | Se otorga y **se puede abrir ya** (dopamina inmediata) | Se revela pero queda `LOCKED` para retiro | Aporte registrado como **RESERVE** (no gastable) |
| Postback `approved` / pago nativo confirmado | `APPROVED` | — | `LOCKED → UNLOCKED` | RESERVE → CONTRIBUTION (gastable) |
| Cancelación/reembolso | `REFUNDED`/`REJECTED` | Si no se abrió: se revoca | Si `LOCKED`: `REVOKED` (nunca se pagó nada) | Reverso del aporte |

Con esto **la plataforma jamás paga un premio antes de cobrar la comisión que lo financia**. Los premios digitales de costo $0 (cupones de partners, descuentos propios) se entregan `UNLOCKED` al instante como gratificación garantizada.

## 4. Invariantes de solvencia (no negociables en código)

1. `pool_available = Σ CONTRIBUTION − Σ PAYOUT − Σ RESERVE_activa` se calcula **dentro de la misma transacción SQL** que el unboxing, con lock (`SELECT … FOR UPDATE` sobre la fila de pool o aislamiento SERIALIZABLE). Nunca desde caché.
2. Un premio con `costo_real > 0` solo es elegible si `pool_available ≥ costo_real × safety_multiplier` (default **3.5**).
3. El conjunto de premios elegibles de una caja debe cumplir `E[costo] ≤ RTP_target × comisión_que_financió_la_caja`. Si no hay combinación válida, el motor degrada automáticamente a la tabla de premios de relleno (costo $0) — la caja **siempre** entrega algo.
4. Todo movimiento de pool es una fila inmutable en `prize_pool_ledger` (nunca UPDATE de un saldo suelto): auditable y reconstruible.
5. Idempotencia total: `(network, external_order_id)` único en transacciones; `image_hash` y `(merchant, invoice_number)` únicos en OCR; jobId determinístico en colas.

## 5. Seguridad y antifraude

- **Afiliados:** firma/secret por red en el endpoint de postback + allowlist de IPs donde exista; click_id UUID propio (no adivinable); ventana clic→conversión máxima configurable.
- **OCR:** pHash perceptual antes de gastar en Vision API; EXIF (fecha, screenshot detection); límite 2–3 tickets/día/usuario; constraint único comercio+factura; cola `MANUAL_REVIEW` para confidence < 0.75.
- **Unboxing:** RNG con `crypto.randomInt` (nunca `Math.random`); server-authoritative — el cliente solo recibe el resultado, jamás la tabla de probabilidades; rate limit por usuario; auditoría de cada apertura (seed, premio, pool antes/después) en `box_openings`.
- **Sesiones:** JWT corto + refresh, device fingerprint suave, bloqueo de multi-cuenta por (device, medio de pago) para promos.
- **Pagos:** verificación de firma de webhooks MP/Stripe; nunca acreditar por redirect del cliente, solo por webhook server-side.

## 6. Nota regulatoria (importante, no soy abogado)

Dos módulos distintos, dos regímenes distintos:

- **Cajas regaladas por compra** (canales A–D): jurídicamente son *promociones/sorteos sin obligación de compra adicional* — en Argentina caen bajo normativa de promociones comerciales (Lealtad Comercial, y en varias provincias requieren registro del sorteo ante Lotería provincial). Riesgo bajo-medio, gestionable con bases y condiciones.
- **Cart-to-Mystery Gamble** (canal E): el usuario **paga por un resultado aleatorio con valor económico**. Eso se parece mucho a juego de azar regulado (competencia provincial en Argentina: Lotería de la Ciudad, IPLyC, etc.) y además a lo que reguladores tratan como loot boxes. Recomendación de arquitectura: dejarlo **feature-flagged OFF por defecto**, lanzar el MVP con A–D, y habilitar E solo con dictamen legal (una variante segura: que el "peor resultado" de la caja siempre valga ≥ lo pagado, convirtiéndolo en compra con bonus aleatorio, no en apuesta).

Consultá con un abogado especializado en promociones y juego antes del lanzamiento; el diseño con feature flags te permite lanzar sin bloquearte por esto.

## 7. Estructura del repo

```
misterybox/
├── prisma/schema.prisma
├── src/
│   ├── app/                    # App Router: páginas + /api route handlers
│   ├── components/             # MysteryBoxUnboxer, wallet, directorio, admin/
│   ├── services/               # mysteryBoxService, poolService, grantService…
│   ├── workers/                # index.ts (BullMQ: webhooks, receipts, cron)
│   └── lib/                    # prisma client, redis, auth, rateLimit, rng
├── docs/
└── .env                        # DATABASE_URL, REDIS_URL, secrets por red afiliada
```
