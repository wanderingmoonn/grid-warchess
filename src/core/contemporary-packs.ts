/**
 * 第六时代的两个包：一个是"这一代的底座"，一个是在它之上加料。
 *
 * ---------------------------------------------------------------
 * 为什么是这么分的
 * ---------------------------------------------------------------
 * 前五个时代的样子是同一套：**原版给那一代几个最基本的兵**（步兵班、坦克、火炮、
 * 经济单位、工兵、碉堡、工业园……），**时代兵种包再往上加十几个专精兵**
 * （伞兵、突击队、喀秋莎、重型坦克……）。见 config.ts 的 UNIT_TYPES 与 era-packs.ts。
 *
 * 第六时代在基础规则里是**空的**（见 config.ts 的 BASE_MAX_ERA）：既没有那一行科技，
 * 也没有那一代的兵。所以照同样的分法补两个包：
 *
 *   「现代」     `pack-contemporary`     解锁第六时代 + 9 个**最基本的兵**
 *   「现代战争」 `pack-contemporary-war` 在它之上再加 15 个专精兵（requires 前者）
 *
 * 这就是"底座 + 加料"的关系，和"原版 fifth-era 兵 + pack-modern"完全同构：
 * 只勾「现代」，第六时代是一个能自己打完一整局的完整代际（有步兵、坦克、炮、
 * 经济、工程、工事、军营）；再勾「现代战争」，这一代才多出直升机、无人机、
 * 反坦克导弹、火箭炮、防空导弹这些"专精解法"。
 *
 * 「现代战争」写 `requires: ['pack-contemporary']`：单独勾它整包不进场
 * （开局面板会自动把底座补上）。理由和奇幻系列的「奇想·法则」前置一样——
 * 一个"勾了却造不出来"的兵种包，在玩家眼里就是坏了。
 *
 * ---------------------------------------------------------------
 * 数值口径
 * ---------------------------------------------------------------
 * 沿用 era-packs.ts 那套粗指标（有效耐久 EHP = maxHp + 2 × armor）：
 *
 *   底座的战斗单位 0.17~0.27 —— 和原版二战（0.16~0.32）同带，
 *              因为底座就是"这一代的常态化配置"，不该比上一代更划算或更亏。
 *   加料的战斗单位 0.12~0.24 —— 压在带的下沿，即"更专不更强"：
 *              反坦克导弹 0.12（挨一下就散）换两发带走一辆坦克；
 *              主战坦克 0.24 换全包最难啃的正面。
 *   经济与工程兵不在这条带里（都在 0.13 上下）：它们卖的是产出和工事，
 *              不是耐久；拿耐久去比，粮仓永远"不划算"，这是口径问题不是数值问题。
 *   工事也不在这条带里：墙和地堡从来是"每金耐久极高、但一点用都没有"的东西
 *              （二战第五环 1.21，第六环 1.17），比的是"这条路值不值这些钱"。
 *
 * **射程没有加到 6。** 二战包的火箭炮与自行火炮都因为射程 5 以上被打回过
 * （era-packs.ts 里留着那几段"病根不是攻击而是射程"），所以第六代陆炮还是 5：
 * 这一代的进步写在溅射、连发、对空和空中层上，不写在"更远"上。
 *
 * 一条硬约束：`era: 6` 的单位**不会**被开局白送（setup.ts 只白送 era 1 的战斗单位），
 * 也不会在第五时代的城市里出现（rules 的招募门槛按城市时代判）。
 *
 * ---------------------------------------------------------------
 * 兵种尽量按现实来
 * ---------------------------------------------------------------
 * 名字全部用编制名/装备类名，不用虚构代号：
 *
 *   底座：步兵班 / 坦克 / 榴弹炮 / 装甲侦察车 / 物流中心 / 工程兵 /
 *         混凝土碉堡 / 产业园 / 联合作战中心
 *   加料：机械化步兵（IFV 搭载的步兵班）/ 主战坦克（125mm 滑膛炮，尾翼稳定脱壳穿甲弹）/
 *         反坦克导弹（ATGM，先手伏击）/ 特种部队（小队渗透）/ 自行榴弹炮（155mm）/
 *         远程火箭炮（300mm 多管）/ 防空导弹营（车载区域防空）/ 武装直升机 /
 *         察打无人机（高空长航时）/ 导弹驱逐舰 / 复合装甲墙（城墙线第六环）/
 *         加固地堡（连发机关炮）/ 前进指挥所 / 物流集团 / 工程兵团
 */

import { DAMAGE_STAGE } from './ability-hooks.ts';
import type { AbilityDef } from './abilities.ts';
import type { Expansion } from './expansions.ts';
import type { UnitTypeDef } from './types.ts';

/* ================================================================== */
/* 能力：对空                                                          */
/* ================================================================== */

/**
 * 「对空」——只在对飞行单位开火时加成（属于「现代战争」，底座不带这条）。
 *
 * 为什么这条能力一定要有：`layer: 'air'` 的单位会绕开一切地形（河、山、林），
 * 而地面近战**够不着它**（`strikeDistance` 给"地面打空中"多算一格，
 * 射程 1 的单位因此打不到头顶的直升机）。这是空中单位的卖点，
 * 但没有专门的解法，它就变成"谁有飞行谁赢"。
 *
 * 现实的解法就是防空导弹：所以这里让它**只**对飞行目标 ×1.6，对地面照旧。
 * 加成放在 postRange 段（射程折扣已经算完、减护甲还没开始），
 * 这样它和「长短皆可」那种"距离折扣"不会互相吃掉。
 *
 * 注意它乘的是**攻击力**，不是最终伤害：46 × 1.6 ＝ 74，再减目标的护甲。
 * 所以一架装甲 6 的直升机吃 68，而装甲 17 的坦克吃 29（没有加成）。
 * 这是刻意的——对空是"打得更准"，不是"无视装甲"。
 */
const ANTI_AIR = 1.6;

const MODERN_ABILITIES: AbilityDef[] = [
  {
    id: 'anti-air',
    name: '对空',
    summary: '打飞行单位（直升机、无人机、飞行兵种）时攻击 ×1.6（护甲照常扣）；打地面目标没有加成。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.postRange,
          apply: (c) => {
            if (c.side !== 'attacker' || !c.foe) return;
            const def = c.api.utype(c.state, c.foe.type);
            const flying =
              def.layer === 'air' ||
              c.api.hasAbility(c.state, c.foe, 'fly-over') ||
              c.api.hasAbility(c.state, c.foe, 'fly');
            if (flying) c.damage = Math.round(c.damage * ANTI_AIR);
          },
        },
      ],
    },
  },
];

/* ================================================================== */
/* 时代 6 · 现代 · 底座（9 个最基本的兵）                              */
/* ================================================================== */

/**
 * 这一组就是"原版第六代"该有的样子。
 *
 * 对着二战（原版 era 5）那七个一条一条往上加一格：步兵班 47→50 攻、坦克 56→60、
 * 火炮 47→50、农业公司 → 物流中心、建筑队 → 工程兵、碉堡 → 混凝土碉堡、
 * 工业园 → 产业园；另外补两样这一代少不了的东西——装甲侦察车（原版侦察停在二战
 * 之前的视野 3）和联合作战中心（军营链条的第六档，不然前线基地升不了级）。
 *
 * 它们比「现代战争」里那些专精兵**便宜、平庸、但没有短板**：
 * 一个只开「现代」的玩家，用这一组能打完一整局，只是没有"解法"。
 */
const CONTEMPORARY_BASE: UnitTypeDef[] = [
  // ---- 战斗 ----
  {
    // 步兵班：这一代的"民兵位置"。什么都行、什么都不突出。
    // 射程 3（二战步兵班是 4，但那一代的步兵班本来就是"带机枪的班"，
    // 这里给 3 是为了给「现代战争」的机械化步兵留出升级空间）。
    id: 'ct_infantry',
    name: '步兵班',
    short: '班',
    era: 6,
    category: 'combat',
    cost: 340,
    move: 2,
    atk: 50,
    armor: 5,
    maxHp: 52,
    range: 3,
    vision: 4,
  },
  {
    // 坦克：这一代的主力装甲。护甲 12 比二战坦克（10）厚一档，
    // 但破甲与攻坚都在「现代战争」的主战坦克那里——底座只保证"能顶正面"。
    id: 'ct_tank',
    name: '坦克',
    short: '坦',
    era: 6,
    category: 'combat',
    cost: 450,
    move: 3,
    atk: 60,
    armor: 12,
    maxHp: 96,
    range: 3,
    vision: 3,
    abilities: ['shield-wall', 'siege-master'],
    bio: false,
  },
  {
    // 榴弹炮：射程 5 + 溅射 2，和二战的火炮同一个位置，只是各项都高一档。
    // 视野 2：它打的是"友军报来的坐标"。
    id: 'ct_howitzer',
    name: '榴弹炮',
    short: '炮',
    era: 6,
    category: 'combat',
    cost: 360,
    move: 2,
    atk: 50,
    armor: 5,
    maxHp: 56,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
    bio: false,
  },
  {
    // 装甲侦察车：视野 5 是这个底座唯一的"眼睛"。
    // 攻低（34）、血薄，价值全在"看得见"——原版到二战为止视野都没超过 3。
    id: 'ct_recon',
    name: '装甲侦察车',
    short: '侦',
    era: 6,
    category: 'combat',
    cost: 320,
    move: 4,
    atk: 34,
    armor: 6,
    maxHp: 44,
    range: 2,
    vision: 5,
    bio: false,
  },

  // ---- 经济与工程 ----
  {
    // 物流中心：底座的赚钱单位。平原最赚（38），和农业公司（36）同一个位置。
    id: 'ct_logistics',
    name: '物流中心',
    short: '物',
    era: 6,
    category: 'economy',
    cost: 300,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 32,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 38, city: 26, forest: 15, hill: 13 },
  },
  {
    // 工程兵：盖底座的三种建筑 + 全部桥 + 第六代军营。
    // buildPower 36（二战建筑队 32），一座碉堡两回合起。
    id: 'ct_sapper',
    name: '工程兵',
    short: '工',
    era: 6,
    category: 'builder',
    cost: 300,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 32,
    range: 1,
    vision: 2,
    buildPower: 36,
    builds: ['ct_pillbox', 'ct_industrial', 'bridge', 'bridge2', 'bridge3', 'camp6'],
  },

  // ---- 建筑 ----
  {
    // 混凝土碉堡：底座的固定火力。自动开火、射程 4，
    // 比二战碉堡（36 攻 / 13 甲 / 86 血）各项各高一档。
    id: 'ct_pillbox',
    name: '混凝土碉堡',
    short: '碉',
    era: 6,
    category: 'building',
    cost: 370,
    buildCost: 64,
    move: 0,
    atk: 34,
    armor: 13,
    maxHp: 88,
    range: 4,
    vision: 3,
    autoAttack: true,
  },
  {
    // 产业园：底座的经济建筑。城里有市场、平原是厂区，两头都能站
    // （二战工业园是"平原 34 / 城 22"，这里把两头拉平一点）。
    id: 'ct_industrial',
    name: '产业园',
    short: '园',
    era: 6,
    category: 'building',
    cost: 420,
    buildCost: 60,
    move: 0,
    atk: 5,
    armor: 9,
    maxHp: 64,
    range: 1,
    vision: 2,
    incomeByTerrain: { city: 26, plain: 24, forest: 10, hill: 10 },
  },
  {
    // 联合作战中心：兵营链条的第六档（军营→寨垒→堡寨→兵站→前进基地→这里）。
    // 和前面五档一样取"落成时最近城市的时代"，所以想要第六代兵，
    // 就得把城升到第六时代之后再造它。
    id: 'camp6',
    name: '联合作战中心',
    short: '联',
    era: 6,
    category: 'building',
    cost: 380,
    buildCost: 40,
    move: 0,
    atk: 22,
    armor: 10,
    maxHp: 92,
    range: 1,
    vision: 6,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
];

/* ================================================================== */
/* 时代 6 · 现代 · 加料（15 个专精兵）                                 */
/* ================================================================== */

const CONTEMPORARY_WAR: UnitTypeDef[] = [
  // ---- 陆军：步兵与装甲 ----
  {
    // 机械化步兵：坐在步兵战车里行军、下车作战的步兵班。
    // 比底座的步兵班（340 金 / 50 攻 / 52 血）更贵更硬，射程同为 3。
    id: 'cnt_mechinf',
    name: '机械化步兵',
    short: '机',
    era: 6,
    category: 'combat',
    cost: 380,
    move: 3,
    atk: 54,
    armor: 7,
    maxHp: 62,
    range: 3,
    vision: 4,
  },
  {
    // 主战坦克：底座坦克的"上一档"——破甲（尾翼稳定脱壳穿甲弹）＋ 破城。
    // 640 金是全包最贵的地面单位，换来的是"正面几乎无解"。
    id: 'cnt_mbt',
    name: '主战坦克',
    short: '主',
    era: 6,
    category: 'combat',
    cost: 640,
    move: 3,
    atk: 78,
    armor: 17,
    maxHp: 120,
    range: 3,
    vision: 3,
    abilities: ['armor-pierce', 'siege-master'],
    bio: false,
  },
  {
    // 反坦克导弹分队：三个人扛一具发射器，埋伏在半路等装甲。
    // 先手（first-strike）＋ 破甲，是"坦克杀手"这件事唯一诚实的写法：
    // 它一被摸到就散（护甲 3、血 42），所以卖的是"谁先看见谁先动手"。
    id: 'cnt_atgm',
    name: '反坦克导弹',
    short: '反',
    era: 6,
    category: 'combat',
    cost: 400,
    move: 2,
    atk: 66,
    armor: 3,
    maxHp: 42,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce', 'first-strike'],
  },
  {
    // 特种部队：小队渗透，靠潜行（森林/丘陵）摸到后排。
    // 血薄、射程短，但它能在对面看不见的地方出现——这是它 460 金的理由。
    id: 'cnt_specops',
    name: '特种部队',
    short: '特',
    era: 6,
    category: 'combat',
    cost: 460,
    move: 4,
    atk: 56,
    armor: 5,
    maxHp: 52,
    range: 3,
    vision: 5,
    abilities: ['stealth'],
  },

  // ---- 陆军：炮兵与防空 ----
  {
    // 自行榴弹炮：155mm，射程 5、溅射 2。比底座的榴弹炮贵 140 金，
    // 换来的是攻 50→60、血 56→64，以及"能跟着装甲一起挪"。
    id: 'cnt_sph',
    name: '自行榴弹炮',
    short: '榴',
    era: 6,
    category: 'combat',
    cost: 500,
    move: 2,
    atk: 60,
    armor: 6,
    maxHp: 64,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
    bio: false,
  },
  {
    // 远程火箭炮：300mm 多管，一发覆盖三格（splash 3）。
    // 攻击力压到 40：它清的是"挤在一起的一堆轻甲"，打单体远不如自行榴弹炮。
    id: 'cnt_mlrs',
    name: '远程火箭炮',
    short: '箭',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 2,
    atk: 40,
    armor: 4,
    maxHp: 56,
    range: 5,
    vision: 2,
    splash: 3,
    abilities: ['siege-master'],
    bio: false,
  },
  {
    // 防空导弹营：车载区域防空。对地面仍有 46 攻（自卫），
    // 但对空是 46 × 1.6 ＝ 74 —— 一架 520 金的直升机挨两发就没了。
    id: 'cnt_sam',
    name: '防空导弹营',
    short: '防',
    era: 6,
    category: 'combat',
    cost: 440,
    move: 2,
    atk: 46,
    armor: 4,
    maxHp: 58,
    range: 5,
    vision: 5,
    abilities: ['anti-air'],
    bio: false,
  },

  // ---- 空中 ----
  {
    // 武装直升机：反坦克导弹 + 机炮。layer air = 与地面互不占格，
    // flight = 能掠过水面（河防对它不成立）。
    // 它的天敌是防空导弹（对空 ×1.6）——这条克制关系是整个包的骨架。
    id: 'cnt_heli',
    name: '武装直升机',
    short: '直',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 5,
    atk: 58,
    armor: 6,
    maxHp: 66,
    range: 4,
    vision: 5,
    abilities: ['armor-pierce'],
    flight: true,
    layer: 'air',
    bio: false,
  },
  {
    // 察打无人机：高空长航时。视野 6 是它的主武器，
    // 攻击 34 只够点掉落单的炮兵和工程队——让它能打，但打不疼。
    id: 'cnt_uav',
    name: '察打无人机',
    short: '无',
    era: 6,
    category: 'combat',
    cost: 300,
    move: 4,
    atk: 34,
    armor: 2,
    maxHp: 32,
    range: 5,
    vision: 6,
    flight: true,
    layer: 'air',
    bio: false,
  },

  // ---- 海军 ----
  {
    // 导弹驱逐舰：区域防空 + 反舰，水上唯一能和岸防火力对射的东西。
    // 射程 5、视野 6 是水面上的顶配，代价是 620 金、而且只有临水的城能造。
    id: 'cnt_destroyer',
    name: '导弹驱逐舰',
    short: '驱',
    era: 6,
    category: 'combat',
    cost: 620,
    move: 5,
    atk: 70,
    armor: 13,
    maxHp: 120,
    range: 5,
    vision: 6,
    domain: 'water',
    abilities: ['armor-pierce'],
    bio: false,
  },

  // ---- 工事 ----
  {
    // 复合装甲墙：城墙线第六环（夯土 → 石墙 → 棱堡 → 混凝土胸墙 → 混凝土掩体墙 → 这里）。
    // 240 金换 240 血 + 20 护甲，比同价战斗单位耐得多，但一步都走不了。
    id: 'cnt_armorwall',
    name: '复合装甲墙',
    short: '壁',
    era: 6,
    category: 'building',
    cost: 240,
    move: 0,
    atk: 0,
    armor: 20,
    maxHp: 240,
    range: 1,
    vision: 1,
    obstacle: true,
  },
  {
    // 加固地堡：底座混凝土碉堡的"上一档"——连发机关炮（burst 4）＋ 更厚的墙。
    // burst 4 的代价写在伤害公式里：每一下单独减护甲，打重甲等于白打。
    id: 'cnt_bunker',
    name: '加固地堡',
    short: '堡',
    era: 6,
    category: 'building',
    cost: 420,
    buildCost: 66,
    move: 0,
    atk: 36,
    armor: 16,
    maxHp: 100,
    range: 4,
    vision: 3,
    burst: 4,
    autoAttack: true,
  },
  {
    // 前进指挥所：不还手，但给相邻友军 +2 攻（指挥光环）、
    // 站上去的部队多 3 点护甲（可驻军），视野 6。
    // 它的价值不在自己打，而在"把一片阵地变硬"。
    id: 'cnt_hq',
    name: '前进指挥所',
    short: '所',
    era: 6,
    category: 'building',
    cost: 400,
    buildCost: 50,
    move: 0,
    atk: 0,
    armor: 11,
    maxHp: 96,
    range: 1,
    vision: 6,
    garrison: true,
    abilities: ['aura-command'],
  },

  // ---- 经济与工程 ----
  {
    // 物流集团：底座物流中心的"上一档"——平原 40（底座 38）、城里 26，
    // 换的是 +30 金与 +2 血 +2 甲，多出来的这点值不值全看你要不要在前线养人。
    id: 'cnt_logistics',
    name: '物流集团',
    short: '集',
    era: 6,
    category: 'economy',
    cost: 330,
    move: 3,
    atk: 4,
    armor: 4,
    maxHp: 34,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 40, city: 26, forest: 16, hill: 14 },
  },
  {
    // 工程兵团：盖"加料"的三种工事 + 钢桥，不碰底座的建筑（那是工程兵的活）。
    // buildPower 40 —— 比底座工程兵的 36 高一头，一座复合装甲墙一回合起。
    id: 'cnt_engineer',
    name: '工程兵团',
    short: '团',
    era: 6,
    category: 'builder',
    cost: 320,
    move: 2,
    atk: 6,
    armor: 5,
    maxHp: 34,
    range: 1,
    vision: 2,
    buildPower: 40,
    builds: ['cnt_armorwall', 'cnt_bunker', 'cnt_hq', 'bridge3'],
  },
];

/* ================================================================== */
/* 注册                                                                */
/* ================================================================== */

/**
 * 「现代」——这一代的原版底座：解锁时代 + 9 个最基本的兵。
 *
 * 它自己就是一道完整的代际（步兵、坦克、炮、侦察、经济、工程、工事、军营），
 * 只开它也能打完一整局，只是没有"解法"——解在「现代战争」里。
 */
export const CONTEMPORARY_BASE_PACK: Expansion = {
  id: 'pack-contemporary',
  name: '现代',
  scale: 'large',
  summary:
    '第六时代「现代」的底座：解锁这一级科技（升级费 1080，城市耐久 96、护甲 14、收入 62），' +
    '并给出这一代最基本的 9 个兵——步兵班、坦克、榴弹炮、装甲侦察车、物流中心、工程兵、' +
    '混凝土碉堡、产业园与联合作战中心。想要这一代的专精兵，再勾「现代战争」。',
  /**
   * 这一条就是"第六时代"的开关。
   * 不写它，ERAS 里那一行只是数值（见 config.ts 的 BASE_MAX_ERA）。
   */
  unlockEra: 6,
  hooks: {},
  units: CONTEMPORARY_BASE,
};

/**
 * 「现代战争」——在底座之上再加 15 个专精兵。
 *
 * `requires` 硬挂在底座上：单独勾它整包不进场，开局面板会自动把「现代」补上。
 * 时代开关只在底座那一处，这里不重复写（一格里两扇门，改起来迟早漏一个）。
 */
export const MODERN_WARFARE: Expansion = {
  id: 'pack-contemporary-war',
  name: '现代战争',
  scale: 'large',
  summary:
    '第六代的专精兵：机械化步兵、主战坦克、反坦克导弹、特种部队、自行榴弹炮、远程火箭炮、' +
    '防空导弹营、武装直升机、察打无人机、导弹驱逐舰，外加复合装甲墙、加固地堡、前进指挥所、' +
    '物流集团与工程兵团。需要先开「现代」。',
  requires: ['pack-contemporary'],
  hooks: {},
  abilities: MODERN_ABILITIES,
  units: CONTEMPORARY_WAR,
};
