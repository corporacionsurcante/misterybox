import IORedis from 'ioredis';

/**
 * Cliente Redis perezoso.
 *
 * IORedis valida (y parsea) la URL apenas se construye la instancia. Si eso
 * pasa al importar el módulo, `next build` explota en la fase de "collecting
 * page data" cuando REDIS_URL falta o está mal formada — y rompe el deploy
 * entero por una variable de entorno, aunque el código esté bien.
 *
 * Creándolo dentro de una función, la conexión se abre recién cuando un request
 * real la necesita. Un Redis mal configurado degrada el rate limiting, no tumba
 * el sitio.
 */

const globalForRedis = globalThis as unknown as { redis?: IORedis | null };

function isValidRedisUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:';
  } catch {
    return false;
  }
}

/** Devuelve el cliente, o null si REDIS_URL no está configurada o es inválida. */
export function getRedis(): IORedis | null {
  if (globalForRedis.redis !== undefined) return globalForRedis.redis;

  const url = process.env.REDIS_URL;
  if (!isValidRedisUrl(url)) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[redis] REDIS_URL ausente o inválida. Debe tener la forma ' +
          'redis://usuario:clave@host:puerto o rediss://... — el rate limiting queda deshabilitado.',
      );
    }
    globalForRedis.redis = null;
    return null;
  }

  globalForRedis.redis = new IORedis(url, {
    // BullMQ lo exige: sin esto los workers abortan comandos en cola.
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  globalForRedis.redis.on('error', (err) => {
    console.error('[redis] error de conexión:', err.message);
  });

  return globalForRedis.redis;
}

/**
 * Conexión que BullMQ clona para cada Queue/Worker.
 * Se lee en el momento de usarla, no al importar.
 */
export function getBullConnection(): { url: string } {
  const url = process.env.REDIS_URL;
  if (!isValidRedisUrl(url)) {
    throw new Error(
      'REDIS_URL ausente o inválida. Las colas necesitan un Redis válido ' +
        '(formato: redis://usuario:clave@host:puerto).',
    );
  }
  return { url };
}
