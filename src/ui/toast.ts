/**
 * 轻提示：屏幕下方浮一行字，2.2 秒自己走。
 *
 * 为什么单独一个文件：`main.ts` 里原本有个同名函数，只有它能用；而编辑器、
 * 面板这些"存完就该说一声"的地方都在 `ui/` 下，反向 import `main.ts` 是循环依赖。
 * 挪出来之后两边用的是同一个实现，样式也还是那一条 `.toast`。
 *
 * 什么时候该用它：**动作完成、结果不在视线里**（存到另一个页面去了、复制到剪贴板了）。
 * 结果就在原地能看见的（比如列表里多了一行）不要再用它，两处提示会互相打架。
 */
export function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2200);
}
