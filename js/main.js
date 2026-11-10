// 画面の骨組み（形式の切り替えと、#/... による画面の切り替え）
import { loadDB, megaRuleDB } from './data.js';
import { icon, h } from './ui.js';
import * as store from './store.js';
import { renderRanking } from './views/ranking.js';
import { renderDetail } from './views/detail.js';
import { renderTeam } from './views/team.js';
import { renderSelect } from './views/select.js';
import { renderCalc } from './views/calc.js';
import { renderSuggest } from './views/suggest.js';

const view = document.getElementById('view');

export const app = {
  db: null,
  format: store.getFormat(),
  // メガシンカバトル
  megaRule: store.getMegaRule(),
  // 構築・保存した構築・選出の相手を、形式とルールごとに分けて保存するときの名前
  get key() { return this.megaRule ? `${this.format}-mega` : this.format; },
  go: (path) => { location.hash = path; },
  // 計算の画面に渡す組み合わせ（構築や詳細の画面から開くとき）
  calcPreset: null,
};
window.__app = app;

const ROUTES = [
  [/^#\/p\/([\w-]+)$/, 'ranking', (m) => renderDetail(app, view, m[1])],
  [/^#\/team(?:\?t=([\w-]+))?$/, 'team', (m) => renderTeam(app, view, m[1])],
  [/^#\/suggest$/, 'suggest', () => renderSuggest(app, view)],
  [/^#\/select$/, 'select', () => renderSelect(app, view)],
  [/^#\/calc$/, 'calc', () => renderCalc(app, view)],
  [/^#?\/?$/, 'ranking', () => renderRanking(app, view)],
];

let lastHash = null;

async function route() {
  const hash = location.hash || '#/';
  const [re, tab, fn] = ROUTES.find(([r]) => r.test(hash)) ?? ROUTES[ROUTES.length - 1];
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('active', a.dataset.tab === tab);
  const sameView = lastHash === hash;
  lastHash = hash;
  try {
    await fn(hash.match(re) ?? []);
  } catch (e) {
    console.error(e);
    view.replaceChildren(h('p', { class: 'error' }, `表示できませんでした: ${e.message}`));
  }
  if (!sameView) window.scrollTo(0, 0);
}

async function setFormat(format) {
  app.format = format;
  store.setFormat(format);
  for (const b of document.querySelectorAll('.format-switch button[data-format]')) b.classList.toggle('on', b.dataset.format === format);
  view.classList.add('loading');
  try {
    const db = await loadDB(format);
    app.db = app.megaRule ? megaRuleDB(db) : db;
  } finally {
    view.classList.remove('loading');
  }
}

for (const el of document.querySelectorAll('[data-icon]')) el.append(icon(el.dataset.icon));
for (const b of document.querySelectorAll('.format-switch button[data-format]')) {
  b.addEventListener('click', async () => {
    if (b.dataset.format === app.format) return;
    await setFormat(b.dataset.format);
    lastHash = null;
    route();
  });
}
const ruleBtn = document.querySelector('.rule-toggle');
const showRule = () => {
  ruleBtn.classList.toggle('on', app.megaRule);
  ruleBtn.setAttribute('aria-pressed', String(app.megaRule));
  document.body.classList.toggle('mega-rule', app.megaRule);
};
ruleBtn.addEventListener('click', async () => {
  app.megaRule = !app.megaRule;
  store.setMegaRule(app.megaRule);
  showRule();
  await setFormat(app.format);
  lastHash = null;
  route();
});
showRule();
window.addEventListener('hashchange', route);

try {
  await setFormat(app.format);
  route();
} catch (e) {
  console.error(e);
  view.replaceChildren(h('p', { class: 'error' }, `データを読み込めませんでした: ${e.message}`));
}
