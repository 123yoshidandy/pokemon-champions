// 環境（使用率の順位）
import { h, mount, typeBadges, typeBadge, iconButton, bar } from '../ui.js';
import { jaPokemon, jaItem, usageOf, isMegaStone, battleForm, moveData, toKatakana } from '../data.js';
import { metaBattler, trendAttackType, TREND_MIN_POWER } from '../analysis.js';
import { TYPES, TYPE_JA } from '../types.js';
import { addToTeam, dataDate, formatLabel, getTopN, topNSelect } from './common.js';
import * as store from '../store.js';

export function renderRanking(app, root) {
  const db = app.db;
  const state = { q: '', type: store.getPref('rankType', null), showAll: false };

  const list = h('ol', { class: 'rank-list' });
  const search = h('input', { type: 'search', class: 'search', placeholder: '名前で絞り込む', value: '' });
  const chips = h('div', { class: 'chips' });

  const renderChips = () => chips.replaceChildren(
    ...TYPES.map((t) => {
      const b = typeBadge(t, true);
      b.classList.add('chip');
      b.classList.toggle('off', state.type != null && state.type !== t);
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      b.addEventListener('click', () => {
        state.type = state.type === t ? null : t;
        store.setPref('rankType', state.type);
        renderChips();
        renderList();
      });
      return b;
    }),
  );

  const renderList = () => {
    const q = toKatakana(state.q.trim()).toLowerCase();
    const rows = db.ranking.filter((r) => {
      const f = battleForm(db, r.id, usageOf(db, r.id).items[0]?.[0]);
      if (!f) return false;
      if (state.type && !f.types.includes(state.type) && !db.dex[r.id].types.includes(state.type)) return false;
      if (q && !toKatakana(jaPokemon(db, r.id)).toLowerCase().includes(q) && !r.id.includes(q)) return false;
      return true;
    });
    const limit = state.showAll || q || state.type ? rows.length : 60;
    mount(list,
      ...rows.slice(0, limit).map((r) => rankRow(app, r)),
      rows.length > limit
        ? h('li', { class: 'more' }, h('button', { class: 'btn', type: 'button', onclick: () => { state.showAll = true; renderList(); } }, `すべて表示（${rows.length}体）`))
        : null,
    );
  };

  search.addEventListener('input', () => { state.q = search.value; renderList(); });

  mount(root, 
    h('section', { class: 'page-head' },
      h('h1', {}, `${formatLabel(db)}の環境`),
      h('p', { class: 'muted' }, `${dataDate(db)} 時点・シーズン ${db.season === 'Current' ? '最新' : db.season}`),
    ),
    trends(db),
    h('section', { class: 'card' },
      h('div', { class: 'filter' }, search, chips),
      list,
    ),
    h('p', { class: 'source' }, 'データ: ', h('a', { href: 'https://championsbattledata.com/', target: '_blank', rel: 'noopener' }, 'Pokemon Champions Battle Data'), '（ゲーム内のバトルデータ）'),
  );
  renderChips();
  renderList();
}

function rankRow(app, r) {
  const db = app.db;
  const u = usageOf(db, r.id);
  const topItem = u.items[0]?.[0];
  const mega = isMegaStone(db, r.id, topItem);
  const form = battleForm(db, r.id, mega ? topItem : null);
  const diff = r.prev == null ? null : r.prev - r.pos;
  return h('li', { class: 'rank-row' },
    h('a', { class: 'rank-link', href: `#/p/${r.id}` },
      h('span', { class: 'rank-pos' }, r.pos),
      h('span', { class: `rank-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}` }, diff == null ? '' : diff > 0 ? `↑${diff}` : diff < 0 ? `↓${-diff}` : ''),
      h('span', { class: 'rank-name' }, jaPokemon(db, r.id), mega ? h('span', { class: 'tag' }, 'メガ') : null),
      h('span', { class: 'rank-meta' },
        typeBadges(form.types, true),
        h('span', { class: 'rank-item muted' }, topItem ? jaItem(db, topItem) : ''),
      ),
    ),
    iconButton('plus', '構築に入れる', () => addToTeam(app, r.id), 'add-btn'),
  );
}

// 上位の傾向。上位の数を変えると描き直す（開いたまま）
function trends(db) {
  const summary = h('summary', {});
  const body = h('div', { class: 'trend-body' });
  const draw = () => {
    const n = getTopN();
    summary.textContent = `上位${n}体の傾向`;
    mount(body, h('div', { class: 'row' }, topNSelect(draw)), trendGrid(db, n));
  };
  draw();
  return h('details', { class: 'card trends' }, summary, body);
}

// タイプ・攻撃技のタイプ
function trendGrid(db, n) {
  const top = db.ranking.slice(0, n);
  const w = (pos) => 1 / Math.sqrt(pos);
  const typeCount = new Map();
  const atkType = new Map();
  for (const r of top) {
    const u = usageOf(db, r.id);
    const f = battleForm(db, r.id, isMegaStone(db, r.id, u.items[0]?.[0]) ? u.items[0][0] : null);
    if (!f) continue;
    const wt = w(r.pos);
    for (const t of f.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    const b = metaBattler(db, r.id);
    for (const [m, pct] of u.moves) {
      const t = trendAttackType(moveData(db, m), m, b);
      if (t) atkType.set(t, (atkType.get(t) ?? 0) + (pct / 100) * wt);
    }
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const maxAtk = sorted(atkType)[0]?.[1] ?? 1;

  return h('div', { class: 'trend-grid' },
      h('div', {},
        h('h3', {}, '多いタイプ'),
        h('div', { class: 'type-counts' }, sorted(typeCount).slice(0, 8).map(([t, n]) => h('span', { class: 'type-count' }, typeBadge(t, true), `${n}`))),
      ),
      h('div', {},
        h('h3', {}, 'よく使われる攻撃技のタイプ'),
        h('p', { class: 'muted small' }, `威力${TREND_MIN_POWER}未満の技（ねこだましなど）と、こごえるかぜ・バークアウトは数えない`),
        sorted(atkType).slice(0, 8).map(([t, v]) => bar((v / maxAtk) * 100, TYPE_JA[t], null, '')),
      ),
  );
}
