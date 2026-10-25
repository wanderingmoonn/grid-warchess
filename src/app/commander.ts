/** 指挥官计划与批次推进，不依赖 DOM、存储或浏览器计时。 */
import { isAiSide } from '../core/ai.ts';
import type { AiBudget } from '../core/ai.ts';
import { CONFIG, ORDER_UPGRADE } from '../core/config.ts';
import { citiesOf, incomeOf, ordersOf, recruitCost, upgradeCostOf } from '../core/rules.ts';
import type { GameState, PlayerId, UnitTypeDef } from '../core/types.ts';
import { productionOf } from '../core/rules/production.ts';

/** 单人指挥官视角固定在人类一方；双人本地局沿用当前方视角。 */
export function commanderPlayer(state: GameState): PlayerId {
  const human = (['A', 'B'] as const).filter((player) => !isAiSide(state, player));
  return human.length === 1 ? human[0]! : state.current;
}

export function commanderPool(state: GameState, player: PlayerId): UnitTypeDef[] {
  const eras = citiesOf(state, player).map((city) => city.era);
  const era = eras.length > 0 ? Math.max(...eras) : 1;
  return Object.values(state.unitTypes)
    .filter((def) => def.category !== 'building' && def.era <= era && def.era >= era - 1)
    .sort((a, b) => a.era - b.era || a.cost - b.cost);
}

/** 升级以最便宜城市估算，后续收入、战损与城市归属仍可能改变实际费用。 */
export function commanderSlotCost(state: GameState, player: PlayerId, order: string): number {
  if (!order) return 0;
  if (order === ORDER_UPGRADE) {
    const costs = citiesOf(state, player)
      .map((city) => upgradeCostOf(state, city))
      .filter((cost): cost is number => cost !== null);
    return costs.length > 0 ? Math.min(...costs) : 0;
  }
  const def = state.unitTypes[order];
  return def ? recruitCost(state, player, def) : 0;
}

export function estimateCommanderGold(state: GameState, player: PlayerId): number[] {
  const income = incomeOf(state, player);
  const queue = ordersOf(state, player);
  const out: number[] = [];
  let available = state.players[player].gold;
  const used = productionOf(state);
  const consumed = state.current === player && used.recruited + used.upgraded > 0;
  for (let i = 0; i < CONFIG.commanderSlots; i++) {
    out.push(available);
    const cost = consumed && i === 0 ? 0 : commanderSlotCost(state, player, queue[i] ?? '');
    // 钱不够时这一格空过，不会实际扣款，更不应让后续预算变成负债。
    if (cost <= available) available -= cost;
    available += income;
  }
  return out;
}

export function commanderBudget(state: GameState, player: PlayerId): Partial<AiBudget> {
  const used = productionOf(state);
  if (state.current === player && used.recruited + used.upgraded > 0) {
    return { maxRecruit: 0, maxUpgrade: 0, order: null };
  }
  const head = ordersOf(state, player)[0] ?? '';
  if (head === ORDER_UPGRADE) return { maxRecruit: 0, maxUpgrade: 1, order: null };
  return { maxRecruit: head ? 1 : 0, maxUpgrade: 0, order: head || null };
}

interface CommanderBatchContext {
  getState(): GameState;
  active(): boolean;
  progress(round: number): void;
  runTurn(overrides?: Partial<AiBudget>): Promise<boolean>;
}

/** 每轮严格为「固定的指挥方 → 对手 → 指挥方」，完成五轮才允许重新装填计划。 */
export async function executeCommanderRounds(
  context: CommanderBatchContext,
  player: PlayerId,
  rounds = CONFIG.commanderSlots,
): Promise<boolean> {
  const alive = () => context.active() && !context.getState().winner;
  for (let round = 1; round <= rounds; round++) {
    if (!alive()) return false;
    // 中断发生在对手行动期间时，先完成该回合，再从指挥方继续。
    if (context.getState().current !== player) {
      if (!(await context.runTurn()) || !alive()) return false;
    }
    if (context.getState().current !== player) return false;
    context.progress(round);
    if (!(await context.runTurn(commanderBudget(context.getState(), player))) || !alive()) return false;
    if (context.getState().current === player) return false;
    if (!(await context.runTurn()) || !alive()) return false;
    if (context.getState().current !== player) return false;
  }
  return true;
}
