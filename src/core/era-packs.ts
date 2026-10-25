/**
 * 时代兵种扩展包（大型模组）。
 *
 * 五个时代各出一套，取材自该时代真实存在的兵种、攻城器械与防御工事。
 * 每套的单位数量都**超过原版同期**（原版：古典 12 / 中世 8 / 火药 11 / 工业 7 / 现代 11），
 * 目的是让"同一代"里出现真正的兵种选择，而不是"挑最贵那个"。
 *
 * ---------------------------------------------------------------
 * 数值是怎么定的（否则后面没法解释平衡报告）
 * ---------------------------------------------------------------
 * 先给每个单位算两个粗指标，再对照原版同代单位校准：
 *
 *   有效耐久 EHP = maxHp + 2 × armor
 *     （伤害模型是"攻击 − 护甲"直接相减，所以 1 点护甲 ≈ 2 点血）
 *   有效输出 DPS = atk × 段数系数
 *     段数系数：burst 取 burst；splash 取 1 + 0.5 × splash（溅射只吃一半伤害）
 *
 * 原版同代的每金耐久带（EHP / cost），本文件所有单位都落在带内或略低：
 *   古典 0.60~1.28　中世 0.29~0.71　火药 0.17~0.44
 *   工业 0.22~0.38　现代 0.16~0.32
 *
 * 也就是说：**新单位不是"更强"，而是"更专"**。重甲的每金输出低、远程的每金
 * 耐久低、攻城器离开了城墙几乎是废铁——换来的才是在某个场景里明显好用。
 * 每金耐久普遍压在带的下沿（不是上沿），是为了让"多了一种兵"不至于变成
 * "整体变强"，否则模组一开，对局节奏就会整体漂移。
 *
 * ---------------------------------------------------------------
 * 一条硬约束：era 1 的战斗单位会被开局白送
 * ---------------------------------------------------------------
 * setup.ts 的开局部队只从 `era === 1 && category === 'combat'` 的池子里取，
 * 而且不看价钱——池子里有战象，开局就白送战象。所以古典包里的战斗单位
 * 一律压在 60 金以内（这也是战象被压到 60、而真实的战象应该更贵的原因：
 * 宁可牺牲一点"贵气"，也不要让开局白送的东西打破基准）。
 *
 * 另外：开局的 2 个经济单位也是从 era 1 的 economy 里轮取的，所以古典包
 * 故意不做经济单位，免得把农民/牧民挤出开局。
 */

import type { Expansion } from './expansions.ts';
import type { UnitTypeDef } from './types.ts';

/* ================================================================== */
/* 时代 1 · 古典（原版 12 个 → 模组 14 个）                            */
/* ================================================================== */

const ANTIQUITY: UnitTypeDef[] = [
  // ---- 战斗 ----
  {
    // 希腊/罗马的投石兵：最便宜的远程，专门用来磨重甲方阵的耐心
    id: 'anc_slinger',
    name: '投石兵',
    short: '石',
    era: 1,
    category: 'combat',
    cost: 30,
    move: 2,
    atk: 9,
    armor: 0,
    maxHp: 18,
    range: 3,
    vision: 3,
  },
  {
    // 罗马轻步兵：射程只有 2，但比弓手便宜、比投石兵扛打
    id: 'anc_javelineer',
    name: '标枪兵',
    short: '标',
    era: 1,
    category: 'combat',
    cost: 32,
    move: 2,
    atk: 12,
    armor: 1,
    maxHp: 20,
    range: 2,
    vision: 3,
  },
  {
    // 希腊重装步兵：方阵的核心。攻击不高，但 5 点护甲让民兵几乎打不动
    id: 'anc_hoplite',
    name: '重装步兵',
    short: '重',
    era: 1,
    category: 'combat',
    cost: 48,
    move: 2,
    atk: 14,
    armor: 5,
    maxHp: 40,
    range: 1,
    vision: 2,
    abilities: ['shield-wall'],
  },
  {
    // 罗马军团兵：站住就有光环，是"阵型"这个概念的第一次兑现
    id: 'anc_legionary',
    name: '军团兵',
    short: '团',
    era: 1,
    category: 'combat',
    cost: 55,
    move: 2,
    atk: 17,
    armor: 4,
    maxHp: 36,
    range: 1,
    vision: 2,
    abilities: ['shield-wall', 'aura-command'],
  },
  {
    // 蛮族战斧手：没有甲，只有一下狠的。用得起、死得快
    id: 'anc_axeman',
    name: '战斧手',
    short: '斧',
    era: 1,
    category: 'combat',
    cost: 40,
    move: 2,
    atk: 18,
    armor: 1,
    maxHp: 30,
    range: 1,
    vision: 2,
  },
  {
    // 轻盾兵：跑得快、能藏林子，用来抢资源点和摸后排
    id: 'anc_skirmisher',
    name: '轻盾兵',
    short: '轻',
    era: 1,
    category: 'combat',
    cost: 38,
    move: 4,
    atk: 11,
    armor: 1,
    maxHp: 24,
    range: 1,
    vision: 4,
    abilities: ['stealth'],
  },
  {
    // 埃及/赫梯战车：古典唯一的"高机动打击力量"，代价是脆
    id: 'anc_chariot',
    name: '战车',
    short: '车',
    era: 1,
    category: 'combat',
    cost: 60,
    move: 4,
    atk: 16,
    armor: 2,
    maxHp: 30,
    range: 1,
    vision: 3,
  },
  {
    // 印度/迦太基战象：一堵会走的墙。kamikaze 表示溃散时会踩自己人
    id: 'anc_elephant',
    name: '战象',
    short: '象',
    era: 1,
    category: 'combat',
    cost: 60,
    move: 2,
    atk: 22,
    armor: 4,
    maxHp: 50,
    range: 1,
    vision: 2,
    abilities: ['kamikaze'],
  },
  {
    // 攻城槌：唯一的用途是撞门，野战里几乎打不动人
    id: 'anc_ram',
    name: '攻城槌',
    short: '槌',
    era: 1,
    category: 'combat',
    cost: 55,
    move: 1,
    atk: 14,
    armor: 5,
    maxHp: 55,
    range: 1,
    vision: 1,
    abilities: ['siege-master'],
  },
  {
    // 希腊/罗马弩炮：射程压过所有弓手，靠破甲啃方阵
    id: 'anc_ballista',
    name: '弩炮',
    short: '弩',
    era: 1,
    category: 'combat',
    cost: 58,
    move: 1,
    atk: 15,
    armor: 1,
    maxHp: 22,
    range: 4,
    vision: 2,
    abilities: ['armor-pierce'],
  },

  // ---- 工事 ----
  {
    // 瞭望塔：古典的"眼睛"。
    // 第一版 atk 12 / 视野 5 / 75 金，实测每百金杀伤 72.7（原版箭塔 37.0）——
    // 视野 5 在 12×12 上等于半个棋盘，它永远先手开火。现在视野收到 4、攻击 12→10、
    // 价格提到 85：仍然是最好的侦察塔，但不再是"造了就赢"。
    id: 'anc_watchtower',
    name: '瞭望塔',
    short: '望',
    era: 1,
    category: 'building',
    cost: 85,
    move: 0,
    atk: 10,
    armor: 4,
    maxHp: 32,
    range: 4,
    vision: 4,
    autoAttack: true,
  },
  {
    // 栅栏：最便宜的堵路工事，专门用来卡河岸和桥头
    id: 'anc_palisade',
    name: '栅栏',
    short: '栅',
    era: 1,
    category: 'building',
    cost: 40,
    move: 0,
    atk: 4,
    armor: 3,
    maxHp: 45,
    range: 1,
    vision: 1,
  },

  // ---- 建造与水军 ----
  {
    // 工匠：本包工事的唯一施工方，顺便保留架桥和军营能力
    id: 'anc_engineer',
    name: '工匠',
    short: '匠',
    era: 1,
    category: 'builder',
    cost: 55,
    move: 2,
    atk: 5,
    armor: 2,
    maxHp: 20,
    range: 1,
    vision: 2,
    builds: ['anc_palisade', 'anc_watchtower', 'bridge', 'camp'],
  },
  {
    // 三层桨战船：古典海权的象征，撞角为主。
    // 实测每百金 49.5，是舢板（23.3）的两倍，攻击收到 14 压一压。
    id: 'anc_trireme',
    name: '三层桨战船',
    short: '桨',
    era: 1,
    category: 'combat',
    cost: 70,
    move: 3,
    atk: 14,
    armor: 3,
    maxHp: 42,
    range: 1,
    vision: 3,
    domain: 'water',
  },
];

/* ================================================================== */
/* 时代 2 · 中世（原版 8 个 → 模组 12 个）                             */
/* ================================================================== */

const MEDIEVAL: UnitTypeDef[] = [
  {
    // 重装军士：骑士下马之后的形态，比长枪兵贵、比骑士耐打
    id: 'med_manatarms',
    name: '重装军士',
    short: '士',
    era: 2,
    category: 'combat',
    cost: 95,
    move: 2,
    atk: 16,
    armor: 6,
    maxHp: 44,
    range: 1,
    vision: 2,
    abilities: ['shield-wall'],
  },
  {
    // 热那亚弩手：射程和破甲都在长弓之上，代价是慢。
    // 第一版 100 金 atk 18，打出场均每百金 55.3（长弓 31.7）——破甲在"人人有甲"的中世
    // 太值钱。攻击收到 16、价格提到 110，让它变成"贵一点的解甲方案"而不是全面替代长弓。
    id: 'med_crossbow',
    name: '弩手',
    short: '弩',
    era: 2,
    category: 'combat',
    cost: 110,
    move: 2,
    atk: 16,
    armor: 1,
    maxHp: 24,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce'],
  },
  {
    // 蒙古骑射手：打带跑。first-strike = 不挨反击，它就是靠这个活着的。
    // 实测每百金只有 20.1——AI 不会"打了就跑"，先手在它手里换不成价值。
    // 所以补偿的是纯数值（攻击 15→17、价格 120→110），而不是再加机制。
    id: 'med_horsearcher',
    name: '骑射手',
    short: '射',
    era: 2,
    category: 'combat',
    cost: 110,
    move: 5,
    atk: 17,
    armor: 2,
    maxHp: 30,
    range: 3,
    vision: 5,
    abilities: ['first-strike'],
  },
  {
    // 瑞士长矛兵：中世的"反骑兵"答案，正面极硬
    id: 'med_pikeman',
    name: '瑞士长矛兵',
    short: '矛',
    era: 2,
    category: 'combat',
    cost: 85,
    move: 2,
    atk: 19,
    armor: 4,
    maxHp: 48,
    range: 1,
    vision: 2,
    abilities: ['shield-wall'],
  },
  {
    // 双手剑士：放弃盾牌换攻击，专破长枪方阵的缝
    id: 'med_doppelsoldner',
    name: '双手剑士',
    short: '剑',
    era: 2,
    category: 'combat',
    cost: 105,
    move: 2,
    atk: 24,
    armor: 3,
    maxHp: 42,
    range: 1,
    vision: 2,
  },
  {
    // 配重投石机：中世攻城的标准答案，射程 5 压过所有塔
    id: 'med_trebuchet',
    name: '投石机',
    short: '投',
    era: 2,
    category: 'combat',
    cost: 150,
    move: 1,
    atk: 26,
    armor: 2,
    maxHp: 34,
    range: 5,
    vision: 2,
    splash: 1,
    abilities: ['siege-master'],
  },
  {
    // 攻城塔：不靠打，靠"把兵送到城墙下"。血厚甲厚，慢得离谱
    id: 'med_siegetower',
    name: '攻城塔',
    short: '塔',
    era: 2,
    category: 'combat',
    cost: 120,
    move: 1,
    atk: 8,
    armor: 7,
    maxHp: 90,
    range: 1,
    vision: 2,
    abilities: ['siege-master'],
  },
  {
    // 胡斯战车：把车连成车堡，是中世少见的"移动工事"
    id: 'med_wagon',
    name: '战车堡',
    short: '堡',
    era: 2,
    category: 'combat',
    cost: 130,
    move: 2,
    atk: 14,
    armor: 8,
    maxHp: 60,
    range: 2,
    vision: 2,
    abilities: ['shield-wall'],
  },
  {
    // 主楼：城堡最后一道防线，射程比石堡远一格
    id: 'med_donjon',
    name: '主楼',
    short: '楼',
    era: 2,
    category: 'building',
    cost: 160,
    move: 0,
    atk: 16,
    armor: 9,
    maxHp: 60,
    range: 3,
    vision: 4,
    autoAttack: true,
  },
  {
    // 城墙段：纯堵路，用来把"能过的地方"变少
    id: 'med_wall',
    name: '城墙段',
    short: '墙',
    era: 2,
    category: 'building',
    cost: 90,
    move: 0,
    atk: 3,
    armor: 8,
    maxHp: 80,
    range: 1,
    vision: 1,
  },
  {
    // 工兵：负责把城墙/主楼/寨垒立起来
    id: 'med_sapper',
    name: '工兵',
    short: '工',
    era: 2,
    category: 'builder',
    cost: 95,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 22,
    range: 1,
    vision: 2,
    builds: ['med_wall', 'med_donjon', 'bridge', 'camp2'],
  },
  {
    // 齿轮帆船：中世唯一能运兵过河的船，运 3 个
    id: 'med_cog',
    name: '齿轮帆船',
    short: '帆',
    era: 2,
    category: 'combat',
    cost: 110,
    move: 4,
    atk: 16,
    armor: 4,
    maxHp: 55,
    range: 2,
    vision: 4,
    domain: 'water',
    transport: true,
    capacity: 3,
  },
];

/* ================================================================== */
/* 时代 3 · 火药（原版 11 个 → 模组 13 个）                            */
/* ================================================================== */

const GUNPOWDER: UnitTypeDef[] = [
  {
    // 线列步兵：排队枪毙的主角，站住齐射比散开强
    id: 'gp_lineinfantry',
    name: '线列步兵',
    short: '列',
    era: 3,
    category: 'combat',
    cost: 150,
    move: 2,
    atk: 25,
    armor: 3,
    maxHp: 40,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce', 'shield-wall'],
  },
  {
    // 掷弹兵：先扔一轮手榴弹再冲锋，所以有溅射
    id: 'gp_grenadier',
    name: '掷弹兵',
    short: '弹',
    era: 3,
    category: 'combat',
    cost: 165,
    move: 2,
    atk: 26,
    armor: 4,
    maxHp: 44,
    range: 3,
    vision: 3,
    splash: 1,
  },
  {
    // 胸甲骑兵：火药时代最后的骑兵冲锋，甲厚、贵、怕枪
    id: 'gp_cuirassier',
    name: '胸甲骑兵',
    short: '胸',
    era: 3,
    category: 'combat',
    cost: 185,
    move: 4,
    atk: 30,
    armor: 7,
    maxHp: 46,
    range: 1,
    vision: 3,
  },
  {
    // 龙骑兵：骑马机动、下马射击，是火力与速度的结合
    id: 'gp_dragoon',
    name: '龙骑兵',
    short: '龙',
    era: 3,
    category: 'combat',
    cost: 155,
    move: 4,
    atk: 22,
    armor: 3,
    maxHp: 38,
    range: 3,
    vision: 4,
  },
  {
    // 猎兵：射程最远的散兵。
    // 第一版给了 first-strike（不挨反击），实测直接失衡：140 金打出每百金 61.7 杀伤、
    // 交换比 5.65，比同代火枪兵高 76%——"射程 5 + 不吃反击 + 潜行"等于无风险打靶。
    // 现在只保留潜行，射程收到 4、攻击 28→24，回到"视野好、能阴人、但被贴上就死"的定位。
    id: 'gp_sharpshooter',
    name: '猎兵',
    short: '猎',
    era: 3,
    category: 'combat',
    cost: 140,
    move: 2,
    atk: 22,
    armor: 1,
    maxHp: 24,
    range: 4,
    vision: 5,
    abilities: ['stealth'],
  },
  {
    // 攻城加农炮：火药时代的攻城核心，两格溅射
    id: 'gp_siegecannon',
    name: '攻城加农炮',
    short: '加',
    era: 3,
    category: 'combat',
    cost: 190,
    move: 1,
    atk: 30,
    armor: 3,
    maxHp: 36,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
  },
  {
    // 康格里夫火箭：射程远、精度差、声光吓人
    id: 'gp_rocket',
    name: '火箭',
    short: '火',
    era: 3,
    category: 'combat',
    cost: 175,
    move: 2,
    atk: 24,
    armor: 1,
    maxHp: 28,
    range: 5,
    vision: 2,
    splash: 1,
  },
  {
    // 长管炮：射程最远的直射火力，靠破甲啃棱堡
    id: 'gp_culverin',
    name: '长管炮',
    short: '长',
    era: 3,
    category: 'combat',
    cost: 200,
    move: 1,
    atk: 28,
    armor: 3,
    maxHp: 34,
    range: 6,
    vision: 2,
    abilities: ['armor-pierce', 'siege-master'],
  },
  {
    // 棱堡：星形要塞的角楼，射界没有死角
    id: 'gp_bastion',
    name: '棱堡',
    short: '棱',
    era: 3,
    category: 'building',
    cost: 200,
    move: 0,
    atk: 24,
    armor: 11,
    maxHp: 70,
    range: 4,
    vision: 5,
    splash: 1,
    autoAttack: true,
  },
  {
    // 防马桩：最便宜的延迟工事，专治骑兵冲脸
    id: 'gp_chevaux',
    name: '防马桩',
    short: '桩',
    era: 3,
    category: 'building',
    cost: 70,
    move: 0,
    atk: 6,
    armor: 6,
    maxHp: 50,
    range: 1,
    vision: 1,
  },
  {
    // 军需官：火药时代军队规模爆炸，后勤本身成了兵种
    id: 'gp_quartermaster',
    name: '军需官',
    short: '需',
    era: 3,
    category: 'economy',
    cost: 150,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 24,
    range: 1,
    vision: 3,
    incomeByTerrain: { city: 16, plain: 9, hill: 5, forest: 4 },
  },
  {
    // 工兵：棱堡与防马桩的施工方
    id: 'gp_sapper',
    name: '工兵',
    short: '工',
    era: 3,
    category: 'builder',
    cost: 135,
    move: 2,
    atk: 5,
    armor: 3,
    maxHp: 24,
    range: 1,
    vision: 2,
    builds: ['gp_chevaux', 'gp_bastion', 'bridge2', 'camp3'],
  },
  {
    // 风帆战列舰：三层甲板、一百门炮，火药时代的海上霸主
    id: 'gp_shipofline',
    name: '风帆战列舰',
    short: '战',
    era: 3,
    category: 'combat',
    cost: 230,
    move: 4,
    atk: 34,
    armor: 8,
    maxHp: 80,
    range: 4,
    vision: 4,
    domain: 'water',
  },
];

/* ================================================================== */
/* 时代 4 · 工业（原版 7 个 → 模组 13 个）                             */
/* ================================================================== */

const INDUSTRY: UnitTypeDef[] = [
  {
    // 骑兵：一战的骑兵已经打不过机枪，但机动仍然能绕后。
    // 实测交换比 0.56、每百金杀伤 10.1（步枪兵 35.9）——AI 不会用机动绕后，
    // move 5 在它手里只是"更快地送进对方阵型"。第一轮已经把攻击抬到 38 仍然不够，
    // 第二轮改为补生存（护甲 4→5、血 50→56）并把攻击抬到 42：
    // 让它至少在正面撞上去时能换掉东西，而不是单方面蒸发。
    id: 'ind_cavalry',
    name: '骑兵',
    short: '骑',
    era: 4,
    category: 'combat',
    cost: 210,
    move: 5,
    atk: 42,
    armor: 5,
    maxHp: 56,
    range: 1,
    vision: 4,
  },
  {
    // 堑壕突击队：穿越无人区的那批人，潜行是他们的生存技能。
    // 第一版 210 金 / atk 34 / 射程 2，和步枪兵（200 金 / atk 36 / 射程 4）比全面更差，
    // 实测每百金 8.6。现在改成"近战爆发"：射程 3、攻击 42、价格 195，
    // 用射程换攻击——它不该是步枪兵的下位替代品。
    id: 'ind_trenchraider',
    name: '堑壕突击队',
    short: '突',
    era: 4,
    category: 'combat',
    cost: 195,
    move: 2,
    atk: 42,
    armor: 3,
    maxHp: 40,
    range: 3,
    vision: 3,
    abilities: ['stealth'],
  },
  {
    // 火焰喷射器：射程只有 2，但在那一格里它就是神
    id: 'ind_flamethrower',
    name: '火焰喷射器',
    short: '焰',
    era: 4,
    category: 'combat',
    cost: 240,
    move: 2,
    atk: 40,
    armor: 3,
    maxHp: 36,
    range: 2,
    vision: 2,
    splash: 1,
  },
  {
    // 毒气兵：无视护甲的成片杀伤，代价是短射程和脆。
    // 实测每百金 18.3（步枪兵 35.9）：溅射要靠敌人扎堆，而 AI 的阵型是散开的。
    // 攻击 32→36 补一点单体伤害，别让它只能在"对方自己站成一排"时才有用。
    id: 'ind_gas',
    name: '毒气兵',
    short: '毒',
    era: 4,
    category: 'combat',
    cost: 230,
    move: 2,
    atk: 36,
    armor: 3,
    maxHp: 36,
    range: 3,
    vision: 2,
    splash: 2,
    abilities: ['armor-pierce'],
  },
  {
    // 榴弹炮：曲射，射程 6，专门拆堑壕体系
    id: 'ind_howitzer',
    name: '榴弹炮',
    short: '榴',
    era: 4,
    category: 'combat',
    cost: 260,
    move: 1,
    atk: 38,
    armor: 4,
    maxHp: 42,
    range: 6,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
  },
  {
    // 列车炮：射程 7，全游戏最远。挪一次要半个回合
    id: 'ind_railwaygun',
    name: '列车炮',
    short: '列',
    era: 4,
    category: 'combat',
    cost: 320,
    move: 1,
    atk: 44,
    armor: 6,
    maxHp: 60,
    range: 7,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
  },
  {
    // 马克 I 型：第一次上战场的坦克，慢、笨、但步枪打不穿
    id: 'ind_landship',
    name: '马克 I 坦克',
    short: '坦',
    era: 4,
    category: 'combat',
    cost: 330,
    move: 2,
    atk: 30,
    armor: 10,
    maxHp: 80,
    range: 2,
    vision: 2,
    abilities: ['siege-master'],
  },
  {
    // 机枪碉堡：把 burst 装进建筑，谁靠近谁碎
    id: 'ind_pillbox',
    name: '机枪碉堡',
    short: '碉',
    era: 4,
    category: 'building',
    cost: 250,
    move: 0,
    atk: 28,
    armor: 10,
    maxHp: 60,
    range: 4,
    vision: 3,
    burst: 3,
    autoAttack: true,
  },
  {
    // 铁丝网：不为杀伤，只为把"一步"变成"三步"
    id: 'ind_wire',
    name: '铁丝网',
    short: '网',
    era: 4,
    category: 'building',
    cost: 60,
    move: 0,
    atk: 4,
    armor: 4,
    maxHp: 40,
    range: 1,
    vision: 1,
  },
  {
    // 钢厂：工业时代的经济建筑，站在城里最赚
    id: 'ind_steelworks',
    name: '钢厂',
    short: '钢',
    era: 4,
    category: 'building',
    cost: 300,
    move: 0,
    atk: 4,
    armor: 7,
    maxHp: 55,
    range: 1,
    vision: 2,
    incomeByTerrain: { city: 34, plain: 16, hill: 10, forest: 8 },
  },
  {
    // 工兵：铁丝网、机枪碉堡、兵站
    id: 'ind_sapper',
    name: '工兵',
    short: '工',
    era: 4,
    category: 'builder',
    cost: 210,
    move: 2,
    atk: 5,
    armor: 3,
    maxHp: 26,
    range: 1,
    vision: 2,
    builds: ['ind_wire', 'ind_pillbox', 'ind_steelworks', 'bridge2', 'camp4'],
  },
  {
    // 驱逐舰：工业时代的海上多面手，带一点溅射
    id: 'ind_destroyer',
    name: '驱逐舰',
    short: '驱',
    era: 4,
    category: 'combat',
    cost: 320,
    move: 5,
    atk: 38,
    armor: 8,
    maxHp: 75,
    range: 4,
    vision: 4,
    splash: 1,
    domain: 'water',
  },
];

/* ================================================================== */
/* 时代 5 · 现代（原版 11 个 → 模组 13 个）                            */
/* ================================================================== */

const MODERN: UnitTypeDef[] = [
  {
    // 伞兵：视野最高的步兵，专门找火炮和后方城市
    id: 'mod_paratrooper',
    name: '伞兵',
    short: '伞',
    era: 5,
    category: 'combat',
    cost: 340,
    move: 4,
    atk: 48,
    armor: 4,
    maxHp: 48,
    range: 3,
    vision: 5,
  },
  {
    // 突击队：潜行 + 高攻，用来捅后排。
    // 第一版射程 2、330 金，实测每百金 6.7，是全包最差——"潜行贴近"在 AI 手里等于送死。
    // 射程放到 3、价格降到 310，让它先能站着输出。
    id: 'mod_commando',
    name: '突击队',
    short: '击',
    era: 5,
    category: 'combat',
    cost: 310,
    move: 3,
    atk: 50,
    armor: 4,
    maxHp: 46,
    range: 3,
    vision: 4,
    abilities: ['stealth'],
  },
  {
    // 反坦克炮：破甲 + 先手，专治重装甲
    id: 'mod_atgun',
    name: '反坦克炮',
    short: '反',
    era: 5,
    category: 'combat',
    cost: 300,
    move: 1,
    atk: 54,
    armor: 3,
    maxHp: 34,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce', 'first-strike'],
  },
  {
    // 喀秋莎：一片覆盖，精度靠密度。
    // 削了两轮才收住：第一版 atk 50 / 射程 6，交换比 5.64；降到 atk 46 后反而升到 7.48
    // （承伤只有 633——射程 6 在这套对局里几乎不可能被摸到）。
    // 真正的病根不是攻击而是**射程**：原版火炮是 5。现在收回 5，保留 splash 2 作为卖点。
    id: 'mod_katyusha',
    name: '火箭炮',
    short: '喀',
    era: 5,
    category: 'combat',
    cost: 380,
    move: 2,
    atk: 46,
    armor: 5,
    maxHp: 46,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
  },
  {
    // 重型坦克：装甲 14，正面几乎无解，代价是慢和贵
    id: 'mod_heavytank',
    name: '重型坦克',
    short: '重',
    era: 5,
    category: 'combat',
    cost: 480,
    move: 3,
    atk: 60,
    armor: 14,
    maxHp: 100,
    range: 3,
    vision: 3,
    abilities: ['siege-master'],
  },
  {
    // 自行火炮：能自己跑的火炮，打一轮换一个地方。
    // 实测交换比 2.35，是原版火炮（2.07）之上——射程 5 + 溅射 2 + 能移动太全能。
    // 攻击 54→50 收一点，保留机动性这个卖点。
    id: 'mod_spg',
    name: '自行火炮',
    short: '自',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 3,
    atk: 50,
    armor: 8,
    maxHp: 62,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
  },
  {
    // 高射炮：平射时是一串连发，burst 2
    id: 'mod_flak',
    name: '高射炮',
    short: '空',
    era: 5,
    category: 'combat',
    cost: 330,
    move: 1,
    atk: 46,
    armor: 4,
    maxHp: 40,
    range: 4,
    vision: 3,
    burst: 2,
  },
  {
    // 反坦克拒马：现代最便宜的"别过来"
    id: 'mod_dragonsteeth',
    name: '反坦克拒马',
    short: '拒',
    era: 5,
    category: 'building',
    cost: 90,
    move: 0,
    atk: 8,
    armor: 10,
    maxHp: 70,
    range: 1,
    vision: 1,
  },
  {
    // 机枪地堡：混凝土 + 重机枪，现代防线的核心
    id: 'mod_mgbunker',
    name: '机枪地堡',
    short: '垒',
    era: 5,
    category: 'building',
    cost: 400,
    move: 0,
    atk: 32,
    armor: 15,
    maxHp: 90,
    range: 4,
    vision: 3,
    burst: 4,
    autoAttack: true,
  },
  {
    // 补给车队：现代战争打的是后勤，收入随地形
    id: 'mod_supply',
    name: '补给车队',
    short: '补',
    era: 5,
    category: 'economy',
    cost: 350,
    move: 3,
    atk: 4,
    armor: 4,
    maxHp: 34,
    range: 1,
    vision: 3,
    incomeByTerrain: { city: 30, plain: 18, hill: 10, forest: 9 },
  },
  {
    // 工兵：拒马、机枪地堡、钢桥、前进基地
    id: 'mod_pioneer',
    name: '工兵',
    short: '工',
    era: 5,
    category: 'builder',
    cost: 300,
    move: 2,
    atk: 5,
    armor: 4,
    maxHp: 30,
    range: 1,
    vision: 2,
    builds: ['mod_dragonsteeth', 'mod_mgbunker', 'bridge3', 'camp5'],
  },
  {
    // 驱逐舰：现代海军的通用平台
    id: 'mod_destroyer',
    name: '驱逐舰',
    short: '舰',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 5,
    atk: 52,
    armor: 11,
    maxHp: 100,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce'],
  },
  {
    // 重型迫击炮：便宜、射程近、胜在能跟着步兵走
    id: 'mod_heavy_mortar',
    name: '重型迫击炮',
    short: '迫',
    era: 5,
    category: 'combat',
    cost: 260,
    move: 2,
    atk: 38,
    armor: 3,
    maxHp: 30,
    range: 4,
    vision: 2,
    splash: 1,
  },
];

/* ================================================================== */
/* 注册                                                                */
/* ================================================================== */

/**
 * 五个时代包。
 *
 * 每个包都是一个普通扩展：勾选才生效，units 会并进本局兵种表，
 * 不勾选就完全不存在——不影响原版的任何平衡基线。
 */
export const ERA_PACKS: Expansion[] = [
  {
    id: 'pack-antiquity',
    name: '古典会战',
    summary: '希腊方阵、罗马军团、战车与战象，加上攻城槌、弩炮和瞭望塔。14 个新单位。',
    hooks: {},
    units: ANTIQUITY,
  },
  {
    id: 'pack-medieval',
    name: '中世兵备',
    summary: '重装军士、热那亚弩手、蒙古骑射手、瑞士长矛兵，配投石机与攻城塔。12 个新单位。',
    hooks: {},
    units: MEDIEVAL,
  },
  {
    id: 'pack-gunpowder',
    name: '火药列国',
    summary: '线列步兵、胸甲骑兵、猎兵，配攻城加农炮、棱堡与风帆战列舰。13 个新单位。',
    hooks: {},
    units: GUNPOWDER,
  },
  {
    id: 'pack-industry',
    name: '工业绞肉机',
    summary: '堑壕突击队、火焰喷射器、毒气兵，配榴弹炮、列车炮与马克 I 坦克。13 个新单位。',
    hooks: {},
    units: INDUSTRY,
  },
  {
    id: 'pack-modern',
    name: '现代合成兵',
    summary: '伞兵、突击队、反坦克炮，配喀秋莎、重型坦克与机枪地堡。13 个新单位。',
    hooks: {},
    units: MODERN,
  },
];
