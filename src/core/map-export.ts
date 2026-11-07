/**
 * 把一局沙盒（上帝模式）反过来导成一张可分享的固定地图。
 *
 * 为什么要有这一步：上帝模式已经能把地形、城位摆成任何样子，那张图本来
 * 就"能玩"——但它是这一局的存档，别人拿不到。要让它变成别人也能选的图，
 * 就必须落回 `FixedMap` 这个公开格式，并且**过一遍同一套校验**。
 *
 * 两条口径（2026-11-07 改过，别按老印象理解）：
 *
 *   1. **地形原样导出，不折算**。地形字符表现在从 `mapgen` 的 `CHAR` 派生
 *      （见 `TERRAIN_CHARS`），扩展地形（台地/谷地/沼泽/沙丘/浅流/深水）
 *      照样收。以前这里会把它们折成本体六种，理由是"别人没开扩展就认不出来"——
 *      那是错的：地形是规则层的正式成员，渲染、移动、视野都无条件支持，
 *      扩展只决定**生成器画不画**。折算的代价是作者画了半天的沼泽在别人
 *      那边变成平原，而且**只在别人那边**变，最难解释。
 *      现在只在 `note` 里提醒一句"这张图用了扩展地形"，不改数据。
 *
 *   2. **城位放得下就行，不要求离边界留空**。贴边的城（含四个角）是正经的
 *      地图设计。只有"2×2 框不进棋盘"才拦——那不是风格问题，是数据不成立。
 */

import {
  MAP_MAX_SIZE,
  MAP_MIN_SIZE,
  validateFixedMap,
  type FixedMap,
  type MapPoint,
} from './fixed-maps.ts';
import { terrainCharOf } from './mapgen.ts';
import type { GameState, PlayerId, Terrain } from './types.ts';

/**
 * "扩展地形"：地图生成器只有在开对应扩展时才会画出来的那几种。
 *
 * 收进地图**没有问题**（规则层无条件支持），但要提醒作者一句：
 * 别人的对局里不会自然生成它们，看到这张图时会有点意外。
 */
const EXPANSION_TERRAINS: ReadonlySet<string> = new Set([
  'plateau',
  'valley',
  'marsh',
  'dune',
  'shallow',
  'deep',
]);

const TERRAIN_NAME: Record<string, string> = {
  plain: '平原',
  forest: '森林',
  hill: '丘陵',
  water: '水域',
  mountain: '高山',
  bridge: '桥',
  plateau: '台地',
  valley: '谷地',
  marsh: '沼泽',
  dune: '沙丘',
  shallow: '浅流',
  deep: '深水',
};

export interface MapExportResult {
  ok: boolean;
  map?: FixedMap;
  /** 校验没过的原因（直接给作者看） */
  errors: string[];
  /**
   * 给作者看的一句提醒：这张图用了哪些扩展地形、多少格。空串＝全是本体地形。
   *
   * 只提醒、不改数据——地图里有沼泽就是沼泽，传上去之后在别人那边也是沼泽。
   */
  note: string;
}

/**
 * 当前局面 → 一份地图。
 *
 * `name` 由调用方给（界面上的输入框），这里只做裁剪和校验。
 */
export function stateToFixedMap(state: GameState, name: string): MapExportResult {
  const errors: string[] = [];

  if (
    state.w < MAP_MIN_SIZE ||
    state.w > MAP_MAX_SIZE ||
    state.h < MAP_MIN_SIZE ||
    state.h > MAP_MAX_SIZE
  ) {
    return {
      ok: false,
      errors: [
        `这张图是 ${state.w}×${state.h}，能分享的地图只收 ${MAP_MIN_SIZE}~${MAP_MAX_SIZE}`,
      ],
      note: '',
    };
  }

  // 地形层：逐格照搬，只统计"用了哪些扩展地形"用来提醒
  const extras = new Map<string, number>();
  const unknown = new Set<string>();
  const rows: string[] = [];
  for (let y = 0; y < state.h; y += 1) {
    let line = '';
    for (let x = 0; x < state.w; x += 1) {
      const t = (state.tiles[y * state.w + x]?.terrain ?? 'plain') as Terrain;
      // 城格在地形层是平原：这一格是不是城由 citiesA/B 记，字符只管地貌
      if (t === 'city') {
        line += '.';
        continue;
      }
      line += terrainCharOf(t);
      if (EXPANSION_TERRAINS.has(t)) extras.set(t, (extras.get(t) ?? 0) + 1);
      // 老存档里可能还留着已删除的地形（lava / volcano），导出会按平原算：
      // 不报错，但要说一句，别让作者以为图坏了
      if (t !== 'plain' && terrainCharOf(t) === '.') unknown.add(t);
    }
    rows.push(line);
  }

  // 城位：左上角原样取，按归属分两堆
  const citiesA: MapPoint[] = [];
  const citiesB: MapPoint[] = [];
  for (const c of state.cities ?? []) {
    const owner: PlayerId = c.owner;
    const point = { x: c.x, y: c.y };
    if (owner === 'A') citiesA.push(point);
    else if (owner === 'B') citiesB.push(point);
    // 三/四人局里的 C/D 没有位置放，直接丢掉——固定地图只认两方
  }
  if (citiesA.length === 0) errors.push('甲方一座城都没有：先用「城市」笔刷给红方摆一座');
  if (citiesB.length === 0) errors.push('乙方一座城都没有：先用「城市」笔刷给蓝方摆一座');

  const parts: string[] = [];
  if (extras.size > 0) {
    parts.push(
      `用了扩展地形：${[...extras.entries()]
        .map(([t, n]) => `${TERRAIN_NAME[t] ?? t} ${n} 格`)
        .join('、')}（没开对应扩展的对局里它们照样是这些地形，只是不会自然生成）`,
    );
  }
  if (unknown.size > 0) {
    parts.push(`有 ${[...unknown].join('、')} 这类已不在游戏里的地形，导出后按平原算`);
  }
  const note = parts.join('；');

  if (errors.length > 0) return { ok: false, errors, note };

  // 最后过一遍公开格式的校验：城放不放得下、叠不叠、每方上限都在那里面
  const checked = validateFixedMap({ name, rows, citiesA, citiesB });
  if (!checked.ok) return { ok: false, errors: checked.errors, note };

  return {
    ok: true,
    // id 用本地临时值：真正入库后云端会回一个 `user:<行号>`，这里只是让
    // 尚未上传/上传失败的图也能在本机注册表里占个位置
    map: { ...checked.map, id: `user:local-${Date.now().toString(36)}` },
    errors: [],
    note,
  };
}
