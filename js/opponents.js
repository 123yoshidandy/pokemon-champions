// 相手にする構築の群れ（使用率と「一緒に使われるポケモン」から、実際にありそうな構築を作る）
import { usageOf, isMegaStone } from './data.js';
import { defaultMember, memberBattler, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { topMeta, rankWeight, fieldClash } from './analysis.js';
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
    const key = team.map((m) => m.id).sort().join(',');
    if (!out.has(key)) out.set(key, { team, weight: team.reduce((a, m) => a + rankWeight(pos(m.id)), 0) / TEAM_SIZE });
  }
  return [...out.values()];
}
