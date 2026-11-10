import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { effectiveness, effectivenessWithAbility, defenseProfile } from '../js/types.js';
import { calcStats, speedTiers, validateSpread, groupSpreads } from '../js/stats.js';
import { calcDamage, koChance, koLabel } from '../js/damage.js';
import { makeDB, megaForItem, battleForm, searchPokemon, searchNames, toKatakana, jaPokemon, spriteUrls, megaRuleDB, canMega } from '../js/data.js';
import { defaultMember, memberBattler, encodeTeam, decodeTeam, toShowdown, fromShowdown, normalizeTeam, movesForItem } from '../js/team.js';
import { duel, threatReport, suggestTeammates, selectionPlan, defenseTable, offenseTable, speedList, metaBattler, trendAttackType, typeReach, teamSupport, supportedDuel, bulkPlans, basicPlan, fieldClash, weatherMisfits } from '../js/analysis.js';

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
  it('能力ポイントの配分を、振った能力の組み合わせでまとめる', () => {
    const g = groupSpreads([[30, [32, 32, 2, 0, 0, 0]], [20, [32, 2, 32, 0, 0, 0]], [10, [32, 32, 0, 0, 2, 0]]]);
    expect(g.map((x) => [x.key, x.pct])).toEqual([['HA', 40], ['HB', 20]]);
    expect(g[0].spreads[0][1]).toEqual([32, 32, 2, 0, 0, 0]);
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
    // ポケモン徹底攻略へのリンクに使う全国図鑑の番号
    for (const d of Object.values(doubles.dex)) expect(d.num).toBeGreaterThan(0);
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
  it('絵の URL は、フォルムとメガシンカの名前を付け、元のすがたの絵を控えにする', () => {
    expect(spriteUrls(doubles, 'rotomwash').map((u) => u.split('/').pop())).toEqual(['rotom-wash.png']);
    expect(spriteUrls(doubles, 'garchomp', 'Garchompite Z').map((u) => u.split('/').pop())).toEqual(['garchomp-megaz.png', 'garchomp.png']);
  });
});

describe('メガシンカバトル', () => {
  const mega = megaRuleDB(doubles);
  it('メガシンカできる種族だけに絞り、順位を1から振り直す', () => {
    expect(mega.megaRule).toBe(true);
    expect(mega.ranking.length).toBeGreaterThan(30);
    expect(mega.ranking.length).toBeLessThan(doubles.ranking.length);
    mega.ranking.forEach((r, i) => {
      expect(canMega(mega, r.id)).toBe(true);
      expect(r.pos).toBe(i + 1);
    });
    // 地方のすがたは、元の種族にメガシンカがあっても使えない
    expect(canMega(doubles, 'raichualola')).toBe(false);
  });
  it('一緒に使われるポケモンと、順位の推移も絞る', () => {
    for (const u of Object.values(mega.usage)) for (const id of u.teammates) expect(canMega(mega, id)).toBe(true);
    mega.history.dates.forEach((_, col) => {
      const pos = Object.values(mega.history.ranks).map((a) => a[col]).filter((v) => v != null).sort((a, b) => a - b);
      pos.forEach((p, i) => expect(p).toBe(i + 1));
    });
  });
  it('同じ db を渡すと、同じものを返す', () => {
    expect(megaRuleDB(doubles)).toBe(mega);
    expect(megaRuleDB(mega)).toBe(mega);
  });
});

describe('構築', () => {
  it('よく使われる型で埋め、持ち物を重ねない', () => {
    const a = defaultMember(doubles, 'garchomp');
    expect(a.moves.filter(Boolean).length).toBe(4);
    const b = defaultMember(doubles, 'garchomp', [{ ...a, id: 'sneasler' }]);
    expect(b.item).not.toBe(a.item);
  });
  it('こだわりアイテム・とつげきチョッキでは、変化技とねこだましを持たせない', () => {
    const NO_STATUS = ['Choice Scarf', 'Choice Band', 'Choice Specs', 'Assault Vest'];
    for (const db of [doubles, singles]) {
      for (const r of db.ranking) {
        const m = defaultMember(db, r.id, [], { noMega: true });
        if (!NO_STATUS.includes(m.item)) continue;
        for (const mv of m.moves) expect(db.moves[mv]?.cat, `${r.id} ${m.item} ${mv}`).not.toBe('Status');
        expect(m.moves).not.toContain('Fake Out');
      }
    }
  });
  it('攻撃技が4つそろわない持ち物は選ばない', () => {
    const u = { moves: [['Protect', 90], ['Earthquake', 80], ['Tailwind', 70]] };
    expect(movesForItem(doubles, u, 'Choice Scarf')).toBeNull();
    expect(movesForItem(doubles, u, 'Sitrus Berry')).toEqual(['Protect', 'Earthquake', 'Tailwind']);
  });
  it('メガストーンが持てないリザードンを、まもる入りのこだわりスカーフにしない', () => {
    const megaHolder = { ...defaultMember(doubles, 'garchomp'), item: 'Garchompite Z' };
    const z = defaultMember(doubles, 'charizard', [megaHolder]);
    expect(z.item).not.toMatch(/ite( [XYZ])?$/);
    if (z.item.startsWith('Choice')) expect(z.moves).not.toContain('Protect');
    // 特殊の技なら、とくこうを下げる性格にしない
    expect(['Adamant', 'Jolly', 'Impish', 'Careful']).not.toContain(z.nature);
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

describe('対面', () => {
  // 技を絞った小さな db と、能力だけを決めたポケモンで比べる
  const db = { doubles: false, moves: {
    Strike: { type: 'Normal', cat: 'Physical', power: 80, acc: 100, prio: 0, target: 'normal' },
    Quick: { type: 'Normal', cat: 'Physical', power: 40, acc: 100, prio: 1, target: 'normal' },
  } };
  const p = (o = {}, spe = 100) => ({ id: 'x', types: ['Water'], stats: [170, 130, 100, 100, 100, spe], ability: '', item: '', moves: ['Strike'], boosts: {}, ...o });

  it('同じ打点で先に動けるだけなら、大きな有利にはしない', () => {
    const d = duel(db, p({}, 101), p());
    expect(d.score).toBeGreaterThan(0);
    expect(d.score).toBeLessThan(0.75);
  });
  it('マルチスケイルは、HP が満タンのときだけ効く', () => {
    // 毎回半分なら 8 発かかるところ、2 発目からは等倍なので 4 発で倒れ、先に 4 発当てた方が勝つ
    const d = duel(db, p(), p({ ability: 'Multiscale' }, 99));
    expect(d.b.avgPct).toBeGreaterThan(d.a.avgPct);
    expect(d.score).toBeLessThan(0);
    expect(d.score).toBeGreaterThan(-0.5);
  });
  it('いのちのたまの反動で、自分のマルチスケイルが切れる', () => {
    const plain = duel(db, p(), p({ ability: 'Multiscale' }, 99)).score;
    const orb = duel(db, p(), p({ ability: 'Multiscale', item: 'Life Orb' }, 99)).score;
    expect(orb).toBeGreaterThan(plain);
  });
  it('遅くても、先制技で倒しきれるなら先に倒す', () => {
    const strong = (o) => p({ stats: [170, 160, 100, 100, 100, 99], ...o });
    expect(duel(db, strong({ moves: ['Strike', 'Quick'] }), p({}, 100)).score).toBeGreaterThan(duel(db, strong(), p({}, 100)).score);
  });
  it('こだわりアイテムでは、途中で先制技に切り替えない', () => {
    const strong = (o) => p({ stats: [170, 160, 100, 100, 100, 99], item: 'Choice Band', ...o });
    expect(duel(db, strong({ moves: ['Strike', 'Quick'] }), p({}, 100)).score).toBe(duel(db, strong(), p({}, 100)).score);
  });
  it('ソーラービームは、はれでなければ2ターンに1回', () => {
    const sdb = { doubles: false, moves: { 'Solar Beam': { type: 'Grass', cat: 'Special', power: 120, acc: 100, prio: 0, target: 'normal' } } };
    const user = (ability) => p({ types: ['Fire'], moves: ['Solar Beam'], ability });
    const plain = duel(sdb, user(''), p()).a.avgPct;
    const sun = duel(sdb, user('Drought'), p()).a.avgPct;
    expect(sun).toBeCloseTo(plain * 2, 0);
  });
  it('おいかぜ・トリックルーム・ねこだましで、先に動ける', () => {
    const slow = p({}, 99);
    expect(duel(db, slow, p()).score).toBeLessThan(0);
    expect(duel(db, slow, p(), { tailwind: true }).score).toBeGreaterThan(0);
    expect(duel(db, slow, p(), { trickRoom: true }).score).toBeGreaterThan(0);
    expect(duel(db, slow, p(), { fakeOut: true }).score).toBeGreaterThan(0);
  });
});

describe('環境の傾向', () => {
  it('ねこだましや、能力を下げるための技は、攻撃技のタイプに数えない', () => {
    const b = { ability: '' };
    expect(trendAttackType(doubles.moves['Fake Out'], 'Fake Out', b)).toBeNull();
    expect(trendAttackType(doubles.moves['Icy Wind'], 'Icy Wind', b)).toBeNull();
    expect(trendAttackType(doubles.moves['Rock Slide'], 'Rock Slide', b)).toBe('Rock');
  });
  it('連続技は回数をかけ、ウェザーボールは天気のタイプで数える', () => {
    expect(trendAttackType({ type: 'Water', cat: 'Physical', power: 25, multihit: [2, 5] }, 'X', {})).toBe('Water');
    expect(trendAttackType(doubles.moves['Weather Ball'], 'Weather Ball', { ability: 'Drought' })).toBe('Fire');
    expect(trendAttackType(doubles.moves['Weather Ball'], 'Weather Ball', { ability: '' })).toBeNull();
  });
  it('攻撃のタイプの通りは 18 タイプで、通りやすい順', () => {
    const r = typeReach(doubles, 30);
    expect(r).toHaveLength(18);
    for (const x of r) expect(x.weak + x.resist).toBeLessThanOrEqual(30);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].weak - r[i - 1].resist).toBeGreaterThanOrEqual(r[i].weak - r[i].resist);
  });
});

describe('天気とフィールド', () => {
  const b = (ability, moves = [], id = ability) => ({ id, ability, moves, item: '' });
  it('違う天気どうし・違うフィールドどうしはぶつかる', () => {
    expect(fieldClash([b('Drought'), b('Drizzle')])).toBe(true);
    expect(fieldClash([b('Drought'), b('Drought', [], 'x')])).toBe(false);
    expect(fieldClash([b('Grassy Surge'), b('Psychic Surge')])).toBe(true);
    expect(fieldClash([b('Drought'), b('Psychic Surge')])).toBe(false);
  });
  it('天気に頼るのに、構築の天気と合わないメンバー', () => {
    expect(weatherMisfits([b('Swift Swim')]).map((x) => x.need)).toEqual(['rain']);
    expect(weatherMisfits([b('Swift Swim'), b('Drizzle')])).toEqual([]);
    expect(weatherMisfits([b('', ['Solar Beam']), b('Drizzle')]).map((x) => x.need)).toEqual(['sun']);
    expect(weatherMisfits([b('', ['Weather Ball']), b('Sand Stream')])).toEqual([]);
  });
  it('相方の提案に、いまの構築とぶつかる天気の起こし役は出ない', () => {
    const team = normalizeTeam([{ ...defaultMember(doubles, 'charizard'), item: 'Charizardite Y' }]);
    const mates = suggestTeammates(doubles, team, { limit: 30 });
    for (const m of mates) expect(fieldClash([memberBattler(doubles, team[0]), m.battler])).toBe(false);
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
  it('ダブルでは、構築の支援（おいかぜなど）で勝ち筋が増える。シングルでは入れない', () => {
    const sup = teamSupport(doubles, battlers);
    expect(sup.tailwind).toBe(true);
    expect(teamSupport(singles, battlers)).toEqual({});
    const foe = metaBattler(doubles, 'sneasler');
    for (const b of battlers.filter(Boolean)) expect(supportedDuel(doubles, b, foe, sup).score).toBeGreaterThanOrEqual(duel(doubles, b, foe).score);
  });
  it('耐久調整: 出した配分なら、その技を確定で耐える', () => {
    const m = defaultMember(doubles, 'incineroar');
    const plans = bulkPlans(doubles, m);
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans.filter((x) => x.reachable)) {
      const foe = metaBattler(doubles, p.foe);
      const r = calcDamage(foe, memberBattler(doubles, { ...m, sp: p.sp }), { name: p.move, ...doubles.moves[p.move] }, { doubles: true });
      expect(r.max).toBeLessThan(r.hp);
      expect(validateSpread(p.sp).ok).toBe(true);
    }
  });
  it('基本選出: ダブルは4体で先発2体、おいかぜの始動役がいれば先発に入る。シングルは3体で先発1体', () => {
    const ids = ['charizard', 'floetteeternal', 'whimsicott', 'basculegion', 'incineroar', 'garchomp'];
    const make = (db) => { const t = []; for (const id of ids) t.push(defaultMember(db, id, t)); return t.map((m) => memberBattler(db, m)); };
    const d = basicPlan(doubles, make(doubles));
    expect(d.members).toHaveLength(4);
    expect(d.lead).toHaveLength(2);
    if (d.members.some((b) => b.moves.includes('Tailwind'))) expect(d.lead.some((b) => b.moves.includes('Tailwind'))).toBe(true);
    expect(d.plan[0]).toMatch(/^先発/);
    const s = basicPlan(singles, make(singles));
    expect(s.members).toHaveLength(3);
    expect(s.lead).toHaveLength(1);
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
