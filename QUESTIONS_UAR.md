# Questions ouvertes pour l'UAR / le métier

Ce document recense tout ce qui reste volontairement non construit dans
IDA Place parce que la réponse dépend d'une décision métier ou d'une
donnée de référence externe — jamais parce que c'est techniquement
difficile. Chaque point a été vérifié contre le dossier technique
(`IDA_Place_Dossier_Technique.md`) et le guide illustré
(`Guide_IDA_Place.docx`) : aucun des deux ne tranche la question posée.

Convention : chaque entrée donne (1) ce que montre la capture de
référence, (2) pourquoi ce n'est pas construit, (3) la question précise
à poser, (4) ce qu'il suffira de faire une fois la réponse connue — pour
qu'une réponse se traduise directement en ticket, sans ré-explorer le
sujet.

---

## 1. Référentiel de place — taxonomie des motifs d'inéligibilité — ✅ TRANCHÉ PAR LE PO EXPERT (2026-10-19), à valider UAR

**Décision (PO expert métier, sur délégation du Product Owner réel)** :
« 17 cas » ne désigne très probablement PAS une liste de motifs
d'inéligibilité mais les **17 circonstances du constat amiable** (base du
barème Art. 14). « RG-01 » n'est établi par aucun document fourni : la
seule interdiction de motif documentée est « la non-déclaration ne peut
jamais motiver une opposition » (Guide pédagogique UAR, diapo 10, Art. 10).

**Construit** : `ConstatCircumstance` (17 libellés du constat européen,
statut `STANDARD_A_CONFIRMER`), `OppositionMotif` (seul motif pré-rempli :
« Non-déclaration du sinistre », interdit), `reasonCode` optionnel sur
l'action `opposer` (400 si inconnu ou interdit). Écran 12 en 3 blocs
(11 motifs du moteur / 17 circonstances / motifs d'opposition), « RG-01 »
affiché nulle part ; écran 4 : liste de motifs ou attestation « pas une
non-déclaration ».

**Reste à valider par l'UAR** : existence d'un document « RG-01 » ;
formulation et version arabe des 17 circonstances algériennes ; liste des
motifs d'opposition admis. **Décision PO (2026-10-19)** : seul un motif
`VALIDE_UAR` peut fonder une opposition (400 `MOTIF_NON_VALIDE` sinon) ;
tant qu'aucun motif n'est validé, l'écran 4 garde l'attestation.

---

## 2. Référentiel de place — calendrier des jours fériés mobiles — ✅ TRANCHÉ PAR LE PO EXPERT (2026-10-19), à valider UAR

**Décision** : une ligne par date, saisie manuelle annuelle (`params`),
`PREVISIONNEL` → `CONFIRME` (référence du communiqué/décret obligatoire).
Les dates prévisionnelles comptent tout de suite dans les jours ouvrés.
Aucune conversion hégirienne par algorithme, aucune date pré-remplie.

**Construit** : `MobileHoliday` + `GET /referential/calendar?from&to`
(union fixes + mobiles avec statut). Les échéances sont recalculées à
chaque lecture (pas de recalcul stocké). Le 5ᵉ jour ouvré de l'avancement
du lot (§8) en tient compte. Ajouts : Yennayer (12 janvier, férié légal
depuis 2018) ; fériés fixes générés pour toute année (ils étaient figés sur
2026-2027 — trouvé par le Testeur).

**Reste à valider par l'UAR** : source officielle retenue et date limite de
saisie annuelle (proposition : 1er décembre de N-1).

---

## 3. Statistiques de la place — référentiel démographique par wilaya — ✅ MÉCANISME CONSTRUIT (2026-10-19), données à fournir

**Décision** : table `WilayaPopulation` (wilaya × année, source
obligatoire), saisie ou import CSV tout-ou-rien. Jamais d'interpolation ni
de projection ; une population antérieure au découpage actuel d'une wilaya
est invalide (mère comme fille).

**Construit** : `per100k`/`populationRef` sur `GET /stats/wilayas?year=` —
`null` sans population valide, et `null` sans `year` (un cumul pluriannuel
rapporté à une seule année gonflerait le taux). Écran 11 : sélecteur
d'année, tuiles « n.d. » hachurées, mesure désactivée sans population.

**Reste à fournir** : les populations elles-mêmes (RGPH ou estimations
ONS), et les noms officiels des wilayas 59 à 69, non remplis de mémoire.

---

## 4. Statistiques de la place — comparatif IRSAM — ✅ MÉCANISME CONSTRUIT (2026-10-19), valeur à fournir

**Défini** (Guide pédagogique UAR, diapo 3) : IRSAM est la convention de
juin 2016 de règlement inter-compagnies des sinistres auto matériels
(plateforme E-Recours), qui a précédé IDA.

**Décision** : indicateur comparé = délai moyen de règlement d'un recours
(`avgSettlementDays`). La référence IRSAM est saisie avec sa définition de
mesure et n'est comparée qu'une fois `VALIDE_UAR` (règle des quatre yeux,
privilège `validateRef` réservé à l'Admin UAR). Le « 74 j » de la maquette
n'est jamais utilisé.

**Construit** : `IrsamBenchmark`, `irsam`/`irsamStatus` sur
`GET /stats/summary` ; KPI de l'écran 11 conditionnel.

**Reste à fournir** : valeur et période, à extraire d'E-Recours, et
confirmation que la mesure part du même événement que pour IDA.

---

## 5. Statistiques de la place / dossiers — codes de barème Art. 14 — ✅ MÉCANISME CONSTRUIT (2026-10-19), table à publier

**Décision** : l'assureur direct saisit circonstances et code de barème
après le contrôle de l'Art. 13 ; ensuite seuls les rôles place
(`matchDecide`) modifient. Barème versionné (`BROUILLON` → `VALIDE_UAR`
immuable → `ARCHIVE`), catégories de véhicule en référentiel. Aucune
déduction automatique du code, aucune reprise rétroactive des dossiers.

**Construit** : référentiels `BaremeVersion`/`BaremeCase`/`VehicleCategory`
(vides) ; champs nullables sur `Claim` ; `PATCH /claims/:id/responsabilite`
(400 si code non publié, 403 compagnie adverse ou `RECOURS_OUVERT`) ;
colonnes d'import 48-53 optionnelles (le modèle à 47 colonnes reste
valide ; code non publié = avertissement, pas inéligibilité) ;
confrontation de l'écran 2 (A/B côte à côte, `divergence`,
`tauxSelonBareme`, `claimAId`/`claimBId` dans le détail) ; répartitions
sur l'écran 11.

**Reste à publier par l'UAR** : la table B01-B11 (codes, parts A/B), la
correspondance circonstances → codes, la liste des catégories, et la règle
d'arbitrage quand A et B déclarent des codes différents. **Décision PO
(2026-10-19)** : une catégorie de véhicule validée est figée comme une
version de barème (409 `CATEGORIE_IMMUABLE`) ; corriger = créer une
nouvelle catégorie.

---

## 6. Échanges Annexes 2/3/4 — distinction "Accepté/silence" vs "Réglé/compensé" — ✅ RÉSOLU (2026-10-18)

**Décision Product Owner (l'utilisateur réel, pas simulée)** : la
distinction est PUREMENT TEMPORELLE — `Recours.state === REGLE` avant/
après la clôture trimestrielle (`SettlementClosure`) du trimestre dérivé
de `settledAt`. Aucun nouveau champ sur `Recours`, aucun nouvel état de
`RECOURS_STATES`.

**Construit** : `GET /settlement/quarter/closures` (`settlement.service.ts`
`quarterlyClosures()`, commit `68e08fc`) + sous-onglets côté front
`/exchanges` (calcul entièrement client, `quarterOf(settledAt)` croisé
avec la liste des clôtures — voir HANDOFF.md des deux dépôts pour le
détail, y compris une trouvaille réelle du Testeur en vérification
navigateur corrigée depuis : `closuresQuery` manquait de polling).

Gardé ici comme trace de la décision et du point de départ, au cas où ce
document serait relu plus tard.

---

## 7. Commission — onglets "Adhésions & retraits" et "Plafond conventionnel" — ✅ ADHÉSIONS & RETRAITS CONSTRUITS (2026-10-19) · plafond reporté

**Base documentaire** (Guide pédagogique UAR, Chapitre VI, Art. 30-35) :
adhésion par demande adressée à l'UAR par une société agréée pour la
branche automobile ; retrait par dénonciation avec préavis d'au moins
3 mois avant la fin de l'année civile ; obligations maintenues pour les
sinistres antérieurs.

**Décisions du PO** : instruction par les rôles place (privilège
`membership`) ; ADHESION `RECUE` → `ACCEPTEE` (agrément obligatoire) |
`REJETEE` (motif obligatoire), sans création automatique de compagnie ;
RETRAIT `RECUE` → `EFFECTIVE` | `ANNULEE` (droit unilatéral, pas de rejet),
date d'effet calculée (reçu au plus tard le 30/09 → 31/12 de l'année, sinon
31/12 suivant), constat possible seulement après cette date (la compagnie
passe `EN_RETRAIT`).

**Construit** : `MembershipRequest` + `/commission/membership-requests`,
onglet sur l'écran 7. Vérifié par le Testeur.

**Toujours reporté — Plafond conventionnel** : aucun document ne décrit de
procédure (la Commission peut seulement « proposer une révision »,
Art. 24-27).

---

## 8. Compensation trimestrielle — pipeline "Avancement du lot" — ✅ RÉSOLU (2026-10-19)

**Décision du Product Owner** : 5 étapes reconstituées à partir des
Art. 16-18 (Diagramme d'activité + Guide pédagogique UAR), M = mois qui
suit le trimestre :
1. Saisie et validation des recours — 5ᵉ jour ouvré de M (Art. 16) ;
2. Synthèse mensuelle automatisée, Annexe 7 — le 10 de M ;
3. Insertion des règlements (Annexe 8) et transmission aux tiers — dernier
   jour de M (« à la clôture du mois », confirmé par le PO le 2026-10-19) ;
4. Synthèse globale trimestrielle et réunion UAR — dernier jour de M ;
5. Signature du PV (Annexe 9) et règlement — réunion + 8 jours (Art. 18).

**Construit** : `SettlementPipelineStep`, `GET /settlement/quarter/:q/pipeline`,
`POST …/pipeline/:step/complete` (`closeQuarter`, étapes 1-4 dans l'ordre).
L'étape 5 = clôture trimestrielle, qui exige désormais les étapes 1-4
(409 `PIPELINE_INCOMPLET` — trouvé par le Testeur). Écran 6 : section
« Avancement du lot » et bouton « Clôturer le trimestre » (aucun accès
écran à la clôture n'existait auparavant).

**À confirmer** : le libellé exact des étapes de la maquette de l'écran 6,
qui est une image.

---

## 9. Recours — pièces jointes Annexes 2/3/4 — ✅ RÉSOLU (2026-10-18)

**Décision Product Owner (l'utilisateur réel)** : `DocumentsModule`
étendu aux recours/dossiers de commission — dépôt MANUEL par
l'utilisateur (pas de génération automatique de PDF).

**Construit** : nouvelle entité `Document` (`recoursId?`/
`commissionCaseId?`, jamais les deux), `POST /documents/upload` accepte
ces deux champs additifs, `GET /documents?recoursId=X|commissionCaseId=Y`
liste les pièces — même contrôle de périmètre compagnie que
`RecoursService.get`/`CommissionService.getCase`. Côté front : section
"Pièces jointes" (`AttachmentsPanel`, composant transverse) sur
`/exchanges` et `/commission`. Vérifié en navigateur réel de bout en
bout par le Testeur (upload, liste, 403 cross-tenant, 404 dossier
inconnu) — voir HANDOFF.md des deux dépôts.

---

## 10. Monitoring assureurs — seuils de scoring à valider — ✅ CONFIRMÉ (2026-10-18)

**Décision Product Owner (l'utilisateur réel)** : les valeurs actuelles
sont conservées telles quelles — `GRADE_THRESHOLDS` (A≥90/B≥72/C≥50),
`TARDIF_RATIO_THRESHOLD` (50% du délai écoulé), `OPPOSITION_ALERT_THRESHOLD_PCT`
(20%), et la composante `delais` reste la latence accident→ingestion
uniquement (pas étendue aux délais de règlement/recours). Aucun
changement de code — confirmation pure, les constantes restent
paramétrables en tête de `monitoring.scoring.ts` si une révision est
nécessaire plus tard.

---

## 11. Compensation trimestrielle — qui peut clôturer la place entière ? — ✅ RÉSOLU (2026-10-18)

**Décision Product Owner (l'utilisateur réel)** : réservé aux rôles
"place" (OPERATEUR_PLACE/ADMIN_UAR/MEMBRE_COMMISSION).

**Construit** : nouveau privilège dédié `closeQuarter`, `POST
/settlement/quarter/:q/close` l'exige désormais au lieu de `synth`
(qui reste inchangé pour la LECTURE des synthèses par
CORRESPONDANT_IDA/TRESORIER). Vérifié en navigateur/API réel par le
Testeur : `TRESORIER`/`CORRESPONDANT_IDA` → 403, `OPERATEUR_PLACE` →
201/409 (idempotence).

---

## 12. Référentiel de place — qui peut créer une NOUVELLE compagnie adhérente ? — ✅ RÉSOLU (2026-10-18)

**Décision Product Owner (l'utilisateur réel)** : réservé aux rôles
"place" (OPERATEUR_PLACE/ADMIN_UAR).

**Construit** : nouveau privilège dédié `onboardCompany`, `POST
/referential/companies` l'exige désormais au lieu de `refedit` (qui
reste inchangé pour `updateCompany`/`createAgency`/`updateAgency`/
experts, toujours restreints à SA PROPRE compagnie pour un
CORRESPONDANT_IDA). Vérifié en navigateur/API réel par le Testeur :
`CORRESPONDANT_IDA` → 403 sur la création, `OPERATEUR_PLACE` → 201 ;
`updateCompany` toujours fonctionnel pour un correspondant sur sa
propre compagnie (régression confirmée saine).

---

## 13. Anti-fraude — le journal des actions suspectes doit-il être scopé ? — ✅ CONFIRMÉ (2026-10-18)

**Décision Product Owner (l'utilisateur réel)** : `GET /fraud/actions`
reste PLACE-WIDE, non scopé par compagnie — même esprit que
`LedgerModule` (audit trail partagé). Aucun changement de code
nécessaire ; le comportement actuel (délibérément non scopé depuis la
revue sécurité du 2026-10-18) est le comportement voulu.

---

## 14. Limites d'upload (taille/type) — valeurs provisoires, pas officielles

**Trouvé lors de la revue sécurité générale du 2026-10-18** (hors
scoping tenant, voir HANDOFF.md) : ni `POST /documents/upload` ni `POST
/claims/import` n'avaient de limite de taille ou de type de fichier —
corrigé avec des valeurs RAISONNABLES mais choisies sans base
documentaire (15 Mo + PDF/JPEG/PNG/WEBP pour les pièces jointes, 20 Mo +
CSV/XLS/XLSX pour l'import de dossiers).

**Question** : Quelles sont les limites réelles attendues par l'UAR —
taille maximale par pièce jointe (constat/carte grise/devis), formats
acceptés au-delà de PDF/image (scan multi-page en TIFF ?), taille
maximale d'un fichier d'import de dossiers (combien de lignes/Mo en
pratique pour un lot mensuel réel) ?

**Une fois répondu** : changement de valeur uniquement dans les deux
`FileInterceptor` (`documents.module.ts`/`claims.controller.ts`), zéro
refactoring.

---

## 15. Recours — qui peut « lever » une opposition ? (SEC-18, revue sécurité 2026-10-19) — ❓ À CONFIRMER

**Constat** (plan de remédiation sécurité, SEC-18) : l'action
`lever_opposition` est aujourd'hui exécutée par la compagnie
**demanderesse** (`from`) et fait passer le recours directement en
`REGLE` (`recours.rules.ts`, `RecoursService.assertActionAllowed`), sans
intervention de la commission. Concrètement : la débitrice s'oppose, la
demanderesse « lève » aussitôt l'opposition, et le recours devient dû et
entre en compensation.

**Pourquoi ce n'est pas modifié** : la règle relève de la convention IDA ;
la revue de sécurité a demandé de ne pas la changer sans confirmation de
l'UAR. Le code est inchangé (seule la traçabilité a été renforcée :
auteur, rôle, compagnie représentée et motif de chaque transition sont
désormais conservés et scellés au journal, SEC-17).

**Question** : selon la convention IDA, la levée d'une opposition est-elle
(a) le **retrait de son opposition par la compagnie débitrice** (`to`),
(b) un acte de la **demanderesse** soumis à une pièce justificative ou à
un délai, ou (c) une décision qui doit passer par la **commission** (la
demanderesse ne pouvant alors que contester puis transmettre) ?

**Une fois répondu** : (a) réserver `lever_opposition` à la compagnie `to`
dans `RecoursService.assertActionAllowed` ; (c) supprimer `lever_opposition`
de `ALLOWED_ACTIONS_BY_STATE.OPPOSITION` (seuls `contester` →
`transmettre_commission` restent) ; dans tous les cas, ajouter le test de
transition par partie correspondant (`recours.service.spec.ts`).

---

## Comment utiliser ce document

Chaque section est indépendante : répondre à une seule suffit à
débloquer le point correspondant sans toucher aux autres. Aucune réponse
ici n'est urgente pour le fonctionnement actuel de la plateforme — tous
les écrans du guide illustré sont déjà construits et vérifiés avec les
données réellement disponibles ; ces points concernent uniquement les
écarts volontaires documentés dans `HANDOFF.md` des deux dépôts.
