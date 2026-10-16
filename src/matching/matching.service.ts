import { Injectable, NotFoundException } from '@nestjs/common';
import { paginateArray } from '../common/dto/pagination.dto';
import {
  MatchDecisionDto,
  MatchDecisionResultDto,
  MatchQueueItemDto,
  MatchQueueQueryDto,
  MatchThresholdsDto,
} from './dto/matching.dto';

const COMPANIES = ['CAAT', 'SAA', 'CASH', 'ALLI'];

function buildMock(): MatchQueueItemDto[] {
  return Array.from({ length: 22 }).map((_, i) => {
    const econstatShared = i % 6 === 0;
    const plaquesCroisees = econstatShared || i % 2 === 0;
    const policeCroisee = i % 3 === 0;
    const dateHeure = i % 2 === 0;
    const compagniesCroisees = i % 4 !== 0;
    const gps = i % 5 === 0;
    const score = econstatShared
      ? 100
      : (plaquesCroisees ? 35 : 0) + (policeCroisee ? 15 : 0) + (dateHeure ? 15 : 0) + (compagniesCroisees ? 10 : 0) + (gps ? 10 : 0);
    const level = score >= 80 ? 'AUTO' : score >= 50 ? 'MANUEL' : 'NON';
    const status = level === 'AUTO' ? 'AUTO_CONFIRME' : level === 'MANUEL' ? 'A_CONFIRMER' : 'A_CONFIRMER';
    return {
      id: `mtc-${2000 + i}`,
      refA: `ECT-2026-${10000 + i}`,
      companyA: COMPANIES[i % 4],
      plateA: `${(i % 2 === 0 ? '16' : '31')}-${100000 + i}-16`,
      refB: i % 7 === 6 ? undefined : `ECT-2026-${10000 + i + 1}`,
      companyB: i % 7 === 6 ? undefined : COMPANIES[(i + 1) % 4],
      plateB: i % 7 === 6 ? undefined : `${(i % 2 === 0 ? '31' : '16')}-${200000 + i}-31`,
      score,
      level,
      status,
      econstatShared,
      criteria: { econstatPartage: econstatShared, plaquesCroisees, policeCroisee, dateHeure, compagniesCroisees, gps },
      at: new Date(Date.UTC(2026, 0, (i % 27) + 1, 9 + (i % 8))).toISOString(),
    };
  });
}

const MOCK_QUEUE: MatchQueueItemDto[] = buildMock();

/**
 * MatchingModule — écran 2. Clé d'appariement + score pondéré — B.5.
 *
 * TODO(backend-agent): implémenter la logique réelle, voir §B.5 du dossier :
 *  - clé exacte (n° e-constat partagé) puis clé composite (plaques non
 *    ordonnées {immatA, immatB} + date/heure ±2j/±60min + wilaya/commune +
 *    police/attestation croisés) ;
 *  - calcul du score pondéré (plaques 35, police 15, date-heure 15,
 *    compagnies croisées 10, GPS 10) sur les `Claim` réelles
 *    (ClaimsModule), persistance de `MatchQueueItem` (entité + migration) ;
 *  - seuils `auto`/`à confirmer` paramétrables (actuellement en dur :
 *    80 / 50, voir `getThresholds`) ;
 *  - barème de responsabilité Art. 14 avec validation humaine obligatoire
 *    sur `decide('confirm'|'reject'|'complement'|'link')` ;
 *  - émission des événements temps réel `match.updated` (RealtimeModule).
 * NE PAS changer la forme des DTO ni des routes `/matching/queue` et
 * `/matching/{id}/decide`.
 */
@Injectable()
export class MatchingService {
  queue(query: MatchQueueQueryDto) {
    let rows = MOCK_QUEUE;
    if (query.filter === 'AUTO') rows = rows.filter((r) => r.level === 'AUTO');
    if (query.filter === 'A_CONFIRMER') rows = rows.filter((r) => r.status === 'A_CONFIRMER');
    if (query.filter === 'NON_APPARIES') rows = rows.filter((r) => !r.refB);
    return paginateArray(rows, query.page, query.pageSize);
  }

  counters() {
    return {
      TOUS: MOCK_QUEUE.length,
      AUTO: MOCK_QUEUE.filter((r) => r.level === 'AUTO').length,
      A_CONFIRMER: MOCK_QUEUE.filter((r) => r.status === 'A_CONFIRMER').length,
      NON_APPARIES: MOCK_QUEUE.filter((r) => !r.refB).length,
    };
  }

  getThresholds(): MatchThresholdsDto {
    return { autoThreshold: 80, confirmThreshold: 50 };
  }

  decide(id: string, dto: MatchDecisionDto, decidedBy: string): MatchDecisionResultDto {
    const item = MOCK_QUEUE.find((r) => r.id === id);
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Élément de confrontation introuvable.' });

    const nextStatus: Record<string, string> = {
      confirm: 'CONFIRME_MANUEL',
      reject: 'REJETE',
      complement: 'COMPLEMENT',
      link: 'CONFIRME_MANUEL',
    };
    item.status = nextStatus[dto.action];
    item.confirmedBy = decidedBy;
    item.confirmedAt = new Date().toISOString();
    if (dto.action === 'reject') item.rejectReason = dto.reason;

    return { id: item.id, status: item.status, decidedAt: item.confirmedAt, decidedBy };
  }
}
