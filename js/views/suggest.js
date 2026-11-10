// おすすめの構築（環境データから6体を提案する）
import { h, mount, typeBadges, typeBadge, pokemonCombo, iconButton, icon, toast, pokeIcon } from '../ui.js';
import { jaPokemon, jaItem } from '../data.js';
import { suggestTeams, STYLES } from '../suggest.js';
import * as store from '../store.js';
import { formatLabel } from './common.js';

const state = {
  axis: store.getPref('suggestAxis', [null, null]),
  useTeam: store.getPref('suggestUseTeam', false),
  style: store.getPref('suggestStyle', ''),
  pool: store.getPref('suggestPool', 60),
  threats: store.getPref('suggestThreats', 40),
  result: null, // { key, list }
  busy: false,
};

const save = () => {
  store.setPref('suggestAxis', state.axis);
  store.setPref('suggestUseTeam', state.useTeam);
  store.setPref('suggestStyle', state.style);
  store.setPref('suggestPool', state.pool);
  store.setPref('suggestThreats', state.threats);
};

export function renderSuggest(app, root) {
  const db = app.db;
  const team = store.getTeam(app.format).filter(Boolean);
  const axis = state.useTeam && team.length ? team.slice(0, 5).map((m) => m.id) : state.axis.filter((id) => id && db.dex[id]);
  const key = JSON.stringify([app.format, db.date, axis, state.style, state.pool, state.threats]);
  const redraw = () => { save(); renderSuggest(app, root); };

  const run = () => {
    state.busy = true;
    redraw();
    // 「計算中」を先に描いてから計算する
    setTimeout(() => {
      try {
        state.result = { key, list: suggestTeams(db, axis, { style: state.style, pool: state.pool, threats: state.threats }) };
      } finally {
        state.busy = false;
        redraw();
      }
    }, 30);
  };

  const axisBox = state.useTeam && team.length
    ? h('div', { class: 'mate-list' }, axis.map((id) => h('span', { class: 'mate' }, jaPokemon(db, id))))
    : h('div', { class: 'opp-slots' }, [0, 1].map((i) =>
      h('div', { class: 'opp-slot' },
        pokemonCombo(db, {
          value: state.axis[i],
          placeholder: `軸${i + 1}（なくてもよい）`,
          onPick: (id) => { state.axis[i] = id || null; redraw(); },
        }),
        state.axis[i] ? iconButton('close', '外す', () => { state.axis[i] = null; redraw(); }) : null,
      )));

  const sel = (value, options, onChange) => h('select', { onchange: (e) => onChange(Number(e.target.value)) },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

  const stale = state.result && state.result.key !== key;

  mount(root,
    h('section', { class: 'page-head' },
      h('h1', {}, `おすすめの構築（${formatLabel(db)}）`),
      h('p', { class: 'muted small' }, '環境の上位の相手に有利なメンバーがそろい、弱点が重なりにくく、よく組まれる組み合わせを優先して6体を選びます。'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '軸'),
      team.length
        ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: state.useTeam, onchange: (e) => { state.useTeam = e.target.checked; redraw(); } }),
          `いまの構築（${team.length}体）を軸にして、空いた枠を埋める`)
        : null,
      axisBox,
      h('h2', { class: 'mt' }, 'スタイル'),
      h('div', { class: 'seg' }, Object.entries(STYLES).map(([k, v]) =>
        h('button', { type: 'button', class: state.style === k ? 'on' : '', onclick: () => { state.style = k; redraw(); } }, v.label))),
      h('details', { class: 'more-opts' },
        h('summary', { class: 'muted small' }, '細かい設定'),
        h('div', { class: 'field-row' },
          h('label', { class: 'boost' }, h('span', {}, '候補にする範囲'),
            sel(state.pool, [[40, '上位40体'], [60, '上位60体'], [100, '上位100体']], (v) => { state.pool = v; redraw(); })),
          h('label', { class: 'boost' }, h('span', {}, '相手にする上位'),
            sel(state.threats, [[30, '上位30体'], [40, '上位40体'], [60, '上位60体']], (v) => { state.threats = v; redraw(); })),
        ),
      ),
      h('div', { class: 'row mt' },
        h('button', { class: 'btn primary', type: 'button', disabled: state.busy, onclick: run }, icon('wand'), state.busy ? '計算中…' : '提案する'),
        stale ? h('span', { class: 'muted small' }, '条件を変えました。もう一度押すと出し直します') : null,
      ),
    ),
    state.result ? results(app, db, state.result.list) : null,
  );
}

function results(app, db, list) {
  if (!list.length) return h('p', { class: 'muted' }, '条件に合う構築が見つかりませんでした。');
  const threatsN = state.threats;
  return h('ol', { class: 'suggest-list' }, list.map((s, k) =>
    h('li', { class: 'card suggest' },
      h('div', { class: 'suggest-head' },
        h('span', { class: 'plan-rank' }, k + 1),
        s.styles.map((st) => h('span', { class: 'tag style-tag' }, STYLES[st].label)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onclick: () => useTeam(app, s.team) }, 'この構築を使う'),
      ),
      h('div', { class: 'suggest-members' }, s.battlers.map((b) =>
        h('a', { class: 'suggest-mon', href: `#/p/${b.id}` },
          h('span', { class: 'suggest-mon-head' }, pokeIcon(db, b.id, b.item), h('span', { class: 'slot-name' }, b.name)),
          typeBadges(b.types, true),
          h('span', { class: 'muted small' }, b.item ? jaItem(db, b.item) : '持ち物なし'),
        ))),
      h('div', { class: 'reasons' },
        h('span', { class: `reason${s.eval.holes.length ? ' bad' : ''}` },
          s.eval.holes.length
            ? `上位${threatsN}体のうち、有利なメンバーがいない相手: ${s.eval.holes.map((id) => jaPokemon(db, id)).join('、')}`
            : `上位${threatsN}体のどれにも、有利なメンバーがいる`),
        s.eval.stacked.length ? h('span', { class: 'reason bad' }, '弱点が重なる: ', s.eval.stacked.map((t) => typeBadge(t, true))) : null,
        s.eval.pairs.length
          ? h('span', { class: 'reason' }, `よく組まれる組み合わせ: ${s.eval.pairs.slice(0, 4).map(([a, b]) => `${jaPokemon(db, a)}・${jaPokemon(db, b)}`).join(' / ')}${s.eval.pairs.length > 4 ? ` ほか${s.eval.pairs.length - 4}組` : ''}`)
          : null,
      ),
    )));
}

function useTeam(app, team) {
  const cur = store.getTeam(app.format);
  if (cur.some(Boolean) && !confirm('いまの構築を、この構築で置き換えますか？')) return;
  store.setTeam(app.format, team);
  toast('構築に入れました');
  app.go('#/team');
}
