/**
 * 单位贴图：一个**随时能关掉**的附加层。
 *
 * 背景：2026-11-11 试了用混元生成兵种美术，结论是"建筑和载具能看，人形在低分屏上糊"。
 * 这件事还没定论，所以做成开关而不是直接替换——关掉就完全回到原来的汉字方块，
 * 不需要改代码、不需要回滚版本。
 *
 * 三条设计约束：
 *   1. **默认关**。没验证过的东西不替玩家做主；而且现在只有 4 个兵种有图，
 *      默认开会让棋盘变成"一半图一半字"，那比全字更乱。
 *   2. **查不到就回退**。任何一步失败（清单没拉到、id 不在清单里、图加载失败）
 *      都退回汉字，绝不留空格子。
 *   3. **不猜路径**。靠 `manifest.json` 而不是"逐张试 404"——330 个兵种会刷出
 *      330 条红字，把真问题淹掉。
 *
 * 开关落在 `<html data-art>`，和主题（`data-ui`）、动效（`data-motion`）同一套思路：
 * 切换只是改一个属性，不重新加载样式，也不碰存档与对局。
 */

export type UiArt = 'on' | 'off';

const ART_KEY = 'warchess:art';
const MANIFEST = 'art/units/manifest.json';
const BASE = 'art/units';

/** 有图的兵种 id。null = 还没拉到清单（这一帧先走汉字） */
let available: Set<string> | null = null;
let artOn = false;
let loading: Promise<void> | null = null;

function readStored(): boolean | null {
  try {
    const raw = localStorage.getItem(ART_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

/** URL 上带 `?art=on` 强制打开：和主题的 `?ui=modern` 一样，用来做 A/B 对比 */
function fromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('art');
  } catch {
    return null;
  }
}

export function initUnitArt(): void {
  const url = fromUrl();
  const stored = readStored();
  artOn = url === 'on' ? true : url === 'off' ? false : (stored ?? false);
  apply();
}

function apply(): void {
  try {
    document.documentElement.dataset.art = artOn ? 'on' : 'off';
  } catch {
    /* 没有 document（测试环境）：忽略，读的时候还有默认值兜着 */
  }
}

export function uiArtOn(): boolean {
  return artOn;
}

export function setUiArt(on: boolean): void {
  artOn = on;
  apply();
  try {
    localStorage.setItem(ART_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式下写不进去，本次会话内仍然生效 */
  }
}

/**
 * 拉清单。**只在开关打开时才拉**——关着的时候一个字节都不该多请求。
 *
 * 幂等：重复调用复用同一个 promise。
 */
export function loadUnitArtIndex(): Promise<void> {
  if (available || loading) return loading ?? Promise.resolve();
  loading = (async () => {
    try {
      const res = await fetch(MANIFEST, { cache: 'force-cache' });
      if (!res.ok) {
        available = new Set();
        return;
      }
      const data = (await res.json()) as { units?: unknown };
      const list = Array.isArray(data.units) ? data.units.filter((x): x is string => typeof x === 'string') : [];
      available = new Set(list);
    } catch {
      available = new Set();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 这个兵种有没有贴图。开关关着、或者清单还没到，一律返回 null */
export function unitArtUrl(typeId: string): string | null {
  if (!artOn || !available || !available.has(typeId)) return null;
  return `${BASE}/${typeId}.png`;
}

/** 给测试用：注入一份假清单，不用真去 fetch */
export function __setArtIndexForTest(ids: readonly string[] | null): void {
  available = ids === null ? null : new Set(ids);
}
