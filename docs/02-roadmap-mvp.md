# MisteryBox — Roadmap de MVP a producción

Objetivo: **plataforma facturando en 8 semanas** con un solo desarrollador full-time (o dos part-time). El orden está pensado para que cada fase deje algo demostrable y para que lo legalmente riesgoso quede al final, detrás de feature flags.

---

## Fase 0 — Fundaciones (semana 1)

| # | Tarea | Entregable |
|---|---|---|
| 0.1 | `npx create-next-app@latest misterybox --ts --tailwind --app` | Repo base |
| 0.2 | Postgres + Redis en Railway/Neon + Upstash | `DATABASE_URL`, `REDIS_URL` |
| 0.3 | Copiar `schema.prisma`, `npx prisma migrate dev --name init` | Base creada |
| 0.4 | Seed: `PoolState` singleton, `BoxCatalog` (4 tiers), feature flags, 8–10 premios de prueba | `prisma/seed.ts` |
| 0.5 | Auth.js con Google OAuth + Magic Link (Resend) | Login funcionando |
| 0.6 | Deploy Vercel + worker en Railway | URL pública |

**Definición de listo:** te logueás, ves un dashboard vacío, la DB tiene el pool en 0.

> Semilla del pool: arrancá con `JACKPOT_SEED` de $150.000–$300.000 ARS de capital propio. Sin colchón inicial, los primeros 200 usuarios solo pueden ganar cupones de costo $0 y la experiencia arranca floja.

---

## Fase 1 — El core del juego (semana 2)

| # | Tarea |
|---|---|
| 1.1 | `mysteryBoxService.ts` completo + tests unitarios de `filterEligible`, `applyRtpBudget`, `weightedPick` |
| 1.2 | Endpoint `POST /api/boxes/open` con auth + rate limit (5 aperturas/min/usuario) |
| 1.3 | `MysteryBoxUnboxer.tsx` integrado en `/app/boxes/[id]` |
| 1.4 | Wallet: `/app/wallet` con saldo disponible vs bloqueado e historial |
| 1.5 | Panel admin básico (`AdminControlPanel.tsx`) + endpoints `/api/admin/*` con RBAC |
| 1.6 | Script de simulación Monte Carlo en CI: falla el build si el pool se vuelve negativo |

**Definición de listo:** un admin te regala una caja a mano, la abrís, ganás, se acredita.

---

## Fase 2 — Primer canal de ingresos real (semanas 3–4)

Elegí **un solo** canal para arrancar. Recomendación por facilidad de alta en Argentina:

**Opción A — Ticketing nativo (más rápido de monetizar, cero dependencia de terceros).**
No necesitás aprobación de ninguna red de afiliados: vendés entradas de un boliche/fiesta con Mercado Pago Checkout Pro, te quedás con un fee del 8–12%, y cada entrada otorga una caja. Es el canal donde controlás todo y donde la comisión entra `APPROVED` de una (sin ventana de devolución) — el pool se llena rápido y sin escrow.

- 2.1 CRUD de eventos, lotes y precios en el admin
- 2.2 Checkout con Mercado Pago (preferencia + webhook con validación de firma)
- 2.3 Generación de `EventTicket` con QR firmado (HMAC del `qrToken` + rotación cada 30s)
- 2.4 PWA de escaneo en puerta (`/staff/scan`) con `@zxing/browser`, marca `USED` de forma idempotente
- 2.5 La compra de entrada otorga caja `SILVER`

**Opción B — Afiliados.** Alta en Awin/Impact/Admitad + programa de Mercado Libre. El cuello de botella es la aprobación (2–4 semanas) y suelen pedir sitio con tráfico. Empezá el trámite en paralelo a la Fase 0, pero no bloquees el MVP con esto.

**Definición de listo:** vendiste 20 entradas reales, esas 20 personas abrieron su caja, el pool creció con plata de verdad.

---

## Fase 3 — Afiliados y escrow (semanas 5–6)

| # | Tarea |
|---|---|
| 3.1 | `GET /go/[merchantSlug]` → crea `AffiliateClick`, redirige con `subid1={clickId}` |
| 3.2 | `POST /api/webhooks/affiliate/[network]` → valida firma → guarda `WebhookEvent` → encola |
| 3.3 | Worker `webhooks`: upsert `Transaction` idempotente → `contributeToPool` → `assignMysteryBoxToUser` |
| 3.4 | Cron diario: `releaseEscrowForTransaction` sobre lo aprobado, `revokeEscrowForTransaction` sobre reembolsos |
| 3.5 | Cron: importar reportes de Mercado Libre por API (no mandan postback S2S) |
| 3.6 | Directorio de comercios `/app/tiendas` con los flags del admin |

**Test crítico antes de salir:** mandate un postback `pending`, abrí la caja, verificá que el premio quedó `LOCKED`; después mandá el mismo postback como `refunded` y verificá que el premio pasó a `REVOKED` y el pool se revirtió. Este es *el* test que protege tu plata.

---

## Fase 4 — OCR y comercios sin API (semana 7)

| # | Tarea |
|---|---|
| 4.1 | `POST /api/receipts/presign` → URL prefirmada R2/S3 |
| 4.2 | pHash con `sharp` + `blockhash-core` **antes** de gastar en Vision API |
| 4.3 | Worker `receipts`: Vision multimodal → JSON estructurado → `evaluateFraudRules` |
| 4.4 | Límite 2 tickets/día/usuario, ventana de 48h, monto mínimo, EXIF check |
| 4.5 | Cola de revisión manual en el admin (`/admin/receipts`) |

**Cuidado con el costo:** a $0.005 por ticket y 5.000 tickets/mes son ~USD 25 — despreciable. Lo caro es el fraude: sin pHash y sin límite diario, un usuario sube 200 tickets de la basura en una noche.

---

## Fase 5 — Endurecimiento y lanzamiento (semana 8)

- Rate limiting global (Upstash Ratelimit): aperturas, uploads, login
- Sentry + alertas: pool por debajo del floor, RTP real >8 pts sobre el objetivo, cola de webhooks trabada
- Backups automáticos de Postgres + prueba de restore real (no solo activarlos)
- Bases y condiciones + política de privacidad + términos de premios
- Reconciliación mensual: `Σ ledger` vs `PoolState.availableBalance` — si divergen, hay un bug de transaccionalidad
- Beta cerrada con 50–100 usuarios reales antes de abrir

---

## Fase 6 — Post-MVP (detrás de feature flags)

| Módulo | Flag | Precondición |
|---|---|---|
| Cart-to-Mystery Gamble | `module.cart_gamble` | **Dictamen legal.** Es el módulo con riesgo regulatorio real (ver `01-arquitectura.md` §6) |
| Jackpot progresivo | `jackpot.enabled` | Pool sostenido > $500k y bases de sorteo registradas |
| Suscripciones recurrentes | `module.subscriptions` | Contratos firmados con proveedores |
| Referidos y niveles | `module.referrals` | Métricas de retención de la Fase 5 |

---

## Los tres errores que hunden este tipo de plataforma

1. **Pagar premios antes de cobrar la comisión.** El escrow (`LOCKED` → `UNLOCKED`) no es opcional. Una red de afiliados que rechaza el 20% de las conversiones te funde si ya pagaste.
2. **Calcular el saldo del pool fuera de la transacción SQL.** Dos aperturas concurrentes leyendo el mismo saldo cacheado pagan dos premios que el pool banca una sola vez. Por eso el `FOR UPDATE` sobre `pool_state` y el aislamiento `Serializable`.
3. **Tunear los pesos "a ojo".** Corré la simulación Monte Carlo cada vez que toques un peso o un costo en el admin, y comparalo con el RTP real que muestra el panel. La diferencia entre 45% y 65% de RTP es la diferencia entre un negocio y un pasatiempo caro.

---

## Costos de infraestructura estimados (mensual, arranque)

| Servicio | Costo |
|---|---|
| Vercel Pro | USD 20 |
| Postgres (Neon/Railway) | USD 10–25 |
| Redis (Upstash) | USD 0–10 |
| R2 storage | USD ~1 |
| Vision API (5k tickets) | USD ~25 |
| Resend (emails) | USD 0–20 |
| **Total** | **≈ USD 60–100/mes** |

El costo real del negocio no es la infraestructura: es el pool de premios. Presupuestá el pool como marketing, no como servidor.
