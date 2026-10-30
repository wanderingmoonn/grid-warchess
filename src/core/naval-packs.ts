/**
 * 海军扩展：「海战」（naval-fleet）+「现代海军」（naval-modern）。
 *
 * ── 放哪里、怎么组织 ──────────────────────────────────────────────────
 *
 *   src/core/naval-packs.ts     ← 这个文件：能力 + 兵种 + 两条舰队规则 + 两个扩展
 *   src/core/naval-carrier.ts   ← 航母甲板接口（空军扩展接进来的那道口子）
 *   src/core/expansions.ts      ← 只加两行：import + 展开进 EXPANSIONS
 *
 * 除了那两行注册，**没有一行代码落在核心引擎里**（`rules.ts` / `types.ts` /
 * `setup.ts` 一行不动）。所有效果都由现有的扩展接口表达：
 *   · 数值、造价、机位、运输 → `UnitTypeDef` 的既有字段；
 *   · 「岸轰 / 潜航 / 区域防空 / 海上补给 / 旗舰」→ `Expansion.abilities`
 *     （每条能力自带钩子，删掉这个包它们就一起消失）；
 *   · 「封锁 / 港口抢修 / 甲板整备」→ `ExpansionHooks` 的既有钩子。
 *
 * ── 为什么不给海军加新地形 ────────────────────────────────────────────
 *
 * "浅水 / 深水"听起来是海军该有的东西，但它会渗进三处核心：`navigable()`、
 * 寻路、以及城市生成。扩展虽然能登记新地形（`Expansion.terrains`），
 * 却没法告诉 `navigable()` "这一格也算水面"——那就只能改引擎。
 * 所以这一版**不加地形**，改用两条不需要新地形的规则表达"海权"：
 * 封锁（船贴着城，城不回血）和港口抢修（船贴着自家城，每回合修）。
 *
 * ── 数值口径 ─────────────────────────────────────────────────────────
 *
 * 沿用奇幻包那张粗糙的价值模型，只看**同代**对比（贵兵天然更不值，
 * 这是被编制上限压出来的，不是漏洞）：
 *
 *   V = 攻 + 0.45×血 + 5×甲 + 3×射程 + 2.5×移 + 1.5×视野（溅射每级 +4）
 *
 * 现有水军的 V/造价：舢板 1.03、三层桨 0.98、齿轮帆船 0.84、炮艇 0.70、
 * 风帆战列舰 0.67、雷击舰 0.50、铁甲舰 0.58、驱逐舰 0.52、导弹驱逐舰 0.36。
 * 新船就按这条线上落位：E2 0.75~0.80、E3 0.57~0.87（火船是玻璃炮，给高一点）、
 * E4 0.50~0.54、E5 0.49、E6 0.24~0.37。
 */

import type { AbilityDef } from './abilities.ts';
import { DAMAGE_STAGE, TURN_START } from './ability-hooks.ts';
import type { Expansion } from './expansions.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import { navigable } from './config.ts';
import type { ResourceCost } from './resources.ts';
import { airwingOps, deckLine, deckSpecOf } from './naval-carrier.ts';

/* ===========================================================================
 * 一、能力（只在勾了这个包的局里存在）
 * ======================================================================== */

/**
 * 舰炮支援登陆：船打城的伤害 ×1.25。
 *
 * 为什么单开一条能力而不是给所有船：岸轰是**重炮舰**的活。
 * 舢板、火船、运输船打城墙本来就该是挠痒——把这条发给全体水面单位，
 * "海军"就变成了"从水上来的炮兵"，陆军的攻城单位当场失去意义。
 *
 * 它能和「破城」（×1.5）叠起来：战列舰打城是 1.5 × 1.25 ≈ 1.88 倍。
 * 这是有意的——一个一千多金的船，本来就该是攻城效率最高的东西。
 */
const SHORE_BOMBARD: AbilityDef = {
  id: 'nv-shore-bombard',
  name: '岸轰',
  summary: '攻城伤害 ×1.25。舰炮支援登陆，和「破城」可以叠。',
  group: 'attack',
  hooks: {
    siegeDamage: [
      {
        stage: 1,
        apply: (c) => {
          c.damage = Math.round(c.damage * 1.25);
        },
      },
    ],
  },
};

/**
 * 潜航：只有贴到相邻格的敌人才发现得了它，而且打完不挨反击。
 *
 * 这两条都是既有机制，组合起来正好是潜艇：
 *   · `hidden` 走的是"潜行"那条判定（迷雾局里生效，而且**所有**观察者
 *     都要先贴到一格内才发现——这正是"声纳只有这么远"的意思）；
 *   · `noCounter` 是「先手」用的那个旗标：我打你，你没法立刻还手。
 *     水面舰追着潜艇打不到，潜艇却能从水下先动手，这个不对称就是它的全部价值。
 *
 * 注意它**不是无敌**：贴脸就现形，一旦被发现，护甲 9、血量 100 的船
 * 挨两轮齐射就没了。所以潜艇的正确用法是"打完就换位置"，不是站桩。
 */
const SUBMERGE: AbilityDef = {
  id: 'nv-submerge',
  name: '潜航',
  summary: '迷雾局里只有相邻的敌人才发现得了它；攻击不会引来反击。',
  group: 'move',
  hooks: { hidden: () => true, noCounter: true },
};

/**
 * 区域防空：对**空中层**目标多打 12 点。
 *
 * 空军扩展还没来，这条能力现在是"空转"的——但它是这道接口的一部分：
 * 等空军上线，带这条能力的船就是舰队的伞。写在这里而不是等空军包再补，
 * 是因为"哪条船能防空"是海军的设计决定，不该由空军包定义。
 *
 * 判据用 `layer === 'air'`（掠空、飞行都在这一层），不是"有没有飞行能力"：
 * 热气球只在天上、不一定会飞，但它照样是防空炮该打的东西。
 */
const AA_COVER: AbilityDef = {
  id: 'nv-aa-cover',
  name: '区域防空',
  summary: '对空中层目标造成 +12 伤害。空军扩展上线后是舰队的伞。',
  group: 'defense',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (!c.foe) return;
          const foe = c.api.utype(c.state, c.foe.type);
          if (foe.layer === 'air') c.damage += 12;
        },
      },
    ],
  },
};

/**
 * 海上补给：回合开始时，相邻的友方水面单位回 3 点。
 *
 * 用的是 `TURN_START.aura` 这个时机（治疗光环就在这一段），
 * 也就是"轮到我方回合，先处理各种补给，再干活"。
 * 只补水面单位：补给舰的油管子接不到岸上的坦克。
 */
const FLEET_REPAIR: AbilityDef = {
  id: 'nv-fleet-repair',
  name: '海上补给',
  summary: '每回合开始时，相邻的友方水面单位回复 3 点生命。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          let healed = 0;
          for (const u of c.state.units) {
            if (u.owner !== c.owner || u.id === c.self.id) continue;
            if (c.api.utype(c.state, u.type).domain !== 'water') continue;
            if (c.api.distance(u, c.self) > 1) continue;
            const max = c.api.utype(c.state, u.type).maxHp;
            if (u.hp >= max) continue;
            u.hp = Math.min(max, u.hp + 3);
            healed += 1;
          }
          if (healed > 0) {
            c.api.pushLog(c.state, c.owner, `海上补给：${c.api.utype(c.state, c.self.type).name} 给 ${healed} 艘友舰各补 3 点`);
          }
        },
      },
    ],
  },
};

/**
 * 旗舰：相邻友军 +2 攻 +2 甲。
 *
 * 航母在**没有空军扩展**的局里靠这条站住脚：它自己不打人（攻 26、射程 3），
 * 但它是全图视野最好（9）的移动指挥部。这条也让"航母必须待在舰队中间"
 * 成为一条真实的取舍——离得太远，光环就白给了。
 */
const FLEET_COMMAND: AbilityDef = {
  id: 'nv-fleet-command',
  name: '旗舰',
  summary: '相邻的友军 +2 攻击、+2 护甲。航母在空军接入前靠它站住脚。',
  group: 'support',
  hooks: { aura: { allyAtk: 2, allyArmor: 2 } },
};

/**
 * 潜母：给潜艇补氧、补雷、修耐压壳。
 *
 * 为什么单独一条、不复用「海上补给」：那条管水面舰，这条只管潜艇。
 * 合成一条的话，一艘潜母就能同时奶住整支舰队，"编队要带几种支援船"
 * 这个取舍就没了——而取舍正是这一版加这么多舰种的理由。
 */
const SUB_TENDER: AbilityDef = {
  id: 'nv-sub-tender',
  name: '潜母',
  summary: '每回合开始时，相邻的友方潜艇回复 6 点生命（只对潜艇有效）。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          let fixed = 0;
          for (const u of c.state.units) {
            if (u.owner !== c.owner || u.id === c.self.id) continue;
            const def = c.api.utype(c.state, u.type);
            if (!(def.abilities ?? []).includes('nv-submerge')) continue; // 只修潜艇
            if (c.api.distance(u, c.self) > 1) continue;
            if (u.hp >= def.maxHp) continue;
            u.hp = Math.min(def.maxHp, u.hp + 6);
            fixed += 1;
          }
          if (fixed > 0) {
            c.api.pushLog(c.state, c.owner, `潜母：给 ${fixed} 艘潜艇各补 6 点`);
          }
        },
      },
    ],
  },
};

/**
 * 远洋补给：相邻友舰 +1 移动。
 *
 * 和「海上补给」（回血）刻意分工：一个管血、一个管腿。
 * 两条都给同一条船的话，支援舰就只剩"哪个便宜买哪个"一个选择。
 */
const FLEET_OILER: AbilityDef = {
  id: 'nv-fleet-oiler',
  name: '远洋补给',
  summary: '相邻的友方水面单位 +1 移动力。',
  group: 'support',
  hooks: { aura: { allyMove: 1 } },
};

/**
 * 能力各归各家（引擎里有一条测试盯着这件事）。
 *
 * 「岸轰」两个包都会用（浅水重炮舰在「海战」、战列舰在「现代海军」），
 * 所以它挂在基础包上；其余四条只有第六时代的船用，就归「现代海军」。
 * 能力表是**全局合并**的（不看这一局勾了哪些包），所以现代包引用基础包的
 * 能力 id 完全没问题——但反过来"两个包各声明一份"会直接踩测试。
 */
const FLEET_ABILITIES: AbilityDef[] = [SHORE_BOMBARD, SUBMERGE, FLEET_REPAIR, SUB_TENDER];
const MODERN_ABILITIES: AbilityDef[] = [AA_COVER, FLEET_COMMAND, FLEET_OILER];

/* ===========================================================================
 * 二、兵种
 *
 * 全部参照真实历史舰型，按"这个时代的海战在解决什么问题"来定位：
 *   E1 只有舢板/三层桨（撞击与接舷）—— 本体与「古典」已经有，不重复
 *   E2 帆桨并用 + 第一代运输船（德罗蒙、卡拉克）
 *   E3 舷侧炮列（盖伦）+ 纵火（火船）
 *   E4 蒸汽与装甲的过渡（护卫舰、浅水重炮舰）
 *   E5 装甲巡洋舰（无畏舰之前的远洋主力）
 *   E6 航母、战列舰、区域防空巡洋舰、核潜艇、两栖舰、导弹艇、补给舰
 * ======================================================================== */

const FLEET_UNITS: UnitTypeDef[] = [
  {
    id: 'nv_dromon',
    name: '德罗蒙战舰',
    short: '德',
    era: 2,
    category: 'combat',
    cost: 132,
    move: 4,
    atk: 19,
    armor: 5,
    maxHp: 60,
    range: 3,
    vision: 4,
    domain: 'water',
    splash: 1,
    // 拜占庭的"希腊火"：喷出去是一道火墙，不是一根箭。
    // 溅射 1 在 E2 只有它和臼炮有，所以它贵、也脆（甲 5）。
    // V = 19 + 27 + 25 + 9 + 10 + 6 + 4(溅射) = 100 → 0.76 / 金
  },
  {
    id: 'nv_carrack',
    name: '卡拉克帆船',
    short: '卡',
    era: 2,
    category: 'combat',
    cost: 150,
    move: 4,
    atk: 17,
    armor: 6,
    maxHp: 72,
    range: 2,
    vision: 4,
    domain: 'water',
    transport: true,
    capacity: 4,
    // 和齿轮帆船（98 金、容量 3）分工：卡拉克贵一半，换来 4 个舱位和 6 点甲。
    // 跨海投送是"一次运四个"还是"分两趟运两个"，在 20×20 的图上差一整回合。
  },
  {
    id: 'nv_fireship',
    name: '火船',
    short: '火',
    era: 3,
    category: 'combat',
    cost: 105,
    move: 6,
    atk: 40,
    armor: 2,
    maxHp: 34,
    range: 1,
    vision: 3,
    domain: 'water',
    splash: 1,
    // 纵火船：装满火药和沥青冲进敌阵。攻高、血薄、移动快，溅射 1 让它
    // 贴上去就有交换价值。V = 40+15.3+10+3+15+4.5+4 = 92 → 0.87。
    // 这个比值偏高是故意的：它只活一回合，价值模型算不出"活不过一轮"。
  },
  {
    id: 'nv_galleon',
    name: '盖伦帆船',
    short: '盖',
    era: 3,
    category: 'combat',
    cost: 240,
    move: 4,
    atk: 33,
    armor: 8,
    maxHp: 82,
    range: 3,
    vision: 5,
    domain: 'water',
    transport: true,
    capacity: 3,
    // 远洋主力：打得过炮艇（130 金 25 攻），又能运三个兵。
    // 它是"海军独立成军"的起点——从这一代开始，海权不再只是过河的工具。
    // V = 33+36.9+40+9+10+7.5 = 136 → 0.57
  },
  {
    id: 'nv_frigate',
    name: '护卫舰',
    short: '护',
    era: 4,
    category: 'combat',
    cost: 310,
    move: 6,
    atk: 30,
    armor: 8,
    maxHp: 78,
    range: 4,
    vision: 4,
    domain: 'water',
    burst: 2,
    // 蒸汽护卫舰的卖点是"追得上"：移动 6、两动。多动就是两次完整的一击，
    // 所以单发攻击力压到 30（对照雷击舰 38/单发）。
    // V = 60+35.1+40+12+15+6 = 168 → 0.54
  },
  {
    id: 'nv_monitor',
    name: '浅水重炮舰',
    short: '浅',
    era: 4,
    category: 'combat',
    cost: 330,
    move: 3,
    atk: 50,
    armor: 10,
    maxHp: 82,
    range: 4,
    vision: 3,
    domain: 'water',
    splash: 1,
    abilities: ['nv-shore-bombard'],
    // 内河与近岸的浮动炮台：慢、笨、打城墙特别狠（岸轰 + 溅射）。
    // 视野只有 3，离开己方侦察就是瞎子——这是它的代价。
    // V = 50+36.9+50+12+7.5+4.5+4 = 165 → 0.50
  },
  {
    id: 'nv_submarine',
    name: '潜艇',
    short: '艇',
    era: 4,
    category: 'combat',
    cost: 300,
    move: 5,
    atk: 62,
    armor: 6,
    maxHp: 70,
    range: 3,
    vision: 5,
    domain: 'water',
    abilities: ['nv-submerge'],
    // 一战 U 艇：便宜、隐蔽、一发狠。它和第六时代的核潜艇是**同一条线**的两端，
    // 不是重复品——这里射程只有 3、甲 6，被逼出水面就是挨打。
    // V = 62+31.5+30+9+12.5+7.5 = 152 → 0.51
  },
  {
    id: 'nv_transport',
    name: '运输舰',
    short: '运',
    era: 4,
    category: 'combat',
    cost: 300,
    move: 5,
    atk: 6,
    armor: 8,
    maxHp: 110,
    range: 1,
    vision: 5,
    domain: 'water',
    transport: true,
    capacity: 5,
    // 纯运输：五个舱位、几乎不还手。和第六时代的两栖攻击舰分工明确——
    // 两栖能带直升机、能防空、能自保；运输舰只负责"一次把五个人送过去"，
    // 便宜一半，但必须有人护航。V = 6+49.5+40+3+12.5+7.5 = 119 → 0.40
  },
  {
    id: 'nv_cruiser',
    name: '装甲巡洋舰',
    short: '巡',
    era: 5,
    category: 'combat',
    cost: 400,
    move: 5,
    atk: 56,
    armor: 12,
    maxHp: 100,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 无畏舰之前的远洋主力：射程 5、带破甲，专门去啃铁甲舰（甲 11）。
    // V = 56+45+60+15+12.5+7.5 = 196 → 0.49
  },
  {
    id: 'nv_battlecruiser',
    name: '战列巡洋舰',
    short: '巡',
    era: 5,
    category: 'combat',
    cost: 660,
    move: 6,
    atk: 92,
    armor: 12,
    maxHp: 140,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 费舍尔的赌注：战列舰的炮 + 巡洋舰的速度。跑得比战列舰快 2 格，
    // 甲薄 6 点、便宜 120 金——日德兰之后大家都知道"薄皮大炮"意味着什么。
    // 和战列舰**不是替代关系**：追歼、破交、抓巡洋舰用它；顶线用它换不起。
    // V = 92+63+60+15+15+7.5 = 252 → 0.38
  },
  {
    id: 'nv_battleship',
    name: '战列舰',
    short: '战',
    era: 5,
    category: 'combat',
    cost: 780,
    move: 4,
    atk: 95,
    armor: 18,
    maxHp: 180,
    range: 5,
    vision: 5,
    domain: 'water',
    splash: 2,
    abilities: ['armor-pierce', 'siege-master', 'nv-shore-bombard'],
    // **无畏舰**，历史定位落在第五时代（二战），不是第六时代。
    // 全部三项攻城加成（破甲 + 破城 + 岸轰）都在它身上，射程 5、溅射 2——
    // 它是一战到二战之间"大舰巨炮"这条路的终点。
    // 第六时代没有战列舰：1945 年之后没有任何国家再开工建一级，
    // 原因写在 docs/NAVAL-PACK.md（导弹、航母、成本三件事各补一刀）。
    // V = 95+81+90+15+10+7.5+8 = 306 → 0.39
  },
  {
    id: 'nv_light_carrier',
    name: '轻型航空母舰',
    short: '轻',
    era: 5,
    category: 'combat',
    cost: 640,
    move: 5,
    atk: 20,
    armor: 10,
    maxHp: 130,
    range: 3,
    vision: 8,
    domain: 'water',
    abilities: ['nv-aa-cover'],
    // 独立级 / 护航航母：用巡洋舰船体改出来的应急航母。两个机位、
    // 视野 8、能防空，自己几乎不打人。和第六时代的舰队航母分工：
    // 轻母是"数量"，一艘航母的钱能买两艘半轻母。
    // V = 20+58.5+50+9+12.5+12 = 162 → 0.25（甲板的价值不在公式里）
  },
  {
    id: 'nv_aviation_battleship',
    name: '航空战列舰',
    short: '航',
    era: 5,
    category: 'combat',
    cost: 860,
    move: 4,
    atk: 70,
    armor: 16,
    maxHp: 165,
    range: 5,
    vision: 7,
    domain: 'water',
    splash: 1,
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 伊势级那种"拆了后主炮换飞行甲板"的混血。它存在的意义不是强，
    // 而是**告诉你专精更划算**：炮不如战列舰（95→70）、机位只有一个、
    // 比轻母贵 220。造它是因为"我两样都想要"，而两样都想要通常两样都不够。
    // V = 70+74.25+80+15+10+10.5+4 = 264 → 0.31
  },
  {
    id: 'nv_sub_tender',
    name: '潜母',
    short: '母',
    era: 5,
    category: 'combat',
    cost: 460,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 140,
    range: 0,
    vision: 7,
    domain: 'water',
    abilities: ['nv-sub-tender'],
    // 潜水母舰：给潜艇补氧气、补鱼雷、修耐压壳。完全不打人，视野 7。
    // 它和维修舰的分工是**水下 / 水面**：潜母只修潜艇（一次 6 点，比维修舰高），
    // 维修舰只修水面舰。想两样都管就得带两艘船——这就是编队的成本。
    // V = 0+63+50+0+10+10.5 = 134 → 0.29
  },
  {
    id: 'nv_repair_ship',
    name: '维修舰',
    short: '修',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 130,
    range: 0,
    vision: 5,
    domain: 'water',
    abilities: ['nv-fleet-repair'],
    // 海上抢修船：把"回港修三个月"压成"跟着舰队慢慢回"。
    // 不打人、跑得慢，是整支舰队里最该被保护的那条船。
    // V = 0+58.5+50+0+10+7.5 = 126 → 0.30
  },
];

const MODERN_FLEET_UNITS: UnitTypeDef[] = [
  {
    id: 'nv_carrier',
    name: '航空母舰',
    short: '航',
    era: 6,
    category: 'combat',
    cost: 1350,
    move: 3,
    atk: 26,
    armor: 15,
    maxHp: 260,
    range: 3,
    vision: 9,
    domain: 'water',
    // 2×2：占四格、四格都挡路、只在四格里挨一份伤害（见 rules 的 distBetweenUnits）。
    // 这是引擎里"大型单位"的唯一表达方式，也是城市与兵营在用的那套。
    footprint: 2,
    abilities: ['nv-fleet-command', 'nv-aa-cover'],
    // 全图视野最好的船，自己几乎不打人。**它是 `naval-carrier.ts` 那道接口的宿主**：
    // 机位 4、起飞半径 2 写在 DECK_SPECS 里，不写在这儿——甲板规格属于"接口"，
    // 不属于数值表，改它的人应该先看到那份契约。
    //
    // **大型单位**（footprint 2，占 2×2 四格）：
    //   · 好处：四格一起挡路，是一条能封锁航道的船；只在四格里挨一份溅射；
    //   · 代价：需要 2×2 的开阔水面才能造、才能停（一寸宽的河里开不进航母），
    //     而且移动力压到 3——这么大的船掉头本来就慢。
    //   · 血量从 200 提到 260、护甲 14→15、造价 1250→1350：占到四格之后
    //     被围住的风险更高，光靠 200 血撑不住一轮集火。
    //
    // 没有空军扩展时它不是废铁：旗舰光环（相邻 +2/+2）+ 视野 9 + 防空，
    // 是一艘"移动指挥部"。V = 26+117+75+9+7.5+13.5 = 248 → 0.18，
    // 光是船体确实不值这个价——它的价值在甲板、光环和那四格航道上，这三样都不进公式。
  },
  {
    id: 'nv_large_cruiser',
    name: '超巡',
    short: '超',
    era: 6,
    category: 'combat',
    cost: 1050,
    move: 5,
    atk: 85,
    armor: 17,
    maxHp: 175,
    range: 6,
    vision: 6,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 基洛夫级那种核动力大巡洋舰：**它接的是战列舰的位置，但不是战列舰**。
    // 导弹时代的"大舰"是巡洋舰体量——炮只是副业，主战武器是射程 6 的导弹。
    // 所以它没有溅射 2（舰炮不再是主角），但射程和护甲都压过普通巡洋舰。
    // V = 85+78.75+85+18+12.5+9 = 288 → 0.27
  },
  {
    id: 'nv_aegis',
    name: '防空巡洋舰',
    short: '防',
    era: 6,
    category: 'combat',
    cost: 880,
    move: 5,
    atk: 72,
    armor: 15,
    maxHp: 150,
    range: 6,
    vision: 7,
    domain: 'water',
    abilities: ['nv-aa-cover', 'armor-pierce'],
    // 舰队之伞：视野 7 比超巡好，区域防空对空中层多打 12 点。
    // 空军扩展上线之前，它就是"视野好、能打、跑得快"的通用巡洋舰。
    // V = 72+67.5+75+18+12.5+10.5 = 256 → 0.29
  },
  {
    id: 'nv_attack_sub',
    name: '攻击核潜艇',
    short: '潜',
    era: 6,
    category: 'combat',
    cost: 900,
    move: 5,
    atk: 92,
    armor: 9,
    maxHp: 100,
    range: 4,
    vision: 5,
    domain: 'water',
    abilities: ['nv-submerge'],
    // 水下刺客：迷雾局里贴脸才现形，先手不被反击。
    // 它是第四时代那艘「潜艇」的**升级而不是重复**：射程 3→4、攻 62→92、
    // 血 70→100，价格翻三倍。差别在"能不能单挑一支护航队"。
    // V = 92+45+45+12+12.5+7.5 = 214 → 0.24（潜航的价值不在公式里）
  },
  {
    id: 'nv_amphib',
    name: '两栖攻击舰',
    short: '两',
    era: 6,
    category: 'combat',
    cost: 760,
    move: 5,
    atk: 22,
    armor: 12,
    maxHp: 165,
    range: 2,
    vision: 6,
    domain: 'water',
    transport: true,
    capacity: 4,
    abilities: ['nv-aa-cover'],
    // 登陆作战的核心：4 个舱位 + 2 个直升机位（DECK_SPECS 里登记）。
    // 火力很弱（22 攻），它存在的意义是把四个兵送到对岸的城市旁边。
    // 和「运输舰」的分工：运输舰只运（容量 5、更便宜），两栖能自保、能防空、
    // 能带直升机——贵一倍多。
    // V = 22+74.25+60+6+12.5+9 = 184 → 0.24
  },
  {
    id: 'nv_missile_boat',
    name: '导弹快艇',
    short: '导',
    era: 6,
    category: 'combat',
    cost: 400,
    move: 7,
    atk: 58,
    armor: 5,
    maxHp: 58,
    range: 4,
    vision: 5,
    domain: 'water',
    // 空潜快里的"快"：400 金买不到的东西它都有——射程 4、移 7、58 攻。
    // 代价是甲 5、血 58：挨一发战列舰的溅射就没了。
    // V = 58+26.1+25+12+17.5+7.5 = 146 → 0.37（略高于同代，靠脆换来的）
  },
  {
    id: 'nv_oiler',
    name: '舰队补给舰',
    short: '补',
    era: 6,
    category: 'combat',
    cost: 430,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 130,
    range: 0,
    vision: 6,
    domain: 'water',
    abilities: ['nv-fleet-oiler'],
    // 和第五时代的「维修舰」刻意分工：维修舰修血，补给舰给**机动**
    // （相邻友舰 +1 移动）。两种支援不该是同一条船的两个数值版本——
    // 那样玩家只会买便宜的那条，另一条永远不出场。
    // V = 0+58.5+50+0+10+9 = 128 → 0.30
  },
  {
    id: 'nv_oil_platform',
    name: '海上钻井平台',
    short: '井',
    era: 6,
    category: 'economy',
    cost: 480,
    move: 0,
    atk: 0,
    armor: 6,
    maxHp: 90,
    range: 0,
    vision: 3,
    domain: 'water',
    incomeByTerrain: { deep: 50, water: 34, shallow: 20 },
    // 海上经济单位：**造出来就不动了**，收入看它站在什么水上。
    // 深水 50 / 水域 34 / 浅流 20——「深水」是这一版新加的地形，
    // 越往外海走越肥，但也就越难守（离本土远、补给线长）。
    // 回本：480 / 50 = 9.6 回合（深水），比陆上的农业公司（7.2）慢，
    // 换来的是"陆地上没这块地"——岛上或者海峡中间的局，这是唯一的收入增长点。
    //
    // 和海军单位的互动：**敌舰贴着它，它就停产**（见 modifyYield）。
    // 所以它天然要求制海权；反过来，敌方的钻井平台也是最好的袭扰目标——
    // 打掉一座 480 金的平台，比击沉一条 300 金的运输舰更伤经济。
  },
];

/* ===========================================================================
 * 三、两条舰队规则（扩展钩子，纯规则、不绑兵种）
 * ======================================================================== */

/** 城市矩形到某点的曼哈顿距离（在城内为 0）。和 rules 里那套算法同一个口径 */
function cityGap(city: { x: number; y: number; size: number }, p: { x: number; y: number }): number {
  const dx = Math.max(city.x - p.x, 0, p.x - (city.x + city.size - 1));
  const dy = Math.max(city.y - p.y, 0, p.y - (city.y + city.size - 1));
  return dx + dy;
}

/** 封锁的税额：每座 8 金，最多 24 */
const BLOCKADE_PER_CITY = 8;
const BLOCKADE_CAP = 24;

/**
 * 被封锁的城市少交多少税。
 *
 * 纯函数：`incomeResOf` 在热路径上（AI 每回合算预算要问几十次），
 * 这里只数城、数船，不写任何状态。
 */
function blockedIncome(state: GameState, player: PlayerId, income: number): number {
  let lost = 0;
  for (const city of state.cities) {
    if (city.owner !== player || city.ruined) continue;
    if (!blockaded(state, city, player)) continue;
    lost += BLOCKADE_PER_CITY;
    if (lost >= BLOCKADE_CAP) return Math.max(0, income - BLOCKADE_CAP);
  }
  return Math.max(0, income - lost);
}

/** 这一方有没有水面单位贴在城边（封锁） */
function blockaded(s: GameState, city: { x: number; y: number; size: number }, owner: PlayerId): boolean {
  return s.units.some(
    (u) => u.owner !== owner && s.unitTypes[u.type]?.domain === 'water' && cityGap(city, u) <= 1,
  );
}

/* ---------------------------------------------------------------------------
 * 共用规则：两个包都会用到，所以只写一份
 *
 * 「海战」和「现代海军」都要封锁与抢修。两个包各写一遍的话，同时勾上就会
 * **跑两次**：城回血被掐两次（无害），港口修理却会变成每回合回 8 点（有害）。
 * 所以这里写成两个共享函数，并且修理带一个"这一回合已经修过"的标记——
 * 幂等靠数据，不靠"玩家不会同时勾两个包"这种假设。
 * ------------------------------------------------------------------------- */

/** 港口抢修：贴着自家城的水面单位每回合 +4（同回合只算一次） */
function portRepair(state: GameState, player: PlayerId): void {
  for (const u of state.units) {
    if (u.owner !== player) continue;
    const def = state.unitTypes[u.type];
    if (def?.domain !== 'water') continue;
    if (u.hp >= def.maxHp) continue;
    const atPort = state.cities.some((c) => c.owner === player && cityGap(c, u) <= 1);
    if (!atPort) continue;
    // 两个包同时开时这个钩子会被叫两次，靠哨兵挡住第二次
    if (u.custom?.portRepairedTurn === state.turn) continue;
    u.custom = { ...(u.custom ?? {}), portRepairedTurn: state.turn };
    u.hp = Math.min(def.maxHp, u.hp + 4);
  }
}

/**
 * 甲板整备：把"轮到你"这个时机转告空军扩展（没接入就什么都不做）。
 *
 * 两个海军包都挂了这个钩子，所以同一次回合开始会被叫两遍。空军那边的
 * `onDeckTurnStart` 是"先收、再修、后放"的完整一套——跑两遍的后果不是
 * 放两架，而是**刚放出去的那架立刻被收回来再修一次**，玩家看到的是
 * "飞机原地没动、血却多回了 8 点"。所以这里用和 `portRepair` 同一个办法：
 * 在船身上记一个本回合的哨兵，第二遍直接跳过。
 */
function deckUpkeep(state: GameState, player: PlayerId): void {
  const ops = airwingOps();
  if (!ops?.onDeckTurnStart) return;
  for (const u of state.units) {
    if (u.owner !== player) continue;
    if (!deckSpecOf(u.type)) continue;
    if (u.custom?.deckUpkeepTurn === state.turn) continue;
    u.custom = { ...(u.custom ?? {}), deckUpkeepTurn: state.turn };
    ops.onDeckTurnStart({ state, carrier: u });
  }
}

/** 面板行：甲板状态 + 封锁/停泊提示。两个包共用，免得各画一遍出现双份 */
function navalPanelLines(state: GameState, unit: Unit): string[] {
  const lines: string[] = [];
  // 大型单位的体量要写出来：玩家点了半天发现"怎么放不下"，
  // 得有一句话告诉他这不是 bug，是 2×2 的要求。
  if (state.unitTypes[unit.type]?.footprint === 2) {
    lines.push('占地 2×2：四格一起挡路，起飞/停泊都要 2×2 的开阔水面');
  }
  const deck = deckLine(unit);
  if (deck) lines.push(deck);
  const def = state.unitTypes[unit.type];
  if (def?.domain === 'water') {
    const enemyCity = state.cities.find((c) => c.owner !== unit.owner && cityGap(c, unit) <= 1);
    if (enemyCity) lines.push(`正在封锁敌城外港：它这一回合少收 ${BLOCKADE_PER_CITY} 金`);
    const ownCity = state.cities.find((c) => c.owner === unit.owner && cityGap(c, unit) <= 1);
    if (ownCity) lines.push('停在自家港口：每回合回复 4 点');
  }
  return lines;
}

/* ---------------------------------------------------------------------------
 * 深水与钻井平台：两个包里都要用，同样只写一份
 * ------------------------------------------------------------------------- */

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 把离岸两格以上的 water 改写成 deep。
 *
 * 为什么走 `afterTerrain` 而不是让 mapgen 直接画：地形生成器是本体的事，
 * 让它认识一种"扩展才有的格子"，等于把扩展规则缝进核心。`afterTerrain`
 * 拿到的是已经画完的整张图，就地改——「地形高差」补山脚用的也是这一招。
 *
 * 只改 `water`，不动 `shallow`：浅流是"陆军能踩过去的水"，把它深水化
 * 等于偷偷改了整张图的可通行性（陆军的过河点会凭空消失）。
 */
const deepenWater: NonNullable<Expansion['afterTerrain']> = (g, w, h) => {
  // 从所有陆地出发做一遍 BFS，水格的层数就是"离岸几步"
  const far = new Int16Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < g.length; i++) {
    if (navigable(g[i]!)) continue;
    far[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = ny * w + nx;
      if (!navigable(g[k]!)) continue;
      if (far[k] !== -1) continue;
      far[k] = far[i]! + 1;
      queue.push(k);
    }
  }
  // 离岸 >=2 格才算外海：沿岸那一圈留成水域，
  // 这样"贴着岸能不能下水/靠港"的老判定一条都不用改。
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== 'water') continue;
    if (far[i]! >= 2) g[i] = 'deep';
  }
};

/**
 * 钻井平台：敌舰贴着就停产。
 *
 * 走 `modifyYield` 而不是"改 unit.income"：那个字段是兵种表里的共享定义，
 * 改它等于给全场所有平台一起停产。钩子是按单位算的，天然分得清。
 *
 * 只对**水上经济单位**生效：陆地上的农田不该被一条路过的船掐掉收入。
 */
function platformYield(state: GameState, unit: Unit, yields: ResourceCost): ResourceCost {
  const def = state.unitTypes[unit.type];
  if (def?.category !== 'economy' || def.domain !== 'water') return yields;
  const cut = state.units.some((u) => {
    if (u.owner === unit.owner) return false;
    if (state.unitTypes[u.type]?.domain !== 'water') return false;
    return Math.abs(u.x - unit.x) + Math.abs(u.y - unit.y) <= 1;
  });
  return cut ? {} : yields;
}

/**
 * 「海战」：E2~E5 的七条船 + 封锁与抢修。
 *
 * 为什么这两条规则要单独放在包上、而不是做成能力：
 * 它们说的是"**海权**有什么意义"，不是某条船的特长。做成能力的话，
 * 玩家会以为"只有带这条能力的船才能封锁"，而现实是任何一条船堵在港口
 * 都能让城断粮——规则的口径应该和直觉一致。
 *
 * 封锁掐的是**税收**，不是回血。本来想掐回血的，翻了一遍核心才发现
 * `cityRegenOf()` 里已经有一条"城外有敌人就不回血"（围城），任何单位贴着
 * 城都算——再写一遍就是同一条规则的两份实现，看着像新机制，其实什么都不做。
 * 所以改成断收入：三座城被堵各自少 8 金，一回合少 24，这才是"海权"该有的疼。
 */
export const NAVAL_FLEET: Expansion = {
  id: 'naval-fleet',
  name: '海战',
  scale: 'large',
  summary:
    '补上第二到第五时代的水上力量：德罗蒙、卡拉克、火船、盖伦、护卫舰、浅水重炮舰、潜艇、运输舰、' +
    '装甲巡洋舰、战列巡洋舰、战列舰、轻型航母、航空战列舰、潜母、维修舰十五条船；' +
    '两条海权规则（封锁港口断税收、贴着自家城抢修），以及**深水**地形' +
    '（离岸两格以上的外海，只有船进得去，大舰吃水深进不了浅流）。',
  abilities: FLEET_ABILITIES,
  units: FLEET_UNITS,
  terrains: ['deep'],
  afterTerrain: deepenWater,
  hooks: {
    /** 钻井平台：敌舰贴着就停产（海战包先开，现代海军再开也不会叠加出错） */
    modifyYield: ({ state, unit, yields }) => platformYield(state, unit, yields),
    /**
     * 封锁：敌方水面单位贴着你的城，那座城这一回合的税收断掉。
     *
     * 每座 −8 金、最多 −24（也就是三座城封顶）。为什么封顶：
     * 后期四城全开的话，一条 45 金的舢板堵满四条水路能让对面直接破产，
     * 而"派一条船过去"根本不该有这么高的赔率。
     */
    modifyIncome: ({ state, player, income }) => blockedIncome(state, player, income),

    /**
     * 回合开始：港口抢修（+ 甲板整备，如果空军扩展接了进来）。
     *
     * 抢修的数值（4 点）是照"回一趟港要两三个回合"定的：
     * 一条 100 血的巡洋舰从残血修回来要十几回合，所以它只是"不用回城",
     * 不是"永不沉没"。真正让它沉的是被围住——围住就没有自家城可贴。
     */
    onTurnStart: ({ state, player }) => {
      portRepair(state, player);
      deckUpkeep(state, player);
    },

    /**
     * 面板：航母多一行甲板状态；船在封锁/停泊时给一句提示。
     *
     * 这一行是**接口的可见部分**：没有空军扩展时它明说"未接入"，
     * 而不是画一个空甲板让人以为飞机掉了。
     */
    getUnitPanelLines: ({ state, unit }) => navalPanelLines(state, unit),
  },
};

/**
 * 「现代海军」：第六时代的七条船，**依赖「现代」**。
 *
 * 为什么一定要 `requires`：第六时代是「现代」这个包开出来的（`unlockEra: 6`）。
 * 单勾「现代海军」的话，城市永远升不到 6 级，这批船一条都造不出来——
 * 在玩家眼里就是"这个包坏了"。写上依赖之后，开局面板会把「现代」一起补上。
 */
export const MODERN_NAVAL: Expansion = {
  id: 'naval-modern',
  name: '现代海军',
  requires: ['pack-contemporary'],
  scale: 'large',
  summary:
    '第六时代的海上力量：航空母舰（甲板接口，等空军扩展接进来）、超巡、防空巡洋舰、' +
    '攻击核潜艇（潜航）、两栖攻击舰、导弹快艇、舰队补给舰、海上钻井平台。' +
    '**第六时代没有战列舰**——它停在第五时代（二战），1945 年之后再没有国家开工建过一级。' +
    '航母的机位与起飞半径写在 naval-carrier.ts 的 DECK_SPECS 里，不在这张数值表上。',
  abilities: MODERN_ABILITIES,
  units: MODERN_FLEET_UNITS,
  // 只开「现代海军」也想要深水（钻井平台的产出靠它）——两个包都登记一次，
  // 沙箱画笔那边会去重，afterTerrain 也是幂等的。
  terrains: ['deep'],
  afterTerrain: deepenWater,
  hooks: {
    /** 钻井平台：敌舰贴着就停产 */
    modifyYield: ({ state, unit, yields }) => platformYield(state, unit, yields),
    // 封锁与抢修是海军共同的规则，两个包各写一份就会走散（改一处忘一处），
    // 所以这里直接复用同一套实现——封锁是纯函数（同样输入同样输出），
    // 抢修带"这一回合修过"的哨兵，重合也不会有副作用。
    modifyIncome: ({ state, player, income }) => blockedIncome(state, player, income),

    onTurnStart: ({ state, player }) => {
      // 先整备再修船：空军扩展可能在这一步把飞机放回甲板/扣燃油，
      // 顺序固定下来，两个包同时开时行为一致
      deckUpkeep(state, player);
      portRepair(state, player);
    },

    getUnitPanelLines: ({ state, unit }) => navalPanelLines(state, unit),
  },
};

/** 空军扩展接入时用得上的：把一个已经贴着母舰的飞机收进甲板 */
export function tryRecoverPlane(state: GameState, carrier: Unit, plane: Unit): { ok: boolean; reason?: string } {
  const ops = airwingOps();
  if (!ops) return { ok: false, reason: '没有空军扩展接入' };
  return ops.recover({ state, carrier, plane });
}
