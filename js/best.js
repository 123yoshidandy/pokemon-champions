// 「一番の構築」を、相手の構築群との対戦のシミュレーションで探す（局所探索）
// 重いので、GitHub Actions で事前に計算する（scripts/best-teams.mjs）
import { usageOf, isMegaStone } from './data.js';
import { defaultMember, memberWithItem, memberBattler, normalizeTeam, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { topMeta, fieldClash, weatherMisfits } from './analysis.js';
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

// 探索の候補にしてよいか（規則に加えて、天気に頼るのに構築の天気と合わないメンバーがいない）
// 相手の構築群は使用率から組み立てたものなので、この規則はかけない
export function validCandidate(db, team) {
  return validTeam(db, team) && weatherMisfits(team.map((m) => memberBattler(db, m))).length === 0;
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
  const tk = teamKey(team);
  const per = opponents.map((o, k) => {
    // 選出は、相手ごとに覚えて使い回す（同じ組み合わせを何度も評価するので）
    const mine = o.picksMine?.get(tk) ?? choosePicks(db, team, o.team.map((m) => m.id));
    o.picksMine?.set(tk, mine);
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

// 型は、よく使われる型に限る（持ち物は入れ替えない。使用率の低い型で、シミュレーターのすきを突く構築が出にくいように）
function mutate(db, team, r, pool) {
  return r() < 0.8 ? swapMember(db, team, r, pool) : swapMega(db, team, r);
}

// ---------- 探索 ----------

// 試合数 n で測った勝率 p の、95% のぶれの幅（±）
export const margin = (p, n) => 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.01) / Math.max(1, n));

// 候補を作る：安い評価（相手の一部・少ない試合）で局所探索し、評価したものすべてを返す [{ team, v }]
function explore(db, starts, { opponents, pool, battles, iterations, patience, seed, log }) {
  const r = rng(seed);
  const seen = new Map();
  const score = (team) => {
    const k = teamKey(team);
    if (!seen.has(k)) seen.set(k, { team, v: evaluateTeam(db, team, opponents, { battles, seed }) });
    return seen.get(k).v;
  };
  let si = 0;
  let cur = starts[0];
  let curV = score(cur);
  let stale = 0;
  for (let it = 0; it < iterations; it++) {
    const next = mutate(db, cur, r, pool);
    if (next && validCandidate(db, next)) {
      const v = score(next);
      if (v > curV) {
        cur = next;
        curV = v;
        stale = 0;
        log(`  ${it}: ${(v * 100).toFixed(1)}% ${cur.map((m) => m.id).join(' ')}`);
      } else stale++;
    } else stale++;
    // しばらく良くならなければ、別の初期値から
    if (stale >= patience) {
      si = (si + 1) % starts.length;
      cur = starts[si];
      curV = score(cur);
      stale = 0;
    }
  }
  return [...seen.values()];
}

/**
 * 段階的なふるい落とし（successive halving）
 * 1 段目は全部の候補を、相手の構築群の全部と battles 試合ずつ戦わせ、上位半分を残す。段ごとに試合数を 2 倍にし、
 * keep 個まで減らす。試合は段ごとに新しいシードで、結果は積み上げる（有望な候補ほど多く試合させ、少ない計算で精度を上げる）
 * @returns [{ team, rate, games, margin, per }]（rate の高い順。per は相手ごとの勝率）
 */
export function race(db, candidates, opponents, { battles = 1, keep = 4, seed = 1, log = () => {} } = {}) {
  let alive = candidates.map((team) => ({ team, sum: 0, wsum: 0, games: 0, perWin: opponents.map(() => 0), perGames: 0 }));
  const all = alive.slice();
  let b = battles;
  for (let stage = 0; ; stage++) {
    for (const c of alive) {
      const d = evaluateDetail(db, c.team, opponents, { battles: b, seed: seed + 100 * stage });
      opponents.forEach((o, k) => {
        c.sum += d.per[k] * o.weight * b;
        c.wsum += o.weight * b;
        c.perWin[k] += d.per[k] * b;
      });
      c.games += d.games;
      c.perGames += b;
      c.rate = c.sum / c.wsum;
    }
    alive.sort((x, y) => y.rate - x.rate);
    log(`  ふるい ${stage + 1}段目: ${alive.length}個、1つあたり ${alive[0].games}試合、1位 ${(alive[0].rate * 100).toFixed(1)}%`);
    if (alive.length <= keep) break;
    alive = alive.slice(0, Math.max(keep, Math.ceil(alive.length / 2)));
    b *= 2;
  }
  for (const c of all) {
    c.margin = margin(c.rate, c.games);
    c.per = c.perWin.map((w) => w / c.perGames);
  }
  return all.sort((x, y) => y.games - x.games || y.rate - x.rate);
}

/**
 * 苦手な相手：相手の構築の 1 体ずつ（その種族がいる構築）ごとに勝率を集計し、試合数が min 以上のものから、勝率の低い n 体
 * （1 つの相手の構築との数試合だけの勝率は、ぶれが大きいので）
 * @returns [{ id, rate, games }]
 */
export function weakSpecies(c, opponents, { min = 200, n = 3 } = {}) {
  const agg = new Map();
  opponents.forEach((o, k) => {
    for (const m of o.team) {
      const a = agg.get(m.id) ?? { wins: 0, games: 0 };
      a.wins += c.per[k] * c.perGames;
      a.games += c.perGames;
      agg.set(m.id, a);
    }
  });
  return [...agg].filter(([, a]) => a.games >= min).map(([id, a]) => ({ id, rate: a.wins / a.games, games: a.games }))
    .sort((a, b) => a.rate - b.rate).slice(0, n);
}

/**
 * 一番の構築を探す
 * 1. 相手の構築群の一部と少ない試合の安い評価で局所探索し、評価した構築の上位 candidates 個と今の提案の 5 つを候補にする
 * 2. 候補を、相手の構築群の全部（使用率の重み付き）との段階的なふるい落としで比べ、最後の keep 個は数千試合で比べる
 * @returns { ranking: [{ team, envWinRate, margin, games, weakEnv, fromSuggestion }], team, winRate, baseline, ... }
 */
export function searchBest(db, { opponents: nOpp = 400, searchOpponents = 60, battles = 4, iterations = 800, candidates: nCand = 64,
  raceBattles = 1, keep = 4, pool: nPool = 50, patience = 60, seed = 1, extra = [], log = () => {} } = {}) {
  const pool = topMeta(db, nPool).filter((id) => db.usage[id]);
  const prep = (list) => list.map((o) => ({ ...o, picksVs: new Map(), picksMine: new Map() }));
  // extra：相手に加える構築 [{ team, weight }]（見つけた構築を相手に加えて、相手の側も強くしていくとき）
  const opponents = prep([...buildOpponents(db, { n: nOpp, seed }), ...extra]);
  // 初期値：今の提案の結果（一番の構築と、おまかせの上位）
  // 候補に入れるポケモンは、そのルールの使用率の上位 nPool 体に限る
  const starts = suggestTeams(db, [], { pool: nPool, threats: 60, beam: 48, results: 5 })
    .map((s) => fixItems(db, s.team.filter(Boolean)))
    .filter((t) => validCandidate(db, t));
  // 1. 安い評価で探す（相手の構築群の一部）
  const seen = explore(db, starts, { opponents: [...opponents.slice(0, searchOpponents), ...opponents.slice(nOpp)], pool, battles, iterations, patience, seed, log });
  const cands = seen.sort((a, b) => b.v - a.v).slice(0, nCand).map((x) => x.team);
  for (const t of starts) if (!cands.some((x) => teamKey(x) === teamKey(t))) cands.push(t);
  // 2. ふるい落とし（探索とは別のシードの試合で）
  const raced = race(db, cands, opponents, { battles: raceBattles, keep, seed: seed + 7777, log });
  const row = (c) => ({
    team: normalizeTeam(c.team), envWinRate: c.rate, margin: c.margin, games: c.games,
    weakEnv: weakSpecies(c, opponents),
    fromSuggestion: starts.some((t) => teamKey(t) === teamKey(c.team)),
  });
  const ranking = raced.slice(0, keep).map(row);
  const base = raced.find((c) => teamKey(c.team) === teamKey(starts[0]));
  return {
    ranking,
    team: ranking[0].team,
    winRate: ranking[0].envWinRate,
    baseline: { team: normalizeTeam(starts[0]), winRate: base.rate, margin: base.margin, games: base.games },
    candidates: cands.length,
    explored: seen.length,
    opponents: opponents.length,
  };
}

// 複数のシードの結果の上位をまとめ、もう一度ふるい落としで比べる（Actions で、シードごとに分けて計算したあと）
export function finalRace(db, teams, { opponents: nOpp = 400, raceBattles = 8, keep = 4, seed = 99, log = () => {} } = {}) {
  const opponents = buildOpponents(db, { n: nOpp, seed }).map((o) => ({ ...o, picksVs: new Map(), picksMine: new Map() }));
  const uniq = [];
  for (const t of teams) if (!uniq.some((x) => teamKey(x) === teamKey(t))) uniq.push(t);
  const raced = race(db, uniq, opponents, { battles: raceBattles, keep, seed: seed + 7777, log });
  return raced.slice(0, keep).map((c) => ({
    team: normalizeTeam(c.team), envWinRate: c.rate, margin: c.margin, games: c.games,
    weakEnv: weakSpecies(c, opponents),
  }));
}
