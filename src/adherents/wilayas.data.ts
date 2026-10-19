/**
 * Données de référence — 69 wilayas (B.3 "Wilaya").
 *
 * Codes 01→58 et noms français : découpage administratif algérien réel
 * (wilayas historiques + les 10 créées en 2019).
 *
 * ⚠️ Codes 59→69 : AUCUNE wilaya réelle ne correspond à ces codes
 * aujourd'hui (l'Algérie compte officiellement 58 wilayas). Le dossier
 * technique demande un référentiel de 69 entrées ; ces 11 lignes sont donc
 * des PLACEHOLDERS clairement identifiables (`name` préfixé `Wilaya `) à
 * vérifier/remplacer avec la vraie nomenclature avant mise en production
 * (voir HANDOFF.md).
 *
 * `col`/`row` : placement simple dans la grille de tuiles 13×8 (écran 11),
 * par ordre de code — PAS une position géographique réelle. À affiner si
 * un placement cartographique est souhaité.
 */
export interface WilayaSeed {
  code: string;
  name: string;
  nameAr?: string;
  region?: string;
  col: number;
  row: number;
  lat?: number;
  lng?: number;
  effectiveFrom?: string;
  parentCode?: string;
}

const REAL_NAMES: Array<[string, string]> = [
  ['01', 'Adrar'], ['02', 'Chlef'], ['03', 'Laghouat'], ['04', 'Oum El Bouaghi'],
  ['05', 'Batna'], ['06', 'Béjaïa'], ['07', 'Biskra'], ['08', 'Béchar'],
  ['09', 'Blida'], ['10', 'Bouira'], ['11', 'Tamanrasset'], ['12', 'Tébessa'],
  ['13', 'Tlemcen'], ['14', 'Tiaret'], ['15', 'Tizi Ouzou'], ['16', 'Alger'],
  ['17', 'Djelfa'], ['18', 'Jijel'], ['19', 'Sétif'], ['20', 'Saïda'],
  ['21', 'Skikda'], ['22', 'Sidi Bel Abbès'], ['23', 'Annaba'], ['24', 'Guelma'],
  ['25', 'Constantine'], ['26', 'Médéa'], ['27', 'Mostaganem'], ['28', "M'Sila"],
  ['29', 'Mascara'], ['30', 'Ouargla'], ['31', 'Oran'], ['32', 'El Bayadh'],
  ['33', 'Illizi'], ['34', 'Bordj Bou Arreridj'], ['35', 'Boumerdès'], ['36', 'El Tarf'],
  ['37', 'Tindouf'], ['38', 'Tissemsilt'], ['39', 'El Oued'], ['40', 'Khenchela'],
  ['41', 'Souk Ahras'], ['42', 'Tipaza'], ['43', 'Mila'], ['44', 'Aïn Defla'],
  ['45', 'Naâma'], ['46', 'Aïn Témouchent'], ['47', 'Ghardaïa'], ['48', 'Relizane'],
  ['49', 'Timimoun'], ['50', 'Bordj Badji Mokhtar'], ['51', 'Ouled Djellal'], ['52', 'Béni Abbès'],
  ['53', 'In Salah'], ['54', 'In Guezzam'], ['55', 'Touggourt'], ['56', 'Djanet'],
  ['57', "El M'Ghair"], ['58', 'El Meniaa'],
];

const GRID_COLS = 13;

export function buildWilayaSeeds(): WilayaSeed[] {
  const seeds: WilayaSeed[] = [];
  for (let n = 1; n <= 69; n++) {
    const code = String(n).padStart(2, '0');
    const real = REAL_NAMES.find(([c]) => c === code);
    const index = n - 1;
    seeds.push({
      code,
      name: real ? real[1] : `Wilaya ${code} (à vérifier)`,
      nameAr: real ? undefined : `ولاية ${code} (à vérifier)`,
      region: real ? undefined : 'À_VERIFIER',
      col: index % GRID_COLS,
      row: Math.floor(index / GRID_COLS),
    });
  }
  return seeds;
}
