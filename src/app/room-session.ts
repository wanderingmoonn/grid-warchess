/** 联机会话的状态判断，避免 UI 轮询把草稿或异步切换后的新局覆盖。 */
import type { Action, GameState, PlayerId } from '../core/types.ts';
import { submissionPlayer } from '../net/protocol.ts';

export function shouldSubmitTurn(action: Action, state: GameState): boolean {
  return action.type === 'END_TURN' || state.winner !== null;
}

/** 终局可能仍在对手当前回合，不能只等待 current 切到自己。 */
export function shouldAcceptRoomState(local: GameState, remote: GameState, seat: PlayerId): boolean {
  if (remote.turn < local.turn) return false;
  if (remote.winner && !local.winner) return true;
  return remote.current === seat && remote.turn > local.turn;
}

/** 待提交标记仅保存旧回合号，棋局仍使用房间草稿槽；恢复时重新验证归属。 */
export function restorePendingTurn(state: GameState, seat: PlayerId, raw: string | null): number | null {
  if (!raw) return null;
  try {
    const expectedTurn: unknown = JSON.parse(raw);
    if (typeof expectedTurn !== 'number') return null;
    return submissionPlayer(state, expectedTurn) === seat ? expectedTurn : null;
  } catch {
    return null;
  }
}
