/** 每回合生产账本。额度属于对局，不能被暂停、刷新或更换产兵点重置。 */
import { ORDER_UPGRADE } from '../config.ts';
import type { GameState } from '../types.ts';

export type ProductionAction = { type: 'RECRUIT'; unitType: string } | { type: 'UPGRADE' };
export type TurnProduction = NonNullable<GameState['turnProduction']>;

/** 返回副本，查询者不能通过修改返回值改变真实额度。 */
export function productionOf(state: GameState): TurnProduction {
  const saved = state.turnProduction;
  if (saved?.turn === state.turn && saved.player === state.current) return { ...saved };
  // v4 没有可靠账本；旧战报会截断，不能用“没找到产兵记录”证明额度未用。
  if (state.version === 4 && state.config.commanderMode && !saved) {
    return { turn: state.turn, player: state.current, recruited: 1, upgraded: 0, legacyLocked: true };
  }
  return { turn: state.turn, player: state.current, recruited: 0, upgraded: 0 };
}

/** 只检查产能及显式计划；金币、时代、空格仍由各行动处理器检查。 */
export function productionError(state: GameState, action: ProductionAction): string | null {
  if (!state.config.commanderMode) return null;
  const used = productionOf(state);
  if (used.recruited + used.upgraded > 0) {
    return used.legacyLocked
      ? '旧存档无法确认已用产能，本回合生产已封存，下一回合恢复'
      : '指挥官本回合产能已用完：招募一个单位或升级一座城市，二选一';
  }
  if (!state.orders || !Object.hasOwn(state.orders, state.current)) return null;
  const order = state.orders[state.current]?.[0] ?? '';
  if (!order) return '本回合计划留空，不进行招募或升级';
  if (action.type === 'UPGRADE') {
    return order === ORDER_UPGRADE ? null : '本回合计划是招募单位，不能升级城市';
  }
  if (order === ORDER_UPGRADE) return '本回合计划是升级时代，不能招募单位';
  return order === action.unitType ? null : '招募单位必须与本回合计划一致';
}

/** 仅在行动成功后调用；普通模式也记录，方便 AI 在重载后恢复自己的预算。 */
export function recordProduction(state: GameState, action: ProductionAction): void {
  const used = productionOf(state);
  if (action.type === 'RECRUIT') used.recruited += 1;
  else used.upgraded += 1;
  state.turnProduction = used;
}

export function resetProduction(state: GameState): void {
  state.turnProduction = { turn: state.turn, player: state.current, recruited: 0, upgraded: 0 };
}
