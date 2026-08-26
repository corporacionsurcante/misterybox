/**
 * src/lib/dbRetry.ts — reintento de transacciones que abortan por concurrencia.
 *
 * PostgreSQL aborta transacciones por dos motivos que NO son errores de
 * programación y que se resuelven volviendo a intentar:
 *
 *   40001  serialization_failure — bajo aislamiento Serializable, el motor
 *          detecta que dos transacciones concurrentes no pueden ordenarse.
 *   40P01  deadlock_detected — dos transacciones se esperan mutuamente.
 *
 * Usar Serializable sin reintentar es un antipatrón: la apertura de una caja
 * puede fallar por una carrera perfectamente resoluble y el usuario ve
 * "no pudimos abrir la caja" sin que nada esté roto.
 */

const CODIGOS_REINTENTABLES = new Set(['40001', '40P01']);

function esReintentable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  // Prisma expone el código de Postgres en distintos lugares según el error
  const e = err as { code?: string; meta?: { code?: string }; message?: string };

  if (e.code && CODIGOS_REINTENTABLES.has(e.code)) return true;
  if (e.meta?.code && CODIGOS_REINTENTABLES.has(e.meta.code)) return true;

  const msg = e.message ?? '';
  return (
    msg.includes('could not serialize access') ||
    msg.includes('deadlock detected') ||
    msg.includes('40001') ||
    msg.includes('40P01')
  );
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OpcionesReintento {
  intentos?: number;
  esperaBaseMs?: number;
  etiqueta?: string;
}

/**
 * Ejecuta `fn` reintentando ante conflictos de concurrencia, con espera
 * exponencial y jitter (para que dos transacciones que chocaron no vuelvan a
 * chocar sincronizadas).
 */
export async function conReintento<T>(
  fn: () => Promise<T>,
  opciones: OpcionesReintento = {},
): Promise<T> {
  const { intentos = 4, esperaBaseMs = 60, etiqueta = 'tx' } = opciones;

  let ultimoError: unknown;

  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!esReintentable(err)) throw err;

      ultimoError = err;
      if (i === intentos - 1) break;

      // Espera exponencial con jitter: 60ms, 120ms, 240ms (± 50%)
      const espera = esperaBaseMs * 2 ** i * (0.5 + Math.random());
      console.warn(
        `[${etiqueta}] conflicto de concurrencia, reintento ${i + 1}/${intentos - 1} en ${Math.round(espera)}ms`,
      );
      await dormir(espera);
    }
  }

  console.error(`[${etiqueta}] agotados los reintentos por conflicto de concurrencia`);
  throw ultimoError;
}
