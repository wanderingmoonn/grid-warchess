/**
 * 兵种价值模型：**一处口径，两处使用**。
 *
 * 为什么要单独一个文件：之前"这个兵值多少钱"有两把尺子——
 *   · 人填的 `cost`（拍脑袋 + 手调）；
 *   · AI 采购用的 `combatPower = 攻 × √血 × 射程系数`。
 * 第二把尺子只读三个数，于是**移速、视野、多段、能力全都不算钱**。
 * 结果就是上一轮那个怪现象：龙骑兵在实战里 95% 胜率的打法核心，
 * 而 AI 的采用率只有 1%——它不是"知道强却不买"，是它的尺子量不出来。
 *
 * 现在把这个模型抽出来：
 *   · `ai.ts` 的采购/攒钱/换血全用它；
 *   · `scripts/audit-stats.ts` 用同一份权重去反解现有造价、找失衡。
 * 两边同源，才不会出现"审计说它便宜、AI 说它贵"这种自相矛盾。
 *
 * 口径（每一项都有理由，别随手改）：
 *   · **多段打折**：`burst` 段各自减一次护甲，所以 n 段的收益不是 n 倍，
 *     按 `1 + 0.6 × (n − 1)` 折。3 段 = 2.2 倍而不是 3 倍。
 *   · **护甲**：`1 + armor × 0.05`。护甲是"每次挨打都生效"的乘法属性，
 *     但它有上限（高攻单位面前不值钱），所以给线性小系数而不是乘法暴涨。
 *   · **射程**：`1 + min(5, range−1) × 0.30`。射程的边际收益是递减的：
 *     1→2 是"能隔一格安全输出"，5→6 只是"再多一格"，但都能压住更多地形。
 *   · **移速**：`1 + max(0, move−2) × 0.15`。移 2 是基准（大部分兵）。
 *     移 5 = ×1.45——这是"能选在哪开战"的钱，也是龙骑兵真正贵的地方。
 *   · **视野**：`1 + clamp(vision−3, −2, 6) × 0.04`。迷雾下"看得见才打得着"，
 *     但它有全队共享，所以单兵视野不该像射程一样值钱，只给 4%/格。
 *   · **能力**：查表累加，封顶 0.6（一个兵最多靠能力加价 60%）。
 *     没录进表的能力按 0.05 兜底——宁可低估，也不要给冷门能力凭空抬价。
 */
import type { UnitTypeDef } from './types.ts';

/** 能力权重表：0.15 = 值 15% 的价钱 */
export const ABILITY_VALUE: Record<string, number> = {
  // 输出
  berserk: 0.15,
  charge: 0.12,
  'armor-pierce': 0.1,
  'first-strike': 0.08,
  lifesteal: 0.08,
  kite: 0.08,
  'qi-true-damage': 0.1,
  'poison-hit': 0.06,
  'burn-hit': 0.06,
  'elf-shot': 0.06,
  'kill-rush': 0.06,
  'slow-hit': 0.05,
  'curse-hit': 0.05,
  knockback: 0.05,
  // 生存
  'shield-wall': 0.12,
  'regenerate-plus': 0.1,
  regenerate: 0.08,
  'aoe-immune': 0.08,
  vanish: 0.08,
  stealth: 0.06,
  'af-stealth': 0.08,
  phase: 0.06,
  // 机动
  /*
   * 掠空 0.18：**必须比 `flight`（0.15）贵**，因为它严格包含飞行——
   * 掠空 = 掠水 + 林丘各 1 步（= 飞行）+ 空中层（能和地面单位共格、地面近战够不着）。
   * 同一个东西，加强版反而更便宜，是上一轮定价里最直白的一处自相矛盾。
   * 速攻时还要再高一截，见下面的 `ABILITY_TEMPO`。
   */
  'fly-over': 0.18,
  leap: 0.1,
  'forest-walk': 0.05,
  woodland: 0.05,
  tracker: 0.05,
  'slow-offroad': 0.04,
  // 支援 / 光环 / 召唤
  summoner: 0.14,
  'heal-aura': 0.12,
  'aura-command': 0.12,
  'aura-armor': 0.1,
  'aura-speed': 0.08,
  fear: 0.08,
  'curse-aura': 0.08,
  'hex-weak': 0.08,
  split: 0.1,
  'royal-decree': 0.06,
  purge: 0.05,
  repair: 0.05,
  // 攻城
  'siege-master': 0.15,
};

/**
 * 面板上的**特性字段**：它们不在 `abilities` 数组里，但和主动能力一样值钱。
 *
 * 漏掉这两个是审计里最明显的一处系统性低估：
 *   · `flight`（20 个兵）——飞越水/林/山，等于"没有地形能拦住它"，
 *     而且能直接贴后排。可只有少数兵把它写进了 `abilities: ['fly-over']`，
 *     于是其余飞兵在这把尺子上被当成"移速快一点的陆军"。
 *   · `splash`（34 个兵）——每次开火额外打一圈，按 50% 伤害算。
 *     半径 1 约等于输出 +5%，半径 3 约 +15%；再往上封顶（地图没那么挤）。
 * 效力对照：加上这两条之后，"模型说它便宜"的榜单里飞兵集体回落，
 * 龙骑兵的性价比从 5.03 抬到 5.9 左右（见 docs/BALANCE-2026-11-03-stats-audit.md）。
 */
const FLIGHT_VALUE = 0.15;
const SPLASH_PER_RADIUS = 0.05;
const SPLASH_CAP = 0.15;

/**
 * 能力与"局面"的相性：**同一个能力，速攻和龟缩不一定同价**。
 *
 * 移速已经按 `tempo` 在 0.65~1.35 之间摆了，但能力还是常数——于是
 * "掠空"（穿人堆贴后排）和"守护"（站桩减伤）在速攻时一个价、龟缩时也一个价。
 * 这张表只做一件事：给每条能力一个**随 tempo 倾斜的系数**，
 * `1 + tilt × tempo`（tempo ∈ [−1, 1]，于是在防守/均势/速攻下是 1−tilt、1、1+tilt）。
 *
 * 判据只有一条：**这条能力兑现的是"位置"还是"耐久"**。
 *   · 位置类（穿过去、先手、追击）——速攻时翻倍也不多，因为那时候你只有一两个回合
 *     把伤害落到后排；龟缩时几乎兑现不了。
 *   · 耐久类（回血、护甲光环、免溅射）——反过来，守城时才是它的主场。
 *   · 数值类（破甲、真伤）与局面无关，不进表。
 *
 * 幅度参考移速：移速 ±35%，能力这里给到 ±20%~±60%，因为能力的"兑现条件"
 * 比移速更极端——掠空在龟缩时不是"弱一点"，是**根本用不上**（你自己就在防线上，
 * 没有人堆要穿）。
 */
export const ABILITY_TEMPO: Record<string, number> = {
  // 位置类：速攻更值钱
  'fly-over': 0.6,
  charge: 0.5,
  leap: 0.4,
  kite: 0.4,
  'first-strike': 0.3,
  'kill-rush': 0.3,
  'slow-hit': 0.2,
  'siege-master': 0.3,
  // 耐久类：守更值钱
  'shield-wall': -0.4,
  'regenerate-plus': -0.3,
  regenerate: -0.3,
  'aoe-immune': -0.25,
  'heal-aura': -0.25,
  'aura-armor': -0.3,
  'hex-weak': -0.2,
};

/**
 * 这个兵种的能力总共值多少（0 ~ 0.6）。
 *
 * `ctx.tempo` 会按 `ABILITY_TEMPO` 调整每条能力的权重；不传就是均势。
 */
export function abilityValue(d: UnitTypeDef, ctx: ValueContext = NEUTRAL_CONTEXT): number {
  const tempo = Math.max(-1, Math.min(1, ctx.tempo ?? 0));
  let v = 0;
  for (const a of d.abilities ?? []) {
    const base = ABILITY_VALUE[a] ?? 0.05;
    v += base * (1 + (ABILITY_TEMPO[a] ?? 0) * tempo);
  }
  for (const _ of d.skills ?? []) v += 0.08; // 有技能表（主动技）也是钱
  // 飞行也是"位置类"：它兑现的是"能不能绕过地形贴上去"，速攻时更贵一点。
  if (d.flight) v += FLIGHT_VALUE * (1 + 0.35 * tempo);
  // 溅射兑现的是"对面挤不挤"，和速攻无关——它既可能发生在进攻，也可能发生在守城。
  if ((d.splash ?? 0) > 0) v += Math.min(SPLASH_CAP, (d.splash as number) * SPLASH_PER_RADIUS);
  return Math.min(0.6, v);
}

/**
 * 多段收益：n 段按 1 + 0.6(n−1) 折（每段各自减甲，不是 n 倍）
 */
export const burstFactor = (d: UnitTypeDef): number => 1 + 0.6 * (Math.max(1, d.burst ?? 1) - 1);

/**
 * 判断"这个兵此刻值多少钱"要看局面，不能只看面板。
 *
 * 同一张卡在两种局面下的价钱可以差三成：
 *   · **收缩防守**（`turtle`）：防线是固定的一座城，能站住比跑得快重要，
 *     移速只值平时的六成；反过来**看得远**更值钱（早一点发现绕后）。
 *   · **全军压上 / 换家**（`push` / `trade`）：这时候"能不能先手贴上后排"
 *     就是胜负本身，移速按 1.35 倍计价。
 *   · **视野**：己方已经有几双眼睛（侦察兵、飞机）时，再买一双眼睛的边际价值
 *     是下降的；迷雾关掉时更是几乎不值钱。
 */
export interface ValueContext {
  /** +1 = 全军压上 / 换家；0 = 均势；−1 = 收缩防守 */
  tempo?: number;
  /** 己方现有视野的冗余度 0~1（1 = 已经很开阔，新兵的视野不值钱） */
  visionCoverage?: number;
  /** 有没有迷雾（没开迷雾时视野基本只影响先手，不代表信息） */
  fog?: boolean;
}

/** 没有局面的默认口径：均势、视野中等、有迷雾 */
export const NEUTRAL_CONTEXT: ValueContext = { tempo: 0, visionCoverage: 0.4, fog: true };

/** 移速的权重：防守 0.65 → 均势 1 → 速攻 1.35 */
export const moveWeight = (ctx: ValueContext): number => 1 + 0.35 * Math.max(-1, Math.min(1, ctx.tempo ?? 0));

/**
 * 视野的权重：己方视野越足越低；没开迷雾时几乎只剩"先手"这一点价值。
 * 0 冗余 → 1.2；满冗余 → 0.3。
 */
export const visionWeight = (ctx: ValueContext): number => {
  const cov = Math.max(0, Math.min(1, ctx.visionCoverage ?? 0.4));
  return (0.3 + 0.9 * (1 - cov)) * (ctx.fog === false ? 0.25 : 1);
};

/** 射程系数：1 + min(5, range−1) × 0.30（射程跟局面无关，它是几何优势） */
export const rangeFactor = (range: number): number => 1 + Math.min(5, Math.max(0, range - 1)) * 0.3;

/** 移速系数：1 + max(0, move−2) × 0.15 × 局面权重 */
export const moveFactor = (move: number, ctx: ValueContext = NEUTRAL_CONTEXT): number =>
  1 + Math.max(0, move - 2) * 0.15 * moveWeight(ctx);

/** 视野系数：1 + clamp(vision−3, −2, 6) × 0.05 × 局面权重 */
export const visionFactor = (vision: number, ctx: ValueContext = NEUTRAL_CONTEXT): number =>
  1 + Math.max(-2, Math.min(6, vision - 3)) * 0.05 * visionWeight(ctx);

/** 护甲系数（只在"等效血"里用一次，别在别处重复乘） */
export const armorFactor = (armor: number): number => 1 + Math.max(0, armor) * 0.05;

/**
 * 基准靶子：5 甲、20 攻。
 *
 * "输出"按**打穿 5 甲之后**算，而不是打 0 甲——打 0 甲会把"高攻"重复计一次
 * （攻高本来就赚，再按 0 甲算就等于白送）。5 甲是 3 代前后的中位护甲。
 */
const BASE_ARMOR = 5;
const BASE_ATK = 20;

/**
 * 威胁谱：算"等效血"时假定会被谁打。
 *
 * 这里原来只有一个数 `20`，写成 `hp × 20 / max(1, 20 − armor)`。它在
 * **护甲 ≥ 19 时彻底失效**，而且失效方式很隐蔽（分母被 `max(1,…)` 兜住，
 * 所以不崩、不 NaN，只是把结果钉死在 20 倍上）：
 *
 * | 护甲 | 模型给的等效血 | 每点护甲边际 | 实际每回合吃到的伤害（20 攻） |
 * |---|---|---|---|
 * | 10 | ×2.0 | +10% | 10 点，对得上 |
 * | 15 | ×4.0 | +20% | 5 点，开始夸张 |
 * | 18 | ×10.0 | +50% | 2 点，明显过头 |
 * | 19 | ×20.0 | **+100%** | 1 点 |
 * | 20~25 | ×20.0（钉住，边际 0） | 0 | **0 点：物理免疫** |
 *
 * 三个问题叠在一起：
 *   ① **上界是假的**：19 → 25 全给 20 倍，模型认为魔龙卵（甲 25）和战列舰（甲 18）
 *      一样硬。前者不吃物理伤害，后者还吃 2 点。
 *   ② **边际收益倒挂**：18→19 一点护甲值 +100%，5→6 只值 +7%。可护甲是
 *      "每次挨打减一次"，本该近似**线性**加等效血，不该是双曲线。
 *   ③ **单点假设不成立**：它假定所有人都是 20 攻。后期 78 攻的坦克打 18 甲，
 *      TTK 只多 30%，不是 5 倍。护甲越厚，这个假设错得越离谱。
 *
 * 所以换成**威胁谱**：轻/中/重三档各算一次 TTK，再取加权几何平均。
 * 用几何平均（不是算术）是因为"等效血"是乘性量，算术平均会被最高那档带飞。
 *
 * 三档就是数据里真实的攻击带：轻 20（民兵/弓手/火枪兵）、中 45（骑士/恶魔）、
 * 重 80（主战坦克/战列舰/隐身战机）。权重按"战场上挨的刀数"给——便宜兵多、
 * 重锤少，但重锤对厚甲最有发言权，所以给到 25%，不是按人头比例的 5%。
 *
 * 标定后的曲线：甲 5 → ×1.19，10 → ×1.49，15 → ×2.11，18 → ×3.20，25 → ×4.84，
 * 单调、有上界（护甲高到三档都打不动时收敛到 ×37.6——那要 79 甲，
 * 数据里最高是魔龙卵的 25），**没有拐点，也没有钉住区**。
 */
const THREAT_ATK: ReadonlyArray<readonly [number, number]> = [
  [BASE_ATK, 0.4], // 轻档就是原来那个"基准 20 攻"
  [45, 0.35],
  [80, 0.25],
];

/**
 * 等效血：挨"威胁谱"打的时候能扛多少个标准回合。
 *
 * `hp × Π(atk / max(1, atk − armor))^w`，就是三档 TTK 的加权几何平均。
 * 分母保底 1，是因为伤害本身保底 0（见 rules 的 `max(0, dmg − armor)`）——
 * 保底 1 相当于"一回合至少推进一点"，否则厚甲会算出真正的无穷大。
 */
export function effectiveHp(hp: number, armor: number): number {
  let logSum = 0;
  for (const [atk, w] of THREAT_ATK) {
    logSum += w * Math.log(atk / Math.max(1, atk - armor));
  }
  return Math.max(1, hp) * Math.exp(logSum);
}

/**
 * 跑批实验钩子：**只给对照实验用，正式行为由下面的默认值决定**。
 *
 * 为什么要读环境变量：A/B 两组口径要跑同一棵树，而分片跑批是"边跑边 spawn"——
 * 跑到一半改源文件，后面的分片就会用上改过的代码，整批数据作废。
 * 把常数做成进程启动时读一次环境变量，两组才能真的并行。
 *
 * 业务代码不要读这些变量，也不要给它们做命令行入口。
 */
function numFromEnv(name: string, fallback: number): number {
  // 浏览器里没有 process（UI 冒烟测试就是把打包产物丢进 jsdom 里跑），
  // 所以这里必须用 typeof 探一下，不能直接 `process.env`——会直接抛 ReferenceError。
  const env = typeof process === 'undefined' ? undefined : process.env;
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 压缩指数。**这一步是"非线性"的关键**。
 *
 * 战斗力不是各项相加，而是"输出 × 生存"的乘积（兰彻斯特平方律：同等训练水平下，
 * 一支军队的战力正比于 数量²，单兵层面就是 DPS × EHP）。所以两个都是 1.5 倍的兵，
 * 合起来是 2.2~2.6 倍，不是 1.5 倍。
 *
 * 但也不能直接用乘积：那样贵兵的性价比会碾压便宜兵（4 倍属性 = 16 倍战力），
 * AI 就会只看大件、不铺兵。取 0.55 次方把乘积压回与金币同量级——
 * **压的是量级，不是超线性**：属性齐涨 1.5 倍 → 战力 1.64 倍，仍明显高于线性。
 *
 * 0.7 与 0.55 都跑过 100 局对照（见 docs/BALANCE-2026-11-03-stats-audit.md）：
 * 0.7 更"宠大件"，AI 兵力铺不开，打满 200 回合的和局比例更高。
 */
export const LANCHESTER_EXP = numFromEnv('WB_UNIT_EXP', 0.55);

/**
 * 模型量级常数：让效率值落在和旧版相近的区间（见 EFF_SCALE）。
 *
 * 标定方式：让全兵种效率的**中位数**落在 5~6（旧版 `攻×√血×射程/价^0.8`
 * 的中位就在这一档），这样采购分里 0~26 那一段的上下限才对得上。
 * **换压缩指数必须重标**：`npm run calibrate:k -- <exp>` 会给对应的 K。
 */
export const POWER_K = numFromEnv('WB_POWER_K', 8.94);

/**
 * 价格指数：价格越贵，同样的属性越"便宜"一点点。
 *
 * 小于 1 是因为造价里含了**规模成本**（训练营、出兵格、补给线），
 * 这些东西不随兵的强弱变化，所以高价兵的单位属性价格天然更低。
 */
export const PRICE_EXP = numFromEnv('WB_PRICE_EXP', 0.95);

/**
 * 战力的"核心两项"：每回合输出、等效血。
 *
 * 单独导出来是因为标定脚本要拿它去试别的压缩指数——**必须和 unitPower 同源**。
 * 之前 `calibrate-k.ts` 自己抄了一份 `hp × 20/(20−armor)`，阈值一改两边就对不上，
 * 算出来的 K 会把标定带偏。抄件就是下一个 bug。
 */
export function combatCore(d: UnitTypeDef): { dps: number; ehp: number } {
  const atk = d.atk + (d.magicAtk ?? 0) * 1.2;
  return {
    dps: Math.max(1, atk - BASE_ARMOR) * burstFactor(d),
    ehp: effectiveHp(d.maxHp, d.armor),
  };
}

/**
 * 一个兵种的"战力"。
 *
 * 三步：
 *   1. 输出 = 打穿 5 甲后的每回合伤害（多段打折）；
 *   2. 生存 = 挨**威胁谱**（20/45/80 攻）打时的等效血量；
 *   3. 战力 = (输出 × 生存)^LANCHESTER_EXP × 射程 × 移速 × 视野 × (1 + 能力)。
 *
 * 旧版是 `攻 × √血 × 射程`——两个毛病：血量开根号把"血厚"的价值压掉一半，
 * 而且移速/视野/护甲/能力全都不计价（龙骑兵因此被 AI 判成废卡）。
 */
export function unitPower(d: UnitTypeDef, ctx: ValueContext = NEUTRAL_CONTEXT): number {
  const { dps, ehp } = combatCore(d);
  const core = (dps * ehp) ** LANCHESTER_EXP;
  return (
    core *
    POWER_K *
    rangeFactor(d.range ?? 1) *
    moveFactor(d.move, ctx) *
    visionFactor(d.vision, ctx) *
    (1 + abilityValue(d, ctx))
  );
}

/**
 * 采购打分里的比例常数。
 *
 * 保持 3：新战力的量级已经用 `POWER_K` 对回旧版（p50 效率 ≈ 5~6），
 * 采购分里"性价比"这一项的上下限（0 ~ 26）才和以前可比。
 * 试过压到 1.35——结果固定底分（+12 / +4×代）和经济单位占了上风，
 * 24 个民兵的用例里 AI 宁可买农民也不换血。常数不能单独动。
 */
export const EFF_SCALE = 3;

/** 性价比：战力 ÷ 价格^PRICE_EXP（指数 <1，让贵兵的护甲/破城不被线性压死） */
export function unitEfficiency(
  d: UnitTypeDef,
  price: number,
  ctx: ValueContext = NEUTRAL_CONTEXT,
): number {
  return unitPower(d, ctx) / Math.max(20, price) ** PRICE_EXP;
}
