# MisteryBox

Plataforma de compras gamificadas: cada compra desbloquea una caja sorpresa con premios reales, financiados por comisiones de afiliados.

**Stack:** Next.js 16 (App Router) · React 19 · Tailwind 4 · PostgreSQL + Prisma 7 · Redis + BullMQ · Auth.js

---

## Arrancar en local

```bash
# 1. Dependencias
npm install

# 2. Variables de entorno
cp .env.example .env    # completá DATABASE_URL y REDIS_URL

# 3. Base de datos
npm run db:migrate      # crea las tablas
npm run db:seed         # pool semilla, tiers, premios, comercios

# 4. Levantar
npm run dev             # web en http://localhost:3000
npm run worker          # en otra terminal: procesa webhooks y escrow
```

## Variables de entorno

| Variable | Para qué | Dónde se saca |
|---|---|---|
| `DATABASE_URL` | Postgres | [Neon](https://neon.tech) o Railway |
| `REDIS_URL` | Colas y rate limit | [Upstash](https://upstash.com) |
| `AUTH_SECRET` | Firma de sesiones | `npx auth secret` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Login con Google | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `NEXT_PUBLIC_APP_URL` | URL pública | tu dominio |
| `SEED_POOL_AMOUNT` | Capital semilla del pool (default 150000) | — |
| `WEBHOOK_SECRET_<RED>` | Validar postbacks (ej. `WEBHOOK_SECRET_AWIN`) | panel de cada red |

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción (corre `prisma generate` primero) |
| `npm run worker` | Worker de colas — **no corre en Vercel** |
| `npm run db:seed` | Puebla pool, tiers, premios y comercios |
| `npm run db:studio` | Explorador visual de la base |
| `npm run sim` | Simulación Monte Carlo del motor de premios |
| `npm run typecheck` | TypeScript en modo estricto |

## Deploy

**Web → Vercel.** Importás el repo, cargás las env vars, listo.

**Worker → Railway o Render.** Vercel es serverless y no mantiene procesos vivos: el worker de BullMQ necesita correr aparte con `npm run worker`. Sin él, los webhooks de afiliados se encolan y nunca se procesan.

## Antes de tocar los premios

Cada vez que cambies un peso o un costo en el panel de admin, corré `npm run sim` y compará con el RTP real que muestra el panel. La diferencia entre 45% y 65% de RTP es la diferencia entre un negocio y un pasatiempo caro.

## Nota regulatoria

El flag `module.cart_gamble` viene apagado. Ese módulo (pagar por un resultado aleatorio) tiene un perfil regulatorio distinto al resto y necesita dictamen legal antes de encenderse. Ver `docs/01-arquitectura.md` §6.

## Documentación

- `docs/01-arquitectura.md` — arquitectura, flujo de datos, invariantes de solvencia
- `docs/02-roadmap-mvp.md` — roadmap semana a semana hasta producción
