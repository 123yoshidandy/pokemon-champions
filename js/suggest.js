// 環境データからの、おすすめの構築（6体）の提案
// 上位の相手への有利さ・弱点の重なり・よく組まれる組み合わせで点を付け、
// 1体ずつ足しながら良い組み合わせを残していく（ビームサーチ）
import { TYPES, defenseProfile } from './types.js';
import { usageOf, isMegaStone, moveData, isAttack } from './data.js';
import { defaultMember, memberBattler, normalizeTeam, megaStoneShare, MEGA_ONLY_SHARE, TEAM_SIZE } from './team.js';
import { duel, topMeta, rankWeight, teamSupport, supportNames, fieldClash, weatherMisfits } from './analysis.js';

// ---------- スタイル ----------

const WEATHER = {
  sun: { label: 'はれ', setter: ['Drought'], abusers: ['Chlorophyll', 'Solar Power', 'Protosynthesis', 'Flower Gift'], type: 'Fire' },
  rain: { label: 'あめ', setter: ['Drizzle'], abusers: ['Swift Swim', 'Rain Dish', 'Dry Skin'], type: 'Water' },
  sand: { label: 'すなあらし', setter: ['Sand Stream'], abusers: ['Sand Rush', 'Sand Force', 'Sand Veil'], type: 'Rock' },
  snow: { label: 'ゆき', setter: ['Snow Warning'], abusers: ['Slush Rush', 'Ice Body', 'Snow Cloak'], type: 'Ice' },
};

export const STYLES = {
  '': { label: 'おまかせ' },
  ...Object.fromEntries(Object.entries(WEATHER).map(([k, v]) => [k, { label: v.label }])),
  trickroom: { label: 'トリックルーム' },
  tailwind: { label: 'おいかぜ' },
  perish: { label: '滅び' },
  baton: { label: 'バトン' },
  // 介護（このゆびとまれ・いかりのこなで攻撃を引きつけ、エースに積ませる）はダブルだけ
  carry: { label: '介護', doubles: true },
};

// 形式で使えるスタイル
export const stylesFor = (db) => Object.entries(STYLES).filter(([, v]) => !v.doubles || db.doubles);

// 技で始めるスタイルの、始動の技
export const STYLE_MOVES = {
  trickroom: ['Trick Room'],
  tailwind: ['Tailwind'],
  perish: ['Perish Song'],
  baton: ['Baton Pass'],
  carry: ['Follow Me', 'Rage Powder', 'Ally Switch'],
};

// 能力を上げる技（バトン・介護で活きる）
const SETUP_MOVES = new Set(['Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind', 'Quiver Dance', 'Shell Smash', 'Bulk Up',
  'Belly Drum', 'Agility', 'Iron Defense', 'Cosmic Power', 'Acid Armor', 'Curse', 'Coaching', 'Victory Dance', 'Shift Gear', 'Tidy Up', 'Growth', 'Work Up']);
// 滅びで、ほろびのカウントを稼ぐ技
const STALL_MOVES = new Set(['Protect', 'Detect', 'Spiky Shield', "King's Shield", 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark', 'Fake Out', 'Follow Me', 'Rage Powder']);

// 振りなしのすばやさ（Lv50）がこれ以下なら、トリックルームで活きるとみなす（種族値 80 以下）
const TR_SPEED = 100;

const hasMove = (b, name) => b.moves.includes(name);

export function isSetter(b, style) {
  if (WEATHER[style]) return WEATHER[style].setter.includes(b.ability);
  return (STYLE_MOVES[style] ?? []).some((m) => hasMove(b, m));
}

// スタイルの始動の技を、採用率がこれ以上なら、よく使われる4つの技に入っていなくても入れて比べる
const STYLE_MOVE_MIN_PCT = 5;

// スタイルに合わせた型（始動の技が4つの技になければ、4つ目と入れ替える）
export function styleMember(db, member, style) {
  const keys = STYLE_MOVES[style];
  if (!keys || keys.some((m) => member.moves.includes(m))) return member;
  const use = usageOf(db, member.id).moves.find(([m, p]) => keys.includes(m) && p >= STYLE_MOVE_MIN_PCT);
  if (!use) return member;
  const moves = member.moves.slice();
  // まもるは残し、採用の少ない方から入れ替える
  const i = moves.findLastIndex((m) => m && m !== 'Protect');
  moves[i >= 0 ? i : Math.max(0, moves.findLastIndex(Boolean))] = use[0];
  return { ...member, moves };
}

// その場を活かせるか（始動役は除く）
export function isAbuser(db, b, style) {
  const w = WEATHER[style];
  if (w) {
    if (w.abusers.includes(b.ability)) return true;
    return b.moves.some((m) => {
      const mv = moveData(db, m);
      return isAttack(mv) && mv.power && mv.type === w.type;
    }) && b.types.includes(w.type);
  }
  if (style === 'trickroom') return (db.dex[b.id]?.stats[5] ?? Infinity) <= TR_SPEED;
  if (style === 'tailwind') return b.stats[5] >= 90 && b.stats[5] <= 140;
  if (style === 'perish') return b.moves.some((m) => STALL_MOVES.has(m));
  if (style === 'baton' || style === 'carry') return b.moves.some((m) => SETUP_MOVES.has(m));
  return false;
}

// 構築にあるスタイル（表示用）
export function detectStyles(db, battlers) {
  return stylesFor(db).map(([s]) => s).filter((s) => s && battlers.some((b) => isSetter(b, s)));
}

// スタイルの始動役になれるポケモン（候補の範囲の外でも足す）
function styleSetterIds(db, style) {
  if (!style) return [];
  const w = WEATHER[style];
  return db.ranking.map((r) => r.id).filter((id) => {
    const u = usageOf(db, id);
    if (w) return u.abilities.some(([a, p]) => w.setter.includes(a) && p >= STYLE_MOVE_MIN_PCT);
    return u.moves.some(([m, p]) => STYLE_MOVES[style]?.includes(m) && p >= STYLE_MOVE_MIN_PCT);
  });
}

// ---------- 候補の下ごしらえ ----------

// 支援ごとの対面の条件（ダブルだけ）。上がり幅を候補ごとに計算しておき、構築の支援に合わせて足す
const SUPPORT_OPTS = {
  tailwind: { tailwind: true },
  trickRoom: { trickRoom: true },
  screens: { reflect: true, lightScreen: true },
  intimidate: { intimidate: true },
  fakeOut: { fakeOut: true },
};

// 構築の支援（壁は、リフレクターとひかりのかべの片方なら半分とみなす）
function supportOf(db, team) {
  const s = teamSupport(db, team.map((c) => c.battler));
  return { ...s, screens: (s.reflect ? 0.5 : 0) + (s.lightScreen ? 0.5 : 0) };
}

// 候補 c の、相手 j への有利さ（構築の支援 sup を入れる）
function supportedScore(c, j, sup) {
  let s = c.scores[j];
  if (!c.deltas) return s;
  const d = c.deltas;
  s += Math.max(0, sup.tailwind ? d.tailwind[j] : 0, sup.trickRoom ? d.trickRoom[j] : 0);
  if (sup.screens) s += sup.screens * d.screens[j];
  if (sup.intimidate) s += d.intimidate[j];
  if (sup.fakeOut || sup.redirect) s += d.fakeOut[j];
  return Math.max(-1, Math.min(1, s));
}

// 計算した候補を、データ・相手の数・スタイルごとに覚えておく（提案を出し直すときや、軸を変えて何度も出すときに使い回す）
const prepared = new WeakMap();

// 候補ごとに、メガストーンあり／なしの型と、上位の相手への有利さを計算しておく
function prepare(db, ids, threats, style = '') {
  if (!prepared.has(db)) prepared.set(db, new Map());
  const memoKey = `${threats.length}|${style}`;
  const byKey = prepared.get(db);
  if (!byKey.has(memoKey)) byKey.set(memoKey, new Map());
  const memo = byKey.get(memoKey);
  const cands = new Map();
  for (const id of ids) {
    if (!db.dex[id] || cands.has(id)) continue;
    if (memo.has(id)) {
      cands.set(id, memo.get(id));
      continue;
    }
    const variants = [];
    const main = styleMember(db, defaultMember(db, id), style);
    variants.push(main);
    // メガなしの型。使用率データのほとんどがメガシンカの型の種族は、メガなしでは候補にしない（実在しない型になるため）。
    // メガシンカバトルでは、メガは1体だけで残りはメガなしにするしかないので、持ち物に合わせて組み直した型を使う
    if (isMegaStone(db, id, main.item) && (db.megaRule || megaStoneShare(db, id) < MEGA_ONLY_SHARE)) {
      variants.push(styleMember(db, defaultMember(db, id, [], { noMega: true }), style));
    }
    cands.set(id, variants.map((member) => {
      const b = memberBattler(db, member);
      const scores = threats.map((t) => (t.id === id ? 0 : duel(db, b, t).score));
      const deltas = db.doubles
        ? Object.fromEntries(Object.entries(SUPPORT_OPTS).map(([k, opts]) =>
          [k, threats.map((t, j) => (t.id === id ? 0 : duel(db, b, t, opts).score - scores[j]))]))
        : null;
      return {
        id,
        member,
        battler: b,
        mega: isMegaStone(db, id, member.item),
        scores,
        deltas,
        prof: defenseProfile(b.types, b.ability),
      };
    }));
    memo.set(id, cands.get(id));
  }
  return cands;
}

// ---------- 点数 ----------

// 天気に頼るのに、構築の天気と合わないメンバー1体あたりの減点
const MISFIT_PENALTY = 0.08;

function evaluate(db, team, ctx) {
  const { threats, weights, wsum, style } = ctx;
  // 上位の相手への有利さ（一番有利なメンバー + 2番手を少し）
  let cover = 0;
  const holes = [];
  const sup = supportOf(db, team);
  threats.forEach((t, j) => {
    let best = -1;
    let second = -1;
    for (const c of team) {
      const s = supportedScore(c, j, sup);
      if (s > best) [best, second] = [s, best];
      else if (s > second) second = s;
    }
    cover += weights[j] * (best + 0.3 * Math.max(0, second));
    if (best <= 0) holes.push(t.id);
  });
  cover /= wsum;

  // 弱点の重なり
  let defense = 0;
  const stacked = [];
  for (const type of TYPES) {
    let weak = 0;
    let resist = 0;
    for (const c of team) {
      if (c.prof[type] > 1) weak++;
      else if (c.prof[type] < 1) resist++;
    }
    if (weak >= 3 || (weak >= 2 && resist === 0)) {
      defense += weak >= 3 && resist === 0 ? 0.12 : 0.06;
      stacked.push(type);
    }
  }

  // よく組まれる組み合わせ（どちらかの採用データの上位5体に、もう一方が入っている）
  const pairs = [];
  for (let i = 0; i < team.length; i++) {
    for (let k = i + 1; k < team.length; k++) {
      const a = team[i].id;
      const b = team[k].id;
      if (usageOf(db, a).teammates.slice(0, 5).includes(b) || usageOf(db, b).teammates.slice(0, 5).includes(a)) pairs.push([a, b]);
    }
  }

  // スタイル
  let styleBonus = 0;
  if (style) {
    const setters = team.filter((c) => isSetter(c.battler, style)).length;
    const abusers = team.filter((c) => !isSetter(c.battler, style) && isAbuser(db, c.battler, style)).length;
    styleBonus = (setters ? 0.1 : -0.3) + Math.min(abusers, 4) * 0.08 - Math.max(0, setters - 2) * 0.05;
    // トリックルームでは、速いメンバーが裏目に出る
    if (style === 'trickroom') styleBonus -= team.filter((c) => c.battler.stats[5] >= 120 && !isSetter(c.battler, style)).length * 0.04;
  }

  // ほかの提案ですでに使ったメンバーを、少し減点する（似た構築ばかりにならないように）
  const reuse = ctx.used ? team.reduce((a, c) => a + (ctx.used.get(c.id) ?? 0), 0) * 0.04 : 0;

  const popularity = team.reduce((a, c) => a + rankWeight(db.rankOf.get(c.id)?.pos), 0) * 0.01;
  // 天気に頼るのに、構築の天気と合わないメンバー
  const misfits = weatherMisfits(team.map((c) => c.battler));
  const base = cover - defense + Math.min(pairs.length, 5) * 0.02 + styleBonus + popularity - misfits.length * MISFIT_PENALTY;
  return { score: base - reuse, base, cover, holes, stacked, pairs, styleBonus, support: supportNames(sup), misfits };
}

// ---------- 探索 ----------

/**
 * @param axis 軸にするポケモン（必ず入れる）の id。最大 5 体
 * @param opts { pool: 候補にする上位の数, threats: 相手にする上位の数, style, beam, results }
 * @returns [{ team: member[6], members, eval }]
 */
export function suggestTeams(db, axis = [], { pool = 60, threats: threatN = 40, style = '', beam = 24, results = 5 } = {}) {
  const threatIds = topMeta(db, threatN);
  const threatBattlers = threatIds.map((id) => memberBattler(db, defaultMember(db, id)));
  const weights = threatIds.map((id) => rankWeight(db.rankOf.get(id)?.pos));
  const ctx = { threats: threatBattlers, weights, wsum: weights.reduce((a, b) => a + b, 0), style };
  const axisIds = [...new Set(axis.filter((id) => db.dex[id]))].slice(0, TEAM_SIZE - 1);
  const cands = prepare(db, [...axisIds, ...topMeta(db, pool), ...styleSetterIds(db, style)], threatBattlers, style);

  // 1体のポケモンについて、チームの状態に合う型（メガシンカは1体まで）
  const variantFor = (id, team) => {
    const megaTaken = team.some((c) => c.mega);
    return cands.get(id).find((v) => !(megaTaken && v.mega)) ?? null;
  };
  const sameBase = (team, id) => team.some((c) => db.dex[c.id].base === db.dex[id].base);
  const key = (team) => team.map((c) => `${c.id}:${c.mega ? 1 : 0}`).sort().join(',');

  // 始まり: 軸。スタイルの指定があって、軸に始動役がいなければ、始動役ごとに始める
  let start = [];
  for (const id of axisIds) {
    const v = variantFor(id, start);
    if (v && !sameBase(start, id)) start.push(v);
  }
  let states = [start];
  if (style && !start.some((c) => isSetter(c.battler, style))) {
    const setters = [...cands.keys()].filter((id) => !sameBase(start, id)).map((id) => variantFor(id, start)).filter((v) => v && isSetter(v.battler, style) && !fieldClash([...start, v].map((c) => c.battler)));
    if (setters.length) states = setters.map((v) => [...start, v]);
  }

  const search = () => {
    let cur = states;
    while (cur[0].length < TEAM_SIZE) {
      const next = new Map();
      for (const team of cur) {
        for (const id of cands.keys()) {
          if (sameBase(team, id)) continue;
          const v = variantFor(id, team);
          if (!v) continue;
          const t = [...team, v];
          // 違う天気どうし・違うフィールドどうしは、同じ構築に入れない
          if (fieldClash(t.map((c) => c.battler))) continue;
          const k = key(t);
          if (!next.has(k)) next.set(k, { team: t, ev: evaluate(db, t, ctx) });
        }
      }
      if (!next.size) break;
      cur = [...next.values()].sort((a, b) => b.ev.score - a.ev.score).slice(0, beam).map((x) => x.team);
    }
    return cur;
  };

  // 1つ選ぶごとに、使ったメンバーを減点して探し直す。軸の数より多く、同じメンバーが重なる構築は外す
  const picked = [];
  ctx.used = new Map();
  const maxShared = Math.max(4, start.length + 1);
  for (let round = 0; round < results * 2 && picked.length < results; round++) {
    const finals = search().map((team) => ({ team, ev: evaluate(db, team, ctx) })).sort((a, b) => b.ev.score - a.ev.score);
    const f = finals.find((x) => {
      const ids = new Set(x.team.map((c) => c.id));
      return !picked.some((p) => p.team.filter((c) => ids.has(c.id)).length > maxShared);
    });
    if (f) picked.push(f);
    for (const c of (f ?? finals[0]).team) if (!axisIds.includes(c.id)) ctx.used.set(c.id, (ctx.used.get(c.id) ?? 0) + 1);
  }
  picked.sort((a, b) => b.ev.base - a.ev.base);

  return picked.map(({ team, ev }) => {
    // 構築に入れる形にする（持ち物が重ならないように、順に選び直す）
    const members = [];
    // 技は、スタイルに合わせた型のまま
    for (const c of team) members.push(c.mega ? c.member : { ...defaultMember(db, c.id, members, { noMega: team.some((x) => x.mega) }), moves: c.member.moves });
    const battlers = members.map((m) => memberBattler(db, m));
    return { team: normalizeTeam(members), battlers, eval: ev, styles: detectStyles(db, battlers) };
  });
}

// ---------- いちばんのおすすめ ----------

// 条件を選ばずに、候補・相手・探索の幅を広げて、一番点の高い構築を1つに絞る
export const BEST_OPTS = { pool: 100, threats: 60, beam: 48, results: 1 };
export const bestTeam = (db) => suggestTeams(db, [], BEST_OPTS)[0] ?? null;

// ---------- マイナーなポケモンを軸に ----------

// 上位 MINOR_FROM 体の外を「マイナー」とし、MINOR_TO 位までから軸を探す
export const MINOR_FROM = 50;
const MINOR_TO = 150;

/**
 * マイナーなポケモンのうち、上位の相手に勝てる数が多く、特に上位のポケモンがあまり勝てない相手に勝てるものを選ぶ
 * @returns [{ id, score, answers: 勝てる上位の相手の id }]
 */
export function minorAxes(db, { threats: threatN = 40, style = '', n = 5 } = {}) {
  const threatIds = topMeta(db, threatN);
  const threatBattlers = threatIds.map((id) => memberBattler(db, defaultMember(db, id)));
  const weights = threatIds.map((id) => rankWeight(db.rankOf.get(id)?.pos));
  const major = prepare(db, topMeta(db, MINOR_FROM), threatBattlers, style);
  const minorIds = db.ranking.filter((r) => r.pos > MINOR_FROM && r.pos <= MINOR_TO && db.usage[r.id]).map((r) => r.id);
  const minor = prepare(db, minorIds, threatBattlers, style);
  // 相手ごとに、上位のポケモンのうち有利なものの割合（少ないほど、その相手に勝てることの値打ちが高い）
  const majorList = [...major.values()].map((v) => v[0]);
  const answered = threatIds.map((_, j) => majorList.filter((c) => c.scores[j] > 0).length / Math.max(1, majorList.length));
  const list = [...minor.values()].map((variants) => {
    const c = variants[0];
    let score = 0;
    const answers = [];
    threatIds.forEach((tid, j) => {
      const s = c.scores[j];
      if (s <= 0) return;
      score += weights[j] * s * (0.5 + (1 - answered[j]));
      answers.push(tid);
    });
    return { id: c.id, score, answers };
  });
  // 同じポケモンの別のすがたは、1つだけにする
  const seen = new Set();
  return list.sort((a, b) => b.score - a.score).filter((x) => {
    const base = db.dex[x.id].base;
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  }).slice(0, n);
}

// マイナーなポケモンを1体ずつ軸にして、構築を1つずつ出す（軸以外はマイナーでなくてよい）
export function minorAxisTeams(db, { pool = 60, threats = 40, style = '', n = 5 } = {}) {
  return minorAxes(db, { threats, style, n }).map((axis) => {
    const t = suggestTeams(db, [axis.id], { pool, threats, style, results: 1 })[0];
    return t ? { ...t, axis } : null;
  }).filter(Boolean);
}
