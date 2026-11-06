// 実数値の計算（Lv50・個体値31 固定）
// チャンピオンズの能力ポイントは合計 66・1 つの能力に最大 32。
// 1 ポイント = 努力値 8 なので、Lv50 では実数値がちょうど 1 ずつ上がる。
// 元データの「実数値」は能力ポイント 0 のときの値なので、そこにポイントを足し、性格補正をかける。

export const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_JA = { hp: 'H', atk: 'A', def: 'B', spa: 'C', spd: 'D', spe: 'S' };
export const STAT_LONG_JA = { hp: 'HP', atk: 'こうげき', def: 'ぼうぎょ', spa: 'とくこう', spd: 'とくぼう', spe: 'すばやさ' };
export const SP_TOTAL = 66;
export const SP_MAX = 32;

// 性格 → [上がる能力, 下がる能力]
export const NATURES = {
  Hardy: [null, null], Lonely: ['atk', 'def'], Brave: ['atk', 'spe'], Adamant: ['atk', 'spa'], Naughty: ['atk', 'spd'],
  Bold: ['def', 'atk'], Docile: [null, null], Relaxed: ['def', 'spe'], Impish: ['def', 'spa'], Lax: ['def', 'spd'],
  Timid: ['spe', 'atk'], Hasty: ['spe', 'def'], Serious: [null, null], Jolly: ['spe', 'spa'], Naive: ['spe', 'spd'],
  Modest: ['spa', 'atk'], Mild: ['spa', 'def'], Quiet: ['spa', 'spe'], Bashful: [null, null], Rash: ['spa', 'spd'],
  Calm: ['spd', 'atk'], Gentle: ['spd', 'def'], Sassy: ['spd', 'spe'], Careful: ['spd', 'spa'], Quirky: [null, null],
};

export function natureMod(nature, stat) {
  const [up, down] = NATURES[nature] ?? [null, null];
  if (stat === up) return 1.1;
  if (stat === down) return 0.9;
  return 1;
}

// base: 能力ポイント 0 の実数値 [H,A,B,C,D,S]、sp: 能力ポイント [H,A,B,C,D,S]
export function calcStats(base, sp = [0, 0, 0, 0, 0, 0], nature = 'Serious') {
  return STATS.map((s, i) => {
    const raw = base[i] + (sp[i] || 0);
    return i === 0 ? raw : Math.floor(raw * natureMod(nature, s));
  });
}

// ランク補正（-6〜+6）
export function rankMod(rank) {
  return rank >= 0 ? (2 + rank) / 2 : 2 / (2 - rank);
}

// すばやさの目安（最速・準速・無振り・最遅）
export function speedTiers(baseSpe) {
  return {
    fastest: Math.floor((baseSpe + SP_MAX) * 1.1),
    fast: baseSpe + SP_MAX,
    neutral: baseSpe,
    slowest: Math.floor(baseSpe * 0.9),
  };
}

export function validateSpread(sp) {
  const total = sp.reduce((a, b) => a + (b || 0), 0);
  return { total, ok: total <= SP_TOTAL && sp.every((v) => v >= 0 && v <= SP_MAX) };
}
