import IORedis from 'ioredis';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

export const redis =
  globalForRedis.redis ??
  new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    // BullMQ lo exige: sin esto los workers abortan comandos en cola.
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

/** Conexión que BullMQ clona para cada Queue/Worker. */
export const bullConnection = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
};
