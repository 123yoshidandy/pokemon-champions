// 「一番の構築」を、相手の構築群との対戦のシミュレーションで探す（局所探索）
// 重いので、GitHub Actions で事前に計算する（scripts/best-teams.mjs）
import { usageOf, isMegaStone } from './data.js';
import { defaultMember, memberWithItem, memberBattler, normalizeTeam, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { topMeta, fieldClash } from './analysis.js';
import { suggestTeams } from './suggest.js';
import { rng, battle, choosePicks, matchup } from './sim.js';
import { buildOpponents, itemFits, fixItems } from './opponents.js';

// ---------- 規則 ----------

export function validTeam(db, team) {
  if (team.length !== TEAM_SIZE || team.some((m) => !m || !db.dex[m.id])) return false;
  if (new Set(team.map((m) => db.dex[m.id].base)).size !== TEAM_SIZE) return false;
  if (team.filter((m) => isMegaStone(db, m.id, m.item)).length > 1) return false;
  const items = team.map((m) => m.item).filter(Boolean);
  if (new Set(items).size !== items.length) return false;
  if (fieldClash(team.map((m) => memberBattler(db, m)))) return false;
  if (team.some((m) => !itemFits(db, team, m))) return false;
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
export function evaluateTeam(db, team, opponents, opts = {}) {
  return evaluateDetail(db, team, opponents, opts).rate;
}

// 相手ごとの勝率も返す { rate, per: [相手ごとの勝率], games: 試合数 }
export function evaluateDetail(db, team, opponents, { battles = 8, seed = 1 } = {}) {
  let sum = 0;
  let wsum = 0;
  const ids = team.map((m) => m.id);
  const per = opponents.map((o, k) => {
    const mine = choosePicks(db, team, o.team.map((m) => m.id));
    const theirs = o.picksVs?.get(ids.join(',')) ?? choosePicks(db, o.team, ids);
    o.picksVs?.set(ids.join(','), theirs);
    let win = 0;
    for (let i = 0; i < battles; i++) win += battle(db, [team, o.team], [mine, theirs], (seed * 1000003 + k * 7919 + i * 104729) >>> 0);
    sum += (win / battles) * o.weight;
    wsum += o.weight;
    return win / battles;
  });
  return { rate: sum / wsum, per, games: battles * opponents.length };
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


// 試合数 n で測った勝率 p の、95% のぶれの幅（±）
export const margin = (p, n) => 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.01) / Math.max(1, n));

// 1 回分の探索（初期値から局所探索し、上位 5 つを、探索に使っていない相手の構築群で選び直す）
function searchOnce(db, starts, { opponents, validation, pool, battles, finalBattles, iterations, patience, seed, log }) {
  const r = rng(seed);
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
    // しばらく良くならなければ、別の初期値から
    if (stale >= patience && si + 1 < starts.length) {
      cur = starts[++si];
      curV = score(cur);
      stale = 0;
    }
  }
  const top = [...seen.values()].sort((a, b) => b.v - a.v).slice(0, 5);
  const finalists = top.map((x) => ({ team: x.team, train: x.v, v: evaluateTeam(db, x.team, validation, { battles: finalBattles, seed: seed + 1 }) }))
    .sort((a, b) => b.v - a.v);
  return { finalists, evaluations };
}

/**
 * 一番の構築を、リーグで選ぶ
 * 1. 探索を rounds 回まわす。2 回目からは、それまでに見つけた構築を相手に加える（相手の側も強くしていく）
 * 2. 各回の上位 keep 個と、今の提案の上位 5 つを「リーグ」に集める
 * 3. 探索にも選び直しにも使っていない相手の構築群（使用率の重み）への勝率と、リーグのほかの構築との直接対決の勝率の平均で並べる
 *    （特定の相手に強いだけでなく、どれにも大きく負けない構築を上にするため）
 * @returns { ranking: 上位 [{ team, score, envWinRate, leagueWinRate, margin, weakLeague, strongLeague, weakEnv }], team, winRate, baseline, ... }
 */
export function searchBest(db, { opponents: nOpp = 60, battles = 8, finalBattles = 32, iterations = 300, rounds = 4, keep = 3, leagueBattles = 40, top: nTop = 5,
  pool: nPool = 80, patience = 40, seed = 1, log = () => {} } = {}) {
  const pool = topMeta(db, nPool).filter((id) => db.usage[id]);
  const prep = (list) => list.map((o) => ({ ...o, picksVs: new Map() }));
  const base = buildOpponents(db, { n: nOpp, seed });
  const validationBase = buildOpponents(db, { n: nOpp, seed: seed + 1000 });
  // 初期値：今の提案の結果（一番の構築と、おまかせの上位）
  const starts = suggestTeams(db, [], { pool: 100, threats: 60, beam: 48, results: 5 })
    .map((s) => fixItems(db, s.team.filter(Boolean)))
    .filter((t) => validTeam(db, t));
  const avgW = base.reduce((a, o) => a + o.weight, 0) / base.length;
  const found = [];
  let evaluations = 0;
  let searchWinRate = null;
  for (let k = 0; k < rounds; k++) {
    // それまでに見つけた構築を、相手（探索用・選び直し用）に加える。重みは、相手の構築群の重みの平均の 2 倍
    const extra = found.map((x) => ({ team: x.team, weight: avgW * 2 }));
    const res = searchOnce(db, starts, {
      opponents: prep([...base, ...extra]), validation: prep([...validationBase, ...extra]), pool, battles, finalBattles,
      iterations: Math.ceil(iterations / rounds), patience, seed: seed + k * 17, log: (s) => log(`回${k + 1}${s}`),
    });
    evaluations += res.evaluations;
    if (k === 0) searchWinRate = res.finalists[0].train;
    for (const x of res.finalists.slice(0, keep)) if (!found.some((y) => teamKey(y.team) === teamKey(x.team))) found.push(x);
  }

  // リーグ：見つけた構築と、今の提案の上位 5 つ
  const league = found.map((x) => x.team);
  for (const t of starts) if (!league.some((x) => teamKey(x) === teamKey(t))) league.push(t);
  const test = prep(buildOpponents(db, { n: nOpp, seed: seed + 2000 }));
  const env = league.map((t) => evaluateDetail(db, t, test, { battles: finalBattles, seed: seed + 2 }));
  // 直接対決（a から見た勝率。b から見れば 1 − その値）
  const h2h = league.map(() => league.map(() => null));
  league.forEach((a, i) => league.forEach((b, j) => {
    if (j <= i) return;
    h2h[i][j] = matchup(db, a, b, { n: leagueBattles, seed: seed + 3 + i * 31 + j });
    h2h[j][i] = 1 - h2h[i][j];
  }));
  const ids = (t) => t.map((x) => x.id);
  const byRank = (list) => list.slice().sort((a, b) => (db.rankOf.get(a)?.pos ?? 999) - (db.rankOf.get(b)?.pos ?? 999));
  const rows = league.map((team, i) => {
    const vs = h2h[i].map((v, j) => (j === i ? null : { j, v })).filter(Boolean);
    const leagueWinRate = vs.reduce((a, x) => a + x.v, 0) / Math.max(1, vs.length);
    const envWinRate = env[i].rate;
    const sorted = vs.slice().sort((a, b) => a.v - b.v);
    return {
      team: normalizeTeam(team),
      score: (envWinRate + leagueWinRate) / 2,
      envWinRate,
      leagueWinRate,
      // 点（2 つの勝率の平均）の 95% のぶれの幅
      margin: 0.5 * Math.hypot(margin(envWinRate, env[i].games), margin(leagueWinRate, leagueBattles * vs.length)),
      weakLeague: sorted.slice(0, 2).map((x) => ({ ids: ids(league[x.j]), rate: x.v })),
      strongLeague: sorted.slice(-2).reverse().map((x) => ({ ids: ids(league[x.j]), rate: x.v })),
      // 環境で苦手な相手：勝率が低い相手の構築の、主なメンバー（使用率の順位が高い 3 体）
      weakEnv: env[i].per.map((v, k) => ({ v, k })).sort((a, b) => a.v - b.v).slice(0, 3)
        .map(({ v, k }) => ({ ids: byRank(ids(test[k].team)).slice(0, 3), rate: v })),
      fromSuggestion: starts.some((t) => teamKey(t) === teamKey(team)),
    };
  }).sort((a, b) => b.score - a.score);
  const baseRow = rows.find((x) => teamKey(x.team.filter(Boolean)) === teamKey(starts[0]));
  return {
    ranking: rows.slice(0, nTop),
    team: rows[0].team,
    winRate: rows[0].envWinRate,
    searchWinRate,
    baseline: { team: normalizeTeam(starts[0]), winRate: baseRow.envWinRate, leagueWinRate: baseRow.leagueWinRate, score: baseRow.score },
    leagueSize: league.length,
    evaluations,
    opponents: nOpp,
  };
}
