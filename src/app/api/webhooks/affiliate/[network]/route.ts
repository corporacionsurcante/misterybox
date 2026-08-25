import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getWebhookQueue } from '@/lib/queues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/affiliate/[network]
 *
 * Este endpoint NO procesa nada: valida la firma, guarda el evento crudo y lo
 * encola. Las redes de afiliados reintentan y duplican postbacks, así que la
 * idempotencia y los reintentos viven en la cola, no acá.
 *
 * Responder 200 rápido es importante: varias redes desactivan el postback si
 * tardás más de unos segundos.
 */

function verifySignature(network: string, rawBody: string, signature: string | null): boolean {
  const secret = process.env[`WEBHOOK_SECRET_${network.toUpperCase()}`];
  // Sin secreto configurado no validamos (útil en dev), pero lo dejamos anotado.
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request, ctx: { params: Promise<{ network: string }> }) {
  const { network } = await ctx.params;
  const rawBody = await req.text();

  const signature =
    req.headers.get('x-signature') ?? req.headers.get('x-webhook-signature') ?? null;

  if (!verifySignature(network, rawBody, signature)) {
    console.warn(`[webhook:${network}] firma inválida`);
    return NextResponse.json({ error: 'Firma inválida' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  // Cada red nombra distinto el id de orden; normalizamos acá.
  const externalId = String(
    payload.order_id ?? payload.orderId ?? payload.transaction_id ?? payload.conversion_id ?? '',
  );
  if (!externalId) {
    return NextResponse.json({ error: 'Falta el id de orden' }, { status: 400 });
  }

  // Idempotencia a nivel de ingesta: si la red reenvía, no duplicamos el evento.
  try {
    await prisma.webhookEvent.create({
      data: { source: network, externalId, payload: payload as never },
    });
  } catch {
    // Violación del unique (source, externalId) → ya lo recibimos.
    return NextResponse.json({ received: true, duplicate: true });
  }

  await getWebhookQueue().add(
    'affiliate-conversion',
    { network, externalId, payload },
    {
      jobId: `${network}:${externalId}`, // idempotencia también en la cola
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );

  return NextResponse.json({ received: true });
}
