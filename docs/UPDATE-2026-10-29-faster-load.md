# 更新公告 · 2026-10-29 · 首屏从四十多个请求降到三个

> 一句话：线上不再跑 vite 开发服务器，改成直接发构建产物——gzip 后一个 JS、一个 CSS、
> 一个 HTML，第一次打开一秒多就能落子。

---

## 一、以前为什么慢

线上的发布链路是把**源码**上传、在沙箱里跑 `vite dev`，浏览器访问到的就是开发服务器。
开发服务器不打包：它按 `import` 图**一个模块一个请求**地给你，本项目是 40 多个。
每个请求都要过一次反代，实测单个模块 0.5~0.8 秒，而且依赖链是串行的——
`main.ts` 里的 import 要到手才知道下一层要什么，于是首屏等于把延迟乘了好几遍。

更糟的是 `vite dev` 还带一个 HMR 的 WebSocket，在经过反代时经常连不上、反复重试。

一句话：**打包这件事被推迟到了每个访客的浏览器上**，而每个访客又只打开一次。

## 二、现在什么样

| | 以前 | 现在 |
|---|---|---|
| 请求数 | 40+（逐个模块） | 3（HTML + JS + CSS） |
| JS 传输 | 每个模块单独取，共约 1.1 MB | 148 KB（gzip） |
| 服务端 | vite dev，按需编译 | node 静态服务器，几十毫秒起好 |
| 缓存 | 几乎没有 | 带哈希的产物 `immutable` 缓存一年 |
| 复访 | 重新走一遍模块图 | HTML 304，JS/CSS 直接命中本地缓存 |

实测（同一台机器、同一个反代）：

```
index.html          0.59s   2.2KB
assets/index.js     0.88s   148KB (gzip)
assets/index.css    0.5s    7.9KB (gzip)
```

## 三、具体改了什么

| 位置 | 改了什么 |
|---|---|
| `scripts/serve-static.mjs` | **新增**：只用 node 内置模块的静态服务器。gzip、`immutable` 缓存、ETag/304、单页应用回退（`?sharecode=…` 这类地址都能进首页）、`/__health` 健康检查 |
| `package.json` | 新增 `build:static`：`vite build --outDir _publish` |
| `index.html` | `#app` 里先放一个转圈占位，首帧渲染时被 `innerHTML` 整个换掉——白屏会让人以为站点坏了，刷新一次反而更慢 |
| `.gitignore` | `_publish/` 不进版本库（它是产物，能用 `npm run build:static` 重跑） |

发布流程变成：`npm run build:static` → 发布目录取 `_publish/` → 线上只跑
`node scripts/serve-static.mjs`，**不需要 `npm install`**（产物是自带依赖的单文件包）。

## 四、中间踩的坑（值得记）

第一次试的方案是 `startCmd: "vite build && vite preview"`——看着很省事，发布侧直接判
`SITES_START_FAILED`：沙箱冷启动时"构建 + 起服务"超过了它对端口的 60 秒等待。
所以构建必须留在本地，线上只做一件它擅长的事：**发文件**。

顺带一提，`vite preview` 的 `/assets/*.js` 只发 391KB 原文件（它虽然有 gzip 中间件，
但 `sirv` 的默认行为并不总压缩）；自己写服务器时 gzip 是显式的，实测 424KB → 148KB。

## 五、验证

- 线上：`index.html` 无 `/@vite/client`（确认已不是 dev）、JS/CSS 均 200 且
  `Content-Encoding: gzip`、`Cache-Control: public, immutable`、带 `If-None-Match` 复访返回 304。
- 线上 JS 下载后 `node --check` 通过（传输没有被截断），体积与本地产物一致。
- 本地：`tsc --noEmit`、`vite build` 通过；规则 355 / AI 26+7 / 冒烟 129 全过。

## 六、这次没做的

- **云 SDK 还在首屏包里**。`@tencent-ai/workbuddy-cloud-sdk` 经 `src/net/room.ts` 静态
  引入，联机和对局上报共用它，占了包里不小的一块。要再快就得把它改成动态 `import()`，
  但那会把 `cloudDatabase()` 变成异步、牵动一堆调用点——留给下一批。
- 棋盘首帧的绘制开销（`imperative` 的 DOM 层）是另一个话题，那一批已经压到中位 8.7ms。
