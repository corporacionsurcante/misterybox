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
  /// La plantilla del enlace de afiliado. Sin esto cargado con TU id real de
  /// cada programa, /go/[slug] no lleva a ningún lado: el seed trae un
  /// placeholder de ejemplo.
  affiliateUrlTemplate: z.string().url('Tiene que ser una URL válida').nullable().optional(),
  cookieWindowDays: z.number().int().min(1).max(120).optional(),
  approvalWindowDays: z.number().int().min(0).max(120).optional(),
  minOrderAmount: z.number().min(0).optional(),
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

  // Sin {{CLICK_ID}} en la plantilla no hay forma de saber qué compra fue de
  // qué usuario: la comisión llegaría sin dueño y nadie recibiría su caja.
  if (patch.affiliateUrlTemplate && !patch.affiliateUrlTemplate.includes('{{CLICK_ID}}')) {
    return NextResponse.json(
      {
        error:
          'La plantilla tiene que incluir {{CLICK_ID}} donde va el identificador de seguimiento. ' +
          'Sin eso no podemos saber de qué usuario fue la compra y nadie recibe su caja.',
      },
      { status: 422 },
    );
  }

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
