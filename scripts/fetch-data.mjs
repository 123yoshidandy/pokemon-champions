#!/usr/bin/env node
// ポケモンチャンピオンズのバトルデータを取得し、data/ 以下の JSON を作り直す。
// 取得元: https://championsbattledata.com （ゲーム内のバトルデータを集めているファンサイト）
// 日本語名: PokeAPI の CSV、技の性能: Pokémon Showdown の moves.json
//
// 使い方: node scripts/fetch-data.mjs [--force]
//   --force  取得元のデータの版が前回と同じでも取り直す

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const API = 'https://championsbattledata.com';
const POKEAPI_CSV = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';
const SHOWDOWN_MOVES = 'https://play.pokemonshowdown.com/data/moves.json';
const FORMATS = [
  { key: 'doubles', api: 'Doubles' },
  { key: 'singles', api: 'Singles' },
];
// 取得元は個人のファンサイトなので、同時に2本まで・1件ごとに間を空けて取る（800件で5〜6分）
const CONCURRENCY = 2;
const REQUEST_INTERVAL_MS = 400;
// 続けてこの件数だけ失敗したら、取得元の形が変わったとみて全体を打ち切る
const MAX_CONSECUTIVE_FAILURES = 10;
const HISTORY_DAYS = 60;
// PokeAPI と Showdown のデータは、ほとんど変わらないので、この日数ごとに取り直す
const REFERENCE_MAX_AGE_DAYS = 30;
const REFERENCE_CACHE = path.join(ROOT, 'scripts', 'cache', 'reference.json');
const UA = 'pokemon-champions-builder (+https://github.com/123yoshidandy/pokemon-champions)';

const force = process.argv.includes('--force');

// ---------- 通信 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AbortRun extends Error {}

// やり直すのは、つながらないとき・429・5xx だけ（429 は Retry-After に従う）。404 などはすぐ失敗にする
async function fetchText(url, tries = 4) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA } });
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * 2 ** i);
      continue;
    }
    if (res.ok) return await res.text();
    if (!(res.status === 429 || res.status >= 500) || i >= tries) throw new Error(`${url}: HTTP ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** i);
  }
}

const fetchJSON = async (url) => JSON.parse(await fetchText(url));

// 取得元（championsbattledata.com）への要求。間を空け、失敗が続いたら打ち切る
let consecutiveFailures = 0;
async function apiJSON(pathAndQuery) {
  try {
    const json = await fetchJSON(`${API}${pathAndQuery}`);
    consecutiveFailures = 0;
    return json;
  } catch (e) {
    if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new AbortRun(`${MAX_CONSECUTIVE_FAILURES}件続けて失敗したので打ち切ります（最後: ${e.message}）`);
    }
    throw e;
  } finally {
    await sleep(REQUEST_INTERVAL_MS);
  }
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj) + '\n');
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- 採用データ（技・持ち物など）を詰め直す ----------

const STAT_KEYS = ['hp_points', 'attack_points', 'defense_points', 'sp_atk_points', 'sp_def_points', 'speed_points'];
const STAT_LABEL = { Attack: 'atk', Defense: 'def', 'Sp. Atk': 'spa', 'Sp. Def': 'spd', Speed: 'spe' };

function compactUsage(rows, nameToId) {
  const u = { moves: [], items: [], abilities: [], natures: [], spreads: [], teammates: [] };
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  for (const r of sorted) {
    const pct = r.percentage_value ?? null;
    switch (r.category) {
      case 'move': u.moves.push([r.name, pct]); break;
      case 'held_item': u.items.push([r.name, pct]); break;
      case 'ability': u.abilities.push([r.name, pct]); break;
      case 'stat_alignment':
        u.natures.push([r.name, pct, STAT_LABEL[r.stat_up] ?? null, STAT_LABEL[r.stat_down] ?? null]);
        break;
      case 'stat_points':
        u.spreads.push([pct, STAT_KEYS.map((k) => Number(r[k]) || 0)]);
        break;
      case 'teammate':
        u.teammates.push(nameToId.get(norm(r.name)) ?? norm(r.name));
        break;
    }
  }
  return u;
}

// ---------- 種族データ（タイプ・実数値・フォルム） ----------

// ランキングの名前の接尾辞を、メタデータの form 欄の言葉に寄せる
const FORM_ALIASES = { f: 'female', alola: 'alolan', galar: 'galarian', hisui: 'hisuian', paldea: 'paldean' };

function pickFormRow(rows, entry) {
  const base = rows.find((r) => !r.form) ?? rows[0];
  const suffix = entry.name.slice(base.base_name.length).replace(/^-/, '');
  if (!suffix) return base;
  const tokens = suffix.split('-').map((t) => FORM_ALIASES[t.toLowerCase()] ?? t.toLowerCase());
  let best = base;
  let bestScore = 0;
  for (const r of rows) {
    if (!r.form || /^mega/i.test(r.form)) continue;
    const form = r.form.toLowerCase();
    const score = tokens.filter((t) => form.includes(t)).length;
    if (score > bestScore) [best, bestScore] = [r, score];
  }
  return best;
}

function toForm(r) {
  return {
    title: r.saved_name,
    form: r.form || '',
    types: r.types.split('/'),
    abilities: r.abilities.split('|').filter(Boolean),
    // Lv50・能力ポイント0のときの実数値 [H, A, B, C, D, S]
    stats: [r.hp, r.atk, r.def, r.spa, r.spd, r.spe],
    weight: parseFloat(r.weight) || null,
  };
}

function buildSpecies(entry, rows) {
  const row = pickFormRow(rows, entry);
  const isBaseForm = !row.form;
  return {
    name: entry.name,
    base: row.base_name,
    ...toForm(row),
    // メガシンカは、元のすがたのときだけ付ける（地方のすがた等には付けない）
    megas: isBaseForm ? rows.filter((r) => /^mega/i.test(r.form)).map(toForm) : [],
  };
}

// ---------- 日本語名 ----------

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  return lines.map((line) => {
    // 名前に , を含む行は "..." で囲まれている
    const cells = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

// 英語名 → 日本語名（かな）の対応表を作る
async function nameTable(file, idCol) {
  const rows = parseCSV(await fetchText(`${POKEAPI_CSV}/${file}.csv`));
  const en = new Map();
  const ja = new Map();
  for (const r of rows) {
    if (r.local_language_id === '9') en.set(r[idCol], r.name);
    if (r.local_language_id === '1') ja.set(r[idCol], r.name);
  }
  const out = new Map();
  for (const [id, e] of en) if (ja.has(id)) out.set(norm(e), ja.get(id));
  return out;
}

const FORM_JA = {
  wash: 'ウォッシュ', heat: 'ヒート', frost: 'フロスト', fan: 'スピン', mow: 'カット',
  female: '♀', f: '♀', alola: 'アローラ', alolan: 'アローラ', galar: 'ガラル', galarian: 'ガラル',
  hisui: 'ヒスイ', hisuian: 'ヒスイ', paldea: 'パルデア', paldean: 'パルデア',
  aqua: 'ウォーター', blaze: 'ブレイズ', combat: 'コンバット',
  four: '4匹家族', fancy: 'ファンシー', eternal: 'えいえんのはな', lowkey: 'ローな', dusk: 'たそがれ',
  midnight: 'まよなか', small: 'ちいさい', large: 'おおきい', super: 'とくだい', yellow: 'イエロー',
  bloodmoon: 'アカツキ', therian: 'れいじゅう', origin: 'オリジン',
};

function jaSpeciesName(name, base, speciesJa) {
  const baseJa = speciesJa.get(norm(base)) ?? base;
  const suffix = name.slice(base.length).replace(/^-/, '');
  if (!suffix) return baseJa;
  const label = FORM_JA[norm(suffix)] ?? suffix.split('-').map((t) => FORM_JA[norm(t)] ?? t).join('・');
  return `${baseJa}(${label})`;
}

// 全角の英数字を半角にそろえる（PokeAPI のメガストーン名に「Ｘ」が混じるため）
const toHalfWidth = (s) => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

function jaMegaName(form, baseJa) {
  const x = form.form.replace(/^Mega\s*/i, '');
  return `メガ${baseJa}${x}`;
}

// ---------- 技の性能と日本語名（手元に保存して使い回す） ----------

function compactMove(d) {
  return {
    type: d.type,
    cat: d.category, // Physical / Special / Status
    power: d.basePower || 0,
    acc: d.accuracy === true ? null : d.accuracy,
    prio: d.priority || 0,
    target: d.target,
    ...(d.multihit ? { multihit: d.multihit } : {}),
    // ダメージ計算で使う区分（接触・パンチ・かみつき・切る・波動）
    ...Object.fromEntries(['contact', 'punch', 'bite', 'slicing', 'pulse'].filter((f) => d.flags?.[f]).map((f) => [f, true])),
    ...(d.secondary || d.secondaries ? { secondary: true } : {}),
    ...(d.recoil || d.hasCrashDamage ? { recoil: true } : {}),
  };
}

// 保存したものを使う。ないとき・--force・古いとき・知らない技が出たときだけ取り直す
async function loadReference(usedMoves) {
  const cached = await readJSON(REFERENCE_CACHE, null);
  const ageDays = cached ? (Date.now() - Date.parse(cached.fetchedAt)) / 86400e3 : Infinity;
  const unknown = cached ? [...usedMoves].filter((m) => !cached.moves[norm(m)]) : [];
  const reason = !cached ? '保存したものがない' : force ? '--force' : ageDays > REFERENCE_MAX_AGE_DAYS ? `${Math.floor(ageDays)}日たった`
    : unknown.length ? `知らない技がある（${unknown.slice(0, 3).join(', ')}）` : null;
  if (!reason) return cached;
  // 取り直したのに知らない技が残るとき（チャンピオンズの新しい技など）、毎回取り直さないように、前回と同じなら使い回す
  if (cached && !force && ageDays <= REFERENCE_MAX_AGE_DAYS && cached.unknownMoves?.join() === unknown.join()) return cached;

  console.log(`PokeAPI と Showdown のデータを取り直します（${reason}）`);
  const sdMoves = await fetchJSON(SHOWDOWN_MOVES);
  const tables = await Promise.all([
    nameTable('pokemon_species_names', 'pokemon_species_id'),
    nameTable('move_names', 'move_id'),
    nameTable('item_names', 'item_id'),
    nameTable('ability_names', 'ability_id'),
    nameTable('nature_names', 'nature_id'),
  ]);
  const ref = {
    fetchedAt: new Date().toISOString(),
    moves: Object.fromEntries(Object.entries(sdMoves).map(([id, d]) => [id, compactMove(d)])),
    names: Object.fromEntries(['species', 'moves', 'items', 'abilities', 'natures'].map((k, i) => [k, Object.fromEntries(tables[i])])),
  };
  ref.unknownMoves = [...usedMoves].filter((m) => !ref.moves[norm(m)]);
  await writeJSON(REFERENCE_CACHE, ref);
  return ref;
}

// ---------- 本体 ----------

async function main() {
  const firstRanking = await apiJSON("/api/rankings?format=Doubles");
  const sourceVersion = firstRanking.dataVersion ?? null;
  const prevMeta = await readJSON(path.join(DATA, 'meta.json'), {});
  if (!force && sourceVersion && prevMeta.sourceVersion === sourceVersion) {
    console.log(`データの版が前回と同じ（${sourceVersion}）なので終了します。`);
    return;
  }

  const rankings = {};
  for (const f of FORMATS) {
    rankings[f.key] = f.api === 'Doubles' ? firstRanking : await apiJSON(`/api/rankings?format=${f.api}`);
    console.log(`${f.api}: ${rankings[f.key].rankings.length} 体`);
  }

  // 両形式に出てくるポケモンの一覧
  const entries = new Map();
  for (const f of FORMATS) for (const r of rankings[f.key].rankings) entries.set(r.showdownId, r);
  const nameToId = new Map([...entries.values()].map((e) => [norm(e.name), e.showdownId]));

  // 種族データ
  const metaById = new Map();
  await pool([...entries.values()], async (e) => {
    try {
      const m = await apiJSON(`/api/metadata/${e.showdownId}`);
      if (m.rows?.length) metaById.set(e.showdownId, m.rows);
      else console.warn(`メタデータなし: ${e.name}`);
    } catch (err) {
      if (err instanceof AbortRun) throw err;
      console.warn(`メタデータなし: ${e.name} (${err.message})`);
    }
  });
  const pokedex = {};
  // 並行で取るので、取れた順ではなくランキングの順に並べる（日ごとの差分を、中身の変化だけにする）
  for (const id of entries.keys()) if (metaById.has(id)) pokedex[id] = buildSpecies(entries.get(id), metaById.get(id));

  // 形式ごとの採用データ
  const usageByFormat = {};
  for (const f of FORMATS) {
    const list = rankings[f.key].rankings;
    const usage = {};
    let done = 0;
    await pool(list, async (r) => {
      try {
        const b = await apiJSON(`/api/battle/${f.api}/${r.showdownId}`);
        usage[r.showdownId] = compactUsage(b.rows ?? [], nameToId);
      } catch (e) {
        if (e instanceof AbortRun) throw e;
        console.warn(`採用データなし: ${f.api} ${r.name} (${e.message})`);
      }
      if (++done % 50 === 0) console.log(`  ${f.api} ${done}/${list.length}`);
    });
    usageByFormat[f.key] = Object.fromEntries(list.filter((r) => usage[r.showdownId]).map((r) => [r.showdownId, usage[r.showdownId]]));
  }

  // 技の性能（採用されている技だけ）と、日本語名の対応表
  const usedMoves = new Set();
  for (const u of Object.values(usageByFormat)) for (const p of Object.values(u)) for (const [m] of p.moves) usedMoves.add(m);
  const ref = await loadReference(usedMoves);
  const moves = {};
  for (const m of usedMoves) {
    const d = ref.moves[norm(m)];
    if (d) moves[m] = d;
    else console.warn(`技データなし: ${m}`);
  }
  const [speciesJa, movesJa, itemsJa, abilitiesJa, naturesJa] = ['species', 'moves', 'items', 'abilities', 'natures']
    .map((k) => new Map(Object.entries(ref.names[k])));
  const overrides = await readJSON(path.join(DATA, 'names-ja-overrides.json'), {});
  const names = { pokemon: {}, moves: {}, items: {}, abilities: {}, natures: {} };
  const missing = { pokemon: [], moves: [], items: [], abilities: [], natures: [] };
  const put = (kind, en, ja) => {
    const v = overrides[kind]?.[en] ?? ja;
    if (v) names[kind][en] = toHalfWidth(v);
    else missing[kind].push(en);
  };
  for (const [id, p] of Object.entries(pokedex)) {
    const baseJa = speciesJa.get(norm(p.base));
    put('pokemon', id, overrides.pokemon?.[id] ?? (baseJa ? jaSpeciesName(p.name, p.base, speciesJa) : null));
    for (const m of p.megas) put('pokemon', m.title, baseJa ? jaMegaName(m, baseJa) : null);
    for (const a of [...p.abilities, ...p.megas.flatMap((m) => m.abilities)]) put('abilities', a, abilitiesJa.get(norm(a)));
  }
  const seen = { moves: new Set(), items: new Set(), abilities: new Set(), natures: new Set() };
  for (const u of Object.values(usageByFormat)) {
    for (const [id, p] of Object.entries(u)) {
      for (const [m] of p.moves) seen.moves.add(m);
      for (const [i] of p.items) seen.items.add(i);
      for (const [a] of p.abilities) seen.abilities.add(a);
      for (const [n] of p.natures) seen.natures.add(n);
      void id;
    }
  }
  for (const m of seen.moves) put('moves', m, movesJa.get(norm(m)));
  for (const a of seen.abilities) if (!names.abilities[a]) put('abilities', a, abilitiesJa.get(norm(a)));
  for (const n of seen.natures) put('natures', n, naturesJa.get(norm(n)));
  for (const i of seen.items) {
    let ja = itemsJa.get(norm(i));
    // 新しいメガストーンは「ポケモン名 + ナイト」で補う（例: Garchompite Z → ガブリアスナイトZ）
    const mega = !ja && i.match(/^(.+?)ite(?:\s+([XYZ]))?$/);
    if (mega) {
      const sp = [...Object.values(pokedex)].find((p) => p.megas.length && norm(p.base).startsWith(norm(mega[1]).slice(0, 5)));
      const spJa = sp && speciesJa.get(norm(sp.base));
      if (spJa) ja = `${spJa}ナイト${mega[2] ?? ''}`;
    }
    put('items', i, ja);
  }
  for (const [k, v] of Object.entries(missing)) {
    if (v.length) console.warn(`日本語名なし ${k}: ${v.join(', ')}`);
  }

  // 書き出し
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST の日付
  for (const f of FORMATS) {
    const file = path.join(DATA, `${f.key}.json`);
    const prev = await readJSON(file, null);
    const prevPos = new Map((prev?.ranking ?? []).map((r) => [r.id, r.pos]));
    const ranking = rankings[f.key].rankings.map((r) => ({
      id: r.showdownId,
      pos: r.position,
      // 前回（別の日）の順位。同じ日の取り直しでは、その前の値を引き継ぐ
      prev: prev?.date === today ? prev.ranking.find((x) => x.id === r.showdownId)?.prev ?? null : prevPos.get(r.showdownId) ?? null,
    }));
    await writeJSON(file, {
      format: f.key,
      season: rankings[f.key].season,
      date: today,
      ranking,
      usage: usageByFormat[f.key],
    });

    // 順位の推移
    const hfile = path.join(DATA, 'history', `${f.key}.json`);
    const hist = await readJSON(hfile, { dates: [], ranks: {} });
    let col = hist.dates.indexOf(today);
    if (col < 0) {
      hist.dates.push(today);
      col = hist.dates.length - 1;
    }
    for (const id of Object.keys(hist.ranks)) hist.ranks[id][col] = null;
    for (const r of ranking) {
      const arr = (hist.ranks[r.id] ??= []);
      while (arr.length < col) arr.push(null);
      arr[col] = r.pos;
    }
    const drop = Math.max(0, hist.dates.length - HISTORY_DAYS);
    hist.dates = hist.dates.slice(drop);
    for (const id of Object.keys(hist.ranks)) {
      hist.ranks[id] = hist.ranks[id].slice(drop);
      while (hist.ranks[id].length < hist.dates.length) hist.ranks[id].push(null);
      if (hist.ranks[id].every((v) => v == null)) delete hist.ranks[id];
    }
    await writeJSON(hfile, hist);
  }
  await writeJSON(path.join(DATA, 'pokedex.json'), pokedex);
  await writeJSON(path.join(DATA, 'moves.json'), moves);
  await writeJSON(path.join(DATA, 'names-ja.json'), names);
  await writeJSON(path.join(DATA, 'meta.json'), {
    sourceVersion,
    seasons: firstRanking.seasons,
    fetchedAt: new Date().toISOString(),
    date: today,
  });
  console.log('完了');
}

if (!existsSync(DATA)) await mkdir(DATA, { recursive: true });
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
