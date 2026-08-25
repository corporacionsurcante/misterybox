import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

const patchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const { key } = await ctx.params;

  let patch;
  try {
    patch = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  // El módulo de carrito-apuesta tiene riesgo regulatorio: encenderlo queda
  // registrado con nombre y apellido en la auditoría.
  const before = await prisma.featureFlag.findUnique({ where: { key } });
  if (!before) return NextResponse.json({ error: 'Flag no encontrado' }, { status: 404 });

  const after = await prisma.featureFlag.update({ where: { key }, data: { enabled: patch.enabled } });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'flag.toggle',
      entityType: 'FeatureFlag',
      entityId: key,
      before: { enabled: before.enabled },
      after: { enabled: after.enabled },
    },
  });

  return NextResponse.json({ ok: true });
}
