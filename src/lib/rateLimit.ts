import { redis } from './redis';

/**
 * Rate limit por ventana fija con contador atómico en Redis.
 * Simple a propósito: en el MVP el objetivo es frenar bots y doble-clics,
 * no construir un sliding window perfecto.
 *
 * Si Redis está caído, la función deja pasar (fail-open). Para el endpoint de
 * apertura de cajas eso es aceptable porque la solvencia ya está protegida por
 * el lock transaccional del pool — el rate limit es defensa en profundidad,
 * no el control primario.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ ok: boolean; remaining: number; resetIn: number }> {
  try {
    const redisKey = `rl:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, windowSeconds);
    const ttl = await redis.ttl(redisKey);
    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      resetIn: ttl > 0 ? ttl : windowSeconds,
    };
  } catch {
    return { ok: true, remaining: limit, resetIn: windowSeconds };
  }
}

/** Extrae la IP real detrás del proxy de Vercel. */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
