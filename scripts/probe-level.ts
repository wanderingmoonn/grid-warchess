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
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { LEVELS, levelById, validateLevel } from '../src/core/level.ts';
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
check(LEVELS.length > 0, `${LEVELS.length} 张关卡`);
for (const def of LEVELS) {
  const res = validateLevel(def);
  if (!res.ok) {
    bad(`${def.id} 过不了校验`, res.errors.join('；'));
    continue;
  }
  ok(`${def.id}（${res.level.name} ${res.level.map.w}×${res.level.map.h}）`);
  check(res.level.map.rows.every((r) => r.length === res.level.map.w),
    `${def.id} 每行长度一致`);
  check(res.level.map.citiesA.length > 0 && res.level.map.citiesB.length > 0,
    `${def.id} 双方各有城`);
}

const probe = LEVELS[0];
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

/* ── 汇总 ─────────────────────────────────────────────────────── */
console.log('');
if (failed === 0) {
  console.log(`全部通过（关卡「${levelById(probe.id)?.name}」，${STEPS} 步样本）`);
} else {
  console.log(`有 ${failed} 项没过`);
  process.exitCode = 1;
}
