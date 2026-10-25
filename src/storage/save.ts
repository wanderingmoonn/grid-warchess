/**
 * 存档层（本机）。
 *
 * 每次动作后自动落盘，所以刷新、关页面后还能继续；换设备需要导出或联机同步。
 * 联机时这一层存的是**草稿**——结束回合或分出胜负后才会把整局推到云端
 * （见 net/room.ts），所以对方看不到你正在怎么摆兵。
 *
 * 一个必须记住的边界：本机的存档是完整的 fullState。
 * 热座模式无所谓（同一个人操作两边），联机模式下意味着
 * "迷雾是界面约定而不是安全边界"。
 */

import type { GameState } from '../core/types.ts';
import { isObject, isPlayerId } from './validation.ts';
import { normalizeState } from './migrate.ts';

const KEY_MATCH = 'warchess:match:v1';
const KEY_META = 'warchess:meta:v1';

/**
 * 当前存档写到哪个键。
 *
 * 本机对局写 warchess:match:v1；进了联机房间就写 warchess:match:v1:room:<CODE>。
 * 分开是为了两件事：
 *   1. 房间里的草稿不会把你本机那局冲掉，退出房间还能接着打；
 *   2. 同一个浏览器同时挂两局也不会互相覆盖。
 */
let scopedKey = KEY_MATCH;
let scopedMetaKey = KEY_META;

/** 切到某个房间的草稿槽；传 null 回到本机对局 */
export function setSaveScope(roomCode: string | null): void {
  scopedKey = roomCode ? `${KEY_MATCH}:room:${roomCode}` : KEY_MATCH;
  scopedMetaKey = roomCode ? `${KEY_META}:room:${roomCode}` : KEY_META;
}

export interface MatchMeta {
  createdAt: number;
  updatedAt: number;
  /** 当前应该由谁操作 */
  pendingFor: 'A' | 'B';
}

export function saveMatch(s: GameState): void {
  try {
    const normalized = normalizeState(s);
    if (!normalized) return;
    localStorage.setItem(scopedKey, JSON.stringify(normalized));
    const prev = loadMeta();
    const meta: MatchMeta = {
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      pendingFor: s.current,
    };
    localStorage.setItem(scopedMetaKey, JSON.stringify(meta));
  } catch {
    // 隐私模式下 localStorage 不可写，静默降级为纯内存对局
  }
}

export function loadMatch(): GameState | null {
  try {
    const raw = localStorage.getItem(scopedKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

export function loadMeta(): MatchMeta | null {
  try {
    const raw = localStorage.getItem(scopedMetaKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || !isPlayerId(parsed.pendingFor)) return null;
    const { createdAt, updatedAt, pendingFor } = parsed;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0 ||
      typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < createdAt) return null;
    return { createdAt, updatedAt, pendingFor };
  } catch {
    return null;
  }
}

export function clearMatch(): void {
  try {
    localStorage.removeItem(scopedKey);
    localStorage.removeItem(scopedMetaKey);
  } catch {
    // ignore
  }
}

/** 导出成一段文本，可以直接发微信给对方 */
export function exportMatch(s: GameState): string {
  return JSON.stringify({ kind: 'warchess-match', version: 1, state: s });
}

export function importMatch(text: string): GameState | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || parsed.kind !== 'warchess-match' || parsed.version !== 1) return null;
    return normalizeState(parsed.state);
  } catch {
    return null;
  }
}
