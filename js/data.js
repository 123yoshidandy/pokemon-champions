// データの読み込みと、名前・フォルムの引き当て
// db = { format, date, season, ranking, usage, dex, moves, names, history, meta }

const cache = new Map();

async function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(url);
}

export async function loadDB(format, base = './data') {
  const [fmt, dex, moves, names, history, meta] = await Promise.all([
    getJSON(`${base}/${format}.json`),
    getJSON(`${base}/pokedex.json`),
    getJSON(`${base}/moves.json`),
    getJSON(`${base}/names-ja.json`),
    getJSON(`${base}/history/${format}.json`).catch(() => ({ dates: [], ranks: {} })),
    getJSON(`${base}/meta.json`),
  ]);
  return makeDB({ ...fmt, dex, moves, names, history, meta });
}

// テストからも使えるように、読み込んだ JSON から db を組み立てる部分を分けている
export function makeDB({ format, date, season, ranking, usage, dex, moves, names, history, meta, megaRule = false }) {
  const rankOf = new Map(ranking.map((r) => [r.id, r]));
  return { format, date, season, ranking, usage, dex, moves, names, history, meta, rankOf, doubles: format === 'doubles', megaRule };
}

// ---------- メガシンカバトル ----------

// メガシンカのすがたがある種族か（地方のすがたなど、そのすがたにメガシンカがないものは除く）
export const canMega = (db, id) => !!db.dex[id]?.megas?.length;

// 指定された順に、1 から順位を振り直す
const reRank = (ids) => new Map(ids.map((id, i) => [id, i + 1]));

const megaCache = new WeakMap();

/**
 * メガシンカバトル（メガシンカできるポケモンだけが使えるルール）の db。
 * このルールの使用率はないので、ふつうの使用率を、メガシンカできる種族だけに絞って使う。
 * 順位・前回の順位・順位の推移は、絞ったあとの順位に振り直す。一緒に使われるポケモンも絞る
 */
export function megaRuleDB(db) {
  if (db.megaRule) return db;
  if (megaCache.has(db)) return megaCache.get(db);
  const ok = (id) => canMega(db, id);
  const kept = db.ranking.filter((r) => ok(r.id));
  const prevPos = reRank(kept.filter((r) => r.prev != null).sort((a, b) => a.prev - b.prev).map((r) => r.id));
  const ranking = kept.map((r, i) => ({ id: r.id, pos: i + 1, prev: prevPos.get(r.id) ?? null }));
  const usage = {};
  for (const r of kept) {
    const u = db.usage[r.id];
    if (u) usage[r.id] = { ...u, teammates: u.teammates.filter(ok) };
  }
  // 順位の推移も、日ごとに絞ったあとの順位にする
  const ids = Object.keys(db.history.ranks).filter(ok);
  const ranks = {};
  db.history.dates.forEach((_, col) => {
    const order = ids.filter((id) => db.history.ranks[id][col] != null).sort((a, b) => db.history.ranks[a][col] - db.history.ranks[b][col]);
    order.forEach((id, i) => {
      (ranks[id] ??= Array(db.history.dates.length).fill(null))[col] = i + 1;
    });
  });
  const out = makeDB({ ...db, ranking, usage, history: { dates: db.history.dates, ranks }, megaRule: true });
  megaCache.set(db, out);
  return out;
}

// ---------- 名前 ----------

export const jaPokemon = (db, idOrTitle) => db.names.pokemon[idOrTitle] ?? db.dex[idOrTitle]?.name ?? idOrTitle;
export const jaMove = (db, m) => db.names.moves[m] ?? m;
export const jaItem = (db, i) => db.names.items[i] ?? i;
export const jaAbility = (db, a) => db.names.abilities[a] ?? a;
export const jaNature = (db, n) => db.names.natures[n] ?? n;

// ---------- フォルム ----------

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// 持ち物がそのポケモンのメガストーンなら、メガシンカ後のフォルムを返す
export function megaForItem(dexEntry, item) {
  if (!item || !dexEntry?.megas?.length) return null;
  const m = item.match(/^(.+?)ite(?:\s+([XYZ]))?$/);
  if (!m) return null;
  if (!norm(dexEntry.base).startsWith(norm(m[1]).slice(0, 4))) return null;
  const want = m[2] ? `Mega ${m[2]}` : 'Mega';
  return dexEntry.megas.find((f) => f.form === want) ?? null;
}

export const isMegaStone = (db, id, item) => !!megaForItem(db.dex[id], item);

// 実際に戦うときのフォルム（メガストーンを持っていればメガシンカ後）
export function battleForm(db, id, item) {
  const d = db.dex[id];
  if (!d) return null;
  const mega = megaForItem(d, item);
  const f = mega ?? d;
  return {
    id,
    title: mega ? mega.title : id,
    name: jaPokemon(db, mega ? mega.title : id),
    types: f.types,
    abilities: f.abilities,
    stats: f.stats,
    weight: f.weight ?? d.weight,
    mega: !!mega,
  };
}

// ---------- 絵 ----------

const SPRITE_BASE = 'https://play.pokemonshowdown.com/sprites/gen5/';

// Pokémon Showdown の絵の URL（rotom-wash、garchomp-megaz）。メガシンカの絵がないときのために、元のすがたの絵も返す
export function spriteUrls(db, id, item, megaForm = null) {
  const d = db.dex[id];
  if (!d) return [];
  const base = norm(d.base);
  const suffix = d.name.slice(d.base.length).replace(/^-/, '');
  const own = `${SPRITE_BASE}${base}${suffix ? `-${norm(suffix)}` : ''}.png`;
  const mega = megaForm ?? megaForItem(d, item);
  return mega ? [`${SPRITE_BASE}${base}-${norm(mega.form)}.png`, own] : [own];
}

// ---------- 検索 ----------

// ひらがな → カタカナ
export const toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

export function searchPokemon(db, query, limit = 12) {
  const q = toKatakana(query.trim()).toLowerCase();
  if (!q) return [];
  const qn = norm(q);
  const hits = [];
  for (const r of db.ranking) {
    const ja = toKatakana(jaPokemon(db, r.id)).toLowerCase();
    const en = norm(db.dex[r.id]?.name ?? r.id);
    const score = ja.startsWith(q) || (qn && en.startsWith(qn)) ? 0 : ja.includes(q) || (qn && en.includes(qn)) ? 1 : -1;
    if (score >= 0) hits.push([score, r.pos, r.id]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, limit).map((h) => h[2]);
}

// 技・持ち物などを日本語・英語で探す（候補は英語名の配列）
export function searchNames(list, toJa, query, limit = 20) {
  const q = toKatakana(query.trim()).toLowerCase();
  if (!q) return list.slice(0, limit);
  const qn = norm(q);
  const scored = [];
  for (const en of list) {
    const ja = toKatakana(toJa(en)).toLowerCase();
    const e = norm(en);
    const s = ja.startsWith(q) || (qn && e.startsWith(qn)) ? 0 : ja.includes(q) || (qn && e.includes(qn)) ? 1 : -1;
    if (s >= 0) scored.push([s, en]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

// ---------- 採用データ ----------

export const usageOf = (db, id) => db.usage[id] ?? { moves: [], items: [], abilities: [], natures: [], spreads: [], teammates: [] };

export const moveData = (db, name) => db.moves[name] ?? null;

export const isAttack = (mv) => !!mv && mv.cat !== 'Status';

// 全ポケモンの採用データに出てくる技・持ち物（候補の一覧に使う）
export function allUsed(db, key) {
  const count = new Map();
  for (const u of Object.values(db.usage)) for (const [n, pct] of u[key]) count.set(n, (count.get(n) ?? 0) + (pct ?? 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}

// 順位の推移 [{date, pos}]
export function rankHistory(db, id) {
  const arr = db.history.ranks[id] ?? [];
  return db.history.dates.map((date, i) => ({ date, pos: arr[i] ?? null }));
}
