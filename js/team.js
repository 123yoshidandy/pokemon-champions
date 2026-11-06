// 構築（チーム）のデータ
// member = { id, item, ability, nature, moves:[4], sp:[6] }
import { usageOf, battleForm, jaPokemon, jaItem, jaAbility, jaMove, jaNature, isMegaStone } from './data.js';
import { calcStats, STATS, SP_MAX } from './stats.js';

export const TEAM_SIZE = 6;

// よく使われている型で埋める。持ち物はチーム内で重ならないようにする
// noMega: メガストーンを持たせない（チームにすでにメガシンカがいる前提で比べるとき）
export function defaultMember(db, id, team = [], { noMega = false } = {}) {
  const u = usageOf(db, id);
  const takenItems = new Set(team.filter((m) => m && m.id !== id).map((m) => m.item));
  const megaTaken = noMega || team.some((m) => m && m.id !== id && isMegaStone(db, m.id, m.item));
  const item = u.items.map((x) => x[0]).find((i) => !takenItems.has(i) && !(megaTaken && isMegaStone(db, id, i))) ?? '';
  const form = battleForm(db, id, item);
  const ability = form?.mega ? form.abilities[0] : u.abilities[0]?.[0] ?? form?.abilities[0] ?? '';
  return {
    id,
    item,
    ability,
    nature: u.natures[0]?.[0] ?? 'Serious',
    moves: [...new Set(u.moves.map((x) => x[0]))].slice(0, 4).concat(['', '', '', '']).slice(0, 4),
    sp: u.spreads[0]?.[1]?.slice() ?? [0, 0, 0, 0, 0, 0],
  };
}

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
