import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLAIM_IMPORT_COLUMNS } from '../../src/claims/claim-47-columns';

/** Dates relatives à aujourd'hui : le dossier reste éligible quelle que soit la date d'exécution (forclusion Art. 19, validité des attestations). */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Importe une déclaration éligible IDA (modèle 47 colonnes, valeurs de `fixtures/import-eligible-ineligible.csv`) et renvoie l'id du dossier créé. */
export async function importEligibleClaim(app: INestApplication, numEconstat: string, company: string, counterparty: string): Promise<string> {
  const values: Record<string, string> = {
    numEconstat,
    dateDeclaration: daysFromNow(-10),
    dateDemandeRecours: daysFromNow(-5),
    nombreVehicules: '2',
    territoire: 'ALGERIE',
    wilaya: '16',
    commune: 'Alger-Centre',
    dateAccident: daysFromNow(-10),
    heureAccident: '10:30',
    compagnieA: company,
    numAttestationA: `ATT-A-${numEconstat}`,
    validiteADebut: daysFromNow(-300),
    validiteAFin: daysFromNow(300),
    garantieA: 'RC',
    conducteurAEstAssure: 'true',
    immatriculationA: '16123456',
    compagnieB: counterparty,
    numAttestationB: `ATT-B-${numEconstat}`,
    validiteBDebut: daysFromNow(-300),
    validiteBFin: daysFromNow(300),
    garantieB: 'RC',
    immatriculationB: '31654321',
    conducteurBEstAssure: 'true',
    montantEstime: '150000',
    montantExpertise: '150000',
    piecesFournies: 'CONSTAT_AMIABLE,CARTE_GRISE,PERMIS_CONDUIRE,ATTESTATION_ASSURANCE',
    constatAmiableSigneDeuxParties: 'true',
    responsabiliteDeclareeA: '0',
    responsabiliteDeclareeB: '100',
    dommagesCorporelsDeclares: 'false',
    adversePartieAdherente: 'true',
    adversePartieActive: 'true',
    canalDeclaration: 'IMPORT',
  };
  const header = CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(';');
  const row = CLAIM_IMPORT_COLUMNS.map((c) => values[c.key] ?? '').join(';');
  await request(app.getHttpServer())
    .post('/api/v1/claims/import')
    .set('x-dev-user', 'OPERATEUR_PLACE')
    .attach('file', Buffer.from(`${header}\n${row}\n`, 'utf-8'), `${numEconstat}.csv`)
    .expect(201);
  const list = await request(app.getHttpServer()).get('/api/v1/claims').query({ pageSize: 1000 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
  const claim = list.body.items.find((c: { numEconstat: string }) => c.numEconstat === numEconstat);
  if (!claim) throw new Error(`Dossier ${numEconstat} non importé`);
  if (claim.eligibilityVerdict !== 'ELIGIBLE_IDA') throw new Error(`Dossier ${numEconstat} non éligible : ${JSON.stringify(claim.eligibilityReasons)}`);
  return claim.id;
}
