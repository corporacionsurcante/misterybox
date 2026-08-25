import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { BoxTier } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const planSchema = z.object({
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/, 'Sólo minúsculas, números y guiones'),
  name: z.string().min(2),
  description: z.string().optional(),
  merchantId: z.string().uuid().nullable().optional(),
  price: z.number().positive(),
  providerCost: z.number().min(0),
  frequency: z.number().int().positive().default(1),
  frequencyType: z.enum(['months', 'days']).default('months'),
  repetitions: z.number().int().positive().nullable().optional(),
  freeTrialDays: z.number().int().positive().nullable().optional(),
  boxesPerCycle: z.number().int().min(1).max(20).default(1),
  boxTier: z.nativeEnum(BoxTier).default(BoxTier.SILVER),
  poolShareRate: z.number().min(0).max(1).default(0.5),
  benefits: z.array(z.string()).optional(),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
});

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const planes = await prisma.subscriptionPlan.findMany({
    include: {
      merchant: { select: { name: true, slug: true } },
      _count: { select: { subscriptions: true } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  return NextResponse.json({ planes });
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  let datos;
  try {
    datos = planSchema.parse(await req.json());
  } catch (err) {
    const detalle = err instanceof z.ZodError ? err.issues.map((i) => i.message).join(', ') : '';
    return NextResponse.json({ error: `Datos inválidos. ${detalle}` }, { status: 400 });
  }

  // Guardarraíl del negocio: si el costo del proveedor iguala o supera el
  // precio, no hay margen del que sacar los premios. La caja se financiaría
  // con plata que ya se le debe al proveedor.
  if (datos.providerCost >= datos.price) {
    return NextResponse.json(
      {
        error:
          'El costo del proveedor tiene que ser menor al precio: de ese margen salen los premios. ' +
          `Con precio ${datos.price} y costo ${datos.providerCost} el margen es cero o negativo.`,
      },
      { status: 422 },
    );
  }

  const margen = datos.price - datos.providerCost;
  const aportePool = margen * datos.poolShareRate;
  const porCaja = aportePool / datos.boxesPerCycle;

  // Aviso, no bloqueo: con menos de $50 de presupuesto por caja el usuario
  // sólo va a poder sacar cupones de costo cero, y la experiencia se siente
  // vacía. Se deja pasar porque puede ser deliberado.
  const advertencias: string[] = [];
  if (porCaja < 50) {
    advertencias.push(
      `Cada caja va a tener sólo $${porCaja.toFixed(2)} de presupuesto para premios. ` +
        'Con ese monto casi siempre van a salir cupones sin valor real. ' +
        'Considerá subir el precio, bajar el costo del proveedor o dar menos cajas por ciclo.',
    );
  }

  const { benefits, ...resto } = datos;

  const plan = await prisma.subscriptionPlan.create({
    data: {
      ...resto,
      benefits: benefits ?? undefined,
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'plan.create',
      entityType: 'SubscriptionPlan',
      entityId: plan.id,
      after: { slug: plan.slug, price: plan.price.toString(), boxes: plan.boxesPerCycle },
    },
  });

  return NextResponse.json({
    ok: true,
    plan,
    resumen: {
      margenPorCiclo: margen,
      aporteAlPool: aportePool,
      presupuestoPorCaja: porCaja,
    },
    advertencias,
  });
}
