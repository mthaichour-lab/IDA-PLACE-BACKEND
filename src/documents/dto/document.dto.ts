import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * QUESTIONS_UAR.md §9, décision Product Owner 2026-10-18 — champs
 * ADDITIFS du formulaire multipart `POST /documents/upload` : un document
 * déposé peut optionnellement être attaché à un `Recours` ou à un
 * `CommissionCase` (jamais les deux, voir `document.entity.ts`). Absents
 * (comportement historique : document non attaché) : aucun changement pour
 * les appelants existants.
 */
export class UploadDocumentDto {
  @ApiPropertyOptional({ description: 'Id du Recours (RecoursModule) auquel attacher ce document — exclusif avec commissionCaseId.' })
  @IsOptional()
  @IsString()
  recoursId?: string;

  @ApiPropertyOptional({ description: 'Id du CommissionCase (CommissionModule) auquel attacher ce document — exclusif avec recoursId.' })
  @IsOptional()
  @IsString()
  commissionCaseId?: string;
}

/**
 * `GET /documents?recoursId=X` ou `GET /documents?commissionCaseId=Y` —
 * EXACTEMENT un des deux est attendu (voir `DocumentsService.listForDossier`).
 */
export class ListDocumentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() recoursId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() commissionCaseId?: string;
}

/** Pièce attachée — réponse de `GET /documents?recoursId=X|commissionCaseId=Y` (QUESTIONS_UAR.md §9). */
export class DocumentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() uploadedBy!: string;
  @ApiProperty() uploadedAt!: string;
  /** URL pré-signée à durée courte (≈15 min, B.10) — recalculée à chaque appel, même mécanisme que `POST /documents/upload`. */
  @ApiProperty() url!: string;
}
