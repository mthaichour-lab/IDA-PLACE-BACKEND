/**
 * Données de référence statiques pour l'écran 12 "Référentiel de place" —
 * section "Paramètres de la convention" / "Calendrier ouvré" / "Barème &
 * motifs" du guide illustré. Additif (2026-10-18), aucune route existante
 * modifiée.
 *
 * Règle d'or C.1 appliquée strictement ici : chaque valeur est soit une
 * RÉUTILISATION d'une configuration déjà réelle ailleurs dans l'app
 * (délais Art.10/12/19, plafond Art.4 — jamais une seconde constante
 * dupliquée et potentiellement divergente), soit un FAIT externe vérifiable
 * (week-end légal algérien, jours fériés à date FIXE), jamais une donnée
 * inventée pour ressembler à la capture de référence.
 */

export interface ConventionParams {
  /** Réutilise `DEFAULT_ELIGIBILITY_CONFIG.version` (eligibility.rules.ts) — pas une étiquette de version inventée pour cet écran. */
  version: string;
  silenceDays: number;
  oppositionDays: number;
  forclusionMonths: number;
  maxAmountDA: number;
}

/**
 * Week-end légal algérien (vendredi-samedi, Décret exécutif n°09-405) — fait
 * public, pas une hypothèse de ce projet.
 */
export const ALGERIA_WEEKEND_DAYS = ['FRIDAY', 'SATURDAY'] as const;

export interface PublicHoliday {
  date: string; // ISO (AAAA-MM-JJ)
  label: string;
}

/**
 * Jours fériés algériens à date FIXE (grégorienne) pour 2026-2027 — faits
 * publics. ⚠️ Les jours fériés religieux à date MOBILE (calendrier
 * hégirien : Aïd el-Fitr, Aïd el-Adha, Mawlid Ennabaoui, 1er Moharram,
 * Achoura) sont VOLONTAIREMENT ABSENTS de cette liste : leur date exacte
 * dépend de l'observation lunaire et n'est confirmée par arrêté officiel
 * qu'à l'approche de l'événement — lister une date estimée aujourd'hui
 * serait présenter comme un fait une donnée incertaine (règle d'or C.1).
 */
export const ALGERIA_FIXED_HOLIDAYS: PublicHoliday[] = [
  { date: '2026-01-01', label: "Jour de l'an" },
  { date: '2026-05-01', label: 'Fête du travail' },
  { date: '2026-07-05', label: "Fête de l'indépendance" },
  { date: '2026-11-01', label: 'Fête de la révolution' },
  { date: '2027-01-01', label: "Jour de l'an" },
  { date: '2027-05-01', label: 'Fête du travail' },
  { date: '2027-07-05', label: "Fête de l'indépendance" },
  { date: '2027-11-01', label: 'Fête de la révolution' },
];

export interface EligibilityMotif {
  article: string;
  label: string;
}

/**
 * Catalogue RÉEL des motifs d'inéligibilité (écran 12, "Barème & motifs")
 * — extrait des règles RÉELLEMENT appliquées par `eligibility.rules.ts`
 * (chaque motif y est généré dynamiquement avec les valeurs du dossier,
 * ici seule la catégorie/l'article est repris, pas le texte interpolé).
 *
 * ⚠️ Le guide illustré affiche "17 cas · motif interdit RG-01" — aucune
 * taxonomie "RG-01"/17 cas n'existe dans le dossier technique ni dans ce
 * moteur de règles (7 catégories réelles seulement). Pas de nombre ni de
 * code inventé pour coller à la capture.
 */
export const ELIGIBILITY_MOTIF_CATALOG: EligibilityMotif[] = [
  { article: 'Art. 4', label: 'Nombre de véhicules impliqués ≠ 2' },
  { article: 'Art. 3', label: 'Dommages corporels déclarés (IDA : dommages matériels uniquement)' },
  { article: 'Art. 3', label: 'Territoire hors Algérie' },
  { article: 'Art. 3/28', label: 'Partie adverse non adhérente IDA' },
  { article: 'Art. 28', label: 'Partie adverse non active (suspendue, en retrait ou exclue)' },
  { article: 'Art. 4', label: 'Montant (estimé ou expertisé) non renseigné' },
  { article: 'Art. 4', label: 'Montant (estimé ou expertisé) > plafond IDA' },
  { article: 'Art. 19', label: 'Recours introduit après le délai autorisé — forclusion' },
  { article: 'Art. 5-6', label: 'Exclusion(s) contractuelle(s) déclarée(s)' },
  { article: 'Art. 13', label: 'Pièce(s) obligatoire(s) manquante(s)' },
  { article: 'Art. 13', label: 'Constat amiable non signé par les deux parties' },
];
