import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { CacheService } from '../common/cache/cache.service';
import { ClaimsModule } from '../claims/claims.module';
import { ClaimsService } from '../claims/claims.service';
import { MatchingModule } from '../matching/matching.module';
import { MatchingService } from '../matching/matching.service';

const SUMMARY_CACHE_TTL_SECONDS = 10;

const LATE_THRESHOLD_DAYS = 7;

/**
 * CockpitModule — écran 1 "Cockpit de place". Module AGRÉGATEUR additionnel
 * (en plus des 17 modules de B.2), qui agrège désormais les VRAIES données
 * de `ClaimsModule` (dossiers) et `MatchingModule` (file de confrontation)
 * au lieu de valeurs mockées. Forme de `GET /cockpit/summary` INCHANGÉE
 * (contrat stable, voir HANDOFF.md) — seules les valeurs sont réelles.
 *
 * Hypothèses documentées (RecoursModule/SettlementModule restent hors
 * périmètre de ce sprint, voir HANDOFF.md) :
 *  - "dossiers du jour" = dossiers importés aujourd'hui (date de création) ;
 *  - "à apparier" = lignes de la file de confrontation au statut
 *    `A_CONFIRMER` (MatchingModule, B.5) ;
 *  - "en retard" = dossiers encore en `A_APPARIER` depuis plus de
 *    `LATE_THRESHOLD_DAYS` jours (pas de timer conventionnel réel tant que
 *    RecoursModule reste un mock) ;
 *  - "compensation à venir" = somme des montants (expertisé si connu, sinon
 *    estimé) des dossiers non encore réglés (`A_APPARIER`/`APPARIE`).
 */
@ApiTags('cockpit')
@ApiBearerAuth()
@Controller('cockpit')
@UseGuards(AuthGuard)
class CockpitController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly matching: MatchingService,
    private readonly cache: CacheService,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'KPIs agrégés du cockpit de place (dossiers du jour, à apparier, en retard, compensation à venir) — mis en cache (Redis si REDIS_ENABLED, sinon recalculé à chaque appel, voir cache.service.ts)' })
  async summary() {
    // Sprint 3 : référence réutilisable de cache de lecture (CacheService,
    // voir common/cache). TTL volontairement court (10s) : le cockpit doit
    // rester quasi temps réel, le cache n'économise que les appels en
    // rafale (ex. plusieurs onglets ouverts) — pas de rupture de forme.
    return this.cache.getOrSet('cockpit:summary', SUMMARY_CACHE_TTL_SECONDS, () => this.computeSummary());
  }

  private async computeSummary() {
    const [{ items: allClaims }, matchCounters] = await Promise.all([
      this.claims.list({ page: 1, pageSize: 100_000 }),
      this.matching.counters(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const lateThresholdMs = LATE_THRESHOLD_DAYS * 86_400_000;

    const dossiersDuJour = allClaims.filter((c) => c.createdAt.slice(0, 10) === today).length;
    const enRetard = allClaims.filter(
      (c) => c.state === 'A_APPARIER' && now - new Date(c.createdAt).getTime() > lateThresholdMs,
    ).length;
    const compensationAVenir = allClaims
      .filter((c) => c.state === 'A_APPARIER' || c.state === 'APPARIE')
      .reduce((sum, c) => sum + (c.expertAmount ?? c.estimatedAmount ?? 0), 0);

    // Sparkline : nb de dossiers créés par jour sur les 12 derniers jours (ordre chronologique).
    const sparklineDeclarations: number[] = [];
    for (let i = 11; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      sparklineDeclarations.push(allClaims.filter((c) => c.createdAt.slice(0, 10) === day).length);
    }

    // Position nette par compagnie (somme des montants où elle est "A" moins où elle est adverse "B").
    const companies = new Set<string>();
    for (const c of allClaims) {
      if (c.company) companies.add(c.company);
      if (c.counterpartyCompany) companies.add(c.counterpartyCompany);
    }
    const barresNettes = Array.from(companies).map((company) => {
      const net = allClaims.reduce((sum, c) => {
        const amount = c.expertAmount ?? c.estimatedAmount ?? 0;
        if (c.company === company) return sum + amount;
        if (c.counterpartyCompany === company) return sum - amount;
        return sum;
      }, 0);
      return { company, net };
    });

    return {
      kpis: {
        dossiersDuJour,
        aApparier: matchCounters.A_CONFIRMER ?? 0,
        enRetard,
        compensationAVenir,
      },
      sparklineDeclarations,
      barresNettes,
      updatedAt: new Date().toISOString(),
    };
  }
}

@Module({ imports: [ClaimsModule, MatchingModule], controllers: [CockpitController] })
export class CockpitModule {}
