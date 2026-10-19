import { Throttle } from '@nestjs/throttler';

/**
 * Limites de débit PAR ROUTE — SEC-13 (phase 2 de la revue sécurité
 * 2026-10-19).
 *
 * Le `ThrottlerGuard` global (`THROTTLE_LIMIT` / `THROTTLE_TTL_SECONDS`,
 * 300 requêtes / 60 s par défaut) protège toutes les routes. Les routes
 * coûteuses ou sensibles reçoivent ici une limite PLUS STRICTE, propre à la
 * route (le compteur du throttler est tenu par route et par adresse
 * cliente, voir `TRUST_PROXY_HOPS`) :
 *
 *  | Profil          | Routes                                                      | Défaut     | Variables d'environnement                                   |
 *  |-----------------|-------------------------------------------------------------|------------|-------------------------------------------------------------|
 *  | `IMPORT`        | `POST /claims/import`                                       | 10 / 60 s  | `THROTTLE_IMPORT_LIMIT`, `THROTTLE_IMPORT_TTL_SECONDS`      |
 *  | `UPLOAD`        | `POST /documents/upload`                                    | 30 / 60 s  | `THROTTLE_UPLOAD_LIMIT`, `THROTTLE_UPLOAD_TTL_SECONDS`      |
 *  | `LEDGER_VERIFY` | `GET /ledger/verify`                                        | 6 / 60 s   | `THROTTLE_LEDGER_VERIFY_LIMIT`, `THROTTLE_LEDGER_VERIFY_TTL_SECONDS` |
 *  | `ADMIN`         | `/admin/users*`, `/admin/roles/matrix`, `PUT /pricing/grid` | 30 / 60 s  | `THROTTLE_ADMIN_LIMIT`, `THROTTLE_ADMIN_TTL_SECONDS`        |
 *
 * Les valeurs sont lues À CHAQUE REQUÊTE (fonctions résolues par le
 * throttler), donc après le chargement du `.env` ; elles sont validées au
 * démarrage par `validateEnv()`. Ces limites suivent l'interrupteur global :
 * désactivées sous Jest comme le throttler global (`THROTTLE_ENABLED`,
 * `skipIf` de `app.module.ts`), jamais désactivables en production.
 */

export const ROUTE_THROTTLE_PROFILES = ['IMPORT', 'UPLOAD', 'LEDGER_VERIFY', 'ADMIN'] as const;
export type RouteThrottleProfile = (typeof ROUTE_THROTTLE_PROFILES)[number];

const DEFAULTS: Record<RouteThrottleProfile, { limit: number; ttlSeconds: number }> = {
  IMPORT: { limit: 10, ttlSeconds: 60 },
  UPLOAD: { limit: 30, ttlSeconds: 60 },
  // Vérification complète du chaînage : coûteuse ; le frontend la sonde toutes les 30 s.
  LEDGER_VERIFY: { limit: 6, ttlSeconds: 60 },
  ADMIN: { limit: 30, ttlSeconds: 60 },
};

type Env = Record<string, string | undefined>;

/** Noms des variables d'environnement d'un profil (documentation, validation). */
export function routeThrottleEnvKeys(profile: RouteThrottleProfile): { limit: string; ttl: string } {
  return { limit: `THROTTLE_${profile}_LIMIT`, ttl: `THROTTLE_${profile}_TTL_SECONDS` };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback;
}

/** Limite effective d'un profil (valeur invalide = défaut ; `validateEnv()` refuse déjà le démarrage dans ce cas). */
export function getRouteThrottle(profile: RouteThrottleProfile, env: Env = process.env): { limit: number; ttlMs: number } {
  const keys = routeThrottleEnvKeys(profile);
  const d = DEFAULTS[profile];
  return { limit: positiveInt(env[keys.limit], d.limit), ttlMs: positiveInt(env[keys.ttl], d.ttlSeconds) * 1000 };
}

/** `@RouteThrottle('IMPORT')` : limite stricte du profil sur la route (remplace la limite globale pour cette route). */
export const RouteThrottle = (profile: RouteThrottleProfile) =>
  Throttle({
    default: {
      limit: () => getRouteThrottle(profile).limit,
      ttl: () => getRouteThrottle(profile).ttlMs,
    },
  });
