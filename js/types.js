// タイプ相性
export const TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
  'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

export const TYPE_JA = {
  Normal: 'ノーマル', Fire: 'ほのお', Water: 'みず', Electric: 'でんき', Grass: 'くさ', Ice: 'こおり',
  Fighting: 'かくとう', Poison: 'どく', Ground: 'じめん', Flying: 'ひこう', Psychic: 'エスパー', Bug: 'むし',
  Rock: 'いわ', Ghost: 'ゴースト', Dragon: 'ドラゴン', Dark: 'あく', Steel: 'はがね', Fairy: 'フェアリー',
};

export const TYPE_COLOR = {
  Normal: '#9a9a8a', Fire: '#e8692c', Water: '#3d8be0', Electric: '#e8bb1e', Grass: '#4fa84a', Ice: '#5cc4cf',
  Fighting: '#c2412f', Poison: '#9150b8', Ground: '#b8843a', Flying: '#7f95e0', Psychic: '#e0507e', Bug: '#8fa524',
  Rock: '#a8954f', Ghost: '#5f5a9e', Dragon: '#5560d8', Dark: '#5a4a44', Steel: '#6f97a8', Fairy: '#d97fc8',
};

// 攻撃タイプ → { 防御タイプ: 倍率 }（1 倍は省略）
const CHART = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

// 攻撃タイプが、防御側のタイプ（1〜2個）に与える倍率
export function effectiveness(atkType, defTypes) {
  let m = 1;
  for (const t of defTypes) m *= CHART[atkType]?.[t] ?? 1;
  return m;
}

// 特性で倍率が変わるもの（受ける側）
const ABILITY_IMMUNE = {
  Levitate: 'Ground', 'Flash Fire': 'Fire', 'Water Absorb': 'Water', 'Storm Drain': 'Water', 'Dry Skin': 'Water',
  'Volt Absorb': 'Electric', 'Lightning Rod': 'Electric', 'Motor Drive': 'Electric', 'Sap Sipper': 'Grass',
  'Earth Eater': 'Ground', 'Well-Baked Body': 'Fire',
};

export function effectivenessWithAbility(atkType, defTypes, ability) {
  if (ability && ABILITY_IMMUNE[ability] === atkType) return 0;
  let m = effectiveness(atkType, defTypes);
  if (ability === 'Thick Fat' && (atkType === 'Fire' || atkType === 'Ice')) m *= 0.5;
  if (ability === 'Heatproof' && atkType === 'Fire') m *= 0.5;
  if (ability === 'Purifying Salt' && atkType === 'Ghost') m *= 0.5;
  if (ability === 'Water Bubble' && atkType === 'Fire') m *= 0.5;
  if (ability === 'Fluffy' && atkType === 'Fire') m *= 2;
  if (ability === 'Wonder Guard' && m < 2) m = 0;
  return m;
}

// 防御側の 18 タイプ分の倍率
export function defenseProfile(defTypes, ability) {
  return Object.fromEntries(TYPES.map((t) => [t, effectivenessWithAbility(t, defTypes, ability)]));
}
