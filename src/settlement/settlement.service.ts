import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ConflictException, Injectable } from '@nestjs/common';
import { ClaimsService } from '../claims/claims.service';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { MeteringService } from '../metering/metering.service';
import { MonthlySettlementDto, QuarterCompensationDto, SettlementCompanyLineDto } from './dto/settlement.dto';
import { BilateralPosition, CompensationQuarter, NetPosition } from './entities/compensation-quarter.entity';
import { SettlementMonthly } from './entities/settlement-monthly.entity';
import { isWithinRange, parseMonthPeriod, parseQuarterPeriod } from './settlement.util';

/** États de dossier (ClaimsModule, `CLAIM_STATES`) considérés "en cours" côté cycle de règlement IDA. */
const PENDING_CLAIM_STATES = new Set(['A_APPARIER', 'APPARIE', 'ELIGIBLE', 'EN_RECOURS']);
const SETTLED_CLAIM_STATE = 'REGLE';

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). */
const MEMORY_MONTHLY = new Map<string, SettlementCompanyLineDto>(); // clé `${period}|${company}`
const MEMORY_QUARTER = new Map<string, QuarterCompensationDto>(); // clé `quarter`

function monthlyToDto(e: SettlementMonthly): SettlementCompanyLineDto {
  return {
    company: e.company,
    claimsSettledCount: e.claimsSettledCount,
    claimsPendingCount: e.claimsPendingCount,
    totalSettledAmount: e.totalSettledAmount,
    totalPendingAmount: e.totalPendingAmount,
    fraisTraitement: e.fraisTraitement,
    status: e.status,
    bordereauRef: e.bordereauRef,
    generatedAt: e.generatedAt.toISOString(),
    closedAt: e.closedAt?.toISOString(),
  };
}

function quarterToDto(e: CompensationQuarter): QuarterCompensationDto {
  return {
    quarter: e.quarter,
    bordereau: e.bordereauRef,
    positions: e.positions,
    net: e.net,
    status: e.status,
    generatedAt: e.generatedAt.toISOString(),
    sealedAt: e.sealedAt?.toISOString(),
  };
}

/**
 * SettlementModule — B.2/B.3. Écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle".
 *
 * Dépend de `ClaimsService` (public, ClaimsModule — jamais l'entité
 * `Claim`) pour la synthèse mensuelle, et de `MeteringService` (public,
 * MeteringModule) pour les frais de traitement dérivés de la grille
 * tarifaire TARIF-2026.01 (hypothèse documentée ci-dessous).
 *
 * ⚠️ HYPOTHÈSES À VALIDER PAR LE MÉTIER (le dossier technique ne chiffre
 * pas ces règles ici) :
 *  - période mensuelle/trimestrielle résolue sur la date d'accident du
 *    dossier (`accidentDate`), repli sur la date de création si absente ;
 *  - "frais de traitement" du bordereau mensuel = nombre de dossiers
 *    (réglés + en cours) de la compagnie sur la période × prix unitaire
 *    "Dossiers ingérés" de la grille TARIF-2026.01 courante (simple showback
 *    indicatif, PAS une facture — voir `MeteringModule`, qui reste le seul
 *    module de facturation réel) ;
 *  - position bilatérale (compensation trimestrielle) : pour un dossier
 *    RÉGLÉ où `company=A` a indemnisé son assuré et `counterpartyCompany=B`
 *    est la compagnie de la partie adverse déclarée, on retient que B doit
 *    reverser le montant à A (convention d'indemnisation directe : chaque
 *    assureur règle son propre assuré puis se fait rembourser par
 *    l'assureur de la partie responsable) — à confirmer avec le métier, le
 *    dossier ne détaille pas de barème de responsabilité par dossier ;
 *  - une période déjà CLOTURÉE/SCELLÉE n'est plus recalculée (valeurs
 *    gelées) : seul un recalcul manuel futur (hors périmètre) pourrait la
 *    rouvrir.
 */
@Injectable()
export class SettlementService {
  constructor(
    @InjectRepository(SettlementMonthly) private readonly monthlyRepo: EntityRepository<SettlementMonthly>,
    @InjectRepository(CompensationQuarter) private readonly quarterRepo: EntityRepository<CompensationQuarter>,
    private readonly claims: ClaimsService,
    private readonly metering: MeteringService,
  ) {}

  /**
   * B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que la ligne de SA
   * compagnie (jamais le bordereau mensuel des compagnies concurrentes) ;
   * les rôles "place" (dont `AUDITEUR_CSA`) voient toutes les compagnies.
   * Trou de sécurité comblé en revue Product Owner, sprint 3 — l'endpoint
   * n'était pas scopé du tout jusqu'ici.
   */
  async monthly(period: string, user?: AuthenticatedUser): Promise<MonthlySettlementDto> {
    const range = parseMonthPeriod(period);
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });
    const inPeriod = allClaims.filter((c) => isWithinRange(c.accidentDate || c.createdAt, range));

    const companies = new Set<string>();
    for (const c of inPeriod) if (c.company) companies.add(c.company);

    const tenant = user ? resolveTenantFilter(user) : undefined;
    const targetCompanies = tenant ? (companies.has(tenant) ? [tenant] : []) : Array.from(companies);

    const lines: SettlementCompanyLineDto[] = [];
    for (const company of targetCompanies) {
      lines.push(await this.monthlyForCompany(period, company, inPeriod));
    }
    lines.sort((a, b) => a.company.localeCompare(b.company));
    return { period, companies: lines };
  }

  private async monthlyForCompany(period: string, company: string, claimsInPeriod: { company: string; state: string; expertAmount?: number; estimatedAmount: number }[]): Promise<SettlementCompanyLineDto> {
    const key = `${period}|${company}`;

    const existing = await withDegradedFallback(
      'SettlementService.monthlyForCompany.read',
      async () => {
        const e = await this.monthlyRepo.findOne({ period, company });
        return e ? monthlyToDto(e) : undefined;
      },
      () => MEMORY_MONTHLY.get(key),
    );
    if (existing?.status === 'CLOTURE') return existing; // période gelée — pas de recalcul (voir hypothèses ci-dessus)

    const own = claimsInPeriod.filter((c) => c.company === company);
    const settled = own.filter((c) => c.state === SETTLED_CLAIM_STATE);
    const pending = own.filter((c) => PENDING_CLAIM_STATES.has(c.state));
    const totalSettledAmount = settled.reduce((s, c) => s + (c.expertAmount ?? c.estimatedAmount ?? 0), 0);
    const totalPendingAmount = pending.reduce((s, c) => s + (c.expertAmount ?? c.estimatedAmount ?? 0), 0);
    const fraisTraitement = Math.round((settled.length + pending.length) * this.metering.unitPrice('claimsIngested'));
    const bordereauRef = `BORD-${period}-${company}`;
    const generatedAt = new Date();

    const line: SettlementCompanyLineDto = {
      company,
      claimsSettledCount: settled.length,
      claimsPendingCount: pending.length,
      totalSettledAmount,
      totalPendingAmount,
      fraisTraitement,
      status: 'EN_COURS',
      bordereauRef,
      generatedAt: generatedAt.toISOString(),
    };

    await withDegradedFallback(
      'SettlementService.monthlyForCompany.write',
      async () => {
        let e = await this.monthlyRepo.findOne({ period, company });
        if (!e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          e = this.monthlyRepo.create({ period, company } as any);
          this.monthlyRepo.getEntityManager().persist(e);
        }
        Object.assign(e, {
          claimsSettledCount: line.claimsSettledCount,
          claimsPendingCount: line.claimsPendingCount,
          totalSettledAmount: line.totalSettledAmount,
          totalPendingAmount: line.totalPendingAmount,
          fraisTraitement: line.fraisTraitement,
          bordereauRef: line.bordereauRef,
        });
        await this.monthlyRepo.getEntityManager().flush();
      },
      () => {
        MEMORY_MONTHLY.set(key, line);
      },
    );

    return line;
  }

  async closeMonthly(period: string, company: string): Promise<SettlementCompanyLineDto> {
    const current = await this.monthlyForCompany(period, company, (await this.claims.list({ page: 1, pageSize: 100_000 })).items.filter((c) => isWithinRange(c.accidentDate || c.createdAt, parseMonthPeriod(period))));
    if (current.status === 'CLOTURE') {
      throw new ConflictException({ code: 'CONFLICT', message: 'Période déjà clôturée.' });
    }
    const closedAt = new Date();
    const closed: SettlementCompanyLineDto = { ...current, status: 'CLOTURE', closedAt: closedAt.toISOString() };

    await withDegradedFallback(
      'SettlementService.closeMonthly',
      async () => {
        const e = await this.monthlyRepo.findOne({ period, company });
        if (e) {
          e.status = 'CLOTURE';
          e.closedAt = closedAt;
          await this.monthlyRepo.getEntityManager().flush();
        }
      },
      () => {
        MEMORY_MONTHLY.set(`${period}|${company}`, closed);
      },
    );
    return closed;
  }

  /**
   * B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les positions
   * bilatérales où sa compagnie est partie, et uniquement son propre net
   * (jamais la matrice complète des créances/dettes entre concurrents) ;
   * les rôles "place" voient tout. Le `net` global reste calculé sur
   * l'ensemble des positions avant filtrage (sinon le net de la compagnie
   * serait faux). Trou de sécurité comblé en revue Product Owner, sprint 3.
   */
  private scopeQuarterForUser(dto: QuarterCompensationDto, user?: AuthenticatedUser): QuarterCompensationDto {
    const tenant = user ? resolveTenantFilter(user) : undefined;
    if (!tenant) return dto;
    return {
      ...dto,
      positions: dto.positions.filter((p) => p.from === tenant || p.to === tenant),
      net: dto.net.filter((n) => n.company === tenant),
    };
  }

  async quarter(q: string, user?: AuthenticatedUser): Promise<QuarterCompensationDto> {
    const existing = await withDegradedFallback(
      'SettlementService.quarter.read',
      async () => {
        const e = await this.quarterRepo.findOne({ quarter: q });
        return e ? quarterToDto(e) : undefined;
      },
      () => MEMORY_QUARTER.get(q),
    );
    if (existing?.status === 'SCELLE') return this.scopeQuarterForUser(existing, user); // trimestre scellé — pas de recalcul

    const range = parseQuarterPeriod(q);
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });
    const settledInQuarter = allClaims.filter(
      (c) => c.state === SETTLED_CLAIM_STATE && c.counterpartyCompany && isWithinRange(c.accidentDate || c.createdAt, range),
    );

    // Position bilatérale : B (compagnie adverse déclarée) doit à A (compagnie qui a réglé) — voir hypothèse en tête de fichier.
    const positionsMap = new Map<string, number>(); // clé `${from}|${to}`
    for (const c of settledInQuarter) {
      const from = c.counterpartyCompany!;
      const to = c.company;
      if (!from || !to || from === to) continue;
      const amount = c.expertAmount ?? c.estimatedAmount ?? 0;
      const key = `${from}|${to}`;
      positionsMap.set(key, (positionsMap.get(key) ?? 0) + amount);
    }
    const positions: BilateralPosition[] = Array.from(positionsMap.entries())
      .map(([key, amount]) => {
        const [from, to] = key.split('|');
        return { from, to, amount: Math.round(amount) };
      })
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    const companies = new Set<string>();
    for (const p of positions) {
      companies.add(p.from);
      companies.add(p.to);
    }
    const net: NetPosition[] = Array.from(companies)
      .map((company) => {
        const incoming = positions.filter((p) => p.to === company).reduce((s, p) => s + p.amount, 0);
        const outgoing = positions.filter((p) => p.from === company).reduce((s, p) => s + p.amount, 0);
        return { company, net: incoming - outgoing };
      })
      .sort((a, b) => a.company.localeCompare(b.company));

    const bordereauRef = `BORD-${q}`;
    const generatedAt = new Date();
    const dto: QuarterCompensationDto = { quarter: q, bordereau: bordereauRef, positions, net, status: 'CALCULE', generatedAt: generatedAt.toISOString() };

    await withDegradedFallback(
      'SettlementService.quarter.write',
      async () => {
        let e = await this.quarterRepo.findOne({ quarter: q });
        if (!e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          e = this.quarterRepo.create({ quarter: q } as any);
          this.quarterRepo.getEntityManager().persist(e);
        }
        Object.assign(e, { bordereauRef, positions, net });
        await this.quarterRepo.getEntityManager().flush();
      },
      () => {
        MEMORY_QUARTER.set(q, dto);
      },
    );

    return this.scopeQuarterForUser(dto, user);
  }

  async sealQuarter(q: string): Promise<QuarterCompensationDto> {
    const current = await this.quarter(q);
    if (current.status === 'SCELLE') {
      throw new ConflictException({ code: 'CONFLICT', message: 'Trimestre déjà scellé.' });
    }
    const sealedAt = new Date();
    const sealed: QuarterCompensationDto = { ...current, status: 'SCELLE', sealedAt: sealedAt.toISOString() };

    await withDegradedFallback(
      'SettlementService.sealQuarter',
      async () => {
        const e = await this.quarterRepo.findOne({ quarter: q });
        if (e) {
          e.status = 'SCELLE';
          e.sealedAt = sealedAt;
          await this.quarterRepo.getEntityManager().flush();
        }
      },
      () => {
        MEMORY_QUARTER.set(q, sealed);
      },
    );
    return sealed;
  }
}
