/**
 * 空军扩展：「空军」（air-corps，第四~第五时代）+「现代空军」（air-modern，第六时代）。
 *
 * ── 放在哪里 ──────────────────────────────────────────────────────────
 *
 *   src/core/air-packs.ts      ← 这个文件：6 条能力 + 18 个兵种 + 两个扩展 + 航母甲板的
 *                                空军侧实现（AirwingOps）
 *   src/core/naval-carrier.ts  ← 海军那边的契约（DECK_SPECS / AirwingOps / 收放容器）
 *   src/core/expansions.ts     ← 只加两行注册
 *
 * 引擎一行不改：空中层（`layer: 'air'`）、掠水（`flight: true`）、
 * "地面打空中 +1 格"（`strikeDistance`）都是既有规则，空军只是**用**它们。
 *
 * ── 三条设计原则 ───────────────────────────────────────────────────────
 *
 * 1. **飞行不是免伤**。地面单位射程 ≥2 就能打到相邻的空中单位
 *    （`strikeDistance` 对"地面打空中" +1），所以一架飞机贴着防空炮站，
 *    等于把肚子亮出来。飞行买的是**机动与视野**，不是无敌。
 * 2. **每种飞机只擅长一件事**。制空的打不动地、对地的打不过制空、
 *    轰炸机只能炸城和堆、支援机不会打架。想全都要，就得多带几种。
 * 3. **便宜的一定脆**。无人机 280 金、视野 10，但它只有 40 血——
 *    它的用法是"去看、去换"，不是"去赢"。
 */

import type { AbilityDef } from './abilities.ts';
import { DAMAGE_STAGE } from './ability-hooks.ts';
import type { Expansion } from './expansions.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import type { AirwingOps, LaunchCtx, RecoverCtx } from './naval-carrier.ts';
import { registerAirwingOps, deckFree, deckOf, popPlane, stowPlane, deckSpecOf } from './naval-carrier.ts';

/* ===========================================================================
 * 一、能力
 * ======================================================================== */

/**
 * 制空：对**空中层**目标多打 12 点。
 *
 * 这条是"战斗机为什么存在"的全部答案。没有它，战斗机就只是"飞得快的高攻单位"，
 * 打轰炸机和打坦克的账一样——那空军就没有制空这个概念了。
 *
 * 判据用 `layer === 'air'`，和海军那条「区域防空」（nv-aa-cover）同一个口径，
 * 所以两条可以叠：防空巡洋舰 + 战斗机一起咬一架轰炸机，是这套规则里最贵的死法。
 */
const AIR_SUPERIORITY: AbilityDef = {
  id: 'af-superiority',
  name: '制空',
  summary: '对空中层目标造成 +12 伤害。战斗机的本职。',
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (!c.foe) return;
          if (c.api.utype(c.state, c.foe.type).layer !== 'air') return;
          c.damage += 12;
        },
      },
    ],
  },
};

/**
 * 对地攻击：打**地面层**目标 +14。
 *
 * 强击机、攻击机、武装直升机、无人机挂这条。它和「制空」互斥地定义了空军的
 * 两条主线：一条抢天空，一条砸地面。挂了对地的飞机去打飞机，收益只有基础值。
 */
const GROUND_STRIKE: AbilityDef = {
  id: 'af-ground-strike',
  name: '对地攻击',
  summary: '对地面层目标造成 +14 伤害。强击机与攻击机的本职。',
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (!c.foe) return;
          if (c.api.utype(c.state, c.foe.type).layer === 'air') return;
          c.damage += 14;
        },
      },
    ],
  },
};

/**
 * 反舰：打**水面单位** +12。
 *
 * 这是空军与海军之间的第一座桥：俯冲轰炸机、舰载机、鱼雷机打船特别狠。
 * 它让"没有制空权的舰队"变成一个真实的处境——二战太平洋战场就是这么打的。
 */
const ANTI_SHIP: AbilityDef = {
  id: 'af-anti-ship',
  name: '反舰',
  summary: '对水面单位造成 +12 伤害。',
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (!c.foe) return;
          if (c.api.utype(c.state, c.foe.type).domain !== 'water') return;
          c.damage += 12;
        },
      },
    ],
  },
};

/**
 * 隐身：雷达看不见，而且先手不被反击。
 *
 * 复用既有两条机制（`hidden` 走潜行判定、`noCounter` 是先手那个旗标），
 * 所以"迷雾局里贴脸才发现"这条规则对隐身机和潜艇是同一条——一致性白拿。
 */
const STEALTH: AbilityDef = {
  id: 'af-stealth',
  name: '隐身',
  summary: '迷雾局里只有相邻的敌人才发现得了它；攻击不会引来反击。',
  group: 'move',
  hooks: { hidden: () => true, noCounter: true },
};

/**
 * 空中指挥：相邻友军 +2 攻。
 *
 * 预警机自己一发子弹都没有，价值全在"看得远 + 让身边的人打得更准"。
 * 这条也解释了为什么它该被护航——打掉一架预警机，整支编队的输出都掉一档。
 */
const AIR_COMMAND: AbilityDef = {
  id: 'af-command',
  name: '空中指挥',
  summary: '相邻的友军 +2 攻击。预警机的价值不在自己开火。',
  group: 'support',
  hooks: { aura: { allyAtk: 2 } },
};

/**
 * 电子压制：相邻敌军 −2 攻。
 *
 * 和「空中指挥」正好相反的一侧：一个加自己人，一个削对面。
 * 摆在一起就是"要不要为了两支部队都带一架不打架的飞机"这个取舍。
 */
const JAMMING: AbilityDef = {
  id: 'af-jam',
  name: '电子压制',
  summary: '相邻的敌军 −2 攻击。',
  group: 'support',
  hooks: { aura: { foeAtk: -2 } },
};

const AIR_ABILITIES: AbilityDef[] = [
  AIR_SUPERIORITY,
  GROUND_STRIKE,
  ANTI_SHIP,
  STEALTH,
  AIR_COMMAND,
  JAMMING,
];

/* ===========================================================================
 * 二、兵种
 *
 * 数值口径同海军：V = 攻 + 0.45×血 + 5×甲 + 3×射程 + 2.5×移 + 1.5×视野（溅射每级 +4）。
 * 飞机的移/视天生高，所以它们的"贵"是买机动，不是买火力——
 * 同代陆军的 V/价比飞机高得多，这是对的：一架飞机的价值在"它够得着哪儿"。
 * ======================================================================== */

/** 所有飞机共有的字段：空中层 + 掠水（能停在海上，包括深水） */
const AIRFRAME = { layer: 'air', flight: true } as const;

const AIR_CORPS_UNITS: UnitTypeDef[] = [
  {
    id: 'af_balloon',
    name: '侦察气球',
    short: '球',
    era: 4,
    category: 'combat',
    cost: 90,
    move: 2,
    atk: 0,
    armor: 0,
    maxHp: 30,
    range: 0,
    vision: 9,
    ...AIRFRAME,
    // 一战前线的炮兵之眼：不能打、跑得慢、一打就掉。
    // 90 金买 9 格视野，是这个游戏里最便宜的"看见"。
    // V = 0+13.5+0+0+5+13.5 = 32 → 0.36
  },
  {
    id: 'af_scout',
    name: '侦察机',
    short: '侦',
    era: 4,
    category: 'combat',
    cost: 150,
    move: 7,
    atk: 14,
    armor: 1,
    maxHp: 45,
    range: 1,
    vision: 10,
    ...AIRFRAME,
    // 视野 10 是全场最高一档，代价是几乎打不动人。
    // V = 14+20.25+5+3+17.5+15 = 75 → 0.50
  },
  {
    id: 'af_biplane',
    name: '双翼战斗机',
    short: '翼',
    era: 4,
    category: 'combat',
    cost: 210,
    move: 8,
    atk: 26,
    armor: 2,
    maxHp: 60,
    range: 2,
    vision: 6,
    ...AIRFRAME,
    // 第一代制空权：射程 2、移动 8，能咬住对面的侦察机。
    // V = 26+27+10+6+20+9 = 98 → 0.47
  },
  {
    id: 'af_fighter',
    name: '活塞战斗机',
    short: '战',
    era: 5,
    category: 'combat',
    cost: 340,
    move: 9,
    atk: 44,
    armor: 4,
    maxHp: 80,
    range: 3,
    vision: 7,
    ...AIRFRAME,
    abilities: ['af-superiority'],
    // 二战制空主力：射程 3 + 制空 +12，空战里稳吃轰炸机和强击机。
    // V = 44+36+20+9+22.5+10.5 = 142 → 0.42
  },
  {
    id: 'af_dive_bomber',
    name: '俯冲轰炸机',
    short: '俯',
    era: 5,
    category: 'combat',
    cost: 380,
    move: 8,
    atk: 62,
    armor: 3,
    maxHp: 85,
    range: 2,
    vision: 6,
    ...AIRFRAME,
    abilities: ['af-anti-ship'],
    // 斯图卡那条线：反舰 +12，是舰队的噩梦。但射程只有 2，
    // 贴着防空巡洋舰（区域防空 +12）就是互相换命。
    // V = 62+38.25+15+6+20+9 = 150 → 0.40
  },
  {
    id: 'af_sturmovik',
    name: '强击机',
    short: '强',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 6,
    atk: 66,
    armor: 7,
    maxHp: 110,
    range: 2,
    vision: 5,
    ...AIRFRAME,
    abilities: ['af-ground-strike'],
    // 伊尔-2：装甲 7 是所有飞机里最厚的，对地 +14。
    // 它是"空中坦克歼击车"，不是战斗机——遇到制空机只能挨打。
    // V = 66+49.5+35+6+15+7.5 = 179 → 0.43
  },
  {
    id: 'af_heavy_bomber',
    name: '重型轰炸机',
    short: '轰',
    era: 5,
    category: 'combat',
    cost: 620,
    move: 5,
    atk: 52,
    armor: 4,
    maxHp: 160,
    range: 4,
    vision: 6,
    ...AIRFRAME,
    splash: 1,
    abilities: ['siege-master'],
    // B-17：射程 4、溅射 1、破城。它的目标从来不是兵，是城和堆。
    // 打野战部队性价比极低（52 攻打不动重甲），所以它必须有人护航。
    // V = 52+72+20+12+12.5+9+4 = 181 → 0.29
  },
  {
    id: 'af_transport',
    name: '运输机',
    short: '运',
    era: 5,
    category: 'combat',
    cost: 300,
    move: 8,
    atk: 4,
    armor: 3,
    maxHp: 120,
    range: 1,
    vision: 6,
    ...AIRFRAME,
    transport: true,
    capacity: 2,
    // 空运：两个舱位，能把兵丢到任何一块相邻的陆地上（越过海峡也算）。
    // 卸载的落点判定和运输船是同一条（`blockedFor`），所以不会把坦克丢进海里。
    // V = 4+54+15+3+20+9 = 105 → 0.35
  },
  {
    id: 'af_naval_plane',
    name: '舰载机',
    short: '舰',
    era: 5,
    category: 'combat',
    cost: 330,
    move: 8,
    atk: 38,
    armor: 3,
    maxHp: 70,
    range: 3,
    vision: 7,
    ...AIRFRAME,
    abilities: ['af-anti-ship'],
    // **能上舰**（见 CARRIER_CAPABLE）。它比同代战斗机便宜、比俯冲轰炸机全能，
    // 但两头都不精——这正是舰载机在历史上的样子：为了能上舰，什么都得让一点。
    // V = 38+31.5+15+9+20+10.5 = 124 → 0.38
  },
];

const MODERN_AIR_UNITS: UnitTypeDef[] = [
  {
    id: 'af_jet',
    name: '喷气战斗机',
    short: '喷',
    era: 6,
    category: 'combat',
    cost: 700,
    move: 12,
    atk: 78,
    armor: 5,
    maxHp: 90,
    range: 4,
    vision: 8,
    ...AIRFRAME,
    abilities: ['af-superiority'],
    // 移动 12：全游戏最快的单位，一圈能横穿半张 20×20 的图。
    // 制空 +12 + 射程 4，空战无敌——但它对地只有 78 的裸值，砸不动重甲。
    // V = 78+40.5+25+12+30+12 = 198 → 0.28
  },
  {
    id: 'af_stealth',
    name: '隐身战斗机',
    short: '隐',
    era: 6,
    category: 'combat',
    cost: 900,
    move: 12,
    atk: 86,
    armor: 4,
    maxHp: 85,
    range: 4,
    vision: 8,
    ...AIRFRAME,
    abilities: ['af-superiority', 'af-stealth'],
    // 隐身 + 先手：迷雾局里摸到脸上才被发现，而且打你不挨反击。
    // 代价是甲 4、血 85——被护航机咬住就没了。
    // V = 86+38.25+20+12+30+12 = 198 → 0.22
  },
  {
    id: 'af_attack_jet',
    name: '攻击机',
    short: '攻',
    era: 6,
    category: 'combat',
    cost: 620,
    move: 9,
    atk: 88,
    armor: 8,
    maxHp: 120,
    range: 2,
    vision: 6,
    ...AIRFRAME,
    abilities: ['af-ground-strike'],
    // A-10 那一挂：对地 +14、甲 8，专治坦克集群。射程只有 2，
    // 意味着它必须飞进防空圈里干活——这是它的全部风险。
    // V = 88+54+40+6+22.5+9 = 219 → 0.35
  },
  {
    id: 'af_heli',
    name: '武装直升机',
    short: '直',
    era: 6,
    category: 'combat',
    cost: 480,
    move: 7,
    atk: 60,
    armor: 6,
    maxHp: 100,
    range: 2,
    vision: 7,
    ...AIRFRAME,
    abilities: ['af-ground-strike'],
    // 比攻击机便宜、比它慢、比它脆，但**便宜一半还多**。
    // 反装甲的性价比之选：三架直升机的价钱顶一架攻击机，覆盖的面积还更大。
    // V = 60+45+30+6+17.5+10.5 = 169 → 0.35
  },
  {
    id: 'af_drone',
    name: '无人机',
    short: '无',
    era: 6,
    category: 'combat',
    cost: 280,
    move: 9,
    atk: 44,
    armor: 1,
    maxHp: 40,
    range: 3,
    vision: 10,
    ...AIRFRAME,
    abilities: ['af-ground-strike'],
    // 消耗品：280 金、视野 10、对地 +14，40 血。
    // 它的正确用法是"去看、去换、去逼对方开火"——不是去赢。
    // V = 44+18+5+9+22.5+15 = 113 → 0.40（纸面偏高，靠 40 血拉回来）
  },
  {
    id: 'af_strategic',
    name: '战略轰炸机',
    short: '略',
    era: 6,
    category: 'combat',
    cost: 950,
    move: 8,
    atk: 74,
    armor: 6,
    maxHp: 200,
    range: 3,
    vision: 7,
    ...AIRFRAME,
    splash: 2,
    abilities: ['siege-master'],
    // 溅射 2 + 破城：一座城在它面前是"一片"而不是"一个点"。
    // 200 血 + 甲 6 让它挨得住两三轮防空，但制空机一来照样掉。
    // V = 74+90+30+9+20+10.5+8 = 241 → 0.25
  },
  {
    id: 'af_awacs',
    name: '预警机',
    short: '警',
    era: 6,
    category: 'combat',
    cost: 620,
    move: 8,
    atk: 0,
    armor: 4,
    maxHp: 140,
    range: 0,
    vision: 13,
    ...AIRFRAME,
    abilities: ['af-command'],
    // 视野 13（整张 20×20 的图能看掉三分之二）+ 相邻友军 +2 攻。
    // 它自己一发子弹都没有，是全场最该被护航的单位。
    // V = 0+63+20+0+20+19.5 = 123 → 0.20
  },
  {
    id: 'af_ew',
    name: '电子战机',
    short: '电',
    era: 6,
    category: 'combat',
    cost: 660,
    move: 10,
    atk: 20,
    armor: 4,
    maxHp: 110,
    range: 3,
    vision: 9,
    ...AIRFRAME,
    abilities: ['af-jam'],
    // 相邻敌军 −2 攻。它不杀伤，但能让对面整条战线少打一截——
    // 摆位比数值重要：贴着对方主力飞，收益最大，也最容易被打下来。
    // V = 20+49.5+20+9+25+13.5 = 137 → 0.21
  },
  {
    id: 'af_heavy_transport',
    name: '重型运输机',
    short: '重',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 10,
    atk: 6,
    armor: 4,
    maxHp: 170,
    range: 1,
    vision: 7,
    ...AIRFRAME,
    transport: true,
    capacity: 4,
    // 四个舱位、移动 10：一次能把半个小队丢到地图另一头。
    // 和运输舰的分工：船要港口、它不用；但船能停在海上等，它得落地。
    // V = 6+76.5+20+3+25+10.5 = 141 → 0.27
  },
];

/* ===========================================================================
 * 三、航母甲板：空军侧的实现（海军交甲板，空军交实现）
 * ======================================================================== */

/**
 * 哪些飞机能上舰。
 *
 * 这是一份**白名单**，不是"按属性猜"：能不能上舰是工程问题（起落架、机翼折叠、
 * 弹射/拦阻），不是数值问题。重型轰炸机和运输机永远上不去。
 */
const CARRIER_CAPABLE: ReadonlySet<string> = new Set([
  'af_naval_plane',
  'af_jet',
  'af_attack_jet',
  'af_awacs', // 预警机（E-2 那类）本来就是舰载的
]);

/** 这些扩展开着时，甲板才归空军管 */
const AIR_PACKS = ['air-corps', 'air-modern'];

function airEnabled(state: GameState): boolean {
  return (state.config.expansionIds ?? []).some((id) => AIR_PACKS.includes(id));
}

/** 在母舰周围找一个能停飞机的空格（空中层不占地面格，但一格只能有一架飞机） */
function findAirspace(state: GameState, carrier: Unit, radius: number): { x: number; y: number } | null {
  for (let r = 1; r <= Math.max(1, radius); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== r) continue;
        const x = carrier.x + dx;
        const y = carrier.y + dy;
        if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
        // 已经有飞机停在那一格就不行（同层互斥）；地面单位不影响
        const busy = state.units.some(
          (u) => u.x === x && u.y === y && state.unitTypes[u.type]?.layer === 'air',
        );
        if (busy) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * 空军交付给海军的那份实现。
 *
 * 职责边界（和 naval-carrier.ts 里那份契约逐条对应）：
 *   · 上舰资格：这份白名单说了算（`canBoard`）；
 *   · 起飞：落点、编队、这一回合还能不能动，全归这里（`launch`）；
 *   · 回收：能不能收、收进来之后存什么（`recover`）；
 *   · 整备：每回合轮到航母时干什么（`onDeckTurnStart`）。
 * 海军那边一行都不解读这些数据，它只负责"甲板还剩几个位置"和"轮到你整备了"。
 */
const AIRWING_OPS: AirwingOps = {
  id: 'air-core',
  name: '舰载航空兵',

  canBoard: ({ planeTypeId }) => CARRIER_CAPABLE.has(planeTypeId),

  launch: ({ state, carrier, plane }: LaunchCtx) => {
    if (!airEnabled(state)) return { ok: false as const, reason: '这一局没有开启空军扩展' };
    const spec = deckSpecOf(carrier.type);
    if (!spec) return { ok: false as const, reason: '这艘船没有甲板' };
    const spot = findAirspace(state, carrier, spec.launchRange);
    if (!spot) return { ok: false as const, reason: '甲板周围没有空域了' };
    const def = state.unitTypes[plane.type];
    if (!def) return { ok: false as const, reason: '兵种表里没有这种飞机' };

    const id = `air${state.nextUnitSeq++}`;
    state.units.push({
      id,
      type: plane.type,
      owner: carrier.owner,
      x: spot.x,
      y: spot.y,
      hp: Math.min(def.maxHp, Math.max(1, plane.hp)),
      kills: plane.kills ?? 0,
      moved: true, // 起飞占掉这一回合的移动：它刚从甲板上滑出去
      acted: false,
    });
    // 起飞成功才从甲板上取走
    popPlane(carrier, 0);
    return { ok: true as const };
  },

  recover: ({ state, carrier, plane }: RecoverCtx) => {
    if (!airEnabled(state)) return { ok: false as const, reason: '这一局没有开启空军扩展' };
    if (!CARRIER_CAPABLE.has(plane.type)) return { ok: false as const, reason: '这种飞机上不了舰' };
    if (deckFree(carrier) <= 0) return { ok: false as const, reason: '甲板满了' };
    if (Math.abs(plane.x - carrier.x) + Math.abs(plane.y - carrier.y) > 2) {
      return { ok: false as const, reason: '离母舰太远，回不来' };
    }
    stowPlane(carrier, plane);
    state.units = state.units.filter((u) => u.id !== plane.id);
    return { ok: true as const };
  },

  /**
   * 每回合轮到航母时：**先收、再修、后放**。
   *
   * 这个顺序是有讲究的：
   *   · 先收：贴着母舰的飞机算"返航"，进甲板；
   *   · 再修：甲板上的飞机每回合回 8 点（整备）——不加这条，飞机就成了一次性的；
   *   · 后放：每回合放**一架**。放太快会让"甲板容量"这个数字失去意义。
   */
  onDeckTurnStart: ({ state, carrier }) => {
    if (!airEnabled(state)) return;
    const spec = deckSpecOf(carrier.type);
    if (!spec) return;

    // 1) 返航：贴着母舰的舰载机自动收进甲板
    for (const u of [...state.units]) {
      if (u.owner !== carrier.owner) continue;
      if (!CARRIER_CAPABLE.has(u.type)) continue;
      if (Math.abs(u.x - carrier.x) + Math.abs(u.y - carrier.y) > 1) continue;
      if (deckFree(carrier) <= 0) break;
      AIRWING_OPS.recover({ state, carrier, plane: u });
    }

    // 2) 整备：甲板上的飞机每回合回 8 点（上限是兵种血量）
    for (const p of deckOf(carrier)) {
      const max = state.unitTypes[p.type]?.maxHp ?? p.hp;
      p.hp = Math.min(max, p.hp + 8);
    }

    // 3) 放飞：每回合最多一架，出不去就留着
    if (deckFree(carrier) < spec.capacity) {
      const first = deckOf(carrier)[0];
      if (first) AIRWING_OPS.launch({ state, carrier, plane: first });
    }
  },
};

// 模块加载即注册：空军这套实现是"唯一的一份"，谁开航母都走它。
// 具体行为还会再查一次 airEnabled(state)，所以关掉扩展的对局里它什么都不做。
registerAirwingOps(AIRWING_OPS);

/** 给界面/未来动作留的显式入口：把甲板上第 index 架放飞出去 */
export function launchFromCarrier(state: GameState, carrier: Unit): { ok: boolean; reason?: string } {
  const planes = deckOf(carrier);
  const first = planes[0];
  if (!first) return { ok: false, reason: '甲板是空的' };
  const r = AIRWING_OPS.launch({ state, carrier, plane: first });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** 给界面/未来动作留的显式入口：把贴着母舰的这架飞机收进甲板 */
export function recoverToCarrier(state: GameState, carrier: Unit, plane: Unit): { ok: boolean; reason?: string } {
  const r = AIRWING_OPS.recover({ state, carrier, plane });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/* ===========================================================================
 * 四、两个扩展
 * ======================================================================== */

/**
 * 「空军」：第四、第五时代。
 *
 * 为什么从第四时代开始：第三时代（火药）之前没有"飞机"这种东西，
 * 硬塞进来就得编；而气球、双翼机、二战机群正好填第四、第五两代。
 */
export const AIR_CORPS: Expansion = {
  id: 'air-corps',
  name: '空军',
  scale: 'large',
  summary:
    '补上第四、第五时代的空中力量：侦察气球、侦察机、双翼战斗机、活塞战斗机、俯冲轰炸机、' +
    '强击机、重型轰炸机、运输机、舰载机九个兵种。空军不是免伤——地面单位射程 ≥2 就能打到' +
    '相邻的飞机；飞行买的是机动与视野。舰载机能上航空母舰（海军扩展）。',
  abilities: AIR_ABILITIES,
  units: AIR_CORPS_UNITS,
  hooks: {},
};

/**
 * 「现代空军」：第六时代，`requires: ['pack-contemporary', 'air-corps']`。
 *
 * 第六时代是「现代」开出来的，单勾这个包会得到一堆造不出来的飞机——
 * 那是"包坏了"，不是设计。所以写上前置，开局面板会自动补上。
 *
 * 为什么还要依赖 `air-corps`：现代机用的 `af-superiority` / `af-ground-strike`
 * 这些能力声明在空军基础包里。能力表是全局合并的，同一条**不许在两处各写一份**
 * （重复的那份会被核心静默覆盖，改它等于白改），所以现代包只能引用、不能重发。
 * 既然引用，就得保证那份一定在场——把基础包写进前置是唯一诚实的写法。
 */
export const MODERN_AIR: Expansion = {
  id: 'air-modern',
  name: '现代空军',
  requires: ['pack-contemporary', 'air-corps'],
  scale: 'large',
  summary:
    '第六时代的空中力量：喷气战斗机、隐身战斗机、攻击机、武装直升机、无人机、战略轰炸机、' +
    '预警机、电子战机、重型运输机九个兵种。' +
    '和海军扩展的航母联动：喷气战斗机、攻击机、预警机属于舰载机，能上甲板起飞与返航。',
  // 能力表是全局合并的，现代包直接引用基础包里那几条，不重复声明
  abilities: [],
  units: MODERN_AIR_UNITS,
  hooks: {},
};

/** 让规则层拿到"这一局有没有空军"的判据（也给测试用） */
export function airPackEnabled(state: GameState, player?: PlayerId): boolean {
  void player;
  return airEnabled(state);
}
