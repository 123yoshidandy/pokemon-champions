// 構築の分析（相性・対面・相方の提案・選出）
// どれも「よく使われている型どうしで、どちらが先に倒せるか」を土台にしている
import { TYPES, defenseProfile, effectiveness } from './types.js';
import { moveData, isAttack, usageOf, isMegaStone } from './data.js';
import { calcDamage } from './damage.js';
import { defaultMember, memberBattler, megaStoneShare, MEGA_ONLY_SHARE } from './team.js';
import { SP_TOTAL, SP_MAX } from './stats.js';

// ---------- 対戦する形 ----------

const metaCache = new WeakMap();

// 環境のポケモンの、一番よく使われている型
export function metaBattler(db, id) {
  let byDb = metaCache.get(db);
  if (!byDb) metaCache.set(db, (byDb = new Map()));
  if (!byDb.has(id)) {
    const m = defaultMember(db, id);
    // 環境の型では、攻撃技を優先して 4 つ選ぶ（補助技ばかりだと打点が出ないため）
    // こだわりアイテムなどで、すでに攻撃技だけにしてあるときは、そのまま
    if (m.moves.some((n) => n && !isAttack(moveData(db, n)))) {
      const u = usageOf(db, id);
      const attacks = u.moves.filter(([n]) => isAttack(moveData(db, n))).map(([n]) => n);
      const others = u.moves.map(([n]) => n).filter((n) => !attacks.includes(n));
      m.moves = [...attacks.slice(0, 3), ...others, ...attacks.slice(3)].slice(0, 4);
    }
    byDb.set(id, memberBattler(db, m));
  }
  return byDb.get(id);
}

export function topMeta(db, n) {
  return db.ranking.slice(0, n).map((r) => r.id).filter((id) => db.dex[id]);
}

export const rankWeight = (pos) => 1 / Math.sqrt(pos || 50);

// ---------- 打点 ----------

// 1 ターン目にためて、2 ターン目に攻撃する技
const CHARGE_MOVES = new Set(['Solar Beam', 'Solar Blade', 'Meteor Beam', 'Sky Attack', 'Skull Bash', 'Razor Wind', 'Freeze Shock', 'Ice Burn', 'Electro Shot']);
// 場に出ると天気を変える特性
export const WEATHER_ABILITY = { Drought: 'sun', Drizzle: 'rain', 'Sand Stream': 'sand', 'Snow Warning': 'snow', 'Orichalcum Pulse': 'sun' };
// 技が固定される持ち物
const isChoice = (b) => ['Choice Scarf', 'Choice Band', 'Choice Specs'].includes(b.item);

const NO_HIT = { move: null, avgPct: 0, minPct: 0, maxPct: 0, ko: { n: Infinity, chance: 0 }, eff: 0 };

// 一番通る技（命中も考えた平均ダメージ%で比べる）。filter で候補の技を絞れる
export function bestHit(db, att, def, field = {}, filter = null) {
  let best = null;
  for (const name of att.moves) {
    const mv = moveData(db, name);
    if (!isAttack(mv) || (filter && !filter(name, mv))) continue;
    const r = calcDamage(att, def, { name, ...mv }, { doubles: db.doubles, ...field });
    let avg = ((r.minPct + r.maxPct) / 2) * ((mv.acc ?? 100) / 100);
    // ため技は、はれ（ソーラー技）かパワフルハーブでなければ、2 ターンに 1 回しか当たらない
    if (CHARGE_MOVES.has(name) && att.item !== 'Power Herb' && !(field.weather === 'sun' && name.startsWith('Solar'))) avg /= 2;
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
  // こだわりアイテムでは、最初に選んだ技のまま
  const laterFilter = isChoice(att) ? (name) => name === first.move : filter;
  const later = FULL_HP_GUARD.has(def.ability) ? bestHit(db, att, { ...def, hpPct: 99 }, field, laterFilter) : first;
  return {
    first: { ...first, recoil: recoilPct(db, att, def, first) },
    later: { ...later, recoil: recoilPct(db, att, def, later) },
  };
}

// 攻撃の手段: いつもの技と、先制技（倒しきれるときに使う。ねこだましは除く）
function attackPlan(db, att, def, field) {
  const main = hitPair(db, att, def, field);
  // こだわりアイテムでは、途中で先制技に切り替えられない
  if (isChoice(att)) return { main, prio: null };
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
  // 片方だけが天気を変える特性なら、その天気で戦う（両方なら、どちらになるかわからないので入れない）
  const wa = WEATHER_ABILITY[a.ability];
  const wb = WEATHER_ABILITY[b.ability];
  const weather = wa && wb ? null : wa ?? wb ?? null;
  const ha = attackPlan(db, A, B, { weather });
  const hb = { ...attackPlan(db, B, A, { weather, reflect: opts.reflect, lightScreen: opts.lightScreen }), skipFirst: !!(opts.fakeOut || opts.redirect) };
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

// ---------- 天気とフィールド（構築の中でぶつからないように） ----------

// 場に出るとフィールドを張る特性
export const TERRAIN_ABILITY = { 'Grassy Surge': 'grassy', 'Electric Surge': 'electric', 'Psychic Surge': 'psychic', 'Misty Surge': 'misty', 'Hadron Engine': 'electric' };
export const WEATHER_JA = { sun: 'はれ', rain: 'あめ', sand: 'すなあらし', snow: 'ゆき', any: '天気' };
// 天気に頼る特性・技（any は、どの天気でもよい）
const NEEDS_WEATHER_ABILITY = { Chlorophyll: 'sun', 'Solar Power': 'sun', 'Flower Gift': 'sun', 'Swift Swim': 'rain', 'Rain Dish': 'rain', 'Sand Rush': 'sand', 'Sand Force': 'sand', 'Slush Rush': 'snow', 'Ice Body': 'snow' };
const NEEDS_WEATHER_MOVE = { 'Solar Beam': 'sun', 'Solar Blade': 'sun', 'Aurora Veil': 'snow', 'Weather Ball': 'any' };

// 構築の天気・フィールドを起こすポケモンの、天気とフィールドの一覧（メガシンカ後の特性も見る）
export function fieldSetters(battlers) {
  const live = battlers.filter(Boolean);
  return {
    weathers: [...new Set(live.map((b) => WEATHER_ABILITY[b.ability]).filter(Boolean))],
    terrains: [...new Set(live.map((b) => TERRAIN_ABILITY[b.ability]).filter(Boolean))],
  };
}

// 違う天気どうし、違うフィールドどうしが、同じ構築にいるか
export function fieldClash(battlers) {
  const f = fieldSetters(battlers);
  return f.weathers.length > 1 || f.terrains.length > 1;
}

// 天気に頼るのに、構築の天気と合わないメンバー [{ id, need, why }]
export function weatherMisfits(battlers) {
  const live = battlers.filter(Boolean);
  const have = fieldSetters(live).weathers;
  const out = [];
  for (const b of live) {
    let need = NEEDS_WEATHER_ABILITY[b.ability];
    let why = b.ability;
    // こだいかっせいは、ブーストエナジーがなければ、はれに頼る
    if (b.ability === 'Protosynthesis' && b.item !== 'Booster Energy') [need, why] = ['sun', b.ability];
    if (!need) {
      const m = b.moves.find((x) => NEEDS_WEATHER_MOVE[x]);
      if (m) [need, why] = [NEEDS_WEATHER_MOVE[m], m];
    }
    if (!need) continue;
    const ok = need === 'any' ? have.length > 0 : have.includes(need);
    if (!ok) out.push({ id: b.id, need, why });
  }
  return out;
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
// ねこだまし・このゆびとまれ（相手が1ターン目に動けない）は、1試合に1回・味方と並んだときだけなので、対面には入れない
// （すべての対面に入れると、1発で倒される相手にも有利と出てしまう）
export function supportedDuel(db, a, b, sup = {}) {
  const { tailwind, trickRoom, fakeOut, redirect, ...rest } = sup;
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
    const cm = defaultMember(db, id, team.filter(Boolean));
    // いまの構築の天気・フィールドとぶつかる起こし役は出さない
    if (fieldClash([...members, memberBattler(db, cm)])) continue;
    // メガシンカの型でしか使われていない種族は、メガストーンを持てないなら出さない（メガシンカバトルは除く）
    if (!db.megaRule && !isMegaStone(db, id, cm.item) && megaStoneShare(db, id) >= MEGA_ONLY_SHARE) continue;
    const c = memberBattler(db, cm);
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
    // 天気が合わない候補は減点する
    const misfit = weatherMisfits([...members, c]).some((x) => x.id === id);
    const score = gain * 1.5 + covers.length * 0.3 - adds.length * 0.3 + co * 0.15 + rankWeight(db.rankOf.get(id)?.pos) * 0.5 - (misfit ? 0.5 : 0);
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

// ---------- 基本選出と戦い方 ----------

const WEATHER_SETTERS = { Drought: 'はれ', Drizzle: 'あめ', 'Sand Stream': 'すなあらし', 'Snow Warning': 'ゆき' };
const TERRAIN_SETTERS = { 'Grassy Surge': 'グラスフィールド', 'Electric Surge': 'エレキフィールド', 'Psychic Surge': 'サイコフィールド', 'Misty Surge': 'ミストフィールド' };
const SETUP = new Set(['Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind', 'Quiver Dance', 'Shell Smash', 'Bulk Up', 'Belly Drum', 'Coaching', 'Victory Dance', 'Tidy Up']);
// 終盤に強くなる特性・技
const LATE_ABILITIES = { 'Supreme Overlord': '倒れた味方が多いほど強くなる', Moxie: '倒すたびにこうげきが上がる', 'Beast Boost': '倒すたびに能力が上がる' };

// 先発に場を作る役がいるときの重み
const ROLE_WEIGHT = { tailwind: 0.6, trickRoom: 0.6, weather: 0.3, terrain: 0.2, redirect: 0.3, fakeOut: 0.25, screens: 0.2, intimidate: 0.1 };
// 後発にいるときの役目
const BACK_ROLE = { tailwind: 'おいかぜを張り直して、味方を先に動かす', trickRoom: 'トリックルームを張り直す', redirect: '攻撃を引きつけて、味方を守る', fakeOut: 'ねこだましで隙を作り直す', intimidate: 'いかくを入れ直しながら、相手の物理を受ける', screens: '壁を張り直す' };

// 場を作る役（先発に向く）。強いものから順に
function leadRoles(b) {
  const r = [];
  const has = (m) => b.moves.includes(m);
  if (has('Tailwind')) r.push({ key: 'tailwind', move: 'Tailwind', text: 'おいかぜで先に動き' });
  if (has('Trick Room')) r.push({ key: 'trickRoom', move: 'Trick Room', text: 'トリックルームで遅い方から動き' });
  if (WEATHER_SETTERS[b.ability]) r.push({ key: 'weather', text: `${WEATHER_SETTERS[b.ability]}にして` });
  if (TERRAIN_SETTERS[b.ability]) r.push({ key: 'terrain', text: `${TERRAIN_SETTERS[b.ability]}を張り` });
  if (has('Follow Me') || has('Rage Powder')) r.push({ key: 'redirect', move: has('Follow Me') ? 'Follow Me' : 'Rage Powder', text: '攻撃を引きつけ' });
  if (has('Fake Out')) r.push({ key: 'fakeOut', move: 'Fake Out', text: 'ねこだましで隙を作り' });
  if (has('Reflect') || has('Light Screen') || has('Aurora Veil')) r.push({ key: 'screens', text: '壁を張り' });
  if (b.ability === 'Intimidate') r.push({ key: 'intimidate', text: 'いかくで相手の物理を弱め' });
  return r;
}

// 一番の攻撃技（ダブルでは全体技を少し優先する）
function mainAttack(db, b) {
  let best = null;
  for (const name of b.moves) {
    const mv = moveData(db, name);
    if (!isAttack(mv) || !mv.power) continue;
    const spread = db.doubles && ['allAdjacentFoes', 'allAdjacent'].includes(mv.target);
    const stab = b.types.includes(mv.type) ? 1.5 : 1;
    const v = mv.power * stab * (spread ? 1.2 : 1) * (Array.isArray(mv.multihit) ? 3 : mv.multihit ?? 1);
    if (!best || v > best.v) best = { name, v, spread };
  }
  return best;
}

// 後発の役目（終盤に強い・積む・入れ替えながら戦う）
function backRole(db, b, jaMoveName) {
  const lr = leadRoles(b).find((x) => BACK_ROLE[x.key]);
  if (lr && (lr.key === 'tailwind' || lr.key === 'trickRoom')) return BACK_ROLE[lr.key];
  if (b.moves.includes('Last Respects')) return `${jaMoveName('Last Respects')}で、倒れた味方が多い終盤に押し切る`;
  if (LATE_ABILITIES[b.ability]) return `${LATE_ABILITIES[b.ability]}ので、終盤に押し切る`;
  const setup = b.moves.find((m) => SETUP.has(m));
  if (setup) return `${jaMoveName(setup)}で積んで、終盤に押し切る`;
  if (lr) return BACK_ROLE[lr.key];
  if (b.item === 'Choice Scarf') return 'こだわりスカーフで、弱った相手を上から倒す';
  return null;
}

/**
 * 構築の基本選出（環境の上位 n 体を相手に、一番勝ち筋が多い選び方）と、先発・後発の戦い方
 * @param jaMoveName 技の日本語名（文を組み立てるのに使う）
 * @returns { members, lead, back, plan: [文], answers: 有利な相手の数, n }
 */
export function basicPlan(db, battlers, jaMoveName = (m) => m, { n = 30 } = {}) {
  const mine = battlers.filter(Boolean);
  const pick = Math.min(mine.length, db.doubles ? 4 : 3);
  if (!pick) return null;
  const foes = topMeta(db, n).map((id) => metaBattler(db, id));
  const weights = foes.map((f) => rankWeight(db.rankOf.get(f.id)?.pos));
  const cache = new Map();
  const score = (b, j, sup) => {
    const k = `${b.id}|${j}|${JSON.stringify(sup)}`;
    if (!cache.has(k)) cache.set(k, supportedDuel(db, b, foes[j], sup).score);
    return cache.get(k);
  };
  // 選んだメンバーで、相手ごとに一番有利な対面の重み付きの和（支援は supIdxs のメンバーのもの）
  const value = (idxs, supIdxs = idxs) => {
    const sup = teamSupport(db, supIdxs.map((i) => mine[i]));
    let v = 0;
    let answers = 0;
    foes.forEach((f, j) => {
      const best = Math.max(...idxs.map((i) => (mine[i].id === f.id ? -1 : score(mine[i], j, sup))));
      v += weights[j] * best;
      if (best > 0) answers++;
    });
    return { v, answers };
  };
  let best = null;
  for (const idxs of combinations([...mine.keys()], pick)) {
    const r = value(idxs);
    if (!best || r.v > best.v) best = { idxs, ...r };
  }
  const chosen = best.idxs.map((i) => mine[i]);

  // 先発: 場を作る役 + その場で一番勝ち筋が増える攻め手（シングルは、一番勝ち筋が多い 1 体）
  let lead;
  if (db.doubles && chosen.length >= 2) {
    // 場を作る役の重みが一番大きいメンバーを先発に入れ（すばやさを変える役を一番重く）、相方は 2 体の点が一番高いもの
    const roleW = (x) => Math.max(0, ...leadRoles(x).map((r) => ROLE_WEIGHT[r.key] ?? 0.05));
    const first = chosen.slice().sort((x, y) => roleW(y) - roleW(x))[0];
    const pairs = combinations([...chosen.keys()], 2)
      .map((p) => p.map((i) => chosen[i]))
      .filter((pair) => !roleW(first) || pair.includes(first))
      // 相方は、先発の役の支援だけを入れて比べる（相方自身の支援で点を稼がないように）
      .map((pair) => ({ pair, v: value(pair.map((x) => mine.indexOf(x)), roleW(first) ? [mine.indexOf(first)] : undefined).v }))
      .sort((x, y) => y.v - x.v);
    lead = pairs[0].pair;
  } else {
    lead = [chosen.map((b) => ({ b, v: value([mine.indexOf(b)]).v })).sort((a, b) => b.v - a.v)[0].b];
  }
  const back = chosen.filter((b) => !lead.includes(b));

  // 戦い方の文
  const plan = [];
  // 攻撃の強さ（一番の技の威力 × こうげき・とくこうの高い方）
  const strength = (b) => (mainAttack(db, b)?.v ?? 0) * Math.max(b.stats[1], b.stats[3]);
  // 場を作る役は、役を持つ中で攻撃が一番弱いもの。攻め手は、残りで一番強いもの
  const setter = lead.map((b) => ({ b, roles: leadRoles(b) })).filter((x) => x.roles.length).sort((x, y) => strength(x.b) - strength(y.b))[0];
  const others = lead.filter((b) => b !== setter?.b);
  const atkB = (others.length ? others : lead).slice().sort((x, y) => strength(y) - strength(x))[0];
  const atk = mainAttack(db, atkB) ? { b: atkB, m: mainAttack(db, atkB) } : null;
  const how = setter ? `${setter.b.name}の${setter.roles[0].text}、` : '';
  if (atk) plan.push(`先発: ${how}${atk.b.name}の${atk.m.spread ? '全体技' : ''}${jaMoveName(atk.m.name)}で攻める`);
  else plan.push(`先発: ${lead.map((b) => b.name).join('・')}`);
  for (const b of back) {
    const role = backRole(db, b, jaMoveName);
    const m = mainAttack(db, b);
    plan.push(`後発: ${b.name}${role ? `は、${role}` : m ? `は、${jaMoveName(m.name)}で残った相手を倒す` : ''}`);
  }
  return { members: chosen, lead, back, plan, answers: best.answers, n };
}

// ---------- 耐久調整 ----------

/**
 * 上位 n 体のよく使われる型の攻撃技のうち、いまの配分だと1発で倒されうる技について、
 * HP と ぼうぎょ（物理）・とくぼう（特殊）を振り直して、確定で耐える一番少ない配分を探す。
 * こうげき・とくこう・すばやさのポイントと性格はそのまま。残りのポイントでまかなえないものは「届かない」とする
 * @returns [{ foe, move, before: {minPct, maxPct}, sp, cost, reachable }]（相手の順位の順）
 */
export function bulkPlans(db, member, { n = 30 } = {}) {
  const me = memberBattler(db, member);
  if (!me) return [];
  const free = SP_TOTAL - member.sp[1] - member.sp[3] - member.sp[5];
  const plans = [];
  for (const fid of topMeta(db, n)) {
    if (fid === member.id) continue;
    const foe = metaBattler(db, fid);
    for (const name of foe.moves) {
      const mv = moveData(db, name);
      if (!isAttack(mv) || !mv.power) continue;
      const move = { name, ...mv };
      const field = { doubles: db.doubles };
      const now = calcDamage(foe, me, move, field);
      if (now.max < now.hp) continue;
      // 物理は B、特殊は D（サイコショックなどは B）。HP と合わせて、合計の少ない順に探す
      const di = mv.cat === 'Physical' || ['Psyshock', 'Psystrike', 'Secret Sword'].includes(name) ? 2 : 4;
      let best = null;
      for (let total = 0; total <= 2 * SP_MAX && !best; total++) {
        for (let hp = Math.min(SP_MAX, total); hp >= Math.max(0, total - SP_MAX); hp--) {
          const sp = member.sp.slice();
          sp[0] = hp;
          sp[di] = total - hp;
          // もう片方の耐久は、残りのポイントの範囲で、いまの値を残す
          const other = di === 2 ? 4 : 2;
          sp[other] = Math.max(0, Math.min(member.sp[other], free - total));
          const r = calcDamage(foe, memberBattler(db, { ...member, sp }), move, field);
          if (r.max < r.hp) {
            best = { sp, cost: total };
            break;
          }
        }
      }
      if (best) plans.push({ foe: fid, move: name, before: { minPct: now.minPct, maxPct: now.maxPct }, sp: best.sp, cost: best.cost, reachable: best.cost <= free });
    }
  }
  return plans;
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
