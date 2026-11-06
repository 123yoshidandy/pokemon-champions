// 画面どうしで共通の処理
import * as store from '../store.js';
import { defaultMember } from '../team.js';
import { jaPokemon } from '../data.js';
import { toast } from '../ui.js';

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

export function dataDate(db) {
  const d = db.date ?? db.meta?.date;
  return d ? d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3') : '';
}
