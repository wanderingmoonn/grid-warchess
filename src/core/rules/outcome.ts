/** 城市是胜负目标；完整轮上限让双方获得同样多的行动机会。 */
import { CONFIG } from '../config.ts';
import type { GameState } from '../types.ts';

export interface MatchOutcome {
  winner: Exclude<GameState['winner'], null>;
  reason: NonNullable<GameState['resultReason']>;
}

/** 纯查询。仅在 B 结束行动时触发轮数裁决，不能在 A 先行动后提前裁决。 */
export function evaluateOutcome(state: GameState, endingTurn = false): MatchOutcome | null {
  const a = state.cities.filter((city) => city.owner === 'A').length;
  const b = state.cities.filter((city) => city.owner === 'B').length;
  if (a === 0 && b === 0) return { winner: 'draw', reason: 'no-cities' };
  if (a === 0) return { winner: 'B', reason: 'conquest' };
  if (b === 0) return { winner: 'A', reason: 'conquest' };
  if (endingTurn && state.current === 'B' && state.turn >= CONFIG.maxRounds * 2) {
    return { winner: a === b ? 'draw' : a > b ? 'A' : 'B', reason: 'turn-limit' };
  }
  return null;
}

/** 终局原因供战报和界面复用；玩家名称由渲染边界负责转义。 */
export function outcomeText(state: GameState): string {
  if (!state.winner) return '';
  const winner = state.winner === 'draw' ? '平局' : `${state.players[state.winner].name}获胜`;
  if (state.resultReason === 'no-cities') return '双方均无城市，对局平局';
  if (state.resultReason === 'turn-limit') {
    const a = state.cities.filter((city) => city.owner === 'A').length;
    const b = state.cities.filter((city) => city.owner === 'B').length;
    return `达到 ${CONFIG.maxRounds} 轮上限，按城市数 ${a}∶${b} 裁决：${winner}`;
  }
  if (state.resultReason === 'conquest') return `${winner}：对方已失去全部城市`;
  return `${winner}（保留旧版终局结果）`;
}
