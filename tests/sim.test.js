import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDB } from '../js/data.js';
import { rng, battle, matchup, _internal } from '../js/sim.js';
import { defaultMember } from '../js/team.js';

const { newBattle, runTurn, chooseAction, speedOf } = _internal;

// 技と種族を絞った小さな db
const MOVES = {
  Strike: { type: 'Normal', cat: 'Physical', power: 80, acc: 100, prio: 0, target: 'normal' },
  Blast: { type: 'Fire', cat: 'Special', power: 90, acc: 100, prio: 0, target: 'normal' },
  Wave: { type: 'Water', cat: 'Special', power: 90, acc: 100, prio: 0, target: 'allAdjacentFoes' },
  'Solar Beam': { type: 'Grass', cat: 'Special', power: 120, acc: 100, prio: 0, target: 'normal' },
  Protect: { type: 'Normal', cat: 'Status', power: 0, acc: null, prio: 4, target: 'self' },
  'Fake Out': { type: 'Normal', cat: 'Physical', power: 40, acc: 100, prio: 3, target: 'normal', contact: true },
  Tailwind: { type: 'Flying', cat: 'Status', power: 0, acc: null, prio: 0, target: 'allySide' },
  'Trick Room': { type: 'Psychic', cat: 'Status', power: 0, acc: null, prio: -7, target: 'all' },
};
const mon = (name, spe, types = ['Normal'], abilities = ['']) => ({ name, base: name, types, abilities, stats: [180, 120, 100, 120, 100, spe], weight: 50, megas: [] });
const DEX = { fast: mon('Fast', 150), slow: mon('Slow', 50), mid: mon('Mid', 100), sunny: mon('Sunny', 90, ['Fire'], ['Drought']), wall: mon('Wall', 60, ['Water']) };
const tiny = (doubles) => makeDB({ format: doubles ? 'doubles' : 'singles', ranking: Object.keys(DEX).map((id, i) => ({ id, pos: i + 1 })), usage: {}, dex: DEX, moves: MOVES, names: { pokemon: {}, moves: {}, items: {}, abilities: {}, natures: {} }, history: { dates: [], ranks: {} }, meta: {} });
const m = (id, moves, extra = {}) => ({ id, item: '', ability: DEX[id].abilities[0], nature: 'Serious', moves, sp: [0, 0, 0, 0, 0, 0], ...extra });
const start = (db, a, b, seed = 1) => newBattle(db, [a, b], [a.map((x) => x.id), b.map((x) => x.id)], seed);

describe('シミュレーター', () => {
  it('シード付きの乱数は、同じシードなら同じ列', () => {
    const a = rng(5);
    const b = rng(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('ダメージは、計算の乱数の範囲に入る', () => {
    const db = tiny(false);
    const st = start(db, [m('fast', ['Strike'])], [m('wall', ['Strike'])]);
    runTurn(st);
    const lost = st.sides[1].mons[0].max - st.sides[1].mons[0].hp;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(st.sides[1].mons[0].max);
  });

  it('速い方が先に動き、トリックルーム・おいかぜで順番が変わる', () => {
    const db = tiny(false);
    const st = start(db, [m('fast', ['Strike'])], [m('slow', ['Strike'])]);
    const [f, s] = [st.sides[0].mons[0], st.sides[1].mons[0]];
    expect(speedOf(st, f)).toBeGreaterThan(speedOf(st, s));
    st.sides[1].tailwind = 2;
    expect(speedOf(st, s)).toBe(100);
    const scarf = start(db, [m('fast', ['Strike'])], [m('mid', ['Strike'], { item: 'Choice Scarf' })]);
    expect(speedOf(scarf, scarf.sides[1].mons[0])).toBe(150);
  });

  it('こだわりアイテムでは、最初に使った技に固定される', () => {
    const db = tiny(false);
    const st = start(db, [m('fast', ['Strike', 'Blast'], { item: 'Choice Specs' })], [m('wall', ['Strike'])]);
    runTurn(st);
    const me = st.sides[0].mons[0];
    expect(me.lock).toBeTruthy();
    expect(chooseAction(st, me).move).toBe(me.lock);
  });

  it('ひでりで、はれになり、ソーラービームをためずに撃つ', () => {
    const db = tiny(false);
    const st = start(db, [m('sunny', ['Solar Beam'])], [m('wall', ['Strike'])]);
    expect(st.weather).toBe('sun');
    runTurn(st);
    expect(st.sides[1].mons[0].hp).toBeLessThan(st.sides[1].mons[0].max);
    // はれでなければ、1ターン目はためるだけ
    const st2 = start(db, [m('fast', ['Solar Beam'])], [m('wall', ['Strike'])]);
    runTurn(st2);
    expect(st2.sides[1].mons[0].hp).toBe(st2.sides[1].mons[0].max);
    expect(st2.sides[0].mons[0].charging).toBeTruthy();
  });

  it('まもるで、攻撃を受けない', () => {
    const db = tiny(false);
    const st = start(db, [m('fast', ['Strike'])], [m('wall', ['Protect'])]);
    const wall = st.sides[1].mons[0];
    // 倒されそうなときに半分の確率でまもるので、まもったターンを探す
    let blocked = false;
    for (let seed = 1; seed < 30 && !blocked; seed++) {
      const s = start(db, [m('fast', ['Strike'])], [m('wall', ['Protect'])], seed);
      s.sides[1].mons[0].hp = 10;
      runTurn(s);
      if (!s.sides[1].mons[0].fainted && s.sides[1].mons[0].hp === 10) blocked = true;
    }
    expect(blocked).toBe(true);
    expect(wall.hp).toBe(wall.max);
  });

  it('ねこだましで、遅い相手はそのターンに動けない', () => {
    const db = tiny(false);
    const st = start(db, [m('slow', ['Fake Out', 'Strike'])], [m('fast', ['Strike'])]);
    runTurn(st);
    // ねこだましは優先度が高いので先に当たり、相手はひるんで攻撃しない
    expect(st.sides[0].mons[0].hp).toBe(st.sides[0].mons[0].max);
    expect(st.sides[1].mons[0].hp).toBeLessThan(st.sides[1].mons[0].max);
  });

  it('ダブルの全体技は、2体に当たる', () => {
    const db = tiny(true);
    const st = start(db, [m('fast', ['Wave']), m('mid', ['Strike'])], [m('slow', ['Strike']), m('wall', ['Strike'])]);
    runTurn(st);
    for (const x of st.sides[1].active) expect(x.hp).toBeLessThan(x.max);
  });

  it('同じシードなら、同じ結果', () => {
    const db = tiny(true);
    const a = [m('fast', ['Strike', 'Wave']), m('mid', ['Blast']), m('sunny', ['Solar Beam', 'Blast']), m('wall', ['Wave'])];
    const b = [m('slow', ['Strike', 'Trick Room']), m('mid', ['Strike', 'Tailwind']), m('wall', ['Wave', 'Protect']), m('fast', ['Fake Out', 'Strike'])];
    const ids = (t) => t.map((x) => x.id);
    expect(battle(db, [a, b], [ids(a), ids(b)], 42)).toBe(battle(db, [a, b], [ids(a), ids(b)], 42));
  });
});

describe('偏り', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
  const db = makeDB({ ...read('doubles.json'), dex: read('pokedex.json'), moves: read('moves.json'), names: read('names-ja.json'), meta: read('meta.json'), history: read('history/doubles.json') });
  it('同じ構築どうしなら、どちらの側でもほぼ五分（控えは両方が同時に選ぶ）', () => {
    const team = [];
    for (const id of ['charizard', 'garchomp', 'sneasler', 'kingambit', 'farigiraf', 'grimmsnarl']) team.push(defaultMember(db, id, team));
    const w = matchup(db, team, team, { n: 300, seed: 6 });
    expect(Math.abs(w - 0.5)).toBeLessThan(0.08);
  });
});

describe('有名な対面（よく使われる型どうし、シングル）', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
  const db = makeDB({ ...read('singles.json'), dex: read('pokedex.json'), moves: read('moves.json'), names: read('names-ja.json'), meta: read('meta.json'), history: read('history/singles.json') });
  // メガシンカの型だと別の相性になるので、メガなしの型で比べる
  const solo = (id) => [defaultMember(db, id, [], { noMega: true })];
  const win = (a, b) => matchup(db, solo(a), solo(b), { n: 60, seed: 9 });

  it('タイプ相性どおりの勝ち負けになる', () => {
    // じしん → サーフゴー、フェアリー → ガブリアス、みず → リザードン、あく → サーフゴー、はがね → ニンフィア
    expect(win('garchomp', 'gholdengo')).toBeGreaterThan(0.7);
    expect(win('sylveon', 'garchomp')).toBeGreaterThan(0.7);
    expect(win('primarina', 'charizard')).toBeGreaterThan(0.7);
    expect(win('kingambit', 'gholdengo')).toBeGreaterThan(0.7);
    expect(win('gholdengo', 'sylveon')).toBeGreaterThan(0.7);
  });
});
