// 構築（6体の編集と、環境への相性・相方の提案・タイプ相性・すばやさ）
import { h, mount, typeBadges, typeBadge, icon, iconButton, pokemonCombo, nameCombo, toast, scoreClass, scoreMark, duelDamage, DUEL_LEGEND, pokeIcon } from '../ui.js';
import { jaPokemon, jaItem, jaAbility, jaMove, jaNature, usageOf, allUsed, battleForm, isMegaStone, moveData } from '../data.js';
import { STATS, STAT_JA, NATURES, SP_TOTAL, SP_MAX, validateSpread } from '../stats.js';
import { TYPE_JA } from '../types.js';
import { defaultMember, memberBattler, encodeTeam, decodeTeam, toShowdown, fromShowdown, toJapaneseText, normalizeTeam } from '../team.js';
import { threatReport, suggestTeammates, defenseTable, offenseTable, speedList, teamSupport, supportNames } from '../analysis.js';
import * as store from '../store.js';
import { formatLabel, saveTeam } from './common.js';

const ui = { editing: null, tab: store.getPref('teamTab', 'threats'), threatN: store.getPref('threatN', 30) };

export function renderTeam(app, root, shared) {
  if (shared) {
    const t = decodeTeam(shared);
    const cur = store.getTeam(app.format);
    if (t && (!cur.some(Boolean) || confirm('共有された構築で、いまの構築を置き換えますか？'))) {
      store.setTeam(app.format, t);
      toast('共有された構築を読み込みました');
    }
    history.replaceState(null, '', '#/team');
  }
  draw(app, root);
}

function draw(app, root) {
  const db = app.db;
  const team = store.getTeam(app.format);
  const set = (next) => {
    store.setTeam(app.format, normalizeTeam(next));
    draw(app, root);
  };
  const battlers = team.map((m) => (m ? memberBattler(db, m) : null));
  if (ui.editing != null && !team[ui.editing] && ui.editing !== 'new') ui.editing = null;

  mount(root, 
    h('section', { class: 'page-head row' },
      h('h1', {}, `構築（${formatLabel(db)}）`),
      h('span', { class: 'spacer' }),
      teamActions(app, team, set, root),
    ),
    warnings(db, team),
    h('div', { class: 'slots' }, team.map((m, i) => slot(app, team, i, set))),
    ui.editing != null && team[ui.editing] ? editor(app, team, ui.editing, set) : null,
    analysisTabs(app, team, battlers, set, root),
  );
}

// ---------- 枠 ----------

function slot(app, team, i, set) {
  const db = app.db;
  const m = team[i];
  if (!m) {
    return h('div', { class: 'slot empty' },
      h('span', { class: 'slot-num' }, i + 1),
      pokemonCombo(db, {
        placeholder: 'ポケモンを入れる',
        onPick: (id) => {
          if (!id) return;
          if (team.some((x) => x?.id === id)) return toast('もう入っています');
          const next = team.slice();
          next[i] = defaultMember(db, id, team);
          set(next);
        },
      }),
    );
  }
  const b = memberBattler(db, m);
  const editing = ui.editing === i;
  return h('div', { class: `slot${editing ? ' editing' : ''}` },
    h('button', {
      type: 'button',
      class: 'slot-main',
      onclick: () => { ui.editing = editing ? null : i; set(team); },
    },
    h('div', { class: 'slot-head' },
      pokeIcon(db, m.id, m.item),
      h('span', { class: 'slot-name' }, b.name),
      typeBadges(b.types, true),
    ),
    h('div', { class: 'slot-sub muted' }, [m.item && jaItem(db, m.item), jaAbility(db, b.ability)].filter(Boolean).join(' / ')),
    h('div', { class: 'slot-moves' }, m.moves.filter(Boolean).map((mv) => h('span', {}, jaMove(db, mv)))),
    h('div', { class: 'slot-stats muted' }, b.stats.join('-')),
    ),
    h('div', { class: 'slot-tools' },
      iconButton('edit', '編集', () => { ui.editing = editing ? null : i; set(team); }),
      iconButton('trash', '外す', () => {
        const next = team.slice();
        next[i] = null;
        if (ui.editing === i) ui.editing = null;
        set(next);
      }),
    ),
  );
}

// ---------- 編集 ----------

function editor(app, team, i, set) {
  const db = app.db;
  const m = team[i];
  const u = usageOf(db, m.id);
  const b = memberBattler(db, m);
  const form = battleForm(db, m.id, m.item);
  const update = (patch) => {
    const next = team.slice();
    next[i] = { ...m, ...patch };
    // メガストーンを外した・付けたときは、特性をそのフォルムに合わせる
    const f = battleForm(db, m.id, next[i].item);
    if (f && !f.mega && !db.dex[m.id].abilities.includes(next[i].ability)) next[i].ability = u.abilities[0]?.[0] ?? db.dex[m.id].abilities[0];
    set(next);
  };
  const allMoves = Object.keys(db.moves);
  const allItems = allUsed(db, 'items');
  const { total } = validateSpread(m.sp);

  const spInputs = STATS.map((s, k) =>
    h('label', { class: 'sp-field' },
      h('span', {}, STAT_JA[s]),
      h('input', {
        type: 'number', min: 0, max: SP_MAX, value: m.sp[k], inputmode: 'numeric',
        onchange: (e) => {
          const sp = m.sp.slice();
          sp[k] = Math.max(0, Math.min(SP_MAX, Number(e.target.value) || 0));
          update({ sp });
        },
      }),
      h('span', { class: 'sp-stat' }, b.stats[k]),
    ));

  const abilityChoices = form.mega ? form.abilities : db.dex[m.id].abilities;

  return h('section', { class: 'card editor' },
    h('div', { class: 'editor-head' },
      h('h2', {}, `${i + 1}. ${b.name}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { const next = team.slice(); next[i] = defaultMember(db, m.id, team); set(next); } }, icon('wand'), 'よく使われる型'),
      iconButton('close', '閉じる', () => { ui.editing = null; set(team); }),
    ),
    h('div', { class: 'editor-grid' },
      field('ポケモン', pokemonCombo(db, {
        value: m.id,
        onPick: (id) => {
          if (!id || id === m.id) return;
          if (team.some((x) => x?.id === id)) return toast('もう入っています');
          const next = team.slice();
          next[i] = defaultMember(db, id, team.filter((_, k) => k !== i));
          set(next);
        },
      })),
      field('持ち物', nameCombo({ value: m.item, preferred: u.items, all: allItems, toJa: (x) => jaItem(db, x), placeholder: 'なし', onPick: (item) => update({ item }) })),
      field('特性', h('select', { onchange: (e) => update({ ability: e.target.value }), disabled: form.mega }, abilityChoices.map((a) => {
        const p = u.abilities.find(([x]) => x === a)?.[1];
        return h('option', { value: a, selected: a === b.ability }, `${jaAbility(db, a)}${p != null && !form.mega ? `（${p.toFixed(1)}%）` : ''}`);
      }))),
      field('性格', h('select', { onchange: (e) => update({ nature: e.target.value }) }, natureOptions(db, u, m.nature))),
    ),
    h('div', { class: 'moves-edit' }, [0, 1, 2, 3].map((k) =>
      field(`技${k + 1}`, nameCombo({
        value: m.moves[k],
        preferred: u.moves,
        all: allMoves,
        toJa: (x) => jaMove(db, x),
        placeholder: '-',
        onPick: (mv) => {
          const moves = m.moves.slice();
          moves[k] = mv;
          update({ moves });
        },
      }), moveInfo(db, m.moves[k])))),
    h('div', { class: 'sp-edit' },
      h('div', { class: 'sp-head' },
        h('span', {}, '能力ポイント'),
        h('span', { class: total > SP_TOTAL ? 'bad' : 'muted' }, `${total} / ${SP_TOTAL}`),
      ),
      h('div', { class: 'sp-grid' }, spInputs),
      h('div', { class: 'presets' },
        h('span', { class: 'muted small' }, 'よく使われる配分'),
        u.spreads.slice(0, 4).map(([p, sp]) => h('button', { class: 'chip-btn', type: 'button', onclick: () => update({ sp: sp.slice() }) }, `${sp.join('-')}（${p.toFixed(0)}%）`)),
      ),
    ),
  );
}

const field = (label, control, extra) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, extra ?? null);

function moveInfo(db, name) {
  const mv = name && moveData(db, name);
  if (!mv) return null;
  return h('span', { class: 'move-meta small' }, typeBadge(mv.type, true), mv.cat === 'Status' ? '変化' : `${mv.cat === 'Physical' ? '物理' : '特殊'} ${mv.power || '-'}`);
}

function natureOptions(db, u, current) {
  const pct = new Map(u.natures.map(([n, p]) => [n, p]));
  const names = [...u.natures.map(([n]) => n), ...Object.keys(NATURES).filter((n) => !pct.has(n))];
  return names.map((n) => {
    const [up, down] = NATURES[n] ?? [];
    return h('option', { value: n, selected: n === current },
      `${jaNature(db, n)}${up ? ` ${STAT_JA[up]}↑${STAT_JA[down]}↓` : ''}${pct.has(n) ? `（${pct.get(n).toFixed(1)}%）` : ''}`);
  });
}

// ---------- 注意 ----------

function warnings(db, team) {
  const list = [];
  const items = team.filter((m) => m?.item).map((m) => m.item);
  const dup = [...new Set(items.filter((x, i) => items.indexOf(x) !== i))];
  if (dup.length) list.push(`持ち物が重なっています: ${dup.map((i) => jaItem(db, i)).join('、')}`);
  const megas = team.filter((m) => m && isMegaStone(db, m.id, m.item));
  if (megas.length > 1) list.push(`メガシンカは1試合に1体だけです: ${megas.map((m) => jaPokemon(db, m.id)).join('、')}`);
  for (const m of team) {
    if (m && !validateSpread(m.sp).ok) list.push(`${jaPokemon(db, m.id)} の能力ポイントが上限（合計${SP_TOTAL}・1つ${SP_MAX}まで）を超えています`);
  }
  return list.length ? h('ul', { class: 'warnings' }, list.map((t) => h('li', {}, t))) : null;
}

// ---------- 共有・保存 ----------

function teamActions(app, team, set, root) {
  const db = app.db;
  return h('div', { class: 'actions' },
    iconButton('share', '共有のリンクをコピー', async (e) => {
      const url = `${location.origin}${location.pathname}#/team?t=${encodeTeam(team)}`;
      try {
        await navigator.clipboard.writeText(url);
        const btn = e.currentTarget;
        btn.replaceChildren(icon('check'));
        setTimeout(() => btn.replaceChildren(icon('share')), 1500);
      } catch {
        prompt('共有のリンク', url);
      }
    }),
    iconButton('save', '保存', () => { if (saveTeam(app, team)) draw(app, root); }),
    iconButton('copy', '書き出し・取り込み', () => openExport(app, team, set)),
    savedMenu(app, set, root),
  );
}

function savedMenu(app, set, root) {
  const saved = store.getSaved(app.format);
  if (!saved.length) return null;
  return h('details', { class: 'saved' },
    h('summary', { class: 'btn' }, `保存した構築（${saved.length}）`),
    h('ul', { class: 'saved-list' }, saved.map((s, k) =>
      h('li', {},
        h('button', { type: 'button', class: 'saved-load', onclick: () => { ui.editing = null; set(s.team); toast(`${s.name} を読み込みました`); } },
          h('span', {}, s.name),
          h('span', { class: 'muted small' }, s.team.filter(Boolean).map((m) => jaPokemon(app.db, m.id)).join(' ')),
        ),
        iconButton('trash', '削除', () => {
          const list = store.getSaved(app.format);
          list.splice(k, 1);
          store.setSaved(app.format, list);
          draw(app, root);
        }),
      ))),
  );
}

function openExport(app, team, set) {
  const db = app.db;
  const sd = h('textarea', { class: 'export', rows: 12, spellcheck: 'false' });
  sd.value = toShowdown(db, team);
  const ja = h('textarea', { class: 'export', rows: 12, readonly: true });
  ja.value = toJapaneseText(db, team);
  const dlg = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog-head' }, h('h2', {}, '書き出し・取り込み'), iconButton('close', '閉じる', () => dlg.close())),
    h('h3', {}, 'Showdown 形式'),
    h('p', { class: 'muted small' }, '能力ポイントは、努力値（ポイント×8、上限252）として書き出します。貼り付けて「取り込む」で読み込めます。'),
    sd,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => copy(sd.value) }, 'コピー'),
      h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => {
          const t = fromShowdown(db, sd.value);
          if (!t.some(Boolean)) return toast('読み込めるポケモンがありませんでした');
          ui.editing = null;
          set(t);
          dlg.close();
          toast('取り込みました');
        },
      }, '取り込む'),
    ),
    h('h3', {}, '日本語のメモ'),
    ja,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => copy(ja.value) }, 'コピー')),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch {
    toast('コピーできませんでした');
  }
}

// ---------- 分析 ----------

const TABS = [
  ['threats', '環境チェック'],
  ['mates', '相方の提案'],
  ['types', 'タイプ相性'],
  ['speed', 'すばやさ'],
];

function analysisTabs(app, team, battlers, set, root) {
  const body = h('div', { class: 'tab-body' });
  const seg = h('div', { class: 'seg tabs' }, TABS.map(([k, label]) =>
    h('button', {
      type: 'button',
      class: ui.tab === k ? 'on' : '',
      onclick: () => { ui.tab = k; store.setPref('teamTab', k); draw(app, root); },
    }, label)));
  const live = battlers.filter(Boolean);
  if (!live.length && ui.tab !== 'mates') {
    body.append(
      h('p', { class: 'muted' }, 'ポケモンを入れると、環境への相性が出ます。'),
      h('a', { class: 'btn', href: '#/suggest' }, icon('spark'), '環境から6体を提案してもらう'),
    );
  } else if (ui.tab === 'threats') body.append(threatsView(app, battlers, root));
  else if (ui.tab === 'mates') body.append(matesView(app, team, set));
  else if (ui.tab === 'types') body.append(typesView(app, battlers));
  else body.append(speedView(app, battlers));
  return h('section', { class: 'card analysis' }, seg, body);
}

function threatsView(app, battlers, root) {
  const db = app.db;
  const live = battlers.filter(Boolean);
  const report = threatReport(db, battlers, ui.threatN);
  const sup = supportNames(teamSupport(db, battlers));
  const holes = report.filter((r) => r.best <= 0);
  const nSel = h('select', { onchange: (e) => { ui.threatN = Number(e.target.value); store.setPref('threatN', ui.threatN); draw(app, root); } },
    [20, 30, 50, 80].map((n) => h('option', { value: n, selected: n === ui.threatN }, `上位${n}体`)));

  return h('div', {},
    h('div', { class: 'row' },
      nSel,
      h('span', { class: 'muted small' }, `よく使われる型どうしで、先に倒せる方を有利としています${sup.length ? `（味方の${sup.join('・')}を入れて比べています）` : ''}`),
    ),
    holes.length
      ? h('div', { class: 'holes' },
        h('h3', {}, `勝てるメンバーがいない相手（${holes.length}）`),
        h('div', { class: 'mate-list' }, holes.map((r) => h('a', { class: 'mate bad', href: `#/p/${r.id}` }, h('span', { class: 'muted' }, r.pos), jaPokemon(db, r.id)))))
      : h('p', { class: 'good' }, `上位${ui.threatN}体のどれにも、有利なメンバーがいます。`),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'mu-table' },
        h('thead', {}, h('tr', {},
          h('th', { class: 'sticky' }, '相手'),
          live.map((b) => h('th', { class: 'mu-col' }, b.name)),
        )),
        h('tbody', {}, report.map((r) =>
          h('tr', { class: r.best <= 0 ? 'hole' : '' },
            h('th', { class: 'sticky' },
              h('a', { href: `#/p/${r.id}` }, h('span', { class: 'muted small' }, `${r.pos} `), r.foe.name),
              h('div', {}, typeBadges(r.foe.types, true))),
            r.duels.map((d) => h('td', {
              class: `mu-cell ${scoreClass(d.score)}`,
              title: `与 ${jaMove(db, d.a.move) ?? '-'} ${d.a.minPct.toFixed(0)}〜${d.a.maxPct.toFixed(0)}% / 被 ${jaMove(db, d.b.move) ?? '-'} ${d.b.minPct.toFixed(0)}〜${d.b.maxPct.toFixed(0)}% / S ${d.speedA} vs ${d.speedB}`,
            },
            h('span', { class: 'mu-mark' }, scoreMark(d.score)),
            h('span', { class: 'mu-dmg' }, duelDamage(d)))),
          ))),
      ),
    ),
    h('p', { class: 'muted small' }, DUEL_LEGEND),
  );
}

function matesView(app, team, set) {
  const db = app.db;
  const full = team.every(Boolean);
  const list = suggestTeammates(db, team, { limit: 15 });
  return h('div', {},
    h('p', { class: 'muted small' }, '環境の上位100体から、上位40体への勝ち筋が増える・弱点を受けられる・一緒に使われることが多い順に出しています。'),
    h('ol', { class: 'mates' }, list.map((s) =>
      h('li', { class: 'mate-card' },
        h('div', { class: 'mate-head' },
          pokeIcon(db, s.id, s.battler.item),
          h('a', { href: `#/p/${s.id}`, class: 'mate-name' }, s.battler.name),
          typeBadges(s.battler.types, true),
          h('span', { class: 'muted small' }, `${db.rankOf.get(s.id)?.pos}位`),
          h('span', { class: 'spacer' }),
          full ? null : iconButton('plus', '構築に入れる', () => {
            const next = team.slice();
            const k = next.findIndex((m) => !m);
            next[k] = defaultMember(db, s.id, team);
            set(next);
            toast(`${s.battler.name} を入れました`);
          }, 'add-btn'),
        ),
        h('div', { class: 'reasons' },
          s.newAnswers.length ? h('span', { class: 'reason' }, `勝てる相手が増える: ${s.newAnswers.slice(0, 5).map((id) => jaPokemon(db, id)).join('、')}${s.newAnswers.length > 5 ? ` ほか${s.newAnswers.length - 5}体` : ''}`) : null,
          s.covers.length ? h('span', { class: 'reason' }, '弱点を受ける: ', s.covers.map((t) => typeBadge(t, true))) : null,
          s.adds.length ? h('span', { class: 'reason bad' }, '弱点が重なる: ', s.adds.map((t) => typeBadge(t, true))) : null,
          s.paired.length ? h('span', { class: 'reason' }, `よく組まれる: ${s.paired.map((id) => jaPokemon(db, id)).join('、')}`) : null,
          h('span', { class: 'reason muted' }, `型: ${[s.battler.item && jaItem(db, s.battler.item), jaAbility(db, s.battler.ability)].filter(Boolean).join(' / ')}`),
        ),
      ))),
  );
}

function typesView(app, battlers) {
  const db = app.db;
  const live = battlers.filter(Boolean);
  const def = defenseTable(live);
  const off = offenseTable(db, live);
  const cell = (m) => {
    if (m == null) return h('td', {});
    const label = m === 0 ? '0' : m === 0.25 ? '¼' : m === 0.5 ? '½' : m === 1 ? '' : m === 2 ? '2' : '4';
    return h('td', { class: `tc tc-${String(m).replace('.', '_')}` }, label);
  };
  return h('div', {},
    h('h3', {}, '受けるタイプ相性'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'type-table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), live.map((b) => h('th', {}, b.name)), h('th', {}, '弱'), h('th', {}, '耐'))),
        h('tbody', {}, def.map((r) => h('tr', { class: r.danger === 2 ? 'danger' : '' },
          h('th', {}, typeBadge(r.type, true)),
          r.mults.map(cell),
          h('td', { class: r.weak >= 2 ? 'bad num' : 'num' }, r.weak),
          h('td', { class: 'num' }, r.resist),
        ))),
      ),
    ),
    h('h3', {}, '攻撃技の範囲（ばつぐんを取れるタイプ）'),
    h('div', { class: 'cover' }, off.map((r) =>
      h('span', { class: `cover-item ${r.best > 1 ? 'ok' : 'ng'}`, title: r.who.map((id) => jaPokemon(db, id)).join('、') || 'なし' },
        typeBadge(r.type, true), r.best > 1 ? `${r.who.length}` : '—'))),
    h('p', { class: 'muted small' }, '数字は、ばつぐんを取れるメンバーの数。—は、ばつぐんを取れる技がないタイプ。'),
    h('p', { class: 'muted small' }, `弱点が2体以上で、半減以下がいないタイプを強調しています（${def.filter((r) => r.danger === 2).map((r) => TYPE_JA[r.type]).join('・') || 'なし'}）。`),
  );
}

function speedView(app, battlers) {
  const db = app.db;
  const rows = speedList(db, battlers, 40);
  return h('div', {},
    h('p', { class: 'muted small' }, '環境の上位40体は、よく使われる性格と能力ポイントで計算しています。こだわりスカーフは1.5倍。'),
    h('ol', { class: 'speed-list' }, rows.map((r) =>
      h('li', { class: r.mine ? 'mine' : '' },
        h('span', { class: 'num speed' }, r.speed),
        h('span', {}, jaPokemon(db, r.title)),
        r.scarf ? h('span', { class: 'tag' }, 'スカーフ') : null,
        r.mine ? h('span', { class: 'tag mine-tag' }, '自分') : h('span', { class: 'muted small' }, `${r.pos}位`),
      ))),
  );
}
