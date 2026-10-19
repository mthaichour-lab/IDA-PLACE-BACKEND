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
  /**
   * Identité de l'assuré PROPRE à cette déclaration (colonne 44, "Identité
   * assuré A" du modèle 47 colonnes — B.4) — jamais l'identité de la partie
   * adverse telle que déclarée par l'autre compagnie. Additif (2026-10-18,
   * écran 2 "Vue de confrontation") : affichage uniquement, n'entre dans
   * aucun calcul de `matching.scoring.ts`.
   */
  assureIdentite?: string;
  /** Canal de déclaration PROPRE à cette déclaration (ERP/ECONSTAT/IMPORT/API — B.4 colonne 47). Additif (2026-10-18), affichage uniquement. */
  canalDeclaration?: string;
  /** Barème Art. 14 tel que saisi sur CETTE déclaration (décision PO §5) — affichage écran 2, jamais dans le score. */
  responsabilite?: DeclarationResponsabilite;
}

/** Saisie Art. 14 d'une déclaration, du point de vue de sa compagnie (A = son assuré, B = l'adverse). */
export interface DeclarationResponsabilite {
  circonstancesA?: number[];
  circonstancesB?: number[];
  baremeVersionId?: string;
  baremeCode?: string;
  vehicleCategoryA?: string;
  vehicleCategoryB?: string;
  responsabiliteDeclareeA?: number;
  responsabiliteDeclareeB?: number;
}
