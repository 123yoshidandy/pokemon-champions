import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDB, isMegaStone, megaRuleDB, canMega } from '../js/data.js';
import { fieldClash } from '../js/analysis.js';
import { suggestTeams, isSetter, STYLES, stylesFor, styleMember, bestTeam, minorAxisTeams, MINOR_FROM } from '../js/suggest.js';
import { memberBattler, megaStoneShare, MEGA_ONLY_SHARE } from '../js/team.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const shared = { dex: read('pokedex.json'), moves: read('moves.json'), names: read('names-ja.json'), meta: read('meta.json') };
const doubles = makeDB({ ...read('doubles.json'), ...shared, history: read('history/doubles.json') });
const singles = makeDB({ ...read('singles.json'), ...shared, history: read('history/singles.json') });

function expectValid(db, s) {
  const members = s.team.filter(Boolean);
  expect(members).toHaveLength(6);
  expect(new Set(members.map((m) => db.dex[m.id].base)).size).toBe(6);
  const items = members.map((m) => m.item).filter(Boolean);
  expect(new Set(items).size).toBe(items.length);
  expect(members.filter((m) => isMegaStone(db, m.id, m.item)).length).toBeLessThanOrEqual(1);
}

describe('構築の提案', () => {
  it('違う天気どうし・違うフィールドどうしを、同じ構築に入れない', () => {
    for (const db of [doubles, singles]) {
      for (const style of ['', 'sun', 'rain']) {
        for (const s of suggestTeams(db, [], { pool: 60, threats: 30, style, results: 3 })) expect(fieldClash(s.battlers), `${db.format} ${style}`).toBe(false);
      }
    }
  });
  it('メガシンカの型でしか使われていない種族を、メガなしで入れない（ふつうのルール）', () => {
    for (const db of [doubles, singles]) {
      for (const s of suggestTeams(db, [], { pool: 60, threats: 40, results: 3 })) {
        for (const m of s.team) {
          if (!isMegaStone(db, m.id, m.item)) expect(megaStoneShare(db, m.id), m.id).toBeLessThan(MEGA_ONLY_SHARE);
        }
      }
    }
  });
  it('メガシンカバトルでは、6体ともメガシンカできる種族で、メガシンカは1体', () => {
    const db = megaRuleDB(singles);
    for (const s of suggestTeams(db, [], { pool: 40, threats: 30, results: 2 })) {
      expectValid(db, s);
      for (const m of s.team) expect(canMega(db, m.id)).toBe(true);
    }
  });
  it('おまかせで1つに絞る', () => {
    const s = bestTeam(singles);
    expectValid(singles, s);
  });
  it('マイナーなポケモンを1体ずつ軸にする', () => {
    const r = minorAxisTeams(singles, { n: 3 });
    expect(r).toHaveLength(3);
    expect(new Set(r.map((s) => s.axis.id)).size).toBe(3);
    for (const s of r) {
      expectValid(singles, s);
      expect(singles.rankOf.get(s.axis.id).pos).toBeGreaterThan(MINOR_FROM);
      expect(s.team.some((m) => m?.id === s.axis.id)).toBe(true);
    }
  });
  it('滅び・バトンでは、4つの技になくても始動の技を入れた型で、始動役を入れる', () => {
    for (const [style, move] of [['perish', 'Perish Song'], ['baton', 'Baton Pass']]) {
      const r = suggestTeams(doubles, [], { style, pool: 40, threats: 30, results: 1 });
      expect(r[0].team.some((m) => m?.moves.includes(move))).toBe(true);
    }
  });
  it('介護はダブルだけ', () => {
    expect(stylesFor(doubles).map(([k]) => k)).toContain('carry');
    expect(stylesFor(singles).map(([k]) => k)).not.toContain('carry');
  });
  it('スタイルの技は、まもるを残して入れ替える', () => {
    const m = styleMember(doubles, { id: 'primarina', moves: ['Protect', 'Moonblast', 'Hyper Voice', 'Calm Mind'] }, 'perish');
    expect(m.moves).toEqual(['Protect', 'Moonblast', 'Hyper Voice', 'Perish Song']);
  });
  it('ダブルでは、味方を助ける技や特性を持つメンバーが入る', () => {
    const r = suggestTeams(doubles, [], { pool: 40, threats: 30, results: 2 });
    for (const s of r) expect(s.eval.support.length).toBeGreaterThan(0);
  });
  it('おまかせで、条件を守った構築を複数出す', () => {
    const r = suggestTeams(doubles, [], { pool: 40, threats: 30, results: 3 });
    expect(r.length).toBeGreaterThanOrEqual(2);
    for (const s of r) expectValid(doubles, s);
    // 似すぎない（4体より多くは重ならない）
    const ids = r.map((s) => new Set(s.team.map((m) => m.id)));
    expect([...ids[0]].filter((id) => ids[1].has(id)).length).toBeLessThanOrEqual(4);
  });

  it('軸のポケモンを必ず入れる', () => {
    const r = suggestTeams(doubles, ['garchomp', 'incineroar'], { pool: 40, threats: 30, results: 2 });
    for (const s of r) {
      expectValid(doubles, s);
      const ids = s.team.map((m) => m.id);
      expect(ids).toContain('garchomp');
      expect(ids).toContain('incineroar');
    }
  });

  it('スタイルを指定すると、始動役が入る', () => {
    for (const style of ['sun', 'rain', 'trickroom']) {
      const r = suggestTeams(doubles, [], { pool: 60, threats: 30, results: 1, style });
      expect(r).toHaveLength(1);
      expectValid(doubles, r[0]);
      expect(r[0].team.some((m) => isSetter(memberBattler(doubles, m), style))).toBe(true);
    }
  });

  it('シングルでも出せる', () => {
    const r = suggestTeams(singles, [], { pool: 40, threats: 30, results: 1 });
    expectValid(singles, r[0]);
  });

  it('スタイルの一覧', () => {
    expect(Object.keys(STYLES)).toEqual(['', 'sun', 'rain', 'sand', 'snow', 'trickroom', 'tailwind', 'perish', 'baton', 'carry']);
  });
});
