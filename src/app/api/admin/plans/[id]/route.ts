import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { BoxTier } from '@/generated/prisma/client';

export const runtime = 'nodejs';

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  merchantId: z.string().uuid().nullable().optional(),
  price: z.number().positive().optional(),
  providerCost: z.number().min(0).optional(),
  boxesPerCycle: z.number().int().min(1).max(20).optional(),
  boxTier: z.nativeEnum(BoxTier).optional(),
  poolShareRate: z.number().min(0).max(1).optional(),
  freeTrialDays: z.number().int().min(0).nullable().optional(),
  benefits: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const { id } = await ctx.params;

  let patch;
  try {
    patch = patchSchema.parse(await req.json());
  } catch (err) {
    const detalle = err instanceof z.ZodError ? err.issues.map((i) => i.message).join(', ') : '';
    return NextResponse.json({ error: `Datos inválidos. ${detalle}` }, { status: 400 });
  }

  const antes = await prisma.subscriptionPlan.findUnique({ where: { id } });
  if (!antes) return NextResponse.json({ error: 'Plan no encontrado' }, { status: 404 });

  // El margen es lo que financia los premios. Si el costo del proveedor se come
  // el precio, cada caja se pagaría con plata que ya se le debe a otro.
  const precio = patch.price ?? Number(antes.price);
  const costo = patch.providerCost ?? Number(antes.providerCost);

  if (costo >= precio) {
    return NextResponse.json(
      {
        error: `El costo del proveedor ($${costo}) tiene que ser menor al precio ($${precio}): de esa diferencia salen los premios.`,
      },
      { status: 422 },
    );
  }

  // Cambiar el precio no puede reescribir el plan que ya existe en Mercado
  // Pago: los suscriptores actuales autorizaron un monto concreto. Se limpia
  // el vínculo para que el próximo que se suscriba genere un plan nuevo.
  const cambioPrecio = patch.price !== undefined && patch.price !== Number(antes.price);

  const despues = await prisma.subscriptionPlan.update({
    where: { id },
    data: {
      ...patch,
      benefits: patch.benefits ?? undefined,
      ...(cambioPrecio ? { mpPreapprovalPlanId: null } : {}),
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'plan.update',
      entityType: 'SubscriptionPlan',
      entityId: id,
      before: { price: antes.price.toString(), providerCost: antes.providerCost.toString(), isActive: antes.isActive },
      after: { price: despues.price.toString(), providerCost: despues.providerCost.toString(), isActive: despues.isActive },
    },
  });

  return NextResponse.json({
    ok: true,
    avisoPrecio: cambioPrecio
      ? 'Cambiaste el precio. Los suscriptores actuales siguen pagando el monto que autorizaron; el nuevo precio aplica a las suscripciones que se creen de ahora en más.'
      : null,
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const { id } = await ctx.params;

  const suscriptores = await prisma.subscription.count({
    where: { planId: id, status: { in: ['ACTIVE', 'PENDING'] } },
  });

  // Borrar un plan con gente suscripta dejaría cobros huérfanos que el webhook
  // no sabría a quién imputar. Se desactiva en su lugar.
  if (suscriptores > 0) {
    await prisma.subscriptionPlan.update({ where: { id }, data: { isActive: false } });
    return NextResponse.json({
      ok: true,
      desactivado: true,
      mensaje: `El plan tiene ${suscriptores} suscripción(es) activa(s), así que se desactivó en vez de borrarse. Deja de aparecer en la página pero los que ya están suscriptos siguen recibiendo sus cajas.`,
    });
  }

  await prisma.subscriptionPlan.delete({ where: { id } });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'plan.delete',
      entityType: 'SubscriptionPlan',
      entityId: id,
    },
  });

  return NextResponse.json({ ok: true, borrado: true });
}
