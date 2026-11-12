# 多图（地球 / 月球 / 以后的空间站）

2026-11-11 · 给"以后要加一张图"或"要写扩展"的人

---

## 一句话契约

> **改状态用 `state`，查格子用 `view`。**

`state.tiles` **永远是地球那一张**（地球没有并进 `s.boards`，原因见 `src/core/board.ts` 开头）。
所以 `api.tileAt(state, u.x, u.y)` 在地球上恰好对，在任何别的图上都是错的——而且**不会报错**。

---

## 三层现状

| 层 | 在哪 | 说明 |
|---|---|---|
| 数据 | `Unit.board?` / `City.board?` / `state.boards[id]` | 缺省即地球。地球的格子在 `state.w/h/tiles`，别的图在 `state.boards[id]` |
| 几何 | `boardOf` / `boardStateOf` / `idxOn` / `xyOn` / `tileAtOn` | 按图取宽高、格表、投影 |
| 闸门 | `doAttack` / `doSiege` / `canStrike` | **必须同图**。跨图的两个单位坐标再近也打不到 |

---

## 写扩展时用什么

在钩子里（`HookCtx` / `StrikeCtx` / `DeathCtx` / `KillCtx` / `TurnStartCtx` / `SkillCtx` /
`SkillPreviewCtx` / `SkillTargetCells`）都带一个 `view`：

```ts
// ✅ 查地形：按"这个单位"所在的那张图
const tile = c.api.tileOf(c.state, c.self);      // 或者 c.api.tileAt(c.view, x, y)

// ✅ 找空地 + 生成：一步做完，落点和出生点由同一个单位决定
c.api.spawnNear(c.state, c.owner, 'slimelet', c.self);

// ✅ 技能选点 / 范围：用 view 的宽高与格表
c.api.canStandAt(c.view, nx, ny, c.target.type);

// ❌ 这些默认指地球（多图下静默出错）
c.api.tileAt(c.state, c.self.x, c.self.y);
c.api.freeNeighbor(c.state, c.self, type);   // 找的是地球的邻格
c.api.spawn(c.state, owner, type, x, y);     // 不传 board 就生在地球
```

### 原语表

| 想干什么 | 用这个 |
|---|---|
| 单位脚下那格地形 | `api.tileOf(state, unit)` |
| 某个坐标的地形（已知哪张图） | `api.tileAt(view, x, y)` / `tileAtOn(state, board, x, y)` |
| 单位的投影视图 | `c.view` / `api.viewOf(state, unit)` / `boardStateOf` |
| 邻格找空地并生成 | `api.spawnNear(state, owner, type, near)` |
| 明确指定图的生成 | `api.spawn(state, owner, type, x, y, board)` |
| 坐标 → 格号 | `idxOn(state, board, x, y)`（地球之外**不要**用 `idx`） |
| 格号 → 坐标 | `xyOn(state, board, i)` |

---

## 加一张新图要做什么

1. 在扩展的 `onMatchStart` 里塞一张：`state.boards[id] = { id, kind, name, w, h, tiles }`；
2. 单位/城市带上 `board: id`（地球不用写）；
3. 没了。战斗、溅射、视野、走子、寻路、技能选点都按 `Unit.board` 自己推导。

**不需要**在规则里加分支。如果一个功能还需要"判断是不是月球"，先怀疑它写错了。

---

## 护栏（别让下一个人再踩一遍）

```bash
npm run lint:boards            # 已接进 npm test 的第一步
npm run lint:boards -- --update  # 确认这次新增的"地球口径"是合理的，压进基线
```

它盯着 `src/` 里 `state.tiles` / `idx(` / `tileAt(` / `inBounds(` / `xyOf(` / `unitAt(` /
`unitsAt(` 的出现次数，按文件存基线，**只能变少不能变多**。

真的只能在地球上的地方（桥、地雷、城市经济）就留在基线里；改好一处就顺手 `--update`
把基线压下去。当前基线：**40 个文件、271 处**。

---

## 已知边界（不是 bug，是还没做）

- **战况烈度（heat）只记地球**：它存的是格号，没带"图"这一维，硬记会和地球同号的格子串味。
  真要月面也显示，得先给 heat 加一维。
- **装卸只认地球**：月球上没有带 `hold` 的东西；真要接，把 `doLoad` 里的
  `inBounds` / `unitAt` / `blockedFor` 换成 `boardStateOf` 的投影即可。
- **攻城只在地球**：月球没有城。判定已经改成"必须同图"，等月面有城的时候直接就能用。
- **AI 不认识多图**：它只会在地球上活动（也不会登月）。

---

## 测试怎么写

`scripts/test-rules.ts` 里有两条可以直接抄：

- 「手搓一张第二张图」：不挂任何扩展，直接 `s.boards['test-b'] = {...}`，
  验走子 / 开火 / 溅射 / 威胁圈——证明不是月球特例；
- 「月面战斗」那组：验地形掩护按图取、溅射不串图、跨图打不到。

摆"两张图同坐标各一人"的用例**不要用 `place2`**：它按 (x,y) 去重，会把另一张图的人删掉。
直接 `s.units.push({ ..., board: 'moon' })`。
