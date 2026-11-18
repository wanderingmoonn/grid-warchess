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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
