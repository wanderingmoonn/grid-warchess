/**
 * 地形材质：和「棋子贴图」同级、但**独立**的一个开关。
 *
 * 为什么不共用一个开关：地形是背景、棋子是前景，两者要解决的观感问题不一样
 * （地形管"这是块什么地方"，棋子管"这是谁"）。玩家可能只想要其中一半，
 * 合在一起就只能全开或全关。
 *
 * 为什么关着时一个字节都不请求：图在 CSS 里，用 `html[data-terrain='on']`
 * 前缀才生效——关着的时候浏览器根本不会去取那几张 webp。
 *
 * 取景方式：每格按自己的 (x, y) 去同一张大图上取一块，所以同一种地形连成片时
 * 是**连续**的纹理，不是每格贴一张小图。这也是它比 CSS 画纹理强的地方。
 */

export type UiTerrain = 'on' | 'off';

const KEY = 'warchess:terrain';
let on = false;

function stored(): boolean | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function fromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('terrain');
  } catch {
    return null;
  }
}

function apply(): void {
  try {
    document.documentElement.dataset.terrain = on ? 'on' : 'off';
  } catch {
    /* 没有 document（测试环境）：忽略 */
  }
}

export function initTerrainArt(): void {
  const url = fromUrl();
  const raw = stored();
  on = url === 'on' ? true : url === 'off' ? false : (raw ?? false);
  apply();
}

export function uiTerrainOn(): boolean {
  return on;
}

export function setUiTerrain(v: boolean): void {
  on = v;
  apply();
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式：本次会话内仍然生效 */
  }
}
