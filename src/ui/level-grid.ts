/**
 * 编辑器里"一块地形网格"的共用底座。
 *
 * 为什么要有这个文件：画布（E2）、摆兵（E3）、事件选区/落点（E4）都需要同一件事——
 * 把 `rows` 摊成格子、把城标出来、把点击换算成坐标。前两块各写了一份，
 * 到第三块再抄一遍就是三份会各自漂移的实现（第一份改了城标，另两份不会动）。
 *
 * 这里只管三件事，不管交互：
 *   1. 城市占格的计算（一座 2×2 的城压住哪几格）；
 *   2. 把网格画出来（地形 class + 可选覆盖物）；
 *   3. 事件 → 格子坐标。
 * "点一下要干什么"留在各个面板里，因为那才是它们各自的东西。
 */

import { terrainFromChar } from '../core/mapgen.ts';
import type { MapPoint } from '../core/fixed-maps.ts';
import type { PlayerId, Terrain } from '../core/types.ts';

export interface CityHit {
  seat: PlayerId;
  origin: MapPoint;
}

/** 城的边长。地图数据里没有这个字段（它属于开局设置），编辑器统一按 2 算 */
export const EDITOR_CITY_SIZE = 2;

/**
 * 把"每家几座城"摊成"每一格属于谁"。
 *
 * 每次重画都算一遍是有意的：格子总数最多 40×40，而城的数量个位数，
 * 相比维护一份"增量更新"的索引，重算更不容易出错。
 */
export function cityLookup(
  cities: Partial<Record<PlayerId, MapPoint[]>>,
  size = EDITOR_CITY_SIZE,
): (x: number, y: number) => CityHit | null {
  const cells: Array<CityHit & { x: number; y: number }> = [];
  for (const [seat, list] of Object.entries(cities)) {
    for (const c of list ?? []) {
      for (let dy = 0; dy < size; dy += 1) {
        for (let dx = 0; dx < size; dx += 1) {
          cells.push({ seat: seat as PlayerId, origin: c, x: c.x + dx, y: c.y + dy });
        }
      }
    }
  }
  return (x, y) => {
    const hit = cells.find((c) => c.x === x && c.y === y);
    return hit ? { seat: hit.seat, origin: hit.origin } : null;
  };
}

/** 造一张 w×h 的字符网格，越界/缺字符一律当平原 */
export function gridFromRows(rows: string[], w: number, h: number): string[][] {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => rows[y]?.[x] ?? '.'));
}

export function terrainAt(grid: string[][], x: number, y: number): Terrain {
  return terrainFromChar(grid[y]?.[x] ?? '.');
}

/** 这一格该用哪套地形样式（城优先于地貌）。单格重绘和整块重绘共用它 */
export function cellTone(grid: string[][], cityAt: ((x: number, y: number) => CityHit | null) | undefined, x: number, y: number): string {
  return cityAt?.(x, y) ? 'city' : terrainAt(grid, x, y);
}

export interface RenderOptions {
  w: number;
  h: number;
  grid: string[][];
  cityAt?: (x: number, y: number) => CityHit | null;
  /** 城左上角那一格写什么字（一般就是 A/B/C/D） */
  cityLabel?: (hit: CityHit) => string;
  /** 每格的额外 HTML（兵棋、落点标记……）。返回空串就是不加 */
  overlay?: (x: number, y: number) => string;
  /** 每格额外的 class（阵营色之类） */
  extraClass?: (x: number, y: number) => string;
}

/**
 * 把网格画进一个元素。
 *
 * 正方形的保证只有一条：容器宽高比 = w/h，格子按 1fr 均分。
 * 和对局棋盘（`fitBoardBox`）同源——那边踩过的"格子变长方形"这里不能再踩一次。
 */
export function renderLevelGrid(el: HTMLElement, o: RenderOptions): void {
  const { w, h } = o;
  el.style.aspectRatio = `${w} / ${h}`;
  el.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
  el.style.gridTemplateRows = `repeat(${h}, 1fr)`;
  el.style.setProperty('font-size', `${Math.max(9, Math.min(16, Math.round(360 / Math.max(w, h))))}px`);

  const parts: string[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const hit = o.cityAt?.(x, y) ?? null;
      const terrain = cellTone(o.grid, o.cityAt, x, y);
      const label = hit && hit.origin.x === x && hit.origin.y === y ? (o.cityLabel?.(hit) ?? hit.seat) : '';
      const extra = o.extraClass?.(x, y) ?? '';
      const over = o.overlay?.(x, y) ?? '';
      parts.push(
        `<div class="tile t-${terrain} ${extra}" data-x="${x}" data-y="${y}" title="${x}, ${y}">${label}${over}</div>`,
      );
    }
  }
  el.innerHTML = parts.join('');
}

/** 拖拽框选一块矩形区域。事件选区和胜负条件（护送点）都要用它 */
export interface ZoneDragOptions {
  /** 什么时候允许拖（比如"只有点了选区域之后"）。省略 = 一直允许 */
  enabled?: () => boolean;
  /** 拖拽过程中的预览，松手前会一直回调 */
  onUpdate?: (zone: import('../core/level.ts').LevelZone | null) => void;
  onCommit: (zone: import('../core/level.ts').LevelZone) => void;
}

/**
 * 给一块网格绑上"拖一个矩形"的手势。
 *
 * 抽出来的原因：事件表单的选区和胜负条件的护送区是同一件事。
 * 各写一份的话，早晚出现"事件里拖出来是 3×2，胜负里拖出来是 2×3"这种鬼问题。
 */
export function bindZoneDrag(el: HTMLElement, o: ZoneDragOptions): void {
  let anchor: { x: number; y: number } | null = null;
  let now: { x: number; y: number } | null = null;

  const zoneOf = (): import('../core/level.ts').LevelZone | null => {
    if (!anchor || !now) return null;
    return {
      x0: Math.min(anchor.x, now.x),
      y0: Math.min(anchor.y, now.y),
      x1: Math.max(anchor.x, now.x),
      y1: Math.max(anchor.y, now.y),
    };
  };

  el.addEventListener('pointerdown', (ev) => {
    if (o.enabled && !o.enabled()) return;
    const cell = cellFromEvent(ev, el);
    if (!cell) return;
    ev.preventDefault();
    anchor = cell;
    now = cell;
    o.onUpdate?.(zoneOf());
  });

  el.addEventListener('pointermove', (ev) => {
    if (!anchor) return;
    const cell = cellFromEvent(ev, el);
    if (!cell) return;
    now = cell;
    o.onUpdate?.(zoneOf());
  });

  const finish = (): void => {
    if (!anchor) return;
    const zone = zoneOf() ?? { x0: anchor.x, y0: anchor.y, x1: anchor.x, y1: anchor.y };
    anchor = null;
    now = null;
    o.onCommit(zone);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

/** 从鼠标/指针事件里取出格子坐标（点在格子外面返回 null） */
export function cellFromEvent(ev: Event, root: HTMLElement): { x: number; y: number } | null {
  const target = ev.target as HTMLElement | null;
  const cell = target?.closest<HTMLElement>('[data-x]');
  if (!cell || !root.contains(cell)) return null;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}
