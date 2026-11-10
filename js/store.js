// ブラウザに保存する状態（形式ごと）
import { normalizeTeam } from './team.js';

const PREFIX = 'pcb:';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 保存できなくても画面は動かす
  }
}

export const getFormat = () => (load('format', 'doubles') === 'singles' ? 'singles' : 'doubles');
export const setFormat = (f) => save('format', f);

// メガシンカバトル（メガシンカできるポケモンだけのルール）で見るか
export const getMegaRule = () => load('megaRule', false) === true;
export const setMegaRule = (on) => save('megaRule', !!on);

export const getTeam = (format) => normalizeTeam(load(`team:${format}`, []));
export const setTeam = (format, team) => save(`team:${format}`, team);

// 保存した構築 [{ name, team, savedAt }]
export const getSaved = (format) => load(`saved:${format}`, []);
export const setSaved = (format, list) => save(`saved:${format}`, list);

export const getOpponents = (format) => {
  const v = load(`opp:${format}`, []);
  return [...v, null, null, null, null, null, null].slice(0, 6);
};
export const setOpponents = (format, ids) => save(`opp:${format}`, ids);

export const getPref = (key, fallback) => load(`pref:${key}`, fallback);
export const setPref = (key, value) => save(`pref:${key}`, value);
