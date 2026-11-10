#!/usr/bin/env node
// 「一番の構築」を、相手の構築群との対戦のシミュレーションで探し、data/best-teams.json に書き出す。
// 手元の data/ だけを使う（取得はしない）。データの版が前回と同じなら、何もしない。
//
// 使い方: node scripts/best-teams.mjs [--force] [--quick] [--only doubles|singles|doubles-mega|singles-mega]
//   --force  データの版が前回と同じでも計算し直す
//   --quick  試合数と探索の回数を減らして、短く通す（手元で確かめるとき。ファイルには書かない）
//   --only   1 つのルールだけ計算する

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDB, megaRuleDB } from '../js/data.js';
import { searchBest } from '../js/best.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'best-teams.json');
const args = process.argv.slice(2);
const force = args.includes('--force');
const quick = args.includes('--quick');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// 探索の設定。版の記録にも使い、設定を変えたら計算し直す
const SETTINGS = quick
  ? { opponents: 20, battles: 4, finalBattles: 8, iterations: 40, patience: 15, seed: 1 }
  : { opponents: 80, battles: 8, finalBattles: 40, iterations: 500, patience: 60, seed: 1 };
const RULES = ['doubles', 'singles', 'doubles-mega', 'singles-mega'];

const readJSON = async (f, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(DATA, f), 'utf8'));
  } catch {
    return fallback;
  }
};

const shared = { dex: await readJSON('pokedex.json'), moves: await readJSON('moves.json'), names: await readJSON('names-ja.json'), meta: await readJSON('meta.json') };
const prev = await readJSON('best-teams.json', null);
const version = shared.meta.sourceVersion;
if (!force && !quick && prev?.sourceVersion === version && JSON.stringify(prev.settings) === JSON.stringify(SETTINGS)) {
  console.log(`データの版が前回と同じ（${version}）なので終了します。`);
  process.exit(0);
}

const out = { sourceVersion: version, dataDate: shared.meta.date, generatedAt: null, settings: SETTINGS, rules: { ...(prev?.rules ?? {}) } };
for (const rule of RULES) {
  if (only && rule !== only) continue;
  const format = rule.split('-')[0];
  const base = makeDB({ ...(await readJSON(`${format}.json`)), ...shared, history: await readJSON(`history/${format}.json`, { dates: [], ranks: {} }) });
  const db = rule.endsWith('-mega') ? megaRuleDB(base) : base;
  const t = Date.now();
  console.log(`${rule}: 探索を始めます`);
  const res = searchBest(db, { ...SETTINGS, log: (s) => console.log(s) });
  const seconds = Math.round((Date.now() - t) / 1000);
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`${rule}: ${seconds}秒 確認用の勝率 ${p(res.winRate)}（探索用 ${p(res.searchWinRate)}・選び直し用 ${p(res.validationWinRate)}）、初期値 ${p(res.baseline.winRate)}（探索用 ${p(res.baseline.searchWinRate)}） ${res.team.filter(Boolean).map((m) => m.id).join(' ')}`);
  out.rules[rule] = { ...res, seconds };
}
out.generatedAt = new Date().toISOString();
if (quick) {
  console.log('--quick なので、ファイルには書きません');
} else {
  await writeFile(OUT, JSON.stringify(out) + '\n');
  console.log(`書き出しました: ${path.relative(ROOT, OUT)}`);
}
