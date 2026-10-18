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

## 6. Échanges Annexes 2/3/4 — distinction "Accepté/silence" vs "Réglé/compensé"

**Capture** : écran 4 "Échanges" — le guide montre des onglets
"Acceptés/silence" et "Réglés/compensés" comme deux catégories
distinctes.

**Pourquoi pas construit** : `RECOURS_STATES` n'a qu'un seul état final
positif, `REGLE` — atteint soit par acceptation explicite, soit par
silence tacite Art.10, soit par clôture favorable de commission. Les
onglets `REGLE`/`REJETE` existent déjà côté front (ajoutés le
2026-10-18) mais ne distinguent pas "comment" un dossier est arrivé à
`REGLE`.

**Question** : La distinction "Accepté/silence" (résolu avant mise en
compensation) vs "Réglé/compensé" (effectivement payé lors de la
compensation trimestrielle) correspond-elle à un AUTRE état du cycle de
vie (ex. "réglé mais pas encore compensé" vs "compensé") ? Si oui, quel
événement marque le passage de l'un à l'autre — la clôture trimestrielle
(`SettlementClosure`) suffit-elle, ou faut-il un champ supplémentaire par
recours ?

**Une fois répondu** : si la distinction = `Recours.state === REGLE`
avant/après la date de `SettlementClosure` du trimestre concerné, c'est
calculable sans nouveau champ (sous-filtre additif côté front). Sinon,
ajouter le champ manquant sur `Recours`.

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

## 9. Recours — pièces jointes Annexes 2/3/4

**Capture** : écrans 4/7 — pièces jointes consultables par dossier de
recours/commission.

**Pourquoi pas construit** : `DocumentsModule` existe (upload/presign
réels) mais n'est intégré nulle part dans `RecoursModule`/
`CommissionModule` — le périmètre fonctionnel du dossier technique (B.2)
ne liste les pièces jointes que pour les écrans 2/3/12 (Import des
dossiers/Confrontation/Référentiel).

**Question** : Faut-il étendre la portée de `DocumentsModule` aux
recours/dossiers de commission (Annexe 2 = demande, Annexe 3 =
opposition, Annexe 4 = contestation, PV de commission) ? Si oui, qui
dépose ces pièces (upload manuel par l'utilisateur, ou génération
automatique de PDF à partir des données du recours) ?

**Une fois répondu** : relation `Recours`/`CommissionCase` →
`Document[]`, endpoints d'upload scoping par dossier — travail de
modélisation, pas un ajout trivial.

---

## 10. Monitoring assureurs — seuils de scoring à valider

**Pourquoi pas construit (nuance)** : contrairement aux autres points,
ceci N'EST PAS "non construit" — le scoring composite est réel et
pleinement fonctionnel (`monitoring.scoring.ts`), mais plusieurs seuils
et hypothèses de calcul sont **documentés comme non validés par le
métier** dans l'en-tête du fichier :
- `GRADE_THRESHOLDS` (A ≥ 90, B ≥ 72, C ≥ 50) — seuils choisis
  arbitrairement, non chiffrés par le dossier technique.
- `TARDIF_RATIO_THRESHOLD` (plus de la moitié du délai écoulé = "tardif")
  — hypothèse documentée mais pas une règle officielle.
- `OPPOSITION_ALERT_THRESHOLD_PCT` (20%) — seuil d'alerte arbitraire.
- Composante `delais` : mesure la latence accident→ingestion, pas la
  définition complète probable du dossier technique (délais de
  règlement/recours inclus).

**Question** : Quels sont les seuils réels validés par l'UAR pour chacun
de ces paramètres ? La définition de "délais" doit-elle inclure les
délais de règlement (nécessiterait une mesure supplémentaire basée sur
`Recours`, pas seulement `Claim.createdAt`) ?

**Une fois répondu** : ce sont déjà des constantes paramétrables en tête
de `monitoring.scoring.ts` — changement de valeur uniquement, zéro
refactoring.

---

## Comment utiliser ce document

Chaque section est indépendante : répondre à une seule suffit à
débloquer le point correspondant sans toucher aux autres. Aucune réponse
ici n'est urgente pour le fonctionnement actuel de la plateforme — tous
les écrans du guide illustré sont déjà construits et vérifiés avec les
données réellement disponibles ; ces points concernent uniquement les
écarts volontaires documentés dans `HANDOFF.md` des deux dépôts.
