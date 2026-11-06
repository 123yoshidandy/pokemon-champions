// 画面の部品
import { TYPE_JA, TYPE_COLOR } from './types.js';
import { jaPokemon, searchPokemon, searchNames } from './data.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 画面の中身を入れ替える（配列を平らにし、null を除く）
export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

export function typeBadge(type, small = false) {
  return h('span', { class: `type${small ? ' type-sm' : ''}`, style: { background: TYPE_COLOR[type] } }, TYPE_JA[type] ?? type);
}

export const typeBadges = (types, small) => h('span', { class: 'types' }, types.map((t) => typeBadge(t, small)));

// 線で描いたアイコン（24x24）
const ICONS = {
  ranking: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 5.4"/>',
  select: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="13" width="7" height="7" rx="1.5"/><path d="M15 16.5l2 2 4-4"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  share: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  wand: '<path d="M4 20L15 9M14 4v3M19 9h-3M18 5l-2 2"/>',
  spark: '<path d="M12 3l2.2 6.3L20.5 12l-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.7z"/><path d="M19 3v3M17.5 4.5h3"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
};

export function icon(name, label) {
  const span = h('span', { class: 'icon', 'aria-hidden': label ? null : 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
  return span;
}

export const iconButton = (name, label, onClick, cls = '') =>
  h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon(name));

// text を渡すと、右端の % の代わりに出す（比率のバーで、採用率と読み違えないように）
export function bar(pct, label, sub, text) {
  return h('div', { class: 'bar-row' },
    h('span', { class: 'bar-label' }, label),
    h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: { width: `${Math.min(100, pct ?? 0)}%` } })),
    h('span', { class: 'bar-pct' }, text ?? (pct == null ? '' : `${pct.toFixed(1)}%`)),
    sub ? h('span', { class: 'bar-sub' }, sub) : null,
  );
}

// 候補を絞り込んで選ぶ入力欄
// getItems(query) → [{ value, label, sub? }]
export function combo({ value = '', display = (v) => v, getItems, onPick, placeholder = '', cls = '' }) {
  const input = h('input', { type: 'text', class: `combo-input ${cls}`, placeholder, value: value ? display(value) : '', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { class: 'combo-list', role: 'listbox' });
  const wrap = h('div', { class: 'combo' }, input, list);
  let items = [];
  let active = -1;
  let current = value;

  const close = () => { list.classList.remove('open'); active = -1; };
  const render = () => {
    items = getItems(input.value === display(current) ? '' : input.value);
    list.replaceChildren(...items.map((it, i) =>
      h('li', {
        class: i === active ? 'active' : '',
        role: 'option',
        onmousedown: (e) => { e.preventDefault(); pick(it); },
      }, h('span', {}, it.label), it.sub ? h('span', { class: 'combo-sub' }, it.sub) : null),
    ));
    list.classList.toggle('open', items.length > 0);
  };
  const pick = (it) => {
    current = it.value;
    input.value = display(it.value);
    close();
    input.blur();
    onPick(it.value);
  };

  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('input', () => { active = -1; render(); });
  input.addEventListener('blur', () => {
    close();
    if (input.value.trim() === '' && current) { current = ''; onPick(''); }
    else input.value = current ? display(current) : '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const it = items[active >= 0 ? active : 0]; if (it) pick(it); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  return wrap;
}

// ポケモンを選ぶ入力欄
export function pokemonCombo(db, { value, onPick, placeholder = 'ポケモンを検索' }) {
  return combo({
    value,
    display: (id) => (id ? jaPokemon(db, id) : ''),
    placeholder,
    cls: 'combo-pokemon',
    getItems: (q) => (q ? searchPokemon(db, q, 12) : db.ranking.slice(0, 12).map((r) => r.id)).map((id) => ({
      value: id,
      label: jaPokemon(db, id),
      sub: `${db.rankOf.get(id)?.pos ?? '-'}位`,
    })),
    onPick,
  });
}

// 技・持ち物などを選ぶ入力欄。preferred は採用率つきの [英語名, %] の配列
export function nameCombo({ value, preferred = [], all = [], toJa, onPick, placeholder }) {
  const pct = new Map(preferred.map(([n, p]) => [n, p]));
  const ordered = [...preferred.map(([n]) => n), ...all.filter((n) => !pct.has(n))];
  return combo({
    value,
    display: (v) => (v ? toJa(v) : ''),
    placeholder,
    getItems: (q) => searchNames(ordered, toJa, q, 30).map((n) => ({ value: n, label: toJa(n), sub: pct.has(n) ? `${pct.get(n)?.toFixed(1)}%` : '' })),
    onPick,
  });
}

export function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

export const fmtPct = (v, d = 0) => `${v.toFixed(d)}%`;

// 対面の有利さを色の段階にする
export function scoreClass(s) {
  if (s >= 0.75) return 's-good2';
  if (s > 0) return 's-good';
  if (s === 0) return 's-even';
  if (s > -0.75) return 's-bad';
  return 's-bad2';
}
