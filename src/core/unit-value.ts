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
  /*
   * 破甲 0.10 → 0.05：它的价值现在**已经算在 `combatCore` 里**了
   * （对中甲靶子 5→2.5、对重甲 10→5），再挂 0.10 就是收两遍钱。
   * 留 0.05 是因为模型只按"靶子护甲"算，而实战里破甲对**城墙**（甲更高）
   * 和 buff 叠出来的临时厚甲更值钱，这一层没进公式。
   */
  'armor-pierce': 0.05,
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
  /**
   * 这张图上"水"占多大比例（0~1）。水军只能在水上打，所以要按可作战面积折价。
   * 不传时按 0.25 算（河图实测 15~31%）。
   */
  waterShare?: number;
  /**
   * 这一场仗打在哪一代（1~6）。威胁谱和靶子谱都按它取。
   *
   * 不传 = 用这个兵**自己**的世代（"同代统治力"口径）；
   * 传了就按指定世代算（"它放到 6 代还值多少"、"当前局势该不该买它"）。
   */
  era?: number;
}

/** 没有局面的默认口径：均势、视野中等、有迷雾 */
export const NEUTRAL_CONTEXT: ValueContext = { tempo: 0, visionCoverage: 0.4, fog: true, waterShare: 0.25 };

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

/**
 * 域可用性：**水军只在水上能打，不能按全地图通用来算账**。
 *
 * 这是审计里第二处系统性高估。3 代及以前 104 个战斗兵种里排在最前面的
 * 是风帆战列舰（12.16）、炮艇（11.63）、巡航舰（11.44）——它们确实数值好，
 * 但那是**只算交手、不算能不能到场**的结果：一张 20×20 的图上水域通常只占两成，
 * 船在剩下八成地图上既不能挡路也不能守城，战力只能在这两成里兑现。
 *
 * 折价按"可作战面积"给，不按"水域够不够宽"（那是 `seaDemand` 的活，管的是
 * "该不该为过海造船"，是另一件事）：
 *   · 水占 25%（典型河图）→ ×0.66
 *   · 水占 15%（水少的图）→ ×0.62
 *   · 水占 60%（群岛）→ ×0.82
 * 即使全是水也只给到 ×1.0，不多给——船没有"在水上比陆军在陆上更强"这回事。
 *
 * 飞兵不吃这条：空中没有"地图不通"的问题。陆军同理。
 */
export const domainFactor = (d: UnitTypeDef, ctx: ValueContext = NEUTRAL_CONTEXT): number => {
  if (d.domain !== 'water') return 1;
  const wet = Math.max(0, Math.min(1, ctx.waterShare ?? 0.25));
  return 0.55 + 0.45 * wet;
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

/*
 * 这里原来有两个"基准靶子"常数（5 甲、20 攻）。它们代表了这条公式的老毛病：
 * **把整个世界压成一个对手**。现在靶子按时代取（见下面的 `ERA_SPECTRUM`），
 * 常数就退休了——留着只会让人以为还按 5 甲算。
 */

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
 * 所以换成**威胁谱**：四档"假想的对手"各算一次 TTK，再取加权几何平均。
 * 用几何平均（不是算术）是因为"等效血"是乘性量，算术平均会被最狠那档带飞。
 *
 * 四档就是数据里真实的攻击带：
 *   · **轻 20 攻**（民兵/弓手/火枪兵）—— 数量最多，占 32%
 *   · **中 45 攻**（骑士/恶魔）—— 26%
 *   · **重 80 攻 + 破甲**（主战坦克/战列舰/隐身战机）—— 20%。25 个兵带破甲，
 *     且集中在重锤上，所以"重锤会削你一半甲"是默认而不是特例
 *   · **法师：10 物攻 + 28 魔攻** —— 22%。魔法段**完全不吃护甲**，只减魔抗
 *
 * 为什么非要单独一行法师：护甲和魔抗是两条互不相干的减伤通道
 * （`rules.ts` 先 `max(0, 伤害 − 护甲)`，再加 `max(0, 魔攻 − 魔抗)`）。
 * 只写"物理威胁"的话，`magicRes` 在尺子上等于白送——14 个带魔抗的兵
 * （至尊法师 14、邪龙王 12、天使 6……）一点价钱都拿不到，而他们为此付了造价。
 *
 * 标定后的曲线：甲 5 → ×1.18，10 → ×1.40，15 → ×1.90，18 → ×2.60，25 → ×3.60，
 * 单调、有上界（护甲再高，法师那一行也不会变），**没有拐点，也没有钉住区**。
 */
interface Threat {
  /** 物理攻击 */
  atk: number;
  /** 魔法攻击（不吃护甲，只减魔抗） */
  magic: number;
  /** 是否带破甲（目标护甲砍半，见 abilities.ts 的 armor-pierce） */
  pierce?: boolean;
  /** 权重：这一档在"挨的刀"里占多少 */
  w: number;
}

/**
 * 每一代自己的"威胁谱"和"靶子谱"。
 *
 * 为什么必须按时代分开：**高代兵交手的也是高代兵**。拿一套固定的
 * 20/45/80 去量所有人，两头都会错——
 *   · 低代兵（甲 2~4）被拿去跟 45、80 攻的对手算账，护甲显得一文不值；
 *   · 高代兵（甲 10~18）被拿去跟 20 攻打账，护甲显得近乎无敌；
 *   · 更要命的是"低代兵在高代有多废"这件事直接消失了——因为它的对手还是 3 代。
 *
 * 表里的数字是从全部 210 个战斗兵种**按代分组算出来的分位数**（不是拍的）：
 *
 * | 代 | 兵种数 | 攻 p25/p50/p90 | 甲 p25/p50/p75 |
 * |---|---|---|---|
 * | 1 | 17 | 11/14/19 | 1/1/3 |
 * | 2 | 31 | 12/14/19 | 2/3/4 |
 * | 3 | 51 | 18/22/33 | 2/3/6 |
 * | 4 | 34 | 22/30/42 | 3/6/8 |
 * | 5 | 35 | 38/46/70 | 4/8/11 |
 * | 6 | 35 | 38/56/85 | 4/6/10 |
 *
 * 三条约定：
 *   · **轻/中/重**取这一代攻击的 p25/p50/p90，权重 0.35/0.40/0.25；
 *     "重"那一档带破甲（破甲兵本来就集中在重锤上）。
 *   · **法师**只在"这一代带魔攻的兵 ≥ 8%"时单独成行（3 代 12/51、6 代 2/35），
 *     取值按这一代 p50 的 0.4 倍物攻 + 0.8 倍魔攻，权重 0.20，其余三档等比缩到 0.8。
 *   · 靶子用这一代护甲的 p25/p50/p75，魔抗沿用实测的 0/0/1.5。
 *
 * `npm run era:table` 会重新算一遍并和这张表对账，数值改了会报出来。
 */
type ThreatRow = Threat;

interface EraSpectrum {
  /** 挨的打（防守侧） */
  threats: ThreatRow[];
  /** 打的靶子（输出侧） */
  targets: ReadonlyArray<{ armor: number; magicRes: number; w: number }>;
}

const ERA_SPECTRUM: Record<number, EraSpectrum> = {
  1: {
    threats: [
      { atk: 11, magic: 0, w: 0.35 },
      { atk: 14, magic: 0, w: 0.4 },
      { atk: 19, magic: 0, pierce: true, w: 0.25 },
    ],
    targets: [
      { armor: 1, magicRes: 0, w: 0.35 },
      { armor: 1, magicRes: 0, w: 0.4 },
      { armor: 3, magicRes: 1, w: 0.25 },
    ],
  },
  2: {
    threats: [
      { atk: 12, magic: 0, w: 0.35 },
      { atk: 14, magic: 0, w: 0.4 },
      { atk: 19, magic: 0, pierce: true, w: 0.25 },
    ],
    targets: [
      { armor: 2, magicRes: 0, w: 0.35 },
      { armor: 3, magicRes: 0, w: 0.4 },
      { armor: 4, magicRes: 1, w: 0.25 },
    ],
  },
  3: {
    threats: [
      { atk: 18, magic: 0, w: 0.28 },
      { atk: 22, magic: 0, w: 0.32 },
      { atk: 33, magic: 0, pierce: true, w: 0.2 },
      { atk: 9, magic: 18, w: 0.2 },
    ],
    targets: [
      { armor: 2, magicRes: 0, w: 0.35 },
      { armor: 3, magicRes: 0, w: 0.4 },
      { armor: 6, magicRes: 1.5, w: 0.25 },
    ],
  },
  4: {
    threats: [
      { atk: 22, magic: 0, w: 0.35 },
      { atk: 30, magic: 0, w: 0.4 },
      { atk: 42, magic: 0, pierce: true, w: 0.25 },
    ],
    targets: [
      { armor: 3, magicRes: 0, w: 0.35 },
      { armor: 6, magicRes: 0, w: 0.4 },
      { armor: 8, magicRes: 1.5, w: 0.25 },
    ],
  },
  5: {
    threats: [
      { atk: 38, magic: 0, w: 0.35 },
      { atk: 46, magic: 0, w: 0.4 },
      { atk: 70, magic: 0, pierce: true, w: 0.25 },
    ],
    targets: [
      { armor: 4, magicRes: 0, w: 0.35 },
      { armor: 8, magicRes: 0, w: 0.4 },
      { armor: 11, magicRes: 1.5, w: 0.25 },
    ],
  },
  6: {
    threats: [
      { atk: 38, magic: 0, w: 0.35 },
      { atk: 56, magic: 0, w: 0.4 },
      { atk: 85, magic: 0, pierce: true, w: 0.25 },
    ],
    targets: [
      { armor: 4, magicRes: 0, w: 0.35 },
      { armor: 6, magicRes: 0, w: 0.4 },
      { armor: 10, magicRes: 1.5, w: 0.25 },
    ],
  },
};

/** 没指定时代时按 3 代算（中位；也是"两军刚接触"最常见的年代） */
export const NEUTRAL_ERA = 3;

/** 取某一代的谱；越界就夹到 1~6 */
export function eraSpectrum(era: number | undefined): EraSpectrum {
  const e = Math.max(1, Math.min(6, Math.round(era ?? NEUTRAL_ERA)));
  return ERA_SPECTRUM[e]!;
}

/**
 * 等效血：挨**这一代**的威胁谱打的时候能扛多少个标准回合。
 *
 * 每一档先算它**每回合真能打进来的伤害**（物理减护甲、魔法减魔抗、破甲砍半甲），
 * 再和"它名义上的攻击力"比，得到这一档的 TTK 倍率，最后按权重取几何平均。
 *
 * 分母保底 1，是因为伤害本身保底 0（见 rules 的 `max(0, dmg − armor)`）——
 * 保底 1 相当于"一回合至少推进一点"，否则厚甲会算出真正的无穷大。
 */
export function effectiveHp(hp: number, armor: number, magicRes = 0, era = NEUTRAL_ERA): number {
  let logSum = 0;
  for (const t of eraSpectrum(era).threats) {
    const armorEff = t.pierce ? armor / 2 : armor;
    const dealt = Math.max(0, t.atk - armorEff) + Math.max(0, t.magic - Math.max(0, magicRes));
    const nominal = t.atk + t.magic;
    logSum += t.w * Math.log(nominal / Math.max(1, dealt));
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
export const POWER_K = numFromEnv('WB_POWER_K', 1.03);

/**
 * 价格指数：**金币在排序里占多大的话语权**。
 *
 * 这一条原来写 0.95，等于"按每金币战力排序"——听着天经地义，但对**这个 AI** 是错的：
 * 它的瓶颈不是金币，是它自己身上那两道闸——
 *   · `CONFIG.maxUnits = 24` 的编制上限（**这条只对 AI 生效**，规则层没有）；
 *   · 每回合最多买 `DEFAULT_BUDGET.maxRecruit = 2` 个。
 * 真人对局里这两道闸都不存在：通常模式一座城一回合能连出到 8 个兵，
 * （"一城一兵"是指挥官模式的限制），所以人的瓶颈才是金币，AI 的瓶颈是名额与回合数。
 * 拿"每金币战力"给 AI 排序，等于按人的瓶颈去优化 AI 的瓶颈。
 *
 * 后果很具体：10 个民兵（250 金、10 个名额、**5 个回合**）战力合计 1740，
 * 1 个龙骑兵（265 金、1 个名额、1 个回合）战力 1073。按每金币算民兵赢；
 * 按"每名额、每回合能上多少战力"算，龙骑兵是民兵的六倍多。旧口径把前者
 * 排进前八、把后者排到 36/104，于是 AI 一路堆便宜兵，265 金的突击兵
 * 永远"平平无奇"——不是它弱，是尺子量错了瓶颈。
 *
 * 0.55 是把话语权调回来：贵的兵仍然要为多花的钱打折，但打不到"一金一金算"。
 * 标定后的效果（3 代及以前 104 个战斗兵种）：龙骑兵 36 → **13**，
 * 民兵 8 → **70**。这也和实战对得上——真人用龙骑兵、以及真人之间对局，
 * 它都是统治级的存在。
 */
export const PRICE_EXP = numFromEnv('WB_PRICE_EXP', 0.55);

/** 复利溢价的总体强度（见 raidPremium）；0.35 让龙骑兵在 3 代从 6.25 抬到 8 附近 */
export const RAID_K = numFromEnv('WB_RAID_K', 0.35);

/**
 * 靶子谱：算"输出"时假定打在谁身上。
 *
 * 和威胁谱是同一个道理的另一半：**输出也不能只看一个靶子**。
 * 原来写的是"打穿 5 甲"，于是法师的魔攻被 1.2 的系数硬塞进物理通道、
 * 再一起减 5 甲——可规则里魔法段根本不吃护甲。按 5 甲算，法师的伤害
 * 被系统性地算小了；按 0 甲算，物理兵又被算大了。
 *
 * 三档靶子按"战场上遇到的护甲分布"给权重，中甲那档仍然是 5 甲
 * （这样"打轻甲/打重甲"各占一头的结构，和原来那句话是接得上的）。
 *
 * 靶子的**魔抗按实测期望填**，不要拍：全表 210 个战斗兵里只有 14 个带魔抗，
 * 按护甲分段算出来的期望值是 甲 0-2 → 0.15、甲 3-5 → **0.08**、甲 6-9 → 0.56、
 * 甲 10+ → **1.50**。所以轻/中甲靶子的魔抗基本就是 0，只有重甲靶子带一点。
 * （第一版这里拍了 0/2/4，等于假设"人人都有两点魔抗"，
 * 结果法师的输出被系统性压掉一成多，女巫的采购量当场腰斩。）
 */
/**
 * 战力的"核心两项"：每回合输出、等效血。
 *
 * 单独导出来是因为标定脚本要拿它去试别的压缩指数——**必须和 unitPower 同源**。
 * 之前 `calibrate-k.ts` 自己抄了一份 `hp × 20/(20−armor)`，阈值一改两边就对不上，
 * 算出来的 K 会把标定带偏。抄件就是下一个 bug。
 *
 * 输出走两条通道：
 *   · 物理：`max(0, 攻击 − 靶子护甲)`，带破甲则靶子护甲砍半；
 *   · 魔法：`max(0, 魔攻 − 靶子魔抗)`，**不减护甲**（见 rules 的 magicSegment）。
 * 两条加起来再乘多段系数——多段折扣本来是给"每段各减一次甲"打的折，
 * 用在整个和上略保守（魔法段其实不扣甲），但带多段的兵里没有纯法师，误差可以忽略。
 */
export function combatCore(
  d: UnitTypeDef,
  ctx: ValueContext = NEUTRAL_CONTEXT,
): { dps: number; ehp: number } {
  // 默认按**这个兵自己那一代**算：这样量出来的是"它在自己那一代有多能打"。
  // 想看"它放到别的代还值多少"，显式传 ctx.era 覆盖即可（见 6 代衰减表）。
  const era = ctx.era ?? d.era;
  const spec = eraSpectrum(era);
  const pierce = (d.abilities ?? []).includes('armor-pierce');
  const phys = d.atk;
  const magic = d.magicAtk ?? 0;
  let dps = 0;
  for (const t of spec.targets) {
    const armorEff = pierce ? t.armor / 2 : t.armor;
    dps += t.w * (Math.max(0, phys - armorEff) + Math.max(0, magic - t.magicRes));
  }
  return {
    dps: Math.max(1, dps) * burstFactor(d),
    ehp: effectiveHp(d.maxHp, d.armor, d.magicRes ?? 0, era),
  };
}

/**
 * 后排软目标：农民那一档（45 金、24 血、0 甲）。
 *
 * 骚扰的收益全在这些单位身上，而它们**不在**威胁谱/靶子谱里（那两张表算的是
 * "两军对砍"）。所以要单独把这块价值算出来。
 */
const SOFT_TARGET_HP = 24;
const SOFT_TARGET_VALUE = 45;

/**
 * 骚扰复利率：这个兵**反复上门**能多赚多少。
 *
 * 为什么必须有这一项：`(输出 × 生存)^0.55` 量的是一次公平交换，而这游戏里
 * "只买一种兵、专杀经济"赢的是**复利**——每次回来还能再去一次。
 * 实测五个飞行突击兵在同一个脚本下：龙骑兵 90% 胜（每次上门生还 50%）、
 * 狮鹫骑士 10%（12%）、鹰身女妖 0%（3%）、毒蝙蝠 0%（4%）、蜘蛛骑士 0%（14%）。
 * 面板只差两三成，胜率差出九十个点——差的就是"能打几波"。
 *
 * 三项相乘，各自有明确含义：
 *   · **够不够得着**（reach）：移速 + 飞行/跳跃判定的"能不能绕到后排"。
 *   · **生还率 p**：`ehp / (ehp + D)`，D 是后排两个守卫一回合能打进来的伤害。
 *     这里没有用任何对局数据拟合——它只读模型自己的等效血和这一代的攻击谱。
 *   · **每回合拆掉多少经济**：`dps / 软目标血量 × 软目标价值 ÷ 自身造价`。
 * 最后 `p/(1−p)` 就是复利因子：p=50% → ×1，p=12% → ×0.14，p=4% → ×0.04。
 *
 * 它乘在战力上，但**不是**战力：它是"这个兵换算成经济破坏力之后，再折回战力"的溢价。
 * 所以封顶（2.5 倍复利、1.2 倍经济效率），不让它盖过生存与输出的基本盘。
 */
export function raidPremium(d: UnitTypeDef, ctx: ValueContext = NEUTRAL_CONTEXT): number {
  const era = ctx.era ?? d.era;
  const spec = eraSpectrum(era);
  const bypass =
    d.flight || d.layer === 'air'
      ? 2
      : (d.abilities ?? []).some((a) => a === 'leap' || a === 'fly-over' || a === 'phase')
        ? 1.2
        : 0;
  const reach = Math.max(0, Math.min(1, (d.move + bypass - 4) / 3));
  if (reach <= 0) return 0;

  const { dps, ehp } = combatCore(d, ctx);
  const physRows = spec.threats.filter((t) => t.magic === 0);
  const midAtk = physRows[1]?.atk ?? 20;
  // 后排是两个守卫在还手，不是一支军队：按两下算，且不低于 1
  const threatPerTurn = 2 * Math.max(1, midAtk - d.armor);
  const p = ehp / (ehp + threatPerTurn);
  const ecoPerTurn = (dps / SOFT_TARGET_HP) * SOFT_TARGET_VALUE;
  const compounding = Math.min(2.5, p / Math.max(0.01, 1 - p));
  const ecoRatio = Math.min(1.2, ecoPerTurn / Math.max(1, d.cost));
  return RAID_K * reach * compounding * ecoRatio;
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
  const { dps, ehp } = combatCore(d, ctx);
  const core = (dps * ehp) ** LANCHESTER_EXP;
  return (
    core *
    POWER_K *
    rangeFactor(d.range ?? 1) *
    domainFactor(d, ctx) *
    moveFactor(d.move, ctx) *
    visionFactor(d.vision, ctx) *
    (1 + abilityValue(d, ctx)) *
    (1 + raidPremium(d, ctx))
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
