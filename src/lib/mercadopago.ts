import {
  MercadoPagoConfig,
  PreApprovalPlan,
  PreApproval,
  Payment,
  Preference,
} from 'mercadopago';

/**
 * src/lib/mercadopago.ts — cliente y helpers de Mercado Pago.
 *
 * Se instancia de forma perezosa por la misma razón que Redis: `next build`
 * evalúa los módulos al recolectar datos de página, y construir el cliente ahí
 * rompería el deploy cuando falta el access token.
 */

let cachedConfig: MercadoPagoConfig | null = null;

export function getMpConfig(): MercadoPagoConfig {
  if (cachedConfig) return cachedConfig;

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      'Falta MP_ACCESS_TOKEN. Se saca de mercadopago.com.ar/developers → Tus integraciones → tu aplicación → Credenciales.',
    );
  }

  cachedConfig = new MercadoPagoConfig({
    accessToken,
    options: { timeout: 10000 },
  });
  return cachedConfig;
}

export const mpPreApprovalPlan = () => new PreApprovalPlan(getMpConfig());
export const mpPreApproval = () => new PreApproval(getMpConfig());
export const mpPayment = () => new Payment(getMpConfig());
export const mpPreference = () => new Preference(getMpConfig());

/** ¿Estamos con credenciales de prueba? Útil para avisar en el panel. */
export function isSandbox(): boolean {
  return (process.env.MP_ACCESS_TOKEN ?? '').startsWith('TEST-');
}

export function appUrl(path = ''): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}${path}`;
}

// ─────────────────────────── Planes ───────────────────────────

export interface CrearPlanInput {
  nombre: string;
  precio: number;
  frecuencia: number;
  tipoFrecuencia: 'days' | 'months';
  repeticiones?: number | null;
  diasDePrueba?: number | null;
  moneda?: string;
}

/**
 * Crea el plan del lado de Mercado Pago y devuelve su id.
 *
 * El plan es la plantilla de cobro (monto y periodicidad). Los usuarios se
 * suscriben *a un plan*, y MP se encarga de debitar cada ciclo.
 */
export async function crearPlanEnMP(input: CrearPlanInput): Promise<string> {
  const body: Record<string, unknown> = {
    reason: input.nombre,
    auto_recurring: {
      frequency: input.frecuencia,
      frequency_type: input.tipoFrecuencia,
      transaction_amount: input.precio,
      currency_id: input.moneda ?? 'ARS',
      ...(input.repeticiones ? { repetitions: input.repeticiones } : {}),
      ...(input.diasDePrueba
        ? { free_trial: { frequency: input.diasDePrueba, frequency_type: 'days' } }
        : {}),
    },
    back_url: appUrl('/suscripciones/gracias'),
    payment_methods_allowed: {
      payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }],
    },
  };

  const res = await mpPreApprovalPlan().create({ body: body as never });
  const id = (res as { id?: string }).id;
  if (!id) throw new Error('Mercado Pago no devolvió el id del plan');
  return id;
}

// ─────────────────────────── Suscripciones ───────────────────────────

/**
 * Arranca una suscripción y devuelve el link al que mandar al usuario.
 *
 * No pedimos los datos de la tarjeta: el usuario los carga en el checkout de
 * Mercado Pago. Eso mantiene los datos de tarjeta fuera de nuestros servidores,
 * que es exactamente donde no los queremos.
 */
export async function crearSuscripcionEnMP(params: {
  planIdMP: string;
  emailPagador: string;
  referenciaExterna: string;
}): Promise<{ id: string; initPoint: string }> {
  const res = await mpPreApproval().create({
    body: {
      preapproval_plan_id: params.planIdMP,
      payer_email: params.emailPagador,
      external_reference: params.referenciaExterna,
      back_url: appUrl('/suscripciones/gracias'),
    } as never,
  });

  const data = res as { id?: string; init_point?: string; sandbox_init_point?: string };
  const initPoint = data.init_point ?? data.sandbox_init_point;

  if (!data.id || !initPoint) {
    throw new Error('Mercado Pago no devolvió el link de pago de la suscripción');
  }
  return { id: data.id, initPoint };
}

/** Cancela la suscripción del lado de Mercado Pago (deja de debitar). */
export async function cancelarSuscripcionEnMP(preapprovalId: string): Promise<void> {
  await mpPreApproval().update({
    id: preapprovalId,
    body: { status: 'cancelled' } as never,
  });
}

export async function consultarSuscripcionEnMP(preapprovalId: string) {
  return mpPreApproval().get({ id: preapprovalId });
}

export async function consultarPagoEnMP(paymentId: string) {
  return mpPayment().get({ id: paymentId });
}
