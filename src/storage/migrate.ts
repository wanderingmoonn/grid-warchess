/** One normalization path for local saves, imports and cloud snapshots. */
import type { GameState } from '../core/types.ts';
import { isValidState } from './validation.ts';

/**
 * v4 did not persist production usage and its log may be truncated. Lock only
 * this commander turn rather than guessing from text and allowing extra units.
 * The normal turn transition clears the lock. Completed games retain results.
 */
export function normalizeState(value: unknown): GameState | null {
  if (!isValidState(value)) return null;
  const state = structuredClone(value);
  if (state.version === 4) {
    state.version = 5;
    state.turnProduction = {
      turn: state.turn,
      player: state.current,
      recruited: state.config.commanderMode ? 1 : 0,
      upgraded: 0,
      ...(state.config.commanderMode ? { legacyLocked: true } : {}),
    };
    if (state.winner) state.resultReason = 'legacy';
    else delete state.resultReason;
  }
  return state;
}
