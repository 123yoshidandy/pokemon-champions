// 画面どうしで共通の処理
import * as store from '../store.js';
import { defaultMember } from '../team.js';
import { jaPokemon } from '../data.js';
import { h, toast } from '../ui.js';

// 構築の空いている枠に、よく使われる型で入れる
export function addToTeam(app, id) {
  const team = store.getTeam(app.format);
  if (team.some((m) => m?.id === id)) {
    toast(`${jaPokemon(app.db, id)} はもう入っています`);
    return false;
  }
  const i = team.findIndex((m) => !m);
  if (i < 0) {
    toast('構築が6体そろっています');
    return false;
  }
  team[i] = defaultMember(app.db, id, team);
  store.setTeam(app.format, team);
  toast(`${jaPokemon(app.db, id)} を構築に入れました`);
  return true;
}

export const formatLabel = (db) => (db.doubles ? 'ダブル' : 'シングル');

// 環境の傾向・ポケモンの対面で見る「上位N体」（画面どうしで共通にして覚える）
const TOP_N = [10, 30, 50, 100];
export const getTopN = () => {
  const n = store.getPref('topN', 30);
  return TOP_N.includes(n) ? n : 30;
};

export function topNSelect(onChange) {
  const n = getTopN();
  return h('select', {
    class: 'top-n',
    'aria-label': '相手にする上位の数',
    onchange: (e) => { store.setPref('topN', Number(e.target.value)); onChange(); },
  }, TOP_N.map((v) => h('option', { value: v, selected: v === n }, `上位${v}体`)));
}

export function dataDate(db) {
  const d = db.date ?? db.meta?.date;
  return d ? d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3') : '';
}
