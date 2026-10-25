/** Offline, testable validation for the room transport boundary. */
import type { GameState, PlayerId } from '../core/types.ts';
import { isObject, isPlayerId, isValidState } from '../storage/validation.ts';
import { normalizeState } from '../storage/migrate.ts';

export type Seat = PlayerId;

export interface RoomSnapshot {
  code: string;
  state: GameState;
  turn: number;
  current: PlayerId;
  updatedAt: string;
  seats: Record<Seat, string | null>;
}

export interface RoomSeat {
  code: string;
  seat: Seat;
  token: string;
}

export function isRoomSeat(value: unknown): value is RoomSeat {
  return isObject(value) && typeof value.code === 'string' && value.code.length > 0 &&
    isPlayerId(value.seat) && typeof value.token === 'string' && value.token.trim().length > 0;
}

/** jsonb normally arrives as an object, but some SDK environments return JSON text. */
export function readRoomSnapshot(value: unknown): RoomSnapshot {
  if (!isObject(value)) throw new Error('房间数据不完整，请刷新后重试');
  let state: unknown = value.state;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { throw new Error('房间存档无法解析'); }
  }
  const seatToken = (token: unknown): token is string | null => token === null ||
    typeof token === 'string' && token.trim().length > 0;
  const normalized = normalizeState(state);
  if (!normalized) throw new Error('房间存档损坏或版本不兼容');
  if (typeof value.code !== 'string' || !value.code || value.turn !== normalized.turn || value.current !== normalized.current ||
    typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at)) ||
    !seatToken(value.seat_a) || !seatToken(value.seat_b)) {
    throw new Error('房间信息与存档不一致，请刷新后重试');
  }
  return {
    code: value.code,
    // Do not let local draft edits change a cached SDK response by reference.
    state: normalized,
    turn: normalized.turn,
    current: normalized.current,
    updatedAt: value.updated_at,
    seats: { A: value.seat_a, B: value.seat_b },
  };
}

/** Normal handoff advances once; a winning move may finish within the same turn. */
export function submissionPlayer(state: GameState, expectedTurn: number): PlayerId {
  if (!Number.isSafeInteger(expectedTurn) || expectedTurn < 1 || !isValidState(state)) {
    throw new Error('无法提交无效的对局状态');
  }
  if (state.turn === expectedTurn + 1) return state.current === 'A' ? 'B' : 'A';
  if (state.turn === expectedTurn && state.winner !== null) return state.current;
  throw new Error('只能提交结束后的回合或本回合的胜局');
}

/** jsonb may reorder object keys; a lost response must still be safe to retry. */
export function sameSubmittedState(left: GameState, right: GameState): boolean {
  const normalizedLeft = normalizeState(left);
  const normalizedRight = normalizeState(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const canonical = (state: GameState): string => JSON.stringify(state, (_key, value: unknown) =>
    isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  return canonical(normalizedLeft) === canonical(normalizedRight);
}
