/**
 * 「战报要不要因为某个事件自动展开」这一条判断。
 *
 * 规则只有一句话：**事件里写了 `say` 才展开**。
 *
 * 为什么不是"任何事件都展开"：`spawn` / `terrain` / `reveal` 这些动作很可能是
 * 设计意图上**不想让玩家知道**的——伏兵从雾里冒出来、桥悄悄塌了、地图某处
 * 亮了一下。把它们全抖到战报上，等于把暗手提前剧透。
 * 而写了 `say` 的，作者已经替这一关决定好了"这句话就是要给玩家看的"。
 *
 * 抽成纯函数是因为它活在 `main.ts` 的模块状态里（依赖整个界面），测试加载不动；
 * 提出来就能直接盯住"哪些 id 算新触发、哪些带 say"这两步。
 */
export function logEventSays(
  prevFired: ReadonlySet<string>,
  fired: readonly string[],
  hasSay: (id: string) => boolean,
): boolean {
  for (const id of fired) {
    // 已经触发过的（含 `repeat` 事件重复触发的）不再算"新"——只提示第一次，
    // 否则每回合都会弹一次，比不提示还烦
    if (prevFired.has(id)) continue;
    if (hasSay(id)) return true;
  }
  return false;
}
