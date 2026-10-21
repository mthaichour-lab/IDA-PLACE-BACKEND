import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { COMPANY_CODE_MESSAGE, COMPANY_CODE_PATTERN } from '../../recours/dto/recours.dto';

export class CompanyMonthlySynthesisDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'SEC-34 : nombre de recours RÉGLÉS dont le règlement tombe dans le mois' }) claimsCount!: number;
  @ApiProperty({ description: 'SEC-34 : nombre de recours RÉGLÉS du mois (identique à claimsCount — la synthèse ne retient que les recours réglés, par mois de règlement)' })
  resolvedCount!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ enum: ['EN_COURS', 'CLOTURE'] }) status!: 'EN_COURS' | 'CLOTURE';
  @ApiPropertyOptional() closedAt?: string;
  @ApiPropertyOptional() bordereauRef?: string;
}

export class MonthlySettlementDto {
  @ApiProperty() period!: string;
  @ApiProperty({ type: [CompanyMonthlySynthesisDto] }) companies!: CompanyMonthlySynthesisDto[];
}

export class CloseMonthlyDto {
  @ApiProperty({ description: 'Code de la compagnie dont on clôture la synthèse mensuelle' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  company!: string;
}

export class BilateralPositionDto {
  @ApiProperty({ description: 'Créancier net de la paire (reçoit) — même convention que Recours.from' }) from!: string;
  @ApiProperty({ description: 'Débiteur net de la paire (paie) — même convention que Recours.to' }) to!: string;
  @ApiProperty() amount!: number;
}

export class CompanyNetPositionDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'Positif = la compagnie doit recevoir ; négatif = elle doit payer' }) net!: number;
}

export class QuarterlySettlementDto {
  @ApiProperty() quarter!: string;
  @ApiPropertyOptional() bordereau?: string;
  @ApiProperty({ type: [BilateralPositionDto], description: 'Positions bilatérales nettées (paire par paire)' }) positions!: BilateralPositionDto[];
  @ApiProperty({ type: [CompanyNetPositionDto], description: 'Compensation multilatérale — position nette par compagnie vis-à-vis de la place' }) net!: CompanyNetPositionDto[];
  @ApiPropertyOptional() closedAt?: string;
  @ApiPropertyOptional() closedBy?: string;
}

/**
 * Nouveaux endpoints additifs (`GET /settlement/quarter/:q/matrix`,
 * `GET /settlement/quarter/:q/summary`) — `SettlementModule` est un contrat
 * figé (ARCHITECTURE.md §1) : `QuarterlySettlementDto` ci-dessus ne change
 * pas de forme, ces compléments vivent sur des routes séparées.
 */
export class MatrixCellDto {
  @ApiProperty({ description: 'Créancier — compagnie demanderesse des recours réglés (Recours.from)' }) from!: string;
  @ApiProperty({ description: 'Débiteur — compagnie adverse (Recours.to)' }) to!: string;
  @ApiProperty({ description: 'Position BRUTE (avant tout netting) que `to` doit à `from`' }) amount!: number;
}

export class QuarterlyMatrixDto {
  @ApiProperty() quarter!: string;
  @ApiProperty({ type: [String], description: 'Compagnies impliquées dans au moins une position ce trimestre, triées' }) companies!: string[];
  @ApiProperty({ type: [MatrixCellDto], description: 'Matrice brute créancier(from)×débiteur(to), avant netting bilatéral ou multilatéral' }) cells!: MatrixCellDto[];
}

export class QuarterlySummaryDto {
  @ApiProperty() quarter!: string;
  @ApiProperty({ description: 'Somme des positions brutes (avant tout netting)' }) grossTotal!: number;
  @ApiProperty({ description: 'Somme des positions après netting bilatéral (paire par paire)' }) bilateralNetTotal!: number;
  @ApiProperty({ description: 'Somme des positions après netting multilatéral (compensation de place) — somme des positions nettes positives uniquement' }) multilateralNetTotal!: number;
  @ApiProperty({ description: 'Réduction des flux (%) entre le brut et le net multilatéral' }) reductionPct!: number;
  @ApiProperty({ description: 'Nombre de recours réglés inclus dans la compensation de ce trimestre' }) settledCount!: number;
  @ApiProperty({ description: 'Nombre de recours actuellement en opposition (hors circuit de compensation, toutes périodes confondues)' }) opposedCount!: number;
}

/**
 * Nouveaux endpoints additifs (`GET /settlement/monthly/:period/summary`,
 * `GET /settlement/monthly/:period/annexe7`) — écran 5 "Cycle mensuel" du
 * guide illustré. `MonthlySettlementDto`/`CompanyMonthlySynthesisDto`
 * ci-dessus ne changent pas de forme (contrat figé, ARCHITECTURE.md §1) ;
 * ces compléments vivent sur des routes séparées et appliquent une
 * convention de regroupement DIFFÉRENTE (par date de RÈGLEMENT, pas
 * d'ENVOI) — voir l'en-tête de `settlement.service.ts`.
 */
export class MonthlySummaryDto {
  @ApiProperty() period!: string;
  @ApiProperty({ description: 'Nombre de recours RÉGLÉS dont le règlement (ou, à défaut, l’envoi) tombe dans le mois' })
  settledCount!: number;
  @ApiProperty({ description: 'Montant total des recours réglés du mois' }) totalAmount!: number;
  @ApiProperty({ description: 'Nombre de recours actuellement en opposition — exclus du circuit, toutes périodes confondues (RG-06)' })
  excludedOppositionCount!: number;
  @ApiProperty({
    description:
      'Échéance de saisie — 5e jour du mois suivant, en ISO simple (AAAA-MM-05). Hypothèse simplificatrice : jours calendaires, pas ouvrés (aucun calendrier de jours fériés algériens disponible).',
  })
  insertionDeadline!: string;
}

export class Annexe7PairDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ description: 'Nombre de recours réglés pour cette paire orientée créancier→débiteur' }) count!: number;
  @ApiProperty({ description: 'Montant total pour cette paire orientée' }) totalAmount!: number;
}

export class Annexe7Dto {
  @ApiProperty() period!: string;
  @ApiProperty({
    type: [Annexe7PairDto],
    description: 'Paires créancier(from)→débiteur(to) EXACTES, non nettées — une ligne par sens si les deux existent (pas de netting, contrairement à /settlement/quarter)',
  })
  pairs!: Annexe7PairDto[];
}

/**
 * Nouvel endpoint additif (`GET /settlement/quarter/closures`) — écran 4
 * "Échanges Annexes 2/3/4" du guide illustré, sous-onglets "Accepté/silence"
 * vs "Réglé/compensé". Verdict Product Owner 2026-10-18 : cette distinction
 * est purement TEMPORELLE (le trimestre de `settledAt` du recours est-il
 * déjà clôturé ?), pas un nouvel état de `RECOURS_STATES` — voir l'en-tête
 * de `SettlementService.quarterlyClosures()`. Liste minimale (toutes les
 * clôtures trimestrielles, place entière, aucun filtre de période) :
 * `RecoursViewDto`/`QuarterlySettlementDto` ne changent pas de forme
 * (contrat figé, ARCHITECTURE.md §1) — le frontend croise lui-même chaque
 * recours réglé avec cette liste, entièrement côté client.
 */
export class QuarterlyClosureDto {
  @ApiProperty({ description: 'Trimestre clôturé, format AAAA-Qn (ex: "2026-Q1")' }) period!: string;
  @ApiProperty() closedAt!: string;
  @ApiPropertyOptional() closedBy?: string;
  @ApiPropertyOptional() bordereauRef?: string;
}
