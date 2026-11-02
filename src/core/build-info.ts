/**
 * 构建版本。
 *
 * 为什么值得单独一个文件：报告里要带版本号，而版本号的来源有三条互不相干的路径——
 *
 *   · 浏览器里（vite build）：`__APP_VERSION__` 被静态替换成 package.json 的 version；
 *   · 脚本里（node --experimental-strip-types 直接跑 .ts）：这个全局量根本不存在；
 *   · 万一哪天换构建工具，替换没配上，也不该让整页崩掉。
 *
 * 所以统一在这里兜一层。读不到就写 'dev'——**宁可写 dev，也不能写一个猜的版本号**：
 * 报告里的版本是用来"按版本切数据"的，一个错的版本比没有版本更坏。
 *
 * 为什么不用 git hash：发布产物是从 `_publish/` 发出去的，工作区里那笔提交
 * 和线上跑的东西没有可靠的对应关系（可以带着未提交的改动构建）。version 至少
 * 是个人工承诺的"这一版是什么"。
 */

export const BUILD_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
