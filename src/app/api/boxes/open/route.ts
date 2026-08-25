import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentUser } from '@/lib/auth';
import { rateLimit, getClientIp } from '@/lib/rateLimit';
import { openMysteryBox, UnboxingError } from '@/services/mysteryBoxService';
import { UserStatus } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  userBoxId: z.string().uuid('userBoxId inválido'),
});

export async function POST(req: Request) {
  // 1. Autenticación
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'Iniciá sesión para abrir tu caja' }, { status: 401 });
  }

  // 2. Cuenta suspendida por fraude
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { status: true },
  });
  if (dbUser?.status !== UserStatus.ACTIVE) {
    return NextResponse.json(
      { error: 'Tu cuenta está suspendida. Escribinos para revisarla.' },
      { status: 403 },
    );
  }

  // 3. Rate limit: 5 aperturas por minuto por usuario, 20 por IP
  const [byUser, byIp] = await Promise.all([
    rateLimit(`open:user:${user.id}`, 5, 60),
    rateLimit(`open:ip:${getClientIp(req)}`, 20, 60),
  ]);
  if (!byUser.ok || !byIp.ok) {
    return NextResponse.json(
      { error: 'Demasiadas aperturas seguidas. Esperá un momento.' },
      { status: 429, headers: { 'Retry-After': String(byUser.resetIn) } },
    );
  }

  // 4. Validación del body
  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Pedido inválido' }, { status: 400 });
  }

  // 5. Apertura
  try {
    const result = await openMysteryBox({
      userId: user.id,
      userBoxId: parsed.userBoxId,
      ip: getClientIp(req),
    });

    // El cliente nunca ve el estado del pool ni la tabla de probabilidades.
    const { poolBalanceAfter, jackpotBalance, ...safe } = result;
    return NextResponse.json(safe);
  } catch (err) {
    if (err instanceof UnboxingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    console.error('[boxes/open] error inesperado', err);
    return NextResponse.json(
      { error: 'No pudimos abrir la caja. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }
}
