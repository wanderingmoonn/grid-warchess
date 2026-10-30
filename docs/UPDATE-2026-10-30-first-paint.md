# 首屏再压一轮：430KB → 358KB，传输 173KB → 110KB

> 上一批把"一个畸形 URL 打死全服"修掉了，但线上延迟仍然抖。这一批只做一件事：
> **首屏要传的字节再少三分之一**，顺带把两块"首屏根本用不到"的代码挪出主包。

## 一、先看清主包里装了什么

用 esbuild 的 metafile 把主包拆开看（相对占比）：

| 模块 | 占比 | 首屏用得到吗 |
|---|---|---|
| `@tencent-ai/workbuddy-cloud-sdk` | 13.9% | **不**：联机房间与云端战报才用 |
| `core/rules.ts` | 10.8% | 要（走子、战斗、视野） |
| `main.ts` | 10.0% | 要（组装层） |
| `core/fantasy-packs.ts` | 7.3% | 要（开局面板要列兵种） |
| `ui/panel.ts` | 7.0% | 要（右侧面板） |
| `core/ai.ts` | 6.9% | **不**：开局只问"是不是 AI 在走" |
| `core/info.ts` | 3.7% | 要（地形/兵种说明） |
| `core/mapgen.ts` | 3.2% | 要（开局生成地图） |

前两项与 `ai.ts` 都不在首帧路径上，三项合计 **28%**。

## 二、动了三处

### 2.1 云 SDK 改成动态引入

`src/net/room.ts` 原来静态 `import { createWorkBuddyCloud }`，于是 71KB 的 SDK
被算进主包——尽管它只在"开联机房间 / 传云端战报"时才需要。

现在只留 `import type`，真正的创建放进 `cloudDatabase()`：

```ts
export async function cloudDatabase() {
  if (!client) {
    const { createWorkBuddyCloud: create } = await import('@tencent-ai/workbuddy-cloud-sdk');
    client = create({ ... });
  }
  return client.database;
}
```

**踩到的坑**：SDK 的查询对象是 thenable（`await query` 才拿到 `{ data, error }`），
而 Promise 的解析过程会把它当成"要返回的值"直接吃掉——

```ts
async function table() { return db.from(TABLE); }   // ❌ Promise<Queryish> 永远是查询结果
const { data } = await table().select('*');          //    .select 不见了
```

所以表入口改成返回一个普通对象 `{ q }`，调用方写 `(await table()).q.select(...)`。

### 2.2 AI 引擎拆成"元信息 + 引擎"

`core/ai.ts` 有 3466 行 / 35KB，装的是威胁图、换子价值、三套战术。首屏只需要
"这一方是不是 AI""难度叫什么"两个判断——但只要有一行 `import ... from './core/ai'`，
整个引擎就进主包。

于是新增 `core/ai-meta.ts`（7 个两行的函数与常量），`ai.ts` 反向 import 并继续对外
转发（老的引用与测试一行都不用改）。`main.ts` 在 `runAiTurn()` 开头才：

```ts
const engine = await aiEngine();   // 第一次真要它走子时才拉 38KB
```

AI 的第一步本来就被 `AI_SPEED_MS` 故意放慢了，这次加载藏在"它正在思考"里。

### 2.3 服务器改用 brotli

`serve-static.mjs` 现在按 `Accept-Encoding` 协商：br 优先，其次 gzip，认 `q=0`
（显式拒绝）与 `*`（通配）。压缩结果按 `size-mtime` 缓存，压一次发很多次；
br 直接上 11 档——静态文件只压一次，多花的 CPU 换每个访客都少付的字节。

## 三、结果

| | 之前 | 现在 |
|---|---|---|
| 主包 raw | 468 KB | 358 KB |
| 主包 gzip | 164 KB | 127 KB |
| 主包 br | — | **102 KB** |
| 样式 br | 8.4 KB（gzip） | 7.5 KB |
| **首屏合计传输** | **173 KB** | **110 KB（−36%）** |
| 首屏请求数 | 3 | 3（html / js / css） |
| 按需加载 | — | AI 13.4 KB、云 SDK 19.1 KB（br） |

两块懒加载块没有 `modulepreload`，确认不会被首屏顺带拉走。

## 四、没有做的（以及为什么）

- **把 CSS 内联进 HTML**：算过账——现在 CSS 与 JS 在第二轮并行取，内联只省"一个
  连接"，不省轮次；但 index.html 是 `no-cache`，内联会让每次回访都重下 7.5KB，
  而 CSS 文件本来是 `immutable` 缓存一年的。不划算。
- **拆开扩张包的数据表**（fantasy/era/naval/air 合计约 70KB）：开局面板的兵种
  选择器要列全部兵种，`createMatch` 也是同步构建 `unitTypes` 的。要拆就得把
  扩展注册表改成异步，收益 70KB 但会把"引擎里没有异步"这条线打断。
- **把整块游戏壳延后到"开始对局"**：首屏就是战场，没有独立启动页，拆了等于重写
  启动流程。

## 五、验证

- `npm test`：规则 410 / AI 26+7 / 界面 142 / 服务器 11，全绿；
- `scripts/smoke-room.ts` 打真实云端建了一个房间并抢座成功——这条同时证明
  **动态引入的云 SDK 在真机路径上是通的**（不是只有类型过）；
- 线上：`Content-Encoding: br`、主包 `102208 B`、`cache-control: immutable`；
  两块懒加载块单独 200，且首页里没有它们。

## 六、下一步还能做什么

首屏 110KB 里，`rules.ts`(55KB) + `main.ts`(51KB) + 兵种数据表(~70KB) 是大头。
再往下压要么动数据结构（兵种表分片加载），要么动启动流程（先给一个极轻的
标题页，点"开始"再加载战场）。两者都不是"顺手改一下"的量级，等下一次专门做。
