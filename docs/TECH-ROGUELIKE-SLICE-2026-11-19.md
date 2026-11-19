# 肉鸽模式 · 垂直切片技术方案（2026-11-19）

> 目标：用最小侵入跑通「3 场战斗 + 1 次整备 + 1 次三选一 + 1 次路线选择」，
> 约 10 分钟体验，用来判断循环成不成立。
>
> **硬约束：不改 `rules.ts` 的战斗结算、不改 AI、不动平衡数值。**
> 所有新概念都放在“一层包装”里——`applyAction` 外面套 runner，`createMatch` 外面套编译器。

---

## 0. 本切片包含 / 不包含

| 包含 | 不包含 |
|---|---|
| Run 状态与存档（可随时退出，重开无限制） | 随机遭遇生成器 |
| 3 场手写战斗（无城敌人 / 带营地 / 带遗物守门人） | 宝箱、护送事件 |
| 撤离阶段（敌人全灭 → N 手 → 入城结算） | 敌方给城的精英（留到下一版） |
| 兵额（= 城容量）与进城判定 | 局外解锁 |
| 战后三选一（含「不选拿钱」） | 完整遗物表 |
| 整备关三选一（城墙 / 修城 / 升级卡） | 多幕、Boss |
| 兵种卡重复升级（3 张合成 1 级） | 剧情 |

---

## 1. 模块布局（新增代码全部在新目录）

```
src/core/roguelike/
  run-state.ts       // 类型定义、存档/读档、版本迁移
  cards.ts           // 卡池、三选一抽取、重复计数 → 等级
  compile.ts         // 卡牌等级 → run 专用兵种表（注入 createMatch）
  rewards.ts         // 结算公式（纯函数，可单测）
  roster.ts          // 兵额、进城判定、抚恤折算
  stages.ts          // 3 场手写遭遇（全是 LevelDef，可直接用编辑器打开改）

src/ui/roguelike/
  run-screen.ts      // 路线 / 节点（战斗 / 整备 / 结算）
  reward-screen.ts   // 战后三选一、整备三选一
  runner.ts          // 包装一轮战斗：撤离阶段、结束判定、结算入账
```

**为什么不塞进 `main.ts`**：`main.ts` 已经一万多行，肉鸽是并行的第二套“对局外壳”，
塞进去会和标题页/房间/战役的流程互相纠缠。runner 只做一件事：拿一份 `LevelDef`
→ 用现成的 `createMatch` 开一局 → 每步 `applyAction` 后看一眼阶段 → 结束时报账。

---

## 2. 数据结构

```ts
// src/core/roguelike/run-state.ts
export interface RunState {
  v: 1;                     // 存档版本，改结构时迁移
  seed: number;             // 本 run 的种子（路线/抽卡都从它派生）
  gold: number;
  act: number;              // 当前幕（切片固定 1）
  node: number;             // 当前节点序号
  totalStages: number;      // 切片为 3
  roster: RosterUnit[];     // 带进下一关的兵（含 HP）
  relics: string[];         // 遗物 id
  cards: Record<string, number>;  // 兵种卡 → 已抽到张数（3 张 = 1 级）
  path: StageRef[];         // 已走过的节点
  allowRestart: boolean;    // 开局选“是否允许重开本关”
  restartsUsed: number;
  stagePhase?: 'battle' | 'evac';  // 当前战斗处于哪一段
  evacLeft?: number;               // 撤离剩余手数
}

export interface RosterUnit {
  type: string;   // UnitTypeDef.id
  hp: number;     // 跨关保留
  cardLv: number; // 抽卡时定下来，等于该兵的成长等级
}
```

存档：`localStorage['warchess:run:v1']`，**每个节点切换时落盘**（进战斗前、结算后、整备后）。
随时退出 = 直接关页面；下次进肉鸽入口读档续上。重开本关 = 重放当前 `StageRef`，
清空本关战果，`restartsUsed += 1`（是否限制由开局的 `allowRestart` 决定）。

---

## 3. 兵种卡升级：不改规则的做法

**关键点：`createMatch` 本来就接受一份“本局兵种表”**（`loadCustomUnits()` 就是它的来源）。
所以卡牌等级不需要碰 `computeDamage`：

```ts
// src/core/roguelike/compile.ts
export function compileUnits(cards: Record<string, number>): Record<string, UnitTypeDef> {
  const out: Record<string, UnitTypeDef> = {};
  for (const [id, n] of Object.entries(cards)) {
    const lv = Math.floor(n / 3);          // 3 张 = 1 级
    if (lv <= 0) continue;
    const base = UNIT_TYPES[id];
    if (!base) continue;
    out[id] = {
      ...base,
      atk: base.atk + lv,                  // 每级 +1 攻（数值待校准）
      maxHp: base.maxHp + lv * 2,          // 每级 +2 血
    };
  }
  return out;
}
```

- 战斗时：`createMatch(config, seed, { ...loadCustomUnits(), ...compileUnits(run.cards) })`；
- 面板上兵种会显示提升后的数值，玩家看得见，规则层一个字没动；
- 危险点：`atk` 被 buff 后会影响 AI 估值——这是**预期**的（更强的兵本来就该被更看重），
  但要在切片里量一次 `probe:agreement`，确认动作没炸。

---

## 4. 撤离阶段：runner 里的状态机

```
battle ──(敌方单位数 == 0)──▶ evac(left = N) ──(END_TURN 递减到 0)──▶ settle
                                      │
                                      └─ 玩家把兵挪进城内（普通 MOVEs）
```

判定全部在 runner 里，`rules.ts` 不新增任何字段：

```ts
// src/ui/roguelike/runner.ts（伪代码）
let phase: 'battle' | 'evac' = 'battle';
let left = 0;

function afterAction(prev: GameState, next: GameState): void {
  if (phase === 'battle' && foesOf(next).length === 0 && !next.winner) {
    phase = 'evac';
    left = evacTurnsFor(stage);      // 普通 2 / Boss 1 / 任务 3
    toast(`敌人清空，${left} 手撤离时间`);
  } else if (phase === 'evac' && next.turn !== prev.turn) {
    left -= 1;
    if (left <= 0) settle();          // 结束本关，进城结算
  }
}
```

- **进城判定**复用 `cityTiles(city)`：单位坐标落在城内格即算进城；
- 兵额上限 = 城内格数（2×2 = 4），超过的按身价 50% 折金；
- `settle()` 产出：`{ taken: RosterUnit[], left: RosterUnit[], gold }` → 写回 `RunState`。

---

## 5. 结算公式（纯函数，先单测）

```ts
// src/core/roguelike/rewards.ts
export function settleGold(input: {
  stageIndex: number;
  taken: number;
  turnsSaved: number;   // 相对该关的“期望手数”
  campDestroyed: boolean;
  halfDone: boolean;    // 未清场就认输
}): number
```

常数集中在一处、带注释，**改数不用改逻辑**。切片阶段先按设计稿的占位值跑。

---

## 6. 整备关（不进棋盘）

整备关是**纯 UI 节点**，不开对局：

| 选项 | 效果 | 约束 |
|---|---|---|
| 加固城墙 | `wallProgress += 1`；累计 2 次 → 城市边长 +1（兵额 4 → 9） | 每次整备只能选一次 |
| 修城 | 城市 HP 回满 | 城没掉血时禁用 |
| 升级兵种卡 | 指定一张卡 +1 张（凑满 3 张即升级） | 需要至少有一张卡 |

- 城墙状态就是 `RunState.wallProgress` + `config` 里的城市边长，建战斗时套进 `createMatch`；
- 没有棋盘 → 不需要新规则，只需要一个新面板。

---

## 7. 开局选项：是否允许重开

肉鸽入口的第一步（新 run 界面）：

```
[ ] 允许重开本关（勾掉 = 硬核）
开局兵额 / 起始遗物：按局外进度解锁（切片里固定）
```

`allowRestart = false` 时，`重开` 按钮不出现；这是**难度选项**，不是隐藏规则。

---

## 8. 与现有入口的接线（要改的既有文件，只有 3 处）

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/main.ts` | 标题页加一个「肉鸽」按钮 → `openRunScreen()`；战斗时用 `runner` 代替 `newGameFlow` 的建局 | +30 行 |
| `src/core/setup.ts` | 无（只通过 `createMatch(config, seed, units)` 复用） | 0 |
| `src/core/rules.ts` | 无（撤离阶段在 runner 里判） | 0 |

> 若后续要把撤离阶段做进联机/回放，才需要把它下沉进 rules——**切片阶段不做**，
> 因为一旦进规则内核，就要重跑 956 项测试和一致率探针。

---

## 9. 任务拆分（按可验证的中间态排）

| # | 任务 | 验证方式 |
|---|---|---|
| 1 | `run-state.ts` + 存档/读档 + 版本迁移 | 单测：写→读→字段一致；改版本号能迁移 |
| 2 | `compile.ts`（卡→兵种表） | 单测：3 张卡 → atk +1；0 张不变 |
| 3 | `rewards.ts` 结算 | 单测：公式各分支（含败退三成） |
| 4 | `roster.ts` 兵额/进城/抚恤 | 单测：5 人抢 4 格 → 1 人折半 |
| 5 | `stages.ts` 3 场手写遭遇 | 用关卡校验跑一遍（`validateLevel` 无错） |
| 6 | `runner.ts` 撤离状态机 | 无头冒烟：清场 → 2 手 → settle 写入 RunState |
| 7 | `run-screen` + `reward-screen` | 手动跑通 3 关；截图存档 |
| 8 | 入口接线（标题页按钮） | 从标题进得去、退得出来、刷新能续 |

前 5 项是纯逻辑、可单测，**一天内能全部绿**；6~8 是接线和 UI。

---

## 10. 验收标准

- 3 关走通，总时长 8~12 分钟；
- 单场行动次数 ≤ 12（含撤离）；
- 刷新浏览器后能从上次节点续上；
- `npm run test:rules` 仍 956 项全绿（说明规则内核没被碰）；
- 一致率探针与改动前一致（说明 AI 没被卡牌数值打歪）。

---

## 11. 切片之后才考虑的事

1. 随机遭遇生成器（按幕/主题抽兵种 + 摆位）；
2. 宝箱、护送事件；
3. 敌方给城的精英 / Boss（需要“占领敌方城”这条规则，动内核）；
4. 局外解锁；
5. 把撤离阶段下沉进 `rules`（如果将来要联机/回放支持）。
