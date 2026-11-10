// 相手にする構築の群れ（使用率と「一緒に使われるポケモン」から、実際にありそうな構築を作る）
import { usageOf, isMegaStone } from './data.js';
import { defaultMember, memberWithItem, memberBattler, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { topMeta, rankWeight, fieldClash, fieldSetters, WEATHER_ABILITY } from './analysis.js';
import { rng } from './sim.js';

// 構築を作るときに使う、上位の範囲
const POOL = 80;

// 重みに比例して 1 つ選ぶ
function pick(r, items, weight) {
  const ws = items.map(weight);
  const sum = ws.reduce((a, b) => a + b, 0);
  if (sum <= 0) return items[Math.floor(r() * items.length)];
  let x = r() * sum;
  for (let i = 0; i < items.length; i++) if ((x -= ws[i]) <= 0) return items[i];
  return items.at(-1);
}

// 条件があるときだけ効く持ち物（フィールドのシード・天気を伸ばす石など）
const TERRAIN_ITEM = { 'Electric Seed': 'electric', 'Grassy Seed': 'grassy', 'Psychic Seed': 'psychic', 'Misty Seed': 'misty' };
const WEATHER_ROCK = { 'Heat Rock': 'sun', 'Damp Rock': 'rain', 'Smooth Rock': 'sand', 'Icy Rock': 'snow' };
const SCREENS = ['Reflect', 'Light Screen', 'Aurora Veil'];

// 持ち物が、構築の中で効くか（シードはそのフィールドを張る味方、石は自分の天気、ねんどは自分の壁、ルームサービスはトリックルーム）
export function itemFits(db, team, m) {
  if (TERRAIN_ITEM[m.item]) return fieldSetters(team.map((x) => memberBattler(db, x))).terrains.includes(TERRAIN_ITEM[m.item]);
  if (WEATHER_ROCK[m.item]) return WEATHER_ABILITY[memberBattler(db, m).ability] === WEATHER_ROCK[m.item];
  if (m.item === 'Light Clay') return m.moves.some((x) => SCREENS.includes(x));
  if (m.item === 'Room Service') return team.some((x) => x.moves.includes('Trick Room'));
  return true;
}

// 条件に合わない持ち物を、採用率 1% 以上の、合う別の持ち物に替える（替えられなければ、そのまま）
export function fixItems(db, team) {
  const out = team.slice();
  out.forEach((m, i) => {
    if (itemFits(db, out, m)) return;
    const taken = new Set(out.filter((_, k) => k !== i).map((x) => x.item));
    for (const [it, p] of usageOf(db, m.id).items) {
      if ((p ?? 0) < 1 || it === m.item || taken.has(it) || isMegaStone(db, m.id, it)) continue;
      const nm = memberWithItem(db, m.id, it);
      if (nm && itemFits(db, out.map((x, k) => (k === i ? nm : x)), nm)) {
        out[i] = nm;
        return;
      }
    }
  });
  return out;
}

// 構築に足せるか（同じ種族・天気とフィールドのぶつかり・メガの型でしか使われない種族のメガなし）
export function canAdd(db, team, member) {
  if (team.some((m) => db.dex[m.id].base === db.dex[member.id].base)) return false;
  if (fieldClash([...team, member].map((m) => memberBattler(db, m)))) return false;
  if (!db.megaRule && !isMegaStone(db, member.id, member.item) && megaStoneShare(db, member.id) >= MEGA_ONLY_SHARE) return false;
  return true;
}

/**
 * 相手の構築を n 個作る。同じ顔ぶれは 1 つにまとめる
 * @returns [{ team: member[6], weight }]（weight はメンバーの使用率の重みの平均）
 */
export function buildOpponents(db, { n = 60, seed = 1 } = {}) {
  const r = rng(seed);
  const pool = topMeta(db, POOL).filter((id) => db.usage[id]);
  const inPool = new Set(pool);
  const pos = (id) => db.rankOf.get(id)?.pos ?? POOL;
  const out = new Map();
  for (let tries = 0; out.size < n && tries < n * 20; tries++) {
    // 軸は、上位ほど選ばれやすく
    const core = pick(r, pool, (id) => 1 / pos(id));
    const team = [defaultMember(db, core)];
    if (!canAdd(db, [], team[0])) continue;
    while (team.length < TEAM_SIZE) {
      // いまのメンバーと一緒に使われるポケモンほど選ばれやすく（採用データの上位ほど重い）
      const score = new Map();
      for (const m of team) {
        usageOf(db, m.id).teammates.forEach((id, i) => {
          if (inPool.has(id)) score.set(id, (score.get(id) ?? 0) + (10 - i));
        });
      }
      const cands = [...score.keys()].filter((id) => !team.some((m) => m.id === id));
      const list = cands.length ? cands : pool.filter((id) => !team.some((m) => m.id === id));
      let added = false;
      for (let k = 0; k < 8 && !added; k++) {
        const id = pick(r, list, (x) => (score.get(x) ?? 1) ** 2 / Math.sqrt(pos(x)));
        const m = defaultMember(db, id, team);
        if (canAdd(db, team, m)) {
          team.push(m);
          added = true;
        }
      }
      if (!added) break;
    }
    if (team.length < TEAM_SIZE) continue;
    const fixed = fixItems(db, team);
    team.splice(0, TEAM_SIZE, ...fixed);
    if (team.some((m) => !itemFits(db, team, m))) continue;
    const key = team.map((m) => m.id).sort().join(',');
    if (!out.has(key)) out.set(key, { team, weight: team.reduce((a, m) => a + rankWeight(pos(m.id)), 0) / TEAM_SIZE });
  }
  return [...out.values()];
}
