// ポケモンの詳細（採用データ・相性・対面）
import { h, mount, typeBadges, typeBadge, bar, iconButton, scoreClass } from '../ui.js';
import { jaPokemon, jaItem, jaAbility, jaMove, jaNature, usageOf, rankHistory, moveData } from '../data.js';
import { STATS, STAT_JA, STAT_LONG_JA, speedTiers } from '../stats.js';
import { defenseProfile, TYPES } from '../types.js';
import { metaBattler, duel, topMeta } from '../analysis.js';
import { addToTeam } from './common.js';

export function renderDetail(app, root, id) {
  const db = app.db;
  const d = db.dex[id];
  if (!d) {
    mount(root, h('p', { class: 'error' }, 'このポケモンのデータはありません'));
    return;
  }
  const u = usageOf(db, id);
  const rank = db.rankOf.get(id);
  const forms = [{ title: id, ...d }, ...d.megas];
  let formIdx = 0;
  const formBox = h('div');

  const renderForm = () => {
    const f = forms[formIdx];
    mount(formBox,
      forms.length > 1
        ? h('div', { class: 'seg' }, forms.map((x, i) =>
          h('button', { type: 'button', class: i === formIdx ? 'on' : '', onclick: () => { formIdx = i; renderForm(); } }, i === 0 ? '通常' : jaPokemon(db, x.title))))
        : null,
      h('div', { class: 'form-head' },
        typeBadges(f.types),
        h('span', { class: 'muted' }, f.abilities.map((a) => jaAbility(db, a)).join(' / ')),
      ),
      statTable(f.stats),
      defenseBlock(f.types),
    );
  };
  renderForm();

  const usedMega = u.items.find(([i]) => /ite( [XYZ])?$/.test(i));

  mount(root, 
    h('div', { class: 'detail-top' },
      iconButton('back', '戻る', () => history.length > 1 ? history.back() : app.go('#/')),
      h('h1', {}, jaPokemon(db, id)),
      rank ? h('span', { class: 'rank-badge' }, `${rank.pos}位`) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => addToTeam(app, id) }, '構築に入れる'),
    ),
    h('section', { class: 'card' }, formBox, sparkline(rankHistory(db, id))),
    h('div', { class: 'grid2' },
      h('section', { class: 'card' },
        h('h2', {}, '技'),
        u.moves.map(([m, p]) => {
          const mv = moveData(db, m);
          return bar(p, jaMove(db, m), mv ? h('span', { class: 'move-meta' }, typeBadge(mv.type, true), mv.cat === 'Status' ? '変化' : mv.power || '-') : null);
        }),
      ),
      h('section', { class: 'card' },
        h('h2', {}, '持ち物'),
        // 採用率 1% 以下の持ち物は出さない
        u.items.filter(([, p]) => p > 1).map(([i, p]) => bar(p, jaItem(db, i))),
        usedMega ? h('p', { class: 'muted small' }, `メガシンカの採用: ${jaItem(db, usedMega[0])} ${usedMega[1]?.toFixed(1)}%`) : null,
      ),
      h('section', { class: 'card' },
        h('h2', {}, '特性'),
        u.abilities.map(([a, p]) => bar(p, jaAbility(db, a))),
        h('h2', {}, '性格'),
        u.natures.slice(0, 6).map(([n, p, up, down]) => bar(p, jaNature(db, n), up ? `${STAT_JA[up]}↑${STAT_JA[down]}↓` : '')),
      ),
      h('section', { class: 'card' },
        h('h2', {}, '能力ポイント'),
        h('p', { class: 'muted small' }, 'H-A-B-C-D-S'),
        u.spreads.slice(0, 8).map(([p, sp]) => bar(p, sp.join('-'))),
      ),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '一緒に使われるポケモン'),
      h('div', { class: 'mate-list' }, u.teammates.map((t, i) =>
        h('a', { class: 'mate', href: `#/p/${t}` }, h('span', { class: 'muted' }, i + 1), jaPokemon(db, t)))),
    ),
    matchups(app, id),
  );
}

function statTable(stats) {
  const tiers = speedTiers(stats[5]);
  return h('div', { class: 'stats' },
    h('table', { class: 'stat-table' },
      h('tbody', {}, STATS.map((s, i) =>
        h('tr', {},
          h('th', {}, STAT_LONG_JA[s]),
          h('td', { class: 'num' }, stats[i]),
          h('td', { class: 'stat-bar-cell' }, h('span', { class: 'stat-bar', style: { width: `${Math.min(100, (stats[i] / 230) * 100)}%` } })),
        ))),
    ),
    h('p', { class: 'muted small' }, `振りなしの実数値（Lv50）。すばやさ: 最速 ${tiers.fastest} / 準速 ${tiers.fast} / 無振り ${tiers.neutral} / 最遅 ${tiers.slowest}`),
  );
}

function defenseBlock(types) {
  const prof = defenseProfile(types);
  const groups = [[4, '×4'], [2, '×2'], [0.5, '×½'], [0.25, '×¼'], [0, '×0']];
  return h('div', { class: 'def-groups' }, groups.map(([m, label]) => {
    const ts = TYPES.filter((t) => prof[t] === m);
    return ts.length ? h('div', { class: 'def-group' }, h('span', { class: 'def-label' }, label), ts.map((t) => typeBadge(t, true))) : null;
  }));
}

// 順位の推移（小さな折れ線）
function sparkline(hist) {
  const pts = hist.filter((x) => x.pos != null);
  if (pts.length < 2) return null;
  const W = 300;
  const H = 60;
  const max = Math.max(...pts.map((p) => p.pos));
  const min = Math.min(...pts.map((p) => p.pos));
  const x = (i) => (i / (hist.length - 1)) * (W - 8) + 4;
  const y = (pos) => (max === min ? H / 2 : ((pos - min) / (max - min)) * (H - 12) + 6);
  const path = hist.map((p, i) => (p.pos == null ? null : `${x(i)},${y(p.pos)}`)).filter(Boolean).join(' ');
  const box = h('div', { class: 'spark' },
    h('span', { class: 'muted small' }, `順位の推移（${hist[0].date.slice(5)}〜${hist.at(-1).date.slice(5)}・最高 ${min}位）`));
  box.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${path}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`);
  return box;
}

// 環境の上位との対面
function matchups(app, id) {
  const db = app.db;
  const me = metaBattler(db, id);
  const rows = topMeta(db, 30).filter((x) => x !== id).map((fid) => {
    const foe = metaBattler(db, fid);
    return { fid, d: duel(db, me, foe) };
  });
  const strong = rows.filter((r) => r.d.score > 0).sort((a, b) => b.d.score - a.d.score);
  const weak = rows.filter((r) => r.d.score < 0).sort((a, b) => a.d.score - b.d.score);
  const line = (r) => h('li', { class: `mu ${scoreClass(r.d.score)}` },
    h('a', { href: `#/p/${r.fid}` }, jaPokemon(db, r.fid)),
    h('span', { class: 'small' }, `与 ${jaMove(db, r.d.a.move) ?? '-'} ${r.d.a.avgPct.toFixed(0)}%`),
    h('span', { class: 'small' }, `被 ${jaMove(db, r.d.b.move) ?? '-'} ${r.d.b.avgPct.toFixed(0)}%`),
  );
  return h('section', { class: 'card' },
    h('h2', {}, '環境の上位30体との対面'),
    h('p', { class: 'muted small' }, `よく使われる型どうしで、先に倒せるかを比べています（${jaItem(db, me.item) || '持ち物なし'}・${jaNature(db, me.nature)}・${me.sp.join('-')}）`),
    h('div', { class: 'grid2' },
      h('div', {}, h('h3', {}, `有利（${strong.length}）`), h('ul', { class: 'mu-list' }, strong.map(line))),
      h('div', {}, h('h3', {}, `不利（${weak.length}）`), h('ul', { class: 'mu-list' }, weak.map(line))),
    ),
  );
}
