import { AgencyType } from './entities/agency.entity';
import { hierarchyViolation } from './agency-hierarchy.rules';

describe('organisation DG > DR > AG', () => {
  it('accepte DR sous DG, agence sous DR ou DG, et toute entité sans rattachement', () => {
    expect(hierarchyViolation(AgencyType.DR, AgencyType.DG)).toBeNull();
    expect(hierarchyViolation(AgencyType.AG, AgencyType.DR)).toBeNull();
    expect(hierarchyViolation(AgencyType.AG, AgencyType.DG)).toBeNull();
    expect(hierarchyViolation(AgencyType.DG, undefined)).toBeNull();
  });

  it('refuse les rattachements incohérents, avec un message lisible', () => {
    expect(hierarchyViolation(AgencyType.DR, AgencyType.AG)).toBe('Une Direction régionale relève de la Direction générale, pas d’une agence.');
    expect(hierarchyViolation(AgencyType.AG, AgencyType.AG)).toBe('Une agence relève d’une Direction régionale ou de la Direction générale, pas d’une agence.');
    expect(hierarchyViolation(AgencyType.DG, AgencyType.DR)).toMatch(/racine de l’organisation/);
  });
});
