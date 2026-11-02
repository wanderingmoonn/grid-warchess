# 飞行的分类统一 + 掉血动画只播一次

2026-11-02 · 规则判据收敛到一处、动画从 CSS 类换成 Web Animations

---

## 一、为什么会出现"`flight: true` 却不是空中层"

查下来，**数据本身是干净的**：扩展到齐（280 个兵种）扫一遍，
34 个 `flight: true` 的单位全部写了 `layer: 'air'`，反向也没有"在空中层却没写 flight"的。
问题出在**规则允许这种状态存在**——同一个概念有三种写法，而判定只认其中两种：

| 写法 | 出处 | 旧判定 |
|---|---|---|
| `layer: 'air'` | 现在的标准写法 | ✅ `airLayer()` 认 |
| `flight: true` | 早期只有"能过水"一个字段，还没有"层"的概念 | ❌ `airLayer()` **不认** |
| 能力 `fly-over`（掠空） | 老数据 / 兵种编辑器 | ✅ 认（`hooks.airLayer`） |
| 能力 `fly`（飞行）、`leap`（跳跃） | 只给"过水"，本来就不该进空中层 | —（正确） |

也就是说：只要谁写了 `flight: true` 而漏了 `layer: 'air'`，就会掉进一个没人负责的缝里——
这个兵**能飞过河、却按地面兵算**：占地面格、被地面近战当普通单位打、
选卡面板上还标着"飞行"。当时数据里恰好一个都没有，所以没人报障；
但规则留着这条缝，下一个写兵种的人就会踩进去。

**成因**一句话：`flight` 最初是"行进"字段，`layer` 是后来的"分层"字段，
两者描述的是同一件事却各说各话，而 `airLayer()` 只读了其中一个。

### 改法

```ts
// rules.ts
export function airLayer(def: UnitTypeDef): boolean {
  return def.layer === 'air' || def.flight === true || hasFlag(def, 'airLayer');
}

function crossesWater(def: UnitTypeDef): boolean {
  return airLayer(def) || hasFlag(def, 'crossesWater');
}
```

- **会飞就是空中层**：`flight: true` 直接并进 `airLayer()`，这条缝从规则上封死。
- 想表达"能过水但仍在地面"（蜘蛛骑士那一跃），只能用能力（`leap` / `fly` 的
  `crossesWater` 钩子），**不能用 `flight` 字段**——这条写进了注释。
- `crossesWater` 改成从 `airLayer` 派生，避免"空中层却过不了水"的反向矛盾。
- 选卡面板的标签跟着收敛：以前同一个能力有「掠空 / 空中 / 飞行」三个名字，
  现在空中层一律叫「空中」，只掠水的地面兵叫「掠水」。

### 守卫

`test-rules` 新增一条全兵种扫描（扩展全开 280 个）：
`flight` ⇔ 空中层，两个方向都断言，并要求至少存在一个 `leap` 单位当对照。
以后再有人写漏 `layer`，测试会直接红。

---

## 二、掉血动画为什么还在重复播放

上一版堵的是**我们自己的调用次数**：由调用方在动作前后对账，
只把"这一下真掉了血的单位"交给棋盘，不再让棋盘自己猜。
但病根不在调用次数，在**浏览器**：

`paintUnits` 为了对齐 DOM 顺序会调 `insertBefore`。一个节点从父节点上摘下再插回去时，
浏览器会把**正在跑的 CSS 动画从头再来一遍**。而顺序变化最常发生在"这一下有单位死了"
的那一帧——正好和掉血同一帧。于是橙条先播一遍，随着节点前移又播一遍。
上一版的对账逻辑对此无能为力：它只保证"这一次动作只传一次"，管不了浏览器自己重播。

### 改法

1. 残留血条从 **CSS 类动画**换成 **Web Animations**（`element.animate()`）：
   脚本动画挂在元素上，重新插入 DOM 不会重播。
   关键帧和曲线与原来一模一样（0~40% 停在旧宽度、82% 追上、最后淡出）。
2. 加 `dataset.chipAt` 记号（和打击抖动用的是同一套 `paintStamp`）：
   同一次绘制里即使写了两遍节点，也只演一遍。
3. 没有 `animate` 的老环境退回原来的 CSS 类——能动就行，只是仍有重播的可能。

打击抖动（`.unit` 左右震）本来就走 Web Animations + `paintStamp`，不受影响。

---

## 改动范围

| 文件 | 改动 |
|---|---|
| `src/core/rules.ts` | `airLayer()` 认 `flight`；`crossesWater()` 从 `airLayer` 派生 |
| `src/ui/draft-panel.ts` | 空中标签收敛成「空中 / 掠水」两种 |
| `src/ui/board.ts` | 新增 `playChip()`（WAAPI + 旧环境兜底）；`writeUnitNode` 加 `chipAt` 记号 |
| `scripts/test-rules.ts` | 守卫用例（全兵种扫描）+ 把"掠水爬不了山"的对照改成 `leap` 单位 |
| `scripts/smoke-dom.ts` | 掉血动画调用次数用例（含 DOM 重排、`animate` 缺失的兜底路径） |

## 验证

| 项 | 结果 |
|---|---|
| 规则 `npm run test:rules` | **517 项**（+1 守卫）全绿 |
| 界面 `npm run test:ui` | **167 项**（+1 掉血动画）全绿 |
| AI 评估门槛 | 7 项通过 |
| `tsc --noEmit` | 干净 |

掉血用例断言四件事：
1. 一次扣血只调一次 `animate`，且起点是**掉血前**的宽度（不然等于没演）；
2. 同一笔掉血重绘（顶栏 / 缩放 / 轮询都会触发）不再演；
3. 有人倒下导致 DOM 重排，不再演第二遍；
4. 有 `animate` 时不退回 CSS 类；`animate` 缺失时用类兜底。

飞行侧的验证：全兵种扫描证明数据无冲突；`leap` 单位仍"能过水、爬不了山"，
空中层仍"深水与高山都过得去、也停得下"（上一条改动留下的用例）。
