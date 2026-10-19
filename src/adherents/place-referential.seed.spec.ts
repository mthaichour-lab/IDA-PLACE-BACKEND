import { Migration20261018030000_ReferentielPlace } from '../migrations/Migration20261018030000_ReferentielPlace';
import { CONSTAT_CIRCUMSTANCES_SEED, MOBILE_HOLIDAY_KINDS, OPPOSITION_MOTIFS_SEED } from './place-referential.data';
import { ALGERIA_FIXED_HOLIDAYS } from './referential-reference-data';
import { buildWilayaSeeds } from './wilayas.data';

/** Exécute `up()` en capturant le SQL, sans base. */
async function migrationSql(): Promise<string[]> {
  const sql: string[] = [];
  const migration = Object.create(Migration20261018030000_ReferentielPlace.prototype) as Migration20261018030000_ReferentielPlace;
  (migration as unknown as { addSql: (s: string) => void }).addSql = (s: string) => sql.push(s);
  await migration.up();
  return sql;
}

describe('Référentiels de place — données pré-remplies (seed)', () => {
  it('la migration ne pré-remplit ni fériés mobiles, ni populations, ni référence IRSAM, ni périmètre de wilaya', async () => {
    const inserts = (await migrationSql()).filter((s) => /insert\s+into/i.test(s));
    const tables = inserts.map((s) => /insert\s+into\s+"(\w+)"/i.exec(s)?.[1]);
    expect(tables.sort()).toEqual(['constat_circumstance', 'opposition_motif']);
    expect((await migrationSql()).join('\n')).not.toMatch(/update\s+"wilaya"/i);
  });

  it('la migration insère exactement les 17 circonstances (STANDARD_A_CONFIRMER) et le motif interdit des constantes', async () => {
    const sql = (await migrationSql()).join('\n');
    for (const c of CONSTAT_CIRCUMSTANCES_SEED) {
      expect(sql).toContain(`(${c.number}, '${c.labelFr.replace(/'/g, "''")}', 'STANDARD_A_CONFIRMER', 'system:seed')`);
    }
    expect(CONSTAT_CIRCUMSTANCES_SEED).toHaveLength(17);
    const [motif] = OPPOSITION_MOTIFS_SEED;
    expect(OPPOSITION_MOTIFS_SEED).toHaveLength(1);
    expect(motif.forbidden).toBe(true);
    expect(sql).toContain(`('${motif.code}', '${motif.label}', true, '${motif.sourceRef}', 'SAISI', 'system:seed')`);
  });

  it('les types de fériés mobiles sont fournis sans aucune date', () => {
    expect([...MOBILE_HOLIDAY_KINDS]).toEqual(['AWAL_MOHARRAM', 'ACHOURA', 'MAWLID_ENNABAOUI', 'AID_EL_FITR', 'AID_EL_ADHA']);
  });

  it('Yennayer (12 janvier) figure parmi les fériés fixes', () => {
    expect(ALGERIA_FIXED_HOLIDAYS.filter((h) => h.date.endsWith('-01-12')).map((h) => h.label)).toEqual(['Yennayer', 'Yennayer']);
  });

  it('aucun nom inventé pour les wilayas 59 à 69', () => {
    expect(buildWilayaSeeds().filter((w) => Number(w.code) >= 59).every((w) => w.name === `Wilaya ${w.code} (à vérifier)`)).toBe(true);
  });
});
