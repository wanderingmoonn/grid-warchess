/**
 * 肉鸽 2.0 的地址入口。
 *
 * 只在地址栏带 `?rogue`（或 `#rogue`）时才接管页面；平时到这里就结束了，
 * 一个模块都不多加载。这样加进来的风险最小：主对局的启动路径完全没变。
 *
 * 打开方式：
 *   · `npm run dev` 后访问 `/?rogue=1`；
 *   · 或者从标题页点「肉鸽 2.0」（那条直接走 `mount.ts` 的 openRogue2）。
 */
const params = new URLSearchParams(window.location.search);
const wantRogue = params.has('rogue') || window.location.hash === '#rogue';

if (wantRogue) {
  void import('./mount.ts').then((mod) => mod.openRogue2());
}
