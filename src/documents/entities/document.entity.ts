import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Document — QUESTIONS_UAR.md §9, décision Product Owner 2026-10-18 :
 * extension de `DocumentsModule` pour permettre l'attachement de pièces
 * (Annexe 2 = demande, Annexe 3 = opposition, Annexe 4 = contestation, PV de
 * commission) à un dossier de `Recours` ou de `CommissionCase`. Dépôt
 * MANUEL par l'utilisateur (pas de génération automatique de PDF) — voir la
 * question posée dans QUESTIONS_UAR.md §9 et sa réponse.
 *
 * Premier enregistrement PERSISTÉ de `DocumentsModule` : avant ce point, la
 * route `POST /documents/upload` écrivait les octets via `StorageProvider`
 * sans jamais rien enregistrer en base (voir `documents.module.ts`
 * `DocumentsService.upload`, forme de retour `{key, sizeBytes, contentType,
 * mode, url}`). `key`/`sizeBytes`/`contentType` reprennent exactement ce que
 * `StorageProvider.put` a renvoyé — jamais recalculés ici.
 *
 * `recoursId`/`commissionCaseId` référencent `Recours`/`CommissionCase` par
 * id simple (string), JAMAIS par relation MikroORM (`@ManyToOne` etc.) — règle
 * architecturale constante de ce code base : les modules ne se connaissent
 * que via leurs interfaces de service publiques, jamais par relation
 * d'entité croisée (voir ARCHITECTURE.md et les commentaires de
 * `CommissionCase`/`Recours`).
 *
 * Un document est soit non attaché (comportement existant, préservé),
 * soit attaché à EXACTEMENT un dossier (recours OU dossier de commission,
 * jamais les deux) — invariant validé dans `DocumentsService`, pas en base
 * (pas de contrainte CHECK : cohérence interne à un seul écrivain, dans
 * l'esprit "validation légère plutôt que contrainte DB lourde" déjà suivi
 * ailleurs dans ce code base, ex. `CommissionCase`/`Recours`).
 */
@Entity({ tableName: 'document' })
export class Document {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Clé de stockage (StorageProvider) — préfixée par la compagnie de l'uploadeur ou "place", voir documents.module.ts. */
  @Property()
  key!: string;

  /** Nom de fichier original, déjà assaini (voir `sanitizeFilename`, documents.module.ts). */
  @Property()
  filename!: string;

  @Property()
  contentType!: string;

  /** Taille en octets — `int` (pas `bigint`) : les limites d'upload actuelles (B.10, 15 Mo) restent largement sous `Number.MAX_SAFE_INTEGER`, pas besoin du type MikroORM `bigint` (qui sérialise en string côté JS, inutilement lourd ici). */
  @Property({ type: 'integer' })
  sizeBytes!: number;

  /** Nom de l'utilisateur ayant déposé la pièce — même convention que `closedBy`/`decidedBy` ailleurs dans ce code base. */
  @Property()
  uploadedBy!: string;

  @Property({ onCreate: () => new Date() })
  uploadedAt: Date = new Date();

  /** Id du `Recours` (RecoursModule) auquel ce document est attaché, ou absent. Au plus un de `recoursId`/`commissionCaseId` est renseigné (voir en-tête). */
  @Property({ nullable: true, length: 36 })
  recoursId?: string;

  /** Id du `CommissionCase` (CommissionModule) auquel ce document est attaché, ou absent. */
  @Property({ nullable: true, length: 36 })
  commissionCaseId?: string;
}
