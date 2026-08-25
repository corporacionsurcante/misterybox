/**
 * prisma/seed.ts — siembra desde la línea de comandos.
 * Correr con: npm run db:seed
 *
 * La lógica vive en src/lib/seedData.ts para que el endpoint /api/setup pueda
 * reutilizarla. Es idempotente: correrla dos veces no duplica nada.
 */
import 'dotenv/config';
import { runSeed } from '../src/lib/seedData';
import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('Sembrando MisteryBox…\n');
  const log = await runSeed();
  for (const line of log) console.log('  ' + line);
  console.log('\nListo. Recordá: module.cart_gamble queda en OFF hasta tener dictamen legal.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
