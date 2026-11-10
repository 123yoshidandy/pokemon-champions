// 構築どうしの対戦のシミュレーション（ダブル・シングル）
// 選出から、ターンを追って戦わせる。乱数はシード付きで、同じシードなら同じ結果になる。
// 行動は簡単な規則で選ぶ（倒せる相手を狙う・場を作る技は一度だけ・危ないときにまもる など）
import { calcDamage } from './damage.js';
import { moveData, isAttack } from './data.js';
import { memberBattler } from './team.js';
import { rankMod } from './stats.js';
import { effectivenessWithAbility } from './types.js';
import { selectionPlan } from './analysis.js';

// ---------- 乱数 ----------

// シード付きの乱数（mulberry32）。0 以上 1 未満を返す関数
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 技と持ち物の表 ----------

const PROTECT = new Set(['Protect', 'Detect', "King's Shield", 'Spiky Shield', 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark', 'Obstruct']);
const REDIRECT = new Set(['Follow Me', 'Rage Powder']);
const SPREAD = new Set(['allAdjacentFoes', 'allAdjacent']);
const CHOICE = new Set(['Choice Scarf', 'Choice Band', 'Choice Specs']);
// ため技（はれ・あめならためない技）
// 撃った次のターンは動けない技（はかいこうせんなど）
const RECHARGE = new Set(['Hyper Beam', 'Giga Impact', 'Blast Burn', 'Frenzy Plant', 'Hydro Cannon', 'Rock Wrecker', 'Roar of Time', 'Prismatic Laser', 'Eternabeam', 'Meteor Assault']);
// 1 回ごとに命中を判定し、外れたところで止まる連続技
const MULTI_ACC = new Set(['Population Bomb', 'Triple Axel', 'Triple Kick']);

// 1 回ごとに命中を判定する連続技の、当たった回数（スキルリンクは全部当たる）
function rollHits(st, m, mv, max) {
  if (m.b.ability === 'Skill Link' || mv.acc == null) return max;
  let n = 0;
  while (n < max && st.r() * 100 < mv.acc * (m.item === 'Wide Lens' ? 1.1 : 1)) n++;
  return n;
}
// その平均（行動を選ぶとき）
const expectedHits = (mv, max) => { let e = 0; let p = 1; for (let k = 0; k < max; k++) { p *= Math.min(1, (mv.acc ?? 100) / 100); e += p; } return e; };

const CHARGE = { 'Solar Beam': 'sun', 'Solar Blade': 'sun', 'Electro Shot': 'rain', 'Meteor Beam': null, 'Sky Attack': null };
// 相手の能力を必ず下げる技 [能力, 段階]
const FOE_DROP = {
  'Icy Wind': ['spe', -1], Electroweb: ['spe', -1], Bulldoze: ['spe', -1], 'Rock Tomb': ['spe', -1], 'Low Sweep': ['spe', -1],
  Snarl: ['spa', -1], 'Struggle Bug': ['spa', -1], 'Mystical Fire': ['spa', -1], 'Breaking Swipe': ['atk', -1], Lunge: ['atk', -1],
};
// 自分の能力が下がる技
const SELF_DROP = {
  'Draco Meteor': { spa: -2 }, Overheat: { spa: -2 }, 'Leaf Storm': { spa: -2 }, 'Fleur Cannon': { spa: -2 }, 'Make It Rain': { spa: -1 },
  'Close Combat': { def: -1, spd: -1 }, 'Headlong Rush': { def: -1, spd: -1 }, 'Armor Cannon': { def: -1, spd: -1 }, Superpower: { atk: -1, def: -1 },
};
// 効果ばつぐんの技を一度だけ半分にする実
const RESIST_BERRY = {
  'Occa Berry': 'Fire', 'Passho Berry': 'Water', 'Wacan Berry': 'Electric', 'Rindo Berry': 'Grass', 'Yache Berry': 'Ice', 'Chople Berry': 'Fighting',
  'Kebia Berry': 'Poison', 'Shuca Berry': 'Ground', 'Coba Berry': 'Flying', 'Payapa Berry': 'Psychic', 'Tanga Berry': 'Bug', 'Charti Berry': 'Rock',
  'Kasib Berry': 'Ghost', 'Haban Berry': 'Dragon', 'Colbur Berry': 'Dark', 'Babiri Berry': 'Steel', 'Roseli Berry': 'Fairy',
};
const WEATHER_SET = { Drought: 'sun', Drizzle: 'rain', 'Sand Stream': 'sand', 'Snow Warning': 'snow', 'Orichalcum Pulse': 'sun' };
const TERRAIN_SET = { 'Grassy Surge': 'grassy', 'Electric Surge': 'electric', 'Psychic Surge': 'psychic', 'Misty Surge': 'misty', 'Hadron Engine': 'electric' };
const SPEED_WEATHER = { 'Swift Swim': 'rain', Chlorophyll: 'sun', 'Sand Rush': 'sand', 'Slush Rush': 'snow' };
const INTIMIDATE_IMMUNE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Mirror Armor', 'Guard Dog']);
const DROP_IMMUNE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Mirror Armor']);
const MAX_TURNS = 40;

// 能力を上げる技（積み技）
const SETUP = {
  'Swords Dance': { atk: 2 }, 'Nasty Plot': { spa: 2 }, 'Calm Mind': { spa: 1, spd: 1 }, 'Dragon Dance': { atk: 1, spe: 1 },
  'Bulk Up': { atk: 1, def: 1 }, 'Quiver Dance': { spa: 1, spd: 1, spe: 1 }, 'Shell Smash': { atk: 2, spa: 2, spe: 2, def: -1, spd: -1 },
  'Victory Dance': { atk: 1, def: 1, spe: 1 }, 'Coil': { atk: 1, def: 1 }, 'Iron Defense': { def: 2 }, 'Agility': { spe: 2 },
  'Tidy Up': { atk: 1, spe: 1 }, 'Shift Gear': { atk: 1, spe: 2 }, 'Growth': { atk: 1, spa: 1 }, 'Work Up': { atk: 1, spa: 1 },
};
// 眠らせる技（あくびは、次のターンの終わりに眠る）
const SLEEP = new Set(['Spore', 'Sleep Powder', 'Hypnosis', 'Sing', 'Dark Void', 'Yawn']);
const POWDER = new Set(['Spore', 'Sleep Powder']);
// HP を半分回復する技
const RECOVER = new Set(['Recover', 'Roost', 'Slack Off', 'Soft-Boiled', 'Moonlight', 'Morning Sun', 'Synthesis', 'Milk Drink', 'Shore Up', 'Strength Sap', 'Life Dew']);
// 天気で強くなる技（にほんばれ・あまごいを使うかの目安）
const WEATHER_USE = { 'Solar Beam': 'sun', 'Solar Blade': 'sun', 'Weather Ball': null, 'Heat Wave': 'sun', Flamethrower: 'sun', 'Fire Blast': 'sun', 'Hydro Pump': 'rain', Surf: 'rain', 'Muddy Water': 'rain', Thunder: 'rain', Hurricane: 'rain' };
const WEATHER_MOVE = { 'Sunny Day': 'sun', 'Rain Dance': 'rain', Sandstorm: 'sand', 'Snowscape': 'snow' };

// ---------- 場の状態 ----------

function makeMon(db, member, side) {
  const b = memberBattler(db, member);
  return {
    id: member.id, name: b.name, b, side,
    hp: b.stats[0], max: b.stats[0], item: b.item,
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    lock: null, charging: null, protectStreak: 0, turnsOut: 0, fainted: false,
    // 状態異常（slp・brn・par）と、ねむりの残りターン、あくび、ちょうはつの残りターン
    status: null, sleep: 0, yawn: 0, taunt: 0, recharge: false,
  };
}

// ダメージ計算に渡す形
const view = (m) => ({ ...m.b, item: m.item, boosts: m.boosts, status: m.status, hpPct: (m.hp / m.max) * 100 });

function newBattle(db, teams, picks, seed) {
  const doubles = db.doubles;
  const r = rng(seed);
  const sides = teams.map((team, s) => {
    const mons = picks[s].map((id) => makeMon(db, team.find((m) => m.id === id), s));
    const n = doubles ? 2 : 1;
    return { mons, active: mons.slice(0, n), reserve: mons.slice(n), tailwind: 0, reflect: 0, lightScreen: 0, veil: 0, fainted: 0 };
  });
  const st = { db, doubles, r, sides, weather: null, weatherTurns: 0, terrain: null, terrainTurns: 0, trickRoom: 0, turn: 0, log: [] };
  const first = sides.flatMap((s) => s.active).map((m) => ({ m, k: r() }));
  first.sort((a, b) => speedOf(st, b.m) - speedOf(st, a.m) || a.k - b.k);
  for (const { m } of first) enter(st, m);
  return st;
}

const foeSide = (st, m) => st.sides[1 - m.side];
const aliveActive = (side) => side.active.filter((m) => m && !m.fainted);
const partnerOf = (st, m) => st.sides[m.side].active.find((x) => x && x !== m && !x.fainted) ?? null;

// 場に出たときの特性（いかく・天気・フィールド）
function enter(st, m) {
  m.turnsOut = 0;
  m.lock = null;
  m.charging = null;
  m.recharge = false;
  m.protectStreak = 0;
  m.taunt = 0;
  m.yawn = 0;
  m.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const ab = m.b.ability;
  if (ab === 'Intimidate') {
    for (const f of aliveActive(foeSide(st, m))) {
      if (INTIMIDATE_IMMUNE.has(f.b.ability)) continue;
      boost(f, 'atk', -1);
      if (f.b.ability === 'Defiant') boost(f, 'atk', 2);
      if (f.b.ability === 'Competitive') boost(f, 'spa', 2);
    }
  }
  if (WEATHER_SET[ab]) { st.weather = WEATHER_SET[ab]; st.weatherTurns = 5; }
  if (TERRAIN_SET[ab]) { st.terrain = TERRAIN_SET[ab]; st.terrainTurns = 5; }
}

const boost = (m, stat, n) => { m.boosts[stat] = Math.max(-6, Math.min(6, m.boosts[stat] + n)); };

// ---------- すばやさと順番 ----------

export function speedOf(st, m) {
  let s = Math.floor(m.b.stats[5] * rankMod(m.boosts.spe));
  if (m.item === 'Choice Scarf') s = Math.floor(s * 1.5);
  if (st.sides[m.side].tailwind > 0) s *= 2;
  if (SPEED_WEATHER[m.b.ability] && SPEED_WEATHER[m.b.ability] === st.weather) s *= 2;
  if (m.status === 'par') s = Math.floor(s / 2);
  return s;
}

function priorityOf(st, m, act) {
  if (act.type === 'switch') return 7;
  const mv = moveData(st.db, act.move);
  let p = mv?.prio ?? 0;
  if (m.b.ability === 'Prankster' && mv?.cat === 'Status') p += 1;
  if (act.move === 'Grassy Glide' && st.terrain === 'grassy') p += 1;
  return p;
}

// ---------- ダメージ ----------

function fieldFor(st, att, def, spread, crit = false, helpingHand = false) {
  const ds = st.sides[def.side];
  return {
    doubles: st.doubles, weather: st.weather, terrain: st.terrain, crit, spread,
    helpingHand, reflect: ds.reflect > 0 || ds.veil > 0, lightScreen: ds.lightScreen > 0 || ds.veil > 0,
  };
}

// 威力が場で変わる技（おはかまいり・そうだいしょう）
function moveFor(st, att, name) {
  const mv = { name, ...moveData(st.db, name) };
  const fallen = st.sides[att.side].fainted;
  if (name === 'Last Respects') mv.power = 50 + 50 * fallen;
  if (att.b.ability === 'Supreme Overlord' && fallen && mv.power) mv.power = Math.floor(mv.power * (1 + 0.1 * Math.min(5, fallen)));
  return mv;
}

// 見込みのダメージ（平均・命中込み）。行動を選ぶのに使う
function expected(st, att, def, name, spread) {
  const mv = moveFor(st, att, name);
  const r = calcDamage(view(att), view(def), mv, fieldFor(st, att, def, spread));
  let avg = r.rolls.reduce((a, b) => a + b, 0) / r.rolls.length;
  avg *= (mv.acc ?? 100) / 100;
  if (name in CHARGE && !(CHARGE[name] && CHARGE[name] === st.weather) && att.item !== 'Power Herb') avg /= 2;
  // 1 回ごとに命中を判定する連続技は、当たる回数の平均で数える（上でかけた命中は、回数の平均に入っているので外す）
  if (MULTI_ACC.has(name) && att.b.ability !== 'Skill Link') avg = (avg / r.hits) * expectedHits(mv, r.hits) / ((mv.acc ?? 100) / 100);
  // 撃った次のターンは動けないので、2 ターンに 1 回とみなす
  if (RECHARGE.has(name)) avg /= 2;
  return { avg, max: r.max };
}

// ---------- 行動の選び方 ----------

const hasMove = (m, name) => m.b.moves.includes(name);
const usable = (m, name) => !m.lock || m.lock === name;

function threatened(st, m) {
  for (const f of aliveActive(foeSide(st, m))) {
    for (const name of f.b.moves) {
      if (!isAttack(moveData(st.db, name)) || !usable(f, name)) continue;
      if (expected(st, f, m, name, false).max >= m.hp) return true;
    }
  }
  return false;
}

// 攻撃の候補（技と相手）と、その値打ち（相手のHPに対する%。倒せるなら上乗せ）
function attackOptions(st, m) {
  const foes = aliveActive(foeSide(st, m));
  const ally = partnerOf(st, m);
  const out = [];
  for (const name of m.b.moves) {
    const mv = moveData(st.db, name);
    if (!isAttack(mv) || !usable(m, name)) continue;
    if (name === 'Fake Out' && m.turnsOut > 0) continue;
    const value = (d, f) => (Math.min(d.avg, f.hp) / f.max) * 100 + (d.avg >= f.hp ? 40 : 0);
    if (st.doubles && SPREAD.has(mv.target)) {
      const targets = [...foes, ...(mv.target === 'allAdjacent' && ally ? [ally] : [])];
      const spread = targets.length > 1;
      let v = 0;
      for (const f of foes) v += value(expected(st, m, f, name, spread), f);
      if (mv.target === 'allAdjacent' && ally) v -= value(expected(st, m, ally, name, spread), ally) * 1.2;
      out.push({ type: 'move', move: name, target: null, value: v });
    } else {
      for (const f of foes) out.push({ type: 'move', move: name, target: f, value: value(expected(st, m, f, name, false), f) });
    }
  }
  return out;
}

// 眠らせられるか（くさタイプにこな技は効かない。エレキフィールド・ミストフィールドでは、地面にいるポケモンは眠らない）
function canSleep(st, f, move) {
  if (f.status || f.yawn) return false;
  if (POWDER.has(move) && (f.b.types.includes('Grass') || f.b.ability === 'Overcoat' || f.item === 'Safety Goggles')) return false;
  if (['Insomnia', 'Vital Spirit', 'Sweet Veil'].includes(f.b.ability)) return false;
  const grounded = !f.b.types.includes('Flying') && f.b.ability !== 'Levitate';
  return !(grounded && (st.terrain === 'electric' || st.terrain === 'misty'));
}

function chooseAction(st, m) {
  // ため技の2ターン目
  if (m.charging) return { type: 'move', move: m.charging.move, target: m.charging.target };
  const side = st.sides[m.side];
  const foes = aliveActive(foeSide(st, m));
  const opts = attackOptions(st, m);
  const r = st.r;
  if (!m.lock) {
    // ねこだまし：出た最初のターン
    if (m.turnsOut === 0 && hasMove(m, 'Fake Out')) {
      const t = foes.filter((f) => f.b.ability !== 'Inner Focus' && effectivenessWithAbility('Normal', f.b.types, f.b.ability) > 0)
        .sort((a, b) => Math.max(a.b.stats[1], a.b.stats[3]) - Math.max(b.b.stats[1], b.b.stats[3])).pop();
      if (t) opts.push({ type: 'move', move: 'Fake Out', target: t, value: 70 });
    }
    // おいかぜ：張っていないとき
    if (hasMove(m, 'Tailwind') && side.tailwind === 0 && !st.trickRoom) opts.push({ type: 'move', move: 'Tailwind', value: 60 });
    // トリックルーム：味方の方が遅いとき（張っていなければ張る）
    if (hasMove(m, 'Trick Room') && !st.trickRoom) {
      const avg = (list) => list.reduce((a, x) => a + speedOf(st, x), 0) / Math.max(1, list.length);
      if (avg(side.mons.filter((x) => !x.fainted)) < avg(foes)) opts.push({ type: 'move', move: 'Trick Room', value: 65 });
    }
    // 壁
    if (hasMove(m, 'Aurora Veil') && st.weather === 'snow' && !side.veil) opts.push({ type: 'move', move: 'Aurora Veil', value: 55 });
    if (hasMove(m, 'Reflect') && !side.reflect && !side.veil) opts.push({ type: 'move', move: 'Reflect', value: 45 });
    if (hasMove(m, 'Light Screen') && !side.lightScreen && !side.veil) opts.push({ type: 'move', move: 'Light Screen', value: 42 });
    // このゆびとまれ：味方がいて、自分が倒されそうでないとき
    const redirect = m.b.moves.find((x) => REDIRECT.has(x));
    if (st.doubles && redirect && partnerOf(st, m) && r() < 0.6) opts.push({ type: 'move', move: redirect, value: 50 });
    const bestAttack = (x) => Math.max(0, ...attackOptions(st, x).map((o) => o.value));
    const threat = threatened(st, m);
    // てだすけ：自分の打点が、相方よりかなり低いとき
    const partner = partnerOf(st, m);
    if (st.doubles && hasMove(m, 'Helping Hand') && partner && bestAttack(m) < bestAttack(partner) * 0.6) opts.push({ type: 'move', move: 'Helping Hand', value: 40 });
    // ワイドガード：相手が全体技を持つとき、ときどき
    if (st.doubles && hasMove(m, 'Wide Guard') && m.protectStreak === 0 && r() < 0.4 &&
        foes.some((f) => f.b.moves.some((x) => SPREAD.has(moveData(st.db, x)?.target) && isAttack(moveData(st.db, x))))) opts.push({ type: 'move', move: 'Wide Guard', value: 48 });
    // 積み技：倒されそうでなく、まだ上げていないとき
    const setup = m.b.moves.find((x) => SETUP[x] && Object.entries(SETUP[x]).some(([k, n]) => n > 0 && m.boosts[k] < 2));
    if (setup && !threat) opts.push({ type: 'move', move: setup, value: 52 });
    // ねむり：相手に眠っているポケモンがいなければ（ねむりの重ねがけは禁止）、一番強い相手に
    const sleepMove = m.b.moves.find((x) => SLEEP.has(x));
    if (sleepMove && !foeSide(st, m).mons.some((x) => x.status === 'slp' && !x.fainted)) {
      const t = foes.filter((f) => canSleep(st, f, sleepMove)).sort((a, b) => bestAttack(a) - bestAttack(b)).pop();
      if (t) opts.push({ type: 'move', move: sleepMove, target: t, value: 58 * ((moveData(st.db, sleepMove)?.acc ?? 100) / 100) });
    }
    // おにび：物理の相手に。でんじは：自分より速い相手に
    if (hasMove(m, 'Will-O-Wisp')) {
      const t = foes.find((f) => !f.status && !f.b.types.includes('Fire') && f.b.stats[1] > f.b.stats[3]);
      if (t) opts.push({ type: 'move', move: 'Will-O-Wisp', target: t, value: 45 });
    }
    if (hasMove(m, 'Thunder Wave')) {
      const t = foes.find((f) => !f.status && !f.b.types.includes('Electric') && !f.b.types.includes('Ground') && speedOf(st, f) > speedOf(st, m));
      if (t) opts.push({ type: 'move', move: 'Thunder Wave', target: t, value: 38 });
    }
    // 回復：HP が半分を切ったら
    const heal = m.b.moves.find((x) => RECOVER.has(x));
    if (heal && m.hp < m.max / 2) opts.push({ type: 'move', move: heal, value: 48 });
    // ちょうはつ：相手がトリックルーム・おいかぜを張れるとき
    if (hasMove(m, 'Taunt')) {
      const t = foes.find((f) => !f.taunt && ((hasMove(f, 'Trick Room') && !st.trickRoom) || (hasMove(f, 'Tailwind') && !foeSide(st, m).tailwind)));
      if (t) opts.push({ type: 'move', move: 'Taunt', target: t, value: 56 });
    }
    // すてゼリフ：控えがいるとき
    if (hasMove(m, 'Parting Shot') && side.reserve.some((x) => !x.fainted) && foes.length) {
      opts.push({ type: 'move', move: 'Parting Shot', target: foes.sort((a, b) => bestAttack(a) - bestAttack(b)).at(-1), value: 35 });
    }
    // にほんばれ・あまごい：その天気を使う味方がいて、その天気でないとき
    const wm = m.b.moves.find((x) => WEATHER_MOVE[x] && st.weather !== WEATHER_MOVE[x]);
    if (wm && side.mons.some((x) => !x.fainted && (x.b.moves.some((y) => WEATHER_USE[y] === WEATHER_MOVE[wm]) || SPEED_WEATHER[x.b.ability] === WEATHER_MOVE[wm]))) {
      opts.push({ type: 'move', move: wm, value: 42 });
    }
    // まもる：倒されそうなとき、続けてでなければ半分くらいの確率で
    const protect = m.b.moves.find((x) => PROTECT.has(x));
    if (protect && m.protectStreak === 0 && r() < 0.5 && threatened(st, m)) opts.push({ type: 'move', move: protect, value: 75 });
  }
  // ちょうはつを受けていれば、変化技は使えない
  const usableOpts = m.taunt > 0 ? opts.filter((o) => isAttack(moveData(st.db, o.move))) : opts;
  const best = usableOpts.sort((a, b) => b.value - a.value)[0];
  // 打点がほとんどなく、控えに替えられるなら替える
  if ((!best || best.value < 8) && st.sides[m.side].reserve.some((x) => !x.fainted)) {
    const to = pickReserve(st, m.side);
    if (to) return { type: 'switch', to };
  }
  return best ?? { type: 'pass' };
}

// 控えから出すポケモン（いまの相手への打点が一番大きいもの）
function pickReserve(st, s, exclude = new Set()) {
  const side = st.sides[s];
  const cands = side.reserve.filter((x) => !x.fainted && !exclude.has(x));
  if (!cands.length) return null;
  const foes = aliveActive(st.sides[1 - s]);
  let best = null;
  for (const c of cands) {
    let v = 0;
    for (const f of foes) {
      let top = 0;
      for (const name of c.b.moves) if (isAttack(moveData(st.db, name))) top = Math.max(top, expected(st, c, f, name, false).avg / f.max);
      v += top;
    }
    if (!best || v > best.v) best = { c, v };
  }
  return best.c;
}

// ---------- 行動 ----------

function switchIn(st, s, out, inn) {
  const side = st.sides[s];
  const i = side.active.indexOf(out);
  side.active[i] = inn;
  side.reserve = side.reserve.filter((x) => x !== inn);
  if (out && !out.fainted) side.reserve.push(out);
  enter(st, inn);
}

function faint(st, m) {
  if (m.fainted) return;
  m.fainted = true;
  m.hp = 0;
  st.sides[m.side].fainted++;
}

function damage(m, n) {
  m.hp = Math.max(0, m.hp - n);
}

function useMove(st, m, act, ctx) {
  const name = act.move;
  const mv = moveData(st.db, name);
  const side = st.sides[m.side];
  if (CHOICE.has(m.item)) m.lock = name;
  // 変化技
  if (!isAttack(mv)) {
    if (PROTECT.has(name)) {
      const ok = m.protectStreak === 0 || st.r() < 1 / 3 ** m.protectStreak;
      if (ok) ctx.protected.add(m);
      m.protectStreak = ok ? m.protectStreak + 1 : 0;
      return;
    }
    if (name === 'Tailwind') side.tailwind = 4;
    else if (name === 'Trick Room') st.trickRoom = st.trickRoom ? 0 : 5;
    else if (name === 'Reflect') side.reflect = m.item === 'Light Clay' ? 8 : 5;
    else if (name === 'Light Screen') side.lightScreen = m.item === 'Light Clay' ? 8 : 5;
    else if (name === 'Aurora Veil' && st.weather === 'snow') side.veil = m.item === 'Light Clay' ? 8 : 5;
    else if (REDIRECT.has(name)) ctx.redirect[m.side] = m;
    else if (name === 'Helping Hand') { const p = partnerOf(st, m); if (p) ctx.helping.add(p); }
    else if (name === 'Wide Guard') {
      const ok = m.protectStreak === 0 || st.r() < 1 / 3 ** m.protectStreak;
      if (ok) ctx.wideGuard[m.side] = true;
      m.protectStreak = ok ? m.protectStreak + 1 : 0;
      return;
    } else if (SETUP[name]) {
      for (const [k, n] of Object.entries(SETUP[name])) boost(m, k, n);
    } else if (RECOVER.has(name)) {
      m.hp = Math.min(m.max, m.hp + Math.floor(m.max / 2));
    } else if (WEATHER_MOVE[name]) {
      st.weather = WEATHER_MOVE[name];
      st.weatherTurns = 5;
    } else if (act.target && !act.target.fainted && !ctx.protected.has(act.target)) {
      // 相手にかける変化技（命中も見る）
      const t = act.target;
      if (mv.acc != null && st.r() * 100 >= mv.acc) { m.protectStreak = 0; return; }
      if (SLEEP.has(name) && canSleep(st, t, name)) {
        if (name === 'Yawn') t.yawn = 2;
        else { t.status = 'slp'; t.sleep = 1 + Math.floor(st.r() * 3); }
      } else if (name === 'Will-O-Wisp' && !t.status && !t.b.types.includes('Fire')) t.status = 'brn';
      else if (name === 'Thunder Wave' && !t.status && !t.b.types.includes('Electric') && !t.b.types.includes('Ground')) t.status = 'par';
      else if (name === 'Taunt' && t.b.ability !== 'Oblivious') t.taunt = 3;
      else if (name === 'Parting Shot') {
        if (!DROP_IMMUNE.has(t.b.ability)) { boost(t, 'atk', -1); boost(t, 'spa', -1); }
        const to = pickReserve(st, m.side);
        if (to) switchIn(st, m.side, m, to);
      }
    }
    m.protectStreak = 0;
    return;
  }
  m.protectStreak = 0;
  // ため技：1ターン目はためる（はれ・あめ・パワフルハーブなら、すぐ撃つ）
  if (name in CHARGE && !m.charging) {
    const instant = (CHARGE[name] && CHARGE[name] === st.weather) || m.item === 'Power Herb';
    if (m.item === 'Power Herb' && !(CHARGE[name] && CHARGE[name] === st.weather)) m.item = '';
    if (!instant) {
      m.charging = { move: name, target: act.target };
      if (name === 'Meteor Beam') boost(m, 'spa', 1);
      return;
    }
  }
  m.charging = null;
  const foes = aliveActive(foeSide(st, m));
  if (!foes.length) return;
  let targets;
  if (st.doubles && SPREAD.has(mv.target)) {
    targets = [...foes];
    const ally = partnerOf(st, m);
    if (mv.target === 'allAdjacent' && ally) targets.push(ally);
  } else {
    let t = act.target && !act.target.fainted && foes.includes(act.target) ? act.target : foes[Math.floor(st.r() * foes.length)];
    const rd = ctx.redirect[1 - m.side];
    if (rd && !rd.fainted && foes.includes(rd)) t = rd;
    targets = [t];
  }
  const spread = targets.length > 1;
  const move = moveFor(st, m, name);
  let dealt = 0;
  for (const t of targets) {
    if (ctx.protected.has(t)) continue;
    // ワイドガードは、全体技を防ぐ
    if (spread && ctx.wideGuard[t.side]) continue;
    // 連続技で 1 回ごとに命中を判定するものは、下で当たった回数を数える
    if (!MULTI_ACC.has(name) && mv.acc != null && st.r() * 100 >= mv.acc) continue;
    const crit = st.r() < 1 / 24;
    const res = calcDamage(view(m), view(t), move, fieldFor(st, m, t, spread, crit, ctx.helping.has(m)));
    let d = res.rolls[Math.floor(st.r() * 16)];
    if (MULTI_ACC.has(name)) {
      const hits = rollHits(st, m, mv, res.hits);
      d = Math.floor((d / res.hits) * hits);
    }
    if (d <= 0) continue;
    // 半減の実
    if (RESIST_BERRY[t.item] === (res.eff > 1 ? move.type : null)) { d = Math.floor(d / 2); t.item = ''; }
    // きあいのタスキ・がんじょう
    if (t.hp === t.max && d >= t.hp && (t.item === 'Focus Sash' || t.b.ability === 'Sturdy')) {
      d = t.hp - 1;
      if (t.item === 'Focus Sash') t.item = '';
    }
    damage(t, d);
    dealt += d;
    if (st.trace) st.trace.push(`    → ${t.side}:${t.name} に ${d}（残り ${t.hp}/${t.max}${crit ? '・急所' : ''}）`);
    // ねこだましでひるむ（まだ動いていなければ）
    if (name === 'Fake Out' && !ctx.moved.has(t) && t.b.ability !== 'Inner Focus') ctx.flinched.add(t);
    // 相手の能力を下げる追加効果
    const drop = FOE_DROP[name];
    if (drop && t.hp > 0 && !DROP_IMMUNE.has(t.b.ability)) {
      boost(t, drop[0], drop[1]);
      if (t.b.ability === 'Defiant') boost(t, 'atk', 2);
      if (t.b.ability === 'Competitive') boost(t, 'spa', 2);
    }
    // 接触の反動
    if (mv.contact && m.item !== 'Protective Pads') {
      if (t.item === 'Rocky Helmet') damage(m, Math.floor(m.max / 6));
      if (t.b.ability === 'Rough Skin' || t.b.ability === 'Iron Barbs') damage(m, Math.floor(m.max / 8));
    }
    // オボンのみ
    if (t.hp > 0 && t.hp <= t.max / 2 && t.item === 'Sitrus Berry') { t.hp = Math.min(t.max, t.hp + Math.floor(t.max / 4)); t.item = ''; }
    if (t.hp <= 0) faint(st, t);
  }
  // はかいこうせんなどは、当たれば次のターンは動けない
  if (RECHARGE.has(name) && dealt > 0) m.recharge = true;
  if (dealt > 0) {
    for (const [stat, n] of Object.entries(SELF_DROP[name] ?? {})) boost(m, stat, n);
    if (m.item === 'Life Orb' && m.b.ability !== 'Magic Guard') damage(m, Math.floor(m.max / 10));
    if (mv.recoil && !['High Jump Kick', 'Jump Kick', 'Supercell Slam', 'Axe Kick'].includes(name) && m.b.ability !== 'Rock Head') {
      damage(m, Math.floor(dealt * (name === 'Head Smash' ? 0.5 : 1 / 3)));
    }
    if (m.hp <= 0) faint(st, m);
  }
}

// ---------- 1ターン ----------

function runTurn(st) {
  st.turn++;
  if (st.trace) st.trace.push(`T${st.turn} 天気 ${st.weather ?? '-'} TR ${st.trickRoom} 追い風 ${st.sides.map((x) => x.tailwind).join('/')} | ${st.sides.map((x, i) => aliveActive(x).map((m) => `${i}:${m.name} ${m.hp}/${m.max}${m.status ? '(' + m.status + ')' : ''}`).join(', ')).join(' | ')}`);
  const acts = [];
  for (const side of st.sides) {
    for (const m of aliveActive(side)) {
      const act = chooseAction(st, m);
      acts.push({ m, act, prio: priorityOf(st, m, act), speed: speedOf(st, m), tie: st.r() });
    }
  }
  acts.sort((a, b) => b.prio - a.prio || (st.trickRoom ? a.speed - b.speed : b.speed - a.speed) || a.tie - b.tie);
  const ctx = { protected: new Set(), flinched: new Set(), moved: new Set(), redirect: [null, null], helping: new Set(), wideGuard: [false, false] };
  // まもる・このゆびとまれは、優先度が高いので先に効く（並べた順に処理すれば足りる）
  for (const { m, act } of acts) {
    if (m.fainted) continue;
    ctx.moved.add(m);
    if (m.recharge) { m.recharge = false; if (st.trace) st.trace.push(`  ${m.side}:${m.name} は反動で動けない`); continue; }
    if (ctx.flinched.has(m)) { m.charging = null; continue; }
    // ねむり：残りのターンの間は動けず、0 になったら起きて動く。まひ：4 回に 1 回動けない
    if (m.status === 'slp' && act.type === 'move') {
      if (m.sleep > 0) { m.sleep--; continue; }
      m.status = null;
    }
    if (m.status === 'par' && act.type === 'move' && st.r() < 0.25) continue;
    if (st.trace) st.trace.push(`  ${m.side}:${m.name} ${act.type === 'switch' ? `交代 → ${act.to.name}` : act.move ?? '何もしない'}${act.target ? ` → ${act.target.side}:${act.target.name}` : ''}`);
    if (act.type === 'switch') { if (!act.to.fainted) switchIn(st, m.side, m, act.to); continue; }
    if (act.type === 'move') useMove(st, m, act, ctx);
    if (st.sides.some((s) => s.mons.every((x) => x.fainted))) break;
  }
  endOfTurn(st);
}

function endOfTurn(st) {
  for (const side of st.sides) {
    for (const m of aliveActive(side)) {
      if (m.item === 'Leftovers') m.hp = Math.min(m.max, m.hp + Math.floor(m.max / 16));
      if (m.status === 'brn' && m.b.ability !== 'Magic Guard') {
        damage(m, Math.floor(m.max / 16));
        if (m.hp <= 0) { faint(st, m); continue; }
      }
      // あくび：次のターンの終わりに眠る
      if (m.yawn && --m.yawn === 0 && !m.status) { m.status = 'slp'; m.sleep = 1 + Math.floor(st.r() * 3); }
      if (m.taunt > 0) m.taunt--;
      if (st.weather === 'sand' && !m.b.types.some((t) => ['Rock', 'Ground', 'Steel'].includes(t)) && !['Sand Veil', 'Sand Rush', 'Sand Force', 'Overcoat', 'Magic Guard'].includes(m.b.ability)) {
        damage(m, Math.floor(m.max / 16));
        if (m.hp <= 0) faint(st, m);
      }
      if (st.terrain === 'grassy' && !m.b.types.includes('Flying') && m.b.ability !== 'Levitate') m.hp = Math.min(m.max, m.hp + Math.floor(m.max / 16));
      if (!m.fainted) m.turnsOut++;
    }
    for (const k of ['tailwind', 'reflect', 'lightScreen', 'veil']) if (side[k] > 0) side[k]--;
  }
  if (st.weather && --st.weatherTurns <= 0) st.weather = null;
  if (st.terrain && --st.terrainTurns <= 0) st.terrain = null;
  if (st.trickRoom > 0) st.trickRoom--;
  // 倒れた枠に、控えから出す。実際のゲームと同じく、両方の側が出す前の同じ場を見て選び、そのあとでまとめて出す
  // （片方が先に出すと、もう片方はそれを見て選べてしまい、どちらの側から処理するかで勝率が偏るため）
  const entries = [];
  for (let s = 0; s < 2; s++) {
    const side = st.sides[s];
    const chosen = new Set();
    side.active.forEach((m, i) => {
      if (m && !m.fainted) return;
      const inn = pickReserve(st, s, chosen);
      if (!inn) return;
      chosen.add(inn);
      entries.push({ side, i, inn });
    });
  }
  for (const { side, i, inn } of entries) {
    side.active[i] = inn;
    side.reserve = side.reserve.filter((x) => x !== inn);
  }
  // 場に出たときの特性は、すばやさの順に（同じなら乱数で）
  entries.sort((a, b) => speedOf(st, b.inn) - speedOf(st, a.inn) || st.r() - 0.5);
  for (const { inn } of entries) enter(st, inn);
}

// ---------- 対戦 ----------

const remaining = (side) => side.mons.reduce((a, m) => a + (m.fainted ? 0 : m.hp / m.max), 0) / side.mons.length;

/**
 * 1 試合。picks は [[先発..., 控え...], [...]]（選んだ順に並べた id）
 * @returns 1 = 0 側の勝ち、0 = 1 側の勝ち、0.5 = 引き分け
 */
// trace に配列を渡すと、試合の流れを書き込む（確かめるとき）
export function battle(db, teams, picks, seed, trace = null) {
  const st = newBattle(db, teams, picks, seed);
  st.trace = trace;
  while (st.turn < MAX_TURNS) {
    const out = st.sides.map((s) => s.mons.every((m) => m.fainted));
    if (out[0] || out[1]) return out[0] && out[1] ? 0.5 : out[1] ? 1 : 0;
    runTurn(st);
  }
  const a = remaining(st.sides[0]);
  const b = remaining(st.sides[1]);
  return a > b ? 1 : a < b ? 0 : 0.5;
}

// 相手の 6 体を見て選ぶ（ダブル 4 体・シングル 3 体）。先発を前に並べる
export function choosePicks(db, team, opponentIds) {
  const plan = selectionPlan(db, team, opponentIds).plans[0];
  if (!plan) return team.filter(Boolean).slice(0, db.doubles ? 4 : 3).map((m) => m.id);
  return [...plan.lead, ...plan.members.filter((id) => !plan.lead.includes(id))];
}

/**
 * 2 つの構築を n 回戦わせたときの、a の勝率（0〜1）
 * 選出は試合ごとに変えない（相手の 6 体を見て、それぞれが決める）
 */
export function matchup(db, a, b, { n = 20, seed = 1 } = {}) {
  const pa = choosePicks(db, a, b.map((m) => m.id));
  const pb = choosePicks(db, b, a.map((m) => m.id));
  let win = 0;
  for (let i = 0; i < n; i++) win += battle(db, [a, b], [pa, pb], (seed * 7919 + i * 104729) >>> 0);
  return win / n;
}

// テスト用
export const _internal = { newBattle, runTurn, useMove, chooseAction, speedOf, expected };
