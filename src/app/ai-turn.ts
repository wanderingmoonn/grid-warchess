/** AI 回合调度：规则仍由 applyAction 执行，界面和计时通过回调注入。 */
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey, aiNextAction } from '../core/ai.ts';
import type { AiBudget } from '../core/ai.ts';
import { applyAction } from '../core/rules.ts';
import { productionOf } from '../core/rules/production.ts';
import type { GameState } from '../core/types.ts';

export interface AiTurnContext {
  getState(): GameState;
  setState(state: GameState): void;
  active(): boolean;
  /** 每步保存，不因极快档跳过绘制而丢掉暂停前最后几个动作。 */
  save(): void;
  render(): void;
  sleep(ms: number): Promise<void>;
}

/** 返回是否完整结束了本方回合；取消时不会替新局结束回合。 */
export async function executeAiTurn(
  context: AiTurnContext,
  overrides: Partial<AiBudget> = {},
  delay = 70,
): Promise<boolean> {
  const initial = context.getState();
  // 同一方、同一回合也可能是另一份导入的存档，不能只靠回合号识别旧任务。
  let expectedState = initial;
  const rejected = new Set<string>();
  const player = initial.current;
  const turn = initial.turn;
  const budget: AiBudget = {
    ...DEFAULT_BUDGET,
    ...(initial.config.commanderMode ? { maxRecruit: 1 } : {}),
    ...overrides,
    recruited: productionOf(initial).recruited,
    upgraded: productionOf(initial).upgraded,
  };
  const alive = () => {
    const state = context.getState();
    return context.active() && state === expectedState && !state.winner && state.current === player && state.turn === turn;
  };

  for (let step = 0; step < AI_MAX_STEPS; step++) {
    if (!alive()) return false;
    const used = productionOf(context.getState());
    budget.recruited = used.recruited;
    budget.upgraded = used.upgraded;
    const action = aiNextAction(expectedState, budget, rejected);
    if (!action) break;
    const result = applyAction(expectedState, action);
    if (!result.ok) {
      // 迷雾下未知占位可能阻断移动；失败只排除这次尝试，其他单位继续行动。
      rejected.add(aiActionKey(action));
      await context.sleep(0);
      continue;
    }
    expectedState = result.state;
    rejected.clear();
    context.setState(result.state);
    context.save();
    if (delay > 0 || step % 6 === 0 || result.state.winner) context.render();
    // 即使极快档也让出主线程，让取消和换局事件有机会执行。
    await context.sleep(delay);
  }

  if (!alive()) return false;
  const end = applyAction(context.getState(), { type: 'END_TURN' });
  if (!end.ok) return false;
  expectedState = end.state;
  context.setState(end.state);
  context.save();
  context.render();
  await context.sleep(delay);
  return context.active() && context.getState() === expectedState;
}
