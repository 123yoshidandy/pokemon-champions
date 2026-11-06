// 環境データからの、おすすめの構築（6体）の提案
// 上位の相手への有利さ・弱点の重なり・よく組まれる組み合わせで点を付け、
// 1体ずつ足しながら良い組み合わせを残していく（ビームサーチ）
import { TYPES, defenseProfile } from './types.js';
import { usageOf, isMegaStone, moveData, isAttack } from './data.js';
import { defaultMember, memberBattler, normalizeTeam, TEAM_SIZE } from './team.js';
import { duel, topMeta, rankWeight } from './analysis.js';

// ---------- スタイル ----------

const WEATHER = {
  sun: { label: 'はれ', setter: ['Drought'], abusers: ['Chlorophyll', 'Solar Power', 'Protosynthesis', 'Flower Gift'], type: 'Fire' },
  rain: { label: 'あめ', setter: ['Drizzle'], abusers: ['Swift Swim', 'Rain Dish', 'Dry Skin'], type: 'Water' },
  sand: { label: 'すなあらし', setter: ['Sand Stream'], abusers: ['Sand Rush', 'Sand Force', 'Sand Veil'], type: 'Rock' },
  snow: { label: 'ゆき', setter: ['Snow Warning'], abusers: ['Slush Rush', 'Ice Body', 'Snow Cloak'], type: 'Ice' },
};

export const STYLES = {
  '': { label: 'おまかせ' },
  ...Object.fromEntries(Object.entries(WEATHER).map(([k, v]) => [k, { label: v.label }])),
  trickroom: { label: 'トリックルーム' },
  tailwind: { label: 'おいかぜ' },
};

// 振りなしのすばやさ（Lv50）がこれ以下なら、トリックルームで活きるとみなす（種族値 80 以下）
const TR_SPEED = 100;

const hasMove = (b, name) => b.moves.includes(name);

export function isSetter(b, style) {
  if (WEATHER[style]) return WEATHER[style].setter.includes(b.ability);
  if (style === 'trickroom') return hasMove(b, 'Trick Room');
  if (style === 'tailwind') return hasMove(b, 'Tailwind');
  return false;
}

// その場を活かせるか（始動役は除く）
export function isAbuser(db, b, style) {
  const w = WEATHER[style];
  if (w) {
    if (w.abusers.includes(b.ability)) return true;
    return b.moves.some((m) => {
      const mv = moveData(db, m);
      return isAttack(mv) && mv.power && mv.type === w.type;
    }) && b.types.includes(w.type);
  }
  if (style === 'trickroom') return (db.dex[b.id]?.stats[5] ?? Infinity) <= TR_SPEED;
  if (style === 'tailwind') return b.stats[5] >= 90 && b.stats[5] <= 140;
  return false;
}

// 構築にあるスタイル（表示用）
export function detectStyles(db, battlers) {
  return Object.keys(STYLES).filter((s) => s && battlers.some((b) => isSetter(b, s)));
}

// ---------- 候補の下ごしらえ ----------

// 候補ごとに、メガストーンあり／なしの型と、上位の相手への有利さを計算しておく
function prepare(db, ids, threats) {
  const cands = new Map();
  for (const id of ids) {
    if (!db.dex[id] || cands.has(id)) continue;
    const variants = [];
    const main = defaultMember(db, id);
    variants.push(main);
    if (isMegaStone(db, id, main.item)) variants.push(defaultMember(db, id, [], { noMega: true }));
    cands.set(id, variants.map((member) => {
      const b = memberBattler(db, member);
      return {
        id,
        member,
        battler: b,
        mega: isMegaStone(db, id, member.item),
        scores: threats.map((t) => (t.id === id ? 0 : duel(db, b, t).score)),
        prof: defenseProfile(b.types, b.ability),
      };
    }));
  }
  return cands;
}

// ---------- 点数 ----------

function evaluate(db, team, ctx) {
  const { threats, weights, wsum, style } = ctx;
  // 上位の相手への有利さ（一番有利なメンバー + 2番手を少し）
  let cover = 0;
  const holes = [];
  threats.forEach((t, j) => {
    let best = -1;
    let second = -1;
    for (const c of team) {
      const s = c.scores[j];
      if (s > best) [best, second] = [s, best];
      else if (s > second) second = s;
    }
    cover += weights[j] * (best + 0.3 * Math.max(0, second));
    if (best <= 0) holes.push(t.id);
  });
  cover /= wsum;

  // 弱点の重なり
  let defense = 0;
  const stacked = [];
  for (const type of TYPES) {
    let weak = 0;
    let resist = 0;
    for (const c of team) {
      if (c.prof[type] > 1) weak++;
      else if (c.prof[type] < 1) resist++;
    }
    if (weak >= 3 || (weak >= 2 && resist === 0)) {
      defense += weak >= 3 && resist === 0 ? 0.12 : 0.06;
      stacked.push(type);
    }
  }

  // よく組まれる組み合わせ（どちらかの採用データの上位5体に、もう一方が入っている）
  const pairs = [];
  for (let i = 0; i < team.length; i++) {
    for (let k = i + 1; k < team.length; k++) {
      const a = team[i].id;
      const b = team[k].id;
      if (usageOf(db, a).teammates.slice(0, 5).includes(b) || usageOf(db, b).teammates.slice(0, 5).includes(a)) pairs.push([a, b]);
    }
  }

  // スタイル
  let styleBonus = 0;
  if (style) {
    const setters = team.filter((c) => isSetter(c.battler, style)).length;
    const abusers = team.filter((c) => !isSetter(c.battler, style) && isAbuser(db, c.battler, style)).length;
    styleBonus = (setters ? 0.1 : -0.3) + Math.min(abusers, 4) * 0.08 - Math.max(0, setters - 2) * 0.05;
    // トリックルームでは、速いメンバーが裏目に出る
    if (style === 'trickroom') styleBonus -= team.filter((c) => c.battler.stats[5] >= 120 && !isSetter(c.battler, style)).length * 0.04;
  }

  // ほかの提案ですでに使ったメンバーを、少し減点する（似た構築ばかりにならないように）
  const reuse = ctx.used ? team.reduce((a, c) => a + (ctx.used.get(c.id) ?? 0), 0) * 0.04 : 0;

  const popularity = team.reduce((a, c) => a + rankWeight(db.rankOf.get(c.id)?.pos), 0) * 0.01;
  const base = cover - defense + Math.min(pairs.length, 5) * 0.02 + styleBonus + popularity;
  return { score: base - reuse, base, cover, holes, stacked, pairs, styleBonus };
}

// ---------- 探索 ----------

/**
 * @param axis 軸にするポケモン（必ず入れる）の id。最大 5 体
 * @param opts { pool: 候補にする上位の数, threats: 相手にする上位の数, style, beam, results }
 * @returns [{ team: member[6], members, eval }]
 */
export function suggestTeams(db, axis = [], { pool = 60, threats: threatN = 40, style = '', beam = 24, results = 5 } = {}) {
  const threatIds = topMeta(db, threatN);
  const threatBattlers = threatIds.map((id) => memberBattler(db, defaultMember(db, id)));
  const weights = threatIds.map((id) => rankWeight(db.rankOf.get(id)?.pos));
  const ctx = { threats: threatBattlers, weights, wsum: weights.reduce((a, b) => a + b, 0), style };
  const axisIds = [...new Set(axis.filter((id) => db.dex[id]))].slice(0, TEAM_SIZE - 1);
  const cands = prepare(db, [...axisIds, ...topMeta(db, pool)], threatBattlers);

  // 1体のポケモンについて、チームの状態に合う型（メガシンカは1体まで）
  const variantFor = (id, team) => {
    const megaTaken = team.some((c) => c.mega);
    return cands.get(id).find((v) => !(megaTaken && v.mega)) ?? null;
  };
  const sameBase = (team, id) => team.some((c) => db.dex[c.id].base === db.dex[id].base);
  const key = (team) => team.map((c) => `${c.id}:${c.mega ? 1 : 0}`).sort().join(',');

  // 始まり: 軸。スタイルの指定があって、軸に始動役がいなければ、始動役ごとに始める
  let start = [];
  for (const id of axisIds) {
    const v = variantFor(id, start);
    if (v && !sameBase(start, id)) start.push(v);
  }
  let states = [start];
  if (style && !start.some((c) => isSetter(c.battler, style))) {
    const setters = [...cands.keys()].filter((id) => !sameBase(start, id)).map((id) => variantFor(id, start)).filter((v) => v && isSetter(v.battler, style));
    if (setters.length) states = setters.map((v) => [...start, v]);
  }

  const search = () => {
    let cur = states;
    while (cur[0].length < TEAM_SIZE) {
      const next = new Map();
      for (const team of cur) {
        for (const id of cands.keys()) {
          if (sameBase(team, id)) continue;
          const v = variantFor(id, team);
          if (!v) continue;
          const t = [...team, v];
          const k = key(t);
          if (!next.has(k)) next.set(k, { team: t, ev: evaluate(db, t, ctx) });
        }
      }
      if (!next.size) break;
      cur = [...next.values()].sort((a, b) => b.ev.score - a.ev.score).slice(0, beam).map((x) => x.team);
    }
    return cur;
  };

  // 1つ選ぶごとに、使ったメンバーを減点して探し直す。軸の数より多く、同じメンバーが重なる構築は外す
  const picked = [];
  ctx.used = new Map();
  const maxShared = Math.max(4, start.length + 1);
  for (let round = 0; round < results * 2 && picked.length < results; round++) {
    const finals = search().map((team) => ({ team, ev: evaluate(db, team, ctx) })).sort((a, b) => b.ev.score - a.ev.score);
    const f = finals.find((x) => {
      const ids = new Set(x.team.map((c) => c.id));
      return !picked.some((p) => p.team.filter((c) => ids.has(c.id)).length > maxShared);
    });
    if (f) picked.push(f);
    for (const c of (f ?? finals[0]).team) if (!axisIds.includes(c.id)) ctx.used.set(c.id, (ctx.used.get(c.id) ?? 0) + 1);
  }
  picked.sort((a, b) => b.ev.base - a.ev.base);

  return picked.map(({ team, ev }) => {
    // 構築に入れる形にする（持ち物が重ならないように、順に選び直す）
    const members = [];
    for (const c of team) members.push(c.mega ? c.member : defaultMember(db, c.id, members, { noMega: team.some((x) => x.mega) }));
    const battlers = members.map((m) => memberBattler(db, m));
    return { team: normalizeTeam(members), battlers, eval: ev, styles: detectStyles(db, battlers) };
  });
}
