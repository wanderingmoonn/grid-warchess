/**
 * **批 0：让位账（只读）**——`docs/PLAN-V4-PHASE4-2026-11-26.md` §4.23 的第一批。
 *
 * 它不改任何决策，只回答四个问题（每个都能数，不打分）：
 *
 *   ① 站在"必须空"的格子上、却**不在任何编队里**的我方战斗兵有几个（= 失忆的人）；
 *   ② 其中**射程内有敌人**的有几个（= 本来能开火，却被派去让路）；
 *   ③ 被派了让路、落点**还落在名单上**的有几个（= 从关键格挪到关键格，纯空转）；
 *   ④ 被派了让路、离**最近的自城 / 最近的敌城**反而更远的有几个（= 越让越远）。
 *
 * 另外记两个归因用的数：让位发生在**城格**（产兵口）还是**城圈/桥头**（出门通道），
 * 以及这一手被引擎拒了几次（"目标格不可达"是让位最典型的浪费）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────
 *
 * 改让位之前必须先有这个刻度。否则"改完变好了"只能靠胜率说，而胜率的噪声
 * 比这几条判据大一个量级（见 `docs/PLAN-V4-PHASE4` §3.1："实战不是刻度，是探针"）。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *
 *   node --experimental-strip-types scripts/probe-yield4.ts --exam exams/D-3-01
 *   ... --exam exams/D-3-01,exams/D-1-01 --cap 60 --detail
 *
 * `--detail` 打出每一手有让位的明细（谁、从哪到哪、目标来源、前后距离）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { passable } from '../src/core/config.ts';
import { applyAction, attackableTargets, utype } from '../src/core/rules.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { currentView, resetV4 } from '../src/core/v4/ai-v4.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const DETAIL = process.argv.includes('--detail');
/**
 * `--check-keep`：**批 1 的自查**——需求表拼出来的"必须空"清单，必须和旧的手写几何循环
 * （城格 + 外一圈 + 桥头，按行主序）**逐格、逐序**一致。
 *
 * 为什么不只是"39 题没变"：矩阵只比结论（红/绿），格子清单错了也可能碰巧不改红绿。
 * 这里把旧公式**原样抄一份当对照**——它是"特征测试"，不是第二套实现：
 * 批 2 引入名额时会**故意**让它开始不一致，那时应该同步改这个检查，而不是让它静默通过。
 */
const CHECK_KEEP = process.argv.includes('--check-keep');
let keepMismatch = 0;

const EXAM_ARGS = argOf('exam', 'exams/D-3-01').split(',').map((x) => x.trim()).filter(Boolean);
const CAP = Number(argOf('cap', '0'));
const SEED = Number(argOf('seed', '0'));

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<
  typeof import('../src/core/ai.ts')['aiNextAction']
>;
const meNext = ((await import('../src/core/v4/ai-v4.ts')) as { aiNextAction: AiFn }).aiNextAction;
const foeNext = ((await import('../src/core/ai.ts')) as { aiNextAction: AiFn }).aiNextAction;

/** 一手的读数 */
type Row = {
  turn: number;
  /** 我方战斗兵 */
  combat: number;
  /** 站在名单上的 */
  onKeep: number;
  /** 其中在编队名册里的（桥面豁免，正常应该 >0） */
  onKeepInSquad: number;
  /** 其中射程内有敌人的 */
  onKeepHit: number;
  /** 这一手被派了让位的人次 */
  yields: number;
  /** 让位发生在城格 / 城圈·桥头 */
  yieldCity: number;
  yieldRing: number;
  /** 落点还在名单上（空转） */
  ontoKeep: number;
  /** 没有目标（无队、无岗、无调令） */
  noGoal: number;
  /** 离最近的自城更远 */
  awayCity: number;
  /** 离最近的敌城更远 */
  awayFoe: number;
  /** 射程内有敌人、却被派去让路 */
  hitAndYield: number;
  /** 命中"帮倒忙"三件的**去重人次**（空转 / 无目标 / 能打却让） */
  bad: number;
  /** 这一手被引擎拒的动作次数 */
  rejects: number;
};

const rows: Row[] = [];
const details: string[] = [];
let totalRejects = 0;

function playExam(dir: string): void {
  const snapPath = resolve(dir, 'snap.json');
  if (!existsSync(snapPath)) {
    console.log(`跳过 ${dir}：没有 snap.json`);
    return;
  }
  const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as { state: GameState };
  const critPath = resolve(dir, 'criteria.json');
  const crit = existsSync(critPath)
    ? (JSON.parse(readFileSync(critPath, 'utf8')) as { me?: PlayerId; window?: number })
    : {};
  const ME: PlayerId = crit.me ?? raw.state.current;
  const FOE: PlayerId = ME === 'A' ? 'B' : 'A';
  const cap = SEED ? CAP || crit.window || 60 : CAP || crit.window || 60;

  resetV4();
  const s0 = structuredClone(raw.state);
  s0.aiControl = { [ME]: false, [FOE]: false } as Record<PlayerId, boolean>;
  if (SEED) s0.seed = SEED;

  const before = rows.length;
  let s = s0;
  let turnIdx = 0;
  let rejectsThisGame = 0;

  console.log(`\n=== ${dir} · ${ME} 方 · 上限 ${cap} 手 ===`);

  while (!s.winner && s.turn - s0.turn < cap) {
    const who = s.current;
    if (who === ME) {
      /*
       * 拿这一手的视图：和 AI 内部用的是同一个（`currentView` 按回合缓存），
       * 所以这里读到的是"它真的打算这么干"，不是另算一遍。
       */
      const view = currentView(s, ME);
      const row = measure(s, ME, view, turnIdx);
      const st = stepSide(s, meNext);
      s = st.state;
      row.rejects = st.rejects;
      rejectsThisGame += st.rejects;
      rows.push(row);
      totalRejects += st.rejects;
      printRow(row);
      turnIdx += 1;
    } else {
      s = stepSide(s, foeNext).state;
    }
  }

  const mine = rows.slice(before);
  const sum = (f: (r: Row) => number): number => mine.reduce((n, r) => n + f(r), 0);
  console.log(
    `— 小计：让位 ${sum((r) => r.yields)} 人次 | 空转(落点还在名单上) ${sum((r) => r.ontoKeep)}` +
      ` | 无目标 ${sum((r) => r.noGoal)} | 射程内有人却让 ${sum((r) => r.hitAndYield)}` +
      ` | 离自城更远 ${sum((r) => r.awayCity)} | 离敌城更远 ${sum((r) => r.awayFoe)}` +
      ` | 拒 ${rejectsThisGame}`,
  );
  const lost = s0.cities.filter((c) => c.owner === ME && !c.ruined).length -
    s.cities.filter((c) => c.owner === ME && !c.ruined).length;
  console.log(
    `— 终局：第 ${s.turn} 手 · 我方城 ${s.cities.filter((c) => c.owner === ME && !c.ruined).length}` +
      `（丢 ${lost}）· 我方战斗兵 ${s.units.filter((u) => u.owner === ME && utype(s, u.type).category === 'combat').length}` +
      ` · 敌方战斗兵 ${s.units.filter((u) => u.owner === FOE && utype(s, u.type).category === 'combat').length}`,
  );
}

/**
 * **旧的手写几何循环，原样抄一份当对照**（只给 `--check-keep` 用）。
 *
 * 这是"特征测试"：把批 1 之前的构造固定下来，用来证明"搬位置"真的没改任何一格。
 * 批 2 引入名额之后它会**故意**开始不一致——那时要么同步改它，要么删掉它，
 * **不许让它静默通过**（静默通过等于这层保护失效了）。
 */
function legacyKeepClear(
  s: GameState,
  cities: ReadonlyArray<{ city: { x: number; y: number; size?: number }; foeEta: number }>,
): number[] {
  const out: number[] = [];
  for (const info of cities) {
    const city = info.city;
    const n = city.size ?? 2;
    for (let dy = -1; dy <= n; dy++) {
      for (let dx = -1; dx <= n; dx++) {
        const inside = dx >= 0 && dy >= 0 && dx < n && dy < n;
        if (inside && info.foeEta <= 1) continue;
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const t = s.tiles[y * s.w + x]?.terrain;
        if (!t || !passable(t)) continue;
        out.push(y * s.w + x);
      }
    }
  }
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[y * s.w + x]?.terrain !== 'bridge') continue;
      let water = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = s.tiles[(y + dy) * s.w + (x + dx)]?.terrain;
        if (t === 'water' || t === 'deep') water += 1;
      }
      if (water >= 2) out.push(y * s.w + x);
    }
  }
  return [...new Set(out)];
}

/** 一手的读数（在**任何动作执行之前**算） */
function measure(
  s: GameState,
  ME: PlayerId,
  view: ReturnType<typeof currentView>,
  turnIdx: number,
): Row {
  const { world, con } = view;
  const keep = new Set(con.keepClear);
  const cityCells = new Set<number>();
  for (const c of world.myCities) {
    const n = c.size ?? 2;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cityCells.add((c.y + dy) * s.w + (c.x + dx));
  }
  const squadOf = new Map<string, (typeof con.squads)[number]>();
  for (const q of con.squads) for (const id of q.unitIds) squadOf.set(id, q);

  /* 真实步数场（按格缓存）——"更远/更近"一律用它，不用直线距离 */
  const fields = new Map<number, Float64Array>();
  const fieldOf = (p: { x: number; y: number }): Float64Array => {
    const k = p.y * s.w + p.x;
    let f = fields.get(k);
    if (!f) {
      f = world.stepsFrom(p);
      fields.set(k, f);
    }
    return f;
  };
  const stepTo = (p: { x: number; y: number }, at: { x: number; y: number }): number =>
    fieldOf(p)[at.y * s.w + at.x] ?? Infinity;

  const cityCenters = world.myCities.map((c) => ({
    x: c.x + Math.floor((c.size ?? 2) / 2),
    y: c.y + Math.floor((c.size ?? 2) / 2),
  }));
  const foeCenters = world.foeCities.map((c) => ({
    x: c.x + Math.floor((c.size ?? 2) / 2),
    y: c.y + Math.floor((c.size ?? 2) / 2),
  }));
  const nearestOf = (centers: Array<{ x: number; y: number }>, at: { x: number; y: number }): number =>
    centers.length === 0 ? Infinity : Math.min(...centers.map((c) => stepTo(c, at)));

  const row: Row = {
    turn: s.turn,
    combat: 0,
    onKeep: 0,
    onKeepInSquad: 0,
    onKeepHit: 0,
    yields: 0,
    yieldCity: 0,
    yieldRing: 0,
    ontoKeep: 0,
    noGoal: 0,
    awayCity: 0,
    awayFoe: 0,
    hitAndYield: 0,
    bad: 0,
    rejects: 0,
  };

  if (CHECK_KEEP) {
    const legacy = legacyKeepClear(s, world.cities);
    const now = world.keepClear;
    const same = legacy.length === now.length && legacy.every((k, i) => k === now[i]);
    if (!same) {
      keepMismatch += 1;
      const onlyOld = legacy.filter((k) => !now.includes(k));
      const onlyNew = now.filter((k) => !legacy.includes(k));
      console.log(
        `  ✗ T${s.turn} 「必须空」清单不一致：旧 ${legacy.length} 格 / 新 ${now.length} 格` +
          ` · 只在旧:${onlyOld.length} 只在新:${onlyNew.length}` +
          (onlyOld.length || onlyNew.length ? `（顺序或内容变了）` : '（内容一样但顺序变了）'),
      );
    }
  }

  for (const u of s.units) {
    if (u.owner !== ME) continue;
    if (utype(s, u.type).category !== 'combat') continue;
    row.combat += 1;
    const k = u.y * s.w + u.x;
    if (!keep.has(k)) continue;
    row.onKeep += 1;
    if (squadOf.has(u.id)) row.onKeepInSquad += 1;
    if (attackableTargets(s, u).some((v) => v.owner !== ME)) row.onKeepHit += 1;
  }

  /* 去重：一个人这一手同时"空转 + 无目标"只算一件坏事 */
  const badSet = new Set<string>();
  for (const m of con.yieldMoves) {
    const u = s.units.find((x) => x.id === m.unitId);
    if (!u || u.owner !== ME) continue;
    row.yields += 1;
    const from = { x: u.x, y: u.y };
    const to = { x: m.x, y: m.y };
    const cellKind = cityCells.has(from.y * s.w + from.x)
      ? '城格'
      : s.tiles[from.y * s.w + from.x]?.terrain === 'bridge'
        ? '桥面'
        : '城圈';
    if (cellKind === '城格') row.yieldCity += 1;
    else row.yieldRing += 1;
    if (keep.has(to.y * s.w + to.x)) row.ontoKeep += 1;

    /* 目标：编队终点 → 岗位 → 调令。三者都没有 = 这个人不知道要去哪 */
    const sq = squadOf.get(u.id);
    const post = con.econPosts?.[u.id];
    const tr = con.transit?.[u.id];
    let goal: { x: number; y: number } | undefined;
    let goalSrc = '无';
    /*
     * `order:'yield'` 是**回放标签**，不是任务：它没有城、没有终点。
     * 把它当成"有队"会让所有统计虚高（"这个兵有任务"其实是"它这一手的任务就是走开"）。
     */
    if (sq && sq.order !== 'yield') {
      const c = sq.cityId ? s.cities.find((x) => x.id === sq.cityId) : undefined;
      goal = sq.at ?? (c ? { x: c.x + Math.floor((c.size ?? 2) / 2), y: c.y + Math.floor((c.size ?? 2) / 2) } : undefined);
      goalSrc = `队:${sq.order}`;
    } else if (post) {
      goal = post;
      goalSrc = '岗';
    } else if (tr) {
      goal = tr;
      goalSrc = '调令';
    }
    if (!goal) {
      row.noGoal += 1;
      badSet.add(u.id);
    }

    const dcBefore = nearestOf(cityCenters, from);
    const dcAfter = nearestOf(cityCenters, to);
    if (dcAfter > dcBefore) row.awayCity += 1;
    const dfBefore = nearestOf(foeCenters, from);
    const dfAfter = nearestOf(foeCenters, to);
    if (dfAfter > dfBefore) row.awayFoe += 1;
    const canHit = attackableTargets(s, u).some((v) => v.owner !== ME);
    if (canHit) {
      row.hitAndYield += 1;
      badSet.add(u.id);
    }
    if (keep.has(to.y * s.w + to.x)) badSet.add(u.id);

    if (DETAIL) {
      const gd = goal
        ? `${goalSrc} 目标距 ${stepTo(goal, from).toFixed(0)}→${stepTo(goal, to).toFixed(0)}`
        : `无目标(队=${sq ? `${sq.id}/${sq.order}/${sq.cityId ?? '-'}/at:${sq.at ? '有' : '无'}` : '不在名册'})`;
      const flag = [
        keep.has(to.y * s.w + to.x) ? '空转' : '',
        canHit ? '能打' : '',
        dcAfter > dcBefore ? '远城' : '',
      ]
        .filter(Boolean)
        .join('/');
      details.push(
        `    T${s.turn} ${u.id}(${u.type}) ${cellKind} (${u.x},${u.y})→(${m.x},${m.y}) ` +
          `${gd} 城距 ${dcBefore.toFixed(0)}→${dcAfter.toFixed(0)}${flag ? ' 【' + flag + '】' : ''}`,
      );
    }
  }
  row.bad = badSet.size;
  void turnIdx;
  return row;
}

function printRow(r: Row): void {
  if (r.yields === 0 && r.onKeep === 0) return;
  const pad = (n: number, w = 2): string => String(n).padStart(w, ' ');
  console.log(
    `T${pad(r.turn, 3)} 兵${pad(r.combat)} | 名单上${pad(r.onKeep)}` +
      `(有队${pad(r.onKeepInSquad)} 能打${pad(r.onKeepHit)})` +
      ` | 让${pad(r.yields)}(城${r.yieldCity}/圈${r.yieldRing})` +
      ` 空转${pad(r.ontoKeep)} 无目标${pad(r.noGoal)} 能打却让${pad(r.hitAndYield)} 坏事${pad(r.bad)}` +
      ` 远城${pad(r.awayCity)} 远敌${pad(r.awayFoe)}` +
      (r.rejects ? ` 拒${r.rejects}` : ''),
  );
  /* 明细在行后面打（同一手），不然要翻两遍 */
  while (details.length) console.log(details.shift());
}

/** 一方走一回合；返回新状态和被拒次数 */
function stepSide(
  s: GameState,
  ai: AiFn,
): { state: GameState; rejects: number } {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  let cur = s;
  let rejects = 0;
  for (let i = 0; i < AI_MAX_STEPS && !cur.winner; i++) {
    const a = ai(cur, budget, rejected);
    if (!a) break;
    const r = applyAction(cur, a);
    if (!r.ok) {
      rejects += 1;
      if (a.type === 'MOVE' && 'unitId' in a) {
        const uid = String((a as { unitId?: string }).unitId ?? '');
        const n = (moveTries.get(uid) ?? 0) + 1;
        moveTries.set(uid, n);
        if (n < 2) continue;
      }
      rejected.add(aiActionKey(a));
      continue;
    }
    rejected.clear();
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    cur = r.state;
  }
  if (cur.winner) return { state: cur, rejects };
  const r = applyAction(cur, { type: 'END_TURN' });
  return { state: r.ok ? r.state : cur, rejects };
}

for (const dir of EXAM_ARGS) playExam(dir);

console.log('\n=== 合计 ===');
const sum = (f: (r: Row) => number): number => rows.reduce((n, r) => n + f(r), 0);
console.log(
  `手数 ${rows.length} | 让位 ${sum((r) => r.yields)} 人次` +
    ` | 空转 ${sum((r) => r.ontoKeep)}` +
    ` | 无目标 ${sum((r) => r.noGoal)}` +
    ` | 射程内有人却让 ${sum((r) => r.hitAndYield)}` +
    ` | 离自城更远 ${sum((r) => r.awayCity)}` +
    ` | 离敌城更远 ${sum((r) => r.awayFoe)}` +
    ` | 被引擎拒 ${totalRejects}`,
);
const ys = sum((r) => r.yields);
const bad = sum((r) => r.bad);
console.log(
  `"帮倒忙"（空转 / 无目标 / 能打却让，去重）${bad} 人次` +
    (ys > 0 ? `，占让位 ${Math.round((bad / ys) * 100)}%` : '') +
    ' — 改之前的基线，改完这三项都该降。',
);
