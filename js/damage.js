// ダメージ計算（第9世代の式をもとにした簡易版・Lv50）
// 入れている補正: 一致・タイプ相性・天気・フィールド・急所・やけど・壁・ダブルの全体技・てだすけ
// 主な持ち物・特性・ランク補正・体重で威力が変わる技・固定ダメージの技
import { effectivenessWithAbility } from './types.js';
import { rankMod } from './stats.js';

const LEVEL = 50;

// 4096 分率の補正をかけて、五捨五超入で丸める
const pokeRound = (x) => (x % 1 > 0.5 ? Math.ceil(x) : Math.floor(x));
const applyMod = (v, mod) => pokeRound((v * mod) / 4096);
const chainMods = (mods) => mods.reduce((acc, m) => Math.round((acc * m) / 4096), 4096);

const TYPE_ITEMS = {
  Charcoal: 'Fire', 'Mystic Water': 'Water', Magnet: 'Electric', 'Miracle Seed': 'Grass', 'Never-Melt Ice': 'Ice',
  'Black Belt': 'Fighting', 'Poison Barb': 'Poison', 'Soft Sand': 'Ground', 'Sharp Beak': 'Flying', 'Twisted Spoon': 'Psychic',
  'Silver Powder': 'Bug', 'Hard Stone': 'Rock', 'Spell Tag': 'Ghost', 'Dragon Fang': 'Dragon', 'Black Glasses': 'Dark',
  'Metal Coat': 'Steel', 'Fairy Feather': 'Fairy', 'Silk Scarf': 'Normal',
};

const ATE = { Pixilate: 'Fairy', Refrigerate: 'Ice', Aerilate: 'Flying', Galvanize: 'Electric', Dragonize: 'Dragon' };

// 全体に当たる技（ダブルで 0.75 倍になる）
const SPREAD_TARGETS = new Set(['allAdjacentFoes', 'allAdjacent']);

function weightPower(kg) {
  if (kg >= 200) return 120;
  if (kg >= 100) return 100;
  if (kg >= 50) return 80;
  if (kg >= 25) return 60;
  if (kg >= 10) return 40;
  return 20;
}

function heavyPower(atkKg, defKg) {
  const r = atkKg / defKg;
  if (r >= 5) return 120;
  if (r >= 4) return 100;
  if (r >= 3) return 80;
  if (r >= 2) return 60;
  return 40;
}

const lbsToKg = (lbs) => (lbs ? lbs * 0.4536 : 50);

const isGrounded = (p) => !p.types.includes('Flying') && p.ability !== 'Levitate' && p.item !== 'Air Balloon';

/**
 * @param attacker { types, stats:[6], ability, item, boosts:{atk,def,spa,spd,spe}, status, weight, hpPct }
 * @param defender 同上
 * @param move { name, type, cat, power, target, multihit, contact }
 * @param field { doubles, weather:'sun'|'rain'|'sand'|'snow'|null, terrain:'electric'|'grassy'|'psychic'|'misty'|null,
 *                crit, reflect, lightScreen, helpingHand, spread }
 * @returns { rolls:[16], min, max, hp, minPct, maxPct, eff, hits, ko }
 */
export function calcDamage(attacker, defender, move, field = {}) {
  const hp = defender.stats[0];
  const empty = { rolls: Array(16).fill(0), min: 0, max: 0, hp, minPct: 0, maxPct: 0, eff: 0, hits: 1, ko: koChance([0], hp) };
  if (!move || move.cat === 'Status') return empty;

  // 固定ダメージ
  if (move.name === 'Seismic Toss' || move.name === 'Night Shade') {
    const immune = move.name === 'Seismic Toss' ? defender.types.includes('Ghost') : defender.types.includes('Normal');
    const d = immune ? 0 : LEVEL;
    return finish(Array(16).fill(d), hp, immune ? 0 : 1, 1);
  }

  let type = move.type;
  let power = move.power;
  const atkAbility = attacker.ability;
  const defAbility = defender.ability === 'Mold Breaker' ? null : defender.ability;
  const mods = []; // 威力の補正

  // タイプが変わる特性
  if (ATE[atkAbility] && type === 'Normal') {
    type = ATE[atkAbility];
    mods.push(4915);
  }
  if (atkAbility === 'Normalize') type = 'Normal';

  // 威力が変わる技
  if (move.name === 'Low Kick' || move.name === 'Grass Knot') power = weightPower(lbsToKg(defender.weight));
  if (move.name === 'Heavy Slam' || move.name === 'Heat Crash') power = heavyPower(lbsToKg(attacker.weight), lbsToKg(defender.weight));
  if (move.name === 'Eruption' || move.name === 'Water Spout' || move.name === 'Dragon Energy') power = Math.max(1, Math.floor((150 * (attacker.hpPct ?? 100)) / 100));
  if (move.name === 'Facade' && attacker.status) power = 140;
  if (move.name === 'Weather Ball' && field.weather) {
    power = 100;
    type = { sun: 'Fire', rain: 'Water', sand: 'Rock', snow: 'Ice' }[field.weather];
  }
  if (move.name === 'Terrain Pulse' && field.terrain && isGrounded(attacker)) {
    power = 100;
    type = { electric: 'Electric', grassy: 'Grass', psychic: 'Psychic', misty: 'Fairy' }[field.terrain];
  }
  if (!power) return empty;

  const eff = effectivenessWithAbility(type, defender.types, defAbility);
  if (eff === 0) return finish(Array(16).fill(0), hp, 0, 1);

  // 威力の補正（特性・持ち物・場）
  if (atkAbility === 'Technician' && power <= 60) mods.push(6144);
  if (atkAbility === 'Tough Claws' && move.contact) mods.push(5325);
  if (atkAbility === 'Iron Fist' && move.punch) mods.push(4915);
  if (atkAbility === 'Strong Jaw' && move.bite) mods.push(6144);
  if (atkAbility === 'Sharpness' && move.slicing) mods.push(6144);
  if (atkAbility === 'Mega Launcher' && move.pulse) mods.push(6144);
  if (atkAbility === 'Sheer Force' && move.secondary) mods.push(5325);
  if (atkAbility === 'Reckless' && move.recoil) mods.push(4915);
  if (atkAbility === 'Sand Force' && field.weather === 'sand' && ['Rock', 'Ground', 'Steel'].includes(type)) mods.push(5325);
  if ((atkAbility === 'Fairy Aura' || defAbility === 'Fairy Aura') && type === 'Fairy') mods.push(5448);
  if ((atkAbility === 'Dark Aura' || defAbility === 'Dark Aura') && type === 'Dark') mods.push(5448);
  if (atkAbility === 'Steelworker' && type === 'Steel') mods.push(6144);
  if (atkAbility === 'Transistor' && type === 'Electric') mods.push(5325);
  if (atkAbility === "Dragon's Maw" && type === 'Dragon') mods.push(6144);
  if (atkAbility === 'Rocky Payload' && type === 'Rock') mods.push(6144);
  if (TYPE_ITEMS[attacker.item] === type) mods.push(4915);
  if (field.helpingHand) mods.push(6144);
  if (isGrounded(attacker)) {
    if (field.terrain === 'electric' && type === 'Electric') mods.push(5325);
    if (field.terrain === 'grassy' && type === 'Grass') mods.push(5325);
    if (field.terrain === 'psychic' && type === 'Psychic') mods.push(5325);
  }
  if (isGrounded(defender)) {
    if (field.terrain === 'misty' && type === 'Dragon') mods.push(2048);
    if (field.terrain === 'grassy' && ['Earthquake', 'Bulldoze'].includes(move.name)) mods.push(2048);
  }
  if (defAbility === 'Dry Skin' && type === 'Fire') mods.push(5120);
  power = Math.max(1, applyMod(power, chainMods(mods)));

  // 攻撃・防御
  const physical = move.cat === 'Physical';
  const foulPlay = move.name === 'Foul Play';
  const bodyPress = move.name === 'Body Press';
  const atkSrc = foulPlay ? defender : attacker;
  const atkKey = bodyPress ? 'def' : physical ? 'atk' : 'spa';
  const atkIdx = { atk: 1, def: 2, spa: 3 }[atkKey];
  const defKey = physical || ['Psyshock', 'Psystrike', 'Secret Sword'].includes(move.name) ? 'def' : 'spd';
  const defIdx = defKey === 'def' ? 2 : 4;

  let atkBoost = atkSrc.boosts?.[atkKey] ?? 0;
  let defBoost = defender.boosts?.[defKey] ?? 0;
  if (field.crit) {
    atkBoost = Math.max(0, atkBoost);
    defBoost = Math.min(0, defBoost);
  }
  if (atkAbility === 'Unaware') defBoost = 0;
  if (defAbility === 'Unaware') atkBoost = 0;

  let A = Math.floor(atkSrc.stats[atkIdx] * rankMod(atkBoost));
  let D = Math.floor(defender.stats[defIdx] * rankMod(defBoost));

  const aMods = [];
  if (physical && (atkAbility === 'Huge Power' || atkAbility === 'Pure Power')) aMods.push(8192);
  if (physical && atkAbility === 'Guts' && attacker.status) aMods.push(6144);
  if (physical && atkAbility === 'Hustle') aMods.push(6144);
  if (!physical && atkAbility === 'Solar Power' && field.weather === 'sun') aMods.push(6144);
  if (physical && attacker.item === 'Choice Band') aMods.push(6144);
  if (!physical && attacker.item === 'Choice Specs') aMods.push(6144);
  if (atkAbility === 'Water Bubble' && type === 'Water') aMods.push(8192);
  if (['Blaze', 'Torrent', 'Overgrow', 'Swarm'].includes(atkAbility) && (attacker.hpPct ?? 100) <= 33 &&
      type === { Blaze: 'Fire', Torrent: 'Water', Overgrow: 'Grass', Swarm: 'Bug' }[atkAbility]) aMods.push(6144);
  if (defAbility === 'Thick Fat' && (type === 'Fire' || type === 'Ice')) aMods.push(2048);
  if (defAbility === 'Heatproof' && type === 'Fire') aMods.push(2048);
  if (defAbility === 'Water Bubble' && type === 'Fire') aMods.push(2048);
  if (defAbility === 'Purifying Salt' && type === 'Ghost') aMods.push(2048);
  A = Math.max(1, applyMod(A, chainMods(aMods)));

  const dMods = [];
  if (!physical && defender.item === 'Assault Vest') dMods.push(6144);
  if (physical && defAbility === 'Fur Coat') dMods.push(8192);
  if (physical && defender.item === 'Eviolite') dMods.push(6144);
  if (!physical && defender.item === 'Eviolite') dMods.push(6144);
  if (field.weather === 'snow' && physical && defender.types.includes('Ice')) dMods.push(6144);
  if (field.weather === 'sand' && !physical && defender.types.includes('Rock')) dMods.push(6144);
  D = Math.max(1, applyMod(D, chainMods(dMods)));

  // 基本のダメージ
  let base = Math.floor(Math.floor((Math.floor((2 * LEVEL) / 5 + 2) * power * A) / D) / 50) + 2;

  const spread = field.spread ?? (field.doubles && SPREAD_TARGETS.has(move.target));
  if (spread) base = applyMod(base, 3072);
  if (field.weather === 'sun' && type === 'Fire') base = applyMod(base, 6144);
  if (field.weather === 'sun' && type === 'Water') base = applyMod(base, 2048);
  if (field.weather === 'rain' && type === 'Water') base = applyMod(base, 6144);
  if (field.weather === 'rain' && type === 'Fire') base = applyMod(base, 2048);
  if (field.crit) base = Math.floor(base * 1.5);

  const stab = attacker.types.includes(type) || ['Protean', 'Libero'].includes(atkAbility);
  const stabMod = stab ? (atkAbility === 'Adaptability' ? 8192 : 6144) : 4096;

  const finalMods = [];
  const screen = physical ? field.reflect : field.lightScreen;
  if (screen && !field.crit && atkAbility !== 'Infiltrator') finalMods.push(field.doubles ? 2732 : 2048);
  if (defAbility === 'Multiscale' || defAbility === 'Shadow Shield') if ((defender.hpPct ?? 100) >= 100) finalMods.push(2048);
  if (eff > 1 && (defAbility === 'Filter' || defAbility === 'Solid Rock' || defAbility === 'Prism Armor')) finalMods.push(3072);
  if (atkAbility === 'Sniper' && field.crit) finalMods.push(6144);
  if (atkAbility === 'Tinted Lens' && eff < 1) finalMods.push(8192);
  if (defAbility === 'Fluffy' && move.contact) finalMods.push(2048);
  if (defAbility === 'Ice Scales' && !physical) finalMods.push(2048);
  if (attacker.item === 'Expert Belt' && eff > 1) finalMods.push(4915);
  if (attacker.item === 'Life Orb') finalMods.push(5324);
  const finalMod = chainMods(finalMods);

  const rolls = [];
  for (let r = 85; r <= 100; r++) {
    let d = Math.floor((base * r) / 100);
    d = applyMod(d, stabMod);
    d = Math.floor(d * eff);
    if (physical && attacker.status === 'brn' && atkAbility !== 'Guts' && move.name !== 'Facade') d = applyMod(d, 2048);
    d = applyMod(d, finalMod);
    rolls.push(Math.max(1, d));
  }

  const hits = multiHits(move, atkAbility, attacker.item);
  return finish(rolls.map((d) => d * hits), hp, eff, hits);
}

function multiHits(move, ability, item) {
  const mh = move.multihit;
  if (!mh) return 1;
  if (typeof mh === 'number') return mh;
  if (ability === 'Skill Link') return mh[1];
  if (item === 'Loaded Dice') return 4;
  return 3; // 2〜5回の技は 3 回で見積もる
}

function finish(rolls, hp, eff, hits) {
  const min = Math.min(...rolls);
  const max = Math.max(...rolls);
  return {
    rolls, min, max, hp,
    minPct: (min / hp) * 100,
    maxPct: (max / hp) * 100,
    eff, hits,
    ko: koChance(rolls, hp),
  };
}

// n 発で倒せる確率（16 通りの乱数を n 回たたみ込む）
export function koChance(rolls, hp, maxHits = 4) {
  if (Math.max(...rolls) <= 0) return { n: Infinity, chance: 0 };
  let dist = new Map([[0, 1]]);
  for (let n = 1; n <= maxHits; n++) {
    const next = new Map();
    for (const [sum, p] of dist) {
      for (const r of rolls) {
        const s = Math.min(hp, sum + r);
        next.set(s, (next.get(s) ?? 0) + p / rolls.length);
      }
    }
    dist = next;
    const chance = dist.get(hp) ?? 0;
    if (chance > 0) return { n, chance };
  }
  return { n: Math.ceil(hp / (rolls.reduce((a, b) => a + b, 0) / rolls.length)), chance: 0 };
}

export function koLabel(ko) {
  if (!Number.isFinite(ko.n)) return '効果なし';
  if (ko.chance >= 0.9999) return `確定${ko.n}発`;
  if (ko.chance > 0) return `乱数${ko.n}発 (${(ko.chance * 100).toFixed(1)}%)`;
  return `${ko.n}発以上`;
}
