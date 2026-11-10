// ダメージ計算
import { h, mount, typeBadges, typeBadge, pokemonCombo, nameCombo, icon } from '../ui.js';
import { jaPokemon, jaItem, jaAbility, jaMove, jaNature, usageOf, allUsed, battleForm, moveData, isAttack } from '../data.js';
import { STATS, STAT_JA, NATURES, SP_MAX } from '../stats.js';
import { calcDamage, koLabel } from '../damage.js';
import { defaultMember, memberBattler } from '../team.js';
import * as store from '../store.js';

const BOOST_KEYS = ['atk', 'def', 'spa', 'spd'];
const emptySide = { boosts: { atk: 0, def: 0, spa: 0, spd: 0 }, status: '', hpPct: 100 };

function initState(app) {
  const db = app.db;
  const saved = store.getPref(`calc:${app.key}`, null);
  if (saved?.atk?.id && db.dex[saved.atk.id] && saved?.def?.id && db.dex[saved.def.id]) return saved;
  const team = store.getTeam(app.key).filter(Boolean);
  const atk = team[0] ?? defaultMember(db, db.ranking[0].id);
  const defId = db.ranking.find((r) => r.id !== atk.id).id;
  return {
    atk: { ...emptySide, ...atk },
    def: { ...emptySide, ...defaultMember(db, defId) },
    extraMove: '',
    field: { weather: '', terrain: '', crit: false, reflect: false, lightScreen: false, helpingHand: false, spread: 'auto' },
  };
}

export function renderCalc(app, root) {
  const db = app.db;
  const state = initState(app);
  const save = () => store.setPref(`calc:${app.key}`, state);
  const redraw = () => { save(); renderCalc(app, root); };

  const team = store.getTeam(app.key).filter(Boolean);
  const sideView = (key, label) => {
    const s = state[key];
    const setSide = (patch) => { state[key] = { ...s, ...patch }; redraw(); };
    const u = usageOf(db, s.id);
    const form = battleForm(db, s.id, s.item);
    const b = battler(db, s);
    const abilityChoices = form.mega ? form.abilities : db.dex[s.id].abilities;
    return h('section', { class: 'card side' },
      h('div', { class: 'side-head' }, h('h2', {}, label), typeBadges(form.types, true)),
      team.length ? h('div', { class: 'chips' }, team.map((m) =>
        h('button', { type: 'button', class: `chip-btn${m.id === s.id ? ' on' : ''}`, onclick: () => setSide({ ...emptySide, ...m }) }, jaPokemon(db, m.id)))) : null,
      h('div', { class: 'editor-grid' },
        field('ポケモン', pokemonCombo(db, { value: s.id, onPick: (id) => id && setSide({ ...emptySide, ...defaultMember(db, id) }) })),
        field('持ち物', nameCombo({ value: s.item, preferred: u.items, all: allUsed(db, 'items'), toJa: (x) => jaItem(db, x), placeholder: 'なし', onPick: (item) => setSide({ item }) })),
        field('特性', h('select', { onchange: (e) => setSide({ ability: e.target.value }), disabled: form.mega },
          abilityChoices.map((a) => h('option', { value: a, selected: a === b.ability }, jaAbility(db, a))))),
        field('性格', h('select', { onchange: (e) => setSide({ nature: e.target.value }) },
          Object.keys(NATURES).map((n) => {
            const [up, down] = NATURES[n];
            return h('option', { value: n, selected: n === s.nature }, `${jaNature(db, n)}${up ? ` ${STAT_JA[up]}↑${STAT_JA[down]}↓` : ''}`);
          }))),
      ),
      h('div', { class: 'sp-grid' }, STATS.map((st, k) =>
        h('label', { class: 'sp-field' },
          h('span', {}, STAT_JA[st]),
          h('input', {
            type: 'number', min: 0, max: SP_MAX, value: s.sp[k], inputmode: 'numeric',
            onchange: (e) => { const sp = s.sp.slice(); sp[k] = Math.max(0, Math.min(SP_MAX, Number(e.target.value) || 0)); setSide({ sp }); },
          }),
          h('span', { class: 'sp-stat' }, b.stats[k]),
        ))),
      h('div', { class: 'boosts' },
        BOOST_KEYS.map((bk) => h('label', { class: 'boost' },
          h('span', {}, `${STAT_JA[bk]}ランク`),
          h('select', { onchange: (e) => setSide({ boosts: { ...s.boosts, [bk]: Number(e.target.value) } }) },
            [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map((v) => h('option', { value: v, selected: v === (s.boosts?.[bk] ?? 0) }, v > 0 ? `+${v}` : v))))),
        h('label', { class: 'boost' }, h('span', {}, 'やけど'),
          h('input', { type: 'checkbox', checked: s.status === 'brn', onchange: (e) => setSide({ status: e.target.checked ? 'brn' : '' }) })),
        h('label', { class: 'boost' }, h('span', {}, '残りHP%'),
          h('input', { type: 'number', min: 1, max: 100, value: s.hpPct ?? 100, onchange: (e) => setSide({ hpPct: Math.max(1, Math.min(100, Number(e.target.value) || 100)) }) })),
      ),
    );
  };

  const atk = battler(db, state.atk);
  const def = battler(db, state.def);
  const f = state.field;
  const fieldOpts = {
    doubles: db.doubles,
    weather: f.weather || null,
    terrain: f.terrain || null,
    crit: f.crit,
    reflect: f.reflect,
    lightScreen: f.lightScreen,
    helpingHand: f.helpingHand,
    ...(f.spread === 'auto' ? {} : { spread: f.spread === 'on' }),
  };
  const moves = [...new Set([...state.atk.moves.filter(Boolean), state.extraMove].filter(Boolean))];
  const results = moves.map((name) => {
    const mv = moveData(db, name);
    return { name, mv, r: mv && isAttack(mv) ? calcDamage(atk, def, { name, ...mv }, fieldOpts) : null };
  });

  const setField = (patch) => { state.field = { ...f, ...patch }; redraw(); };
  const check = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => setField({ [key]: e.target.checked }) }), label);

  mount(root, 
    h('section', { class: 'page-head row' },
      h('h1', {}, 'ダメージ計算'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { [state.atk, state.def] = [state.def, state.atk]; redraw(); } }, icon('swap'), '攻守を入れ替え'),
    ),
    h('section', { class: 'card results' },
      h('h2', {}, `${atk.name} → ${def.name}`),
      h('div', { class: 'muted small' }, `${def.name}: H${def.stats[0]} B${def.stats[2]} D${def.stats[4]}`),
      h('ul', { class: 'dmg-list' }, results.map(({ name, mv, r }) =>
        h('li', { class: 'dmg' },
          h('div', { class: 'dmg-head' },
            h('span', { class: 'dmg-move' }, jaMove(db, name)),
            mv ? typeBadge(mv.type, true) : null,
            mv ? h('span', { class: 'muted small' }, mv.cat === 'Status' ? '変化' : `${mv.cat === 'Physical' ? '物理' : '特殊'} ${mv.power || '-'}`) : null,
            h('span', { class: 'spacer' }),
            r ? h('span', { class: 'dmg-ko' }, koLabel(r.ko)) : h('span', { class: 'muted small' }, '-'),
          ),
          r ? h('div', { class: 'dmg-bar' },
            h('span', { class: 'dmg-max', style: { width: `${Math.min(100, r.maxPct)}%` } }),
            h('span', { class: 'dmg-min', style: { width: `${Math.min(100, r.minPct)}%` } })) : null,
          r ? h('div', { class: 'small' }, `${r.min}〜${r.max}（${r.minPct.toFixed(1)}〜${r.maxPct.toFixed(1)}%）${r.hits > 1 ? ` ${r.hits}回` : ''}${r.eff !== 1 ? ` ×${r.eff}` : ''}`) : null,
        ))),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'ほかの技'),
        nameCombo({ value: state.extraMove, preferred: [], all: Object.keys(db.moves).filter((m) => isAttack(db.moves[m])), toJa: (x) => jaMove(db, x), placeholder: '技を選ぶ', onPick: (m) => { state.extraMove = m; redraw(); } }),
      ),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '場'),
      h('div', { class: 'field-row' },
        h('label', { class: 'boost' }, h('span', {}, '天気'), h('select', { onchange: (e) => setField({ weather: e.target.value }) },
          [['', 'なし'], ['sun', 'はれ'], ['rain', 'あめ'], ['sand', 'すなあらし'], ['snow', 'ゆき']].map(([v, l]) => h('option', { value: v, selected: v === f.weather }, l)))),
        h('label', { class: 'boost' }, h('span', {}, 'フィールド'), h('select', { onchange: (e) => setField({ terrain: e.target.value }) },
          [['', 'なし'], ['electric', 'エレキ'], ['grassy', 'グラス'], ['psychic', 'サイコ'], ['misty', 'ミスト']].map(([v, l]) => h('option', { value: v, selected: v === f.terrain }, l)))),
        db.doubles ? h('label', { class: 'boost' }, h('span', {}, '全体技'), h('select', { onchange: (e) => setField({ spread: e.target.value }) },
          [['auto', '技に合わせる'], ['on', '2体に当てる'], ['off', '1体に当てる']].map(([v, l]) => h('option', { value: v, selected: v === f.spread }, l)))) : null,
        check('crit', '急所'), check('reflect', 'リフレクター'), check('lightScreen', 'ひかりのかべ'), db.doubles ? check('helpingHand', 'てだすけ') : null,
      ),
    ),
    h('div', { class: 'grid2' }, sideView('atk', '攻撃側'), sideView('def', '防御側')),
    h('p', { class: 'muted small' }, '第9世代の計算式をもとにした簡易版です。主な持ち物・特性・場の補正を入れています。2〜5回当たる技は3回（スキルリンクは5回、いかさまダイスは4回）で計算します。'),
  );
}

function battler(db, s) {
  const b = memberBattler(db, s);
  return { ...b, boosts: s.boosts ?? {}, status: s.status || null, hpPct: s.hpPct ?? 100 };
}

const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
