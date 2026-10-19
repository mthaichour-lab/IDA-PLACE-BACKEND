/**
 * Règles d'éligibilité IDA — B.6. Fonctions PURES (aucune I/O, aucune
 * dépendance Nest) afin d'être unitairement testables sans contexte Nest
 * ni base de données. `EligibilityService` (voir eligibility.service.ts)
 * n'est qu'une fine couche injectable autour de `evaluateEligibility`.
 *
 * Articles couverts :
 *  - Art. 3  : dommages matériels uniquement, territoire algérien.
 *  - Art. 4  : deux véhicules exactement, montant ≤ plafond paramétrable.
 *  - Art. 5-6: aucune exclusion contractuelle déclarée.
 *  - Art. 13 : pièces obligatoires présentes (+ constat signé des 2 parties).
 *  - Art. 19 : recours introduit dans les `recoursMaxMonths` mois, non forclos.
 *  - Art. 28 : partie adverse adhérente IDA et active (non suspendue/exclue).
 */

export interface EligibilityConfig {
  /** Identifiant de version de grille (ex: "v2025.12", B.6). */
  version: string;
  /** Plafond d'indemnisation IDA, en DA (300 000 DA au v2025.12). */
  maxAmountDA: number;
  /** Délai maximum (en mois) pour introduire un recours avant forclusion (Art. 19). */
  recoursMaxMonths: number;
  /**
   * Pièces obligatoires attendues (Art. 13). Vocabulaire non fixé par le
   * dossier technique (B.4 ne liste qu'une colonne libre "Pièces fournies") :
   * liste assumée et documentée ici, à ajuster si un référentiel officiel
   * des pièces est fourni ultérieurement.
   */
  requiredPieces: string[];
}

export const DEFAULT_ELIGIBILITY_CONFIG: EligibilityConfig = {
  version: 'v2025.12',
  maxAmountDA: 300_000,
  recoursMaxMonths: 6,
  requiredPieces: ['CONSTAT_AMIABLE', 'CARTE_GRISE', 'PERMIS_CONDUIRE', 'ATTESTATION_ASSURANCE'],
};

/**
 * Entrée attendue par le moteur de règles : un sous-ensemble (par `key`) du
 * modèle 47 colonnes (`CLAIM_IMPORT_COLUMNS`, voir claim-47-columns.ts).
 * Toutes les clés sont optionnelles : une valeur manquante est traitée
 * comme un motif d'inéligibilité explicite plutôt qu'ignorée silencieusement
 * (une donnée absente ne doit jamais faire basculer un dossier en éligible
 * par défaut).
 */
export interface EligibilityInputRow {
  nombreVehicules?: number | null;
  territoire?: string | null;
  dommagesCorporelsDeclares?: boolean | null;
  adversePartieAdherente?: boolean | null;
  adversePartieActive?: boolean | null;
  montantEstime?: number | null;
  montantExpertise?: number | null;
  dateAccident?: string | Date | null;
  dateDemandeRecours?: string | Date | null;
  exclusions?: string[] | null;
  piecesFournies?: string[] | null;
  constatAmiableSigneDeuxParties?: boolean | null;
}

export interface EligibilityVerdict {
  verdict: 'ELIGIBLE_IDA' | 'HORS_IDA';
  /** Motifs (articles cités), vide si ELIGIBLE_IDA. */
  reasons: string[];
}

function toDate(value: string | Date | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Ajoute `months` mois à une date, en arithmétique calendaire (UTC, sans dérive de fuseau). */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** SEC-27 — montant recevable : fini, > 0, deux décimales au plus. */
export function isValidAmount(value: number): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** SEC-27 — configuration lue de l'environnement : refusée au démarrage si illisible (un plafond `NaN` neutralisait le contrôle). */
export function assertEligibilityConfig(config: EligibilityConfig): EligibilityConfig {
  if (!Number.isFinite(config.maxAmountDA) || config.maxAmountDA <= 0) {
    throw new Error(`ELIGIBILITY_MAX_AMOUNT_DA invalide (${config.maxAmountDA}) : montant strictement positif attendu.`);
  }
  if (!Number.isInteger(config.recoursMaxMonths) || config.recoursMaxMonths <= 0) {
    throw new Error(`ELIGIBILITY_RECOURS_MAX_MONTHS invalide (${config.recoursMaxMonths}) : entier strictement positif attendu.`);
  }
  return config;
}

function normalizePiece(p: string): string {
  return p.trim().toUpperCase().replace(/\s+/g, '_');
}

/**
 * Évalue l'éligibilité IDA d'une ligne de dossier — B.6. Fonction pure :
 * mêmes entrées ⇒ même verdict, aucun effet de bord.
 */
export function evaluateEligibility(
  row: EligibilityInputRow,
  config: EligibilityConfig = DEFAULT_ELIGIBILITY_CONFIG,
): EligibilityVerdict {
  const reasons: string[] = [];

  // Art. 4 — deux véhicules exactement.
  if (row.nombreVehicules !== 2) {
    reasons.push(
      `Nombre de véhicules impliqués = ${row.nombreVehicules ?? 'non renseigné'} (attendu : exactement 2) — Art. 4`,
    );
  }

  // Art. 3 — dommages matériels uniquement (donc PAS de dommages corporels).
  if (row.dommagesCorporelsDeclares === true) {
    reasons.push('Dommages corporels déclarés — IDA ne couvre que les dommages matériels — Art. 3');
  } else if (row.dommagesCorporelsDeclares === null || row.dommagesCorporelsDeclares === undefined) {
    reasons.push('Nature des dommages (corporels/matériels) non renseignée — Art. 3');
  }

  // Art. 3 — territoire algérien.
  if (row.territoire !== 'ALGERIE') {
    reasons.push(`Territoire = ${row.territoire ?? 'non renseigné'} (attendu : ALGERIE) — Art. 3`);
  }

  // Art. 3 / 28 — partie adverse adhérente IDA et active.
  if (row.adversePartieAdherente !== true) {
    reasons.push('Partie adverse non adhérente IDA — Art. 3/28');
  }
  if (row.adversePartieActive !== true) {
    reasons.push('Partie adverse non active (suspendue, en retrait ou exclue) — Art. 28');
  }

  // SEC-27 — tout montant fourni doit être un nombre fini, strictement
  // positif, à deux décimales au plus : un `NaN` neutralisait la comparaison
  // au plafond, un négatif passait sous le plafond.
  const invalidAmounts = (['montantEstime', 'montantExpertise'] as const).filter((k) => row[k] !== null && row[k] !== undefined && !isValidAmount(row[k] as number));
  for (const k of invalidAmounts) {
    reasons.push(`Montant ${k === 'montantEstime' ? 'estimé' : 'expertisé'} invalide (${String(row[k])}) : nombre fini, strictement positif, deux décimales au plus — Art. 4`);
  }

  // Art. 4 — montant ≤ plafond. On retient le montant expertisé s'il est
  // disponible (plus fiable), sinon le montant estimé déclaré.
  const amount = row.montantExpertise ?? row.montantEstime;
  if (amount === null || amount === undefined) {
    reasons.push('Montant (estimé ou expertisé) non renseigné — Art. 4');
  } else if (invalidAmounts.length > 0) {
    // Motif déjà porté ci-dessus ; jamais « sous le plafond » par défaut.
  } else if (!(amount <= config.maxAmountDA)) {
    reasons.push(
      `Montant (${amount.toLocaleString('fr-FR')} DA) > plafond ${config.maxAmountDA.toLocaleString('fr-FR')} DA (${config.version}) — Art. 4`,
    );
  }

  // Art. 19 — recours dans les N mois, non forclos.
  const accidentDate = toDate(row.dateAccident);
  const recoursDate = toDate(row.dateDemandeRecours);
  if (!accidentDate) {
    reasons.push("Date de l'accident absente ou invalide — Art. 19");
  } else if (!recoursDate) {
    reasons.push('Date de demande de recours absente ou invalide — Art. 19');
  } else {
    const deadline = addMonthsUtc(accidentDate, config.recoursMaxMonths);
    if (recoursDate.getTime() > deadline.getTime()) {
      reasons.push(
        `Recours introduit le ${recoursDate.toISOString().slice(0, 10)}, après le délai de ${config.recoursMaxMonths} mois (échéance ${deadline.toISOString().slice(0, 10)}) — forclusion, Art. 19`,
      );
    }
  }

  // Art. 5-6 — aucune exclusion contractuelle déclarée.
  if (row.exclusions && row.exclusions.length > 0) {
    reasons.push(`Exclusion(s) contractuelle(s) déclarée(s) : ${row.exclusions.join(', ')} — Art. 5-6`);
  }

  // Art. 13 — pièces obligatoires présentes + constat signé des deux parties.
  const provided = new Set((row.piecesFournies ?? []).map(normalizePiece));
  const missingPieces = config.requiredPieces.filter((p) => !provided.has(normalizePiece(p)));
  if (missingPieces.length > 0) {
    reasons.push(`Pièce(s) obligatoire(s) manquante(s) : ${missingPieces.join(', ')} — Art. 13`);
  }
  if (row.constatAmiableSigneDeuxParties !== true) {
    reasons.push('Constat amiable non signé par les deux parties — Art. 13');
  }

  return reasons.length === 0 ? { verdict: 'ELIGIBLE_IDA', reasons: [] } : { verdict: 'HORS_IDA', reasons };
}
