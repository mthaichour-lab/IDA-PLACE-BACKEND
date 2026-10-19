import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLAIM_IMPORT_COLUMNS } from '../src/claims/claim-47-columns';
import { createTestApp } from './utils/test-app';

/**
 * Plan de remédiation sécurité 2026-10-19 — périmètre « dossiers »
 * (claims, matching, documents, fraud, cockpit, monitoring, stats,
 * metering). Chaque test reproduit le scénario d'exploitation du constat.
 */
describe('Remédiation sécurité 2026-10-19 — dossiers, appariement, pilotage (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  function companyUser(role: 'CORRESPONDANT_IDA' | 'TRESORIER', companyId: string): string {
    return JSON.stringify({ id: `u-${role}-${companyId}`, name: `${role} ${companyId}`, email: `u@${companyId}.test`, role, companyId });
  }

  function daysFromNow(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }

  /** Ligne éligible du modèle 47 colonnes (séparateur `;`). */
  function csvRow(overrides: Record<string, string>): string {
    const values: Record<string, string> = {
      dateDeclaration: daysFromNow(-10),
      dateDemandeRecours: daysFromNow(-5),
      nombreVehicules: '2',
      territoire: 'ALGERIE',
      wilaya: '16',
      commune: 'Alger-Centre',
      dateAccident: daysFromNow(-10),
      heureAccident: '10:30',
      immatriculationA: '16000001',
      immatriculationB: '31000001',
      montantEstime: '150000',
      montantExpertise: '150000',
      piecesFournies: 'CONSTAT_AMIABLE,CARTE_GRISE,PERMIS_CONDUIRE,ATTESTATION_ASSURANCE',
      constatAmiableSigneDeuxParties: 'true',
      dommagesCorporelsDeclares: 'false',
      adversePartieAdherente: 'true',
      adversePartieActive: 'true',
      canalDeclaration: 'IMPORT',
      ...overrides,
    };
    return CLAIM_IMPORT_COLUMNS.map((c) => values[c.key] ?? '').join(';');
  }

  function csvFile(...rows: string[]): Buffer {
    return Buffer.from(`${CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(';')}\n${rows.join('\n')}\n`, 'utf-8');
  }

  async function allClaims(): Promise<Array<{ id: string; numEconstat: string; company: string }>> {
    const res = await http().get('/api/v1/claims').query({ pageSize: 100 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
    return res.body.items;
  }

  describe('SEC-12 — import : déni de service par fichier', () => {
    const asCaat = () => http().post('/api/v1/claims/import').set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'));

    it('un faux XLSX (texte renommé) est refusé (400 FORMAT_INVALIDE)', async () => {
      const res = await asCaat().attach('file', Buffer.from('a;b;c\n1;2;3\n'), 'faux.xlsx').expect(400);
      expect(res.body.code).toBe('FORMAT_INVALIDE');
    });

    it('un .xls (Excel 97-2003) est refusé proprement (400)', async () => {
      const res = await asCaat().attach('file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'ancien.xls').expect(400);
      expect(res.body.code).toBe('FORMAT_XLS_NON_PRIS_EN_CHARGE');
    });

    it('un fichier au-delà de IMPORT_MAX_ROWS (5 000 par défaut) est refusé sans créer de dossier', async () => {
      const row = csvRow({ numEconstat: 'E2E-SEC12-FLOOD', compagnieA: 'CAAT' });
      const res = await asCaat().attach('file', csvFile(...Array.from({ length: 5001 }, () => row)), 'flood.csv').expect(400);
      expect(res.body.code).toBe('IMPORT_TROP_DE_LIGNES');
      expect((await allClaims()).some((c) => c.numEconstat === 'E2E-SEC12-FLOOD')).toBe(false);
    });
  });

  describe('SEC-39 — import : injection de formules neutralisée', () => {
    it('une identité « =HYPERLINK(…) » est stockée neutralisée et signalée dans le rapport', async () => {
      const res = await http()
        .post('/api/v1/claims/import')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC39', compagnieA: 'CAAT', compagnieB: 'SAA', assureAIdentite: '=HYPERLINK("http://evil.example","Ahmed")' })), 'f.csv')
        .expect(201);
      expect(res.body.warnings).toEqual([expect.objectContaining({ columnKey: 'assureAIdentite', code: 'FORMULE_NEUTRALISEE' })]);
      expect(res.body.rows[0].data.assureAIdentite).toMatch(/^'=HYPERLINK\(/);
      const claim = (await allClaims()).find((c) => c.numEconstat === 'E2E-SEC39')!;
      const detail = await http().get(`/api/v1/claims/${claim.id}`).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(detail.body.assureIdentite.startsWith("'")).toBe(true);
    });
  });

  describe('SEC-03 — file d’appariement : seuil, compagnie désignée, masquage', () => {
    async function importAs(company: string, overrides: Record<string, string>): Promise<void> {
      await http()
        .post('/api/v1/claims/import')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', company))
        .attach('file', csvFile(csvRow({ compagnieA: company, ...overrides })), `${company}.csv`)
        .expect(201);
    }

    it('CAAT lit la file : appariée à SAA (désignée), jamais à CASH, et sans aucun champ nominatif de SAA avant confirmation', async () => {
      // A (CAAT → SAA) et B (SAA → CAAT) : plaques et polices croisées, e-constat distincts → niveau MANUEL, à confirmer.
      await importAs('CAAT', { numEconstat: 'E2E-SEC03-A', compagnieB: 'SAA', immatriculationA: '16777001', immatriculationB: '31777001', numPoliceA: 'POL-S03-A', numPoliceB: 'POL-S03-B', assureAIdentite: 'Nom CAAT S03' });
      // Intrus : CASH reprend le n° e-constat de A, mais A a désigné SAA.
      await importAs('CASH', { numEconstat: 'E2E-SEC03-A', compagnieB: 'CAAT', immatriculationA: '09777001', assureAIdentite: 'Nom CASH S03' });
      await importAs('SAA', { numEconstat: 'E2E-SEC03-B', compagnieB: 'CAAT', immatriculationA: '31777001', immatriculationB: '16777001', numPoliceA: 'POL-S03-B', numPoliceB: 'POL-S03-A', assureAIdentite: 'Nom SAA S03' });

      const queue = await http().get('/api/v1/matching/queue').query({ pageSize: 100 }).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      const row = queue.body.items.find((i: { refA: string; companyA: string }) => i.refA === 'E2E-SEC03-A' && i.companyA === 'CAAT');
      expect(row).toMatchObject({ companyB: 'SAA', level: 'MANUEL', status: 'A_CONFIRMER', masked: true, plateB: '••••', assureBIdentite: '••••', policeB: '••••' });
      expect(JSON.stringify(row)).not.toMatch(/Nom SAA S03|Nom CASH S03|POL-S03-B|31777001/);

      const detail = await http().get(`/api/v1/matching/${row.id}`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      expect(detail.body.claimBId).toBeUndefined();
      expect(JSON.stringify(detail.body)).not.toContain('Nom SAA S03');

      // Après confirmation par CAAT, la contrepartie est publiée.
      await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).send({ action: 'confirm' }).expect(201);
      const confirmed = await http().get(`/api/v1/matching/${row.id}`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      expect(confirmed.body).toMatchObject({ assureBIdentite: 'Nom SAA S03', claimBId: expect.any(String) });
    });

    it('une seule coïncidence faible (même jour, compagnies croisées) ne rattache plus une déclaration tierce', async () => {
      await importAs('CAAT', { numEconstat: 'E2E-SEC03-WEAK-A', compagnieB: 'SAA', immatriculationA: '16888001', immatriculationB: '31888001', assureAIdentite: 'Nom faible A' });
      await importAs('SAA', { numEconstat: 'E2E-SEC03-WEAK-B', compagnieB: 'CAAT', immatriculationA: '31888999', immatriculationB: '16888999', assureAIdentite: 'Nom faible B' });
      const queue = await http().get('/api/v1/matching/queue').query({ pageSize: 100 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const row = queue.body.items.find((i: { refA: string }) => i.refA === 'E2E-SEC03-WEAK-A');
      expect(row).toMatchObject({ level: 'NON' });
      expect(row.refB).toBeUndefined();
      expect(row.assureBIdentite).toBeUndefined();
    });
  });

  describe('SEC-05 — cockpit de place', () => {
    it.each(['TRESORIER', 'CORRESPONDANT_IDA'] as const)('%s de CAAT : GET /cockpit/summary refusé (403)', async (role) => {
      await http().get('/api/v1/cockpit/summary').set('x-dev-user', companyUser(role, 'CAAT')).expect(403);
    });

    it.each(['OPERATEUR_PLACE', 'AUDITEUR_CSA', 'MEMBRE_COMMISSION'])('%s (rôle place) : accès autorisé', async (role) => {
      await http().get('/api/v1/cockpit/summary').set('x-dev-user', role).expect(200);
    });
  });

  describe('SEC-13 — requêtes au coût borné', () => {
    it.each(['/api/v1/claims', '/api/v1/matching/queue'])('%s?pageSize=100000 est refusé (400)', async (url) => {
      await http().get(url).query({ pageSize: 100000 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });

    it('GET /fraud/cases renvoie l’état de couverture de l’analyse (SEC-36) sans recalculer', async () => {
      const res = await http().get('/api/v1/fraud/cases').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(res.body.analysis).toMatchObject({ truncated: false, claimsAnalyzed: expect.any(Number) });
    });
  });

  describe('SEC-21 — journal des actions suspectes', () => {
    it.each(['CORRESPONDANT_IDA', 'TRESORIER'] as const)('%s : GET /fraud/actions refusé (403)', async (role) => {
      await http().get('/api/v1/fraud/actions').set('x-dev-user', companyUser(role, 'CAAT')).expect(403);
    });

    it.each(['OPERATEUR_PLACE', 'AUDITEUR_CSA'])('%s (rôle place) : accès autorisé', async (role) => {
      await http().get('/api/v1/fraud/actions').set('x-dev-user', role).expect(200);
    });
  });

  describe('SEC-26 — lectures minimisées pour les rôles compagnie', () => {
    it('GET /metering/place-summary/:period : réservé aux rôles place', async () => {
      await http().get('/api/v1/metering/place-summary/2026-09').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(403);
      await http().get('/api/v1/metering/place-summary/2026-09').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
    });

    it('GET /monitoring/scores : rang, note et score seulement pour les autres compagnies', async () => {
      await http()
        .post('/api/v1/claims/import')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC26-MON', compagnieA: 'SAA', compagnieB: 'CAAT' })), 'm.csv')
        .expect(201);
      const res = await http().get('/api/v1/monitoring/scores').set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      const saa = res.body.companies.find((c: { code: string }) => c.code === 'SAA');
      expect(saa).toBeDefined();
      expect(Object.keys(saa).sort()).toEqual(['code', 'grade', 'rank', 'score']);
      const place = await http().get('/api/v1/monitoring/scores').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(place.body.companies.find((c: { code: string }) => c.code === 'SAA')).toHaveProperty('profile');
    });

    it('GET /claims : un dossier de SAA qui désigne CAAT est visible de CAAT mais sans données nominatives tant qu’aucun dossier commun n’est confirmé', async () => {
      await http()
        .post('/api/v1/claims/import')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC26-CLM', compagnieA: 'SAA', compagnieB: 'CAAT', immatriculationA: '31999026', numPoliceA: 'POL-SAA-26', assureAIdentite: 'Nom SAA 26' })), 'c.csv')
        .expect(201);
      const list = await http().get('/api/v1/claims').query({ pageSize: 100 }).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      const claim = list.body.items.find((c: { numEconstat: string }) => c.numEconstat === 'E2E-SEC26-CLM');
      expect(claim).toMatchObject({ company: 'SAA', masked: true, plateA: '••••', policeA: '••••', assureIdentite: '••••' });
      const detail = await http().get(`/api/v1/claims/${claim.id}`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).expect(200);
      expect(JSON.stringify(detail.body)).not.toMatch(/Nom SAA 26|POL-SAA-26|31999026/);
      const own = await http().get(`/api/v1/claims/${claim.id}`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA')).expect(200);
      expect(own.body).toMatchObject({ assureIdentite: 'Nom SAA 26' });
    });
  });

  describe('SEC-28 — décisions d’appariement historisées et motivées', () => {
    it('A confirme ; B ne peut défaire qu’avec un motif ; chaque décision est historisée par partie', async () => {
      for (const [company, other, plateA, plateB] of [
        ['CAAT', 'SAA', '16555028', '31555028'],
        ['SAA', 'CAAT', '31555028', '16555028'],
      ]) {
        await http()
          .post('/api/v1/claims/import')
          .set('x-dev-user', companyUser('CORRESPONDANT_IDA', company))
          .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC28', compagnieA: company, compagnieB: other, immatriculationA: plateA, immatriculationB: plateB })), 'd.csv')
          .expect(201);
      }
      const asCaat = companyUser('CORRESPONDANT_IDA', 'CAAT');
      const asSaa = companyUser('CORRESPONDANT_IDA', 'SAA');
      const queue = await http().get('/api/v1/matching/queue').query({ pageSize: 100 }).set('x-dev-user', asCaat).expect(200);
      const row = queue.body.items.find((i: { refA: string; companyA: string }) => i.refA === 'E2E-SEC28' && i.companyA === 'CAAT');

      await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', asCaat).send({ action: 'confirm' }).expect(201);
      const refused = await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', asSaa).send({ action: 'reject' }).expect(400);
      expect(refused.body.code).toBe('MOTIF_REQUIS');
      await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', asSaa).send({ action: 'reject', reason: 'x'.repeat(501) }).expect(400);
      await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', asSaa).send({ action: 'link', linkDeclId: 'pas-un-uuid' }).expect(400);
      await http().post(`/api/v1/matching/${row.id}/decide`).set('x-dev-user', asSaa).send({ action: 'reject', reason: 'Sinistre différent' }).expect(201);

      const history = await http().get(`/api/v1/matching/${row.id}/decisions`).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(history.body.map((h: { action: string; decidedByCompany: string; newStatus: string }) => [h.action, h.decidedByCompany, h.newStatus])).toEqual([
        ['confirm', 'CAAT', 'CONFIRME_MANUEL'],
        ['reject', 'SAA', 'REJETE'],
      ]);
      expect(history.body[1].reason).toBe('Sinistre différent');
      await http().get(`/api/v1/matching/${row.id}/decisions`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CASH')).expect(403);
    });
  });

  describe('SEC-37 — grille tarifaire et factures simulées', () => {
    it('PUT /pricing/grid : prix négatif ou métrique inconnue refusés (400), version rétroactive refusée', async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      await http().put('/api/v1/pricing/grid').set('x-dev-user', 'ADMIN_UAR').send({ version: 'TARIF-2098.01', effectiveFrom: tomorrow, metrics: [{ metric: 'apiCalls', unitPrice: -45 }] }).expect(400);
      await http().put('/api/v1/pricing/grid').set('x-dev-user', 'ADMIN_UAR').send({ version: 'TARIF-2098.01', effectiveFrom: tomorrow, metrics: [{ metric: '__proto__', unitPrice: 1 }] }).expect(400);
      await http().put('/api/v1/pricing/grid').set('x-dev-user', 'ADMIN_UAR').send({ version: 'TARIF-2098.01', effectiveFrom: '2020-01-01' }).expect(400);
      const created = await http().put('/api/v1/pricing/grid').set('x-dev-user', 'ADMIN_UAR').send({ version: 'TARIF-2098.01', effectiveFrom: tomorrow, metrics: [{ metric: 'sms', unitPrice: 5 }] }).expect(200);
      expect(created.body).toMatchObject({ version: 'TARIF-2098.01', effectiveFrom: tomorrow });
      // La grille du jour n'est pas modifiée rétroactivement.
      const today = await http().get('/api/v1/pricing/grid').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(today.body.version).not.toBe('TARIF-2098.01');
    });

    it('facture et historique : marqués SIMULEE, période et métrique validées', async () => {
      const invoice = await http().get('/api/v1/metering/CAAT/2026-09').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(200);
      expect(invoice.body).toMatchObject({ status: 'SIMULEE', simulated: true });
      await http().get('/api/v1/metering/CAAT/2026-13').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(400);
      await http().get('/api/v1/metering/CAAT/2026-09/history/__proto__').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(400);
    });
  });

  describe('SEC-38 — contrôles d’accès masqués dans l’interface, refusés côté serveur', () => {
    it('PUT /pricing/grid par un CORRESPONDANT_IDA ou un TRESORIER : 403', async () => {
      for (const role of ['CORRESPONDANT_IDA', 'TRESORIER'] as const) {
        await http().put('/api/v1/pricing/grid').set('x-dev-user', companyUser(role, 'CAAT')).send({ version: 'TARIF-2097.01', effectiveFrom: '2097-01-01' }).expect(403);
      }
    });

    it('facturation d’une autre compagnie (écran metering) : 403', async () => {
      await http().get('/api/v1/metering/SAA/2026-09').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(403);
      await http().get('/api/v1/metering/SAA/2026-09/history/sms').set('x-dev-user', companyUser('TRESORIER', 'CAAT')).expect(403);
    });

    it('panneau Art. 14 côté compagnie B : PATCH /claims/:id/responsabilite par la partie adverse refusé (403)', async () => {
      await http()
        .post('/api/v1/claims/import')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC38-ART14', compagnieA: 'CAAT', compagnieB: 'SAA' })), 'a.csv')
        .expect(201);
      const claim = (await allClaims()).find((c) => c.numEconstat === 'E2E-SEC38-ART14')!;
      await http().patch(`/api/v1/claims/${claim.id}/responsabilite`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA')).send({ circonstancesA: [1] }).expect(403);
      await http().patch(`/api/v1/claims/${claim.id}/responsabilite`).set('x-dev-user', companyUser('TRESORIER', 'CAAT')).send({ circonstancesA: [1] }).expect(403);
      await http().patch(`/api/v1/claims/${claim.id}/responsabilite`).set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).send({ circonstancesA: [1] }).expect(200);
    });
  });

  describe('SEC-44 — entrées typées et bornées', () => {
    it.each([
      ['/api/v1/claims', { 'company[$ne]': 'CAAT' }],
      ['/api/v1/claims', { 'companyId[$ne]': 'CAAT' }],
      ['/api/v1/matching/queue', { 'companyId[$ne]': 'CAAT' }],
      ['/api/v1/fraud/cases', { 'companyId[$ne]': 'CAAT' }],
      ['/api/v1/claims', { company: 'caat; drop' }],
      ['/api/v1/stats/wilayas', { year: '99999' }],
    ])('%s ?%j : refusé (400)', async (url, query) => {
      await http().get(url).query(query).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });

    it.each(['/api/v1/claims/abc', '/api/v1/matching/abc', '/api/v1/documents/abc', '/api/v1/matching/abc/decisions'])('%s : id non UUID refusé (400)', async (url) => {
      await http().get(url).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });

    it.each(['/api/v1/fraud/adherents/../signals', '/api/v1/monitoring/companies/caat%20x/journeys'])('%s : code compagnie invalide refusé', async (url) => {
      const res = await http().get(url).set('x-dev-user', 'OPERATEUR_PLACE');
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('SEC-02 — import lié à la compagnie de l’appelant', () => {
    it('un CORRESPONDANT_IDA de CAAT qui importe des lignes de SAA : lignes refusées, aucun dossier au nom de SAA', async () => {
      const file = csvFile(
        csvRow({ numEconstat: 'E2E-SEC02-OWN', compagnieA: 'CAAT', compagnieB: 'SAA' }),
        csvRow({ numEconstat: 'E2E-SEC02-FORGED', compagnieA: 'SAA', compagnieB: 'CASH' }),
      );
      const res = await http().post('/api/v1/claims/import').set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT')).attach('file', file, 'sec02.csv').expect(201);

      expect(res.body).toMatchObject({ company: 'CAAT', totalRows: 2, rejectedCount: 1 });
      expect(res.body.rows[1]).toMatchObject({ verdict: 'HORS_IDA', rejected: true });
      const claims = await allClaims();
      expect(claims.some((c) => c.numEconstat === 'E2E-SEC02-FORGED')).toBe(false);
      expect(claims.find((c) => c.numEconstat === 'E2E-SEC02-OWN')?.company).toBe('CAAT');
    });

    it('un CORRESPONDANT_IDA ne peut pas importer au nom d’une autre compagnie via le paramètre (403)', async () => {
      await http()
        .post('/api/v1/claims/import')
        .query({ company: 'SAA' })
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC02-PARAM', compagnieA: 'SAA' })), 'p.csv')
        .expect(403);
    });

    it('un rôle place doit désigner la compagnie déclarante (400), qui doit exister au référentiel (400)', async () => {
      const missing = await http().post('/api/v1/claims/import').set('x-dev-user', 'OPERATEUR_PLACE').attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC02-PLACE' })), 'p.csv').expect(400);
      expect(missing.body.code).toBe('COMPAGNIE_REQUISE');
      const unknown = await http()
        .post('/api/v1/claims/import')
        .query({ company: 'ZZZZ' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', csvFile(csvRow({ numEconstat: 'E2E-SEC02-UNKNOWN' })), 'p.csv')
        .expect(400);
      expect(unknown.body.code).toBe('COMPAGNIE_INCONNUE');
      expect((await allClaims()).some((c) => c.company === 'INCONNU' || c.company === 'ZZZZ')).toBe(false);
    });
  });
});
