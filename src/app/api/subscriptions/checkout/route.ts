import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rateLimit';
import { crearSuscripcionEnMP, crearPlanEnMP } from '@/lib/mercadopago';
import { SubscriptionStatus } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  planSlug: z.string().min(1),
});

/**
 * POST /api/subscriptions/checkout
 *
 * Arranca una suscripción y devuelve el link de Mercado Pago donde el usuario
 * autoriza el débito automático. Los datos de la tarjeta se cargan allá, nunca
 * pasan por nuestros servidores.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'Iniciá sesión para suscribirte' }, { status: 401 });
  }

  const limite = await rateLimit(`sub:${user.id}`, 5, 300);
  if (!limite.ok) {
    return NextResponse.json(
      { error: 'Demasiados intentos seguidos. Esperá unos minutos.' },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Pedido inválido' }, { status: 400 });
  }

  const plan = await prisma.subscriptionPlan.findUnique({
    where: { slug: parsed.planSlug },
  });

  if (!plan || !plan.isActive) {
    return NextResponse.json({ error: 'Ese plan no está disponible' }, { status: 404 });
  }

  if (!user.email) {
    return NextResponse.json(
      { error: 'Tu cuenta no tiene email. Volvé a entrar con Google.' },
      { status: 400 },
    );
  }

  // ¿Ya tiene una suscripción viva a este plan?
  const existente = await prisma.subscription.findFirst({
    where: {
      userId: user.id,
      planId: plan.id,
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING] },
    },
  });

  if (existente?.status === SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'Ya tenés este plan activo' }, { status: 409 });
  }

  try {
    // El plan se crea en Mercado Pago la primera vez que alguien lo compra,
    // y queda cacheado. Así el admin puede definir planes en el panel sin
    // tener que tocar Mercado Pago a mano.
    let planIdMP = plan.mpPreapprovalPlanId;

    if (!planIdMP) {
      planIdMP = await crearPlanEnMP({
        nombre: plan.name,
        precio: Number(plan.price),
        frecuencia: plan.frequency,
        tipoFrecuencia: plan.frequencyType === 'days' ? 'days' : 'months',
        repeticiones: plan.repetitions,
        diasDePrueba: plan.freeTrialDays,
        moneda: plan.currency,
      });
      await prisma.subscriptionPlan.update({
        where: { id: plan.id },
        data: { mpPreapprovalPlanId: planIdMP },
      });
    }

    // Fila local primero: si Mercado Pago responde y nosotros fallamos después,
    // el webhook necesita encontrar a quién corresponde el cobro.
    const suscripcion =
      existente ??
      (await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: SubscriptionStatus.PENDING,
          payerEmail: user.email,
        },
      }));

    const { id: preapprovalId, initPoint } = await crearSuscripcionEnMP({
      planIdMP,
      emailPagador: user.email,
      referenciaExterna: suscripcion.id,
    });

    await prisma.subscription.update({
      where: { id: suscripcion.id },
      data: { mpPreapprovalId: preapprovalId },
    });

    console.log(`[sub] ${user.email} inicia suscripción a ${plan.slug} (${preapprovalId})`);

    return NextResponse.json({ url: initPoint, subscriptionId: suscripcion.id });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : 'error desconocido';
    console.error('[sub] error creando la suscripción', mensaje, 'ip:', getClientIp(req));

    if (mensaje.includes('MP_ACCESS_TOKEN')) {
      return NextResponse.json(
        { error: 'Los pagos todavía no están configurados. Escribinos.' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'No pudimos iniciar la suscripción. Intentá de nuevo en un momento.' },
      { status: 502 },
    );
  }
}
