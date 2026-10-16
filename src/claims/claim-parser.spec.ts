import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { mapRow, parseClaimFile, splitCsvLine } from './claim-parser';

describe('splitCsvLine', () => {
  it('découpe des champs simples séparés par des virgules', () => {
    expect(splitCsvLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });

  it('gère les champs entre guillemets contenant le séparateur', () => {
    expect(splitCsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  it('gère les guillemets échappés (doublés) à l’intérieur d’un champ', () => {
    expect(splitCsvLine('"il dit ""bonjour""",b', ',')).toEqual(['il dit "bonjour"', 'b']);
  });

  it('supporte le séparateur point-virgule', () => {
    expect(splitCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('préserve les champs vides', () => {
    expect(splitCsvLine('a,,c', ',')).toEqual(['a', '', 'c']);
  });
});

describe('mapRow', () => {
  function buildFullRow(): string[] {
    // Une cellule plausible par colonne, dans l'ordre exact de CLAIM_IMPORT_COLUMNS.
    const sample: Record<string, string> = {
      numEconstat: 'ECT-2026-1',
      dateDeclaration: '2026-01-05',
      dateDemandeRecours: '2026-01-20',
      nombreVehicules: '2',
      territoire: 'ALGERIE',
      wilaya: '16',
      commune: 'Alger-Centre',
      dateAccident: '2026-01-01',
      heureAccident: '10:30',
      lieuAccident: 'Rue X',
      gpsLat: '36.75',
      gpsLng: '3.06',
      compagnieA: 'CAAT',
      numAttestationA: 'ATT-A-1',
      validiteADebut: '2025-01-01',
      validiteAFin: '2026-12-31',
      garantieA: 'TOUS_RISQUES',
      conducteurAEstAssure: 'oui',
      immatriculationA: '16-100000-16',
      compagnieB: 'SAA',
      numAttestationB: 'ATT-B-1',
      validiteBDebut: '2025-01-01',
      validiteBFin: '2026-12-31',
      garantieB: 'RC',
      immatriculationB: '31-200000-31',
      conducteurBEstAssure: 'non',
      montantEstime: '150000',
      montantExpertise: '140000',
      exclusions: '',
      piecesFournies: 'CONSTAT_AMIABLE;CARTE_GRISE;PERMIS_CONDUIRE;ATTESTATION_ASSURANCE',
      constatAmiableSigneDeuxParties: 'oui',
      responsabiliteDeclareeA: '60',
      responsabiliteDeclareeB: '40',
      observationsIda: 'RAS',
      dommagesCorporelsDeclares: 'non',
      adversePartieAdherente: 'oui',
      adversePartieActive: 'oui',
      vehiculeAImmobilise: 'non',
      vehiculeBImmobilise: 'non',
      expertDesigne: 'Expert X',
      dateExpertise: '2026-01-15',
      numPoliceA: 'POL-A-1',
      numPoliceB: 'POL-B-1',
      assureAIdentite: 'Jean Dupont',
      assureBIdentite: 'Karim Benali',
      telephoneAssureA: '0555000000',
      canalDeclaration: 'IMPORT',
    };
    return CLAIM_IMPORT_COLUMNS.map((c) => sample[c.key] ?? '');
  }

  it('mappe les 47 colonnes sans erreur sur une ligne complète et valide', () => {
    const { values, errors } = mapRow(buildFullRow());
    expect(errors).toHaveLength(0);
    expect(values.nombreVehicules).toBe(2);
    expect(values.territoire).toBe('ALGERIE');
    expect(values.conducteurAEstAssure).toBe(true);
    expect(values.conducteurBEstAssure).toBe(false);
    expect(values.montantEstime).toBe(150000);
    expect(values.piecesFournies).toEqual(['CONSTAT_AMIABLE', 'CARTE_GRISE', 'PERMIS_CONDUIRE', 'ATTESTATION_ASSURANCE']);
    expect(values.exclusions).toBeUndefined(); // cellule vide ⇒ absence de valeur (pas un tableau vide)
    expect(values.canalDeclaration).toBe('IMPORT');
  });

  it('traite les cellules vides comme des valeurs absentes (pas une erreur)', () => {
    const { values, errors } = mapRow([]);
    expect(errors).toHaveLength(0);
    expect(values.nombreVehicules).toBeUndefined();
  });

  it('signale une erreur de type sur une colonne numérique non numérique', () => {
    const row = buildFullRow();
    const idx = CLAIM_IMPORT_COLUMNS.findIndex((c) => c.key === 'montantEstime');
    row[idx] = 'pas-un-nombre';
    const { errors } = mapRow(row);
    expect(errors.some((e) => e.includes('Montant estimé'))).toBe(true);
  });

  it('signale une erreur sur une valeur d’énumération inconnue (territoire)', () => {
    const row = buildFullRow();
    const idx = CLAIM_IMPORT_COLUMNS.findIndex((c) => c.key === 'territoire');
    row[idx] = 'MARS';
    const { errors } = mapRow(row);
    expect(errors.some((e) => e.includes('Territoire'))).toBe(true);
  });

  it('accepte les littéraux booléens insensibles à la casse', () => {
    const row = buildFullRow();
    const idx = CLAIM_IMPORT_COLUMNS.findIndex((c) => c.key === 'conducteurAEstAssure');
    row[idx] = 'OUI';
    const { values, errors } = mapRow(row);
    expect(errors).toHaveLength(0);
    expect(values.conducteurAEstAssure).toBe(true);
  });
});

describe('parseClaimFile (CSV)', () => {
  it('ignore la première ligne (en-tête) et parse les lignes suivantes', async () => {
    const header = CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(',');
    const row1 = CLAIM_IMPORT_COLUMNS.map((c) => (c.key === 'nombreVehicules' ? '2' : c.key === 'territoire' ? 'ALGERIE' : '')).join(',');
    const buffer = Buffer.from(`${header}\n${row1}\n`, 'utf-8');
    const rows = await parseClaimFile(buffer, 'import.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(1);
    expect(rows[0].values.nombreVehicules).toBe(2);
    expect(rows[0].values.territoire).toBe('ALGERIE');
  });

  it('détecte le séparateur point-virgule', async () => {
    const header = CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(';');
    const row1 = CLAIM_IMPORT_COLUMNS.map((c) => (c.key === 'nombreVehicules' ? '2' : '')).join(';');
    const buffer = Buffer.from(`${header}\n${row1}\n`, 'utf-8');
    const rows = await parseClaimFile(buffer, 'import.csv');
    expect(rows[0].values.nombreVehicules).toBe(2);
  });
});
