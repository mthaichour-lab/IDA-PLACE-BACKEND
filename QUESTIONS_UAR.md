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

## 1. Référentiel de place — taxonomie des motifs d'inéligibilité

**Capture** : écran 12 "Référentiel de place", section Motifs — le guide
illustré nomme une taxonomie "17 cas / RG-01".

**Pourquoi pas construit** : `GET /referential/motifs` existe déjà et
renvoie le catalogue RÉEL des motifs tels qu'implémentés dans
`eligibility.rules.ts` (Art. 3/4/5-6/13/19/28) — **11 motifs**, pas 17.
Aucun des deux documents de référence ne liste les 17 cas de "RG-01" ni
ne définit ce que "RG-01" désigne.

**Question** : La règle de gestion "RG-01" existe-t-elle dans un document
non fourni (cahier des charges fonctionnel détaillé, référentiel
réglementaire UAR) ? Si oui, quels sont les 6 motifs supplémentaires par
rapport aux 11 déjà couverts, et quel article de la convention les fonde ?

**Une fois répondu** : étendre `ELIGIBILITY_MOTIF_CATALOG`
(`src/adherents/referential-reference-data.ts`) avec les motifs
manquants — purement additif, aucune migration.

---

## 2. Référentiel de place — calendrier des jours fériés mobiles

**Capture** : écran 12, section Calendrier — jours ouvrés algériens.

**Pourquoi pas construit** : `GET /referential/calendar` couvre déjà le
week-end légal (vendredi-samedi) et les jours fériés à **date fixe**
2026-2027 (`ALGERIA_FIXED_HOLIDAYS`,
`src/adherents/referential-reference-data.ts`). Les jours fériés
**mobiles** (calendrier hégirien : Aïd el-Fitr, Aïd el-Adha, Awal
Muharram, Mawlid) dépendent de l'observation lunaire et ne peuvent pas
être calculés par une formule fixe sans risque d'erreur d'un jour — les
dates officielles sont publiées chaque année par décret.

**Question** : Y a-t-il une source officielle (API, flux, publication
annuelle de l'UAR) donnant les dates algériennes des jours fériés mobiles
pour l'année en cours + N-1 ? À défaut, qui les saisit manuellement
chaque année et à quelle fréquence ?

**Une fois répondu** : ajouter une table `MobileHoliday` (année, date,
libellé) saisie manuellement ou importée de la source trouvée — ne
jamais calculer la date par un algorithme de conversion hégirien-grégorien
seul (imprécis de ±1 jour selon l'observation locale).

---

## 3. Statistiques de la place — référentiel démographique par wilaya

**Capture** : écran 11 "Statistiques de la place" — carte en tuiles des
69 wilayas avec mesure "Pour 100 000 habitants" en plus de
"Déclarations"/"Montants".

**Pourquoi pas construit** : `stats.service.ts` calcule déjà
déclarations/montants réels par wilaya. Aucun des deux documents de
référence ne fournit de table population-par-wilaya, et en inventer une
produirait un taux "pour 100k hab." complètement fabriqué.

**Question** : Quelle source de référence utiliser pour la population par
wilaya (recensement ONS le plus récent, projection annuelle) ? Doit-elle
être figée (snapshot à une date) ou mise à jour périodiquement ?

**Une fois répondu** : ajouter une table `WilayaPopulation` (code wilaya,
année, population) seedée depuis la source, et un calcul additif dans
`stats.service.ts` (`declarations / population * 100000`) — aucune
migration des endpoints existants.

---

## 4. Statistiques de la place — comparatif IRSAM

**Capture** : écran 11 — comparatif "vs IRSAM" sur les délais de
traitement.

**Pourquoi pas construit** : "IRSAM" n'est défini dans aucun des deux
documents (probablement un indicateur sectoriel existant, mais sans
baseline chiffrée fournie).

**Question** : Qu'est-ce qu'IRSAM exactement (indicateur, organisme
source) ? Quelle est sa valeur de référence actuelle, et à quelle
fréquence est-elle mise à jour ?

**Une fois répondu** : ajouter la baseline comme constante paramétrable
(même mécanisme que `DEFAULT_RECOURS_TIMER_CONFIG`) et un calcul
comparatif additif dans `stats.service.ts`.

---

## 5. Statistiques de la place / dossiers — codes de barème Art. 14

**Capture** : écrans 3 et 11 — code de barème Art. 14 (B01-B11) par
dossier, catégorie de véhicule.

**Pourquoi pas construit** : aucun champ `Claim` ne porte de code de
barème ni de catégorie de véhicule — le modèle 47 colonnes
(`claim-47-columns.ts`) ne les capture pas à l'import.

**Question** : La table de correspondance Art. 14 (B01 à B11 → quel type
de sinistre/dommage) existe-t-elle dans un document non fourni ? Le code
de barème est-il saisi par l'expert au moment de l'expertise, ou déduit
automatiquement d'autres champs (nature des dommages, montant) ?

**Une fois répondu** : ajouter `claim.baremeCode`/`vehicleCategory`
(nullable, jamais rempli rétroactivement par une valeur devinée) + la
table de correspondance comme référentiel figé.

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

## 7. Commission — onglets "Adhésions & retraits" et "Plafond conventionnel"

**Capture** : écran 7 "Commission de Suivi et de Conciliation" — 4
onglets dans le guide : "Rôle des affaires", "Sanctions", "Adhésions &
retraits", "Plafond conventionnel".

**Pourquoi pas construit** : seuls les 2 premiers onglets existent
(`CommissionCase`/`Sanction`, réels). Il n'existe aucune entité pour une
**demande** d'adhésion/retrait d'une compagnie (seul le statut final
`Company.status` existe, pas de workflow de demande avec instruction) ni
pour une **demande** de révision du plafond conventionnel (Art.4).

**Question** : Les demandes d'adhésion/retrait et de révision du plafond
passent-elles réellement par un circuit documenté quelque part (courrier,
réunion UAR, autre système) ? Si IDA Place doit les tracer, quelles sont
les étapes exactes du workflow (qui initie, qui valide, délais) ?

**Une fois répondu** : nouvelles entités `MembershipRequest`/
`CeilingRevisionRequest` avec leur propre machine d'état — travail de
modélisation complet, pas un ajout de champ.

---

## 8. Compensation trimestrielle — pipeline "Avancement du lot"

**Capture** : écran 6 — pipeline à 5 étapes nommées avec échéances
(au-delà du cycle à 3 étapes déjà implémenté sur `/cockpit` :
Saisie/Synthèse Annexe 7/Compensation).

**Pourquoi pas construit** : `SettlementClosure` ne modélise qu'une
clôture simple (une date, un auteur), pas un workflow multi-étapes avec
échéances intermédiaires. Déjà tranché par le Product Owner (sprint 3 bis)
comme "vraie nouvelle fonctionnalité, pas de la donnée déjà là".

**Question** : Quelles sont exactement les 5 étapes (noms, ordre,
échéance de chacune par rapport à la date de clôture du trimestre) ? Qui
est responsable de faire avancer chaque étape (rôle) ?

**Une fois répondu** : modéliser un workflow `SettlementPipelineStep`
(ou étendre `SettlementClosure`) — nécessite une vraie conception, pas un
champ additif.

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

## Comment utiliser ce document

Chaque section est indépendante : répondre à une seule suffit à
débloquer le point correspondant sans toucher aux autres. Aucune réponse
ici n'est urgente pour le fonctionnement actuel de la plateforme — tous
les écrans du guide illustré sont déjà construits et vérifiés avec les
données réellement disponibles ; ces points concernent uniquement les
écarts volontaires documentés dans `HANDOFF.md` des deux dépôts.
