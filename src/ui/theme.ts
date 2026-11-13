/**
 * UI 主题开关（legacy / modern）。
 *
 * 为什么要有它：这次 UI 重构的第一条硬规矩是"随时能退回去"。退回去不能靠
 * 记得改代码，得靠一个**运行时开关**——出了问题按一下，界面就回到旧版，
 * 存档、对局、逻辑一概不动。
 *
 * 三层取值，优先级从高到低：
 *   1. URL 参数 `?ui=modern` —— 用来**对比**。开两个标签页，一个带参数一个不带，
 *      同一局同一回合对着看，这是最省事的 A/B；
 *   2. localStorage `warchess:ui` —— 记住"我更喜欢哪一套"；
 *   3. 默认 legacy。
 *
 * 为什么开关落在 `<html data-ui>` 而不是"两套样式表按条件加载"：
 *   · 单文件 CSS，切换只是改一个属性，没有重新加载样式的闪烁；
 *   · 新主题写在 `[data-ui='modern']` 块里，旧规则一个字不用动——
 *     回退就是删掉那个属性（或者删掉那个块）；
 *   · 也方便在控制台手动试：`document.documentElement.dataset.ui = 'modern'`。
 *
 * `data-motion` 是同一套思路的第二根轴："减少动态效果"是无障碍要求，
 * 和主题正交——modern + reduced 是合法组合。
 */

export type UiMode = 'legacy' | 'modern';
export type UiMotion = 'full' | 'reduced';

const MODE_KEY = 'warchess:ui';
const MOTION_KEY = 'warchess:motion';

const MODES: readonly UiMode[] = ['legacy', 'modern'];
const MOTIONS: readonly UiMotion[] = ['full', 'reduced'];

function fromUrl(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function fromStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // 隐私模式 / 禁用存储：读不到就当没设置，不要因为一个偏好把整页打断
    return null;
  }
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 当前该用哪一套（URL > localStorage > legacy） */
export function resolveUiMode(): UiMode {
  return pick(fromUrl('ui') ?? fromStore(MODE_KEY), MODES, 'legacy');
}

/** 当前该用哪一档动效（URL > localStorage > full） */
export function resolveUiMotion(): UiMotion {
  return pick(fromUrl('motion') ?? fromStore(MOTION_KEY), MOTIONS, 'full');
}

/**
 * 把主题落到 DOM 上。`root` / `mode` 可以显式传，测试就不用去伪造 location。
 */
export function applyUiTheme(opts: {
  root?: HTMLElement;
  mode?: UiMode;
  motion?: UiMotion;
} = {}): { mode: UiMode; motion: UiMotion } {
  const mode = opts.mode ?? resolveUiMode();
  const motion = opts.motion ?? resolveUiMotion();
  const root = opts.root ?? document.documentElement;
  root.dataset.ui = mode;
  root.dataset.motion = motion;
  return { mode, motion };
}

/**
 * 切换并记住。界面上的入口（设置页）以后调它；
 * 现在也能在控制台里用：`__ui('modern')`。
 */
export function setUiMode(mode: UiMode, root?: HTMLElement): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 存不下就算了，本次生效即可 */
  }
  applyUiTheme({ mode, root });
}

export function setUiMotion(motion: UiMotion, root?: HTMLElement): void {
  try {
    window.localStorage.setItem(MOTION_KEY, motion);
  } catch {
    /* 同上 */
  }
  applyUiTheme({ motion, root });
}

/**
 * 控制台快捷入口。**只在开发/对比时用**，所以不做成按钮：
 * 玩家看到两个"选皮肤"的选项只会困惑，等 modern 真的成熟了再进设置页。
 */
export function installUiConsole(root?: HTMLElement): void {
  (window as unknown as { __ui?: (m: UiMode) => void }).__ui = (m: UiMode) => {
    setUiMode(m, root);
  };
}
