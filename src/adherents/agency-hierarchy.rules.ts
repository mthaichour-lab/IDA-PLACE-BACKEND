import { AgencyType } from './entities/agency.entity';

/**
 * Organisation d'une compagnie (B.3 « Agency », hiérarchie DG > DR > AG) :
 *  - la Direction générale (DG) est la racine, unique par compagnie ;
 *  - une Direction régionale (DR) relève de la DG ;
 *  - une agence (AG) relève d'une DR, ou directement de la DG.
 */
export const ALLOWED_PARENT_TYPES: Record<AgencyType, readonly AgencyType[]> = {
  [AgencyType.DG]: [],
  [AgencyType.DR]: [AgencyType.DG],
  [AgencyType.AG]: [AgencyType.DR, AgencyType.DG],
};

const LABEL: Record<AgencyType, string> = {
  [AgencyType.DG]: 'la Direction générale',
  [AgencyType.DR]: 'une Direction régionale',
  [AgencyType.AG]: 'une agence',
};

/** Message d'erreur si `type` ne peut pas relever d'un parent de type `parentType` (absent = racine), sinon `null`. */
export function hierarchyViolation(type: AgencyType, parentType: AgencyType | undefined): string | null {
  const allowed = ALLOWED_PARENT_TYPES[type];
  if (parentType === undefined) return null;
  if (allowed.length === 0) return `${capitalize(LABEL[type])} est la racine de l’organisation : elle ne relève d’aucune autre entité.`;
  if (!allowed.includes(parentType)) {
    return `${capitalize(LABEL[type])} relève ${allowed.map((t) => of(LABEL[t])).join(' ou ')}, pas ${of(LABEL[parentType])}.`;
  }
  return null;
}

/** « de la Direction générale », « d’une agence » (élision devant « une »). */
function of(label: string): string {
  return label.startsWith('une ') ? `d’${label}` : `de ${label}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
