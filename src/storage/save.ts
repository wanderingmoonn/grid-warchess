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
// 扩展 id 会被合并/改名（2026-11-04 十六个包并成四个），老存档读进来必须先迁移，
// 否则 config 里留着旧 id，运行期按新 id 查不到包——表现就是"读档后扩展全失效"
import { normalizeExpansionIds } from '../core/expansions.ts';
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

/**
 * 存档暂停开关。
 *
 * 复盘时 `state` 会被临时换成"别人那一局"，而 main.ts 里二十多个地方都会
 * 顺手 `saveMatch(state)`——不拦住的话，玩家看一次复盘就等于把自己没打完的那局
 * 覆盖掉了，而且没有任何提示（下次打开就是别人的棋）。
 *
 * 为什么做在存档层而不是改那二十多个调用点：那种改法漏一处就出一次事故，
 * 而且以后新加的动作路径还会再漏一次。**开关只该有一处**。
 */
let suspended = false;

export function suspendSaves(on: boolean): void {
  suspended = on;
}

/** 切到某个房间的草稿槽；传 null 回到本机对局 */
export function setSaveScope(roomCode: string | null): void {
  scopedKey = roomCode ? `${KEY_MATCH}:room:${roomCode}` : KEY_MATCH;
}

import type { PlayerId } from '../core/types.ts';

export interface MatchMeta {
  createdAt: number;
  updatedAt: number;
  /** 当前应该由谁操作 */
  pendingFor: PlayerId;
}

export function saveMatch(s: GameState): void {
  if (suspended) return;
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
    // 旧扩展 id 迁移（只改内存这份，下次落盘自然写成新格式）
    if (parsed.config?.expansionIds) {
      parsed.config.expansionIds = normalizeExpansionIds(parsed.config.expansionIds);
    }
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

/**
 * 读一段存档文本。
 *
 * 除了「导出对局」那种 `warchess-match`，也收 `kind: 'snapshot'`——
 * 那是「反馈」面板拍下来的 bug 快照（见 core/snapshot.ts）。它的 `state`
 * 就是同一个完整局面，所以收到别人发来的一份快照，直接粘进来就能站到那一格上，
 * 不用先写脚本把 state 抠出来。
 */
export function importMatch(text: string): GameState | null {
  try {
    const parsed = JSON.parse(text) as { kind?: string; state?: GameState };
    if (parsed.kind !== 'warchess-match' && parsed.kind !== 'snapshot') return null;
    if (!parsed.state) return null;
    if (!isValidState(parsed.state)) return null;
    normalizePlayerNames(parsed.state);
    return parsed.state;
  } catch {
    return null;
  }
}
