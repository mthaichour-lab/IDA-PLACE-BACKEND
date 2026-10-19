import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * QUESTIONS_UAR.md §9, décision Product Owner 2026-10-18 — champs
 * ADDITIFS du formulaire multipart `POST /documents/upload` : un document
 * déposé peut optionnellement être attaché à un `Recours` ou à un
 * `CommissionCase` (jamais les deux, voir `document.entity.ts`).
 * SEC-44 : identifiants typés (UUID).
 */
export class UploadDocumentDto {
  @ApiPropertyOptional({ description: 'Id du Recours (RecoursModule) auquel attacher ce document — exclusif avec commissionCaseId.' })
  @IsOptional()
  @IsUUID()
  recoursId?: string;

  @ApiPropertyOptional({ description: 'Id du CommissionCase (CommissionModule) auquel attacher ce document — exclusif avec recoursId.' })
  @IsOptional()
  @IsUUID()
  commissionCaseId?: string;
}

/**
 * `GET /documents?recoursId=X` ou `GET /documents?commissionCaseId=Y` —
 * EXACTEMENT un des deux est attendu (voir `DocumentsService.listForDossier`).
 */
export class ListDocumentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() recoursId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() commissionCaseId?: string;
}

/** Pièce attachée — réponse de `GET /documents?recoursId=X|commissionCaseId=Y` et `GET /documents/:id`. */
export class DocumentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() uploadedBy!: string;
  @ApiProperty() uploadedAt!: string;
  /**
   * URL de téléchargement : pré-signée S3 à durée courte (≈15 min, B.10,
   * pièce jointe) ou, en mode local, `/api/v1/documents/:id/download`
   * (authentifiée). Jamais construite à partir d'une clé fournie par le client.
   */
  @ApiProperty() url!: string;
}
