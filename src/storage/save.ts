/**
 * 存档层（本机）。
 *
 * 每次动作后自动落盘，所以刷新、关页面、切设备都不会丢这一局的进度。
 * 联机时这一层存的是**草稿**——只有点了"结束回合"才会把整局推到云端
 * （见 net/room.ts），所以对方看不到你正在怎么摆兵。
 *
 * 一个必须记住的边界：本机的存档是完整的 fullState。
 * 热座模式无所谓（同一个人操作两边），联机模式下意味着
 * "迷雾是界面约定而不是安全边界"。
 */

import { normalizeUnitTypes } from '../core/customUnits.ts';
import { normalizePlayerNames } from '../core/setup.ts';
import type { GameState } from '../core/types.ts';

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

/** 切到某个房间的草稿槽；传 null 回到本机对局 */
export function setSaveScope(roomCode: string | null): void {
  scopedKey = roomCode ? `${KEY_MATCH}:room:${roomCode}` : KEY_MATCH;
}

export interface MatchMeta {
  createdAt: number;
  updatedAt: number;
  /** 当前应该由谁操作 */
  pendingFor: 'A' | 'B';
}

export function saveMatch(s: GameState): void {
  try {
    localStorage.setItem(scopedKey, JSON.stringify(s));
    const prev = loadMeta();
    const meta: MatchMeta = {
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      pendingFor: s.current,
    };
    localStorage.setItem(KEY_META, JSON.stringify(meta));
  } catch {
    // 隐私模式下 localStorage 不可写，静默降级为纯内存对局
  }
}

export function loadMatch(): GameState | null {
  try {
    const raw = localStorage.getItem(scopedKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (!isValidState(parsed)) return null;
    // 老存档里双方还叫"我方/敌方"：读出来顺手换成红蓝，不用玩家重开一局
    normalizePlayerNames(parsed);
    // 老存档里内嵌的兵种表用的是"整数抗性"，按倍率语义重新折算一次。
    // 只改内存里的这一份，下次落盘自然就是新格式——存档不必为了格式单独迁移。
    if (parsed.unitTypes) normalizeUnitTypes(parsed.unitTypes);
    return parsed;
  } catch {
    return null;
  }
}

export function loadMeta(): MatchMeta | null {
  try {
    const raw = localStorage.getItem(KEY_META);
    if (!raw) return null;
    return JSON.parse(raw) as MatchMeta;
  } catch {
    return null;
  }
}

export function clearMatch(): void {
  try {
    localStorage.removeItem(scopedKey);
    localStorage.removeItem(KEY_META);
  } catch {
    // ignore
  }
}

function isValidState(s: unknown): s is GameState {
  if (!s || typeof s !== 'object') return false;
  const o = s as Partial<GameState>;
  return (
    // 版本必须对上，否则结构字段可能缺失，读出来会到处崩
    o.version === 4 &&
    typeof o.w === 'number' &&
    typeof o.h === 'number' &&
    Array.isArray(o.tiles) &&
    Array.isArray(o.units) &&
    Array.isArray(o.cities) &&
    !!o.players &&
    !!o.memory &&
    !!o.config &&
    !!o.unitTypes
  );
}

/** 导出成一段文本，可以直接发微信给对方 */
export function exportMatch(s: GameState): string {
  return JSON.stringify({ kind: 'warchess-match', version: 1, state: s });
}

export function importMatch(text: string): GameState | null {
  try {
    const parsed = JSON.parse(text) as { kind?: string; state?: GameState };
    if (parsed.kind !== 'warchess-match' || !parsed.state) return null;
    if (!isValidState(parsed.state)) return null;
    normalizePlayerNames(parsed.state);
    return parsed.state;
  } catch {
    return null;
  }
}
