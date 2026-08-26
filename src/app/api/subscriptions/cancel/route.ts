import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { cancelarSuscripcionEnMP } from '@/lib/mercadopago';
import { SubscriptionStatus } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  subscriptionId: z.string().uuid(),
});

/**
 * POST /api/subscriptions/cancel
 *
 * Da de baja una suscripción: deja de debitar en Mercado Pago y la marca como
 * cancelada.
 *
 * En Argentina, la baja tiene que ser tan accesible como el alta (Ley de
 * Defensa del Consumidor). Además la página de planes promete "podés cancelar
 * cuando quieras": sin este endpoint, esa promesa era falsa.
 *
 * No se revocan las cajas ya otorgadas ni el saldo ganado: el usuario pagó
 * esos ciclos. Simplemente no se le cobra el siguiente.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'Iniciá sesión' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Pedido inválido' }, { status: 400 });
  }

  const suscripcion = await prisma.subscription.findFirst({
    where: { id: parsed.subscriptionId, userId: user.id },
    include: { plan: { select: { name: true } } },
  });

  if (!suscripcion) {
    return NextResponse.json({ error: 'No encontramos esa suscripción' }, { status: 404 });
  }

  if (
    suscripcion.status === SubscriptionStatus.CANCELLED ||
    suscripcion.status === SubscriptionStatus.EXPIRED
  ) {
    return NextResponse.json({ ok: true, yaEstaba: true });
  }

  // Primero Mercado Pago: si falla, se corta acá y la suscripción sigue activa
  // en los dos lados. Al revés, quedaría cancelada en la app y debitando en MP.
  if (suscripcion.mpPreapprovalId) {
    try {
      await cancelarSuscripcionEnMP(suscripcion.mpPreapprovalId);
    } catch (err) {
      console.error('[sub] no se pudo cancelar en Mercado Pago', suscripcion.id, err);
      return NextResponse.json(
        {
          error:
            'No pudimos completar la baja en este momento. Intentá de nuevo en unos minutos; ' +
            'si sigue fallando, escribinos y la damos de baja nosotros.',
        },
        { status: 502 },
      );
    }
  }

  await prisma.subscription.update({
    where: { id: suscripcion.id },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: 'Baja solicitada por el usuario',
    },
  });

  console.log(`[sub] ${user.email} dio de baja "${suscripcion.plan.name}"`);

  return NextResponse.json({
    ok: true,
    mensaje:
      'Tu suscripción quedó dada de baja. No se te va a cobrar de nuevo. ' +
      'Las cajas y el saldo que ya ganaste siguen siendo tuyos.',
  });
}
