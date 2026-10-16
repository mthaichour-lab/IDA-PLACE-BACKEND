/**
 * Entrée de calcul d'appariement — B.5. Sous-ensemble de données d'un
 * `Claim` (ClaimsModule) nécessaire au calcul de la clé/score. Volontairement
 * une interface indépendante (pas l'entité `Claim` elle-même) : B.2/
 * ARCHITECTURE.md impose que les modules ne partagent que des interfaces
 * publiques, jamais les entités internes d'un autre module. `ClaimsService`
 * construit ce DTO interne et le passe à `MatchingService`, qui n'importe
 * jamais `Claim`/`ClaimsModule`.
 */
export interface ClaimMatchInput {
  /** Id du `Claim` d'origine (ClaimsModule), pour traçabilité et persistance de la décision. */
  id: string;
  numEconstat?: string;
  company: string;
  counterpartyCompany?: string;
  plateA?: string;
  plateB?: string;
  /** N° attestation ou police, côté A/B — "police/attestation croisés" (B.5). */
  policeA?: string;
  policeB?: string;
  /** Date ISO (YYYY-MM-DD). */
  accidentDate?: string;
  /** Heure locale "HH:mm". */
  accidentTime?: string;
  wilaya?: string;
  commune?: string;
  gpsLat?: number;
  gpsLng?: number;
}
