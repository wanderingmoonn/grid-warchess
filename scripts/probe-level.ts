/**
 * 关卡链路探针（批次 0 的验收脚本）。
 *
 * 批次 0 不加任何玩法，只回答一个问题：**关卡数据能不能安全地走完一局的一生**。
 * 具体是五段路，缺一段就要在动手做内容之前修掉：
 *
 *   1. 注册表里的关卡自己站得住（能过校验）；
 *   2. 建局时关卡地图**优先于**面板上那张固定图；
 *   3. 存档往返之后，地形逐格一致、关卡快照还在；
 *   4. 关卡快照是**拷贝**，不是共享引用（改了注册表，此局不受影响）；
 *   5. 复盘能把这一局原样走一遍——它是"确定性"的最终检验。
 *
 * 另外顺带确认一件不能坏的事：**不带关卡的普通对局行为一点没变**。
 *
 * 用法：
 *   npm run probe:level
 *   npm run probe:level -- --steps 60     跑长一点（默认 40 步）
 */

import { aiNextAction } from '../src/core/ai.ts';
import { isAiSide } from '../src/core/ai-meta.ts';
import { applyAction, canStandAt, isEliminated, runLevelEvents } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch, startGoldFor } from '../src/core/setup.ts';
import { allLevels, demoLevels, levelById, playableLevels, storyLevels, validateLevel } from '../src/core/level.ts';
import { lintLevel } from '../src/core/level-lint.ts';
import { buildReplay } from '../src/core/replay-file.ts';
import type { Action, GameState, MatchConfig } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const STEPS = Math.max(1, Number(argOf('steps', '40')));

let failed = 0;
const ok = (what: string, extra = ''): void => {
  console.log(`  ✓ ${what}${extra ? `  ${extra}` : ''}`);
};
const bad = (what: string, why: string): void => {
  failed += 1;
  console.log(`  ✗ ${what}\n      ${why}`);
};
const check = (cond: boolean, what: string, why = ''): boolean => {
  if (cond) ok(what);
  else bad(what, why);
  return cond;
};

function line(text: string): void {
  console.log(`\n${text}`);
}

/* ── 1. 注册表自检 ─────────────────────────────────────────────── */
line('1. 关卡注册表');
check(allLevels().length > 0, `${allLevels().length} 张关卡`);
for (const def of allLevels()) {
  const res = validateLevel(def);
  if (!res.ok) {
    bad(`${def.id} 过不了校验`, res.errors.join('；'));
    continue;
  }
  ok(`${def.id}（${res.level.name} ${res.level.map.w}×${res.level.map.h}）`);
  check(res.level.map.rows.every((r) => r.length === res.level.map.w),
    `${def.id} 每行长度一致`);
  // cityless 席位（护送关的 A）**没有城是故意的**，不能拿"双方各有城"卡它
  const cityless = new Set(res.level.seats?.cityless ?? []);
  const aOk = res.level.map.citiesA.length > 0 || cityless.has('A');
  const bOk = res.level.map.citiesB.length > 0 || cityless.has('B');
  check(aOk && bOk, `${def.id} 非无城席位各有城`);
}

/*
 * 探针的基准关卡：**按 id 取**，不要用 LEVELS[0]。
 *
 * 用下标的话，往注册表前面加一张玩家关，整份探针就会悄悄换成另一张图跑——
 * 断言大多还能过（它们只关心"有城、有兵"），但已经不是在测原来那张图了。
 */
const probe = levelById('level:probe-flat');
if (!probe) {
  console.log('\n没有关卡可测，结束。');
  process.exit(1);
}

/* ── 2. 关卡地图优先于固定地图 ─────────────────────────────────── */
line('2. 建局：关卡地图是否压过面板上的固定图');
{
  // 故意给一张尺寸完全不同的固定图：如果关卡没生效，尺寸会露馅
  const decoy = {
    id: 'decoy:16',
    name: '诱饵图',
    w: 16,
    h: 16,
    rows: Array.from({ length: 16 }, () => '.'.repeat(16)),
    citiesA: [{ x: 1, y: 1 }],
    citiesB: [{ x: 12, y: 12 }],
  };
  const config: MatchConfig = {
    ...DEFAULT_CONFIG,
    level: probe,
    fixedMap: decoy,
  };
  const s = createMatch(config, 20261114);
  check(s.w === probe.map.w && s.h === probe.map.h,
    `尺寸取自关卡（${s.w}×${s.h}）`,
    `期望 ${probe.map.w}×${probe.map.h}，实际 ${s.w}×${s.h}`);
  check(s.config.level?.id === probe.id, '关卡快照进了局面');
  const cityA = s.cities.filter((c) => c.owner === 'A')[0];
  const cityB = s.cities.filter((c) => c.owner === 'B')[0];
  check(!!cityA && cityA.x === probe.map.citiesA[0]!.x && cityA.y === probe.map.citiesA[0]!.y,
    '红方城位与关卡一致');
  check(!!cityB && cityB.x === probe.map.citiesB[0]!.x && cityB.y === probe.map.citiesB[0]!.y,
    '蓝方城位与关卡一致');
}

/* ── 3. 快照是拷贝，不是共享引用 ───────────────────────────────── */
line('3. 快照独立性（改了注册表，这一局不能跟着变）');
{
  const s = createMatch({ ...DEFAULT_CONFIG, level: probe }, 20261114);
  const snap = s.config.level!;
  check(snap !== probe, '关卡对象不是同一个引用');
  check(snap.map !== probe.map, '地图对象不是同一个引用');
  check(snap.map.rows !== probe.map.rows, '地形数组不是同一个引用');
  check(snap.map.rows.every((r, i) => r === probe.map.rows[i]), '内容逐行相同');

  // 真的改一下注册表那一份，再看这一局：没变才算过
  const before = snap.map.rows[0]!;
  probe.map.rows[0] = '#'.repeat(probe.map.w);
  const still = s.config.level!.map.rows[0]!;
  probe.map.rows[0] = before;
  check(still === before, '改注册表之后，局面里的地形没有被带着改');
}

/* ── 4. 打一局 + 存档往返 ──────────────────────────────────────── */
line('4. 打一局，然后存档往返');
const initial = createMatch({ ...DEFAULT_CONFIG, level: probe }, 20261114);
const actions: Action[] = [];
let cur: GameState = initial;
{
  let rejected = 0;
  for (let i = 0; i < STEPS; i++) {
    if (cur.winner) break;
    const pick = aiNextAction(cur) ?? ({ type: 'END_TURN' } as Action);
    const r = applyAction(cur, pick);
    if (r.ok) {
      actions.push(pick);
      cur = r.state;
      continue;
    }
    // AI 偶尔会挑到"这一步不行"（它自己会兜底，但脚本这里也要兜）：退回结束回合
    rejected += 1;
    const end = applyAction(cur, { type: 'END_TURN' } as Action);
    if (!end.ok) break;
    actions.push({ type: 'END_TURN' } as Action);
    cur = end.state;
  }
  ok(`走了 ${actions.length} 步`, `回合 ${cur.turn}${cur.winner ? ` · 胜方 ${cur.winner}` : ''}`);
  if (rejected > 0) console.log(`      （其中 ${rejected} 步被引擎拒绝，已退回结束回合）`);
}

{
  // 存档就是把整个局面序列化成一行字（和 storage/save.ts 同一个做法）
  const text = JSON.stringify({ kind: 'warchess-match', version: 1, state: cur });
  const back = JSON.parse(text) as { state: GameState };
  const s2 = back.state;
  check(s2.w === cur.w && s2.h === cur.h, '尺寸一致');
  check(s2.tiles.length === cur.tiles.length, `格数一致（${s2.tiles.length}）`);
  let diff = 0;
  for (let i = 0; i < cur.tiles.length; i++) {
    if (s2.tiles[i]!.terrain !== cur.tiles[i]!.terrain) diff += 1;
  }
  check(diff === 0, '地形逐格一致', `${diff} 格不同`);
  check(s2.config.level?.id === probe.id, '读回来之后关卡快照还在');
  check(s2.config.level?.map.rows[0] === cur.config.level!.map.rows[0], '读回来的关卡地形没走样');
  check(s2.units.length === cur.units.length, `兵数一致（${s2.units.length}）`);
  check(JSON.stringify(s2.config.level) === JSON.stringify(cur.config.level), '关卡快照完整往返');
}

/* ── 5. 复盘 ───────────────────────────────────────────────────── */
line('5. 复盘：把这一局原样再走一遍');
{
  const report = {
    v: 3,
    seed: initial.seed,
    config: initial.config,
    actions,
    winner: cur.winner ?? null,
    board: { w: initial.w, h: initial.h },
  };
  const built = buildReplay(report);
  if (!built.ok) {
    bad('复盘建不起来', built.reason);
  } else {
    const ses = built.session;
    check(ses.applied === actions.length, `走通了全部 ${ses.applied} 步`,
      `只走到 ${ses.applied}/${actions.length}：${ses.stopReason ?? ''}`);
    check(ses.finalMatches === true, '终局与报告一致',
      `报告说 ${report.winner ?? '平局'}，复盘走出 ${ses.finalState.winner ?? '平局'}`);
    check(ses.meta.size === initial.w, `复盘用的是关卡地图（${ses.meta.size}）`);
    check(ses.warnings.length === 0, '没有告警', ses.warnings.join('；'));
    // 逐帧抽查：第 7 步和第 0 步不该是同一个局面
    const mid = ses.stateAt(Math.min(7, ses.applied));
    check(mid.turn >= 1, '可以逐帧取状态');
  }
}

/* ── 6. 普通对局不受影响 ───────────────────────────────────────── */
line('6. 普通对局（不带关卡）行为不变');
{
  const plain = createMatch(DEFAULT_CONFIG, 777);
  check(plain.config.level === undefined, 'config 里没有关卡字段');
  check(plain.w === DEFAULT_CONFIG.size && plain.h === DEFAULT_CONFIG.size,
    `随机地图照旧（${plain.w}×${plain.h}）`);
  check(plain.config.fixedMap === undefined, '没有多出固定地图字段');
  const snapText = JSON.stringify(plain);
  check(!snapText.includes('"level"'), '存档里没有关卡键（不给老格式添乱）');
}

/* ── 7. 坏关卡挡得住 ───────────────────────────────────────────── */
line('7. 坏关卡挡得住');
{
  const cases: Array<[string, unknown]> = [
    ['空对象', {}],
    ['没有地图', { id: 'level:x', name: 'x' }],
    ['地图太小', {
      id: 'level:x', name: 'x',
      map: { name: 'x', rows: ['..', '..'], citiesA: [{ x: 0, y: 0 }], citiesB: [{ x: 0, y: 0 }] },
    }],
    ['地图里有看不懂的字符', {
      id: 'level:x', name: 'x',
      map: {
        name: 'x', w: 8, h: 8,
        rows: Array.from({ length: 8 }, () => '........').map((r, i) => (i === 0 ? '...Z....' : r)),
        citiesA: [{ x: 0, y: 0 }], citiesB: [{ x: 6, y: 6 }],
      },
    }],
  ];
  for (const [label, raw] of cases) {
    const res = validateLevel(raw);
    check(!res.ok && res.errors.length > 0, `${label}：被拒并给出原因`,
      res.ok ? '居然通过了' : '被拒但没有原因');
  }
  // 坏关卡不该让整局建不起来，而是退回随机地图
  const broken = createMatch({ ...DEFAULT_CONFIG, level: { id: '', name: '', map: null } as never }, 777);
  check(broken.config.level === undefined && broken.w === DEFAULT_CONFIG.size,
    '坏关卡退回普通对局，没有把整局带塌');
}

/* ── 8. 三家混战关卡（批次 1）──────────────────────────────────── */
line('8. 三家混战：「三岔口」');
const tri = levelById('level:tri-corner');
if (!tri) {
  bad('找不到 level:tri-corner', '注册表里没有这张关卡');
} else {
  const s = createMatch({ ...DEFAULT_CONFIG, level: tri }, 20261114);
  check(s.config.playerCount === 3, `这一局三家（${s.config.playerCount}）`,
    `期望 3，实际 ${s.config.playerCount}`);
  const owners = ['A', 'B', 'C', 'D'].map((p) => s.cities.filter((c) => c.owner === p).length);
  check(owners[0]! > 0 && owners[1]! > 0 && owners[2]! > 0,
    `三家都有城（A${owners[0]} / B${owners[1]} / C${owners[2]}）`,
    '有席位没城——它第一回合就会被判出局');
  check(owners[3] === 0, '第四席没有城（它根本不坐人）');
  check(s.w === tri.map.w && s.h === tri.map.h, `地图取自关卡（${s.w}×${s.h}）`);

  // 谁被托管
  check(JSON.stringify(s.config.aiSeats) === JSON.stringify(['C']),
    `只有绿方是电脑（aiSeats=${JSON.stringify(s.config.aiSeats)}）`);
  check(isAiSide(s, 'C') === true && isAiSide(s, 'A') === false && isAiSide(s, 'B') === false,
    'isAiSide 按席位判断');
  check(s.config.aiOpponent === false && s.config.aiAlly === false,
    '两家局的那两个布尔没有被误用（三家局里它们必须都是 false）');

  // 真的打一遍：脚本替三家都出招，看能不能推进、三席是否都轮到过
  let cur3: GameState = s;
  const acted = new Set<string>();
  let steps = 0;
  for (; steps < 900 && !cur3.winner; steps++) {
    acted.add(cur3.current);
    const pick = aiNextAction(cur3) ?? ({ type: 'END_TURN' } as Action);
    const r = applyAction(cur3, pick);
    if (r.ok) {
      cur3 = r.state;
      continue;
    }
    const end = applyAction(cur3, { type: 'END_TURN' } as Action);
    if (!end.ok) break;
    cur3 = end.state;
  }
  check(acted.size === 3, `三席都轮到过（${[...acted].sort().join(' ')}）`, `只轮到 ${[...acted].join(' ')}`);
  check(cur3.turn >= 6, `对局在推进（回合 ${cur3.turn}）`, `回合只到 ${cur3.turn}，像是卡住了`);
  /*
   * 比"回合数涨了"更硬的证据：**真的有人被打到出局**。
   *
   * 三方混战最容易出的毛病不是崩，而是"谁也不敢动，磨到天荒地老"——
   * 那种局在回合数上看不出问题。所以这里要求 900 步之内至少有一家被灭
   * （或者整局已经分出胜负）。这一条挂掉通常是地图变得太好守了，
   * 不是代码坏了；换图或者等批次 4 加"回合上限"这类胜负条件。
   */
  const wiped = ['A', 'B', 'C'].filter((p) => cur3.cities.filter((c) => c.owner === p).length === 0);
  check(!!cur3.winner || wiped.length > 0,
    cur3.winner ? `分出胜负：${cur3.winner}` : `有人被打到出局（${wiped.join(' ')}）`,
    '900 步里没有任何一家被灭——这关可能打不完，需要改图或加回合上限');
  const endStat = ['A', 'B', 'C'].map((p) => {
    const u = cur3.units.filter((x) => x.owner === p).length;
    const c = cur3.cities.filter((x) => x.owner === p).length;
    return `${p}:${c}城/${u}兵`;
  }).join('  ');
  ok(cur3.winner ? `分出胜负：${cur3.winner}` : `未结束（${steps} 步，回合 ${cur3.turn}）`);
  console.log(`      ${endStat}`);

  // 三家局的存档 + 复盘
  const report = {
    v: 3,
    seed: s.seed,
    config: s.config,
    actions: [] as Action[],
    winner: null as string | null,
  };
  // 用一场短局验证"三家局也能复盘"：只要前 30 步
  let cur4: GameState = s;
  const shortActions: Action[] = [];
  for (let i = 0; i < 30 && !cur4.winner; i++) {
    const pick = aiNextAction(cur4) ?? ({ type: 'END_TURN' } as Action);
    const r = applyAction(cur4, pick);
    if (r.ok) {
      shortActions.push(pick);
      cur4 = r.state;
    } else {
      const end = applyAction(cur4, { type: 'END_TURN' } as Action);
      if (!end.ok) break;
      shortActions.push({ type: 'END_TURN' } as Action);
      cur4 = end.state;
    }
  }
  report.actions = shortActions;
  const built3 = buildReplay(report as never);
  if (!built3.ok) {
    bad('三家局复盘建不起来', built3.reason);
  } else {
    check(built3.session.applied === shortActions.length, `三家局复盘走通 ${built3.session.applied} 步`,
      built3.session.stopReason ?? '');
    check(built3.session.meta.players === 3, '复盘认出这是三家局');
  }
}

/* ── 9. 开局部署（批次 2）────────────────────────────────────── */
line('9. 开局部署：「断后」');
const rear = levelById('level:rear-guard');
if (!rear) {
  bad('找不到 level:rear-guard', '注册表里没有这张关卡');
} else {
  const s = createMatch({ ...DEFAULT_CONFIG, level: rear }, 20261114);
  const mine = s.units.filter((u) => u.owner === 'A');
  const foes = s.units.filter((u) => u.owner === 'B');
  check(mine.length === 1, `守方正好 1 个兵（实际 ${mine.length}）`,
    `期望 1，实际 ${mine.length}：写了部署的席位不该再自动撒兵/送经济单位`);
  check(foes.length === 5, `攻方正好 5 个兵（实际 ${foes.length}）`, `期望 5，实际 ${foes.length}`);
  check(mine[0]?.x === 6 && mine[0]?.y === 7, '守方那个兵站在桥面上',
    `实际站在 (${mine[0]?.x}, ${mine[0]?.y})`);
  check(mine[0]?.type === 'militia', `兵种按关卡写的来（${mine[0]?.type}）`);
  check(s.units.every((u) => u.hp > 0), '所有部署兵都有血（数值取自兵种表）');
  // 部署的兵也得能正常行动（别摆出一个"站在非法格子上"的局面）
  const first = mine[0]!;
  const moved = applyAction(s, { type: 'MOVE', unitId: first.id, x: 5, y: 7 } as Action);
  check(moved.ok, '部署上去的兵当回合就能动', moved.ok ? '' : moved.reason);

  /*
   * 桥到底通不通。
   *
   * 这张图的全部设计都在那一格桥面上：如果 `=` 其实过不去，攻方会站在对岸
   * 干看着，而这在"部署对不对"的检查里完全看不出来。
   *
   * 判据不是"攻方过河"——守方会补兵堵桥头，过不过得去取决于打法。
   * 判的是**攻方能摸到桥头**：要么站到桥旁边那一列，要么已经把守桥那个兵打掉了。
   * 两条都要求"从东岸走到桥"，桥不通就一条也做不到。
   */
  let reachedBridge = false;
  let cur5 = s;
  for (let i = 0; i < 60 && !cur5.winner; i++) {
    const pick = aiNextAction(cur5) ?? ({ type: 'END_TURN' } as Action);
    const r = applyAction(cur5, pick);
    if (r.ok) cur5 = r.state;
    else {
      const end = applyAction(cur5, { type: 'END_TURN' } as Action);
      if (!end.ok) break;
      cur5 = end.state;
    }
    const atBridgeSide = cur5.units.some(
      (u) => u.owner === 'B' && u.x === 7 && (u.y === 6 || u.y === 7 || u.y === 8),
    );
    const defenderGone = !cur5.units.some((u) => u.id === first.id);
    if (atBridgeSide || defenderGone) {
      reachedBridge = true;
      break;
    }
  }
  check(reachedBridge, '攻方能摸到桥头（桥是可通行的）',
    '走了 60 步攻方还没到桥边——那一格大概是过不去的');
}

/* ── 10. 扩展规则三档 ─────────────────────────────────────────── */
line('10. 扩展规则：必须开 / 禁用 / 其余自选');
{
  const rules = {
    ...rear!,
    id: 'level:test-exp',
    // 故意和 DEFAULT_CONFIG 对着干：默认开的两包里禁一个、留一个，再要求一个默认没开的
    expansions: { require: ['last-stand'], forbid: ['bloodbath'] },
  };
  const base: MatchConfig = {
    ...DEFAULT_CONFIG,
    expansionIds: ['bloodbath', 'turn-order-comp'],
    level: rules,
  };
  const s = createMatch(base, 777);
  const got = s.config.expansionIds;
  check(got.includes('last-stand'), `必须开的包被加了进来（${got.join(' ') || '空'}）`,
    `要求开 last-stand，实际 ${got.join(' ') || '空'}`);
  check(!got.includes('bloodbath'), '被禁用的包被去掉了', `禁用了 bloodbath，实际 ${got.join(' ')}`);
  check(got.includes('turn-order-comp'), '关卡没提到的包保留玩家原来的勾选',
    `不该顺手清掉玩家自己勾的包，实际 ${got.join(' ')}`);
  check(base.expansionIds.includes('bloodbath') && !base.expansionIds.includes('last-stand'),
    '不修改调用方的 config（createMatch 是纯函数）');
}

/* ── 11. 坏部署挡得住、跳过时说清楚 ───────────────────────────── */
line('11. 坏部署');
{
  // 结构错在 validateLevel 就拦住
  const badCases: Array<[string, unknown]> = [
    ['部署到没坐人的席位', {
      ...rear!, id: 'level:x', expansions: undefined,
      seats: { count: 2, ai: [] },
      deploy: { D: [{ type: 'militia', x: 1, y: 1 }] },
    }],
    ['坐标出界', {
      ...rear!, id: 'level:x', expansions: undefined,
      deploy: { A: [{ type: 'militia', x: 99, y: 1 }] },
    }],
    ['两处叠在同一格', {
      ...rear!, id: 'level:x', expansions: undefined,
      deploy: { A: [{ type: 'militia', x: 2, y: 2 }, { type: 'archer', x: 2, y: 2 }] },
    }],
  ];
  for (const [label, raw] of badCases) {
    const res = validateLevel(raw);
    check(!res.ok && res.errors.length > 0, `${label}：被拒并给出原因`, res.ok ? '居然通过了' : '被拒但没有原因');
  }

  // 语义错（兵种不存在 / 格子站不住）不该让整局崩，但要写进战报
  const weird = {
    ...rear!,
    id: 'level:test-weird',
    deploy: {
      A: [
        { type: 'militia', x: 6, y: 7 },
        { type: 'no-such-unit', x: 2, y: 2 },
        { type: 'militia', x: 6, y: 3 }, // 河里，站不住
      ],
      B: [{ type: 'militia', x: 10, y: 6 }],
    },
  };
  const s = createMatch({ ...DEFAULT_CONFIG, level: weird }, 999);
  check(s.units.filter((u) => u.owner === 'A').length === 1,
    '认不出的兵种和站不住的格子都被跳过（守方只剩 1 个）',
    `实际 ${s.units.filter((u) => u.owner === 'A').length} 个`);
  const notes = s.log.map((l) => l.text).filter((t) => t.includes('关卡部署'));
  check(notes.length === 2, `战报里有两条说明（${notes.length}）`, `期望 2 条，实际 ${notes.length}：${notes.join(' / ')}`);
}

/* ── 12. 事件表（批次 3）────────────────────────────────────── */
line('12. 事件表：「断后」的三件事');
if (!rear) {
  bad('没有断后关卡，事件测不了', '');
} else {
  let ev = createMatch({ ...DEFAULT_CONFIG, level: rear }, 20261114);
  check((ev.levelState?.fired ?? []).length === 0, '开局一条事件都没触发（第 3 次行动的条件还没到）',
    `实际已触发 ${(ev.levelState?.fired ?? []).join(' ')}`);

  // 推进到第 3 次行动：两次结束回合就够了
  for (let i = 0; i < 4 && ev.turn < 3; i++) {
    const r = applyAction(ev, { type: 'END_TURN' } as Action);
    if (!r.ok) break;
    ev = r.state;
  }
  check(ev.turn >= 3, `推到第 ${ev.turn} 次行动`);
  check((ev.levelState?.fired ?? []).includes('reinforce'), '第 3 次行动：援兵事件触发了',
    `已触发 ${(ev.levelState?.fired ?? []).join(' ') || '无'}`);
  check(ev.units.filter((u) => u.owner === 'B').length === 7, '援兵真的到场（攻方 5 → 7）',
    `实际 ${ev.units.filter((u) => u.owner === 'B').length} 个`);
  check(ev.log.some((l) => l.text.includes('旌旗')), '播报写进了战报');
  const say = ev.log.find((l) => l.text.includes('旌旗'));
  check(!!say?.open && say?.system === true, '旁白是公开的、并标了 system（双方都看得到）');

  // 让电脑自己打一段：守桥兵应该会死，之后"桥丢了"和"上桥"两件事都会触发
  for (let i = 0; i < 120; i++) {
    if (ev.winner) break;
    const pick = aiNextAction(ev) ?? ({ type: 'END_TURN' } as Action);
    const r = applyAction(ev, pick);
    if (!r.ok) {
      const end = applyAction(ev, { type: 'END_TURN' } as Action);
      if (!end.ok) break;
      ev = end.state;
    } else {
      ev = r.state;
    }
  }
  const fired = ev.levelState?.fired ?? [];
  check(fired.includes('bridge-lost'), `守桥兵阵亡触发了事件（已触发：${fired.join(' ') || '无'}）`);
  check(fired.includes('crossed'), `攻方踩上桥面触发了事件（已触发：${fired.join(' ') || '无'}）`);
  check(ev.orderDirectives?.B?.strategy === 'rush', '事件改了绿/蓝方的打法（转猛攻）',
    `实际 ${JSON.stringify(ev.orderDirectives?.B ?? null)}`);
  check(new Set(fired).size === fired.length, '同一件事不会被记两次');

  // 存档往返：触发记录必须活下来（否则读档之后事件会重放一遍）
  const round = JSON.parse(JSON.stringify(ev)) as GameState;
  check(
    JSON.stringify(round.levelState?.fired ?? []) === JSON.stringify(fired),
    '存读之后"已经触发过"的记录还在',
  );
  const unitsBefore = round.units.length;
  runLevelEvents(round, round);
  check(round.units.length === unitsBefore, '读档后再跑一遍事件不会重放（兵数没变）',
    `重跑之后从 ${unitsBefore} 变成 ${round.units.length}`);
}

/* ── 13. enter 条件的精确语义 ─────────────────────────────────── */
line('13. "走进区域"必须是"从外面走进去"');
{
  /*
   * 这一条不靠 AI 跑，而是自己造一关、走一步。
   * 因为「断后」里的 enter 依赖电脑愿不愿意推过来，那是关卡设计的事；
   * 机制本身必须能确定地验：原本就在区域里的兵挪一格，不该算"进入"。
   */
  const mkEnter = (events: unknown[]) => ({
    ...levelById('level:probe-flat')!,
    id: 'level:test-enter',
    seats: { count: 2, ai: [] },
    deploy: {
      A: [{ type: 'militia', x: 4, y: 5 }],
      B: [{ type: 'militia', x: 11, y: 11 }],
    },
    events,
  });
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      level: mkEnter([
        {
          id: 'step',
          when: { kind: 'enter', zone: { x0: 5, y0: 5, x1: 5, y1: 5 }, owner: 'A' },
          do: [{ kind: 'say', text: '踩到了' }],
        },
      ]) as never,
    },
    42,
  );
  const u = s.units.find((x) => x.owner === 'A')!;
  const r = applyAction(s, { type: 'MOVE', unitId: u.id, x: 5, y: 5 } as Action);
  if (!r.ok) {
    bad('测试局：这一手能走', r.reason);
  } else {
    const st = r.state;
    check((st.levelState?.fired ?? []).includes('step'), '走进区域触发了事件',
      `已触发 ${(st.levelState?.fired ?? []).join(' ') || '无'}`);
    check(st.log.some((l) => l.text === '踩到了'), '播报写进战报');

    // 走回 (4,5) 再走回来：不能重复触发（默认只触发一次）
    const back = applyAction(st, { type: 'MOVE', unitId: u.id, x: 4, y: 5 } as Action);
    const again = back.ok
      ? applyAction(back.state, { type: 'MOVE', unitId: u.id, x: 5, y: 5 } as Action)
      : null;
    if (again && again.ok) {
      const says = again.state.log.filter((l) => l.text === '踩到了').length;
      check(says === 1, '再进一次不会重复触发（默认只发生一次）', `实际播报了 ${says} 次`);
    }
  }
}

/* ── 14. 事件写错了挡得住 ────────────────────────────────────── */
line('14. 坏事件');
{
  const mk = (events: unknown): unknown => ({ ...rear!, id: 'level:x', events });
  const cases: Array<[string, unknown]> = [
    ['没写 id', mk([{ when: { kind: 'turn', at: 2 }, do: [{ kind: 'say', text: 'x' }] }])],
    ['id 重复', mk([
      { id: 'a', when: { kind: 'turn', at: 2 }, do: [{ kind: 'say', text: 'x' }] },
      { id: 'a', when: { kind: 'turn', at: 3 }, do: [{ kind: 'say', text: 'y' }] },
    ])],
    ['条件不认识', mk([{ id: 'a', when: { kind: 'moonPhase' }, do: [{ kind: 'say', text: 'x' }] }])],
    ['动作不认识', mk([{ id: 'a', when: { kind: 'turn', at: 2 }, do: [{ kind: 'explode' }] }])],
    ['区域越界', mk([{
      id: 'a',
      when: { kind: 'enter', zone: { x0: 0, y0: 0, x1: 99, y1: 99 } },
      do: [{ kind: 'say', text: 'x' }],
    }])],
    ['给不存在的席位刷兵', mk([{
      id: 'a', when: { kind: 'turn', at: 2 },
      do: [{ kind: 'spawn', owner: 'D', units: [{ type: 'militia', x: 1, y: 1 }] }],
    }])],
    ['没有动作', mk([{ id: 'a', when: { kind: 'turn', at: 2 }, do: [] }])],
  ];
  for (const [label, raw] of cases) {
    const res = validateLevel(raw);
    check(!res.ok && res.errors.length > 0, `${label}：被拒并给出原因`, res.ok ? '居然通过了' : '被拒但没有原因');
  }
}

/* ── 15. 胜负条件（批次 4）────────────────────────────────────── */
line('15. 胜负条件：「死守」守到第 20 次行动');
{
  const hold = levelById('level:hold-out');
  if (!hold) {
    bad('找不到 level:hold-out', '注册表里没有这张关卡');
  } else {
    const s = createMatch({ ...DEFAULT_CONFIG, level: hold }, 20261115);
    check((s.config.level?.goals ?? []).length === 1, '目标进了局面');
    check(s.log.some((l) => l.text.includes('这一关的目标')), '开局战报里写了目标');
    check(s.winner === null, '开局没有判赢');

    // 两边都只结束回合：谁也别打谁，看 20 次行动到点时会不会判守方赢
    let cur = s;
    let steps = 0;
    for (; steps < 30 && !cur.winner; steps++) {
      const r = applyAction(cur, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      cur = r.state;
    }
    check(cur.winner === 'A', `守满就赢（胜方 ${cur.winner ?? '无'}）`,
      `第 ${cur.turn} 次行动时胜方是 ${cur.winner ?? '无'}`);
    check(cur.turn >= 20 && cur.turn <= 21, `判赢的时机在第 20 次行动（实际第 ${cur.turn} 次）`);
    // 这时候攻方明明还活着——赢不是因为把对手打光了，是目标达成了
    check(cur.cities.filter((c) => c.owner === 'B').length > 0, '攻方还有城（不是被灭，是守住了）');
  }
}

/* ── 16. 目标不接管"怎么输" ──────────────────────────────────── */
line('16. 目标只管赢，输还是按老规则判');
{
  const hold = levelById('level:hold-out')!;
  let cur = createMatch({ ...DEFAULT_CONFIG, level: hold }, 20261115);
  /*
   * 手动把守方的城抹掉，模拟"城破了"。
   *
   * 这里是在造一个局面，不是在测规则——所以直接改 state 合理。
   * 想验的是：**目标没达成时，老判定照旧生效**，不会因为"这一关有目标"就不判输。
   */
  cur.cities = cur.cities.filter((c) => c.owner !== 'A');
  const r = applyAction(cur, { type: 'END_TURN' } as Action);
  check(r.ok && r.state.winner === 'B', '守方城破：攻方赢，没有因为"目标还在"就继续打',
    `胜方 ${r.ok ? r.state.winner ?? '无' : r.reason ?? '动作被拒'}`);
}

/* ── 17. 护送 / 斩首 ─────────────────────────────────────────── */
line('17. 另外两种目标');
{
  const base = levelById('level:probe-flat')!;
  const mk = (goals: unknown[]) => ({
    ...base,
    id: 'level:test-goal',
    seats: { count: 2, ai: [] },
    deploy: {
      A: [{ type: 'militia', x: 4, y: 5 }],
      B: [{ type: 'militia', x: 10, y: 10 }, { type: 'scout', x: 10, y: 9 }],
    },
    goals,
  });

  // 护送：A 那个兵走到 (5,5) 就赢
  const escort = createMatch(
    {
      ...DEFAULT_CONFIG,
      level: mk([{ kind: 'escort', seat: 'A', zone: { x0: 5, y0: 5, x1: 5, y1: 5 } }]) as never,
    },
    7,
  );
  const u = escort.units.find((x) => x.owner === 'A')!;
  const moved = applyAction(escort, { type: 'MOVE', unitId: u.id, x: 5, y: 5 } as Action);
  check(moved.ok && moved.state.winner === 'A', '护送：走到终点就赢',
    `胜方 ${moved.ok ? moved.state.winner ?? '无' : moved.reason ?? '动作被拒'}`);

  // 斩首：B 的斥候没了就判 A 赢
  const assass = createMatch(
    {
      ...DEFAULT_CONFIG,
      level: mk([{ kind: 'assassinate', winner: 'A', loser: 'B', unitType: 'scout' }]) as never,
    },
    7,
  );
  check(assass.winner === null, '斩首：目标还在，不判赢');
  const before = assass.units.filter((x) => x.owner === 'B' && x.type === 'scout').length;
  check(before === 1, `被斩方开局确实有那个兵（${before} 个）`);
  // 直接从局面上拿掉那个斥候，再走一步让结算跑一遍
  assass.units = assass.units.filter((x) => !(x.owner === 'B' && x.type === 'scout'));
  const after = applyAction(assass, { type: 'END_TURN' } as Action);
  check(after.ok && after.state.winner === 'A', '斩首：目标没了就判赢',
    `胜方 ${after.ok ? after.state.winner ?? '无' : after.reason ?? '动作被拒'}`);
}

/* ── 18. 坏目标挡得住 ───────────────────────────────────────── */
line('18. 写错的胜利条件');
{
  const hold = levelById('level:hold-out')!;
  const mk = (goals: unknown): unknown => ({ ...hold, id: 'level:x', goals });
  const cases: Array<[string, unknown]> = [
    ['类型不认识', mk([{ kind: 'win' }])],
    ['守方不是这一局的人', mk([{ kind: 'survive', seat: 'D', untilTurn: 10 }])],
    ['时限越界', mk([{ kind: 'survive', seat: 'A', untilTurn: 0 }])],
    ['护送终点越界', mk([{ kind: 'escort', seat: 'A', zone: { x0: 0, y0: 0, x1: 99, y1: 99 } }])],
    ['斩首自己', mk([{ kind: 'assassinate', winner: 'A', loser: 'A' }])],
  ];
  for (const [label, raw] of cases) {
    const res = validateLevel(raw);
    check(!res.ok && res.errors.length > 0, `${label}：被拒并给出原因`, res.ok ? '居然通过了' : '被拒但没有原因');
  }
}

/* ── 19. 关卡钉住的开局设定，规则层也认 ─────────────────────── */
line('19. 时代 / 先手被关卡钉住（不是只在面板上灰掉）');
{
  const hold = levelById('level:hold-out')!;
  /*
   * 故意把 startEra 写成 6、firstSide 写成 B，模拟"一份被改过的 config"
   * （存档、房间、分享链接都能这样传）。规则层必须只认关卡写的那一档。
   */
  const hacked = createMatch(
    { ...DEFAULT_CONFIG, startEra: 6, firstSide: 'B', level: hold },
    4242,
  );
  check(hacked.config.startEra === 1, `时代被压回关卡写的青铜（${hacked.config.startEra}）`,
    `期望 1，实际 ${hacked.config.startEra}`);
  /*
   * 金币要和"老实按关卡开一局"完全一样。
   *
   * 不能直接比 `startGoldFor(1)`：开局那笔"第一回合收入"也会加到账上
   * （见 grantOpeningIncome），所以拿同种子的正常局当基准比更实在。
   */
  const honest = createMatch({ ...DEFAULT_CONFIG, level: hold }, 4242);
  check(hacked.players.A.gold === honest.players.A.gold,
    `开局金币和老实开局一致（${hacked.players.A.gold}）`,
    `被改过的 ${hacked.players.A.gold} ≠ 正常的 ${honest.players.A.gold}`);
  check(honest.players.A.gold < startGoldFor(3),
    `确实只有青铜那一档的钱（${honest.players.A.gold} < 铁器 ${startGoldFor(3)}）`,
    '金币没被压住：这一关的难度就没了');
  check(hacked.current === 'A', `先手是关卡写的红方（${hacked.current}）`, `期望 A，实际 ${hacked.current}`);

  // 没写 setup 的关卡不受影响：面板说什么就是什么
  const noSetup = { ...levelById('level:probe-flat')!, id: 'level:no-setup', setup: undefined };
  const s2 = createMatch({ ...DEFAULT_CONFIG, startEra: 3, level: noSetup as never }, 4242);
  check(s2.config.startEra === 3, `关卡没写时代时不干预（${s2.config.startEra}）`,
    `期望 3，实际 ${s2.config.startEra}`);
}

/* ── 20. 未登场的席位（批次 5）──────────────────────────────── */
line('20. 未登场：第三家第 8 次行动才上场');
{
  const lc = levelById('level:latecomer');
  if (!lc) {
    bad('找不到 level:latecomer', '注册表里没有这张关卡');
  } else {
    let s = createMatch({ ...DEFAULT_CONFIG, level: lc }, 20261115);
    check(s.cities.filter((c) => c.owner === 'C').length === 0, '开局绿方没有城');
    check(s.units.filter((u) => u.owner === 'C').length === 0, '开局绿方没有兵');
    check(isEliminated(s, 'C') === false, '绿方没城，但**不算出局**');
    check(s.winner === null, '开局没有判赢（三家局里只来了两家）');

    // 前 7 次行动应该只有红蓝两家在轮
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      order.push(s.current);
      const r = applyAction(s, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      s = r.state;
    }
    check(order.every((p) => p === 'A' || p === 'B'), `未登场时不占回合（${order.join(' ')}）`,
      `轮到了不该上场的人：${order.join(' ')}`);

    // 再走一步到第 8 次行动，绿方该登场了
    const r8 = applyAction(s, { type: 'END_TURN' } as Action);
    if (!r8.ok) {
      bad('第 8 次行动能走', r8.reason);
    } else {
      s = r8.state;
      const cities = s.cities.filter((c) => c.owner === 'C').length;
      const units = s.units.filter((u) => u.owner === 'C').length;
      check(cities === 1, `登场时放下了一座城（${cities}）`);
      const wantUnits = lc.deploy?.C?.length ?? 0;
      check(units === wantUnits, `登场时摆上了关卡写的那几个兵（${units}/${wantUnits}）`);
      check((s.levelState?.hidden ?? []).length === 0, '"未登场"的名单空了');
      check(s.log.some((l) => l.text.includes('登场了')), '战报里有一句登场提示');
      check(s.winner === null, '登场不改变胜负');
    }
  }

  // 未登场时守方就被打光：不该因为"还有一家没来"而卡住
  {
    let s = createMatch({ ...DEFAULT_CONFIG, level: lc! }, 20261115);
    s.cities = s.cities.filter((c) => c.owner !== 'A');
    const r = applyAction(s, { type: 'END_TURN' } as Action);
    check(r.ok && r.state.winner === 'B', '未登场的那家不该拦住"只剩一家"的判定',
      `胜方 ${r.ok ? r.state.winner ?? '无' : r.reason ?? '动作被拒'}`);
  }

  // 普通对局：完全没有这个字段
  {
    const plain = createMatch(DEFAULT_CONFIG, 5);
    check(plain.levelState === undefined, '普通对局没有 levelState 字段（老行为不变）');
  }
}

/* ── 21. 改地形（批次 6）────────────────────────────────────── */
line('21. 改地形：桥塌、水退、兵被挤走');
{
  const cut = levelById('level:cut-bridge');
  if (!cut) {
    bad('找不到 level:cut-bridge', '注册表里没有这张关卡');
  } else {
    let s = createMatch({ ...DEFAULT_CONFIG, level: cut }, 7);
    const at = (st: GameState, x: number, y: number): string => st.tiles[y * st.w + x]?.terrain ?? '?';
    check(at(s, 7, 7) === 'bridge', `开局桥还在（${at(s, 7, 7)}）`);

    // 走到第 4 次行动：桥应该没了
    for (let i = 0; i < 3; i++) {
      const r = applyAction(s, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      s = r.state;
    }
    check(s.turn === 4, `走到第 ${s.turn} 次行动`);
    check(at(s, 7, 7) === 'deep', `桥变深水（${at(s, 7, 7)}）`);
    check(s.log.some((l) => l.text.includes('地形变了')), '改地形有播报');
    const note = s.log.find((l) => l.text.includes('地形变了'));
    check(!!note?.open && note?.system === true, '播报是公开的旁白（双方都看得到）');
    // 界面靠这个闪一下：光有战报不够，正盯着棋盘的人不会去翻
    check(
      (s.levelState?.terrain?.cells ?? []).includes(7 * 14 + 7),
      `改动记进了 levelState.terrain（第 ${s.levelState?.terrain?.seq ?? 0} 批）`,
    );

    // 第 8 次行动：水退成浅流，但桥墩那格不变
    for (let i = 0; i < 6 && s.turn < 8; i++) {
      const r = applyAction(s, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      s = r.state;
    }
    check(s.turn >= 8, `走到第 ${s.turn} 次行动`);
    check(at(s, 7, 0) === 'shallow', `河道变成浅流（${at(s, 7, 0)}）`);
    check(at(s, 7, 7) === 'deep', `桥墩那格没跟着变（${at(s, 7, 7)}）——only 只改指定的地形`);

    // 存读一遍，地形是改过之后的样子
    const round = JSON.parse(JSON.stringify(s)) as GameState;
    check(at(round, 7, 0) === 'shallow' && at(round, 7, 7) === 'deep', '存读之后地形还是改过的样子');
  }

  /*
   * 格子上的兵：改成水之后要**挤到旁边**，不能消失。
   * 城格：改成什么都不动。
   */
  const mkTerrainLevel = (events: unknown[], deploy: unknown) => ({
    ...levelById('level:probe-flat')!,
    id: 'level:test-terrain',
    seats: { count: 2, ai: [] },
    setup: { startEra: 1 },
    deploy,
    events,
  });
  const flood = createMatch(
    {
      ...DEFAULT_CONFIG,
      level: mkTerrainLevel(
        [
          {
            id: 'flood',
            when: { kind: 'turn', at: 2 },
            do: [{ kind: 'terrain', zone: { x0: 5, y0: 5, x1: 5, y1: 5 }, to: 'water' }],
          },
          {
            id: 'quake',
            when: { kind: 'turn', at: 2 },
            do: [{ kind: 'terrain', zone: { x0: 0, y0: 0, x1: 4, y1: 4 }, to: 'deep' }],
          },
        ],
        {
          A: [{ type: 'militia', x: 5, y: 5 }],
          B: [{ type: 'militia', x: 10, y: 10 }],
        },
      ) as never,
    },
    11,
  );
  const before = flood.units.find((u) => u.owner === 'A')!;
  check(before.x === 5 && before.y === 5, '测试局：守方那个兵站在 (5,5)');
  const cityTile = flood.tiles[0]; // 城格由地图决定，下面按 cityId 找
  void cityTile;

  const r2 = applyAction(flood, { type: 'END_TURN' } as Action);
  check(r2.ok, '走到第 2 次行动');
  if (r2.ok) {
    const st = r2.state;
    const him = st.units.find((u) => u.owner === 'A');
    check(!!him, '被水淹的兵没有凭空消失');
    check(st.tiles[5 * st.w + 5]?.terrain === 'water', '那一格确实变成水了');
    check(
      !!him && (him.x !== 5 || him.y !== 5),
      `兵被挤到旁边（${him?.x}, ${him?.y}）`,
      '还站在水里：寻路和攻击判定都会错乱',
    );
    // 用 ignoreUnits：他自己就站在那一格上，带着占用去问永远是否
    check(!!him && canStandAt(st, him.x, him.y, him.type, { ignoreUnits: true }), '挤到的那一格是站得住的');
    check(st.log.some((l) => l.text.includes('被挤到')), '挤走也说了句人话');
    // 城格不在改动之列
    const city = st.cities.find((c) => c.owner === 'A')!;
    check(st.tiles[city.y * st.w + city.x]?.terrain === 'city', '城格没有被改成深水');
  }
}

/* ── 22. 改不成的地形 ───────────────────────────────────────── */
line('22. 事件改不了的地形');
{
  const base = levelById('level:cut-bridge')!;
  const mk = (doList: unknown): unknown => ({
    ...base,
    id: 'level:x',
    events: [{ id: 'e', when: { kind: 'turn', at: 2 }, do: doList }],
  });
  for (const [label, act] of [
    ['改成城', { kind: 'terrain', zone: { x0: 1, y0: 1, x1: 1, y1: 1 }, to: 'city' }],
    ['改成桥', { kind: 'terrain', zone: { x0: 1, y0: 1, x1: 1, y1: 1 }, to: 'bridge' }],
    ['改成不认识的地形', { kind: 'terrain', zone: { x0: 1, y0: 1, x1: 1, y1: 1 }, to: 'lava' }],
  ] as Array<[string, unknown]>) {
    const res = validateLevel(mk([act]));
    check(!res.ok && res.errors.length > 0, `${label}：被拒并给出原因`, res.ok ? '居然通过了' : '被拒但没有原因');
  }
}

/* ── 23. 地图桥 vs 工兵桥（2026-11-15 修的 bug）──────────────── */
line('23. 地图上的桥不该自己塌');
{
  const rear = levelById('level:rear-guard')!;
  let s = createMatch({ ...DEFAULT_CONFIG, level: rear }, 1);
  const bridgeAt = (st: GameState): string => st.tiles[7 * 14 + 6]?.terrain ?? '?';
  check(bridgeAt(s) === 'bridge', '开局桥在');
  check(s.units.filter((u) => u.owner === 'A').length === 1, '开局守桥的兵在');
  check((s.mapBridges ?? []).includes(7 * 14 + 6), '这一格被记进 mapBridges（地图自带）');

  /*
   * 这一步是关键：以前 `syncBridges` 会在**第一次结算**就把地图桥判成塌了，
   * 站在上面的兵当场落水。所以"走几步之后桥还在、兵还在"才是这条 bug 的回归测试。
   */
  for (let i = 0; i < 3; i++) {
    const r = applyAction(s, { type: 'END_TURN' } as Action);
    if (!r.ok) break;
    s = r.state;
  }
  check(bridgeAt(s) === 'bridge', `走了 ${s.turn - 1} 步，桥还在（${bridgeAt(s)}）`,
    '地图上的桥被当成工兵桥拆掉了');
  const alive = s.units.filter((u) => u.owner === 'A');
  check(alive.length === 1, `守桥的兵还活着（${alive.length}）`, '桥塌了把人一起带走了');
  check(!s.log.some((l) => l.text.includes('落水')), '没有出现"落水"战报');

  // 反过来：工兵架出来的桥，单位没了还得塌
  {
    let st = createMatch({ ...DEFAULT_CONFIG, level: levelById('level:cut-bridge')! }, 7);
    const W = st.w;
    const spot = 3 * W + 7; // 河里的一格，不在 mapBridges 里
    check(!(st.mapBridges ?? []).includes(spot), '这一格不是地图自带的桥');
    const def = st.unitTypes['bridge']!;
    st.tiles[spot]!.terrain = 'bridge'; // 模拟 deckBridge
    st.units.push({
      id: `u${st.nextUnitSeq++}`,
      type: 'bridge',
      owner: 'A',
      x: 7,
      y: 3,
      hp: def.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    });
    const keep = applyAction(st, { type: 'END_TURN' } as Action);
    check(keep.ok && keep.state.tiles[spot]?.terrain === 'bridge', '工兵桥有单位撑着：不塌',
      `实际 ${keep.ok ? keep.state.tiles[spot]?.terrain : '动作被拒'}`);

    const without = keep.ok ? keep.state : st;
    without.units = without.units.filter((u) => u.type !== 'bridge');
    const gone = applyAction(without, { type: 'END_TURN' } as Action);
    check(gone.ok && gone.state.tiles[spot]?.terrain === 'water', '工兵没了：桥面照旧塌回水面',
      `实际 ${gone.ok ? gone.state.tiles[spot]?.terrain : '动作被拒'}`);
  }
}

/* ── 24. 玩家关冒烟：三关都能建、都能跑 ─────────────────────── */
line('24. 玩家关：孤城 / 斩首 / 黄雀 / 护送 / 邪龙');
{
  /*
   * 2026-11-17 菜单分成两栏：
   *   · 「关卡」= 主线 / 教学关（`demo` 不写）——现在还没设计，空着是正常状态；
   *   · 「编辑器」= 示例关（`demo: true`）——内建那五张。
   * 两栏加起来就是"玩家可见的关卡"，也就是 `playableLevels()`。
   */
  const demos = demoLevels();
  const stories = storyLevels();
  const menu = playableLevels();
  check(demos.length === 5, `编辑器栏有五张示例关（${demos.map((l) => l.name).join(' / ')}）`);
  check(
    demos.every((l) => l.demo === true),
    '示例关都标了 demo——不标的话它们会被当成主线关塞进「关卡」栏',
  );
  check(
    stories.length === 0,
    `「关卡」栏现在是空的（主线 / 教学关还没设计），实际 ${stories.map((l) => l.name).join(' / ') || '空'}`,
    '这张新关没写 demo=true，被当成主线关了',
  );
  check(
    menu.length === demos.length + stories.length,
    `两栏加起来等于玩家可见的关卡（${demos.length} + ${stories.length} = ${menu.length}）`,
  );
  check(
    allLevels().length > menu.length,
    `夹具关还在注册表里（全 ${allLevels().length} 张，玩家可见 ${menu.length} 张）`,
    '夹具被删了：探针二十多段会一起失效',
  );

  for (const lv of menu) {
    const v = validateLevel(lv);
    if (!v.ok) {
      bad(`${lv.name}：校验通过`, v.errors.slice(0, 3).join('；'));
      continue;
    }
    let s = createMatch({ ...DEFAULT_CONFIG, level: lv }, 20261115);
    const built = { cities: s.cities.length, units: s.units.length };
    let crashed = '';
    try {
      for (let i = 0; i < 24 && !s.winner; i++) {
        const a = aiNextAction(s) ?? ({ type: 'END_TURN' } as Action);
        const r = applyAction(s, a);
        s = r.ok ? r.state : (applyAction(s, { type: 'END_TURN' } as Action) as { state: GameState }).state;
      }
    } catch (err) {
      crashed = String(err);
    }
    check(crashed === '', `${lv.name}：跑 24 步不炸`, crashed);
    check(built.cities > 0 && built.units > 0, `${lv.name}：开局有城有兵（${built.cities} 城 / ${built.units} 兵）`);
    console.log(
      `      · ${lv.name}：${built.units} 兵起手 → 第 ${s.turn} 次行动，${
        s.winner ? `胜方 ${s.winner}` : '未分胜负'
      }`,
    );
  }
}

/* ── 24b. 邪龙：三人合作关的结构 ─────────────────────────────── */
{
  const lv = levelById('level:evil-dragon')!;
  const v = validateLevel(lv);
  check(v.ok, '邪龙：校验通过', v.ok ? '' : v.errors.slice(0, 3).join('；'));
  if (v.ok) {
    check(
      v.level.map.w === 28 && v.level.map.h === 18,
      `邪龙：地图 28×18（实际 ${v.level.map.w}×${v.level.map.h}）`,
    );
    check(
      JSON.stringify(v.level.seats?.teams) === '[["A","B"],["C"]]',
      '邪龙：A / B 同队、C 单独一队',
      JSON.stringify(v.level.seats?.teams),
    );
    check((v.level.seats?.cityless ?? []).includes('C'), '邪龙：C 是「没有城」的席位');
    check(
      (v.level.expansions?.require ?? []).includes('fantasy'),
      '邪龙：要求开奇想',
      JSON.stringify(v.level.expansions?.require),
    );
    check(
      (v.level.expansions?.require ?? []).includes('air'),
      '邪龙：强制开空军（开局那两只侦察气球要靠它）',
      JSON.stringify(v.level.expansions?.require),
    );

    const s = createMatch({ ...DEFAULT_CONFIG, level: v.level }, 7);
    /*
     * 这条断言是这次最容易再踩的坑：三家局里只要有一家 cityless，
     * `setup` 的 multiOk 就不成立 → 关卡地图被丢掉、**静默**退回 12×12 随机图。
     * 玩家看到的是"我做的 28×18 变成了 12×12"，日志里一个字都没有。
     */
    check(s.w === 28 && s.h === 18, `邪龙：关卡地图真的生效（实际 ${s.w}×${s.h}）`, '又静默退回随机图了');
    check(s.cities.every((c) => c.owner !== 'C'), '邪龙：C 一座城都没有');
    check(s.units.some((u) => u.owner === 'C'), '邪龙：开局必须有兵', 'C 是 cityless，0 兵第一帧就判出局');
    check(
      s.units.filter((u) => u.type === 'af_balloon').length >= 4,
      `邪龙：开局两家各两只侦察气球（实际 ${s.units.filter((u) => u.type === 'af_balloon').length} 只）`,
    );
    for (const t of ['evil-dragon-king', 'demon', 'bone-dragon', 'dragoon-rider', 'af_balloon']) {
      check(!!s.unitTypes[t], `邪龙：兵种表里有「${t}」`, '没有的话事件刷兵只会留一句系统日志');
    }

    /*
     * 禁用兵种：玩家造不了黑暗势力那几样。
     *
     * 这条和下面"boss 照样刷得出来"是一对——禁的是**产线**，不是兵种表。
     * 只做前者的话，玩家会发现自己造不出邪龙王；把后者也测上，才能确认
     * "敌人那边不受影响"这个语义没被误伤。
     */
    const myCity = s.cities.find((c) => c.owner === 'A');
    if (myCity) {
      for (const id of ['evil-dragon-king', 'demon', 'bone-dragon']) {
        const r = applyAction(s, { type: 'RECRUIT', cityId: myCity.id, unitType: id });
        check(
          !r.ok && (r as { reason: string }).reason.includes('禁用'),
          `邪龙：玩家造不了「${s.unitTypes[id]?.name ?? id}」`,
          r.ok ? '竟然造出来了' : '',
        );
      }
      const fine = applyAction(s, { type: 'RECRUIT', cityId: myCity.id, unitType: 'tank' });
      check(fine.ok, '邪龙：没禁的兵种照常能造', fine.ok ? '' : (fine as { reason: string }).reason);
    }

    /*
     * 完全体要在第 26 次行动之后下场。
     *
     * 这里**另开一局带 `godMode`**：AI 的攻击性拉满之后，两家由电脑代打的玩家
     * 撑不到第 26 次行动（实测第 24 次就打崩了），循环提前退出，boss 自然还没刷。
     * 那测的就不是"事件会不会触发"，而是"这关难不难"——后者不该由探针来判。
     * `godMode` 让玩家席位不判负，于是能稳定跑到完全体那一波。
     */
    let wave = createMatch({ ...DEFAULT_CONFIG, level: v.level, godMode: true }, 7);
    try {
      for (let i = 0; i < 200 && !wave.winner && wave.turn < 27; i += 1) {
        const a = aiNextAction(wave) ?? ({ type: 'END_TURN' } as Action);
        const r = applyAction(wave, a);
        wave = r.ok ? r.state : (applyAction(wave, { type: 'END_TURN' } as Action) as { state: GameState }).state;
      }
    } catch {
      /* 炸了下面那条会红 */
    }
    check(
      wave.units.some((u) => u.type === 'evil-dragon-king'),
      `邪龙：第 26 次行动后邪龙王下场（当前 turn=${wave.turn}）`,
      `场上只有 ${wave.units.filter((u) => u.owner === 'C').map((u) => u.type).join(',') || '空'}`,
    );
  }
}

/* ── 25. 孤城：守方没有"安全位"（2026-11-15 实机复盘后）─────── */
line('25. 孤城：隔河白打与一夫当关都不成立');
{
  const lv = levelById('level:lone-city')!;
  const s = createMatch({ ...DEFAULT_CONFIG, level: lv }, 3);
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  /*
   * 实机复盘：守方曾经把弓箭手摆在河岸，越过一格宽的河把对岸的农民和部队
   * 一个个点掉——对面过不来也够不到，于是"守"变成了零代价收割。
   *
   * 现在河宽两格、弓手射程 3：站在自家河岸最多够到河边，
   * 想打到对岸就得先站进河里。这条断言把那个位置彻底钉死。
   */
  const myShooters = s.units.filter((u) => u.owner === 'A' && u.type === 'archer');
  const foes = s.units.filter((u) => u.owner === 'B');
  const nearest = Math.min(...myShooters.flatMap((a) => foes.map((f) => cheb(a, f))));
  check(nearest > 3, `开局弓手够不到对岸（最近 ${nearest} 格 > 射程 3）`, `只有 ${nearest} 格：隔河白打又回来了`);

  /*
   * 攻方的开局构成：只查"够不够形成压力"，**不钉具体兵种**。
   *
   * 钉死过一版（"必须 4 近战 4 远程 2 斥候 2 农民"），作者调阵容就报红——
   * 而阵容本来就是作者该自由调的东西。真要防的是"攻方太薄，压不过来"。
   */
  const foe = s.units.filter((u) => u.owner === 'B');
  check(foe.length >= 8, `攻方开局 ${foe.length} 个兵`, '兵太少，压不过来');
  check(foe.some((u) => u.type === 'tower'), '攻方带了箭塔', '没有塔，守方站河边不掉血');

  /*
   * 桥面 2×2：**通行口宽两格**。
   *
   * 这里最容易搞错的是"什么叫两格宽"：河是竖的、过河走横向，所以通行口宽不宽
   * 只看桥面在 y 方向占了几个格子。只画 (7,7)(8,7) 是"跨过两列河、只开一个口子"，
   * 还是一个兵堵得死。四格才是两条通道。
   */
  const bridges = s.tiles.map((t, i) => ({ t, i })).filter((x) => x.t.terrain === 'bridge');
  check(bridges.length === 4, `桥面是 2×2 四格（${bridges.length} 格）`, '一格宽＝一个兵封死全场');
  const lanes = new Set(bridges.map((b) => Math.floor(b.i / s.w)));
  check(lanes.size === 2, `两条过河通道（y=${[...lanes].join('/')}）`, '桥还是只有一条通道');

  // 兵种构成：只查能不能形成压力，具体阵容归作者
  const count = (t: string): number => s.units.filter((u) => u.owner === 'B' && u.type === t).length;
  // 近战/远程都要有：只有一种压不住（全近战过不了河，全远程守不住桥头）
  check(count('militia') >= 2 && count('archer') >= 2, `攻方近战/远程都有（${count('militia')}/${count('archer')}）`);
  check(count('tower') >= 1, `攻方 2 座箭塔钉在河岸（${count('tower')}）`);

  // 塔要够得着过桥后的第一格，否则钉在那儿没意义
  const towers = s.units.filter((u) => u.type === 'tower');
  const bridgeHeads = [{ x: 9, y: 7 }, { x: 9, y: 8 }];
  check(
    towers.every((t) => bridgeHeads.some((b) => cheb(t, b) <= 3)),
    '每座塔都覆盖桥头',
    '塔离桥头太远，过桥的人不会被压',
  );

  /*
   * 每一波援军都必须有播报。
   *
   * 援军刷在图的东边缘（x=12/13），玩家在西岸，隔着河和两座城——开着迷雾
   * 那就是纯视野盲区。只 spawn 不播报，玩家的体验就是"敌方所谓的援兵都没来"：
   * 看不见、也没人告诉他。这条断言防的就是这个。
   */
  const waves = (lv.events ?? []).filter((e) => e.id.startsWith('wave') || e.id.startsWith('flank'));
  check(waves.length >= 3, `援军/突击队分 ${waves.length} 波`);
  /*
   * 两翼骑兵：投送是 AI 的硬伤，兵得由事件送过来。
   *
   * 但**不能直接送到玩家身边**——试过，玩家的第一反应是"AI 在耍赖"，
   * 不是"远处来了援军"。所以落点必须在地图边缘：从画面外跑进来才叫合围。
   */
  const flankers = waves.filter((w) => w.id.startsWith('flank'));
  check(flankers.length >= 2, `两翼骑兵 ${flankers.length} 波`);
  const spots = flankers.flatMap((w) =>
    w.do.flatMap((d) => (d.kind === 'spawn' ? d.units : [])),
  );
  const h = lv.map.h;
  check(
    spots.every((u) => u.y === 0 || u.y === h - 1),
    `骑兵全部从地图南北边缘进场（${spots.length} 个）`,
    '有骑兵落在腹地：那看起来像是凭空冒出来的',
  );
  /*
   * 两翼用的兵种**必须在兵种表里**。
   *
   * `spawn` 遇到表里没有的兵种会静默跳过（只在战报留一句）。写个 era 更高的兵种
   * （青铜局写铁器骑士）就会踩这个坑：事件跑了、兵一个没有。
   */
  const missing = [...new Set(spots.map((u) => u.type))].filter((t) => !s.unitTypes[t]);
  check(
    missing.length === 0,
    `两翼兵种都在本局兵种表里（${[...new Set(spots.map((u) => u.type))].join('、')}）`,
    `这些兵种本局不存在，刷不出来：${missing.join('、')}`,
  );
  const silent = waves.filter((w) => !w.do.some((d) => d.kind === 'say')).map((w) => w.id);
  check(silent.length === 0, '每一波援军都有播报', `这几波是静默的：${silent.join('、')}`);
  /*
   * 桥塌：**从关卡数据里读**时间和目标地形，不写死。
   *
   * 写死过一版（"第 9 次"），作者把炸桥挪到第 10 次、地形从深水改成水，
   * 探针立刻报红——而关卡其实是对的。这类断言要跟着数据走。
   */
  const blow = (lv.events ?? []).find((e) => e.id === 'blow');
  check(!!blow, '关卡有炸桥事件');
  const blowWhen = blow?.when;
  const blowAt = blowWhen && 'kind' in blowWhen && blowWhen.kind === 'turn' ? blowWhen.at : 0;
  const blowTo = blow?.do.find((d) => d.kind === 'terrain') as { to?: string } | undefined;
  let cur = s;
  for (let i = 0; i < 30 && cur.turn < blowAt && !cur.winner; i++) {
    const r = applyAction(cur, { type: 'END_TURN' } as Action);
    if (!r.ok) break;
    cur = r.state;
  }
  const at = (st: GameState, x: number, y: number): string => st.tiles[y * st.w + x]?.terrain ?? '?';
  const want = blowTo?.to ?? 'water';
  const gone = [[7, 7], [8, 7], [7, 8], [8, 8]].filter(([x, y]) => at(cur, x!, y!) === want).length;
  check(gone === 4, `第 ${blowAt} 次行动后四格桥一起没了（${gone}/4 → ${want}）`, `四格没全塌：剩下的那行还能过河`);
}

/* ── 26. 刷兵不许静默失败 ─────────────────────────────────────── */
line('26. 关卡刷兵：落点被占时会就近找位，不该有"站不住"');
{
  for (const lv of playableLevels()) {
    const v = validateLevel(lv);
    if (!v.ok) continue;
    let s = createMatch({ ...DEFAULT_CONFIG, level: v.level }, 20261115);
    for (let i = 0; i < 200 && !s.winner; i += 1) {
      const r = applyAction(s, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      s = r.state;
    }
    const failed = s.log.filter((l) => l.text.includes('站不住'));
    check(
      failed.length === 0,
      `${v.level.name}：刷兵全部落地`,
      `${failed.length} 次刷兵失败（${failed.slice(0, 3).map((l) => l.text).join('；')}）`,
    );
  }
}

/* ── 汇总 ─────────────────────────────────────────────────────── */
console.log('');
/* ------------------------------------------------------------------ */
/* 计数型条件：fired + times（2026-11-17）                              */
/* ------------------------------------------------------------------ */

{
  const base = allLevels().find((l) => l.id === 'level:probe-flat')!;
  const say = (text: string) => [{ kind: 'say', text }];
  const counted = validateLevel({
    ...structuredClone(base),
    id: 'level:tmp-count',
    name: '计数探针',
    events: [
      /*
       * `tick` 每手都触发（`repeat` + `turn >= 1` 恒真），`gold +1` 让它在战报里
       * 不吵；`twice` 在 tick 第 2 次之后成立。
       */
      { id: 'tick', when: { kind: 'turn', at: 1 }, repeat: true, do: [{ kind: 'gold', seat: 'A', amount: 1 }] },
      { id: 'twice', when: { kind: 'fired', id: 'tick', times: 2 }, do: say('已经两次了') },
    ],
  });
  check(counted.ok, '计数条件能通过校验', counted.ok ? '' : counted.errors[0]);
  if (counted.ok) {
    let st = createMatch({ ...DEFAULT_CONFIG, level: counted.level }, 3);
    const seenAt: number[] = [];
    for (let i = 0; i < 6 && !st.winner; i += 1) {
      const r = applyAction(st, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      st = r.state;
      if (st.log.some((l) => l.text === '已经两次了')) seenAt.push(st.turn);
    }
    check(seenAt.length > 0, '「第 2 次才成立」的条件最终会触发', seenAt.join(','));
    check(
      seenAt.length === 0 || seenAt[0]! >= 2,
      '它不会在第 1 次就触发',
      `实际第 ${seenAt[0] ?? '-'} 次`,
    );
    check(
      (st.levelState?.counts?.tick ?? 0) >= 2,
      '次数记在 levelState.counts 里',
      `tick=${String(st.levelState?.counts?.tick)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 事件条件的 lint：引用 / 环 / repeat（2026-11-17）                    */
/* ------------------------------------------------------------------ */

{
  const base = allLevels().find((l) => l.id === 'level:probe-flat')!;
  const lintOf = (events: unknown[]) => {
    const v = validateLevel({ ...structuredClone(base), id: 'level:tmp-lint', name: 'lint 探针', events });
    return v.ok ? lintLevel(v.level) : [];
  };
  const say = (text: string) => [{ kind: 'say', text }];

  const missing = lintOf([{ id: 'a', when: { kind: 'fired', id: 'nope' }, do: say('x') }]);
  check(
    missing.some((i) => i.severity === 'error' && i.text.includes('不存在的「nope」')),
    '引用不存在的事件：lint 报错',
  );

  const cycle = lintOf([
    { id: 'a', when: { kind: 'fired', id: 'b' }, do: say('x') },
    { id: 'b', when: { kind: 'fired', id: 'a' }, do: say('y') },
  ]);
  check(
    cycle.some((i) => i.severity === 'error' && i.text.includes('互相等待')),
    '互相等待的两个事件：lint 报错',
  );

  const repeatRef = lintOf([
    { id: 'a', when: { kind: 'enter', zone: { x0: 1, y0: 1, x1: 2, y1: 2 } }, repeat: true, do: say('x') },
    { id: 'b', when: { kind: 'fired', id: 'a' }, do: say('y') },
  ]);
  check(
    repeatRef.some((i) => i.severity === 'warn' && i.text.includes('重复触发')),
    '引用 repeat 事件：给一条提醒（不算错）',
  );

  const needRepeat = lintOf([
    { id: 'a', when: { kind: 'turn', at: 2 }, do: say('x') },
    { id: 'b', when: { kind: 'fired', id: 'a', times: 2 }, do: say('y') },
  ]);
  check(
    needRepeat.some((i) => i.severity === 'error' && i.text.includes('不是 repeat')),
    '要它发生 2 次但它不是 repeat：报错（永远不成立）',
  );
}

/* ------------------------------------------------------------------ */
/* 事件条件：组合树 / 比较符 / fired 链（2026-11-17）                    */
/* ------------------------------------------------------------------ */

{
  const base = allLevels().find((l) => l.id === 'level:probe-flat')!;
  const withEvents = (events: unknown[]) =>
    validateLevel({ ...structuredClone(base), id: 'level:tmp-ev', name: '事件条件探针', events });

  const say = (text: string) => [{ kind: 'say', text }];

  const empty = withEvents([{ id: 'e1', when: { all: [] }, do: say('x') }]);
  check(!empty.ok, '空组被拦下（不能当成"恒真"）', empty.ok ? '' : empty.errors[0]?.slice(0, 40));

  const leaf = withEvents([{ id: 'e1', when: { kind: 'turn', at: 2 }, do: say('x') }]);
  check(leaf.ok, '老写法（单条件叶子）仍然合法');

  const nested = withEvents([
    {
      id: 'e1',
      when: {
        all: [
          { kind: 'turn', at: 3, op: '<=' },
          { any: [{ kind: 'unitDied' }, { kind: 'enter', zone: { x0: 1, y0: 1, x1: 3, y1: 3 } }] },
          { not: { kind: 'fired', id: 'e0' } },
        ],
      },
      do: say('x'),
    },
    { id: 'e0', when: { kind: 'turn', at: 1 }, do: say('y') },
  ]);
  check(nested.ok, '嵌套 all / any / not 通过校验', nested.ok ? '' : nested.errors[0]?.slice(0, 50));

  const badOp = withEvents([{ id: 'e1', when: { kind: 'turn', at: 2, op: '≈' }, do: say('x') }]);
  check(!badOp.ok, '不认识的比较符被拦下');

  const selfRef = withEvents([{ id: 'e1', when: { kind: 'fired', id: 'e1' }, do: say('x') }]);
  check(!selfRef.ok, '引用自己的条件被拦下（永远不会触发）');

  /*
   * 运行时：A 在第 2 次行动触发，B 的条件是"A 已发生"。
   * B 不需要等下一次动作——同一批的**第二遍扫描**就能看到 A。
   */
  const chained = withEvents([
    { id: 'a', when: { kind: 'turn', at: 2 }, do: say('A 触发了') },
    { id: 'b', when: { kind: 'fired', id: 'a' }, do: say('B 跟着触发') },
  ]);
  if (chained.ok) {
    let st = createMatch({ ...DEFAULT_CONFIG, level: chained.level }, 3);
    for (let i = 0; i < 20 && st.turn < 2 && !st.winner; i += 1) {
      const r = applyAction(st, { type: 'END_TURN' } as Action);
      if (!r.ok) break;
      st = r.state;
    }
    const said = st.log.filter((l) => l.system === true).map((l) => l.text);
    check(
      said.includes('A 触发了') && said.includes('B 跟着触发'),
      'fired 链在同一批里传播',
      said.slice(-3).join(' / '),
    );
  } else {
    check(false, 'fired 链在同一批里传播', '关卡没通过校验');
  }
}

if (failed === 0) {
  console.log(`全部通过（关卡「${levelById(probe.id)?.name}」，${STEPS} 步样本）`);
} else {
  console.log(`有 ${failed} 项没过`);
  process.exitCode = 1;
}
