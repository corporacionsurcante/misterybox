import { Queue } from 'bullmq';
import { getBullConnection } from './redis';

export interface AffiliateWebhookJob {
  network: string;
  externalId: string;
  payload: Record<string, unknown>;
}

export interface ReceiptJob {
  validationId: string;
  userId: string;
  imageUrl: string;
  imageHash: string;
}

/**
 * Las colas se crean de forma perezosa a propósito.
 *
 * BullMQ abre la conexión a Redis apenas se instancia una Queue. Si eso pasa
 * al importar el módulo, Next intenta conectarse durante `next build` (cuando
 * recolecta los datos de las páginas) y el build falla por una variable de
 * entorno. Creándolas dentro de una función, la conexión se abre recién cuando
 * un request de verdad la necesita.
 */
const globalForQueues = globalThis as unknown as {
  webhookQueue?: Queue<AffiliateWebhookJob>;
  receiptQueue?: Queue<ReceiptJob>;
};

export function getWebhookQueue(): Queue<AffiliateWebhookJob> {
  if (!globalForQueues.webhookQueue) {
    globalForQueues.webhookQueue = new Queue<AffiliateWebhookJob>('webhooks', {
      connection: getBullConnection(),
    });
  }
  return globalForQueues.webhookQueue;
}

export function getReceiptQueue(): Queue<ReceiptJob> {
  if (!globalForQueues.receiptQueue) {
    globalForQueues.receiptQueue = new Queue<ReceiptJob>('receipts', {
      connection: getBullConnection(),
    });
  }
  return globalForQueues.receiptQueue;
}
