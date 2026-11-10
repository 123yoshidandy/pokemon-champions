#!/usr/bin/env node
// 「一番の構築」を、相手の構築群との対戦のシミュレーションで探し、data/best-teams.json に書き出す。
// 手元の data/ だけを使う（取得はしない）。データの版と設定が前回と同じルールは、計算し直さない。
//
// 使い方:
//   node scripts/best-teams.mjs [--force] [--quick] [--only <ルール>]   ルールを順に計算して data/best-teams.json に書く
//   node scripts/best-teams.mjs --rule <ルール> --out <ファイル> [--force] [--quick]
//                                                            1 つのルールだけ計算して、結果をファイルに書く（同時に動かすとき）
//   node scripts/best-teams.mjs --merge <ファイル...>         ルールごとの結果を data/best-teams.json にまとめる（ないルールは前の値を残す）
//   --force  データの版と設定が前回と同じでも計算し直す
//   --quick  試合数と探索の回数を減らして、短く通す（手元で確かめるとき。data/best-teams.json には書かない）
//   ルール: doubles / doubles-mega（ダブルの考察が目的なので、シングルは計算しない。メガシンカバトルはダブル専用）

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDB, megaRuleDB } from '../js/data.js';
import { searchBest, finalRace, teamKey } from '../js/best.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'best-teams.json');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const force = flag('--force');
const quick = flag('--quick');

// 探索の設定。ルールごとの結果にも記録し、設定を変えたら計算し直す。シードはルールによらず同じ
// （ルールどうしで状態を共有しないので、同時に動かしても、順に動かしたときと同じ結果になる）
const SETTINGS = quick
  ? { opponents: 40, searchOpponents: 15, battles: 2, iterations: 40, candidates: 8, raceBattles: 1, keep: 2, patience: 15, seed: 1 }
  : { opponents: 400, searchOpponents: 60, battles: 4, iterations: 800, candidates: 64, raceBattles: 1, keep: 4, patience: 60, seed: 1 };
// --seed でシードを変えられる（ぶれを測るとき、Actions でシードごとに分けて計算するとき）
if (value('--seed')) SETTINGS.seed = Number(value('--seed'));
const RULES = ['doubles', 'doubles-mega'];

const readJSON = async (f, fallback) => {
  try {
    return JSON.parse(await readFile(path.isAbsolute(f) ? f : path.join(DATA, f), 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJSON = (f, obj) => writeFile(f, JSON.stringify(obj) + '\n');

const meta = await readJSON('meta.json');
const prev = await readJSON(OUT, null);

// 1 つのルールの結果（版と設定が前回と同じなら、前回の結果）
async function compute(rule) {
  const old = prev?.rules?.[rule];
  if (!force && !quick && old?.sourceVersion === meta.sourceVersion && JSON.stringify(old.settings) === JSON.stringify(SETTINGS)) {
    console.log(`${rule}: データの版と設定が前回と同じ（${meta.sourceVersion}）なので、前回の結果を使います`);
    return old;
  }
  const db = await loadRuleDB(rule);
  const t = Date.now();
  console.log(`${rule}: 探索を始めます（シード ${SETTINGS.seed}）`);
  const res = searchBest(db, { ...SETTINGS, log: (s) => console.log(`${rule} ${s}`) });
  const seconds = Math.round((Date.now() - t) / 1000);
  console.log(`${rule}: ${seconds}秒 候補${res.candidates}個（評価した構築 ${res.explored}個）。今の提案の1位は ${p(res.baseline.winRate)}（±${p(res.baseline.margin)}・${res.baseline.games}試合）`);
  logRanking(res.ranking);
  return { ...res, seconds, sourceVersion: meta.sourceVersion, dataDate: meta.date, settings: SETTINGS, generatedAt: new Date().toISOString() };
}

const p = (v) => `${(v * 100).toFixed(1)}%`;
const teamKeyOf = (team) => teamKey(team.filter(Boolean));
const logRanking = (ranking) => ranking.forEach((x, i) => console.log(`  ${i + 1}位 ${p(x.envWinRate)}（±${p(x.margin)}・${x.games}試合）${x.fromSuggestion ? '（今の提案）' : ''} ${x.team.filter(Boolean).map((m) => m.id).join(' ')}`));

async function loadRuleDB(rule) {
  const format = rule.split('-')[0];
  const shared = { dex: await readJSON('pokedex.json'), moves: await readJSON('moves.json'), names: await readJSON('names-ja.json'), meta };
  const base = makeDB({ ...(await readJSON(`${format}.json`)), ...shared, history: await readJSON(`history/${format}.json`, { dates: [], ranks: {} }) });
  return rule.endsWith('-mega') ? megaRuleDB(base) : base;
}

// ルールごとの結果を、data/best-teams.json にまとめる（ないルールは前の値を残す）
// 同じルールの結果がシードごとに複数あれば、それぞれの上位を集めて、別の相手の構築群とのふるい落としで比べ直す
async function merge(results) {
  // ルールの一覧にないもの（前に計算していたシングルなど）は捨てる
  const out = { rules: Object.fromEntries(Object.entries(prev?.rules ?? {}).filter(([k]) => RULES.includes(k))) };
  for (const rule of RULES) {
    const parts = results.filter((r) => r.rule === rule);
    if (!parts.length) continue;
    const first = parts[0].result;
    if (parts.length === 1) {
      out.rules[rule] = first;
      continue;
    }
    const db = await loadRuleDB(rule);
    const t = Date.now();
    console.log(`${rule}: ${parts.length}個のシードの上位を比べ直します`);
    // 各シードの 1 位を候補として集め（同じ構築は 1 つ）、共通の相手の構築群で測り直して並べる
    const tops = parts.map((r) => r.result.ranking[0].team.filter(Boolean));
    const ranking = finalRace(db, tops, {
      opponents: first.settings.opponents, keep: tops.length, seed: 99, log: (s) => console.log(`${rule} ${s}`),
    }).map((x) => ({ ...x, fromSuggestion: parts.some((r) => r.result.ranking.some((y) => y.fromSuggestion && teamKeyOf(y.team) === teamKeyOf(x.team))) }));
    logRanking(ranking);
    out.rules[rule] = {
      ...first, ranking, team: ranking[0].team, winRate: ranking[0].envWinRate,
      seeds: parts.map((r) => ({ seed: r.result.settings.seed, team: r.result.ranking[0].team, winRate: r.result.ranking[0].envWinRate, margin: r.result.ranking[0].margin })),
      seconds: Math.max(...parts.map((r) => r.result.seconds)) + Math.round((Date.now() - t) / 1000),
      generatedAt: new Date().toISOString(),
    };
  }
  // 全体の版は、一番新しいもの（画面はルールごとに版を確かめる）
  const latest = Object.values(out.rules).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0];
  out.sourceVersion = latest?.sourceVersion ?? null;
  out.generatedAt = latest?.generatedAt ?? null;
  await writeJSON(OUT, out);
  console.log(`まとめました: ${path.relative(ROOT, OUT)}（${[...new Set(results.map((r) => r.rule))].join(', ') || '新しい結果なし'}）`);
}

if (flag('--merge')) {
  const files = args.slice(args.indexOf('--merge') + 1).filter((a) => !a.startsWith('--'));
  const parts = [];
  for (const f of files) {
    const part = await readJSON(path.resolve(f), null);
    if (part?.rule && part.result) parts.push(part);
    else console.warn(`読めませんでした: ${f}`);
  }
  await merge(parts);
} else if (flag('--rule')) {
  const rule = value('--rule');
  const out = value('--out');
  if (!RULES.includes(rule) || !out) {
    console.error(`--rule は ${RULES.join(' / ')} のどれか、--out に書き出すファイルを指定してください`);
    process.exit(1);
  }
  await writeJSON(path.resolve(out), { rule, seed: SETTINGS.seed, result: await compute(rule) });
  console.log(`書き出しました: ${out}`);
} else {
  const only = value('--only');
  const results = [];
  for (const rule of RULES) if (!only || rule === only) results.push({ rule, result: await compute(rule) });
  if (quick) console.log('--quick なので、data/best-teams.json には書きません');
  else await merge(results);
}
