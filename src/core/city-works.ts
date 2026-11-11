/**
 * 「城郭与物料」：一座更大的城，和两种比金币更硬的东西。
 *
 * 这个扩展改的是**骨架**而不是数值：主城从 2×2 长到 3×3、建筑要分回合施工、
 * 兵要吃粮、楼要耗材、箭塔退成"看得远、守得住、但打不疼"。
 * 因为动的是骨架，它单独成文件——塞进 expansions.ts 会把那张钩子表淹掉。
 *
 * 三条设计上的取舍，写在这儿免得以后自己被自己坑：
 *
 *   1. **金币仍然是硬通货**，只是不再是唯一的。建筑升级、城市升级照旧花金币；
 *      兵种造价被拆成"三成金币 + 七成粮/材"，于是"养兵"第一次真的需要经营。
 *   2. **一种兵，多种产出**。经济单位不再各认一种地形，而是按**脚下那块地**出货：
 *      平地出粮、林丘出材。这就是"缩减经济单位种类"的落点——不是删兵，
 *      而是让"造哪种经济兵"这个问题不再有标准答案。
 *   3. **工地是真实存在的**。塔要两回合，第一回合它就是一个能被拆的工地：
 *      看得见、挡路、开不了火。于是"修塔"从瞬间动作变成需要掩护的过程。
 *   4. **经济建筑只做经济**。它的产出必须够狠（否则没人愿意把钱压在不会动的
 *      东西上），但耐久必须够差（否则它会顺手变成一堵墙）。这两件事以前是反的：
 *      产出平庸、耐久 +35%，于是最划算的用法是把它修在隘口上堵路。
 */

import { navigable } from './config.ts';
import { isProducer } from './produce.ts';
import type { Expansion } from './expansions.ts';
import type { GameState, PlayerId, Terrain, UnitTypeDef } from './types.ts';
import type { ResourceCost } from './resources.ts';
import { seatsOf } from './types.ts';
import { isBioUnit } from './resources.ts';

/**
 * 生物兵吃粮、机械与建筑耗材：造价里非金币的那一份占原价的比例。
 *
 * 7:3 —— 粮和材是主要成本，金币是零头。
 *
 * 上一版是 4:6（金币六成），实战里金币严重短缺——那时的解法是把**支出**改成
 * 三成金币，而不是给收入加金币：加产出会把"经营"这件事抹平，玩家只要多盖几座
 * 磨坊就完事，而粮和材本来才是这个扩展要人操心的东西。
 *
 * 2026-11-04 曾把平原/丘陵/森林上的经济单位对调过一次（六成留金、四成折粮材），
 * **2026-11-06 回撤**：那三种地形是建材主产地，对调让建材掉三分之一，
 * 而金币并没有变宽——短缺只是从金币挪到了建材。现在全地形统一按
 * ECO_UNIT_OUTPUT_SHARE 折算，原因见 modifyYield 里那段注释。
 */
const RES_SHARE = 0.7;
/** 金币那一份：剩下的三成 */
const GOLD_SHARE = 0.3;

/**
 * 经济建筑的四个专用系数。
 *
 * 这一组数只作用于**建筑**，不碰经济单位。原因很直接：经济单位是"人"，
 * 它会走、会被抓、会占编制，本身就有代价；建筑不会动，代价只有造价——
 * 所以它的性价比必须靠数字压住，而不能靠"用起来麻烦"。
 *
 *   ECO_RES_SHARE / ECO_GOLD_SHARE
 *     造价结构：资源 55%、金币 20%（原来 70/30）。全时期的经济建筑都更便宜，
 *     回本从"八九个回合"压到"四五个回合"。
 *   ECO_OUTPUT_SHARE
 *     金币收入里转成粮/材的比例：0.8（原来 0.6）。同样的磨坊，粮食多三成。
 *   EARLY_ECO_RES_SHARE
 *     时代 1-2 的经济建筑还要更便宜（资源 60%），而且一分金币都不要——
 *     那一段玩家手里粮材都还少，把门票（金币）免掉，才敢在第一座粮仓上押钱。
 *
 * 耐久那一条单独拎出来写成 ECO_HP：普通建筑 1.35，经济建筑只有 1.1。
 */
const ECO_RES_SHARE = 0.55;
const ECO_GOLD_SHARE = 0.2;
const ECO_OUTPUT_SHARE = 0.8;
const EARLY_ECO_RES_SHARE = 0.6;
/**
 * 经济建筑的耐久系数。
 *
 * 普通建筑是 1.35，经济建筑只有 1.1，而且护甲再 −1。
 * 合起来：粮仓从 54 血 4 甲变成 44 血 3 甲——一支二代部队拆它从五下变成四下。
 * 这个幅度是刻意"略微"的：再狠一点，经济建筑就只剩"被人顺手拆掉"这一种命运，
 * 玩家会退回去把钱全砸在兵上，经济这套玩法就白做了。
 */
const ECO_HP = 1.1;

/**
 * 经济建筑（产金币或产粮材的那种）——它们的"反击"最该被削。
 *
 * 导出是因为**选卡也要用它**：这类建筑不进卡池（见 `draftAlwaysAllowed`）。
 * 两处必须共用同一个判据——"哪些算经济建筑"分成两份写，迟早会出现
 * "选卡里还躺着一个磨坊"这种事。
 */
export function isEcoBuilding(def: UnitTypeDef): boolean {
  // 注意 yield：粮仓与采石场的产出不写成 income，只写 yield。
  // 早先漏了这一条，"经济建筑"的整套待遇（不还手、造价减免、削耐久）
  // 全都没落到这两个建筑身上——而它们恰恰是隘口堵路的主角。
  return def.category === 'building' && (!!def.incomeByTerrain || !!def.income || !!def.yield);
}

/** 前期经济建筑（时代 1-2）：造价里一分金币都不要 */
function isEarlyEcoBuilding(def: UnitTypeDef): boolean {
  return isEcoBuilding(def) && def.era <= 2;
}

/**
 * 经济建筑产的是粮还是材。
 *
 * 写死了 `yield` 的以它为准（粮仓产粮、采石场产材）；靠金币收入折算的按时代分
 * （时代 3 起折成建材，见 modifyYield）。
 * 造价的"吃哪种资源"和产出的"出哪种资源"共用这一个判断：**产什么就吃什么**。
 * 于是建材线是自洽的——想开石场，先得有木头和石头。
 */
function ecoResOf(def: UnitTypeDef): 'food' | 'material' {
  const y = def.yield ?? {};
  if ((y.material ?? 0) > (y.food ?? 0)) return 'material';
  if ((y.food ?? 0) > 0) return 'food';
  return def.era >= 3 ? 'material' : 'food';
}

/** 防御塔一类的工事：要施工、能驻军 */
const FORTS = ['tower', 'keep', 'battery', 'fortress', 'bunker'];

/** 本扩展新建的资源建筑 */
const NEW_BUILDINGS: UnitTypeDef[] = [
  {
    id: 'granary',
    name: '粮仓',
    short: '仓',
    era: 1,
    category: 'building',
    // 造价写的是"原价"，实际收多少由下面的钩子按资源规则折算
    cost: 55,
    costRes: { food: 33 },
    move: 0,
    atk: 0,
    armor: 4,
    maxHp: 40,
    range: 0,
    vision: 2,
    // 产粮：收上来的谷子在这里变成能吃的军粮
    // 8 → 10：产出必须够狠，玩家才愿意在"不会动的东西"上押钱
    yield: { food: 10 },
  },
  {
    id: 'quarry',
    name: '采石场',
    short: '石',
    era: 2,
    category: 'building',
    cost: 90,
    costRes: { material: 54 },
    move: 0,
    atk: 0,
    armor: 5,
    maxHp: 46,
    range: 0,
    vision: 2,
    yield: { material: 13 },
  },

  // ── 建材产线的后段（时代 3/4/5）──
  //
  // 伐木工（时代 2）之后，建材的"天花板"一直卡在采石场的 13/回合，
  // 而同期一个步枪兵的建材价已经是三位数。于是后期只有一条路：
  // 铺一堆二本采石场，站桩产出永远追不上时代。
  //
  // 这三个建筑的定位完全一致：**不挑地形**（写在 yield 里而不是 yieldByTerrain），
  // 造价全是建材（自己那条产线的产品），产出按 13 → 24 → 40 → 58 往上走。
  //
  // 为什么不是"越贵越划算"：按"总投入 ÷ 每回合产出"算，四者都落在 4.2~4.7 回合，
  // 采石场因为便宜还略占优。差别在**上限**：想要 350 材/回合，采石场要铺二十七座，
  // 建材基地只要六座——格子、工兵的行动、被偷袭时的损失，都不在一个量级。
  // 高级货卖的不是性价比，是"同样几格地里能挤出多少"。
  {
    id: 'brickworks',
    name: '砖窑',
    short: '砖',
    era: 3,
    category: 'building',
    cost: 150,
    costRes: { material: 83 },
    move: 0,
    atk: 0,
    armor: 4,
    maxHp: 38,
    range: 0,
    vision: 2,
    buildCost: 24,
    yield: { material: 24 },
  },
  {
    id: 'cementworks',
    name: '水泥厂',
    short: '泥',
    era: 4,
    category: 'building',
    cost: 240,
    costRes: { material: 132 },
    move: 0,
    atk: 0,
    armor: 5,
    maxHp: 44,
    range: 0,
    vision: 2,
    buildCost: 40,
    yield: { material: 40 },
  },
  {
    id: 'materialbase',
    name: '建材基地',
    short: '基',
    era: 5,
    category: 'building',
    cost: 360,
    costRes: { material: 198 },
    move: 0,
    atk: 0,
    armor: 6,
    maxHp: 52,
    range: 0,
    vision: 2,
    buildCost: 56,
    yield: { material: 58 },
  },
];

/**
 * 建材向的经济单位：把"砍木头"这条线一路接到"建材公司"。
 *
 * 为什么必须有它们：时代 2 之后再没有建材单位，而募兵只认"本代和上一代"
 * （见 rules 的 RECRUIT），所以到了蒸汽时代，伐木工连产都产不出来。
 * 于是后期的建材只能靠建筑硬撑，而建筑的天花板又停在采石场。
 *
 * 数值按"同一块丘陵、每一代大约 ×1.35"排：
 *   伐木工（2）林地 12 → 约 7 材
 *   采石工（3）丘陵 26 → 约 16 材
 *   矿队　（4）丘陵 36 → 约 22 材
 *   建材公司（5）丘陵 48 → 约 29 材
 * 单位之间不靠"更肥的地形表"取胜，靠"同一块地出得更多"——
 * 这样后期不必去抢特定的丘陵，而是"换人"就能扩产。
 */
/* ── 收税（2026-11-10） ──────────────────────────────────────────────────
 *
 * 用户定的规则：
 *   · 牧民：产出对半分成粮食与材料；
 *   · 税官：把全场粮+材的当回合产出按比例折成金币；
 *   · 其余经济单位：按脚下地形定产什么——平原/水域出粮、城市出金、其它出材。
 *
 * 为什么要一个税官：这套扩展把金币折得太狠（原来 0.8 折成粮材、只留 0.2），
 * 而"出兵"仍然要三成金币。结果就是"粮材堆成山、金币见底"——兵摆在城里造不出来。
 * 税官就是把那堆粮材换回金币的出口。
 */

/** 税官这个兵种的 id（定义在下面的 NEW_ECONOMY_UNITS 里） */
const TAX_UNIT = 'tax_collector';

/**
 * 每名税官每回合从"全场粮+材"里抽多少金币。
 *
 * 0.1 = 抽一成。这个数怎么来的、为什么不能再高，见 `taxableOutputOf` 上面
 * 那段账：它不是拍出来的，是按"三成金币 = 出兵的全部金币开销"反推的。
 */
const TAX_RATE = 0.1;

/**
 * 一个经济单位站在这种地形上，产出该落到哪种资源。
 *
 * 单一出口：`modifyYield`（真正改写产出）和 `taxableOutputOf`（算税基）
 * 都调它，避免"界面上是粮、税按材算"这种两套口径。
 */
function econResAt(def: UnitTypeDef, terrain: Terrain): 'gold' | 'food' | 'material' | 'mixed' {
  // 牧民是特例：牛羊既是口粮也是皮革毛料，对半分
  if (def.id === 'herder') return 'mixed';
  if (terrain === 'city') return 'gold';
  // 水域与平原：种的就是粮。桥面也算水域（桥下还是河）
  if (terrain === 'plain' || navigable(terrain)) return 'food';
  // 森林、丘陵、高山、沼泽……剩下的都算材料
  return 'material';
}

/**
 * 这名玩家这一回合能产的**粮食与材料合计**（税基）。
 *
 * 为什么不直接调 `rules.unitYield` 累加：那会让 `city-works → rules → expansions
 * → city-works` 成环，模块初始化顺序一旦变了就是 TDZ 崩。这里的口径写死成
 * "兵种表 × 脚下地形"，和 `modifyYield` 用的是同一个 `econResAt`，
 * 差一样东西：**临水贸易加成**（那 3 金是"靠水吃水"的补贴，不算进税基）。
 *
 * 税官自己不算进税基——否则"N 个税官互相收税"会越叠越高。
 */
function taxableOutputOf(s: GameState, p: PlayerId): number {
  let total = 0;
  for (const u of s.units) {
    if (u.owner !== p || u.hp <= 0) continue;
    const def = s.unitTypes[u.type];
    if (!def || def.id === TAX_UNIT) continue;
    const tile = s.tiles[u.y * s.w + u.x];
    const terrain = tile?.terrain ?? 'plain';

    // 能直接产粮/材的（扩展自己写的 yieldByTerrain）：原样计入
    const direct = def.yieldByTerrain?.[terrain];
    if (direct) total += (direct.food ?? 0) + (direct.material ?? 0);

    const gold = def.incomeByTerrain ? (def.incomeByTerrain[terrain] ?? 0) : (def.income ?? 0);
    if (gold <= 0) continue;

    if (def.category === 'economy') {
      // 'gold' = 站在城里收钱，那份钱不变成粮材，也就不该计税
      if (econResAt(def, terrain) !== 'gold') total += gold;
    } else if (isEcoBuilding(def)) {
      // 经济建筑：磨坊磨粮、工厂出材，折的是八成（见 ECO_OUTPUT_SHARE）
      total += Math.max(1, Math.round(gold * ECO_OUTPUT_SHARE));
    }
  }
  return total;
}

/** 这名玩家此刻的时代（取自家城的最高一代；没有城就按开局时代） */
function playerEraOf(s: GameState, p: PlayerId): number {
  let era = 0;
  for (const c of s.cities) if (c.owner === p && !c.ruined) era = Math.max(era, c.era);
  return era || s.config.startEra;
}

const NEW_ECONOMY_UNITS: UnitTypeDef[] = [
  // 税官：1 时代就能造，自己一分钱不产，产的是"全场粮+材的一成"。
  //
  // 为什么标准产出全是 0：它的收入必须**看得见地**跟着别的产业走。写成
  // "基础 3 金 + 抽成"会让玩家算不清"再多一个税官到底值多少"，
  // 而沙盒类游戏的乐趣恰好在能算清这笔账。数字全在 `modifyYield` 里算。
  {
    id: TAX_UNIT,
    name: '税官',
    short: '税',
    era: 1,
    category: 'economy',
    // 比农民贵一档：它是"把粮食变成金币"的机器，开局押它意味着先不押产能
    cost: 85,
    move: 2,
    atk: 2,
    armor: 1,
    maxHp: 16,
    range: 1,
    vision: 2,
    incomeByTerrain: { city: 0, plain: 0, hill: 0, forest: 0 },
  },
  {
    id: 'quarrier',
    name: '采石工',
    short: '凿',
    era: 3,
    category: 'economy',
    cost: 140,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 24,
    range: 1,
    vision: 2,
    // 丘陵是他吃饭的地方；林地和城郊只是"不至于白跑"
    incomeByTerrain: { hill: 26, forest: 14, plain: 6, city: 6 },
  },
  {
    id: 'minecrew',
    name: '矿队',
    short: '矿',
    era: 4,
    category: 'economy',
    cost: 200,
    move: 2,
    atk: 4,
    armor: 3,
    maxHp: 26,
    range: 1,
    vision: 2,
    incomeByTerrain: { hill: 40, forest: 22, plain: 9, city: 11 },
  },
  {
    id: 'materials',
    name: '建材公司',
    short: '材',
    era: 5,
    category: 'economy',
    cost: 290,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 30,
    range: 1,
    vision: 2,
    // 现代建材不只从山里来：城郊的拆迁料、预制件也算，所以 city 一档给得不低
    incomeByTerrain: { hill: 58, forest: 31, city: 22, plain: 14 },
  },
];

/**
 * 每个建造单位该多会盖什么。
 *
 * 为什么要在这里打补丁而不是直接改 config.ts：`builds` 挂在**建造兵自己**身上，
 * 而本扩展不该改变"没开这个扩展时的劳工会什么"。开局时改本局的兵种表副本，
 * 效果只作用于这一局，原版数据一个字没动。
 *
 * 建材建筑按"谁能盖"分代，就是它的时代门槛：募兵只放本代和上一代，
 * 所以时代 5 的建筑队手上会有全部三种，而时代 3 的劳工只有砖窑。
 */
const EXTRA_BUILDS: Record<string, string[]> = {
  laborer: ['granary'],
  miller: ['quarry', 'granary'],
  engineer: ['quarry', 'granary', 'brickworks'],
  foreman: ['quarry', 'granary', 'brickworks', 'cementworks'],
  crew: ['quarry', 'granary', 'brickworks', 'cementworks', 'materialbase'],
};

export const CITY_WORKS: Expansion = {
  id: 'city-works',
  name: '城郭与物料',
  blurb: '更大的主城，多出粮食与建材。',
  summary:
    '主城扩成 3×3；兵要吃粮、楼要耗材（金币只占零头）。经济单位按**脚下地形**定产什么：' +
    '平原与水域全出粮、城市里全出金、森林丘陵等全出材；牧民粮食与材料各一半。' +
    '**税官**（1 时代可造，最多与当前时代同数）把全场粮材的一成折成金币，' +
    '专门解决"粮材堆成山、金币见底造不出兵"。' +
    '建材产线一路排到现代（采石工→矿队→建材公司，砖窑→水泥厂→建材基地）；' +
    '箭塔改成两回合施工、可驻军、视野更远但打不疼；高山画得更扎眼。',
  scale: 'large',
  // 主城 3×3：地图生成时就要知道，所以写在扩展上而不是开局钩子里
  citySize: 3,
  units: [...NEW_BUILDINGS, ...NEW_ECONOMY_UNITS],
  hooks: {
    // ── 造价：金币三成、资源七成；经济建筑另有减免 ──
    modifyCost: ({ unitType, cost }) => {
      // 前期经济建筑只吃粮食，一分金币都不要——这是"起步靠粮"的那一段
      if (isEarlyEcoBuilding(unitType)) return 0;
      // 经济建筑：金币只占两成（普通单位是三成）。
      // "少要资源"落在两个地方：金币那一份更小，资源那一份也更小——
      // 只减一半的话，回本周期还是被卡在同一个量级。
      const share = isEcoBuilding(unitType) ? ECO_GOLD_SHARE : GOLD_SHARE;
      return Math.max(5, Math.round(cost * share));
    },
    modifyResourceCost: ({ unitType, baseCost }) => {
      // 经济建筑：产什么就吃什么（粮仓吃粮、采石场吃材），建材线因此是自洽的。
      // 时代 1-2 只要六成，而且金币那一份在 modifyCost 里已经免了——
      // 第一座粮仓必须是"攒几回合粮就能盖"，不然没人会在开局押这笔钱。
      if (isEcoBuilding(unitType)) {
        const share = unitType.era <= 2 ? EARLY_ECO_RES_SHARE : ECO_RES_SHARE;
        return { [ecoResOf(unitType)]: Math.max(20, Math.round(baseCost * share)) };
      }
      const share = Math.max(1, Math.round(baseCost * RES_SHARE));
      return isBioUnit(unitType) ? { food: share } : { material: share };
    },

    // ── 产出：经济单位按地形定产什么，税官把粮材换回金币 ──
    //
    // 2026-11-10 用户定口径（旧口径是"金 8 折成粮材，森林丘陵出材、其它出粮"）：
    //   · 牧民：粮食与材料各一半；
    //   · 税官：全场粮+材的一成，折成金币（见 TAX_RATE）；
    //   · 其它经济单位：**全折**，平原/水域出粮、城市出金、剩余地形出材。
    //
    // 旧口径的两条教训留在这儿，别重走：
    //   · 11-04 曾把比例对调成"六成留金"（怕升级城市没钱），结果建材掉三分之一，
    //     金币并没有因此宽裕——支出结构没变，只是把短缺挪了个地方；
    //   · 11-08 反向提到 0.8（折得更狠），金币随即变紧，这才有了 11-10 的税官。
    modifyYield: ({ state, unit, yields }) => {
      const def = state.unitTypes[unit.type];
      if (!def) return yields;

      /*
       * 税官：先算它的收入，再谈别的。
       *
       * 它不吃地形——靠的是"这一方这一回合产了多少粮材"。所以必须在
       * `gold <= 0` 的早退之前处理：它的标准产出表全是 0。
       *
       * 每名税官各抽一份（不是"总数由几个税官平分"）：上限由时代数卡着
       * （见 produceBlocked），"再补一个税官能多收多少"由此变成一个可算的问题。
       */
      if (def.id === TAX_UNIT) {
        const base = taxableOutputOf(state, unit.owner);
        const tax = Math.round(base * TAX_RATE);
        return tax > 0 ? { ...yields, gold: tax } : yields;
      }

      const gold = yields.gold ?? 0;
      if (gold <= 0) return yields;

      const ecoUnit = def.category === 'economy';
      const ecoBuilding = isEcoBuilding(def);
      if (!ecoUnit && !ecoBuilding) return yields;

      const tile = state.tiles[unit.y * state.w + unit.x];
      const terrain = tile?.terrain ?? 'plain';

      /*
       * 水上的东西不参与这套折算。
       *
       * 「城郭」说的是城市补给链：把金币换成粮材，喂给城里的人和工事。
       * 船跑的是贸易、钻井平台卖的是原油——它们离这条链子很远，
       * 而且都是海战包的经济核心（按金/回合定的价），折成粮食等于把它推倒重来。
       * 所以水域经济单位直接放行，保持原样。
       */
      if (def.domain === 'water') return yields;

      // 经济建筑维持原口径：磨坊磨粮、工厂出材，折八成
      if (ecoBuilding) {
        const res = ecoResOf(def);
        const converted = Math.max(1, Math.round(gold * ECO_OUTPUT_SHARE));
        const out = { ...yields };
        out.gold = Math.max(0, gold - converted);
        out[res] = (out[res] ?? 0) + converted;
        return out;
      }

      // 经济单位：全折。产出落到哪种资源只看脚下
      const res = econResAt(def, terrain);
      // 城市里的经济单位原样收金币：那是"城里做买卖"，不是种地
      if (res === 'gold') return yields;

      const out: ResourceCost = { ...yields, gold: 0 };
      if (res === 'mixed') {
        // 牧民：一半口粮、一半皮毛细料；奇数时多出的那一点给材料（牲畜身上能用的更多）
        const food = Math.floor(gold / 2);
        out.food = (out.food ?? 0) + food;
        out.material = (out.material ?? 0) + (gold - food);
      } else {
        out[res] = (out[res] ?? 0) + gold;
      }
      return out;
    },

    // ── 税官的数量上限：等于当前时代 ──
    //
    // 走 `produceBlocked` 而不是在别处拦：这个钩子规则层、面板、AI 三处都认，
    // 面板上直接就是"造不了 + 一句理由"，不会出现"按钮亮着点下去被拒"。
    produceBlocked: ({ state, source, target }) => {
      if (target.id !== TAX_UNIT) return null;
      const owner = source.kind === 'city' ? source.city.owner : source.camp.owner;
      const era = playerEraOf(state, owner);
      const cap = Math.max(1, era);
      const have = state.units.filter(
        (u) => u.owner === owner && u.type === TAX_UNIT && u.hp > 0,
      ).length;
      if (have < cap) return null;
      return `税官最多 ${cap} 个（等于当前时代），已经有 ${have} 个`;
    },

    // ── 开局：改本局的兵种表与城市 ──
    onMatchStart: ({ state }) => {
      // 1) 建造单位多会盖几样东西
      for (const [id, extra] of Object.entries(EXTRA_BUILDS)) {
        const def = state.unitTypes[id];
        if (!def) continue;
        const builds = new Set([...(def.builds ?? []), ...extra]);
        def.builds = Array.from(builds);
      }

      // 2) 建筑数值：更耐打、更会挣、更不还手；防御塔退成"看得远、守得住"
      for (const def of Object.values(state.unitTypes)) {
        if (def.category !== 'building') continue;

        if (FORTS.includes(def.id)) {
          // 削弱进攻、加强防御：射程不动（用户的第二种方案），视野 +2、可驻军、要施工
          def.atk = Math.max(1, Math.round(def.atk * 0.7));
          def.maxHp = Math.round(def.maxHp * 1.4);
          def.armor += 2;
          def.vision += 2;
          def.garrison = true;
          // 城郭包把墙修得更厚，塔也就更难立：点数 ×1.4（本代工兵仍是两回合，
          // 差一点的工兵会明显拖到三回合）。这是"点数"比"回合数"好用的地方——
          // 换工兵有用，而不用给每种塔各写一个回合数。
          def.buildCost = Math.round((def.buildCost ?? Math.max(6, (def.cost ?? 0) / 6)) * 1.4);
          continue;
        }

        // 兵营类：营地画成 2×2 的营垒——原版的营只有一间房，一顶帐篷。
        // 占地是原版接口（UnitTypeDef.footprint），这里只是把它用起来。
        if (isProducer(def)) {
          def.footprint = 2;
          continue;
        }

        // 普通建筑：血更厚一档
        //
        // 经济建筑是**唯一**的例外：它的耐久只加一成（普通建筑是三成半），护甲还要再减一。
        // 以前它跟着一起 +35%，于是"粮仓修在隘口"变成了一个既挡路又挣钱的买卖——
        // 挡五六下才倒、四五个回合回本，防守方几乎不用为堵路付代价。
        // 现在的分工很干脆：能挣钱的，就不耐打。
        const eco = isEcoBuilding(def);
        def.maxHp = Math.round(def.maxHp * (eco ? ECO_HP : 1.35));
        if (eco) {
          // 经济建筑不还手：它的工作是产出，不是打架
          def.atk = 0;
          // 护甲 −1：单看数字是"略微"，但配上"耐久只加一成"之后，
          // 一支二代部队拆粮仓从五下变成四下——够它多撑一回合，不够它当墙。
          def.armor = Math.max(1, def.armor - 1);
          // 收益 +20%
          if (def.income) def.income = Math.round(def.income * 1.2);
          if (def.incomeByTerrain) {
            const next: Record<string, number> = {};
            for (const [k, v] of Object.entries(def.incomeByTerrain)) {
              next[k] = Math.round((v ?? 0) * 1.2);
            }
            def.incomeByTerrain = next as typeof def.incomeByTerrain;
          }
        }
      }

      // 3) 后期经济/工程兵种：略微加强战斗力。
      //    它们本来是"花钱买的产能"，到了后期却连自保都做不到——
      //    给一点攻击和血量，让"带两把工兵铲上前线"这件事不再等于送人头。
      for (const def of Object.values(state.unitTypes)) {
        if (def.era < 3) continue;
        if (def.category !== 'economy' && def.category !== 'builder') continue;
        def.atk += 3;
        def.maxHp += 6;
        if (def.era >= 4) def.armor += 1;
      }

      // 4) 主城：血更厚（城市是这一局的核心，3×3 的城不该比 2×2 的还脆）
      for (const city of state.cities) {
        city.maxHp = Math.round(city.maxHp * 1.5);
        city.hp = city.maxHp;
      }

      // 5) 场上已有的建筑按新上限补血（开局就有城郊设施的场景、读档后的沙盒）
      for (const u of state.units) {
        const def = state.unitTypes[u.type];
        if (!def) continue;
        if (def.category === 'building' && u.hp > def.maxHp) u.hp = def.maxHp;
      }

      // 6) 起步的一点粮和材：不然第一个兵都造不出来（造价已经不是纯金币了）。
      //    按时代给，是因为高时代开局的兵更贵、吃粮更多：
      //    固定 60 粮在青铜够用五六个民兵，在蒸汽连一个步枪兵都不够。
      for (const p of seatsOf(state)) {
        const player = state.players[p];
        player.res = { ...(player.res ?? {}) };
        player.res.food = (player.res.food ?? 0) + 80 + state.config.startEra * 60;
        player.res.material = (player.res.material ?? 0) + 50 + state.config.startEra * 40;
      }
      state.log.push({
        turn: state.turn,
        player: 'A',
        text: '城郭与物料：主城扩为 3×3，兵吃粮、楼耗材，箭塔改为两回合施工且可驻军；建材产线排到现代',
      });
    },
  },
};
