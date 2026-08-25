import { NextResponse } from 'next/server';
import { WebhookSignatureValidator, InvalidWebhookSignatureError } from 'mercadopago';
import { prisma } from '@/lib/prisma';
import { consultarPagoEnMP, consultarSuscripcionEnMP } from '@/lib/mercadopago';
import {
  procesarCobroDeSuscripcion,
  actualizarEstadoSuscripcion,
} from '@/services/subscriptionService';
import { ChargeStatus } from '@/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/mercadopago
 *
 * Recibe las notificaciones de pagos y suscripciones.
 *
 * Regla de oro: NUNCA acreditamos nada con los datos del cuerpo de la
 * notificación. La notificación sólo trae un id; el monto y el estado los
 * consultamos contra la API de Mercado Pago. Confiar en el payload permitiría
 * que cualquiera que descubra la URL se regale cajas mandando un JSON armado.
 *
 * Mercado Pago espera un 200 rápido y reintenta si tardamos o fallamos, así
 * que todo el procesamiento es idempotente.
 */

function estadoDePago(status: string): ChargeStatus {
  switch (status) {
    case 'approved':
      return ChargeStatus.APPROVED;
    case 'refunded':
    case 'charged_back':
      return ChargeStatus.REFUNDED;
    case 'rejected':
    case 'cancelled':
      return ChargeStatus.REJECTED;
    default:
      return ChargeStatus.PENDING;
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const rawBody = await req.text();

  // ── 1. Validar la firma ──
  const secret = process.env.MP_WEBHOOK_SECRET;
  const dataIdQuery = url.searchParams.get('data.id') ?? url.searchParams.get('id') ?? '';

  if (secret) {
    try {
      WebhookSignatureValidator.validate({
        xSignature: req.headers.get('x-signature') ?? '',
        xRequestId: req.headers.get('x-request-id') ?? '',
        dataId: dataIdQuery,
        secret,
      });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        console.warn('[mp] firma inválida', err.message);
        return NextResponse.json({ error: 'Firma inválida' }, { status: 401 });
      }
      throw err;
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Fail-closed: sin secreto configurado no se procesa nada en producción.
    console.error('[mp] falta MP_WEBHOOK_SECRET — notificación rechazada');
    return NextResponse.json({ error: 'Webhook no configurado' }, { status: 503 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const tipo = String(payload.type ?? payload.topic ?? url.searchParams.get('type') ?? '');
  const dataId = String(
    (payload.data as { id?: string } | undefined)?.id ?? payload.id ?? dataIdQuery,
  );

  if (!dataId) {
    return NextResponse.json({ received: true, ignored: 'sin-id' });
  }

  // ── 2. Registrar el evento (idempotencia de ingesta) ──
  const eventKey = `${tipo}:${dataId}`;
  try {
    await prisma.webhookEvent.create({
      data: { source: 'mercadopago', externalId: eventKey, payload: payload as never },
    });
  } catch {
    return NextResponse.json({ received: true, duplicate: true });
  }

  // ── 3. Procesar según el tipo ──
  try {
    if (tipo === 'payment') {
      const pago = (await consultarPagoEnMP(dataId)) as {
        status?: string;
        transaction_amount?: number;
        metadata?: Record<string, unknown>;
        point_of_interaction?: unknown;
        preapproval_id?: string;
        external_reference?: string;
      };

      // Los cobros de una suscripción vienen con el id del preapproval
      const preapprovalId =
        pago.preapproval_id ?? (pago.metadata?.preapproval_id as string | undefined);

      if (preapprovalId) {
        const resultado = await procesarCobroDeSuscripcion({
          mpPaymentId: dataId,
          mpPreapprovalId: preapprovalId,
          monto: Number(pago.transaction_amount ?? 0),
          estado: estadoDePago(String(pago.status ?? '')),
          payload: pago,
        });
        console.log('[mp] cobro de suscripción', dataId, resultado);
      } else {
        console.log('[mp] pago sin suscripción asociada', dataId, pago.status);
      }
    } else if (tipo === 'subscription_preapproval' || tipo === 'preapproval') {
      const sub = (await consultarSuscripcionEnMP(dataId)) as { status?: string };
      const ok = await actualizarEstadoSuscripcion({
        mpPreapprovalId: dataId,
        estadoMP: String(sub.status ?? ''),
      });
      console.log('[mp] estado de suscripción', dataId, sub.status, ok ? 'actualizado' : 'ignorado');
    }

    await prisma.webhookEvent.updateMany({
      where: { source: 'mercadopago', externalId: eventKey },
      data: { processed: true, processedAt: new Date() },
    });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : 'error desconocido';
    console.error('[mp] error procesando la notificación', dataId, mensaje);
    await prisma.webhookEvent.updateMany({
      where: { source: 'mercadopago', externalId: eventKey },
      data: { error: mensaje },
    });
    // 500 para que Mercado Pago reintente
    return NextResponse.json({ error: 'Error al procesar' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// Mercado Pago hace un GET de prueba al configurar la URL en el panel.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'mercadopago-webhook' });
}
