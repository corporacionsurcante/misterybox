import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  commissionRate: z.number().min(0).max(1).optional(),
  poolShareRate: z.number().min(0).max(1).optional(),
  isFeatured: z.boolean().optional(),
});

// Next 16: params llega como Promise
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

  const before = await prisma.merchant.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: 'Comercio no encontrado' }, { status: 404 });

  const after = await prisma.merchant.update({ where: { id }, data: patch });

  await prisma.adminAuditLog.create({
    data: {
      actorUserId: admin.id,
      action: 'merchant.update',
      entityType: 'Merchant',
      entityId: id,
      before: { isActive: before.isActive, commissionRate: before.commissionRate.toString() },
      after: { isActive: after.isActive, commissionRate: after.commissionRate.toString() },
    },
  });

  return NextResponse.json({ ok: true });
}
