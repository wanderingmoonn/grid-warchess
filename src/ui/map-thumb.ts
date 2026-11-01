/**
 * 固定地图的缩略图。
 *
 * 用**内联 SVG 一格一个 rect**，不用 canvas：
 *   · canvas 要等 DOM 插进去之后再跑一遍绘制代码，开局面板每次重绘都得再补一次；
 *   · SVG 是纯字符串，跟着面板一起出现、一起消失，没有"第二遍绘制"这回事。
 * 代价是节点多（16×16 一张 256 个 rect）。实测五张图一起铺在一个弹窗里
 * 也就一千多个 rect，和一张棋盘差不多量级——比"缩略图糊成一团"划算。
 */

import type { FixedMap } from '../core/fixed-maps.ts';

/** 地形配色：和 style.css 里那套保持一致，缩略图才和进局后看到的是同一种绿 */
const COLOR: Record<string, string> = {
  '.': '#dfe9d3', // 平原
  f: '#aecb98', // 森林
  h: '#ddcba6', // 丘陵
  '~': '#a8cadf', // 水
  '^': '#c4ccd6', // 山
  '=': '#c9a878', // 桥
};

const TEAM_A = '#b8433a';
const TEAM_B = '#2f6ea8';

/**
 * 一张地图的缩略图（SVG 字符串）。
 *
 * @param cell 每格画多少个 SVG 单位。1 就够——`viewBox` 会缩放到 CSS 尺寸。
 * @param size 天了的城边长（默认 2），只影响画出来的方块大小。
 */
export function mapThumbSvg(map: FixedMap, citySize = 2): string {
  const cells: string[] = [];
  for (let y = 0; y < map.h; y += 1) {
    const row = map.rows[y] ?? '';
    for (let x = 0; x < map.w; x += 1) {
      const ch = row[x] ?? '.';
      const fill = COLOR[ch];
      if (!fill) continue; // 不认识的字符画成透明，让问题一眼看出来
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`);
    }
  }
  // 城：地图数据只存左上角，这里按边长画一个实心方块盖在地形上
  for (const [list, color] of [
    [map.citiesA, TEAM_A],
    [map.citiesB, TEAM_B],
  ] as const) {
    for (const c of list) {
      cells.push(
        `<rect x="${c.x}" y="${c.y}" width="${citySize}" height="${citySize}" fill="${color}" stroke="#2b2823" stroke-width="0.25"/>`,
      );
    }
  }
  return `<svg class="map-thumb" viewBox="0 0 ${map.w} ${map.h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${cells.join('')}</svg>`;
}
