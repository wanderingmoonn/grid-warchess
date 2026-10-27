/**
 * 奇想兵种包：五个扩展规则，一套法则。
 *
 * 拆成五个而不是一个大包，理由不是"文件太长"，是**玩家的选择粒度**：
 *   · 法则（fantasy-core）  只有机制，没有兵。它是另外四个的前置。
 *   · 骑士团（knights）     人类阵营：前排、骑兵、圣职、刺客。
 *   · 荒兽（beasts）        兽群、飞行、蛮荒、元素之外的野性。
 *   · 秘法（arcane）        法术、亡者、召唤、属性元素。
 *   · 英雄（heroes）        五个全场唯一、首次招募要解锁的大家伙。
 *
 * 为什么要有前置包：魔法攻击、魔法抗性、属性伤害、负面状态、空中层
 * 这五条是**规则**不是兵种。单开一个兵种包，玩家会以为自己买到的是一堆
 * 数值更高的兵，实际上拿到的是半套规则（有魔攻、没魔抗；能飞、不能叠）。
 * 把法则做成一个显式的、必须勾选的前置，成本几乎为零，语义却干净了。
 *
 * 数值口径（和内置兵种对照，别拿"感觉"当平衡）：
 *   用一个粗糙的价值模型 V = 攻 + 0.45×血 + 5×甲 + 3×射程 + 2.5×移 + 1.5×视野
 *   （连击按 攻×(1+0.5×(段数−1))、溅射 +4 计），再看 V/造价：
 *     古典民兵 1.86、中世长枪 0.91、火药戟兵 0.81、火枪 0.58、工业步枪 0.45。
 *   便宜兵天然更"值"，这是被 24 人编制上限压着的设计，不是漏洞。
 *   所以这里每个兵只跟**同代**比：中世 0.55~0.75、火药 0.45~0.65、
 *   工业 0.40~0.50、现代 0.30~0.40。带强机制的再往下压一档，
 *   因为机制的价值不进这个模型。
 *
 * 换来的机制必须是"有代价的"：
 *   飞行要算落点、掠空会和地面叠在一格（被打时也一样）、
 *   冲锋要先动过、狂暴要掉到半血、追猎要拉开距离、重甲难行怕林子、
 *   召唤物占不了编制却也不能当主力、英雄贵在解锁而不是贵在面板。
 */

import type { Expansion } from './expansions.ts';
import type { UnitTypeDef } from './types.ts';

/** 召唤物与临时建筑。它们不进产线、不占编制，所以单独放一个数组。 */
export const SUMMONED_UNITS: UnitTypeDef[] = [
  {
    id: 'skeleton',
    name: '骷髅',
    short: '骷',
    era: 2,
    category: 'combat',
    cost: 45,
    move: 3,
    atk: 9,
    armor: 1,
    maxHp: 14,
    range: 1,
    vision: 3,
    summonedOnly: true,
  },
  {
    id: 'slimelet',
    name: '小史莱姆',
    short: '滴',
    era: 2,
    category: 'combat',
    cost: 20,
    move: 2,
    atk: 6,
    armor: 0,
    maxHp: 12,
    range: 1,
    vision: 2,
    summonedOnly: true,
    weak: { fire: 2 },
  },
  {
    id: 'imp',
    name: '小恶魔',
    short: '魔',
    era: 3,
    category: 'combat',
    cost: 55,
    move: 5,
    atk: 12,
    armor: 1,
    maxHp: 16,
    range: 1,
    vision: 4,
    summonedOnly: true,
    flight: true,
    layer: 'air',
  },
  {
    id: 'phantom',
    name: '幻象',
    short: '幻',
    era: 2,
    category: 'combat',
    cost: 40,
    move: 3,
    atk: 14,
    armor: 0,
    maxHp: 18,
    range: 1,
    vision: 3,
    summonedOnly: true,
  },
  // 土墙：土元素每回合立一道。障碍 + 自损，四回合后自己塌，
  // 所以它是"临时封路"而不是"永久改建地图"。
  {
    id: 'earth-wall',
    name: '土墙',
    short: '墙',
    era: 2,
    category: 'building',
    cost: 40,
    move: 0,
    atk: 0,
    armor: 8,
    maxHp: 20,
    range: 1,
    vision: 1,
    summonedOnly: true,
    obstacle: true,
    decays: 5,
  },
];

const CORE: Expansion = {
  id: 'fantasy-core',
  scale: 'large',
  name: '奇想·法则',
  summary:
    '奇想兵种的前置包（本身不带兵）：开启「魔法攻击 / 魔法抗性」「属性伤害与弱点」「中毒·点燃·减速·诅咒」四类负面状态，以及「空中层」——掠空单位可以和地面单位站在同一格。另外四个奇想兵种包都要先开它。',
  hooks: {
    onMatchStart: ({ state }) => {
      // 法则包自己不需要改任何数值，它只是"允许这些字段生效"。
      // 留一条开局战报，是为了让玩家在战报里能确认自己确实开了它。
      state.log.push({
        turn: 1,
        player: 'A',
        text: '奇想法则生效：魔法攻击/魔抗、属性伤害、负面状态、空中层',
      });
    },
  },
};

const KNIGHTS: Expansion = {
  id: 'fantasy-knights',
  scale: 'large',
  name: '奇想·骑士团',
  summary:
    '人类的十二个兵种：剑士、皇家骑兵、游侠、超级重骑、牧师、法师、刺客、狂战士、圣骑士、皇家守卫、盗贼、符文守卫。有魔法、有治疗、有隐身，也有最硬的一块肉。需先开「奇想·法则」。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 2 级：四种完全不同的"怎么站住" ────────────────────────────────────
    // 剑士是这一档的尺子：便宜、能顶、没有花招。别的兵和它比价格。
    {
      id: 'swordsman',
      name: '剑士',
      short: '剑',
      era: 2,
      category: 'combat',
      cost: 70,
      move: 2,
      atk: 14,
      armor: 4,
      maxHp: 40,
      range: 1,
      vision: 2,
      abilities: ['shield-wall'],
    },
    // 皇家骑兵：4 移动 + 冲锋。它的价值不在面板，在"能挑最软的那一格下手"。
    {
      id: 'royal-cavalry',
      name: '皇家骑兵',
      short: '皇',
      era: 2,
      category: 'combat',
      cost: 125,
      move: 4,
      atk: 16,
      armor: 4,
      maxHp: 40,
      range: 1,
      vision: 3,
      abilities: ['charge'],
    },
    // 游侠：唯一一个"进了林子变强"的远程。走位就是它的护甲。
    {
      id: 'ranger',
      name: '游侠',
      short: '侠',
      era: 2,
      category: 'combat',
      cost: 95,
      move: 3,
      atk: 13,
      armor: 2,
      maxHp: 26,
      range: 3,
      vision: 4,
      abilities: ['forest-walk', 'woodland'],
    },
    // 牧师：不打人，管两件事——回血、洗状态。这两个动作在后期都很贵。
    {
      id: 'priest',
      name: '牧师',
      short: '牧',
      era: 2,
      category: 'combat',
      cost: 105,
      move: 2,
      atk: 9,
      armor: 2,
      maxHp: 30,
      range: 2,
      vision: 4,
      magicAtk: 6,
      magicRes: 3,
      element: 'light',
      abilities: ['heal-aura', 'purge'],
    },
    // 盗贼：攻城顺手捞钱。它存在的意义是让"打不动城墙"也有一点回报。
    {
      id: 'thief',
      name: '盗贼',
      short: '贼',
      era: 2,
      category: 'combat',
      cost: 85,
      move: 3,
      atk: 13,
      armor: 2,
      maxHp: 26,
      range: 1,
      vision: 4,
      abilities: ['stealth', 'steal-gold'],
    },
    // ── 3 级 ──────────────────────────────────────────────────────────────
    // 超级重骑：8 甲 62 血，还能冲锋。代价是森林/丘陵/城市的进入消耗翻倍——
    // 平地上它是墙，进了林子它是靶子。这条地形代价比削数值更能定性。
    {
      id: 'cataphract',
      name: '超级重骑',
      short: '重',
      era: 3,
      category: 'combat',
      cost: 205,
      move: 4,
      atk: 24,
      armor: 8,
      maxHp: 62,
      range: 1,
      vision: 3,
      abilities: ['charge', 'slow-offroad'],
    },
    // 法师：魔攻 18 不吃护甲。打重甲是主力，被骑兵贴上是提款机。
    {
      id: 'mage',
      name: '法师',
      short: '法',
      era: 3,
      category: 'combat',
      cost: 150,
      move: 2,
      atk: 7,
      armor: 1,
      maxHp: 24,
      range: 3,
      vision: 4,
      magicAtk: 18,
      element: 'arcane',
      splash: 1,
    },
    // 刺客：隐匿 + 26 攻。它的强不在换血，在"先手选一个软的打掉"。
    {
      id: 'assassin',
      name: '刺客',
      short: '刺',
      era: 3,
      category: 'combat',
      cost: 135,
      move: 4,
      atk: 26,
      armor: 2,
      maxHp: 28,
      range: 1,
      vision: 3,
      abilities: ['vanish'],
    },
    // 狂战士：半血之后才是它。逼对手在"打死它"和"被它多换一个"之间选。
    {
      id: 'berserker',
      name: '狂战士',
      short: '狂',
      era: 3,
      category: 'combat',
      cost: 120,
      move: 3,
      // 狂暴从 +25% 提到 +50% 之后，基础攻击要往下压一截：
      // 满血时它该是"全场最差的兵"，半血才翻盘。数字上大致是
      // 半血那一刀和改动前持平，满血那一刀矮了三点。
      atk: 19,
      armor: 2,
      maxHp: 44,
      range: 1,
      vision: 3,
      abilities: ['berserk'],
    },
    // 圣骑士：全游戏唯一"边挡边奶"的兵。数值不高，但一条线有它就是另一条线。
    {
      id: 'paladin',
      name: '圣骑士',
      short: '圣',
      era: 3,
      category: 'combat',
      cost: 215,
      move: 3,
      atk: 24,
      armor: 7,
      maxHp: 58,
      range: 1,
      vision: 3,
      magicAtk: 5,
      magicRes: 4,
      element: 'light',
      abilities: ['aura-armor', 'heal-aura'],
    },
    // 符文守卫：不打架，修城。城被打到 5 点耐久的时候，它一人顶一次防守。
    {
      id: 'rune-guardian',
      name: '符文守卫',
      short: '符',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 2,
      atk: 18,
      armor: 6,
      maxHp: 50,
      range: 1,
      vision: 3,
      magicRes: 5,
      abilities: ['repair', 'shield-wall'],
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    // 皇家守卫：唯一一个"炮打不动"的兵。它针对的就是溅射体系。
    {
      id: 'royal-guard',
      name: '皇家守卫',
      short: '卫',
      era: 4,
      category: 'combat',
      cost: 255,
      move: 2,
      atk: 26,
      armor: 10,
      maxHp: 66,
      range: 1,
      vision: 2,
      abilities: ['aoe-immune', 'shield-wall'],
    },
  ],
};

const BEASTS: Expansion = {
  id: 'fantasy-beasts',
  scale: 'large',
  name: '奇想·荒兽',
  summary:
    '二十个野性单位：狼骑士、蜘蛛骑士、蛇人、毒蝙蝠、树人、食人魔、双头巨人、半人马、牛头人、巨魔、狼人、史莱姆、哥布林陷阱师、石像鬼、鹰身女妖、狮鹫骑士、龙骑兵、骷髅飞龙。便宜的快、贵的硬，怕火的特别多。需先开「奇想·法则」。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 2 级：便宜、快、脆，靠数量和时间差 ────────────────────────────────
    {
      id: 'wolf-rider',
      name: '狼骑士',
      short: '狼',
      era: 2,
      category: 'combat',
      cost: 55,
      move: 4,
      atk: 11,
      armor: 1,
      maxHp: 24,
      range: 1,
      vision: 4,
      // 便宜、快、不值钱：它不靠打架赢，靠"林子拦不住它"赢。
      abilities: ['forest-walk'],
    },
    // 蜘蛛骑士：无视地形（能掠水、林子丘陵按 1 步）。追不上的侦察。
    // 挂的是「跳跃」不是「飞行」——蜘蛛是跳过去，不是飞过去，名字得跟画面一致。
    {
      id: 'spider-rider',
      name: '蜘蛛骑士',
      short: '蛛',
      era: 2,
      category: 'combat',
      cost: 78,
      move: 4,
      atk: 13,
      armor: 2,
      maxHp: 28,
      range: 1,
      vision: 6,
      abilities: ['leap'],
    },
    {
      id: 'serpent-man',
      name: '蛇人',
      short: '蛇',
      era: 2,
      category: 'combat',
      cost: 95,
      move: 3,
      atk: 15,
      armor: 3,
      maxHp: 34,
      range: 1,
      vision: 3,
      abilities: ['poison-hit'],
    },
    // 毒蝙蝠：三段 + 中毒。打轻甲是 3×4，打重甲是 3×1，天生怕硬。
    {
      id: 'poison-bat',
      name: '毒蝙蝠',
      short: '蝠',
      era: 2,
      category: 'combat',
      cost: 90,
      move: 5,
      atk: 7,
      armor: 1,
      maxHp: 22,
      range: 1,
      vision: 5,
      burst: 3,
      flight: true,
      layer: 'air',
      abilities: ['poison-hit'],
    },
    {
      id: 'centaur',
      name: '半人马',
      short: '人',
      era: 2,
      category: 'combat',
      cost: 105,
      move: 4,
      atk: 13,
      armor: 2,
      maxHp: 30,
      range: 3,
      vision: 4,
      // 机动射手：会跑还要会站。身边干净时那一箭才准。
      abilities: ['kite'],
    },
    // 史莱姆：打死它要花两下，因为第一下只把它变成两只小的。
    {
      id: 'slime',
      name: '史莱姆',
      short: '史',
      era: 2,
      category: 'combat',
      cost: 60,
      move: 2,
      atk: 9,
      armor: 1,
      maxHp: 36,
      range: 1,
      vision: 2,
      abilities: ['split'],
      splitInto: 'slimelet',
      weak: { fire: 2 },
    },
    // 哥布林陷阱师：不靠数值，靠"你敢不敢贴上来"。
    {
      id: 'goblin-trapper',
      name: '哥布林陷阱师',
      short: '陷',
      era: 2,
      category: 'combat',
      cost: 80,
      move: 3,
      atk: 12,
      armor: 1,
      maxHp: 24,
      range: 1,
      vision: 4,
      abilities: ['trap'],
    },
    // ── 3 级 ──────────────────────────────────────────────────────────────
    // 树人：林子里是墙，平地上是木头。怕火，被点着要掉双倍。
    {
      id: 'treant',
      name: '树人',
      short: '树',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 2,
      atk: 23,
      armor: 6,
      maxHp: 70,
      range: 1,
      vision: 3,
      abilities: ['regenerate', 'woodland', 'siege-master'],
      weak: { fire: 1.5 },
    },
    {
      id: 'ogre',
      name: '食人魔',
      short: '魔',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 2,
      atk: 27,
      armor: 5,
      maxHp: 72,
      range: 1,
      vision: 2,
      abilities: ['lifesteal'],
    },
    {
      id: 'minotaur',
      name: '牛头人',
      short: '牛',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 3,
      atk: 21,
      armor: 4,
      maxHp: 58,
      range: 1,
      vision: 3,
      abilities: ['charge', 'herd'],
    },
    {
      id: 'troll',
      name: '巨魔',
      short: '巨',
      era: 3,
      category: 'combat',
      cost: 170,
      move: 2,
      atk: 24,
      armor: 4,
      maxHp: 68,
      range: 1,
      vision: 3,
      abilities: ['regenerate'],
      weak: { fire: 2 },
    },
    // 石像鬼：半血从"会飞的石头"变成"会飞的疯子"。
    {
      id: 'gargoyle',
      name: '石像鬼',
      short: '石',
      era: 3,
      category: 'combat',
      cost: 150,
      move: 4,
      // 同上：狂暴变强之后，石像鬼满血时更像个"会飞的石头"，半血才变疯子
      atk: 17,
      armor: 5,
      maxHp: 40,
      range: 1,
      vision: 5,
      magicRes: 3,
      flight: true,
      layer: 'air',
      abilities: ['berserk'],
    },
    {
      id: 'harpy',
      name: '鹰身女妖',
      short: '鹰',
      era: 3,
      category: 'combat',
      cost: 120,
      move: 6,
      atk: 15,
      armor: 1,
      maxHp: 24,
      range: 2,
      vision: 6,
      flight: true,
      layer: 'air',
    },
    {
      id: 'griffin-rider',
      name: '狮鹫骑士',
      short: '鹫',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 5,
      atk: 22,
      armor: 4,
      maxHp: 44,
      range: 1,
      vision: 6,
      flight: true,
      layer: 'air',
    },
    // 龙骑兵：飞行 + 冲锋 + 溅射。三条机制叠在一个兵上，所以面板压得低。
    {
      id: 'dragoon-rider',
      name: '龙骑兵',
      short: '龙',
      era: 3,
      category: 'combat',
      cost: 265,
      move: 5,
      atk: 26,
      armor: 6,
      maxHp: 58,
      range: 1,
      vision: 6,
      splash: 1,
      flight: true,
      layer: 'air',
      abilities: ['charge'],
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    {
      id: 'werewolf',
      name: '狼人',
      short: '狼',
      era: 4,
      category: 'combat',
      cost: 235,
      move: 3,
      // 攻击 25 配 50% 狂暴等于半血 37.5，一台 235 金的绞肉机。压到 22：
      // 满血它只是个厚实的肉盾，掉到一半才变成需要优先处理的麻烦。
      atk: 22,
      armor: 5,
      maxHp: 70,
      range: 1,
      vision: 4,
      abilities: ['berserk', 'bloodlust'],
    },
    // 双头巨人：两段攻击 + 破城。打重甲亏，拆城墙赚。
    {
      id: 'two-head-giant',
      name: '双头巨人',
      short: '双',
      era: 4,
      category: 'combat',
      cost: 300,
      move: 2,
      atk: 27,
      armor: 6,
      maxHp: 88,
      range: 1,
      vision: 3,
      burst: 2,
      abilities: ['siege-master'],
    },
    // ── 5 级：飞行的攻坚 ──────────────────────────────────────────────────
    {
      id: 'bone-dragon',
      name: '骷髅飞龙',
      short: '骸',
      era: 5,
      category: 'combat',
      cost: 430,
      move: 5,
      atk: 42,
      armor: 8,
      maxHp: 92,
      range: 1,
      vision: 6,
      flight: true,
      layer: 'air',
      abilities: ['siege-master'],
    },
  ],
};

const ARCANE: Expansion = {
  id: 'fantasy-arcane',
  scale: 'large',
  name: '奇想·秘法',
  summary:
    '法术与亡者：德鲁伊、死灵法师、炼金术士、吟游诗人、巫医、女巫、诅咒骑士、诅咒师、幻术师、元素召唤师、四种元素、幽灵、吸血鬼、僵尸、恶魔、地狱犬、机关傀儡、精灵弓手，以及被召唤的骷髅、小恶魔、幻象、土墙。需先开「奇想·法则」。',
  requires: ['fantasy-core'],
  hooks: {},
  units: [
    // ── 2 级 ──────────────────────────────────────────────────────────────
    // 吟游诗人：两个光环。它自己不打，但它让三条线同时变快、变狠。
    {
      id: 'bard',
      name: '吟游诗人',
      short: '吟',
      era: 2,
      category: 'combat',
      cost: 115,
      move: 3,
      atk: 10,
      armor: 2,
      maxHp: 28,
      range: 2,
      vision: 4,
      abilities: ['aura-command', 'aura-speed'],
    },
    // 僵尸：一回合只能走一格，但 52 血 3 甲。它存在的意义是挡在门口。
    {
      id: 'zombie',
      name: '僵尸',
      short: '僵',
      era: 2,
      category: 'combat',
      cost: 70,
      move: 1,
      atk: 13,
      armor: 3,
      maxHp: 52,
      range: 1,
      vision: 2,
      // 它一回合只能走一格，所以"没挪窝就减伤"对它来说几乎是常驻的——
      // 这不是白送：想吃到它就得放弃推进，一座会走路的掩体换不来一座城。
      abilities: ['shield-wall'],
      weak: { fire: 2 },
    },
    // ── 3 级：法术一档，全部脆、全部靠射程活 ───────────────────────────────
    {
      id: 'druid',
      name: '德鲁伊',
      short: '德',
      era: 3,
      category: 'combat',
      cost: 155,
      move: 2,
      atk: 8,
      armor: 2,
      maxHp: 30,
      range: 3,
      vision: 4,
      magicAtk: 15,
      element: 'nature',
      abilities: ['woodland', 'forest-walk'],
    },
    // 死灵法师：每 2 回合一个骷髅，最多 4 个。它转变的是"时间"，不是伤害。
    {
      id: 'necromancer',
      name: '死灵法师',
      short: '灵',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 28,
      range: 3,
      vision: 4,
      magicAtk: 12,
      element: 'dark',
      abilities: ['summoner'],
      summon: { type: 'skeleton', every: 2, max: 4 },
    },
    // 炼金术士：六发。前三发改变战场，后三发是余量，打光就退回近战。
    {
      id: 'alchemist',
      name: '炼金术士',
      short: '炼',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 2,
      atk: 9,
      armor: 2,
      maxHp: 30,
      range: 3,
      vision: 4,
      magicAtk: 15,
      element: 'fire',
      splash: 1,
      ammo: 6,
      abilities: ['burn-hit'],
    },
    {
      id: 'witch-doctor',
      name: '巫医',
      short: '巫',
      era: 3,
      category: 'combat',
      cost: 185,
      move: 2,
      atk: 10,
      armor: 2,
      maxHp: 32,
      range: 3,
      vision: 4,
      magicAtk: 10,
      element: 'nature',
      splash: 1,
      abilities: ['heal-aura'],
    },
    // 女巫：一片伤害 + 诅咒 + 一点魔攻。三种频率压在同一格上。
    {
      id: 'witch',
      name: '女巫',
      short: '女',
      era: 3,
      category: 'combat',
      cost: 160,
      move: 2,
      atk: 7,
      armor: 1,
      maxHp: 26,
      range: 3,
      vision: 5,
      magicAtk: 13,
      element: 'dark',
      splash: 1,
      abilities: ['curse-hit'],
    },
    {
      id: 'cursed-knight',
      name: '诅咒骑士',
      short: '咒',
      era: 3,
      category: 'combat',
      cost: 195,
      move: 4,
      atk: 22,
      armor: 6,
      maxHp: 54,
      range: 1,
      vision: 3,
      abilities: ['charge', 'curse-aura'],
    },
    {
      id: 'curser',
      name: '诅咒师',
      short: '诅',
      era: 3,
      category: 'combat',
      cost: 145,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 28,
      range: 3,
      vision: 4,
      magicAtk: 12,
      element: 'dark',
      abilities: ['curse-hit', 'fear'],
    },
    // 幻术师：召唤"幻象"——攻击力是真的，血是假的。诱它来打你。
    {
      id: 'illusionist',
      name: '幻术师',
      short: '幻',
      era: 3,
      category: 'combat',
      cost: 160,
      move: 2,
      atk: 8,
      armor: 1,
      maxHp: 26,
      range: 3,
      vision: 5,
      magicAtk: 10,
      abilities: ['summoner'],
      summon: { type: 'phantom', every: 3, max: 2 },
    },
    {
      id: 'fire-elemental',
      name: '火元素',
      short: '火',
      era: 3,
      category: 'combat',
      cost: 170,
      move: 3,
      atk: 21,
      armor: 4,
      maxHp: 48,
      range: 1,
      vision: 4,
      magicAtk: 8,
      element: 'fire',
      abilities: ['burn-hit'],
      weak: { water: 2 },
    },
    {
      id: 'water-elemental',
      name: '水元素',
      short: '水',
      era: 3,
      category: 'combat',
      cost: 160,
      move: 3,
      atk: 17,
      armor: 4,
      maxHp: 52,
      range: 1,
      vision: 4,
      magicAtk: 6,
      element: 'water',
      abilities: ['slow-hit'],
      weak: { fire: 1.5 },
      resist: { water: 4 },
    },
    // 土元素：10 甲 + 每回合立一道墙。它的作用是"把路堵住"，不是"打死谁"。
    {
      id: 'earth-elemental',
      name: '土元素',
      short: '土',
      era: 3,
      category: 'combat',
      cost: 190,
      move: 2,
      atk: 20,
      armor: 9,
      maxHp: 66,
      range: 1,
      vision: 2,
      magicRes: 4,
      abilities: ['build-wall'],
      builds: ['earth-wall'],
    },
    {
      id: 'air-elemental',
      name: '风元素',
      short: '风',
      era: 3,
      category: 'combat',
      cost: 165,
      move: 5,
      atk: 19,
      armor: 3,
      maxHp: 42,
      range: 1,
      vision: 5,
      flight: true,
      layer: 'air',
      abilities: ['knockback'],
    },
    // 幽灵：穿行 + 5 魔抗。堵枪眼对它无效；怕光，天使和圣骑士能治它。
    {
      id: 'ghost',
      name: '幽灵',
      short: '魂',
      era: 3,
      category: 'combat',
      cost: 130,
      move: 4,
      atk: 18,
      armor: 2,
      maxHp: 30,
      range: 1,
      vision: 4,
      magicRes: 5,
      abilities: ['phase'],
      weak: { light: 2 },
    },
    // 地狱犬：7 视野 + 追猎。它专杀撤退的残兵，正面顶不住。
    {
      id: 'hellhound',
      name: '地狱犬',
      short: '犬',
      era: 3,
      category: 'combat',
      cost: 155,
      move: 5,
      atk: 20,
      armor: 3,
      maxHp: 40,
      range: 1,
      vision: 7,
      abilities: ['tracker'],
    },
    // 精灵弓手：射程 5、视野 7。它的工作是在对面还没看清它的时候先开火。
    {
      id: 'elf-archer',
      name: '精灵弓手',
      short: '精',
      era: 3,
      category: 'combat',
      cost: 175,
      move: 3,
      atk: 22,
      armor: 2,
      maxHp: 30,
      range: 5,
      vision: 7,
      // 5 格射程 + 7 格视野 + 无视掩护：它是全场唯一"先看见、先开枪"的兵。
      // 代价是 30 血 2 甲，被任何骑兵摸到就没了。
      abilities: ['elf-shot'],
    },
    // ── 4 级 ──────────────────────────────────────────────────────────────
    {
      id: 'elementalist',
      name: '元素召唤师',
      short: '召',
      era: 4,
      category: 'combat',
      cost: 280,
      move: 2,
      atk: 10,
      armor: 3,
      maxHp: 34,
      range: 3,
      vision: 5,
      magicAtk: 14,
      abilities: ['summoner'],
      // 随机召唤：种子决定，回放对得上
      summon: {
        random: ['fire-elemental', 'water-elemental', 'earth-elemental', 'air-elemental'],
        every: 3,
        max: 2,
      },
    },
    {
      id: 'vampire',
      name: '吸血鬼',
      short: '血',
      era: 4,
      category: 'combat',
      cost: 235,
      move: 5,
      atk: 28,
      armor: 5,
      maxHp: 56,
      range: 1,
      vision: 5,
      flight: true,
      layer: 'air',
      abilities: ['lifesteal'],
      weak: { fire: 2, light: 2 },
    },
    // 机关傀儡：不会好起来的兵。能一直打，但不能一直撑。
    {
      id: 'clockwork-golem',
      name: '机关傀儡',
      short: '械',
      era: 4,
      category: 'combat',
      cost: 245,
      move: 2,
      atk: 30,
      armor: 9,
      maxHp: 72,
      range: 1,
      vision: 3,
      abilities: ['machine', 'shield-wall'],
    },
    // ── 5 级 ──────────────────────────────────────────────────────────────
    // 恶魔：飞行 + 亡语爆炸 + 每 3 回合一个小恶魔。三条都是"死了也不亏"。
    {
      id: 'demon',
      name: '恶魔',
      short: '恶',
      era: 5,
      category: 'combat',
      cost: 400,
      move: 5,
      atk: 42,
      armor: 7,
      maxHp: 78,
      range: 2,
      vision: 6,
      magicAtk: 10,
      element: 'fire',
      flight: true,
      layer: 'air',
      abilities: ['kamikaze', 'summoner'],
      summon: { type: 'imp', every: 3, max: 2 },
    },
    // ── 被召唤的（不进产线、不占编制） ────────────────────────────────────
    ...SUMMONED_UNITS,
  ],
};

/**
 * 英雄包：五个全场唯一、首次招募要付解锁费的大家伙。
 *
 * 为什么单独成包而不是混进上面三个：有人就是想打一场没有 560 金大件的仗。
 * 英雄对局节奏的影响是质变级的（一个九头蛇能顶半支部队），所以它必须
 * 是一个可以被整体关掉的选择，而不是藏在兽群里的一行数据。
 */
const HERO_IDS = ['dwarf-king', 'hydra', 'phoenix', 'archmage', 'angel'];

// 英雄数值在技能化之后整体上调过一档（攻/血各 +5% 上下）。
//
// 原因不是"英雄不够强"，是"英雄不够值"：技能化之后每回合多了一次要做的决定，
// 但面板没动，等于同样的钱买到了更多操作负担。护甲/魔抗/射程/移动一律不动——
// 那几项每加一档就是换一个量级（护甲尤其非线性），跟"略微提升"不是一回事。
//
// 第二次上调：血量整体 ×1.2，造价跟着涨半成（+20~30 金）。
//
// 只动血，不动攻。英雄的问题从来不是"打不死人"，是"太容易先死"：
// 一个 520 金的单位被对面两轮集火就没了，玩家下次就不敢买了，买了也只敢
// 缩在城后——英雄一旦不能上前线，技能里那些"贴上去才值"的效果（投斧、
// 烈焰俯冲、降临）就全废了。血量是唯一能把"敢不敢上"改过来的那一项。
//
// 加血必然要抬价，否则英雄在性价比上直接压死同费普通兵；但**只能略微涨**：
// 涨到 600 以上，五个英雄就变成"解锁费之后再交一道钱墙"，节奏被拖垮的是
// 玩家自己。所以按 +半成 走，谁的血涨得多谁多掏一点，最终都还落在原档位里。
const HERO_UNITS: UnitTypeDef[] = [
  // 矮人王：近战是本职（atk 32，射程 1），投斧是**技能**（开一回合，射程 3 但只有六成）。
  //
  // 改动前它是"射程 3 的兵，贴身打不打折"，等于永远在远程位。现在默认只能近身，
  // 想投斧得自己开——这样"贴上去还是站远点"才是每回合真要做的一个决定。
  // 造价 300 → 340：多了一个可选技能，价格得跟着走一点。
  {
    id: 'dwarf-king',
    name: '矮人王',
    short: '王',
    era: 3,
    category: 'combat',
    cost: 360,
    move: 2,
    atk: 34,
    armor: 8,
    maxHp: 101,
    range: 1,
    vision: 4,
    hero: true,
    unlockCost: 150,
    abilities: ['aura-armor', 'shield-wall'],
    skills: [
      {
        id: 'throw-axe',
        name: '投斧',
        summary:
          '投出一斧：射程 3、隔着一格以上只有六成伤害。这一下不占本回合的攻击次数——扔完还能贴身再劈一次。',
        effect: 'throw-axe',
        cooldown: 1,
        power: 0.6,
      },
    ],
  },
  // 九头蛇：145 血 + 每回合两成回复。解法只有一个——火。
  {
    id: 'hydra',
    name: '九头蛇',
    short: '九',
    era: 4,
    category: 'combat',
    cost: 490,
    move: 3,
    atk: 36,
    armor: 7,
    maxHp: 145,
    range: 1,
    vision: 4,
    hero: true,
    unlockCost: 200,
    abilities: ['regenerate-plus', 'siege-master'],
    weak: { fire: 2 },
    skills: [
      {
        id: 'regrow',
        name: '再生',
        summary: '立刻回复 40% 生命（约 58 点）。',
        effect: 'regenerate',
        cooldown: 2,
        power: 0.4,
      },
    ],
  },
  // 不死鸟：每局从灰烬里站起来一次。它不硬，但它死不完。
  {
    id: 'phoenix',
    name: '不死鸟',
    short: '凤',
    era: 4,
    category: 'combat',
    cost: 480,
    move: 6,
    atk: 38,
    armor: 4,
    maxHp: 89,
    range: 2,
    vision: 7,
    magicAtk: 10,
    element: 'fire',
    hero: true,
    unlockCost: 220,
    flight: true,
    layer: 'air',
    abilities: ['rebirth'],
    skills: [
      {
        id: 'dive',
        name: '烈焰俯冲',
        summary: '本回合移动 +2，攻击额外点燃两层。',
        effect: 'dive',
        cooldown: 2,
        power: 2,
      },
    ],
  },
  // 至尊法师：溅射 2 格加 26 点魔攻。打的是"一片阵型"，不是一个兵。
  // 属性不再自动轮换，改成每回合自己切一次（见 skills）：自动轮换等于
  // "你只有四分之一的回合是火属性"，而火要烧谁是你自己该判断的事。
  {
    id: 'archmage',
    name: '至尊法师',
    short: '尊',
    era: 5,
    category: 'combat',
    cost: 590,
    move: 2,
    atk: 10,
    // 护甲 3 → 6、射程 4 → 5、视野 7 → 8：这一档加强换的是"站得住、看得远、
    // 够得着"。它不是靠血厚活下来的兵，而是靠"对面还没走到就已经挨了两轮"。
    armor: 6,
    maxHp: 72,
    range: 5,
    vision: 8,
    magicAtk: 26,
    // 法抗 10 让它不至于被对面一发法师打回原形：至尊法师该是"法师里的法师"，
    // 对轰的时候不能比对面脆。
    magicRes: 10,
    element: 'fire',
    splash: 2,
    hero: true,
    unlockCost: 300,
    cycle: ['fire', 'water', 'nature', 'dark'],
    // 属性不再只是"这一回合上什么状态"，而是四种形态：
    // 火/水继续压状态，自然变成自愈，暗变成纯粹的伤害放大（见 element-mastery）。
    // 「同源护壁」是这次加的：火属性的至尊法师被火打只吃一半——
    // 它自己的属性就是它的护甲，切属性同时在换"怕什么、不怕什么"。
    abilities: ['element-mastery', 'element-ward'],
    skills: [
      {
        id: 'shift',
        name: '转属性',
        summary: '切到下一种属性（火→水→自然→暗）。火=点燃、水=霜缚、自然=攻击时自愈、暗=魔法段 ×1.5。',
        effect: 'cycle',
        cooldown: 1,
      },
    ],
  },
  // 天使：高甲 + 6 魔抗 + 群体治愈 + 一次大范围「降临」。
  //
  // 大净化从被动改成技能，并且半径从 1 拉到 3：被动版只够得着贴身的三个兵，
  // 而"清掉一条线上的中毒和诅咒"本来就该是一个主动决定——净化什么时候放，
  // 取决于对面法师什么时候出手，而不是取决于天使站在哪。
  {
    id: 'angel',
    name: '天使',
    short: '使',
    era: 5,
    category: 'combat',
    cost: 550,
    move: 5,
    atk: 42,
    armor: 10,
    maxHp: 121,
    range: 1,
    vision: 7,
    magicAtk: 12,
    magicRes: 6,
    element: 'light',
    hero: true,
    unlockCost: 250,
    flight: true,
    layer: 'air',
    abilities: ['heal-aura'],
    skills: [
      {
        id: 'descend',
        name: '降临',
        summary: '半径 3 内友军回复 20% 生命，并清空全部负面状态。',
        effect: 'descend',
        cooldown: 2,
        radius: 3,
        power: 0.2,
      },
    ],
  },
  // 刺客大师：全场最会挑时机的一个。
  //
  // 它面板不吓人（30 攻、78 血），但两条机制叠起来是另一种强度：
  //   · 收割——亲手斩掉一个，脚下又有路了。杀完能换个位置躲开围上来的援兵，
  //     但攻击次数不还，所以它永远做不到"一回合砍两个"。
  //   · 隐匿——主动藏起来，藏到你的下个回合开始。对面要么放弃追击，
  //     要么把兵铺开、贴到相邻格才抓得住它。
  // 这两条合起来，让它成为"补刀 + 脱战"的兵，而不是一个能正面站住的英雄。
  {
    id: 'assassin-master',
    name: '刺客大师',
    short: '刺',
    era: 4,
    category: 'combat',
    cost: 430,
    move: 3,
    atk: 30,
    armor: 3,
    maxHp: 78,
    range: 1,
    // 视野 5 → 7：刺客要挑"从哪边绕过去"，看不清两格外的援兵就挑不了
    vision: 7,
    hero: true,
    unlockCost: 180,
    abilities: ['kill-rush'],
    skills: [
      {
        id: 'vanish',
        name: '隐匿',
        summary:
          '隐去身形：直到你下个回合开始，敌人只有贴到相邻格才发现它。出手或挨打会立刻暴露。',
        effect: 'vanish',
        cooldown: 2,
      },
    ],
  },
  // 史莱姆牢大：血厚甲低的近战肉块，真正的价值在"打不死"。
  //
  // 200 血配 2 甲，看着像一堵墙，其实是四团血：一刀砍下去裂成四只，
  // 每只跑得都比它快。对面要么把四只全清掉（清的时候还要吃四次攻击），
  // 要么被它们跑回去重新合体——这一来一回，才是它值 200 解锁费的地方。
  {
    id: 'slime-boss',
    name: '史莱姆牢大',
    short: '牢',
    era: 3,
    category: 'combat',
    cost: 520,
    move: 3,
    atk: 32,
    // 甲 2 → 3、射程 1 → 2、视野 3 → 4：血厚甲薄的肉块太容易被"隔着打"白嫖，
    // 射程 2 让它能回手（也意味着它能打到飞行单位了，见 rules 的 strikeDistance）
    armor: 3,
    maxHp: 200,
    range: 2,
    vision: 4,
    hero: true,
    unlockCost: 200,
    weak: { fire: 1.5 },
    // 和「分裂」能力共用这一个字段：牢大没有 split 能力，所以阵亡时不会自动裂；
    // 「裂殖」技能读它来决定裂成什么（见 rules 的 doHeroSkill）。
    splitInto: 'slime-giant',
    skills: [
      {
        id: 'mitosis',
        name: '裂殖',
        summary:
          '裂成四只大史莱姆：每只生命为牢大的四分之一（按当前生命分摊，不凭空多也不丢）。分裂体当回合不能行动。',
        effect: 'mitosis',
        cooldown: 3,
      },
    ],
  },
  // 大史莱姆：牢大的碎片，也带着合体的钥匙。
  //
  // 单独给它一条产线会让"牢大"变成一个可以刷的兵，所以它是 summonedOnly：
  // 只能从裂殖里出来。血刚好是牢大的四分之一（50），移速反而更快——
  // 碎开之后它们该做的事是跑，不是站。
  {
    id: 'slime-giant',
    name: '大史莱姆',
    short: '巨',
    era: 3,
    category: 'combat',
    // 造价不会出现在产线上（summonedOnly），只影响"满血解散能退多少"——
    // 按牢大的四分之一写，退了也不至于变成"裂开再解散"的刷钱路子。
    cost: 130,
    move: 5,
    atk: 14,
    // 甲 1 → 2：碎片本来靠数量活着，但 1 甲连民兵都能两下清掉，
    // 裂开等于把血直接送出去
    armor: 2,
    maxHp: 50,
    range: 1,
    vision: 3,
    summonedOnly: true,
    weak: { fire: 1.5 },
    mergeInto: 'slime-boss',
    skills: [
      {
        id: 'fuse',
        name: '聚合',
        summary:
          '和场上其它大史莱姆合体成史莱姆牢大（至少两只）：生命相加，上限按牢大算。合体后当回合不能行动。',
        effect: 'fuse',
        cooldown: 1,
      },
    ],
  },
];

const HEROES: Expansion = {
  id: 'fantasy-heroes',
  scale: 'large',
  name: '奇想·英雄',
  summary:
    '七个全场唯一的英雄，每人每回合有一个主动技能：矮人王（投斧：白送一次三格远程攻击）、九头蛇（再生：回 40% 生命）、不死鸟（烈焰俯冲：加速并点燃两层；阵亡后留下一枚蛋，孵化带一半生命）、至尊法师（转属性：火/水/自然/暗四种形态，护甲 6、射程 5、同属性伤害减半）、天使（降临：半径 3 回 20% 并清空负面状态）、刺客大师（隐匿：藏到你的下个回合，斩杀后还能再走一次）、史莱姆牢大（裂殖：裂成四只大史莱姆，它们能再聚合回来）。第一次招募要额外付解锁费，解锁后永久开放。需先开「奇想·法则」。',
  requires: ['fantasy-core'],
  hooks: {},
  units: HERO_UNITS,
};

export const FANTASY_PACKS: Expansion[] = [CORE, KNIGHTS, BEASTS, ARCANE, HEROES];

/** 英雄 id 列表，给"英雄包只装英雄"这条测试用 */
export const FANTASY_HERO_IDS: readonly string[] = HERO_IDS;
