import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getWebhookQueue } from '@/lib/queues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/affiliate/[network]
 *
 * Valida la firma, guarda el evento crudo y lo encola. No procesa nada acá:
 * las redes reintentan y duplican postbacks, así que la idempotencia y los
 * reintentos viven en la cola.
 *
 * Responder 200 rápido importa: varias redes desactivan el postback si tardás
 * más de unos segundos.
 */

/**
 * Redes habilitadas. `network` viene del path y se usa como clave de
 * idempotencia, así que aceptarlo tal cual permitía este ataque: reenviar el
 * mismo postback firmado a /awin, /AWIN y /Awin generaba tres `source`
 * distintos, ninguna violaba el unique, y cada uno otorgaba una caja nueva.
 */
const REDES_HABILITADAS = ['awin', 'impact', 'admitad', 'rakuten', 'cj', 'mercadolibre'] as const;

function normalizarRed(raw: string): string | null {
  const slug = raw.toLowerCase().normalize('NFKC');
  return (REDES_HABILITADAS as readonly string[]).includes(slug) ? slug : null;
}

function verifySignature(network: string, rawBody: string, signature: string | null): boolean {
  const secret = process.env[`WEBHOOK_SECRET_${network.toUpperCase()}`];
  // Sin secreto configurado no validamos (útil en dev). En producción esto
  // devuelve false: fail-closed.
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request, ctx: { params: Promise<{ network: string }> }) {
  const { network: rawNetwork } = await ctx.params;

  const network = normalizarRed(rawNetwork);
  if (!network) {
    return NextResponse.json({ error: 'Red de afiliados no reconocida' }, { status: 404 });
  }

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

  const estado = String(payload.status ?? payload.state ?? payload.conversion_status ?? 'pending')
    .toLowerCase()
    .trim();

  // El evento se identifica por (red, orden, estado), NO sólo por (red, orden).
  //
  // Las redes usan el MISMO order_id para avisar que una compra pasó de
  // pending a approved o a refunded. Deduplicar por orden descartaba esos
  // avisos: ninguna comisión llegaba nunca a aprobarse, las reservas quedaban
  // apartadas para siempre y todos los premios con costo quedaban LOCKED de
  // por vida. Incluyendo el estado, un reenvío idéntico se descarta pero un
  // cambio de estado real pasa.
  const eventKey = `${externalId}:${estado}`;

  try {
    await prisma.webhookEvent.create({
      data: { source: network, externalId: eventKey, payload: payload as never },
    });
  } catch {
    // Violación del unique (source, externalId) → ya recibimos este mismo
    // evento con este mismo estado.
    return NextResponse.json({ received: true, duplicate: true });
  }

  await getWebhookQueue().add(
    'affiliate-conversion',
    { network, externalId, payload },
    {
      jobId: `${network}:${eventKey}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );

  return NextResponse.json({ received: true });
}
