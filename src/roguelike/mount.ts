/**
 * 肉鸽 2.0 的挂载点：**在主游戏页上开一层独立的全屏界面**。
 *
 * 两个入口共用它：
 *   · 标题页的「肉鸽 2.0」按钮（`ui/title-screen.ts` 里那一个 `data-title="rogue2"`）；
 *   · 地址栏 `?rogue=1`（方便直接发给别人试）。
 *
 * 它和官方那套「肉鸽（切片）」是**两套互不相干的东西**：
 * 那套是原版规则的线性切片（`src/core/roguelike/*`），这一套是 if 线的三层房间图。
 * 因此这里只做三件事：藏起主界面、挂自己的根节点、退出时回到标题——
 * 一不读写对方的存档，二不 import 对方任何模块。
 */
import './rogue.css';
import { bootRogue } from './app.ts';

/** 回到标题：整页重载到不带参数的地址，主程序自己会把首页画出来 */
function backToTitle(): void {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  window.location.href = url.toString();
}

/**
 * 全局快捷键闸门。
 *
 * 主程序在 window 上挂了几个快捷键（Alt+N 开新局、Escape 关面板）。我们只是**盖在**
 * 上面，并没有卸载它们——不拦的话，在肉鸽界面里按 Alt+N 会在背后开出一个开局面板。
 * 用捕获阶段拦掉这两个键：不 preventDefault，所以按钮的键盘激活不受影响。
 */
function keyGuard(e: KeyboardEvent): void {
  if (e.key === 'Escape') e.stopPropagation();
  else if (e.altKey && (e.code === 'KeyN' || (e.key ?? '').toLowerCase() === 'n')) e.stopPropagation();
}

export function openRogue2(): void {
  if (document.getElementById('rogue-root')) return; // 已经开着，别叠第二层
  const game = document.getElementById('app');
  if (game) game.style.display = 'none';

  /*
   * 首页是 `append` 到 body 上的，而且从地址进来时它可能比我们晚出现
   * （main.ts 的启动是异步的）。所以不能只删一次：挂个观察器，谁冒出来删谁。
   * 退出时必须把它撤掉——否则我们走了以后首页也会被一直删掉，游戏就没有门面了。
   */
  const killTitle = (): void => {
    document.querySelectorAll('.title-screen').forEach((el) => el.remove());
  };
  killTitle();
  const watcher = new MutationObserver(killTitle);
  watcher.observe(document.body, { childList: true });

  window.addEventListener('keydown', keyGuard, true);

  const root = document.createElement('div');
  root.id = 'rogue-root';
  const stage = document.createElement('div');
  stage.className = 'rg-stage';
  root.appendChild(stage);
  document.body.appendChild(root);

  bootRogue(stage, {
    onExit: () => {
      watcher.disconnect();
      window.removeEventListener('keydown', keyGuard, true);
      root.remove();
      const g = document.getElementById('app');
      if (g) g.style.display = '';
      backToTitle();
    },
  });
}
