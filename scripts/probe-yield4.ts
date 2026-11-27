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
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, attackableTargets, siegeTargets, utype } from '../src/core/rules.ts';
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
/** `--quota`：打出"这一手给产兵腾了哪几格、赶走了谁"（批 2 的机制到底生效没有） */
const SHOW_QUOTA = process.argv.includes('--quota');
/** `--plan`：打出这一手的决定、编队和"有几个人拿到了落点"（冻住不动就靠它看） */
const SHOW_PLAN = process.argv.includes('--plan');
/**
 * `--seat`：数"这一手每个人有没有座位"。
 *
 * 座位 = 这一手有走位落点（`con.steps`）/ 有经济岗位 / 在守城或工兵队里。
 * **三者都没有的人 = 让位链真正要照看的人**。这个数决定
 * "先补座位表"是不是根问题（见 `PLAN-V4-PHASE4` §4.23）。
 */
const SHOW_SEAT = process.argv.includes('--seat');
/** `--reject`：把"被引擎拒"按原因分档（第 3 步第一个动作，只读） */
const SHOW_REJECT = process.argv.includes('--reject');
/** 原因 → 人次。键里带上动作类型，才看得出"是不是 MOVE 在撞车" */
const rejectReasons = new Map<string, number>();
let seatTurns = 0;
let seatOnKeep = 0;
let seatMoving = 0;
let seatJob = 0;
let seatFight = 0;
let seatWaiting = 0;
let seatIdle = 0;
let quotaTurns = 0;
let quotaCells = 0;
let quotaEvicts = 0;
let keepMismatch = 0;

const EXAM_ARGS = argOf('exam', '').split(',').map((x) => x.trim()).filter(Boolean);
const SIZE = Number(argOf('size', '12'));
const ERA = Number(argOf('era', '3'));
const SIDE = (argOf('side', 'A') === 'B' ? 'B' : 'A') as PlayerId;
const CAP = Number(argOf('cap', '0'));
const SEED = Number(argOf('seed', '0'));

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<
  typeof import('../src/core/ai.ts')['aiNextAction']
>;
const meNext = ((await import('../src/core/v4/ai-v4.ts')) as { aiNextAction: AiFn }).aiNextAction;
/*
 * **对手要和导出回放的那个工具一致**，否则"同一颗种子"根本不是同一局。
 *
 *   · 考题模式默认 `auto`（`src/core/ai.ts`，也就是 `exam-grade --foe-ai auto` 那一个，题库标准）；
 *   · 随机图模式默认 `old`（`scripts/baseline-ai.ts`，也就是 `v4-duel(-replay)` 的默认对手）。
 *
 * 换对手会换整局，所以两边的数只有对手相同才能对读。
 */
const FOE_KIND = argOf('foe', '');
const foeOf = async (kind: string): Promise<AiFn> =>
  (
    (await import(
      kind === 'v3'
        ? '../src/core/ai-v3.ts'
        : kind === 'auto'
          ? '../src/core/ai.ts'
          : './baseline-ai.ts'
    )) as { aiNextAction: AiFn }
  ).aiNextAction;
let foeNext: AiFn = await foeOf(FOE_KIND || 'auto');

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
  const cap = CAP || crit.window || 60;

  resetV4();
  const s0 = structuredClone(raw.state);
  if (SEED) s0.seed = SEED;
  play(dir, s0, ME, cap);
}

/**
 * **生成对局**（不是考题）：随机图整局。
 *
 * 为什么探针要能跑整局：考题里绝大多数局开局 0 金，"挨打 + 有钱"这个组合只有 D-2-01/02 少数几道
 * 能考出来；而实战里"城被围 + 手上有钱"是常态。要判断名额机制在真局里到底动了几格，
 * 只能跑整局——而且最好**和导出的回放是同一局**（种子 / 尺寸 / 代数一致），
 * 这样你在复盘里看到的画面，和我报的数对得上。
 */
function playMatch(seed: number, size: number, era: number, cap: number, side: PlayerId): void {
  resetV4();
  const s0: GameState = createMatch(
    { ...DEFAULT_CONFIG, size, startEra: era, mapStyle: 'random', mapSymmetry: 'fair' },
    seed,
  );
  play(`随机图 ${size}×${size} · ${era} 代 · seed ${seed}（v4 执 ${side}）`, s0, side, cap);
}

function play(label: string, s0: GameState, ME: PlayerId, cap: number): void {
  const FOE: PlayerId = ME === 'A' ? 'B' : 'A';
  s0.aiControl = { [ME]: false, [FOE]: false } as Record<PlayerId, boolean>;

  const before = rows.length;
  let s = s0;
  let turnIdx = 0;
  let rejectsThisGame = 0;
  let recruitsThisGame = 0;

  console.log(`\n=== ${label} · 上限 ${cap} 手 ===`);

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
      if (SHOW_REJECT) for (const [k, n] of st.reasons) rejectReasons.set(k, (rejectReasons.get(k) ?? 0) + n);
      recruitsThisGame += st.recruits;
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
      ` · 敌方战斗兵 ${s.units.filter((u) => u.owner === FOE && utype(s, u.type).category === 'combat').length}` +
      ` · 累计造兵 ${recruitsThisGame}`,
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
  const v = view.decision;
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

  if (SHOW_SEAT) {
    /*
     * **真正要处理的人 = 站在"必须空"的格子上、又不会自己走开的人。**
     *
     * 分四类（从"最没事"到"有理由"）：
     *   · 闲人   ：没落点、没岗位、不在守/工队、也打不到人 ← 座位表要收的人
     *   · 待命   ：在编队里但这一手排不出落点（收拢/等够人） ← 站着挡路却没人管
     *   · 能打   ：原地就能开火，这一格有产出
     *   · 会走   ：这一手有落点，自己会离开
     */
    const stepSet = new Set(Object.keys(con.steps ?? {}));
    const postSet = new Set(Object.keys(con.econPosts ?? {}));
    const holdSet = new Set(
      con.squads.filter((q) => q.order === 'hold' || q.order === 'build').flatMap((q) => q.unitIds),
    );
    for (const u of world.myCombat) {
      if (!keep.has(u.y * s.w + u.x)) continue;
      seatOnKeep += 1;
      if (stepSet.has(u.id)) { seatMoving += 1; continue; }
      if (postSet.has(u.id) || holdSet.has(u.id)) { seatJob += 1; continue; }
      if (attackableTargets(s, u).some((v) => v.owner !== ME) || siegeTargets(s, u).length > 0) { seatFight += 1; continue; }
      /* order='yield' 是回放标签、不是任务（没有城、没有终点），不能算待命 */
      if (con.squads.some((q) => q.order !== 'yield' && q.unitIds.includes(u.id))) { seatWaiting += 1; continue; }
      seatIdle += 1;
    }
    if (seatIdle + seatWaiting > 0) seatTurns += 1;
  }

  if (SHOW_PLAN) {
    const step = Object.keys(con.steps ?? {}).length;
    const sqs = con.squads.map((q) => `${q.order}${q.cityId ? '@' + q.cityId : ''}:${q.unitIds.length}`).join(' ');
    console.log(
      `  · T${s.turn} 决定=${v.kind}${v.cityId ? '@' + v.cityId : ''}` +
        ` 花费=${v.spend?.mode ?? '-'} 编队[${sqs || '无'}] 有落点 ${step}/${world.myCombat.length}` +
        ` 名单 ${con.keepClear.length} 格`,
    );
  }
  if (SHOW_QUOTA && con.spawnQuota && con.spawnQuota.length > 0) {
    quotaTurns += 1;
    for (const q of con.spawnQuota) {
      quotaCells += q.cells.length;
      quotaEvicts += q.evict.length;
      const fmt = (k: number): string => `(${k % s.w},${Math.floor(k / s.w)})`;
      const at = (k: number): string => {
        const u = s.units.find((x) => x.x === k % s.w && x.y === Math.floor(k / s.w));
        if (!u) return '空';
        const c = utype(s, u.type).category;
        return `${u.type}${c === 'combat' ? '（战斗·吃护甲）' : '（非战斗）'}`;
      };
      console.log(
        `  ▸ T${s.turn} ${q.cityId} 产兵名额 ${q.want} 格 → 留空 ` +
          q.cells.map((k) => `${fmt(k)}${q.evict.includes(k) ? '←赶' : ''}`).join(' ') +
          ` ｜ ${q.cells.map(at).join(' / ')}`,
      );
    }
  }

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
): { state: GameState; rejects: number; recruits: number; reasons: Map<string, number> } {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  let cur = s;
  let rejects = 0;
  let recruits = 0;
  const reasons = new Map<string, number>();
  for (let i = 0; i < AI_MAX_STEPS && !cur.winner; i++) {
    const a = ai(cur, budget, rejected);
    if (!a) break;
    const r = applyAction(cur, a);
    if (!r.ok) {
      rejects += 1;
      const key = `${a.type}｜${(r.reason ?? '（无原因）').slice(0, 28)}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
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
    if (a.type === 'RECRUIT') {
      budget.recruited += 1;
      recruits += 1;
    }
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    cur = r.state;
  }
  if (cur.winner) return { state: cur, rejects, recruits, reasons };
  const r = applyAction(cur, { type: 'END_TURN' });
  return { state: r.ok ? r.state : cur, rejects, recruits, reasons };
}

if (EXAM_ARGS.length > 0) {
  for (const dir of EXAM_ARGS) playExam(dir);
} else {
  /* 没给 --exam 就跑随机图（默认 12×12 · 3 代 · 160 手，和 `v4-duel` 的快检档一致） */
  if (!FOE_KIND) foeNext = await foeOf('old');
  playMatch(SEED || 900, SIZE, ERA, CAP || 160, SIDE);
}

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
if (SHOW_REJECT) {
  const all = [...rejectReasons.entries()].sort((a, b) => b[1] - a[1]);
  const total = all.reduce((n, x) => n + x[1], 0);
  console.log(`\n被拒原因（合计 ${total} 人次）：`);
  for (const [k, n] of all.slice(0, 12)) {
    console.log(`  ${String(n).padStart(5)}  ${total > 0 ? String(Math.round((n / total) * 100)).padStart(3) : '  0'}%  ${k}`);
  }
}
if (SHOW_SEAT) {
  console.log(
    `座位账（只数站在"必须空"格子上的战斗兵，共 ${seatOnKeep} 人次）：` +
      `会走 ${seatMoving} · 守/工 ${seatJob} · 能打 ${seatFight} · 待命 ${seatWaiting} · **闲人 ${seatIdle}**` +
      ` ｜ ${seatTurns} 手出现了"待命/闲人"`,
  );
}
if (SHOW_QUOTA) {
  console.log(
    `产兵名额：生效 ${quotaTurns} 手 · 留空 ${quotaCells} 格 · 其中赶人 ${quotaEvicts} 格` +
      (quotaCells > 0 ? `（${Math.round((quotaEvicts / quotaCells) * 100)}% 需要赶人）` : ''),
  );
}
const ys = sum((r) => r.yields);
const bad = sum((r) => r.bad);
console.log(
  `"帮倒忙"（空转 / 无目标 / 能打却让，去重）${bad} 人次` +
    (ys > 0 ? `，占让位 ${Math.round((bad / ys) * 100)}%` : '') +
    ' — 改之前的基线，改完这三项都该降。',
);
