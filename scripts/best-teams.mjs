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
import { searchBest } from '../js/best.js';

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
  ? { opponents: 20, battles: 4, finalBattles: 8, iterations: 40, patience: 15, seed: 1 }
  : { opponents: 100, battles: 10, finalBattles: 60, iterations: 800, patience: 80, seed: 1 };
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
  const format = rule.split('-')[0];
  const shared = { dex: await readJSON('pokedex.json'), moves: await readJSON('moves.json'), names: await readJSON('names-ja.json'), meta };
  const base = makeDB({ ...(await readJSON(`${format}.json`)), ...shared, history: await readJSON(`history/${format}.json`, { dates: [], ranks: {} }) });
  const db = rule.endsWith('-mega') ? megaRuleDB(base) : base;
  const t = Date.now();
  console.log(`${rule}: 探索を始めます`);
  const res = searchBest(db, { ...SETTINGS, log: (s) => console.log(`${rule} ${s}`) });
  const seconds = Math.round((Date.now() - t) / 1000);
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`${rule}: ${seconds}秒 確認用の勝率 ${p(res.winRate)}（探索用 ${p(res.searchWinRate)}・選び直し用 ${p(res.validationWinRate)}）、初期値 ${p(res.baseline.winRate)}（探索用 ${p(res.baseline.searchWinRate)}） ${res.team.filter(Boolean).map((m) => m.id).join(' ')}`);
  return { ...res, seconds, sourceVersion: meta.sourceVersion, dataDate: meta.date, settings: SETTINGS, generatedAt: new Date().toISOString() };
}

// ルールごとの結果を、data/best-teams.json にまとめる（ないルールは前の値を残す）
async function merge(results) {
  // ルールの一覧にないもの（前に計算していたシングルなど）は捨てる
  const out = { rules: Object.fromEntries(Object.entries(prev?.rules ?? {}).filter(([k]) => RULES.includes(k))) };
  for (const r of results) out.rules[r.rule] = r.result;
  // 全体の版は、一番新しいもの（画面はルールごとに版を確かめる）
  const latest = Object.values(out.rules).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0];
  out.sourceVersion = latest?.sourceVersion ?? null;
  out.generatedAt = latest?.generatedAt ?? null;
  await writeJSON(OUT, out);
  console.log(`まとめました: ${path.relative(ROOT, OUT)}（${results.map((r) => r.rule).join(', ') || '新しい結果なし'}）`);
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
  await writeJSON(path.resolve(out), { rule, result: await compute(rule) });
  console.log(`書き出しました: ${out}`);
} else {
  const only = value('--only');
  const results = [];
  for (const rule of RULES) if (!only || rule === only) results.push({ rule, result: await compute(rule) });
  if (quick) console.log('--quick なので、data/best-teams.json には書きません');
  else await merge(results);
}
