// 構築（チーム）のデータ
// member = { id, item, ability, nature, moves:[4], sp:[6] }
import { usageOf, battleForm, jaPokemon, jaItem, jaAbility, jaMove, jaNature, isMegaStone, moveData, isAttack } from './data.js';
import { calcStats, STATS, SP_MAX, NATURES } from './stats.js';

export const TEAM_SIZE = 6;

// こだわりアイテム（固定される技の分類。スカーフはどちらでもよい）と、変化技を使えない持ち物
const CHOICE = { 'Choice Scarf': null, 'Choice Band': 'Physical', 'Choice Specs': 'Special' };
const NO_STATUS = new Set([...Object.keys(CHOICE), 'Assault Vest']);
// 1ターン目にしか使えないので、技が固定される持ち物では使わない
const FIRST_TURN_ONLY = new Set(['Fake Out', 'First Impression']);
// メガストーンが選べないときに、これより採用率の低い持ち物には落とさない
const FALLBACK_ITEM_MIN_PCT = 1;

// 持ち物に合う技（使用率の順）。合わせられなければ null
export function movesForItem(db, u, item) {
  const all = [...new Set(u.moves.map((x) => x[0]))];
  if (!NO_STATUS.has(item)) return all.slice(0, 4);
  const attacks = all.filter((m) => isAttack(moveData(db, m)) && !FIRST_TURN_ONLY.has(m));
  if (attacks.length < 4) return null;
  const cat = CHOICE[item];
  if (!cat) return attacks.slice(0, 4);
  // こだわりハチマキ・メガネは、合う分類の技が 3 つ以上あるときだけ（足りない分は、ほかの攻撃技で埋める）
  const match = attacks.filter((m) => moveData(db, m).cat === cat);
  if (match.length < 3) return null;
  return [...match, ...attacks.filter((m) => !match.includes(m))].slice(0, 4);
}

// 技に合う性格と能力ポイント（攻撃技が物理寄りなら、こうげきを下げない性格と、こうげきに振った配分）
function natureAndSpread(db, u, moves, item) {
  let phys = 0;
  let spec = 0;
  for (const m of moves) {
    const mv = moveData(db, m);
    const pct = u.moves.find(([n]) => n === m)?.[1] ?? 1;
    if (mv?.cat === 'Physical') phys += pct;
    else if (mv?.cat === 'Special') spec += pct;
  }
  const main = phys > spec * 1.5 ? 'atk' : spec > phys * 1.5 ? 'spa' : null;
  const natures = u.natures.map((x) => x[0]);
  const nature = (main && natures.find((n) => NATURES[n]?.[1] !== main)) || natures[0] || 'Serious';
  const spreads = u.spreads.map((x) => x[1]);
  const idx = { atk: 1, spa: 3 }[main];
  let pool = main ? spreads.filter((sp) => sp[idx] >= SP_MAX / 2) : spreads;
  // きあいのタスキは、HP に振らない配分を選ぶ
  if (item === 'Focus Sash' && pool.some((sp) => sp[0] < SP_MAX / 2)) pool = pool.filter((sp) => sp[0] < SP_MAX / 2);
  return { nature, sp: (pool[0] ?? spreads[0])?.slice() ?? [0, 0, 0, 0, 0, 0] };
}

// よく使われている型で埋める。持ち物はチーム内で重ならないようにし、技・性格・能力ポイントは持ち物に合わせる
// noMega: メガストーンを持たせない（チームにすでにメガシンカがいる前提で比べるとき）
export function defaultMember(db, id, team = [], { noMega = false } = {}) {
  const u = usageOf(db, id);
  const takenItems = new Set(team.filter((m) => m && m.id !== id).map((m) => m.item));
  const megaTaken = noMega || team.some((m) => m && m.id !== id && isMegaStone(db, m.id, m.item));
  const usable = u.items.filter(([i]) => !takenItems.has(i) && !(megaTaken && isMegaStone(db, id, i)) && movesForItem(db, u, i));
  // メガストーンを持てないときは、採用率の低すぎる持ち物には落とさない（なければ、残りの一番目）
  const fallback = megaTaken && u.items.some(([i]) => isMegaStone(db, id, i));
  const item = ((fallback && usable.find(([, p]) => (p ?? 0) >= FALLBACK_ITEM_MIN_PCT)) || usable[0])?.[0] ?? '';
  return memberWithItem(db, id, item) ?? memberWithItem(db, id, '');
}

// 持ち物を決めた型（技・性格・能力ポイント・特性を持ち物に合わせる）。持ち物に合う技がそろわなければ null
export function memberWithItem(db, id, item) {
  const u = usageOf(db, id);
  const moves = movesForItem(db, u, item);
  if (!moves) return null;
  const form = battleForm(db, id, item);
  const ability = form?.mega ? form.abilities[0] : u.abilities[0]?.[0] ?? form?.abilities[0] ?? '';
  const { nature, sp } = natureAndSpread(db, u, moves, item);
  return {
    id,
    item,
    ability,
    nature,
    moves: moves.concat(['', '', '', '']).slice(0, 4),
    sp,
  };
}

// メガストーンの採用率がこれ以上なら、使用率データはほとんどメガシンカの型のものとみなす
export const MEGA_ONLY_SHARE = 50;

// メガストーンの採用率（%）。これが高い種族の使用率データは、ほとんどメガシンカの型のもの
export const megaStoneShare = (db, id) =>
  usageOf(db, id).items.filter(([i]) => isMegaStone(db, id, i)).reduce((a, [, p]) => a + (p ?? 0), 0);

// 対戦で使う形（実数値やタイプを含む）にする
export function memberBattler(db, m) {
  const form = battleForm(db, m.id, m.item);
  if (!form) return null;
  // メガシンカ後は、そのフォルムの特性になる
  const ability = form.mega ? form.abilities[0] : m.ability || form.abilities[0];
  return {
    ...form,
    item: m.item,
    ability,
    nature: m.nature,
    sp: m.sp,
    moves: m.moves.filter(Boolean),
    stats: calcStats(form.stats, m.sp, m.nature),
    boosts: {},
  };
}

// ---------- 共有（URL） ----------

export function encodeTeam(team) {
  const json = JSON.stringify(team.map((m) => (m ? [m.id, m.item, m.ability, m.nature, m.moves, m.sp] : 0)));
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTeam(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const arr = JSON.parse(json);
    return normalizeTeam(arr.map((x) => (x ? { id: x[0], item: x[1], ability: x[2], nature: x[3], moves: x[4], sp: x[5] } : null)));
  } catch {
    return null;
  }
}

export function normalizeTeam(team) {
  const out = (team ?? []).slice(0, TEAM_SIZE).map((m) =>
    m && m.id
      ? {
          id: m.id,
          item: m.item ?? '',
          ability: m.ability ?? '',
          nature: m.nature ?? 'Serious',
          moves: [...(m.moves ?? []), '', '', '', ''].slice(0, 4),
          sp: [...(m.sp ?? []), 0, 0, 0, 0, 0, 0].slice(0, 6).map((v) => Math.max(0, Math.min(SP_MAX, Number(v) || 0))),
        }
      : null,
  );
  while (out.length < TEAM_SIZE) out.push(null);
  return out;
}

// ---------- Showdown 形式 ----------

const SD_STAT = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

export function toShowdown(db, team) {
  return team
    .filter(Boolean)
    .map((m) => {
      const name = db.dex[m.id]?.name ?? m.id;
      const evs = STATS.map((s, i) => [SD_STAT[s], Math.min(252, m.sp[i] * 8)]).filter(([, v]) => v > 0);
      return [
        m.item ? `${name} @ ${m.item}` : name,
        m.ability && `Ability: ${m.ability}`,
        'Level: 50',
        evs.length && `EVs: ${evs.map(([k, v]) => `${v} ${k}`).join(' / ')}`,
        m.nature && `${m.nature} Nature`,
        ...m.moves.filter(Boolean).map((mv) => `- ${mv}`),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function fromShowdown(db, text) {
  const byName = new Map(Object.entries(db.dex).map(([id, d]) => [norm(d.name), id]));
  for (const id of Object.keys(db.dex)) byName.set(norm(id), id);
  const team = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = lines[0].match(/^(?:.*\(([^()]+)\)|([^@(]+?))(?:\s*\((?:M|F)\))?\s*(?:@\s*(.+))?$/);
    const species = (head?.[1] ?? head?.[2] ?? '').trim();
    const id = byName.get(norm(species));
    if (!id) continue;
    const m = { id, item: head?.[3]?.trim() ?? '', ability: '', nature: 'Serious', moves: [], sp: [0, 0, 0, 0, 0, 0] };
    for (const l of lines.slice(1)) {
      let r;
      if ((r = l.match(/^Ability:\s*(.+)$/))) m.ability = r[1];
      else if ((r = l.match(/^(\w+) Nature$/))) m.nature = r[1];
      else if ((r = l.match(/^EVs:\s*(.+)$/))) {
        for (const part of r[1].split('/')) {
          const [v, k] = part.trim().split(/\s+/);
          const i = STATS.findIndex((s) => SD_STAT[s].toLowerCase() === k?.toLowerCase());
          if (i >= 0) m.sp[i] = Math.min(SP_MAX, Math.round(Number(v) / 8));
        }
      } else if ((r = l.match(/^-\s*(.+)$/))) m.moves.push(r[1]);
    }
    team.push(m);
  }
  return normalizeTeam(team);
}

// ---------- 日本語のメモ ----------

export function toJapaneseText(db, team) {
  return team
    .filter(Boolean)
    .map((m) => {
      const b = memberBattler(db, m);
      const stats = b ? b.stats.join('-') : '';
      return [
        `${jaPokemon(db, m.id)}${m.item ? ` @ ${jaItem(db, m.item)}` : ''}`,
        `特性: ${jaAbility(db, b?.ability ?? m.ability)} / 性格: ${jaNature(db, m.nature)}`,
        `ポイント: ${m.sp.join('-')}（実数値 ${stats}）`,
        `技: ${m.moves.filter(Boolean).map((mv) => jaMove(db, mv)).join(' / ')}`,
      ].join('\n');
    })
    .join('\n\n');
}
