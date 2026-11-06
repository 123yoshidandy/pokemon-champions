import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { effectiveness, effectivenessWithAbility, defenseProfile } from '../js/types.js';
import { calcStats, speedTiers, validateSpread } from '../js/stats.js';
import { calcDamage, koChance, koLabel } from '../js/damage.js';
import { makeDB, megaForItem, battleForm, searchPokemon, searchNames, toKatakana, jaPokemon } from '../js/data.js';
import { defaultMember, memberBattler, encodeTeam, decodeTeam, toShowdown, fromShowdown, normalizeTeam } from '../js/team.js';
import { duel, threatReport, suggestTeammates, selectionPlan, defenseTable, offenseTable, speedList, metaBattler } from '../js/analysis.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const shared = { dex: read('pokedex.json'), moves: read('moves.json'), names: read('names-ja.json'), meta: read('meta.json') };
const doubles = makeDB({ ...read('doubles.json'), ...shared, history: read('history/doubles.json') });
const singles = makeDB({ ...read('singles.json'), ...shared, history: read('history/singles.json') });

const mon = (types, stats, extra = {}) => ({ types, stats, ability: null, item: null, boosts: {}, ...extra });

describe('タイプ相性', () => {
  it('倍率を掛け合わせる', () => {
    expect(effectiveness('Ground', ['Fire', 'Dark'])).toBe(2);
    expect(effectiveness('Ice', ['Dragon', 'Ground'])).toBe(4);
    expect(effectiveness('Electric', ['Ground'])).toBe(0);
    expect(effectiveness('Fire', ['Water', 'Dragon'])).toBe(0.25);
  });
  it('特性で無効・半減になる', () => {
    expect(effectivenessWithAbility('Ground', ['Steel'], 'Levitate')).toBe(0);
    expect(effectivenessWithAbility('Fire', ['Grass'], 'Thick Fat')).toBe(1);
    expect(defenseProfile(['Water'], 'Water Absorb').Water).toBe(0);
  });
});

describe('実数値', () => {
  it('能力ポイントを足して性格補正をかける', () => {
    expect(calcStats([183, 150, 115, 100, 105, 122], [2, 32, 0, 0, 0, 32], 'Jolly')).toEqual([185, 182, 115, 90, 105, 169]);
  });
  it('すばやさの目安', () => {
    expect(speedTiers(122)).toEqual({ fastest: 169, fast: 154, neutral: 122, slowest: 109 });
  });
  it('能力ポイントの上限', () => {
    expect(validateSpread([32, 32, 2, 0, 0, 0]).ok).toBe(true);
    expect(validateSpread([32, 32, 3, 0, 0, 0]).ok).toBe(false);
    expect(validateSpread([33, 0, 0, 0, 0, 0]).ok).toBe(false);
  });
});

describe('ダメージ計算', () => {
  const chomp = mon(['Dragon', 'Ground'], [183, 200, 115, 90, 105, 154]);
  const incin = mon(['Fire', 'Dark'], [170, 135, 110, 100, 110, 80]);
  const eq = { name: 'Earthquake', type: 'Ground', cat: 'Physical', power: 100, target: 'allAdjacent' };

  it('手計算の値と一致する（シングル）', () => {
    const r = calcDamage(chomp, incin, eq, {});
    expect(r.rolls[0]).toBe(206);
    expect(r.rolls[15]).toBe(246);
    expect(r.ko).toEqual({ n: 1, chance: 1 });
  });
  it('ダブルの全体技は 0.75 倍', () => {
    const r = calcDamage(chomp, incin, eq, { doubles: true });
    expect(r.max).toBeLessThan(246);
    expect(r.max).toBeGreaterThan(170);
  });
  it('無効のタイプは 0', () => {
    const r = calcDamage(chomp, mon(['Flying'], [150, 100, 100, 100, 100, 100]), eq, {});
    expect(r.max).toBe(0);
    expect(koLabel(r.ko)).toBe('効果なし');
  });
  it('持ち物と天気で増える', () => {
    const base = calcDamage(chomp, incin, eq, {}).max;
    expect(calcDamage({ ...chomp, item: 'Life Orb' }, incin, eq, {}).max).toBeGreaterThan(base);
    const fire = { name: 'Flamethrower', type: 'Fire', cat: 'Special', power: 90 };
    expect(calcDamage(incin, chomp, fire, { weather: 'sun' }).max).toBeGreaterThan(calcDamage(incin, chomp, fire, {}).max);
  });
  it('乱数の確率', () => {
    expect(koChance([40, 50], 100)).toEqual({ n: 2, chance: 0.25 });
    expect(koLabel({ n: 2, chance: 0.25 })).toBe('乱数2発 (25.0%)');
  });
});

describe('データ', () => {
  it('ランキングと採用データがそろっている', () => {
    expect(doubles.ranking.length).toBeGreaterThan(100);
    for (const r of doubles.ranking) expect(doubles.dex[r.id]).toBeTruthy();
  });
  it('メガストーンでメガシンカ後のフォルムになる', () => {
    expect(megaForItem(doubles.dex.garchomp, 'Garchompite Z').title).toBe('Mega Garchomp Z');
    expect(megaForItem(doubles.dex.garchomp, 'Garchompite').title).toBe('Mega Garchomp');
    expect(megaForItem(doubles.dex.garchomp, 'Charizardite X')).toBeNull();
    expect(battleForm(doubles, 'charizard', 'Charizardite X').types).toEqual(['Fire', 'Dragon']);
  });
  it('ひらがな・カタカナ・英語で探せる', () => {
    expect(toKatakana('がぶりあす')).toBe('ガブリアス');
    expect(searchPokemon(doubles, 'がぶ')[0]).toBe('garchomp');
    expect(searchPokemon(doubles, 'Garch')[0]).toBe('garchomp');
    expect(searchNames(['Earthquake', 'Rock Slide'], (m) => doubles.names.moves[m], 'いわ')).toEqual(['Rock Slide']);
    expect(jaPokemon(doubles, 'rotomwash')).toBe('ロトム(ウォッシュ)');
  });
});

describe('構築', () => {
  it('よく使われる型で埋め、持ち物を重ねない', () => {
    const a = defaultMember(doubles, 'garchomp');
    expect(a.moves.filter(Boolean).length).toBe(4);
    const b = defaultMember(doubles, 'garchomp', [{ ...a, id: 'sneasler' }]);
    expect(b.item).not.toBe(a.item);
  });
  it('メガストーンは 1 体だけ', () => {
    const megaHolder = { ...defaultMember(doubles, 'charizard'), item: 'Charizardite Y' };
    const g = defaultMember(doubles, 'garchomp', [megaHolder]);
    expect(g.item).not.toMatch(/ite( [XYZ])?$/);
  });
  it('URL の文字列で往復できる', () => {
    const team = normalizeTeam([defaultMember(doubles, 'garchomp'), null, defaultMember(doubles, 'incineroar')]);
    expect(decodeTeam(encodeTeam(team))).toEqual(team);
    expect(decodeTeam('!!!')).toBeNull();
  });
  it('Showdown 形式で往復できる', () => {
    const team = normalizeTeam([defaultMember(doubles, 'garchomp'), defaultMember(doubles, 'rotomwash')]);
    const back = fromShowdown(doubles, toShowdown(doubles, team));
    expect(back.map((m) => m?.id)).toEqual(team.map((m) => m?.id));
    expect(back[0].moves).toEqual(team[0].moves);
    expect(back[0].sp).toEqual(team[0].sp);
  });
});

describe('分析', () => {
  const team = normalizeTeam(['garchomp', 'incineroar', 'rillaboom', 'whimsicott'].map((id) => defaultMember(doubles, id)));
  const battlers = team.map((m) => m && memberBattler(doubles, m));

  it('対面の有利さは -1〜1 で、向きを変えると逆になる', () => {
    const a = metaBattler(doubles, 'garchomp');
    const b = metaBattler(doubles, 'incineroar');
    const d1 = duel(doubles, a, b);
    const d2 = duel(doubles, b, a);
    expect(Math.abs(d1.score)).toBeLessThanOrEqual(1);
    expect(d1.score).toBeCloseTo(-d2.score);
  });
  it('相性表は 18 タイプ', () => {
    expect(defenseTable(battlers)).toHaveLength(18);
    expect(offenseTable(doubles, battlers)).toHaveLength(18);
  });
  it('環境上位の相性', () => {
    const r = threatReport(doubles, battlers, 20);
    expect(r).toHaveLength(20);
    expect(r[0].duels).toHaveLength(4);
  });
  it('相方の提案に、チームと同じポケモンは出ない', () => {
    const s = suggestTeammates(doubles, team, { limit: 10 });
    expect(s).toHaveLength(10);
    for (const x of s) expect(['garchomp', 'incineroar', 'rillaboom', 'whimsicott']).not.toContain(x.id);
  });
  it('選出はダブル 4 体・シングル 3 体', () => {
    const full = normalizeTeam(['garchomp', 'incineroar', 'rillaboom', 'whimsicott', 'sneasler', 'kingambit'].map((id) => defaultMember(doubles, id)));
    const opp = ['charizard', 'indeedeef', 'basculegion', 'raichu', 'archaludon', 'pelipper'];
    const d = selectionPlan(doubles, full, opp);
    expect(d.plans[0].members).toHaveLength(4);
    expect(d.plans[0].lead).toHaveLength(2);
    const s = selectionPlan(singles, full, opp);
    expect(s.plans[0].members).toHaveLength(3);
    expect(s.plans[0].lead).toHaveLength(1);
  });
  it('すばやさの並び', () => {
    const list = speedList(doubles, battlers, 10);
    expect(list).toHaveLength(14);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].speed).toBeGreaterThanOrEqual(list[i].speed);
  });
});
