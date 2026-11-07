/**
 * 把一局沙盒（上帝模式）反过来导成一张可分享的固定地图。
 *
 * 为什么要有这一步：上帝模式已经能把地形、城位摆成任何样子，那张图本来
 * 就"能玩"——但它是这一局的存档，别人拿不到。要让它变成别人也能选的图，
 * 就必须落回 `FixedMap` 这个公开格式，并且**过一遍同一套校验**。
 *
 * 两条硬约束决定了这里不能"原样导出"：
 *
 *   1. **只能有本体那六种地形**（`.fh~^=`）。扩展地形（台地/谷地/沼泽/沙丘/
 *      浅流/深水）在没开对应扩展的局里会还原成平原甚至未知格——一份"给所有人
 *      玩"的地图不该带着别人的扩展依赖。所以这里做折算，并把折算结果**明说**
 *      给作者听，而不是悄悄改掉他的地形。
 *
 *   2. **城位有边距要求**（离边界至少 1 格、每方 1~8 座、不许叠）。沙盒里
 *      城可以贴着边摆，导出时那条约束就会失败。这里不替作者挪城——
 *      挪了就是"我传的和我摆的不是同一张图"，报错让他自己改。
 */

import {
  MAP_MAX_SIZE,
  MAP_MIN_SIZE,
  validateFixedMap,
  type FixedMap,
  type MapPoint,
} from './fixed-maps.ts';
import type { GameState, PlayerId, Terrain } from './types.ts';

/** 本体六种地形对应的字符（和 `TERRAIN_CHARS` 一致） */
const BASIC: Partial<Record<Terrain, string>> = {
  plain: '.',
  forest: 'f',
  hill: 'h',
  water: '~',
  mountain: '^',
  bridge: '=',
};

/**
 * 扩展地形 → 本体地形。
 *
 * 按"走法最接近"折算，不按颜色：浅流本来就该是水（陆军涉水、小船能过），
 * 褶成平原会让一条河凭空消失；沼泽反过来——它是**能走的**地面，只是慢，
 * 折成水会把它变成墙。城格折成平原，因为城由 `citiesA/B` 单独记，
 * 地形层不该再画一遍。
 */
const FOLD: Partial<Record<Terrain, { ch: string; name: string }>> = {
  plateau: { ch: 'h', name: '台地' },
  dune: { ch: 'h', name: '沙丘' },
  valley: { ch: '.', name: '谷地' },
  marsh: { ch: '.', name: '沼泽' },
  shallow: { ch: '~', name: '浅流' },
  deep: { ch: '~', name: '深水' },
  city: { ch: '.', name: '城格' },
};

export interface MapExportResult {
  ok: boolean;
  map?: FixedMap;
  /** 校验没过的原因（直接给作者看） */
  errors: string[];
  /**
   * 折算说明。空串＝一格都没改。
   *
   * 必须有：作者看到的图和传上去的图不一样，这件事得说在前面，
   * 不能等他玩到一半发现"我的沼泽怎么变成平原了"。
   */
  folded: string;
}

/**
 * 当前局面 → 一份地图。
 *
 * `name` 由调用方给（界面上的输入框），这里只做裁剪和校验。
 */
export function stateToFixedMap(state: GameState, name: string): MapExportResult {
  const errors: string[] = [];

  if (state.w < MAP_MIN_SIZE || state.w > MAP_MAX_SIZE || state.h < MAP_MIN_SIZE || state.h > MAP_MAX_SIZE) {
    return {
      ok: false,
      errors: [
        `这张图是 ${state.w}×${state.h}，能分享的地图只收 ${MAP_MIN_SIZE}~${MAP_MAX_SIZE}`,
      ],
      folded: '',
    };
  }

  // 地形层：逐格折成本体字符，顺手记下每一类折了多少格
  const foldCount = new Map<string, number>();
  const rows: string[] = [];
  for (let y = 0; y < state.h; y += 1) {
    let line = '';
    for (let x = 0; x < state.w; x += 1) {
      const t = state.tiles[y * state.w + x]?.terrain ?? 'plain';
      const basic = BASIC[t];
      if (basic) {
        line += basic;
        continue;
      }
      const fold = FOLD[t];
      if (fold) {
        line += fold.ch;
        const label = `${fold.name}→${fold.ch === '.' ? '平原' : fold.ch === 'h' ? '丘陵' : fold.ch === '~' ? '水域' : '?'}`;
        foldCount.set(label, (foldCount.get(label) ?? 0) + 1);
        continue;
      }
      // 认不出来的地形：按平原处理，但要说出来。这里不报错——
      // 一格未知地形不该让整张图传不上去，而作者也该知道那一格被抹平了。
      line += '.';
      const label = `未知地形（${t}）→平原`;
      foldCount.set(label, (foldCount.get(label) ?? 0) + 1);
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

  const folded =
    foldCount.size === 0
      ? ''
      : [...foldCount.entries()].map(([k, n]) => `${k} ${n} 格`).join('，');

  if (errors.length > 0) return { ok: false, errors, folded };

  // 最后过一遍公开格式的校验：城的边距、叠不叠、每方上限都在那里面
  const checked = validateFixedMap({ name, rows, citiesA, citiesB });
  if (!checked.ok) return { ok: false, errors: checked.errors, folded };

  return {
    ok: true,
    // id 用本地临时值：真正入库后云端会回一个 `user:<行号>`，这里只是让
    // 尚未上传/上传失败的图也能在本机注册表里占个位置
    map: { ...checked.map, id: `user:local-${Date.now().toString(36)}` },
    errors: [],
    folded,
  };
}
