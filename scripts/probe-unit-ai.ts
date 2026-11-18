/**
 * 单兵 AI 探针（阶段 1：骨架）。
 *
 * ── 它在守什么 ──────────────────────────────────────────────────────
 *
 * 这一层能合进主线的唯一前提是：**默认值不改变任何现有对局**。
 * 所以第一段是"零变化"：同一批种子跑几遍，动作序列必须一模一样。
 *
 * 但它不是"什么都没做也能过"的空测试——中间那两遍会**真的把 profile 挂上去**：
 *   · 自主分 0 → handler 一次都不该被调用；
 *   · 自主分 1 但 handler 返回空 → handler 被调用，但动作序列仍必须相同。
 * 后者才是真正有信息量的那一遍：它证明"接进去了、而且没副作用"。
 *
 * 最后一段是纯函数校验：白名单、unitId 一致、未注册 profile 静默降级。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *
 *   npm run probe:unit-ai
 *   npm run probe:unit-ai -- --turns 60 --seed 700000
 *
 * 只读：不改规则、不写存档。
 */

import { DEFAULT_BUDGET, aiNextAction, aiStallGuard, aiProgressFingerprint } from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { registerUnitAiProfile, resetUnitAiWarnings, unitAiOf, unitAiProfileOf, unitAiActionProblem } from '../src/core/unit-ai.ts';
import type { Action, GameState, Unit } from '../src/core/types.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const TURNS = Math.max(5, Number(argOf('turns', '40')));
const BASE_SEED = Number(argOf('seed', '700000'));
const GAMES = Math.max(1, Number(argOf('games', '2')));
/** 拿哪个兵种挂 profile。选最普通的那个，它每局都在场 */
const SUBJECT = argOf('unit', 'militia');

interface Arm {
  name: string;
  /** 挂上去的自主分；null = 不挂（基线） */
  autonomy: number | null;
  profile: string;
}

const ARMS: Arm[] = [
  { name: '基线（不挂 profile）', autonomy: null, profile: '' },
  { name: '自主分 0（挂了但不算）', autonomy: 0, profile: 'probe-zero' },
  { name: '自主分 1、handler 返回空', autonomy: 1, profile: 'probe-empty' },
  { name: '自主分 1、profile 未注册', autonomy: 1, profile: 'probe-missing' },
  { name: '自主分 1、提了非法动作', autonomy: 1, profile: 'probe-bad' },
];

/** handler 被调了几次——用来证明"接了没接" */
let handlerCalls = 0;

function registerProbeProfiles(): void {
  registerUnitAiProfile({
    id: 'probe-zero',
    handler: () => {
      handlerCalls += 1;
      return {};
    },
  });
  registerUnitAiProfile({
    id: 'probe-empty',
    handler: () => {
      handlerCalls += 1;
      return {};
    },
  });
  /*
   * 故意提一个"席位级"的动作（结束回合）。核心必须把它丢掉并告警，
   * 否则单兵 AI 就变成了一条绕过整套规划的旁路。
   */
  registerUnitAiProfile({
    id: 'probe-bad',
    handler: () => {
      handlerCalls += 1;
      return { must: { action: { type: 'END_TURN' } as Action, reason: '探针：这是非法的' } };
    },
  });
}

/** djb2：只要稳定，不需要防碰撞 */
function hashOf(items: string[]): string {
  let h = 5381;
  for (const s of items) {
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    h = (h * 33) >>> 0;
  }
  return h.toString(16);
}

interface Run {
  actions: string[];
  hash: string;
  calls: number;
  winner: string | null;
  turns: number;
}

/** 跑一局，返回动作序列的指纹 */
function playOne(seed: number, arm: Arm): Run {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 2, aiLevel: 'advanced', aiAlly: true, aiOpponent: true },
    seed,
  );
  if (arm.autonomy !== null) {
    // 只改这一局的兵种表（它是每局一份的快照），不碰全局
    for (const def of Object.values(s.unitTypes)) {
      if (def.id === SUBJECT) {
        def.aiAutonomy = arm.autonomy;
        def.aiProfile = arm.profile;
      }
    }
  }
  handlerCalls = 0;
  const actions: string[] = [];

  while (!s.winner && s.turn <= TURNS) {
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    const guard = aiStallGuard();
    const cap = 8 + 6 * s.units.filter((u) => u.owner === s.current).length + 6 * s.cities.filter((c) => c.owner === s.current).length;
    let rejects = 0;
    for (let steps = 0; steps < cap; steps += 1) {
      const action = aiNextAction(s, budget, rejected);
      if (!action) break;
      const r = applyAction(s, action);
      if (!r.ok) {
        rejected.add(JSON.stringify(action));
        rejects += 1;
        if (rejects > 12) break;
        continue;
      }
      rejects = 0;
      rejected.clear();
      actions.push(JSON.stringify(action));
      s = r.state;
      if (action.type === 'RECRUIT') budget.recruited += 1;
      if (action.type === 'UPGRADE') budget.upgraded += 1;
      if (s.winner) break;
      if (guard.note(JSON.stringify(action), aiProgressFingerprint(s))) break;
    }
    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }
  return { actions, hash: hashOf(actions), calls: handlerCalls, winner: s.winner ?? null, turns: s.turn };
}

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 第 0 段：注册探针用的 profile
 * ══════════════════════════════════════════════════════════════════ */
console.log('单兵 AI 探针（阶段 1 骨架）\n');
console.log('[0] 注册探针 profile');
registerProbeProfiles();
check('probe-zero 已注册', unitAiProfileOf('probe-zero') !== null);
check('probe-empty 已注册', unitAiProfileOf('probe-empty') !== null);
let dup = false;
try {
  registerUnitAiProfile({ id: 'probe-zero', handler: () => ({}) });
} catch {
  dup = true;
}
check('重复注册同一个 id 会抛错（不能后来者覆盖）', dup);

/* ══════════════════════════════════════════════════════════════════
 * 第 1 段：零变化
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[1] 零变化：默认值必须不改变任何动作');
resetUnitAiWarnings();
const runs = new Map<string, Run[]>();
for (const arm of ARMS) {
  const list: Run[] = [];
  for (let i = 0; i < GAMES; i += 1) list.push(playOne(BASE_SEED + i, arm));
  runs.set(arm.name, list);
}
const base = runs.get(ARMS[0]!.name)!;
for (const arm of ARMS.slice(1)) {
  const list = runs.get(arm.name)!;
  for (let i = 0; i < GAMES; i += 1) {
    const a = base[i]!;
    const b = list[i]!;
    check(
      `${arm.name} → 种子 ${BASE_SEED + i} 动作序列一致`,
      a.hash === b.hash,
      `基线 ${a.hash}（${a.actions.length} 步） vs ${b.hash}（${b.actions.length} 步）`,
    );
  }
}
const zeroRun = runs.get(ARMS[1]!.name)!;
check(
  '自主分 0 时 handler 一次都没被调用',
  zeroRun.every((r) => r.calls === 0),
  zeroRun.map((r) => r.calls).join(','),
);
const oneRun = runs.get(ARMS[2]!.name)!;
check(
  '自主分 1 时 handler 确实被调用（证明这条路是通的，不是死代码）',
  oneRun.every((r) => r.calls > 0),
  oneRun.map((r) => r.calls).join(','),
);

/* ══════════════════════════════════════════════════════════════════
 * 第 2 段：未注册的 profile 静默降级
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[2] 兵种写了名字、包里没注册');
{
  const s = createMatch({ ...DEFAULT_CONFIG, aiAlly: true }, BASE_SEED);
  const def = Object.values(s.unitTypes).find((d) => d.id === SUBJECT)!;
  def.aiAutonomy = 1;
  def.aiProfile = 'nobody-registered-this';
  const u = { id: 'x', type: def.id, owner: 'A', x: 0, y: 0, hp: 1, kills: 0, moved: false, acted: false } as Unit;
  check('查不到 profile 时按"没有自主行为"处理（返回 null，不抛错）', unitAiOf(s, u) === null);
}

/* ══════════════════════════════════════════════════════════════════
 * 第 3 段：白名单与 unitId
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[3] 单兵动作白名单');
const uid = 'unit-1';
const move: Action = { type: 'MOVE', unitId: uid, x: 1, y: 1 };
check('走一步可以用', unitAiActionProblem(move, uid) === null);
check(
  '结束回合不许用（那是席位级）',
  unitAiActionProblem({ type: 'END_TURN' } as Action, uid) !== null,
);
check(
  '招募不许用（会绕过整套招募规划）',
  unitAiActionProblem({ type: 'RECRUIT', unitType: 'militia' } as Action, uid) !== null,
);
check(
  '替别的兵做决定会被拦下',
  unitAiActionProblem({ type: 'MOVE', unitId: 'unit-2', x: 1, y: 1 }, uid) !== null,
);
check(
  '施法可以提（冷却/沉默由规则层管）',
  unitAiActionProblem({ type: 'HERO_SKILL', unitId: uid, skillId: 's1' } as Action, uid) === null,
);

/* ══════════════════════════════════════════════════════════════════
 * 第 4 段：清单。现在有几个兵种开了自主？（阶段 1 的答案必须是 0）
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[4] 兵种清单');
{
  const s = createMatch({ ...DEFAULT_CONFIG, aiAlly: true }, BASE_SEED);
  const defs = Object.values(s.unitTypes);
  const before = defs.filter((d) => !!d.aiProfile).length;
  console.log(`  · 本局兵种 ${defs.length} 个，改动前写了 aiProfile 的 ${before} 个`);
  check('当前没有任何兵种开自主（阶段 1 的答案必须是 0）', before === 0, `有 ${before} 个`);
  // 注入一个悬空的，验证"检测本身"是有效的——否则上一条只是"No news is good news"
  const probe = defs.find((d) => d.id === SUBJECT)!;
  probe.aiProfile = 'not-registered';
  const dangling = Object.values(s.unitTypes).filter(
    (d) => !!d.aiProfile && unitAiProfileOf(d.aiProfile!) === null,
  );
  check('悬空的 aiProfile 能被查出来（检测本身有效）', dangling.length === 1, `查出 ${dangling.length} 个`);
}

/* ══════════════════════════════════════════════════════════════════
 * 第 5 段：三道门（阶段 2 的核心）
 *
 * 这一段的场地是**手工搭的一个小局面**，不是真对局：
 * 一个自己的兵、一个贴身的敌人、一片平地、没有城。
 * 目的是把"must 会不会被普攻抢走 / 被拒后会不会反复提 / 会不会被随机吃掉"
 * 这三件事分别单独试一次——真对局里它们会缠在一起，分不清是谁的问题。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n[5] 三道门（手工小局面）');

/** 这一段要喂给 profile 的"剧本"。handler 是纯函数，只能读它 */
let scriptMust: Action | null = null;
let scriptAdds: Array<{ action: Action; score: number }> = [];
let scriptCalls = 0;

registerUnitAiProfile({
  id: 'probe-stage2',
  handler: () => {
    scriptCalls += 1;
    return {
      ...(scriptAdds.length > 0 ? { add: scriptAdds } : {}),
      ...(scriptMust ? { must: { action: scriptMust } } : {}),
    };
  },
});

interface Arena {
  s: GameState;
  boss: Unit;
  foe: Unit;
}

/** 12×12 全平地、无城、轮到 B。B 方那个兵就是探针 boss */
function arena(seed = 4242, autonomy = 1): Arena {
  const s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 3, aiLevel: 'tactic' }, seed);
  s.fog = false;
  s.units = [];
  s.cities = [];
  s.marks = [];
  s.current = 'B';
  s.turn = 7;
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  for (let y = 0; y < s.h; y += 1) {
    for (let x = 0; x < s.w; x += 1) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
  }
  const base = s.unitTypes['militia']!;
  s.unitTypes['probe-boss'] = {
    ...base,
    id: 'probe-boss',
    name: '探针 boss',
    move: 3,
    range: 1,
    atk: 24,
    armor: 4,
    maxHp: 200,
    vision: 6,
    aiAutonomy: autonomy,
    aiProfile: 'probe-stage2',
  };
  const mk = (type: string, owner: 'A' | 'B', x: number, y: number): Unit => {
    const u: Unit = {
      id: `${type}-${s.units.length}`,
      type,
      owner,
      x,
      y,
      hp: s.unitTypes[type]!.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u);
    return u;
  };
  const boss = mk('probe-boss', 'B', 5, 5);
  const foe = mk('militia', 'A', 6, 5); // 贴身，保证"普攻"这条候选真的存在
  return { s, boss, foe };
}

const keyOf = (a: Action): string => JSON.stringify(a);

/**
 * 第一道门：**must 会不会被一次普攻抢走**。
 *
 * 贴身的敌人随时可以打，那一手的分是实打实的战果；must 只是"往下面走两格"，
 * 本身没有任何收益。如果 must 输了，说明 1000 这个量级不够，或者它被别的
 * 机制（推演削分 / 随机带宽）吃掉了。
 */
{
  const { s, boss } = arena();
  scriptMust = { type: 'MOVE', unitId: boss.id, x: 5, y: 7 };
  scriptAdds = [];
  const picked = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
  check(
    'must 压得住贴脸普攻（不会被"这一刀更划算"抢走）',
    picked !== null && keyOf(picked) === keyOf(scriptMust),
    picked ? keyOf(picked) : 'null',
  );
}

/**
 * 第二道门：**非法动作会不会白耗一步**。
 *
 * 原本以为要测"被规则拒了会不会反复提"，搭出来发现引擎比这更严：
 * 候选在**进入挑选之前**就被筛掉了（`applyAction(view, …)` 不通过的直接跳过），
 * 所以一个走不到的目的地根本不会变成动作，也就没有"白耗一步"这回事。
 *
 * 这条值得测，因为它是个**好消息但要钉住**的性质：如果哪天有人把这一步优化掉
 * （"反正调用方会拒"），扩展写错坐标就会变成每回合空转。
 *
 * 另外补一条契约：已经进了 `rejected` 的动作，扩展再提也必须被丢掉。
 */
{
  const { s, boss } = arena();
  scriptMust = { type: 'MOVE', unitId: boss.id, x: 5, y: 11 };
  scriptAdds = [];
  const first = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
  check(
    '走不到的动作不会被提出来（候选阶段就筛掉了，不白耗一步）',
    first !== null && keyOf(first) !== keyOf(scriptMust),
    first ? keyOf(first) : 'null',
  );
  check('它转而去做别的（贴脸普攻），不是干脆不动', first?.type === 'ATTACK', first ? keyOf(first) : 'null');

  // 契约：rejected 里的动作，扩展提了也不会进候选表
  const again = arena();
  scriptMust = { type: 'MOVE', unitId: again.boss.id, x: 5, y: 7 };
  const rejected = new Set([keyOf(scriptMust)]);
  const picked = aiNextAction(again.s, { ...DEFAULT_BUDGET }, rejected);
  check(
    '已进 rejected 的动作不会再被提（我们的候选也认这张表）',
    picked === null || keyOf(picked) !== keyOf(scriptMust),
    picked ? keyOf(picked) : 'null',
  );
}

/**
 * 第三道门：**会不会被"分差 1.5% 内随机挑"吃掉**。
 *
 * 随机值来自 (种子, 回合, 已走步数)。换 8 个种子各挑一次，
 * 如果 must 有两次以上没选中，就说明它的分不够高——那种"时灵时不灵"
 * 在实机里会被当成"AI 抽风"，很难查。
 */
{
  const outcomes: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const { s, boss } = arena(4242 + i * 137);
    scriptMust = { type: 'MOVE', unitId: boss.id, x: 5, y: 7 };
    scriptAdds = [];
    const picked = aiNextAction(s, { ...DEFAULT_BUDGET }, new Set());
    outcomes.push(picked && keyOf(picked) === keyOf(scriptMust) ? 'ok' : 'lost');
  }
  const lost = outcomes.filter((x) => x === 'lost').length;
  check('换 8 个种子，must 每次都选中（不被随机吃掉）', lost === 0, `${lost} 次没选中`);
}

/**
 * 第四道（顺带验的）：**自主分是真在打折**。
 *
 * 同一个 `add`（分 200）：自主分 1 时压得过普攻，自主分 0.01 时只剩 2 分，
 * 就该输给普攻。这条不测"能不能用"，测的是"权重到底有没有生效"——
 * 没有它，自主分就只是个摆设字段。
 */
{
  const hi = arena();
  scriptMust = null;
  scriptAdds = [{ action: { type: 'MOVE', unitId: hi.boss.id, x: 5, y: 7 }, score: 200 }];
  const pickedHi = aiNextAction(hi.s, { ...DEFAULT_BUDGET }, new Set());
  check(
    '自主分 1：add 分 200 压得过普攻',
    pickedHi !== null && pickedHi.type === 'MOVE',
    pickedHi ? keyOf(pickedHi) : 'null',
  );

  const lo = arena(4242, 0.01);
  scriptMust = null;
  scriptAdds = [{ action: { type: 'MOVE', unitId: lo.boss.id, x: 5, y: 7 }, score: 200 }];
  const pickedLo = aiNextAction(lo.s, { ...DEFAULT_BUDGET }, new Set());
  check(
    '自主分 0.01：同一个 add 只剩 2 分，就该输给普攻（权重真在起作用）',
    pickedLo === null || pickedLo.type !== 'MOVE' || keyOf(pickedLo) !== keyOf(scriptAdds[0]!.action),
    pickedLo ? keyOf(pickedLo) : 'null',
  );
}

console.log(`  · 这一段 handler 被调用 ${scriptCalls} 次`);

/*
 * 顺带量一个数：**这个场地里"贴脸普攻"到底值多少分**。
 *
 * 为什么要量：DESIGN 第 5 节那张换算表是拍的（走一步 3~6、打一下 10~40……），
 * 以后写 boss 招式的人要靠它给分。二分找出"add 的分数高到多少才抢得过普攻"，
 * 就等于量出了那一刀的分。
 *
 * 只打印不断言：这是个**诊断值**，场地一变它就变（换兵种、换甲、换地形都影响），
 * 钉死它会变成一条"改数值就红"的测试。
 */
{
  let lo = 2;
  let hi = 200;
  while (lo < hi) {
    // 必须向下取整：`Math.round` 在 lo=2/hi=3 时会给出 mid=3，
    // 而"赢了"的分支是 hi=mid，减不下去就死循环（真踩过一次，进程被系统杀掉）
    const mid = Math.floor((lo + hi) / 2);
    const a = arena();
    scriptMust = null;
    scriptAdds = [{ action: { type: 'MOVE', unitId: a.boss.id, x: 5, y: 7 }, score: mid }];
    const picked = aiNextAction(a.s, { ...DEFAULT_BUDGET }, new Set());
    const won = picked !== null && keyOf(picked) === keyOf(scriptAdds[0]!.action);
    if (won) hi = mid;
    else lo = mid + 1;
  }
  console.log(
    `  · 参考值：这个场地（24 攻 / 射程 1 打 100 血 2 甲）里，贴脸普攻约值 ${hi} 分` +
      `——扩展给"替代普攻"的招式定分时可以拿它当 1 倍基准。`,
  );
}
scriptMust = null;
scriptAdds = [];

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
