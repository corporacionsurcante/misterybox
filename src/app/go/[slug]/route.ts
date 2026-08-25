import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /go/[slug]?target=<url-encoded>
 *
 * Crea el AffiliateClick (cuyo id ES el subID que viaja a la red de afiliados)
 * y redirige al comercio. Este click_id es lo que después permite atribuir
 * la compra al usuario cuando llega el postback.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const target = url.searchParams.get('target') ?? '';

  const user = await currentUser();
  if (!user) {
    return NextResponse.redirect(new URL(`/login?next=/tiendas`, req.url));
  }

  const limit = await rateLimit(`go:${user.id}`, 30, 60);
  if (!limit.ok) {
    return NextResponse.json({ error: 'Demasiados clics seguidos' }, { status: 429 });
  }

  const merchant = await prisma.merchant.findUnique({ where: { slug } });
  if (!merchant || !merchant.isActive) {
    return NextResponse.redirect(new URL('/tiendas?error=comercio-no-disponible', req.url));
  }

  const click = await prisma.affiliateClick.create({
    data: {
      userId: user.id,
      merchantId: merchant.id,
      targetUrl: target,
      ip: getClientIp(req),
      userAgent: req.headers.get('user-agent') ?? undefined,
      expiresAt: new Date(Date.now() + merchant.cookieWindowDays * 24 * 60 * 60 * 1000),
    },
  });

  // Sustituye los placeholders de la plantilla del comercio
  const destination = (merchant.affiliateUrlTemplate ?? target)
    .replace('{{CLICK_ID}}', click.id)
    .replace('{{TARGET}}', encodeURIComponent(target));

  return NextResponse.redirect(destination, { status: 302 });
}
