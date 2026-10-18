import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CompanyMonthlySynthesisDto {
  @ApiProperty() code!: string;
  @ApiProperty() claimsCount!: number;
  @ApiProperty({ description: 'Nombre de recours résolus (REGLE/REJETE/FORCLOS) sur la période — état d’avancement' })
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
  @IsNotEmpty()
  company!: string;
}

export class BilateralPositionDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
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
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ description: 'Position BRUTE (avant tout netting) que `from` doit à `to`' }) amount!: number;
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
