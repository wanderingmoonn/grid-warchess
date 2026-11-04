# 特性字段设计：载具（carry）与产兵（produce）

**一句话**：一个兵种"能装别的单位"、"能造兵"，从今天起都是**写在它自己数据上的一行**，
规则层只读不猜、界面只读不算、规则书自动跟着变。

---

## 0. 为什么改

这两件事原来都是"散在三处"的：

| 能力 | 以前怎么表达 | 散在哪 |
|---|---|---|
| 装载 | `transport: true` + `capacity: N`；航母的机位另存一张 `DECK_SPECS` 常量表 | 兵种表、`naval-carrier.ts`、`rules.doLoad` 里硬写的"船装不了船 / 建筑搬不上船" |
| 产兵 | `barracks: true` 一个布尔 | 兵种表、`rules.doRecruit`、`ai.ts` 十来个 if、界面里的分支 |

后果是同一个：**想加一种载具或一座兵营，要改三四个文件**；改漏一处就是"面板说能、
点下去被拒"或"面板说有 4 个机位、实际收不下第二架"。而且这些差异表达不出来——
五档军营除了攻/甲/血之外完全一样，因为没有任何地方能写"这座营只出轻步兵"。

---

## 1. 载具特性 `carry`

### 1.1 字段

```ts
carry?: {
  hold?: { max: number; allow?: CarryAllow };        // 货舱：陆军装进来，从棋盘上摘掉
  deck?: { max: number; launchRange: number; allow?: CarryAllow };  // 甲板：战机停驻，能起飞
}
```

两个槽位**互相独立**：渡船只填 `hold`，航母只填 `deck`，两栖攻击舰两个都填。

### 1.2 为什么拆成两个槽位

它们的"装"根本不是一回事：

| | 货舱 hold | 甲板 deck |
|---|---|---|
| 装进去之后 | 从 `state.units` 摘走，棋盘上不存在 | 仍是单位，存成 `custom.airwing` 记录 |
| 途中能否作战 | 不能 | 能，随时起飞 |
| 沉船/沉舰 | 舱里的人一起没 | 甲板上的飞机一起没 |
| 谁说了算 | 船的数据 | 船给机位，能不能起降由空军扩展的 `canBoard` 判 |

用一个 `capacity` 数字承担两种语义，就只能靠规则层猜——这正是要消灭的东西。

### 1.3 准入 `CarryAllow`

```ts
allow?: {
  types?: string[];        // 白名单：只认这些兵种 id
  categories?: UnitCategory[];  // 战斗 / 经济 / 建造 / 建筑
  domains?: UnitDomain[];  // land / water
  layers?: UnitLayer[];    // ground / air
  except?: string[];       // 黑名单：从上面的池子里再抠掉
}
```

条件之间是**与**，全空 = 不设限。写几个满足几个。
`hold` 的缺省准入是 `{ domains: ['land'], categories: ['combat','economy','builder'] }`
（船装不了船、建筑搬不进舱——这两条是物理上说不通的部分，其余都是设计选择，
应该由具体兵种自己声明）。

### 1.4 适用的兵种（当前 8 艘载具 + 4 个甲板）

| 兵种 | 数据 | 说明 |
|---|---|---|
| 渡船 ferry | `hold: { max: 2 }` | 最基础的过河工具 |
| 齿轮帆船 med_cog | `hold: { max: 3 }` | 铁器唯一能运兵的船 |
| 卡拉克帆船 nv_carrack | `hold: { max: 4 }` | |
| 盖伦帆船 nv_galleon | `hold: { max: 3 }` | |
| 运输舰 nv_transport | `hold: { max: 5 }` | 纯运，不还手 |
| 两栖攻击舰 nv_amphib | `hold: { max: 4 }, deck: { max: 2, launchRange: 1 }` | 两种装法并存 |
| 舰队航母 nv_carrier | `deck: { max: 4, launchRange: 2 }` | 没有货舱 |
| 轻型航母 nv_light_carrier | `deck: { max: 2, launchRange: 1 }` | |
| 航空战列舰 nv_aviation_battleship | `deck: { max: 1, launchRange: 1 }` | |
| 运输机 af_transport | `hold: { max: 2 }` | 空运，落点判定和船同一条 |
| 重型运输机 af_heavy_transport | `hold: { max: 4 }` | |

### 1.5 谁在读它

| 位置 | 读什么 |
|---|---|
| `core/carry.ts` | 唯一的判定实现：`carryOf` / `canHold` / `holdRoom` / `allowPass` |
| `rules.doLoad` | `holdOf` 判有没有货舱、`canHold` 判身份、`holdRoom` 判还装得下几个 |
| `rules.doUnload` | `holdOf` 判这是不是载具 |
| `naval-carrier.ts` | `deckSpecOf(def)` 从 `carry.deck` 取机位与起飞半径，`DECK_SPECS` 常量表已删除 |
| `ai.ts` | `hasHold` 决定要不要生成装载/卸载候选、值不值得买船 |
| `ui/panel.ts` | 货舱面板的 `x / max` 直接读 `hold.max` |
| `core/info.ts` | 属性卡："货舱：能把贴身的〔陆上单位〕装进来，最多 2 个" |
| `scripts/build-manual.ts` | 特性列显示「装载 2」「甲板 4」 |

---

## 2. 产兵能力 `produce`

### 2.1 字段

```ts
produce?: {
  units?: string[];     // 白名单：只造这些兵种 id；不写 = 按时代与城市供给放开
  everyTurns?: number;  // 生产间隔：每几回合一个（默认 1 = 当回合成型）
  costScale?: number;   // 造价倍率（默认 1）。0.9 = 便宜一成
  pop?: number;         // 这座营自己占几格编制（默认 0，建筑不占编制）
}
```

只写 `produce: {}` 也成立，意思就是"这是一座产兵点"——这正是老 `barracks: true` 的全部含义。

### 2.2 各字段怎么被用

| 字段 | 读它的地方 | 行为 |
|---|---|---|
| `units` | `canProduce()` → `rules.doRecruit`、`ui/panel.ts` | 名单外的兵：规则层拒绝，面板里根本不会列出来（两边同一个判据，不会"面板能点、点了被拒"） |
| `everyTurns` | `produceCooldownLeft()` → `rules.doRecruit` | 产完在 `Unit.custom.lastProduceTurn` 记一笔；没满 N 回合就拒绝，并说清还要几回合 |
| `costScale` | `scaleCost()` → `rules.doRecruit` | 造价是**资源包**（金币/粮食/建材），逐个资源乘完再四舍五入，不压成单一金币数 |
| `pop` | `producePop()` → `rules.armySize` | 编制统计里按建筑的 pop 计数；AI 的 24 人上限因此会把它算进去 |

生产间隔记在**单位身上**（`custom.lastProduceTurn`）而不是全局表：存档、联机快照、
读档全都自动跟着走，不需要额外同步。

### 2.3 当前七座产兵点的数据

| 建筑 | 数据 | 说明 |
|---|---|---|
| 军营 camp / 寨垒 camp2 / 堡寨 camp3 / 兵站 camp4 | `{}` | 全默认：不设白名单、当回合成型、原价、不占编制 |
| 前进基地 camp5 | `{ costScale: 0.9 }` | 唯一做了产能差异的一档：前线自产自销，兵价九折 |
| 联合作战中心 camp6（现代扩展） | `{}` | 同默认 |

> 只有 camp5 改了一处**会影响手玩**的数字（九折）。AI 不从军营产兵
> （`ai.ts` 里没有任何 `campId` 用法），所以跑批口径不受影响；但如果你希望
> 这次只是结构改造、数值一点都不动，把 camp5 那行改回 `{}` 即可。

### 2.4 怎么加一座"不一样的兵营"

只改一行数据，规则 / 界面 / 规则书 / AI 全自动跟上：

```ts
// 只出轻步兵、两回合一批、便宜两成的前哨营
produce: { units: ['militia', 'archer', 'spearman'], everyTurns: 2, costScale: 0.8 },
```

不需要动 `doRecruit`，也不需要动面板——白名单一变，面板的产兵列表跟着变。

---

## 3. 老数据兼容

两个字段都保留旧的入口，且**只在一处翻译**：

```ts
carryOf(def)   // transport + capacity → { hold: { max: capacity } }
produceOf(def) // barracks: true      → {}
```

存档与联机快照里存的是**当时那份兵种表**，所以老档读进来不会"船突然不能载人、
营突然不产兵"。新写法优先：写了 `carry` / `produce` 就不回头看旧字段。

---

## 4. 验证

- `npx tsc --noEmit` 干净；
- 规则 **452** / AI 29 / 评估 7 / UI 153 / 服务 11 全绿；
- 新增 6 条用例：
  - 载具：`hold/deck` 两个槽位各管各的；`allow.layers` 能挡住空中单位；白名单只认名单内的兵
  - 载具：老存档的 `transport + capacity` 仍读得出 3 个舱位，且新写法优先
  - 载具：航母甲板来自兵种数据（`nv_carrier` 4/2、`nv_amphib` 同时有 4 舱位 + 2 机位、巡洋舰没有甲板）
  - 产兵：默认值、camp5 的 0.9、`barracks: true` 兼容
  - 产兵：改数据即可让一座营只认民兵（行为面），camp5 实收 90% 兵价（行为面）
  - 产兵：冷却按"上次产出回合"算，1/2/3 回合三档都对
- 规则书 9 册重生成：特性列出现「装载 2」「产兵（造价 90%）」。
