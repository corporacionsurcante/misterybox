import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { runSeed } from '@/lib/seedData';
import { prisma } from '@/lib/prisma';
import { UserRole } from '@/generated/prisma/client';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/setup?secret=...
 *
 * Siembra la base por única vez (pool, tiers, premios, comercios, flags) y,
 * opcionalmente, convierte un email en ADMIN.
 *
 * Existe porque la base sólo es alcanzable desde el entorno de Vercel: este
 * endpoint reemplaza el `npm run db:seed` que normalmente correrías desde tu
 * terminal. Es idempotente — llamarlo dos veces no duplica nada.
 *
 * Protegido por SETUP_SECRET. Una vez sembrada la base, borrá esa variable de
 * entorno en Vercel para desactivar el endpoint.
 */
export async function GET(req: Request) {
  const secret = process.env.SETUP_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: 'Setup deshabilitado. Definí SETUP_SECRET en las variables de entorno para habilitarlo.' },
      { status: 403 },
    );
  }

  // Sin límite, el secreto es adivinable por fuerza bruta y este endpoint
  // promueve a administrador: quien lo acierte controla los premios.
  const limite = await rateLimit(`setup:${getClientIp(req)}`, 5, 3600);
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Probá de nuevo más tarde.' },
      { status: 429 },
    );
  }

  const url = new URL(req.url);
  const provisto = url.searchParams.get('secret') ?? '';

  // Comparación de tiempo constante: comparar con !== filtra información sobre
  // el secreto a través de cuánto tarda en fallar.
  const a = Buffer.from(provisto);
  const b = Buffer.from(secret);
  const coincide = a.length === b.length && timingSafeEqual(a, b);

  if (!coincide) {
    console.warn(`[setup] intento con secreto incorrecto desde ${getClientIp(req)}`);
    return NextResponse.json({ error: 'Secreto incorrecto' }, { status: 401 });
  }

  try {
    const log = await runSeed();

    // Promover a admin si se pasa ?admin=email
    const adminEmail = url.searchParams.get('admin');
    if (adminEmail) {
      const user = await prisma.user.findUnique({ where: { email: adminEmail } });
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { role: UserRole.ADMIN } });
        // Toda promoción a administrador deja rastro: es la acción más
        // privilegiada del sistema y era la única que no se auditaba.
        await prisma.adminAuditLog.create({
          data: {
            actorUserId: user.id,
            action: 'setup.promote_admin',
            entityType: 'User',
            entityId: user.id,
            after: { email: adminEmail, role: 'ADMIN' },
            ip: getClientIp(req),
          },
        });
        log.push(`${adminEmail} ahora es ADMIN`);
      } else {
        log.push(`No encontré el usuario ${adminEmail} — entrá una vez con Google y volvé a llamar esta URL`);
      }
    }

    return NextResponse.json({ ok: true, pasos: log });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[setup] error', err);
    return NextResponse.json(
      {
        error: 'Falló la siembra',
        detalle: message,
        pista: message.includes('does not exist')
          ? 'Las tablas todavía no existen. Verificá que el build haya corrido "prisma db push".'
          : undefined,
      },
      { status: 500 },
    );
  }
}
