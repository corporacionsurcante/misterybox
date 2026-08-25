import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

const patchSchema = z.object({
  realCost: z.number().min(0).optional(),
  perceivedValue: z.number().min(0).optional(),
  baseWeight: z.number().int().min(0).optional(),
  poolSafetyMultiplier: z.number().min(1).optional(),
  stock: z.number().int().min(-1).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const { id } = await ctx.params;

  let patch;
  try {
    patch = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  const before = await prisma.prize.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: 'Premio no encontrado' }, { status: 404 });

  // Guardarraíl: bajar el multiplicador de seguridad por debajo de 2 deja el pool
  // expuesto a que una racha de premios caros lo vacíe.
  if (patch.poolSafetyMultiplier !== undefined && patch.poolSafetyMultiplier < 2) {
    return NextResponse.json(
      { error: 'El multiplicador de seguridad no puede ser menor a 2. Riesgo de insolvencia del pool.' },
      { status: 422 },
    );
  }

  const after = await prisma.prize.update({ where: { id }, data: patch });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'prize.update',
      entityType: 'Prize',
      entityId: id,
      before: {
        realCost: before.realCost.toString(),
        baseWeight: before.baseWeight,
        isActive: before.isActive,
      },
      after: {
        realCost: after.realCost.toString(),
        baseWeight: after.baseWeight,
        isActive: after.isActive,
      },
    },
  });

  return NextResponse.json({ ok: true });
}
