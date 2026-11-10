// 選出（相手の6体に対して、選ぶメンバーと先発を提案する）
import { h, mount, typeBadges, pokemonCombo, iconButton, scoreClass, scoreMark, duelDamage, DUEL_LEGEND } from '../ui.js';
import { jaPokemon, jaItem, jaAbility, jaMove } from '../data.js';
import { selectionPlan, metaBattler } from '../analysis.js';
import * as store from '../store.js';
import { formatLabel } from './common.js';

export function renderSelect(app, root) {
  const db = app.db;
  const team = store.getTeam(app.key);
  const opp = store.getOpponents(app.key).map((id) => (id && db.dex[id] ? id : null));
  const setOpp = (next) => {
    store.setOpponents(app.key, next);
    renderSelect(app, root);
  };
  const pick = db.doubles ? 4 : 3;

  const oppSlots = h('div', { class: 'opp-slots' }, opp.map((id, i) =>
    h('div', { class: 'opp-slot' },
      pokemonCombo(db, {
        value: id,
        placeholder: `相手${i + 1}`,
        onPick: (v) => {
          const next = opp.slice();
          next[i] = v || null;
          setOpp(next);
        },
      }),
      id ? iconButton('close', '外す', () => { const next = opp.slice(); next[i] = null; setOpp(next); }) : null,
    )));

  const mine = team.filter(Boolean);
  const foes = opp.filter(Boolean);
  let result = null;
  if (mine.length && foes.length) result = selectionPlan(db, team, opp);

  mount(root, ...[
    h('section', { class: 'page-head row' },
      h('h1', {}, `選出（${formatLabel(db)}・${pick}体）`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => setOpp(db.ranking.slice(0, 6).map((r) => r.id)) }, '上位6体を入れる'),
      foes.length ? h('button', { class: 'btn', type: 'button', onclick: () => setOpp([null, null, null, null, null, null]) }, 'クリア') : null,
    ),
    h('section', { class: 'card' }, h('h2', {}, '相手の6体'), oppSlots),
    !mine.length
      ? h('p', { class: 'muted' }, '構築の画面で、自分のポケモンを入れてください。')
      : !foes.length
        ? h('p', { class: 'muted' }, '相手のポケモンを入れると、選出を提案します。')
        : [plans(db, result), matrix(db, result), foesInfo(db, foes)],
  ].flat());
}

function plans(db, r) {
  return h('section', { class: 'card' },
    h('h2', {}, 'おすすめの選出'),
    h('ol', { class: 'plans' }, r.plans.map((p, k) =>
      h('li', { class: 'plan' },
        h('div', { class: 'plan-members' },
          h('span', { class: 'plan-rank' }, k + 1),
          p.members.map((id) => h('span', { class: `plan-mon${p.lead.includes(id) ? ' lead' : ''}` }, jaPokemon(db, id))),
        ),
        h('div', { class: 'muted small' },
          `先発: ${p.lead.map((id) => jaPokemon(db, id)).join('・')}`,
          p.uncovered.length ? ` / 有利なメンバーがいない相手: ${p.uncovered.map((id) => jaPokemon(db, id)).join('、')}` : ''),
      ))),
  );
}

function matrix(db, r) {
  return h('section', { class: 'card' },
    h('h2', {}, '対面表'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'mu-table' },
        h('thead', {}, h('tr', {}, h('th', { class: 'sticky' }, '自分＼相手'), r.foes.map((f) => h('th', { class: 'mu-col' }, f.name)))),
        h('tbody', {}, r.mine.map((m, i) => h('tr', {},
          h('th', { class: 'sticky' }, m.name),
          r.matrix[i].map((d) => h('td', {
            class: `mu-cell ${scoreClass(d.score)}`,
            title: `与 ${jaMove(db, d.a.move) ?? '-'} ${d.a.minPct.toFixed(0)}〜${d.a.maxPct.toFixed(0)}% / 被 ${jaMove(db, d.b.move) ?? '-'} ${d.b.minPct.toFixed(0)}〜${d.b.maxPct.toFixed(0)}%`,
          }, h('span', { class: 'mu-mark' }, scoreMark(d.score)), h('span', { class: 'mu-dmg' }, duelDamage(d)))),
        ))),
      ),
    ),
    h('p', { class: 'muted small' }, DUEL_LEGEND),
  );
}

// 相手のよく使われる型
function foesInfo(db, foes) {
  return h('section', { class: 'card' },
    h('h2', {}, '相手のよく使われる型'),
    h('div', { class: 'foe-grid' }, foes.map((id) => {
      const b = metaBattler(db, id);
      return h('a', { class: 'foe', href: `#/p/${id}` },
        h('div', { class: 'slot-head' }, h('span', { class: 'slot-name' }, b.name), typeBadges(b.types, true)),
        h('div', { class: 'muted small' }, `${jaItem(db, b.item) || '-'} / ${jaAbility(db, b.ability)} / S ${b.stats[5]}`),
        h('div', { class: 'slot-moves' }, b.moves.map((m) => h('span', {}, jaMove(db, m)))),
      );
    })),
  );
}
