/**
 * 「战报要不要自动展开」这一条判断。
 *
 * 抽出来单独放，是因为它是这一块里**唯一有分支**的逻辑（数变化 / 复盘不展开），
 * 而它又活在 `main.ts` 的模块状态里——那份状态依赖整个界面，测试加载不动。
 * 把判断提成纯函数，测试就能直接盯住它，不用在 jsdom 里搭一局棋。
 */
export function shouldExpandLog(prevFired: number, nextFired: number, replay: boolean): boolean {
  // 复盘：翻到某一手时不该突然把面板撑开——那是回放，不是"有事发生"
  if (replay) return false;
  /*
   * `prevFired` 为 -1 表示还没建立基线（刚进这一局）。此时判的是"有没有事件"，
   * 不是"变多了没有"——开局那一两条事件在建局时就已经触发完，等不到下一次变化，
   * 但仍然该被看见。
   */
  if (prevFired < 0) return nextFired > 0;
  return nextFired > prevFired;
}
