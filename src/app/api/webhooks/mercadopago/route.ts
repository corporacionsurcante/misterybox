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

/** ¿Este evento exacto (id + estado) ya se procesó con éxito? */
async function yaProcesado(eventKey: string): Promise<boolean> {
  const previo = await prisma.webhookEvent.findUnique({
    where: { source_externalId: { source: 'mercadopago', externalId: eventKey } },
  });
  return Boolean(previo?.processed);
}

/** Registra o actualiza el evento. `procesado` sólo se pone en true al final. */
async function registrarEvento(
  eventKey: string,
  payload: unknown,
  error: string | null,
  procesado = false,
): Promise<void> {
  try {
    await prisma.webhookEvent.upsert({
      where: { source_externalId: { source: 'mercadopago', externalId: eventKey } },
      create: {
        source: 'mercadopago',
        externalId: eventKey,
        payload: payload as never,
        processed: procesado,
        processedAt: procesado ? new Date() : null,
        error,
      },
      update: {
        processed: procesado,
        processedAt: procesado ? new Date() : null,
        error,
      },
    });
  } catch (e) {
    console.error('[mp] no se pudo registrar el evento', eventKey, e);
  }
}

/**
 * Camino de recuperación: si el pago no trae el id del preapproval, se busca
 * la suscripción por la referencia externa que le mandamos a Mercado Pago al
 * crearla. Sin esto, un cobro cuyo payload no traiga ese campo quedaba sin
 * dueño y el cliente pagaba sin recibir cajas.
 */
async function buscarPreapprovalPorReferencia(
  referencia: string | undefined,
): Promise<string | undefined> {
  if (!referencia) return undefined;
  const sub = await prisma.subscription.findUnique({
    where: { id: referencia },
    select: { mpPreapprovalId: true },
  });
  return sub?.mpPreapprovalId ?? undefined;
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
        // Sin ventana temporal, una notificación firmada capturada sigue
        // siendo válida para siempre y se puede reenviar indefinidamente.
        toleranceSeconds: 300,
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

  // El HMAC de Mercado Pago cubre el `data.id` de la QUERY, no el cuerpo.
  // Tomar el id del body permitía reenviar una notificación firmada apuntando
  // a otro pago: la firma seguía validando y el procesamiento se desviaba.
  const tipo = String(
    url.searchParams.get('type') ?? url.searchParams.get('topic') ?? payload.type ?? payload.topic ?? '',
  );
  const dataId = String(
    dataIdQuery || (payload.data as { id?: string } | undefined)?.id || payload.id || '',
  );

  if (!dataId) {
    return NextResponse.json({ received: true, ignored: 'sin-id' });
  }

  // ── 2. Procesar ──
  //
  // El estado se consulta contra la API de Mercado Pago ANTES de deduplicar,
  // porque la clave de idempotencia lo incluye. Mercado Pago usa el mismo
  // `data.id` para avisar que un pago pasó de pendiente a aprobado y de
  // aprobado a devuelto: deduplicar sólo por id descartaba esos avisos, y con
  // ellos los reembolsos y los cobros que se aprueban con demora.
  //
  // Y el evento se marca como procesado DESPUÉS de hacer el trabajo. Al revés,
  // un fallo intermedio dejaba la marca puesta y el reintento de Mercado Pago
  // rebotaba como duplicado: el cobro se perdía para siempre.
  let eventKey = `${tipo}:${dataId}`;

  try {
    if (tipo === 'payment') {
      const pago = (await consultarPagoEnMP(dataId)) as {
        status?: string;
        status_detail?: string;
        transaction_amount?: number;
        transaction_amount_refunded?: number;
        metadata?: Record<string, unknown>;
        preapproval_id?: string;
        external_reference?: string;
      };

      const estadoMP = String(pago.status ?? '');
      const devuelto = Number(pago.transaction_amount_refunded ?? 0);
      // Un reembolso parcial mantiene `status: approved`; sin mirar este campo
      // el reembolso era invisible.
      const estado = devuelto > 0 ? ChargeStatus.REFUNDED : estadoDePago(estadoMP);

      eventKey = `${tipo}:${dataId}:${estado}`;
      if (await yaProcesado(eventKey)) {
        return NextResponse.json({ received: true, duplicate: true });
      }

      const preapprovalId =
        pago.preapproval_id ??
        (pago.metadata?.preapproval_id as string | undefined) ??
        (await buscarPreapprovalPorReferencia(pago.external_reference));

      if (preapprovalId) {
        const resultado = await procesarCobroDeSuscripcion({
          mpPaymentId: dataId,
          mpPreapprovalId: preapprovalId,
          monto: Number(pago.transaction_amount ?? 0),
          estado,
          payload: pago,
        });
        console.log('[mp] cobro de suscripción', dataId, estado, resultado);

        if (!resultado.procesado && resultado.motivo === 'suscripcion-no-encontrada') {
          // No marcar como procesado: hay plata cobrada sin dueño identificado.
          await registrarEvento(eventKey, payload, `suscripción no encontrada: ${preapprovalId}`);
          console.error(
            `[mp] COBRO SIN DUEÑO — pago ${dataId}, preapproval ${preapprovalId}. ` +
              'El cliente pagó y nadie recibió cajas. Requiere revisión manual.',
          );
          return NextResponse.json({ received: true, needsReview: true });
        }
      } else {
        console.log('[mp] pago sin suscripción asociada', dataId, estadoMP);
      }
    } else if (
      tipo === 'subscription_preapproval' ||
      tipo === 'preapproval' ||
      tipo === 'subscription_authorized_payment'
    ) {
      const sub = (await consultarSuscripcionEnMP(dataId)) as { status?: string };
      const estadoSub = String(sub.status ?? '');

      eventKey = `${tipo}:${dataId}:${estadoSub}`;
      if (await yaProcesado(eventKey)) {
        return NextResponse.json({ received: true, duplicate: true });
      }

      const ok = await actualizarEstadoSuscripcion({
        mpPreapprovalId: dataId,
        estadoMP: estadoSub,
      });
      console.log('[mp] estado de suscripción', dataId, estadoSub, ok ? 'actualizado' : 'ignorado');
    } else {
      console.log('[mp] tipo de notificación no manejado:', tipo, dataId);
    }

    await registrarEvento(eventKey, payload, null, true);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : 'error desconocido';
    console.error('[mp] error procesando la notificación', dataId, mensaje);
    await registrarEvento(eventKey, payload, mensaje);
    // 500 para que Mercado Pago reintente. Como el evento NO quedó marcado
    // como procesado, el reintento entra de verdad.
    return NextResponse.json({ error: 'Error al procesar' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// Mercado Pago hace un GET de prueba al configurar la URL en el panel.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'mercadopago-webhook' });
}
