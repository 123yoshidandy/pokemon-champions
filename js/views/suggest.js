// おすすめの構築（環境データから6体を提案する）
import { h, mount, typeBadges, typeBadge, pokemonCombo, iconButton, icon, toast, pokeIcon } from '../ui.js';
import { jaPokemon, jaItem, jaMove, loadBestTeams } from '../data.js';
import { basicPlan, WEATHER_JA } from '../analysis.js';
import { suggestTeams, STYLES, stylesFor, bestTeam, BEST_OPTS, minorAxisTeams, MINOR_FROM, describeTeam } from '../suggest.js';
import * as store from '../store.js';
import { formatLabel, saveTeam } from './common.js';

const MODES = [
  ['best', '強い候補'],
  ['custom', '条件を選ぶ'],
  ['minor', 'マイナー軸'],
];

const state = {
  mode: store.getPref('suggestMode', 'custom'),
  axis: store.getPref('suggestAxis', [null, null]),
  useTeam: store.getPref('suggestUseTeam', false),
  style: store.getPref('suggestStyle', ''),
  pool: store.getPref('suggestPool', 60),
  threats: store.getPref('suggestThreats', 40),
  result: null, // { key, style, threats, list }
  busy: false,
};

const save = () => {
  store.setPref('suggestMode', state.mode);
  store.setPref('suggestAxis', state.axis);
  store.setPref('suggestUseTeam', state.useTeam);
  store.setPref('suggestStyle', state.style);
  store.setPref('suggestPool', state.pool);
  store.setPref('suggestThreats', state.threats);
};

// 事前に計算した一番の構築（undefined は読み込み前、null はなし）と、その説明（ルールごと）
const precomputed = { data: undefined, desc: new Map() };

export function renderSuggest(app, root) {
  const db = app.db;
  if (!MODES.some(([k]) => k === state.mode)) state.mode = 'custom';
  // シングルでは、ダブルだけのスタイル（介護）を選べない
  if (!stylesFor(db).some(([k]) => k === state.style)) state.style = '';
  const team = store.getTeam(app.key).filter(Boolean);
  const axis = state.useTeam && team.length ? team.slice(0, 5).map((m) => m.id) : state.axis.filter((id) => id && db.dex[id]);
  const mode = state.mode;
  const key = JSON.stringify(mode === 'best' ? [app.key, db.date, mode]
    : [app.key, db.date, mode, mode === 'custom' ? axis : null, state.style, state.pool, state.threats]);
  const redraw = () => { save(); renderSuggest(app, root); };

  // 一番の構築は、事前の計算（データの版が同じもの）があれば、それを出す
  if (mode === 'best' && precomputed.data === undefined) {
    loadBestTeams().then((d) => { precomputed.data = d; redraw(); });
  }
  // ルールごとに、データの版が同じものだけを使う（1つのルールの計算だけが失敗して古い、ということがあるので）
  const entry = mode === 'best' ? precomputed.data?.rules?.[app.key] : null;
  const pre = entry && entry.sourceVersion === db.meta?.sourceVersion ? entry : null;
  // 上位の候補を、提案と同じ物差しで説明し、シミュレーターの結果（sim）を添える
  if (pre && !precomputed.desc.has(app.key)) {
    const list = (pre.ranking ?? [{ team: pre.team, envWinRate: pre.winRate }]).map((x) => ({ ...describeTeam(db, x.team, { threats: BEST_OPTS.threats }), sim: x }));
    precomputed.desc.set(app.key, list);
  }

  const compute = () => {
    if (mode === 'best') return { style: '', threats: BEST_OPTS.threats, list: [bestTeam(db)].filter(Boolean) };
    const opts = { style: state.style, pool: state.pool, threats: state.threats };
    return { style: state.style, threats: state.threats, list: mode === 'minor' ? minorAxisTeams(db, opts) : suggestTeams(db, axis, opts) };
  };

  const run = () => {
    state.busy = true;
    redraw();
    // 「計算中」を先に描いてから計算する
    setTimeout(() => {
      try {
        state.result = { key, ...compute() };
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

  const styleBox = [
    h('h2', { class: 'mt' }, 'スタイル'),
    h('div', { class: 'seg' }, stylesFor(db).map(([k, v]) =>
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
  ];

  const modeBody = {
    best: pre
      ? [h('p', { class: 'muted small' }, pre.seeds
        ? `使用率の上位50体の、よく使われる型だけで組み、ありそうな相手の構築${pre.opponents}個と、選出からターンを追って戦わせるシミュレーションで強かった構築の候補です。探索を${pre.seeds.length}通りのシードでまわし、それぞれで勝率が最も高かった構築を、共通の相手で測り直して並べています（${dateTime(pre.generatedAt)} に計算）。`
        : `ありそうな相手の構築${pre.opponents}個と、選出からターンを追って戦わせるシミュレーションで強かった構築の候補です（${dateTime(pre.generatedAt)} に計算）。`),
        h('p', { class: 'warnings' }, '自作のシミュレーターの結果で、相手は使用率から組み立てた構築です。勝率は実戦より高く出ます。考察の候補として使ってください。')]
      : [h('p', { class: 'muted small' }, `条件を選ばずに、上位${BEST_OPTS.pool}体から、上位${BEST_OPTS.threats}体に一番勝てる構築を1つに絞ります。${precomputed.data === undefined ? '' : db.doubles ? '（対戦のシミュレーションによる計算が、まだこのデータにはないので、この場で簡単に計算します）' : '（シングルは、対戦のシミュレーションによる計算をしていないので、この場で簡単に計算します）'}`)],
    custom: [
      h('h2', {}, '軸'),
      team.length
        ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: state.useTeam, onchange: (e) => { state.useTeam = e.target.checked; redraw(); } }),
          `いまの構築（${team.length}体）を軸にして、空いた枠を埋める`)
        : null,
      axisBox,
      styleBox,
    ],
    minor: [
      h('p', { class: 'muted small' }, `上位${MINOR_FROM}体の外から、上位の相手に勝てる数が多く、特に上位のポケモンがあまり勝てない相手に勝てるものを選び、1体ずつ軸にします。`),
      styleBox,
    ],
  }[mode];

  mount(root,
    h('section', { class: 'page-head' },
      h('h1', {}, `おすすめの構築（${formatLabel(db)}）`),
      h('p', { class: 'muted small' }, `環境の上位の相手に有利なメンバーがそろい、弱点が重なりにくく、よく組まれる組み合わせを優先して6体を選びます。${db.doubles ? 'おいかぜ・トリックルーム・壁・いかく・ねこだましなど、味方を助ける技や特性の効果も入れて比べます。' : ''}`),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'seg tabs' }, MODES.map(([k, label]) =>
        h('button', { type: 'button', class: mode === k ? 'on' : '', onclick: () => { state.mode = k; redraw(); } }, label))),
      modeBody,
      pre ? null : h('div', { class: 'row mt' },
        h('button', { class: 'btn primary', type: 'button', disabled: state.busy, onclick: run }, icon('wand'), state.busy ? '計算中…' : '提案する'),
        stale ? h('span', { class: 'muted small' }, '条件を変えました。もう一度押すと出し直します') : null,
      ),
    ),
    pre ? results(app, db, precomputed.desc.get(app.key), { style: '', threats: BEST_OPTS.threats })
      : state.result ? results(app, db, state.result.list) : null,
  );
}

function results(app, db, list, info = state.result) {
  if (!list.length) return h('p', { class: 'muted' }, '条件に合う構築が見つかりませんでした。');
  const style = info.style;
  const noSetter = style && !list.some((s) => s.styles.includes(style))
    ? h('p', { class: 'muted' }, `この環境のデータに、${STYLES[style].label}の始動役がいませんでした。`)
    : null;
  const threatsN = info.threats;
  return [noSetter, h('ol', { class: 'suggest-list' }, list.map((s, k) =>
    h('li', { class: 'card suggest' },
      h('div', { class: 'suggest-head' },
        h('span', { class: 'plan-rank' }, k + 1),
        s.styles.map((st) => h('span', { class: 'tag style-tag' }, STYLES[st].label)),
        h('span', { class: 'spacer' }),
        iconButton('save', '保存', () => saveTeam(app, s.team)),
        h('button', { class: 'btn primary', type: 'button', onclick: () => useTeam(app, s.team) }, 'この構築を使う'),
      ),
      h('div', { class: 'suggest-members' }, s.battlers.map((b) =>
        h('a', { class: 'suggest-mon', href: `#/p/${b.id}` },
          h('span', { class: 'suggest-mon-head' }, pokeIcon(db, b.id, b.item), h('span', { class: 'slot-name' }, b.name)),
          typeBadges(b.types, true),
          h('span', { class: 'muted small' }, b.item ? jaItem(db, b.item) : '持ち物なし'),
        ))),
      h('div', { class: 'reasons' },
        s.sim ? simLines(db, s.sim, list[0].sim) : null,
        s.axis ? h('span', { class: 'reason' }, h('span', { class: 'tag axis-tag' }, `軸: ${jaPokemon(db, s.axis.id)}（${db.rankOf.get(s.axis.id)?.pos}位）`), ` 上位${threatsN}体のうち${s.axis.answers.length}体に有利`) : null,
        h('span', { class: `reason${s.eval.holes.length ? ' bad' : ''}` },
          s.eval.holes.length
            ? `上位${threatsN}体のうち、有利なメンバーがいない相手: ${s.eval.holes.map((id) => jaPokemon(db, id)).join('、')}`
            : `上位${threatsN}体のどれにも、有利なメンバーがいる`),
        planLine(db, s.battlers),
        s.eval.support.length ? h('span', { class: 'reason' }, `味方を助ける: ${s.eval.support.join('・')}`) : null,
        s.eval.misfits.length
          ? h('span', { class: 'reason bad' }, `天気が合わない: ${s.eval.misfits.map((x) => `${jaPokemon(db, x.id)}（${WEATHER_JA[x.need]}がない）`).join('、')}`)
          : null,
        s.eval.stacked.length ? h('span', { class: 'reason bad' }, '弱点が重なる: ', s.eval.stacked.map((t) => typeBadge(t, true))) : null,
        s.eval.pairs.length
          ? h('span', { class: 'reason' }, `よく組まれる組み合わせ: ${s.eval.pairs.slice(0, 4).map(([a, b]) => `${jaPokemon(db, a)}・${jaPokemon(db, b)}`).join(' / ')}${s.eval.pairs.length > 4 ? ` ほか${s.eval.pairs.length - 4}組` : ''}`)
          : null,
      ),
    )))];
}

// 基本選出（先発・後発）を1行で
function planLine(db, battlers) {
  const p = basicPlan(db, battlers, (m) => jaMove(db, m));
  if (!p) return null;
  return h('span', { class: 'reason' }, `基本選出: 先発 ${p.lead.map((b) => b.name).join('・')} / 後発 ${p.back.map((b) => b.name).join('・')}`);
}

function useTeam(app, team) {
  const cur = store.getTeam(app.key);
  if (cur.some(Boolean) && !confirm('いまの構築を、この構築で置き換えますか？')) return;
  store.setTeam(app.key, team);
  toast('構築に入れました');
  app.go('#/team');
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const dateTime = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// シミュレーターの結果（勝率とぶれの幅・苦手な相手）。top は 1 位の結果
function simLines(db, x, top) {
  if (x.margin == null) return h('span', { class: 'reason' }, `勝率 ${pct(x.envWinRate)}`);
  const names = (ids) => ids.map((id) => jaPokemon(db, id)).join('・');
  // 1 位との差が、ぶれの幅より小さいか
  const close = x !== top && top.envWinRate - x.envWinRate < Math.hypot(x.margin, top.margin);
  return [
    h('span', { class: 'reason' }, `勝率 ${pct(x.envWinRate)}（±${pct(x.margin)}・${x.games}試合）${x.fromSuggestion ? '（今の提案）' : ''}${close ? '。1つ目の候補との差はぶれの範囲' : ''}`),
    // 苦手な相手：その種族がいる相手の構築への勝率（試合数つき）
    x.weakEnv?.length ? h('span', { class: 'reason bad' }, `苦手な相手: ${x.weakEnv.map((w) => (w.id ? `${jaPokemon(db, w.id)}がいる構築に ${pct(w.rate)}（${w.games}試合）` : `${names(w.ids)}の構築（${pct(w.rate)}）`)).join(' / ')}`) : null,
  ];
}
