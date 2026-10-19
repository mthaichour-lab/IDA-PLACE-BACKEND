import { MatchQueueItemDto } from './dto/matching.dto';
import { MASKED, projectForViewer } from './matching.projection';
import { compareForTieBreak, MatchCandidateIndex, matchKeysFor, NON_INDEXED_MAX_SCORE, selectBestCandidate } from './matching.selection';
import { ClaimMatchInput } from './matching.types';

const MIN = 50; // seuil MANUEL par défaut (MATCHING_CONFIRM_THRESHOLD)

const claimA: ClaimMatchInput = {
  id: 'a',
  numEconstat: 'EC-A',
  company: 'CAAT',
  counterpartyCompany: 'SAA',
  plateA: '16-111-16',
  plateB: '31-222-31',
  policeA: 'POL-A',
  policeB: 'POL-B',
  accidentDate: '2026-10-01',
  accidentTime: '10:00',
};

/** Déclaration miroir de B (plaques, polices et compagnies croisées : 35 + 15 + 10 = 60, niveau MANUEL). */
function mirror(id: string, company = 'SAA', extra: Partial<ClaimMatchInput> = {}): ClaimMatchInput {
  return { id, numEconstat: `EC-${id}`, company, counterpartyCompany: 'CAAT', plateA: '31 222 31', plateB: '16111 16', policeA: 'POL-B', policeB: 'POL-A', ...extra };
}

describe('SEC-03 — sélection de la contrepartie', () => {
  it('ne retient pas un candidat sous le seuil MANUEL (date/heure + compagnies croisées = 25 points)', () => {
    const weak: ClaimMatchInput = { id: 'w', company: 'SAA', counterpartyCompany: 'CAAT', accidentDate: '2026-10-01', accidentTime: '10:30' };
    expect(selectBestCandidate(claimA, [weak], MIN)).toBeUndefined();
  });

  it('retient un candidat au niveau MANUEL (plaques + polices + compagnies croisées = 60)', () => {
    const best = selectBestCandidate(claimA, [mirror('b')], MIN);
    expect(best?.candidate.id).toBe('b');
    expect(best?.result.score).toBe(60); // + compagnies croisées (10)
  });

  it('une déclaration d’une compagnie non désignée n’est jamais candidate, même avec le même e-constat', () => {
    const intruder = mirror('x', 'CASH', { numEconstat: 'EC-A' });
    expect(selectBestCandidate(claimA, [intruder], MIN)).toBeUndefined();
    const legit = mirror('y', 'SAA', { numEconstat: 'EC-A' });
    expect(selectBestCandidate(claimA, [intruder, legit], MIN)?.candidate.id).toBe('y');
  });

  it('sans compagnie adverse déclarée, le pool n’est pas restreint (donnée absente)', () => {
    const open = { ...claimA, counterpartyCompany: undefined };
    expect(selectBestCandidate(open, [mirror('z', 'CASH')], MIN)?.candidate.id).toBe('z');
  });

  it('départage déterministe des égalités : réception la plus ancienne, puis id — quel que soit l’ordre du pool', () => {
    const late = mirror('b1', 'SAA', { receivedAt: '2026-10-05T10:00:00.000Z' });
    const early = mirror('b2', 'SAA', { receivedAt: '2026-10-02T10:00:00.000Z' });
    for (const pool of [[late, early], [early, late]]) {
      const best = selectBestCandidate(claimA, pool, MIN)!;
      expect(best.candidate.id).toBe('b2');
      expect(best.tieBroken).toBe(true);
    }
    const sameDayX = mirror('bx', 'SAA', { receivedAt: '2026-10-02T10:00:00.000Z' });
    expect(selectBestCandidate(claimA, [sameDayX, early], MIN)!.candidate.id).toBe('b2');
    expect(compareForTieBreak(mirror('k1'), mirror('k2'))).toBeLessThan(0);
  });
});

describe('SEC-12 — index des candidats par clé de rapprochement', () => {
  it('clés normalisées comme le score (majuscules, espaces et tirets retirés)', () => {
    expect(matchKeysFor({ numEconstat: ' EC-1 ', plateA: '16-123 45', policeA: 'pol a' }).sort()).toEqual(['E:EC-1', 'N:POLA', 'P:1612345']);
  });

  it('le seuil MANUEL par défaut dépasse le score atteignable sans clé commune : l’index est exact', () => {
    expect(NON_INDEXED_MAX_SCORE).toBe(35);
    expect(MIN).toBeGreaterThan(NON_INDEXED_MAX_SCORE);
  });

  it('candidatesFor ne renvoie que les déclarations partageant une clé, sans la déclaration elle-même', () => {
    const unrelated: ClaimMatchInput = { id: 'u', company: 'SAA', plateA: '99-999-99' };
    const index = new MatchCandidateIndex([claimA, mirror('b'), unrelated]);
    expect(index.candidatesFor(claimA).map((c) => c.id)).toEqual(['b']);
  });

  it('5 000 déclarations sans clé commune : aucun candidat à scorer pour une nouvelle ligne', () => {
    const pool = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, company: 'SAA', plateA: `P${i}`, plateB: `Q${i}` }) as ClaimMatchInput);
    const index = new MatchCandidateIndex(pool);
    expect(index.candidatesFor(claimA)).toEqual([]);
  });
});

describe('SEC-03 — masquage des champs nominatifs avant confirmation', () => {
  const row: MatchQueueItemDto = {
    id: 'm1',
    refA: 'EC-A',
    companyA: 'CAAT',
    plateA: '16-111-16',
    refB: 'EC-B',
    companyB: 'SAA',
    plateB: '31-222-31',
    score: 50,
    level: 'MANUEL',
    status: 'A_CONFIRMER',
    econstatShared: false,
    criteria: { econstatPartage: false, plaquesCroisees: true, policeCroisee: true, dateHeure: false, compagniesCroisees: true, gps: false },
    at: '2026-10-01T00:00:00.000Z',
    accidentDateB: '2026-10-01',
    wilayaB: '31',
    policeA: 'POL-A',
    policeB: 'POL-B',
    assureAIdentite: 'Ahmed Benali',
    assureBIdentite: 'Karim Said',
    canalDeclarationB: 'ERP',
    responsabiliteB: { baremeCode: 'B01' },
    divergence: false,
  };

  it('lecteur A (niveau MANUEL non confirmé) : aucun champ nominatif de B, éléments de rapprochement conservés', () => {
    const out = projectForViewer(row, 'CAAT');
    expect(out).toMatchObject({ plateB: MASKED, policeB: MASKED, assureBIdentite: MASKED, canalDeclarationB: MASKED, masked: true });
    expect(out.responsabiliteB).toBeUndefined();
    expect(out).toMatchObject({ plateA: '16-111-16', assureAIdentite: 'Ahmed Benali', score: 50, wilayaB: '31', accidentDateB: '2026-10-01', criteria: row.criteria });
    expect(JSON.stringify(out)).not.toMatch(/Karim|31-222-31|POL-B/);
  });

  it('lecteur B : c’est le côté A qui est masqué', () => {
    const out = projectForViewer(row, 'SAA');
    expect(out).toMatchObject({ plateA: MASKED, policeA: MASKED, assureAIdentite: MASKED, plateB: '31-222-31' });
  });

  it('appariement confirmé (manuel ou automatique) ou rôle place : rien n’est masqué', () => {
    expect(projectForViewer({ ...row, status: 'CONFIRME_MANUEL' }, 'CAAT').assureBIdentite).toBe('Karim Said');
    expect(projectForViewer({ ...row, status: 'AUTO_CONFIRME' }, 'CAAT').plateB).toBe('31-222-31');
    expect(projectForViewer(row, undefined)).toBe(row);
  });

  it('ligne non appariée : rien à masquer côté B', () => {
    const lonely = { ...row, companyB: undefined, plateB: undefined, refB: undefined, assureBIdentite: undefined, policeB: undefined, canalDeclarationB: undefined, responsabiliteB: undefined };
    expect(projectForViewer(lonely, 'CAAT').masked).toBeUndefined();
  });
});
