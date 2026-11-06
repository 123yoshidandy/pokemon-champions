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

// 一番通る技（命中も考えた平均ダメージ%で比べる）
export function bestHit(db, att, def, field = {}) {
  let best = null;
  for (const name of att.moves) {
    const mv = moveData(db, name);
    if (!isAttack(mv)) continue;
    const r = calcDamage(att, def, { name, ...mv }, { doubles: db.doubles, ...field });
    const avg = ((r.minPct + r.maxPct) / 2) * ((mv.acc ?? 100) / 100);
    if (!best || avg > best.avgPct) best = { move: name, avgPct: avg, minPct: r.minPct, maxPct: r.maxPct, ko: r.ko, eff: r.eff };
  }
  return best ?? { move: null, avgPct: 0, minPct: 0, maxPct: 0, ko: { n: Infinity, chance: 0 }, eff: 0 };
}

const turnsToKO = (hit) => (hit.avgPct > 0 ? Math.min(9, Math.ceil(100 / hit.avgPct)) : 9);

const speedOf = (b) => Math.floor(b.stats[5] * (b.item === 'Choice Scarf' ? 1.5 : 1));

// a から見た対面の有利さ（-1〜1）
export function duel(db, a, b) {
  const ha = bestHit(db, a, b);
  const hb = bestHit(db, b, a);
  const ta = turnsToKO(ha);
  const tb = turnsToKO(hb);
  const sa = speedOf(a);
  const sb = speedOf(b);
  const faster = sa > sb ? 1 : sa < sb ? -1 : 0;
  let score;
  if (ta < tb) score = Math.min(1, 0.5 + (tb - ta) * 0.25);
  else if (ta > tb) score = -Math.min(1, 0.5 + (ta - tb) * 0.25);
  else score = ta >= 9 ? 0 : faster * 0.5;
  return { score, a: ha, b: hb, turnsA: ta, turnsB: tb, speedA: sa, speedB: sb };
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
export function threatReport(db, battlers, n = 30) {
  const team = battlers.filter(Boolean);
  return topMeta(db, n).map((id) => {
    const foe = metaBattler(db, id);
    const duels = team.map((m) => ({ id: m.id, ...duel(db, m, foe) }));
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
  const teamBest = foes.map((f) => (members.length ? Math.max(...members.map((m) => duel(db, m, f).score)) : -1));
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
    let gain = 0;
    const newAnswers = [];
    foes.forEach((f, i) => {
      if (f.id === id) return;
      const s = duel(db, c, f).score;
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

// ---------- すばやさ ----------

export function speedList(db, battlers, n = 40) {
  const rows = battlers.filter(Boolean).map((b) => ({ id: b.id, title: b.title, mine: true, speed: speedOf(b), scarf: b.item === 'Choice Scarf' }));
  for (const id of topMeta(db, n)) {
    const b = metaBattler(db, id);
    rows.push({ id, title: b.title, mine: false, speed: speedOf(b), scarf: b.item === 'Choice Scarf', pos: db.rankOf.get(id)?.pos });
  }
  return rows.sort((a, b) => b.speed - a.speed);
}
