// 構築の分析（相性・対面・相方の提案・選出）
// どれも「よく使われている型どうしで、どちらが先に倒せるか」を土台にしている
import { TYPES, defenseProfile, effectiveness } from './types.js';
import { moveData, isAttack, usageOf } from './data.js';
import { calcDamage } from './damage.js';
import { defaultMember, memberBattler } from './team.js';

// ---------- 対戦する形 ----------

const metaCache = new WeakMap();

// 環境のポケモンの、一番よく使われている型
export function metaBattler(db, id) {
  let byDb = metaCache.get(db);
  if (!byDb) metaCache.set(db, (byDb = new Map()));
  if (!byDb.has(id)) {
    const m = defaultMember(db, id);
    // 環境の型では、攻撃技を優先して 4 つ選ぶ（補助技ばかりだと打点が出ないため）
    const u = usageOf(db, id);
    const attacks = u.moves.filter(([n]) => isAttack(moveData(db, n))).map(([n]) => n);
    const others = u.moves.map(([n]) => n).filter((n) => !attacks.includes(n));
    m.moves = [...attacks.slice(0, 3), ...others, ...attacks.slice(3)].slice(0, 4);
    byDb.set(id, memberBattler(db, m));
  }
  return byDb.get(id);
}

export function topMeta(db, n) {
  return db.ranking.slice(0, n).map((r) => r.id).filter((id) => db.dex[id]);
}

export const rankWeight = (pos) => 1 / Math.sqrt(pos || 50);

// ---------- 打点 ----------

const NO_HIT = { move: null, avgPct: 0, minPct: 0, maxPct: 0, ko: { n: Infinity, chance: 0 }, eff: 0 };

// 一番通る技（命中も考えた平均ダメージ%で比べる）。filter で候補の技を絞れる
export function bestHit(db, att, def, field = {}, filter = null) {
  let best = null;
  for (const name of att.moves) {
    const mv = moveData(db, name);
    if (!isAttack(mv) || (filter && !filter(name, mv))) continue;
    const r = calcDamage(att, def, { name, ...mv }, { doubles: db.doubles, ...field });
    const avg = ((r.minPct + r.maxPct) / 2) * ((mv.acc ?? 100) / 100);
    if (!best || avg > best.avgPct) best = { move: name, avgPct: avg, minPct: r.minPct, maxPct: r.maxPct, ko: r.ko, eff: r.eff };
  }
  return best ?? NO_HIT;
}

const speedOf = (b) => Math.floor(b.stats[5] * (b.item === 'Choice Scarf' ? 1.5 : 1));

// HP が満タンのときだけ、受けるダメージを半分にする特性
const FULL_HP_GUARD = new Set(['Multiscale', 'Shadow Shield']);
// いかくで、こうげきが下がらない特性
const INTIMIDATE_IMMUNE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Mirror Armor', 'Guard Dog']);
// 外したときだけ反動を受ける技（反動の印が付いているが、当たったときは受けない）
const CRASH_MOVES = new Set(['High Jump Kick', 'Jump Kick', 'Supercell Slam', 'Axe Kick']);
// これだけ殴り合っても決着しなければ、互角とする
const MAX_TURNS = 10;

// いかくを受けた後の形（まけんきは、こうげきが上がる。かちきは、とくこうが上がる）
export function intimidated(b) {
  if (INTIMIDATE_IMMUNE.has(b.ability)) return b;
  const boosts = { ...b.boosts, atk: (b.boosts?.atk ?? 0) - 1 };
  if (b.ability === 'Defiant') boosts.atk += 2;
  if (b.ability === 'Competitive') boosts.spa = (boosts.spa ?? 0) + 2;
  return { ...b, boosts };
}

// 1回攻撃したときに、自分が受ける反動（自分の最大HPに対する%）
function recoilPct(db, att, def, hit) {
  if (!hit.move || hit.avgPct <= 0 || att.ability === 'Magic Guard') return 0;
  const mv = moveData(db, hit.move);
  let r = 0;
  if (att.item === 'Life Orb' && !(att.ability === 'Sheer Force' && mv.secondary)) r += 10;
  if (mv.contact && att.item !== 'Protective Pads') {
    if (def.item === 'Rocky Helmet') r += 100 / 6;
    if (def.ability === 'Rough Skin' || def.ability === 'Iron Barbs') r += 12.5;
  }
  if (mv.recoil && !CRASH_MOVES.has(hit.move) && att.ability !== 'Rock Head') {
    r += (hit.avgPct * def.stats[0]) / att.stats[0] * (hit.move === 'Head Smash' ? 0.5 : 1 / 3);
  }
  return r;
}

// 相手の HP が満タンのとき（first）と、減ったあと（later）の打点。マルチスケイルなどは満タンのときだけ効く
function hitPair(db, att, def, field, filter) {
  const first = bestHit(db, att, def, field, filter);
  const later = FULL_HP_GUARD.has(def.ability) ? bestHit(db, att, { ...def, hpPct: 99 }, field, filter) : first;
  return {
    first: { ...first, recoil: recoilPct(db, att, def, first) },
    later: { ...later, recoil: recoilPct(db, att, def, later) },
  };
}

// 攻撃の手段: いつもの技と、先制技（倒しきれるときに使う。ねこだましは除く）
function attackPlan(db, att, def, field) {
  const main = hitPair(db, att, def, field);
  const prio = hitPair(db, att, def, field, (name, mv) => mv.prio > 0 && name !== 'Fake Out');
  return { main, prio: prio.first.move ? prio : null };
}

// 交互に殴り合い、最後に立っている方と、その残りHPを返す。xFirst: 同じ優先度なら x が先に動く
function exchange(x, y, xFirst) {
  const hp = [100, 100];
  const plans = [x, y];
  let turn = 0;
  for (; turn < MAX_TURNS; turn++) {
    const acts = [];
    for (const i of [0, 1]) {
      if (turn === 0 && plans[i].skipFirst) continue;
      const { main, prio } = plans[i];
      const now = (pair) => (hp[1 - i] >= 100 ? pair.first : pair.later);
      // 先制技で倒しきれるなら、先制技を使う
      if (prio && now(prio).avgPct >= hp[1 - i]) acts.push({ i, pair: prio, pri: 1 });
      else acts.push({ i, pair: main, pri: 0 });
    }
    acts.sort((a, b) => b.pri - a.pri || (a.i === (xFirst ? 0 : 1) ? -1 : 1));
    for (const act of acts) {
      if (hp[act.i] <= 0) continue;
      const foe = 1 - act.i;
      // 先に動いた攻撃で HP が減っていれば、マルチスケイルは切れている
      const hit = hp[foe] >= 100 ? act.pair.first : act.pair.later;
      hp[foe] -= hit.avgPct;
      if (hit.avgPct > 0) hp[act.i] -= hit.recoil;
      if (hp[0] <= 0 || hp[1] <= 0) break;
    }
    if (hp[0] <= 0 || hp[1] <= 0) break;
  }
  return { hp, turns: turn + 1 };
}

const resultScore = ([hx, hy]) => {
  if (hx > 0 && hy <= 0) return 0.2 + 0.8 * Math.min(100, hx) / 100;
  if (hy > 0 && hx <= 0) return -(0.2 + 0.8 * Math.min(100, hy) / 100);
  return 0;
};

/**
 * a から見た対面の有利さ（-1〜1）。お互いに一番通る技で殴り合い、勝った方の残りHPが多いほど大きくする
 * （勝っても残りHPがわずかなら 0.2 に近く、無傷で勝てば 1）
 * @param opts 味方の支援 { tailwind, trickRoom, reflect, lightScreen, intimidate, fakeOut, redirect }
 *   tailwind: a のすばやさが 2 倍 / trickRoom: 遅い方が先に動く / reflect・lightScreen: a が受けるダメージが減る
 *   intimidate: b のこうげきが 1 段階下がる / fakeOut・redirect: b は 1 ターン目に a を攻撃できない
 */
export function duel(db, a, b, opts = {}) {
  // お互いの特性のいかく（場に出たときに相手に効く）
  const A = b.ability === 'Intimidate' ? intimidated(a) : a;
  const B = a.ability === 'Intimidate' || opts.intimidate ? intimidated(b) : b;
  const ha = attackPlan(db, A, B, {});
  const hb = { ...attackPlan(db, B, A, { reflect: opts.reflect, lightScreen: opts.lightScreen }), skipFirst: !!(opts.fakeOut || opts.redirect) };
  const sa = speedOf(a) * (opts.tailwind ? 2 : 1);
  const sb = speedOf(b);
  const aFirst = opts.trickRoom ? sa < sb : sa > sb;
  let score;
  let turns;
  if (sa === sb) {
    // 同速は、先に動く場合と後に動く場合の平均
    const r1 = exchange(ha, hb, true);
    const r2 = exchange(ha, hb, false);
    score = (resultScore(r1.hp) + resultScore(r2.hp)) / 2;
    turns = r1.turns;
  } else {
    const r = exchange(ha, hb, aFirst);
    score = resultScore(r.hp);
    turns = r.turns;
  }
  return { score, a: ha.main.first, b: hb.main.first, turns, speedA: sa, speedB: sb, aFirst };
}

// ---------- 味方の支援（ダブル） ----------

export const SUPPORT_LABEL = {
  tailwind: 'おいかぜ', trickRoom: 'トリックルーム', reflect: 'リフレクター', lightScreen: 'ひかりのかべ',
  intimidate: 'いかく', fakeOut: 'ねこだまし', redirect: 'このゆびとまれ・いかりのこな',
};

// 構築の誰かが使える支援。ダブルでは、味方の対面すべてに入れる（シングルでは入れない）
export function teamSupport(db, battlers) {
  if (!db.doubles) return {};
  const live = battlers.filter(Boolean);
  const has = (m) => live.some((b) => b.moves.includes(m));
  return {
    tailwind: has('Tailwind'),
    trickRoom: has('Trick Room'),
    reflect: has('Reflect') || has('Aurora Veil'),
    lightScreen: has('Light Screen') || has('Aurora Veil'),
    intimidate: live.some((b) => b.ability === 'Intimidate'),
    fakeOut: has('Fake Out'),
    // 攻撃を引きつけるので、ねこだましと同じく、相手は1ターン目に味方を攻撃できない
    redirect: has('Follow Me') || has('Rage Powder'),
  };
}

export const supportNames = (sup) => Object.keys(SUPPORT_LABEL).filter((k) => sup[k]).map((k) => SUPPORT_LABEL[k]);

// 支援を入れた対面。おいかぜとトリックルームは、その相手に有利な方を使う（使わない方がよければ使わない）
export function supportedDuel(db, a, b, sup = {}) {
  const { tailwind, trickRoom, ...rest } = sup;
  let best = duel(db, a, b, rest);
  for (const [on, key] of [[tailwind, 'tailwind'], [trickRoom, 'trickRoom']]) {
    if (!on) continue;
    const d = duel(db, a, b, { ...rest, [key]: true });
    if (d.score > best.score) best = d;
  }
  return best;
}

// ---------- タイプ相性 ----------

export function defenseTable(battlers) {
  return TYPES.map((type) => {
    const mults = battlers.map((b) => (b ? defenseProfile(b.types, b.ability)[type] : null));
    const live = mults.filter((m) => m != null);
    const weak = live.filter((m) => m > 1).length;
    const resist = live.filter((m) => m < 1).length;
    return { type, mults, weak, resist, danger: weak >= 2 && resist === 0 ? 2 : weak > resist ? 1 : 0 };
  });
}

// チームの攻撃技で、各タイプ（単タイプ）にばつぐんを取れるか
export function offenseTable(db, battlers) {
  return TYPES.map((type) => {
    let best = 0;
    const who = [];
    for (const b of battlers) {
      if (!b) continue;
      let mine = 0;
      for (const name of b.moves) {
        const mv = moveData(db, name);
        if (!isAttack(mv) || !mv.power) continue;
        mine = Math.max(mine, effectiveness(mv.type, [type]));
      }
      if (mine > 1) who.push(b.id);
      best = Math.max(best, mine);
    }
    return { type, best, who };
  });
}

// ---------- 環境への相性 ----------

// 上位 n 体のそれぞれに、チームの誰が勝てるか
// ダブルでは、構築の支援（おいかぜ・いかくなど）を入れて比べる
export function threatReport(db, battlers, n = 30) {
  const team = battlers.filter(Boolean);
  const sup = teamSupport(db, team);
  return topMeta(db, n).map((id) => {
    const foe = metaBattler(db, id);
    const duels = team.map((m) => ({ id: m.id, ...supportedDuel(db, m, foe, sup) }));
    const best = duels.length ? Math.max(...duels.map((d) => d.score)) : -1;
    const losing = duels.filter((d) => d.score < 0).length;
    return { id, pos: db.rankOf.get(id)?.pos, foe, duels, best, answers: duels.filter((d) => d.score > 0).length, losing };
  });
}

// ---------- 相方の提案 ----------

export function suggestTeammates(db, team, { pool = 100, threats = 40, limit = 15 } = {}) {
  const members = team.filter(Boolean).map((m) => memberBattler(db, m)).filter(Boolean);
  const inTeam = new Set(team.filter(Boolean).map((m) => db.dex[m.id]?.base));
  const threatIds = topMeta(db, threats);
  const foes = threatIds.map((id) => metaBattler(db, id));
  const sup = teamSupport(db, members);
  // いまのメンバーの、相手ごとの一番の有利さ（支援の組み合わせごとに覚えておく）
  const bestBySupport = new Map();
  const membersBest = (s) => {
    const k = JSON.stringify(s);
    if (!bestBySupport.has(k)) bestBySupport.set(k, foes.map((f) => (members.length ? Math.max(...members.map((m) => supportedDuel(db, m, f, s).score)) : -1)));
    return bestBySupport.get(k);
  };
  const teamBest = membersBest(sup);
  const def = defenseTable(members);
  const holes = def.filter((r) => r.weak > r.resist || r.danger).map((r) => r.type);

  const teammateScore = (id) => {
    let s = 0;
    const mine = usageOf(db, id).teammates;
    for (const m of members) {
      const i = mine.indexOf(m.id);
      if (i >= 0) s += (10 - i) / 10;
      const j = usageOf(db, m.id).teammates.indexOf(id);
      if (j >= 0) s += (10 - j) / 10;
    }
    return s;
  };

  // よく組まれる相手（どちらかの採用データの上位5体に、もう一方が入っている）
  const top5 = (id) => usageOf(db, id).teammates.slice(0, 5);
  const pairedWith = (id) => members
    .filter((m) => top5(id).includes(m.id) || top5(m.id).includes(id))
    .map((m) => m.id);

  const results = [];
  for (const id of topMeta(db, pool)) {
    if (inTeam.has(db.dex[id]?.base)) continue;
    // 構築に入れるときと同じ型（持ち物を重ねない・メガストーンは1体だけ）で比べる
    const c = memberBattler(db, defaultMember(db, id, team.filter(Boolean)));
    // 入れたあとの支援で、候補自身と、いまのメンバーの勝ち筋がどれだけ増えるか
    const after = teamSupport(db, [...members, c]);
    const mates = membersBest(after);
    let gain = 0;
    const newAnswers = [];
    foes.forEach((f, i) => {
      if (f.id === id) return;
      const s = Math.max(supportedDuel(db, c, f, after).score, mates[i]);
      const w = rankWeight(db.rankOf.get(f.id)?.pos);
      if (s > teamBest[i]) gain += (s - teamBest[i]) * w;
      if (s > 0 && teamBest[i] <= 0) newAnswers.push(f.id);
    });
    const prof = defenseProfile(c.types, c.ability);
    const covers = holes.filter((t) => prof[t] < 1);
    const adds = TYPES.filter((t) => prof[t] > 1 && !holes.includes(t) && def.find((r) => r.type === t)?.weak >= 2);
    const co = teammateScore(id);
    // 重み: 勝てる相手が増えること > 弱点の補完 > 一緒に使われる度合い・人気
    const score = gain * 1.5 + covers.length * 0.3 - adds.length * 0.3 + co * 0.15 + rankWeight(db.rankOf.get(id)?.pos) * 0.5;
    results.push({ id, battler: c, score, gain, newAnswers, covers, adds, co, paired: pairedWith(id) });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- 選出 ----------

function combinations(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) return void out.push(cur.slice());
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

// 相手の 6 体に対して、こちらの選出（ダブル 4 体・シングル 3 体）と先発を選ぶ
export function selectionPlan(db, team, opponentIds) {
  const mine = team.filter(Boolean).map((m) => memberBattler(db, m)).filter(Boolean);
  const foes = opponentIds.filter(Boolean).map((id) => metaBattler(db, id)).filter(Boolean);
  const pick = Math.min(mine.length, db.doubles ? 4 : 3);
  const matrix = mine.map((m) => foes.map((f) => duel(db, m, f)));
  if (!mine.length || !foes.length) return { matrix, mine, foes, plans: [] };

  const value = (idxs) => {
    let v = 0;
    foes.forEach((_, j) => {
      const scores = idxs.map((i) => matrix[i][j].score);
      v += Math.max(...scores) + 0.25 * (scores.reduce((a, b) => a + b, 0) / scores.length);
    });
    return v;
  };

  const plans = combinations([...mine.keys()], pick)
    .map((idxs) => {
      // 先発: ダブルは 2 体、シングルは 1 体
      const leadSize = db.doubles ? 2 : 1;
      const lead = combinations(idxs, leadSize).map((l) => [l, value(l)]).sort((a, b) => b[1] - a[1])[0][0];
      const uncovered = foes.filter((_, j) => Math.max(...idxs.map((i) => matrix[i][j].score)) <= 0).map((f) => f.id);
      return { members: idxs.map((i) => mine[i].id), lead: lead.map((i) => mine[i].id), value: value(idxs), uncovered };
    })
    .sort((a, b) => b.value - a.value);
  return { matrix, mine, foes, plans: plans.slice(0, 3) };
}

// ---------- 環境の傾向 ----------

// 能力を下げるために使う技（ダメージは小さい）
const UTILITY_ATTACKS = new Set(['Icy Wind', 'Snarl', 'Electroweb']);
const WEATHER_BALL_TYPE = { Drought: 'Fire', Drizzle: 'Water', 'Sand Stream': 'Rock', 'Snow Warning': 'Ice' };
// 威力（連続技は回数をかけたもの）がこれより低い技は、攻撃技のタイプの傾向に数えない（ねこだましなど）
export const TREND_MIN_POWER = 50;

// 攻撃技のタイプの傾向に数えるときのタイプ（数えないなら null）
export function trendAttackType(mv, name, b) {
  if (!isAttack(mv) || UTILITY_ATTACKS.has(name)) return null;
  if (name === 'Weather Ball') return WEATHER_BALL_TYPE[b.ability] ?? null;
  // おはかまいりは、倒れた味方の数で威力が上がる
  const power = name === 'Last Respects' ? 100 : (mv.power ?? 0) * (Array.isArray(mv.multihit) ? 3 : mv.multihit ?? 1);
  return power >= TREND_MIN_POWER ? mv.type : null;
}

// 攻撃のタイプごとに、上位 n 体のうち弱点（×2 以上）になる数と、半減以下（無効を含む）になる数。通りやすい順
export function typeReach(db, n) {
  const foes = topMeta(db, n).map((id) => metaBattler(db, id));
  return TYPES.map((type) => {
    let weak = 0;
    let resist = 0;
    for (const f of foes) {
      const m = defenseProfile(f.types, f.ability)[type];
      if (m > 1) weak++;
      else if (m < 1) resist++;
    }
    return { type, weak, resist };
  }).sort((a, b) => (b.weak - b.resist) - (a.weak - a.resist) || b.weak - a.weak);
}

// ---------- すばやさ ----------

export function speedList(db, battlers, n = 40) {
  const rows = battlers.filter(Boolean).map((b) => ({ id: b.id, title: b.title, mine: true, speed: speedOf(b), scarf: b.item === 'Choice Scarf' }));
  for (const id of topMeta(db, n)) {
    const b = metaBattler(db, id);
    rows.push({ id, title: b.title, mine: false, speed: speedOf(b), scarf: b.item === 'Choice Scarf', pos: db.rankOf.get(id)?.pos });
  }
  return rows.sort((a, b) => b.speed - a.speed);
}
