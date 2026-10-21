/* eslint-disable no-console */
/**
 * Jeu de démonstration — DÉVELOPPEMENT UNIQUEMENT (`npm run demo:seed`).
 *
 * Crée une activité de place réaliste pour CASH, CAAT, CAAR, SAA et 2A en
 * passant EXCLUSIVEMENT par l'API HTTP réelle, avec les mêmes contrôles que
 * l'interface (droits, éligibilité, machine d'état des recours, collégialité
 * de la commission, journal scellé) : aucune ligne n'est écrite directement
 * en base, aucune date n'est antidatée.
 *
 *  1. Adhésion de CAAR et 2A si absentes du référentiel : demande d'adhésion
 *     (courrier reçu), création au référentiel, acceptation avec agrément ;
 *  2. Déclarations (import 47 colonnes, une par compagnie déclarante) :
 *     paires à e-constat partagé (appariement automatique), paires sans
 *     e-constat commun (à confirmer, puis confirmées ou rejetées par un
 *     correspondant), déclarations unilatérales (non appariées) ;
 *  3. Recours (Annexe 2) ouverts par l'assureur de la victime, puis
 *     acceptation, opposition motivée (Annexe 3), levée, contestation
 *     (Annexe 4), transmission en commission ;
 *  4. Commission : saisine, délibéré, prononcé, PV signé par un second
 *     membre, clôture du recours ;
 *  5. Compensation : les recours réglés alimentent le cycle mensuel, la
 *     matrice et les positions nettes du trimestre EN COURS (la date de
 *     règlement est celle du jour : aucune date passée n'est fabriquée).
 *
 * Idempotent : chaque étape relit l'état réel (référentiel, dossiers, file
 * d'appariement, recours, dossiers de commission) et n'accomplit que ce qui
 * manque ; une seconde exécution ne crée rien.
 *
 * Garde-fous : refusé si `NODE_ENV=production`, si l'API n'est pas sur
 * l'hôte local, ou si elle n'accepte pas l'authentification de
 * développement (`x-dev-user`, elle-même interdite en production — SEC-01).
 *
 * Ce que ce script ne peut PAS produire, faute de pouvoir antidater :
 * alertes de délais dépassés (Art. 10/12/19, Art. 24 à 15 jours) et
 * trimestres échus. Elles apparaîtront d'elles-mêmes à l'échéance réelle.
 *
 * Variables : `IDA_API_URL` (défaut `http://localhost:3001/api/v1`).
 */
import { CLAIM_IMPORT_COLUMNS } from '../claims/claim-47-columns';

const API_URL = (process.env.IDA_API_URL ?? 'http://localhost:3001/api/v1').replace(/\/+$/, '');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// --------------------------------------------------------------------------
// Identités de démonstration (en-tête x-dev-user, ASCII uniquement)
// --------------------------------------------------------------------------

type DevUser = string;
const PLACE: DevUser = 'OPERATEUR_PLACE';
const corr = (code: string): DevUser =>
  JSON.stringify({ id: `demo-corr-${code}`, name: `Correspondant ${code} (demo)`, email: `correspondant.${code.toLowerCase()}@demo.ida-place.dz`, role: 'CORRESPONDANT_IDA', companyId: code });
const member = (slot: 'a' | 'b'): DevUser =>
  JSON.stringify({ id: `demo-commission-${slot}`, name: `Membre commission ${slot.toUpperCase()} (demo)`, email: `commission.${slot}@demo.ida-place.dz`, role: 'MEMBRE_COMMISSION' });

// --------------------------------------------------------------------------
// Client HTTP
// --------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

async function api<T = unknown>(method: string, path: string, user: DevUser, options: { body?: unknown; query?: Record<string, string | number | undefined>; form?: FormData } = {}): Promise<T> {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'x-dev-user': user };
  let body: string | FormData | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    // Limitation de débit (SEC-13) : on attend la fenêtre suivante plutôt que d'échouer.
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? 10) * 1000;
      console.log(`  … limite de débit atteinte, reprise dans ${Math.round(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, parsed, `${method} ${url.pathname} → ${res.status} ${JSON.stringify(parsed).slice(0, 400)}`);
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface Page<T> {
  items: T[];
  total: number;
}

/** Toutes les pages d'une liste paginée (100 par page, le maximum de l'API). */
async function listAll<T>(path: string, user: DevUser, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const res = await api<Page<T>>('GET', path, user, { query: { ...query, page, pageSize: 100 } });
    items.push(...res.items);
    if (res.items.length === 0 || items.length >= res.total) return items;
  }
}

// --------------------------------------------------------------------------
// Dates (relatives au jour d'exécution, en UTC comme les contrôles de l'API)
// --------------------------------------------------------------------------

const DAY = 86_400_000;
function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Référentiel : les cinq compagnies du jeu
// --------------------------------------------------------------------------

interface CompanyView {
  id: string;
  code: string;
  name: string;
  status: string;
}

/** Les cinq compagnies du jeu, inscrites par le circuit d'adhésion si absentes du référentiel. */
const MEMBERS = [
  { code: 'CASH', name: 'CASH Assurances', color: '#E30613', letterRef: 'DEMO-ADH-CASH', agrementRef: 'DEMO-AGR-AUTO-CASH' },
  { code: 'CAAT', name: 'CAAT — Compagnie Algérienne des Assurances', color: '#0072BC', letterRef: 'DEMO-ADH-CAAT', agrementRef: 'DEMO-AGR-AUTO-CAAT' },
  { code: 'SAA', name: "SAA — Société Nationale d'Assurance", color: '#F7A600', letterRef: 'DEMO-ADH-SAA', agrementRef: 'DEMO-AGR-AUTO-SAA' },
  { code: 'CAAR', name: "CAAR — Compagnie Algérienne d'Assurance et de Réassurance", color: '#C8102E', letterRef: 'DEMO-ADH-CAAR', agrementRef: 'DEMO-AGR-AUTO-CAAR' },
  { code: '2A', name: '2A — Algérienne des Assurances', color: '#1D4E89', letterRef: 'DEMO-ADH-2A', agrementRef: 'DEMO-AGR-AUTO-2A' },
];
const DEMO_COMPANIES = MEMBERS.map((m) => m.code);

async function ensureCompanies(): Promise<void> {
  console.log('1. Référentiel des adhérents');
  const companies = await listAll<CompanyView>('/referential/companies', PLACE);
  for (const m of MEMBERS) {
    if (companies.some((c) => c.code === m.code)) {
      console.log(`  = ${m.code} déjà adhérente`);
      continue;
    }
    // Art. 30-35 : courrier d'adhésion reçu par l'UAR, inscription au référentiel, acceptation avec agrément.
    const request = await api<{ id: string }>('POST', '/commission/membership-requests', PLACE, {
      body: { type: 'ADHESION', receivedAt: isoDay(0), letterRef: m.letterRef, candidateName: m.name, agrementRef: m.agrementRef },
    });
    const company = await api<CompanyView>('POST', '/referential/companies', PLACE, { body: { code: m.code, name: m.name, color: m.color } });
    await api('POST', `/commission/membership-requests/${request.id}/accept`, PLACE, { body: { agrementRef: m.agrementRef, companyId: company.id, decisionNote: 'Jeu de démonstration' } });
    console.log(`  + ${m.code} : demande d'adhésion acceptée, compagnie inscrite`);
  }
  const all = await listAll<CompanyView>('/referential/companies', PLACE);
  for (const code of DEMO_COMPANIES) {
    const c = all.find((x) => x.code === code);
    if (!c || c.status !== 'ACTIF') throw new Error(`Compagnie ${code} absente ou non active au référentiel (statut ${c?.status ?? '—'}) : jeu de démonstration impossible.`);
  }
}

// --------------------------------------------------------------------------
// Scénario : accidents, déclarations, décisions, recours
// --------------------------------------------------------------------------

/** Parcours visé pour le recours d'un accident (l'assureur de la victime `a` exerce le recours contre `b`). */
type RecoursPlan =
  | 'AUCUN'
  | 'EN_ATTENTE'
  | 'ACCEPTE'
  | 'OPPOSITION'
  | 'OPPOSITION_LEVEE'
  | 'CONTESTATION'
  | 'COMMISSION_A_INSTRUIRE'
  | 'COMMISSION_EN_DELIBERE'
  | 'COMMISSION_FONDE_REGLE'
  | 'COMMISSION_REJETE';

interface Accident {
  n: number;
  /** Assureur de la victime (non responsable) — demandeur du recours. */
  a: string;
  /** Assureur du responsable — partie adverse. */
  b: string;
  /** `partage` : e-constat commun aux deux déclarations ; `manuel` : constats distincts, appariement à confirmer ; `unilateral` : une seule déclaration. */
  kind: 'partage' | 'manuel' | 'unilateral';
  /** Décision sur une paire `manuel`. */
  decision?: 'confirm' | 'reject' | 'attente';
  daysAgo: number;
  hour: string;
  wilaya: string;
  commune: string;
  gps: [number, number];
  /** Montant expertisé du dossier de la victime (DA, ≤ plafond Art. 4). */
  amount: number;
  recours: RecoursPlan;
  opposition?: string;
}

const W = {
  alger: { wilaya: '16', commune: 'Alger-Centre', gps: [36.7538, 3.0588] as [number, number] },
  oran: { wilaya: '31', commune: 'Oran', gps: [35.6971, -0.6308] as [number, number] },
  constantine: { wilaya: '25', commune: 'Constantine', gps: [36.365, 6.6147] as [number, number] },
  annaba: { wilaya: '23', commune: 'Annaba', gps: [36.9, 7.7667] as [number, number] },
  blida: { wilaya: '09', commune: 'Blida', gps: [36.47, 2.8277] as [number, number] },
  setif: { wilaya: '19', commune: 'Sétif', gps: [36.1911, 5.4137] as [number, number] },
  relizane: { wilaya: '48', commune: 'Relizane', gps: [35.7372, 0.5558] as [number, number] },
  tizi: { wilaya: '15', commune: 'Tizi Ouzou', gps: [36.7169, 4.0497] as [number, number] },
};

const at = (place: keyof typeof W) => W[place];

const ACCIDENTS: Accident[] = [
  // --- e-constat partagé : appariement automatique, recours aux parcours variés ---
  { n: 1, a: 'CAAT', b: 'SAA', kind: 'partage', daysAgo: 19, hour: '08:40', ...at('alger'), amount: 186_500, recours: 'ACCEPTE' },
  { n: 2, a: 'CASH', b: 'CAAR', kind: 'partage', daysAgo: 18, hour: '17:15', ...at('oran'), amount: 92_300, recours: 'ACCEPTE' },
  { n: 3, a: '2A', b: 'CASH', kind: 'partage', daysAgo: 17, hour: '11:05', ...at('constantine'), amount: 251_350, recours: 'COMMISSION_FONDE_REGLE', opposition: 'Absence de garantie à la date de l’accident' },
  { n: 4, a: 'SAA', b: 'CAAT', kind: 'partage', daysAgo: 16, hour: '09:20', ...at('blida'), amount: 64_800, recours: 'ACCEPTE' },
  { n: 5, a: 'CAAR', b: '2A', kind: 'partage', daysAgo: 15, hour: '14:50', ...at('annaba'), amount: 143_900, recours: 'OPPOSITION_LEVEE', opposition: 'Montant de l’expertise contesté' },
  { n: 6, a: 'CAAT', b: 'CASH', kind: 'partage', daysAgo: 14, hour: '18:30', ...at('alger'), amount: 49_400, recours: 'EN_ATTENTE' },
  { n: 7, a: 'CASH', b: 'SAA', kind: 'partage', daysAgo: 13, hour: '07:55', ...at('setif'), amount: 192_200, recours: 'ACCEPTE' },
  { n: 8, a: 'SAA', b: '2A', kind: 'partage', daysAgo: 12, hour: '16:10', ...at('tizi'), amount: 105_450, recours: 'OPPOSITION', opposition: 'Responsabilité contestée : circonstances du constat incompatibles' },
  { n: 9, a: '2A', b: 'CAAT', kind: 'partage', daysAgo: 11, hour: '12:35', ...at('relizane'), amount: 259_400, recours: 'COMMISSION_EN_DELIBERE', opposition: 'Véhicule non assuré par nos soins à la date du sinistre' },
  { n: 10, a: 'CAAR', b: 'SAA', kind: 'partage', daysAgo: 10, hour: '10:45', ...at('oran'), amount: 78_900, recours: 'CONTESTATION', opposition: 'Pièces justificatives incomplètes' },
  { n: 11, a: 'CASH', b: 'CAAT', kind: 'partage', daysAgo: 9, hour: '19:05', ...at('constantine'), amount: 134_700, recours: 'COMMISSION_A_INSTRUIRE', opposition: 'Double déclaration du même sinistre' },
  { n: 12, a: 'SAA', b: 'CASH', kind: 'partage', daysAgo: 8, hour: '08:15', ...at('alger'), amount: 57_600, recours: 'ACCEPTE' },
  { n: 13, a: 'CAAT', b: 'CAAR', kind: 'partage', daysAgo: 7, hour: '13:25', ...at('annaba'), amount: 211_000, recours: 'COMMISSION_REJETE', opposition: 'Sinistre hors champ de la convention (dommages corporels)' },
  { n: 14, a: '2A', b: 'SAA', kind: 'partage', daysAgo: 6, hour: '15:40', ...at('blida'), amount: 88_250, recours: 'EN_ATTENTE' },
  { n: 15, a: 'CAAR', b: 'CASH', kind: 'partage', daysAgo: 5, hour: '09:50', ...at('setif'), amount: 119_300, recours: 'EN_ATTENTE' },
  { n: 16, a: 'CAAT', b: '2A', kind: 'partage', daysAgo: 4, hour: '17:35', ...at('tizi'), amount: 73_150, recours: 'ACCEPTE' },
  { n: 17, a: 'CASH', b: '2A', kind: 'partage', daysAgo: 3, hour: '11:20', ...at('relizane'), amount: 166_800, recours: 'EN_ATTENTE' },
  // --- constats distincts : appariement par score, à confirmer par un correspondant ---
  { n: 18, a: 'SAA', b: 'CAAR', kind: 'manuel', decision: 'confirm', daysAgo: 9, hour: '10:56', ...at('relizane'), amount: 98_600, recours: 'ACCEPTE' },
  { n: 19, a: 'CAAT', b: 'CASH', kind: 'manuel', decision: 'confirm', daysAgo: 6, hour: '10:58', ...at('oran'), amount: 54_900, recours: 'EN_ATTENTE' },
  { n: 20, a: '2A', b: 'CAAR', kind: 'manuel', decision: 'attente', daysAgo: 3, hour: '11:00', ...at('alger'), amount: 71_200, recours: 'AUCUN' },
  { n: 21, a: 'CASH', b: 'SAA', kind: 'manuel', decision: 'attente', daysAgo: 2, hour: '10:01', ...at('constantine'), amount: 132_000, recours: 'AUCUN' },
  { n: 22, a: 'CAAR', b: 'CAAT', kind: 'manuel', decision: 'reject', daysAgo: 5, hour: '16:25', ...at('annaba'), amount: 45_300, recours: 'AUCUN' },
  // --- déclarations unilatérales : en attente de la déclaration adverse ---
  { n: 23, a: 'SAA', b: 'CASH', kind: 'unilateral', daysAgo: 2, hour: '09:10', ...at('blida'), amount: 61_700, recours: 'AUCUN' },
  { n: 24, a: '2A', b: 'CAAT', kind: 'unilateral', daysAgo: 1, hour: '18:45', ...at('setif'), amount: 84_400, recours: 'AUCUN' },
  { n: 25, a: 'CAAT', b: 'SAA', kind: 'unilateral', daysAgo: 1, hour: '08:05', ...at('tizi'), amount: 139_950, recours: 'AUCUN' },
];

/** N° e-constat : commun pour une paire `partage`, propre à chaque partie sinon. */
function econstat(acc: Accident, side: 'a' | 'b'): string {
  if (acc.kind === 'partage') return `EC-2026-${640100 + acc.n}`;
  return `EC-2026-${(side === 'a' ? 650100 : 660100) + acc.n}`;
}

/** Immatriculation algérienne (série-année-wilaya), stable par accident et par véhicule. */
function plate(acc: Accident, side: 'a' | 'b'): string {
  const serie = 10_000 + ((acc.n * (side === 'a' ? 7_919 : 4_337)) % 89_999);
  const annee = 100 + ((acc.n * (side === 'a' ? 3 : 5)) % 25);
  return `${serie}-${annee}-${acc.wilaya}`;
}

function police(acc: Accident, side: 'a' | 'b'): string {
  const code = side === 'a' ? acc.a : acc.b;
  return `POL-${code}-2026-${String(400_000 + acc.n * 977 + (side === 'a' ? 0 : 31)).slice(-6)}`;
}

/** Ligne d'import 47 colonnes, du point de vue de la compagnie déclarante (`side`). */
function declarationRow(acc: Accident, side: 'a' | 'b'): Record<string, string> {
  const own = side;
  const other = side === 'a' ? 'b' : 'a';
  const victim = side === 'a';
  const accidentDay = isoDay(-acc.daysAgo);
  // Paire « manuel » : constats distincts, police de la partie adverse non reportée (score sous le seuil AUTO).
  const reportPolice = acc.kind !== 'manuel';
  return {
    numEconstat: econstat(acc, own),
    dateDeclaration: isoDay(-acc.daysAgo + 1),
    dateDemandeRecours: isoDay(Math.min(0, -acc.daysAgo + 2)),
    nombreVehicules: '2',
    territoire: 'ALGERIE',
    wilaya: acc.wilaya,
    commune: acc.commune,
    dateAccident: accidentDay,
    heureAccident: acc.hour,
    lieuAccident: `${acc.commune} — voie urbaine`,
    gpsLat: String(acc.gps[0]),
    gpsLng: String(acc.gps[1]),
    compagnieA: acc[own],
    numAttestationA: `ATT-${acc[own]}-2026-${String(acc.n).padStart(5, '0')}`,
    validiteADebut: isoDay(-200),
    validiteAFin: isoDay(165),
    garantieA: 'RC',
    conducteurAEstAssure: 'true',
    immatriculationA: plate(acc, own),
    compagnieB: acc[other],
    numAttestationB: `ATT-${acc[other]}-2026-${String(acc.n).padStart(5, '0')}`,
    validiteBDebut: isoDay(-240),
    validiteBFin: isoDay(125),
    garantieB: 'RC',
    immatriculationB: plate(acc, other),
    conducteurBEstAssure: 'true',
    montantEstime: String(victim ? acc.amount : Math.round(acc.amount * 0.6)),
    montantExpertise: String(victim ? acc.amount : Math.round(acc.amount * 0.6)),
    piecesFournies: 'CONSTAT_AMIABLE,CARTE_GRISE,PERMIS_CONDUIRE,ATTESTATION_ASSURANCE',
    constatAmiableSigneDeuxParties: 'true',
    responsabiliteDeclareeA: victim ? '0' : '100',
    responsabiliteDeclareeB: victim ? '100' : '0',
    observationsIda: 'Jeu de démonstration IDA Place',
    dommagesCorporelsDeclares: 'false',
    vehiculeAImmobilise: 'false',
    vehiculeBImmobilise: 'false',
    numPoliceA: police(acc, own),
    numPoliceB: reportPolice ? police(acc, other) : '',
    canalDeclaration: acc.kind === 'partage' ? 'ECONSTAT' : 'ERP',
  };
}

interface ClaimView {
  id: string;
  numEconstat: string;
  company: string;
  counterpartyCompany: string;
  eligibilityVerdict?: string;
}

async function ensureDeclarations(): Promise<Map<string, ClaimView>> {
  console.log('2. Déclarations (import 47 colonnes, par compagnie déclarante)');
  const key = (company: string, num: string) => `${company}|${num}`;
  const loadClaims = async () => {
    const map = new Map<string, ClaimView>();
    for (const code of DEMO_COMPANIES) for (const c of await listAll<ClaimView>('/claims', PLACE, { company: code })) map.set(key(c.company, c.numEconstat), c);
    return map;
  };
  let claims = await loadClaims();
  const header = CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(';');
  for (const code of DEMO_COMPANIES) {
    const rows: Record<string, string>[] = [];
    for (const acc of ACCIDENTS) {
      for (const side of ['a', 'b'] as const) {
        if (acc[side] !== code || (side === 'b' && acc.kind === 'unilateral')) continue;
        if (!claims.has(key(code, econstat(acc, side)))) rows.push(declarationRow(acc, side));
      }
    }
    if (rows.length === 0) {
      console.log(`  = ${code} : déclarations déjà importées`);
      continue;
    }
    const csv = [header, ...rows.map((v) => CLAIM_IMPORT_COLUMNS.map((c) => (v[c.key] ?? '').replace(/;/g, ',')).join(';'))].join('\n') + '\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), `ida-demo-${code}.csv`);
    const report = await api<{ totalRows: number; eligibleCount: number; ineligibleCount: number; rejectedCount: number }>('POST', '/claims/import', PLACE, { query: { company: code }, form });
    console.log(`  + ${code} : ${report.totalRows} ligne(s) — ${report.eligibleCount} éligible(s) IDA, ${report.ineligibleCount} non éligible(s), ${report.rejectedCount} rejetée(s)`);
  }
  claims = await loadClaims();
  for (const acc of ACCIDENTS) {
    const victim = claims.get(key(acc.a, econstat(acc, 'a')));
    if (!victim) throw new Error(`Déclaration ${econstat(acc, 'a')} (${acc.a}) absente après import.`);
    if (acc.recours !== 'AUCUN' && victim.eligibilityVerdict !== 'ELIGIBLE_IDA') throw new Error(`Déclaration ${victim.numEconstat} (${acc.a}) non éligible IDA (${victim.eligibilityVerdict}) : recours impossible.`);
  }
  return claims;
}

interface MatchRow {
  id: string;
  reference: string;
  refA: string;
  companyA: string;
  refB?: string;
  status: string;
  level: string;
  score: number;
}

async function ensureMatchingDecisions(): Promise<void> {
  console.log('3. Confrontation & matching');
  const queue = await listAll<MatchRow>('/matching/queue', PLACE);
  for (const acc of ACCIDENTS.filter((x) => x.kind === 'manuel')) {
    const row = queue.find((r) => r.companyA === acc.a && r.refA === econstat(acc, 'a'));
    if (!row) throw new Error(`Ligne d'appariement absente pour ${econstat(acc, 'a')} (${acc.a}).`);
    if (!row.refB) throw new Error(`${row.reference} : aucune contrepartie trouvée (score ${row.score}) — vérifier les clés de rapprochement.`);
    if (acc.decision === 'attente' || row.status !== 'A_CONFIRMER') {
      console.log(`  = ${row.reference} ${row.refA} ⇄ ${row.refB} : ${row.status} (score ${row.score})`);
      continue;
    }
    const action = acc.decision === 'confirm' ? 'confirm' : 'reject';
    await api('POST', `/matching/${row.id}/decide`, corr(acc.a), { body: { action, ...(action === 'reject' ? { reason: 'Véhicules et horaires incompatibles après vérification' } : {}) } });
    console.log(`  + ${row.reference} ${row.refA} ⇄ ${row.refB} : ${action === 'confirm' ? 'confirmé' : 'rejeté'} par ${acc.a}`);
  }
}

// --------------------------------------------------------------------------
// Recours et commission
// --------------------------------------------------------------------------

interface RecoursView {
  id: string;
  reference: string;
  claimId: string;
  from: string;
  to: string;
  state: string;
}

interface CaseView {
  id: string;
  reference: string;
  recoursId: string;
  status: string;
  pv?: unknown;
}

/** États par lesquels passe chaque parcours (ordre de la machine d'état). */
const PATHS: Record<Exclude<RecoursPlan, 'AUCUN'>, string[]> = {
  EN_ATTENTE: ['EN_ATTENTE'],
  ACCEPTE: ['EN_ATTENTE', 'REGLE'],
  OPPOSITION: ['EN_ATTENTE', 'OPPOSITION'],
  OPPOSITION_LEVEE: ['EN_ATTENTE', 'OPPOSITION', 'REGLE'],
  CONTESTATION: ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION'],
  COMMISSION_A_INSTRUIRE: ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION'],
  COMMISSION_EN_DELIBERE: ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION'],
  COMMISSION_FONDE_REGLE: ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'REGLE'],
  COMMISSION_REJETE: ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'REJETE'],
};

async function transition(r: RecoursView, action: string, user: DevUser, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await api<{ state: string }>('POST', `/recours/${r.id}/transition`, user, { body: { action, ...extra } });
  console.log(`    ${r.reference} : ${action} → ${res.state}`);
  r.state = res.state;
}

async function ensureCommissionCase(r: RecoursView, acc: Accident, cases: CaseView[]): Promise<CaseView> {
  let kase = cases.find((c) => c.recoursId === r.id);
  if (!kase) {
    kase = await api<CaseView>('POST', '/commission/cases', corr(acc.a), { body: { recoursId: r.id, motif: `Opposition maintenue : ${acc.opposition ?? 'désaccord des parties'}` } });
    console.log(`    ${kase.reference} : saisine de la commission (recours ${r.reference})`);
  }
  const wantDecision = acc.recours === 'COMMISSION_FONDE_REGLE' || acc.recours === 'COMMISSION_REJETE';
  const wantDeliberation = wantDecision || acc.recours === 'COMMISSION_EN_DELIBERE';
  if (wantDeliberation && kase.status === 'A_INSTRUIRE') {
    kase = await api<CaseView>('POST', `/commission/cases/${kase.id}/deliberate`, member('a'));
    console.log(`    ${kase.reference} : mis en délibéré`);
  }
  if (wantDecision && kase.status === 'EN_DELIBERE') {
    const outcome = acc.recours === 'COMMISSION_FONDE_REGLE' ? 'RECOURS_FONDE' : 'RECOURS_REJETE';
    kase = await api<CaseView>('POST', `/commission/cases/${kase.id}/decide`, member('a'), {
      body: { outcome, motif: outcome === 'RECOURS_FONDE' ? 'Le PV d’expertise établit l’imputabilité des dommages' : 'Sinistre hors champ de la convention IDA' },
    });
    console.log(`    ${kase.reference} : prononcé ${outcome}`);
  }
  if (wantDecision && !kase.pv) {
    // SEC-32 : le PV est signé par un autre membre que l'auteur du prononcé.
    kase = await api<CaseView>('POST', `/commission/cases/${kase.id}/pv-sign`, member('b'));
    console.log(`    ${kase.reference} : PV signé`);
  }
  return kase;
}

async function ensureRecours(claims: Map<string, ClaimView>): Promise<void> {
  console.log('4. Recours (Annexes 2/3/4) et commission');
  const existing = await listAll<RecoursView>('/recours', PLACE);
  const cases = await listAll<CaseView>('/commission/cases', PLACE);
  for (const acc of ACCIDENTS) {
    if (acc.recours === 'AUCUN') continue;
    const claim = claims.get(`${acc.a}|${econstat(acc, 'a')}`)!;
    let r = existing.find((x) => x.claimId === claim.id);
    if (!r) {
      r = await api<RecoursView>('POST', '/recours', corr(acc.a), { body: { claimId: claim.id, from: acc.a, to: acc.b, amount: acc.amount } });
      console.log(`  + ${r.reference} : Annexe 2 ${acc.a} → ${acc.b}, ${acc.amount.toLocaleString('fr-FR')} DA`);
    } else {
      console.log(`  = ${r.reference} : ${r.state}`);
    }
    const path = PATHS[acc.recours];
    const target = path[path.length - 1];
    if (!path.includes(r.state)) {
      console.log(`    ${r.reference} : état ${r.state} hors du parcours prévu (${path.join(' → ')}), laissé tel quel`);
      continue;
    }
    // Chaque tour fait avancer d'UN pas depuis l'état réel relu : relancer le script reprend là où il s'est arrêté.
    while (r.state !== target) {
      const next = path[path.indexOf(r.state) + 1];
      if (r.state === 'EN_ATTENTE' && next === 'REGLE') await transition(r, 'accepter', corr(acc.b), { reason: 'Responsabilité de notre assuré reconnue' });
      else if (r.state === 'EN_ATTENTE' && next === 'OPPOSITION') await transition(r, 'opposer', corr(acc.b), { reason: acc.opposition ?? 'Opposition motivée' });
      else if (r.state === 'OPPOSITION' && next === 'REGLE') await transition(r, 'lever_opposition', corr(acc.a), { reason: 'Justificatifs complémentaires transmis, opposition levée' });
      else if (r.state === 'OPPOSITION' && next === 'CONTESTATION') await transition(r, 'contester', corr(acc.a), { reason: 'Le PV d’expertise établit l’imputabilité des dommages' });
      else if (r.state === 'CONTESTATION' && next === 'COMMISSION') await transition(r, 'transmettre_commission', corr(acc.a), { reason: 'Désaccord persistant après contestation' });
      else if (r.state === 'COMMISSION') {
        await ensureCommissionCase(r, acc, cases);
        await transition(r, next === 'REGLE' ? 'cloturer_commission_favorable' : 'cloturer_commission_defavorable', PLACE, { reason: 'Décision de la commission' });
      } else throw new Error(`${r.reference} : aucun acte connu de ${r.state} vers ${next}`);
    }
    if (r.state === 'COMMISSION') await ensureCommissionCase(r, acc, cases);
  }
}

// --------------------------------------------------------------------------
// Synthèse lue en retour (aucune écriture)
// --------------------------------------------------------------------------

function currentPeriods(): { month: string; quarter: string } {
  const today = isoDay(0);
  const month = today.slice(0, 7);
  return { month, quarter: `${today.slice(0, 4)}-Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}` };
}

async function report(): Promise<void> {
  console.log('5. Compensation (lecture)');
  const { month, quarter } = currentPeriods();
  const monthly = await api<{ settledCount: number; totalAmount: number }>('GET', `/settlement/monthly/${month}/summary`, PLACE);
  const net = await api<{ net: Array<{ code: string; net: number }> }>('GET', `/settlement/quarter/${quarter}`, PLACE);
  const matrix = await api<{ cells: unknown[] }>('GET', `/settlement/quarter/${quarter}/matrix`, PLACE);
  console.log(`  Cycle ${month} : ${monthly.settledCount} recours réglé(s), ${monthly.totalAmount.toLocaleString('fr-FR')} DA`);
  console.log(`  ${quarter} : ${matrix.cells.length} cellule(s) de matrice ; positions nettes ${net.net.map((n) => `${n.code} ${n.net > 0 ? '+' : ''}${n.net.toLocaleString('fr-FR')}`).join(', ')}`);
}

// --------------------------------------------------------------------------

async function assertDevelopmentTarget(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusé : jeu de démonstration interdit en production (NODE_ENV=production).');
  const host = new URL(API_URL).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusé : l'API visée (${host}) n'est pas l'hôte local — ce script ne s'exécute que contre une API de développement.`);
  try {
    const me = await api<{ role?: string }>('GET', '/me', PLACE);
    if (me.role !== 'OPERATEUR_PLACE') throw new Error(`identité inattendue (${JSON.stringify(me)})`);
  } catch (err) {
    throw new Error(`Refusé : l'API n'accepte pas l'authentification de développement (x-dev-user) — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log(`Jeu de démonstration IDA Place → ${API_URL}`);
  await assertDevelopmentTarget();
  await ensureCompanies();
  const claims = await ensureDeclarations();
  await ensureMatchingDecisions();
  await ensureRecours(claims);
  await report();
  console.log('Terminé.');
}

main().catch((err) => {
  console.error(`Échec : ${(err as Error).message}`);
  process.exitCode = 1;
});
