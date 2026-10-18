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

## 11. Compensation trimestrielle — qui peut clôturer la place entière ?

**Trouvé lors de la revue sécurité RBAC du 2026-10-18** (voir HANDOFF.md
backend, section de ce jour) : `POST /settlement/quarter/:q/close`
(`closeQuarterly`) exige le privilège `synth`, détenu à la fois par les
rôles "place" ET par `CORRESPONDANT_IDA`/`TRESORIER` (rôles scopés à UNE
compagnie). Contrairement à `closeMonthly` (clôture PAR compagnie, où un
`TRESORIER` ne clôturant que sa propre compagnie est légitime — corrigé
ce jour, voir HANDOFF.md), `closeQuarterly` n'a PAS de paramètre
compagnie : c'est une action **unique et place-entière** (compensation
multilatérale de TOUTES les compagnies à la fois). Techniquement
aujourd'hui, le trésorier d'UNE SEULE compagnie adhérente peut donc
déclencher la clôture trimestrielle pour TOUTE la place — générer le
bordereau Art.17 avant que les autres compagnies n'aient fini leurs
propres vérifications, par exemple.

**Pourquoi non corrigé seul** : ce n'est pas un trou de scoping tenant
(il n'y a pas de "compagnie B dont les données fuient vers la compagnie
A" ici) mais une question de matrice de privilèges — quel rôle doit
légitimement pouvoir déclencher une action place-entière irréversible.
Changer unilatéralement qui détient `synth` pour cette route précise
serait une décision métier, pas un correctif mécanique.

**Question** : La clôture trimestrielle (Art.17) doit-elle être réservée
aux rôles "place" (OPERATEUR_PLACE/ADMIN_UAR), ou un TRESORIER/
CORRESPONDANT_IDA peut-il légitimement la déclencher (ex: lors d'une
réunion UAR où un représentant de compagnie est mandaté) ?

**Une fois répondu** : si réservé aux rôles place, scinder un nouveau
privilège dédié (ex. `closeQuarter`) tenu uniquement par
OPERATEUR_PLACE/ADMIN_UAR/MEMBRE_COMMISSION, au lieu de réutiliser
`synth` (qui reste nécessaire pour la LECTURE des synthèses par les
compagnies). Changement de décorateur uniquement, pas de refactoring.

---

## 12. Référentiel de place — qui peut créer une NOUVELLE compagnie adhérente ?

**Trouvé lors de la revue sécurité RBAC du 2026-10-18** : `POST
/referential/companies` (`createCompany`) exige `refedit`, détenu par
`CORRESPONDANT_IDA` (rôle représentant une compagnie déjà adhérente).
Contrairement à `updateCompany`/`createAgency` (désormais vérifiés : un
correspondant ne peut agir que sur SA PROPRE compagnie, voir
HANDOFF.md), **créer une compagnie n'a pas de "propriétaire existant" à
vérifier** — c'est un acte d'onboarding d'un NOUVEL adhérent à la place.
Aujourd'hui, n'importe quel correspondant déjà adhérent peut créer une
compagnie adhérente supplémentaire.

**Pourquoi non corrigé seul** : décider si l'onboarding d'un nouvel
adhérent doit être un acte réservé aux rôles "place" (ADMIN_UAR, typique
d'un onboarding réglementaire) est une question de processus métier, pas
un trou de scoping tenant mécanique.

**Question** : L'admission d'une nouvelle compagnie à la convention IDA
passe-t-elle par une procédure UAR documentée ailleurs (vote, signature
de convention) qui devrait se refléter dans qui peut appeler cette
route ?

**Une fois répondu** : si réservé aux rôles place, retirer `refedit` de
`CORRESPONDANT_IDA` pour cette route spécifique (un privilège dédié, ex.
`onboardCompany`) — `refedit` resterait nécessaire pour
`updateCompany`/`createAgency`/experts (déjà correctement restreints à
sa propre compagnie).

---

## 13. Anti-fraude — le journal des actions suspectes doit-il être scopé ?

**Trouvé lors de la revue sécurité RBAC du 2026-10-18** : `GET
/fraud/cases` est désormais scopé par compagnie (`companiesInvolved`,
voir HANDOFF.md), mais `GET /fraud/actions` (journal des actions
suspectes de place : appariements manuels, déliage/reliage,
transmissions tardives) reste volontairement NON scopé. Raison technique
: `FraudAction.actor` est soit un identifiant utilisateur (décision
humaine), soit un code compagnie (transmission tardive) — un champ au
typage mixte, pas une paire `from`/`to` fiable pour filtrer par
compagnie comme ailleurs dans le projet.

**Question** : Ce journal doit-il rester place-wide (même esprit que
`LedgerModule`, un audit trail partagé), ou faut-il le scoper par
compagnie ? Si scopé, sur quel critère exactement — l'acteur humain
appartient-il à une compagnie traçable, ou faut-il relier chaque action
à son `claimId`/`matchId` pour en déduire les compagnies concernées ?

**Une fois répondu** : si scoping souhaité, ajouter un champ
`companiesInvolved`/`company` explicite à `FraudAction` (migration +
peuplement au moment de la création de l'action, pas une déduction a
posteriori fragile) — travail de modélisation, pas un filtre trivial à
ajouter à `actions()`.

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
