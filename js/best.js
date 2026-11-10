// 「一番の構築」を、相手の構築群との対戦のシミュレーションで探す（局所探索）
// 重いので、GitHub Actions で事前に計算する（scripts/best-teams.mjs）
import { usageOf, isMegaStone } from './data.js';
import { defaultMember, memberWithItem, memberBattler, normalizeTeam, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { topMeta, fieldClash } from './analysis.js';
import { suggestTeams } from './suggest.js';
import { rng, battle, choosePicks } from './sim.js';
import { buildOpponents } from './opponents.js';

// ---------- 規則 ----------

export function validTeam(db, team) {
  if (team.length !== TEAM_SIZE || team.some((m) => !m || !db.dex[m.id])) return false;
  if (new Set(team.map((m) => db.dex[m.id].base)).size !== TEAM_SIZE) return false;
  if (team.filter((m) => isMegaStone(db, m.id, m.item)).length > 1) return false;
  const items = team.map((m) => m.item).filter(Boolean);
  if (new Set(items).size !== items.length) return false;
  if (fieldClash(team.map((m) => memberBattler(db, m)))) return false;
  if (db.megaRule && team.some((m) => !db.dex[m.id].megas?.length)) return false;
  // メガシンカの型でしか使われていない種族を、メガなしで使わない（メガシンカバトルは除く）
  if (!db.megaRule && team.some((m) => !isMegaStone(db, m.id, m.item) && megaStoneShare(db, m.id) >= MEGA_ONLY_SHARE)) return false;
  return true;
}

export const teamKey = (team) => team.map((m) => `${m.id}@${m.item}`).sort().join(',');

// ---------- 評価 ----------

/**
 * 相手の構築群に対する、重み付きの勝率（0〜1）
 * 相手ごと・試合ごとのシードは、どの候補でも同じ（候補どうしの差に、乱数のぶれが乗りにくいように）
 */
export function evaluateTeam(db, team, opponents, { battles = 8, seed = 1 } = {}) {
  let sum = 0;
  let wsum = 0;
  const ids = team.map((m) => m.id);
  opponents.forEach((o, k) => {
    const mine = choosePicks(db, team, o.team.map((m) => m.id));
    const theirs = o.picksVs?.get(ids.join(',')) ?? choosePicks(db, o.team, ids);
    o.picksVs?.set(ids.join(','), theirs);
    let win = 0;
    for (let i = 0; i < battles; i++) win += battle(db, [team, o.team], [mine, theirs], (seed * 1000003 + k * 7919 + i * 104729) >>> 0);
    sum += (win / battles) * o.weight;
    wsum += o.weight;
  });
  return sum / wsum;
}

// ---------- 変異 ----------

const others = (team, i) => team.filter((_, k) => k !== i);

// メンバーを 1 体入れ替える
function swapMember(db, team, r, pool) {
  const i = Math.floor(r() * TEAM_SIZE);
  const rest = others(team, i);
  const cands = pool.filter((id) => !rest.some((m) => db.dex[m.id].base === db.dex[id].base));
  const id = cands[Math.floor(r() * cands.length)];
  const next = rest.slice();
  next.splice(i, 0, defaultMember(db, id, rest));
  return next;
}

// 持ち物を、採用率 1% 以上の別の持ち物にする（型は持ち物に合わせて組み直す）
function swapItem(db, team, r) {
  const i = Math.floor(r() * TEAM_SIZE);
  const m = team[i];
  const taken = new Set(others(team, i).map((x) => x.item));
  const megaTaken = others(team, i).some((x) => isMegaStone(db, x.id, x.item));
  const items = usageOf(db, m.id).items
    .filter(([it, p]) => (p ?? 0) >= 1 && it !== m.item && !taken.has(it) && !(megaTaken && isMegaStone(db, m.id, it)))
    .map(([it]) => it);
  if (!items.length) return null;
  const nm = memberWithItem(db, m.id, items[Math.floor(r() * items.length)]);
  if (!nm) return null;
  const next = team.slice();
  next[i] = nm;
  return next;
}

// メガシンカする 1 体を入れ替える
function swapMega(db, team, r) {
  const can = team.map((m, i) => i).filter((i) => !isMegaStone(db, team[i].id, team[i].item) && usageOf(db, team[i].id).items.some(([it]) => isMegaStone(db, team[i].id, it)));
  if (!can.length) return null;
  const j = can[Math.floor(r() * can.length)];
  const next = team.map((m, i) => (i !== j && isMegaStone(db, m.id, m.item) ? defaultMember(db, m.id, others(team, i), { noMega: true }) : m));
  const stone = usageOf(db, next[j].id).items.find(([it]) => isMegaStone(db, next[j].id, it))?.[0];
  next[j] = memberWithItem(db, next[j].id, stone) ?? next[j];
  return next;
}

function mutate(db, team, r, pool) {
  const x = r();
  if (x < 0.6) return swapMember(db, team, r, pool);
  if (x < 0.85) return swapItem(db, team, r);
  return swapMega(db, team, r);
}

// ---------- 探索 ----------

/**
 * @param opts { opponents: 相手の構築の数, battles: 探索中の1組あたりの試合数, finalBattles: 最後の測り直しの試合数,
 *               iterations: 試す変異の数, pool: 入れ替えの候補にする上位の数, seed, log }
 * @returns { team, winRate, baseline: { team, winRate }, evaluations, opponents }
 */
export function searchBest(db, { opponents: nOpp = 60, battles = 8, finalBattles = 32, iterations = 300, pool: nPool = 80, patience = 40, seed = 1, log = () => {} } = {}) {
  const r = rng(seed);
  const opponents = buildOpponents(db, { n: nOpp, seed }).map((o) => ({ ...o, picksVs: new Map() }));
  const pool = topMeta(db, nPool).filter((id) => db.usage[id]);
  const seen = new Map();
  let evaluations = 0;
  const score = (team) => {
    const k = teamKey(team);
    if (!seen.has(k)) {
      seen.set(k, { team, v: evaluateTeam(db, team, opponents, { battles, seed }) });
      evaluations++;
    }
    return seen.get(k).v;
  };

  // 初期値：今の提案の結果（一番の構築と、おまかせの上位）
  const starts = suggestTeams(db, [], { pool: 100, threats: 60, beam: 48, results: 5 })
    .map((s) => s.team.filter(Boolean))
    .filter((t) => validTeam(db, t));
  const baseline = starts[0];
  let best = null;
  let si = 0;
  let cur = starts[0];
  let curV = score(cur);
  let stale = 0;
  for (let it = 0; it < iterations; it++) {
    const next = mutate(db, cur, r, pool);
    if (next && validTeam(db, next)) {
      const v = score(next);
      if (v > curV) {
        cur = next;
        curV = v;
        stale = 0;
        log(`  ${it}: ${(v * 100).toFixed(1)}% ${cur.map((m) => m.id).join(' ')}`);
      } else stale++;
    } else stale++;
    if (!best || curV > best.v) best = { team: cur, v: curV };
    // しばらく良くならなければ、別の初期値から
    if (stale >= patience && si + 1 < starts.length) {
      cur = starts[++si];
      curV = score(cur);
      stale = 0;
    }
  }

  // 上位の候補を、試合数を増やして測り直す（探索中の勝率は、少ない試合数で高めに出やすいので）
  const finalists = [...seen.values()].sort((a, b) => b.v - a.v).slice(0, 5);
  const final = finalists.map((x) => ({ team: x.team, v: evaluateTeam(db, x.team, opponents, { battles: finalBattles, seed: seed + 1 }) }))
    .sort((a, b) => b.v - a.v)[0];
  const baseV = evaluateTeam(db, baseline, opponents, { battles: finalBattles, seed: seed + 1 });
  return {
    team: normalizeTeam(final.team),
    winRate: final.v,
    baseline: { team: normalizeTeam(baseline), winRate: baseV },
    evaluations,
    opponents: opponents.length,
  };
}
