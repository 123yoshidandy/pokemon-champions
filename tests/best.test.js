import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDB, megaRuleDB, canMega } from '../js/data.js';
import { buildOpponents, itemFits } from '../js/opponents.js';
import { validTeam, evaluateTeam, searchBest } from '../js/best.js';
import { memberWithItem } from '../js/team.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const shared = { dex: read('pokedex.json'), moves: read('moves.json'), names: read('names-ja.json'), meta: read('meta.json') };
const doubles = makeDB({ ...read('doubles.json'), ...shared, history: read('history/doubles.json') });
const singles = makeDB({ ...read('singles.json'), ...shared, history: read('history/singles.json') });

describe('相手の構築群', () => {
  it('規則を守った6体の構築を、重み付きで作る。同じシードなら同じ', () => {
    const opp = buildOpponents(doubles, { n: 20, seed: 3 });
    expect(opp.length).toBeGreaterThan(10);
    for (const o of opp) {
      expect(validTeam(doubles, o.team)).toBe(true);
      expect(o.weight).toBeGreaterThan(0);
    }
    expect(buildOpponents(doubles, { n: 20, seed: 3 }).map((o) => o.team.map((m) => m.id))).toEqual(opp.map((o) => o.team.map((m) => m.id)));
  });
  it('メガシンカバトル（ダブル専用）では、メガシンカできる種族だけ', () => {
    const db = megaRuleDB(doubles);
    for (const o of buildOpponents(db, { n: 10, seed: 1 })) for (const m of o.team) expect(canMega(db, m.id)).toBe(true);
  });
});

describe('一番の構築の探索', () => {
  it('フィールドのシードは、そのフィールドを張る味方がいなければ効かない', () => {
    const seed = { id: 'x', item: 'Electric Seed', moves: [] };
    const plain = { id: 'garchomp', item: '', ability: 'Rough Skin', nature: 'Jolly', moves: ['Earthquake'], sp: [0, 0, 0, 0, 0, 0] };
    const surge = { ...plain, id: 'pincurchin' in doubles.dex ? 'pincurchin' : 'garchomp', ability: 'Electric Surge' };
    expect(itemFits(doubles, [plain, seed], seed)).toBe(false);
    expect(itemFits(doubles, [surge, seed], seed)).toBe(true);
    expect(itemFits(doubles, [plain], { ...plain, item: 'Light Clay' })).toBe(false);
  });
  it('持ち物を決めた型は、持ち物に合う技にする', () => {
    const m = memberWithItem(singles, 'garchomp', 'Choice Scarf');
    for (const mv of m.moves) expect(singles.moves[mv].cat).not.toBe('Status');
  });
  it('評価は、同じシードなら同じ値', () => {
    const opp = buildOpponents(singles, { n: 5, seed: 2 });
    const team = opp[0].team;
    expect(evaluateTeam(singles, team, opp, { battles: 2, seed: 4 })).toBe(evaluateTeam(singles, team, opp, { battles: 2, seed: 4 }));
  });
  it('短い設定でも、規則を守った構築を返す', () => {
    const r = searchBest(doubles, { opponents: 5, battles: 2, finalBattles: 2, iterations: 6, rounds: 2, keep: 2, leagueBattles: 2, patience: 3, seed: 1 });
    expect(validTeam(doubles, r.team.filter(Boolean))).toBe(true);
    expect(r.winRate).toBeGreaterThan(0);
    expect(r.evaluations).toBeGreaterThan(1);
    // リーグの上位を、点（環境とリーグの勝率の平均）の順に並べる
    expect(r.ranking.length).toBeGreaterThan(1);
    for (let i = 1; i < r.ranking.length; i++) expect(r.ranking[i - 1].score).toBeGreaterThanOrEqual(r.ranking[i].score);
    for (const x of r.ranking) {
      expect(x.score).toBeCloseTo((x.envWinRate + x.leagueWinRate) / 2);
      expect(x.margin).toBeGreaterThan(0);
    }
  });
});
