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
