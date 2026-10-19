/**
 * SEC-51 (revue sécurité 2026-10-19) — garde des commandes destructrices.
 *
 * `npm run migration:down` (suppression de tables/colonnes) et
 * `npm run seed:wilayas` (écrasement du référentiel) sont refusés quand
 * `NODE_ENV=production`, sauf drapeau explicite
 * `ALLOW_PRODUCTION_DESTRUCTIVE=true` posé pour CETTE exécution.
 *
 * Utilisable comme fonction (seeder) ou en ligne de commande, avant la
 * commande protégée :
 *   ts-node -T src/common/config/destructive-command-guard.ts migration:down && mikro-orm migration:down
 */
export const DESTRUCTIVE_OVERRIDE_FLAG = 'ALLOW_PRODUCTION_DESTRUCTIVE';

export class DestructiveCommandRefusedError extends Error {
  constructor(command: string) {
    super(
      `Commande "${command}" refusée : NODE_ENV=production. ` +
        `Relancer avec ${DESTRUCTIVE_OVERRIDE_FLAG}=true uniquement après sauvegarde et validation (opération destructrice).`,
    );
    this.name = 'DestructiveCommandRefusedError';
  }
}

export function assertDestructiveCommandAllowed(command: string, env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === 'production' && env[DESTRUCTIVE_OVERRIDE_FLAG] !== 'true') {
    throw new DestructiveCommandRefusedError(command);
  }
}

if (require.main === module) {
  const command = process.argv[2] ?? 'commande destructrice';
  try {
    assertDestructiveCommandAllowed(command);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}
