/**
 * 计划排序层的探针（P1）。
 *
 * 只测机制，不跑对局：注册、排序、合成、承诺、冷却、紧急中断。
 * 现在没有任何真实计划注册，所以这些用例全用假计划——它们的价值由用例直接给，
 * 这样"排序算得对不对"和"某条计划估得准不准"是两件事，分开验。
 *
 * 用法：`npm run probe:plan-rank`
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';
import {
  PLAN_TUNING,
  allAiPlans,
  clearAiPlansForTest,
  composeWeights,
  neutralWeights,
  planCount,
  registerAiPlan,
  resolvePlans,
  type AiPlan,
  type PlanCtx,
  type PlanMemo,
} from '../src/core/ai-plan.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

const s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2 }, 11);
function ctxOf(turn: number): PlanCtx {
  return {
    view: { ...s, turn },
    me: 'A',
    era: 2,
    foeEra: 2,
    army: 5,
    foeArmy: 5,
    income: 20,
    gold: 100,
    canReach: true,
    threat: 0,
    enemyAtGate: false,
    weaker: false,
    horizon: PLAN_TUNING.horizon,
    state: {},
  };
}

/** 造一条假计划：值固定，权重固定 */
function fakePlan(
  id: string,
  opts: {
    kind?: 'weights' | 'action';
    value?: number;
    strength?: number;
    done?: boolean;
    weights?: AiPlan['weights'];
    focus?: AiPlan['focus'];
  } = {},
): AiPlan {
  return {
    id,
    kind: opts.kind ?? 'weights',
    strength: opts.strength ?? 1,
    value: () => opts.value ?? 10,
    done: () => opts.done === true,
    ...(opts.kind === 'action' ? { next: () => [] } : {}),
    ...(opts.weights ? { weights: opts.weights } : {}),
    ...(opts.focus ? { focus: opts.focus } : {}),
  };
}

console.log('1 注册');
clearAiPlansForTest();
ok(planCount() === 0, '清空之后注册表是空的');
registerAiPlan(fakePlan('a'));
registerAiPlan(fakePlan('a'));
ok(planCount() === 1, '同 id 重复注册是幂等的');
ok(allAiPlans().length === 1, 'allAiPlans 只有一份');

console.log('2 权重合成');
{
  const w = neutralWeights();
  ok(w.attack === 1 && w.build === 1 && w.econ === 1 && w.save === 1, '中性权重全是 1');
  const two = composeWeights([
    { plan: fakePlan('x', { strength: 1 }), asked: { attack: 0.5 } },
    { plan: fakePlan('y', { strength: 1 }), asked: { attack: 2 } },
  ]);
  ok(near(two.net.attack, 1), '两条相反的满强度计划合成到 1（允许对撞，不阻断）');
  const half = composeWeights([{ plan: fakePlan('x', { strength: 0.5 }), asked: { attack: 2 } }]);
  ok(near(half.net.attack, 1.5), '强度 0.5 的 ×2 只生效一半（1.5）');
  const zero = composeWeights([{ plan: fakePlan('x', { strength: 0 }), asked: { attack: 2 } }]);
  ok(near(zero.net.attack, 1), '强度 0 = 完全没意见');
  ok(two.ledger.length === 2 && two.ledger[0]!.id === 'x', '合成账本按顺序记下每条计划');
}

console.log('3 排序：行动型最多一条，权重型全部当值');
{
  clearAiPlansForTest();
  registerAiPlan(fakePlan('act-hi', { kind: 'action', value: 30 }));
  registerAiPlan(fakePlan('act-lo', { kind: 'action', value: 10 }));
  registerAiPlan(fakePlan('w1', { value: 5, weights: () => ({ econ: 1.5 }) }));
  registerAiPlan(fakePlan('w2', { value: 3, weights: () => ({ build: 0.5 }) }));
  const r = resolvePlans(ctxOf(5), null);
  ok(r.action?.id === 'act-hi', '行动型取价值最高的那条');
  ok(r.weights.length === 2, '两条权重型都当值');
  ok(r.values[0]?.id === 'act-hi', '估值表按价值从高到低');
  ok(near(r.net.econ, 1.5) && near(r.net.build, 0.5), '净权重是两条合成后的结果');
}

console.log('4 承诺：死区与改投门槛');
{
  const prev: PlanMemo = { id: 'act-hi', valueAt: 30, since: 1, pockets: {} };
  clearAiPlansForTest();
  registerAiPlan(fakePlan('act-hi', { kind: 'action', value: 20 })); // 20 ≥ 30×0.6
  registerAiPlan(fakePlan('act-ch', { kind: 'action', value: 40 })); // 40 < 30×1.5=45
  const keep = resolvePlans(ctxOf(6), prev);
  ok(keep.action?.id === 'act-hi', `旧计划掉到 ${20}（阈值 18）仍继续`);
  ok(keep.memo?.valueAt === 30 && keep.memo?.since === 1, '继续时沿用原 valueAt / since');

  registerAiPlan(fakePlan('act-ch2', { kind: 'action', value: 46 })); // ≥ 45
  const sw = resolvePlans(ctxOf(7), prev);
  ok(sw.action?.id === 'act-ch2', '新候选到 1.5 倍才改投');
  ok(sw.memo?.since === 7, '改投时重记 since');

  registerAiPlan(fakePlan('act-lo2', { kind: 'action', value: 17 })); // < 18
  const drop = resolvePlans(ctxOf(8), prev);
  ok(drop.action?.id !== 'act-hi', '旧计划掉到 0.6 以下就不保了');
}

console.log('5 冷却：刚放弃的短期内不重立');
{
  clearAiPlansForTest();
  registerAiPlan(fakePlan('act-a', { kind: 'action', value: 30 }));
  const prev: PlanMemo = { id: 'act-a', valueAt: 30, since: 1, pockets: {} };
  // 第 9 回合：act-a 掉了，改投 act-b
  registerAiPlan(fakePlan('act-b', { kind: 'action', value: 60 }));
  const r1 = resolvePlans(ctxOf(9), prev);
  ok(r1.action?.id === 'act-b', '改投到更高的那条');
  ok(r1.memo?.cooldown?.['act-a'] === 9 + PLAN_TUNING.cooldown, '被放弃的计划进了冷却表');
  // 第 10 回合：act-a 又变最高，但还在冷却
  clearAiPlansForTest();
  registerAiPlan(fakePlan('act-a', { kind: 'action', value: 100 }));
  registerAiPlan(fakePlan('act-b', { kind: 'action', value: 10 }));
  const r2 = resolvePlans(ctxOf(10), r1.memo);
  ok(r2.action?.id !== 'act-a', '冷却期内不重立');
}

console.log('6 完成过的计划不参与');
{
  clearAiPlansForTest();
  registerAiPlan(fakePlan('done-plan', { kind: 'action', value: 99, done: true }));
  registerAiPlan(fakePlan('live-plan', { kind: 'action', value: 1 }));
  const r = resolvePlans(ctxOf(3), null);
  ok(r.action?.id === 'live-plan', 'done 为真的计划被跳过');
  ok(r.values.find((x) => x.id === 'done-plan')?.value === 0, 'done 的计划估值为 0');
}

console.log('7 紧急：urgent 时优先防御（前提是它已注册）');
{
  clearAiPlansForTest();
  registerAiPlan(fakePlan('act-a', { kind: 'action', value: 100 }));
  registerAiPlan(fakePlan('defend', { kind: 'action', value: 1 }));
  const r = resolvePlans(ctxOf(12), null, { urgent: true });
  ok(r.action?.id === 'defend', 'urgent 压过价值更高的进攻');
  ok(r.reason.includes('urgent'), '理由里写明是紧急中断');
}

console.log('8 空注册表：什么都不选，权重全中性');
{
  clearAiPlansForTest();
  const r = resolvePlans(ctxOf(1), null);
  ok(r.action === null && r.weights.length === 0, '没有计划时当值清单为空');
  ok(r.memo === null, '没有计划时不写记忆');
  ok(
    r.net.attack === 1 && r.net.build === 1 && r.net.econ === 1 && r.net.save === 1,
    '空表时净权重全是 1（对局不受影响）',
  );
}

console.log('9 写坏的计划不打死整局');
{
  clearAiPlansForTest();
  registerAiPlan({
    id: 'boom',
    kind: 'weights',
    strength: 1,
    value: () => {
      throw new Error('boom');
    },
    done: () => false,
    weights: () => {
      throw new Error('boom');
    },
  });
  registerAiPlan(fakePlan('fine', { value: 2, weights: () => ({ attack: 1.2 }) }));
  const r = resolvePlans(ctxOf(4), null);
  ok(r.weights.length === 1 && r.weights[0]!.id === 'fine', '抛错的计划按"不成立"处理，别的照常');
  ok(near(r.net.attack, 1.2), '抛错的计划不污染权重');
}

console.log('10 落点（focus）与口袋');
{
  clearAiPlansForTest();
  registerAiPlan(
    fakePlan('cross', {
      kind: 'weights',
      value: 5,
      focus: () => ({ x: 3, y: 4 }),
    }),
  );
  const r = resolvePlans(ctxOf(2), null);
  ok(r.focus?.x === 3 && r.focus?.y === 4, '计划给的落点进了结果');
  ok(r.focusPlanId === 'cross', '落点记得是哪条计划给的');
  ok(
    JSON.stringify((r.memo?.pockets['cross']?.focus ?? null) === null ? null : r.memo?.pockets['cross']?.focus) ===
      JSON.stringify({ x: 3, y: 4 }),
    '落点写进了这条计划自己的口袋',
  );

  // 粘性：计划读自己的口袋，沿用上一回合的点
  clearAiPlansForTest();
  registerAiPlan(
    fakePlan('sticky', {
      kind: 'weights',
      value: 5,
      focus: (c) => (c.state.focus as { x: number; y: number } | undefined) ?? { x: 9, y: 9 },
    }),
  );
  const prev: PlanMemo = { id: 'sticky', valueAt: 5, since: 1, pockets: { sticky: { focus: { x: 1, y: 1 } } } };
  const r2 = resolvePlans(ctxOf(3), prev);
  ok(r2.focus?.x === 1 && r2.focus?.y === 1, '计划能读到上一回合的落点（粘性）');

  // 两条计划各有各的口袋，互不覆盖
  clearAiPlansForTest();
  registerAiPlan(fakePlan('p1', { value: 3, focus: () => ({ x: 1, y: 1 }) }));
  registerAiPlan(fakePlan('p2', { value: 2, focus: () => ({ x: 2, y: 2 }) }));
  const r3 = resolvePlans(ctxOf(4), null);
  ok(
    r3.memo?.pockets['p1'] !== undefined && r3.memo?.pockets['p2'] !== undefined,
    '两条当值计划各有一份口袋',
  );
  ok(r3.focusPlanId === 'p1', '多个落点取价值最高的那条');
}

console.log('11 完成不冷却（干完的活不等于放弃）');
{
  clearAiPlansForTest();
  // 上一回合在追 act-a；这一回合它 done 了
  registerAiPlan({
    id: 'act-a',
    kind: 'action',
    strength: 1,
    value: () => 30,
    done: () => true,
    next: () => [],
  });
  registerAiPlan(fakePlan('act-b', { kind: 'action', value: 5 }));
  const prev: PlanMemo = { id: 'act-a', valueAt: 30, since: 1, pockets: {} };
  const r = resolvePlans(ctxOf(20), prev);
  ok(r.action?.id === 'act-b', '完成的计划不再当值');
  ok(r.memo?.cooldown?.['act-a'] === undefined, '完成不进冷却（过河过去之后被赶回来可以立刻重立）');
}

clearAiPlansForTest();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
