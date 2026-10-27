/**
 * 扩展规则系统。
 *
 * 你们当年玩的乐趣是"自己发明规则"，所以这套东西必须让加规则的成本
 * 低到可以随手写一个：新建一个对象、注册进去、在开局界面上勾选。
 *
 * 两条硬约束：
 *   1. modify* 系列钩子**必须是纯函数**。它们也会在 UI 的伤害预览里被调用，
 *      一旦有副作用，预览就会悄悄改变游戏状态。
 *   2. on* 系列钩子可以改 state（加金币、扣血、写日志），但必须是确定性的：
 *      不许用 Math.random，要随机就推进 state.seed。
 *
 * 加新扩展的做法：在文件末尾的 EXPANSIONS 数组里加一项。
 * rules.ts 一行都不用改。
 */

import type { City, GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import type { ResourceCost } from './resources.ts';
// 五个时代兵种包放在单独文件里：六十多个单位的数据摆在这里会把钩子表淹掉。
// 循环依赖是安全的——那边只 `import type`，运行时没有回指。
import { ERA_PACKS } from './era-packs.ts';
import { FANTASY_PACKS } from './fantasy-packs.ts';
import { CITY_WORKS } from './city-works.ts';
import { SEASONS } from './seasons.ts';

export interface DamageCtx {
  state: GameState;
  attacker: Unit;
  defender: Unit;
  /** 已经算好的基础伤害（攻击 − 护甲 − 地形） */
  damage: number;
  isCounter: boolean;
}

/**
 * 护甲钩子。
 *
 * 和 modifyDamage 的区别很关键：这里改的是**护甲本身**，所以它会被破甲
 * （armor-pierce 只算一半）削掉、也参与"攻击 − 护甲 ≤ 0 就打不动"的判定。
 * 想表达"我身上多了 2 点甲"，用这个；想表达"我这下少挨 2 点"，用 modifyDamage。
 */
export interface ArmorCtx {
  state: GameState;
  attacker: Unit;
  defender: Unit;
  /** 已经算好的护甲（兵种护甲 + 光环 + 地形），还没走破甲 */
  armor: number;
  isCounter: boolean;
}

/**
 * 攻城伤害钩子。
 *
 * 和 modifyDamage 分开的原因：攻城只吃城自身的护甲，没有地形、没有破甲、
 * 也没有反击，两套公式长得完全不一样。硬塞进同一个钩子，写规则的人就得
 * 在钩子里判断"这次是不是攻城"，很快会写错。
 */
export interface SiegeDamageCtx {
  state: GameState;
  attacker: Unit;
  city: City;
  /** 已经算好的基础伤害（攻击 − 城市护甲，含攻城大师的 1.5 倍） */
  damage: number;
}

export interface MoveCtx {
  state: GameState;
  unit: Unit;
  move: number;
}export interface CostCtx {
  state: GameState;
  player: PlayerId;
  unitType: UnitTypeDef;
  cost: number;
}

/**
 * 金币之外那份价格的钩子（粮食、建材……）。
 *
 * 和 modifyCost 分开：那个签名连着所有既有扩展，改成"价格对象"
 * 等于把每一个钩子都重写一遍，而它们关心的只有金币。
 * 这里进来的是**当前**的附加价格表，返回新的表即可（返回空表 = 不要额外资源）。
 *
 * baseCost 是兵种的原始金币价（没被 modifyCost 改过），goldCost 是折后价——
 * 想按"总价的 40% 收粮食"的扩展，应该用 baseCost 算，否则两次折价会叠加。
 */
export interface ResourceCostCtx {
  state: GameState;
  player: PlayerId;
  unitType: UnitTypeDef;
  /** 兵种表里写的原始金币价 */
  baseCost: number;
  /** 走完 modifyCost 之后的实际金币价 */
  goldCost: number;
  /** 当前已经确定的非金币价格（来自 costRes 字段） */
  cost: ResourceCost;
}

/**
 * 产出的钩子：把一个单位每回合的产出表交给你改。
 *
 * 纯函数，返回新表。多资源扩展靠它把原版经济单位的"金币收入"
 * 改写成"所在地形产粮/产材"，而不用去改两百多个兵种条目。
 */
export interface YieldCtx {
  state: GameState;
  unit: Unit;
  /** 已经算好的产出表（含金币、地形加成、临水加成） */
  yields: ResourceCost;
}

export interface IncomeCtx {
  state: GameState;
  player: PlayerId;
  income: number;
}

export interface VisionCtx {
  state: GameState;
  player: PlayerId;
  /** 具体是哪个单位在问视野；不填表示"这一方的整体视野" */
  unit?: Unit;
  base: number;
}

/**
 * 攻击范围钩子。
 *
 * 单独开一个而不是塞进 modifyMove：射程和移动是两件事，一个扩展可能只改其中一样
 * （「季节与气候」的阴雨就是"走得慢一点、还打得近一点"，两条互不相干）。
 */
export interface RangeCtx {
  state: GameState;
  unit: Unit;
  range: number;
}

export interface CityRegenCtx {
  state: GameState;
  city: City;
  /** 已经算好的基础回血量（0 表示本来就不回血） */
  regen: number;
}

export interface UpgradeCostCtx {
  state: GameState;
  player: PlayerId;
  city: City;
  /** 要升到的时代等级 */
  nextEra: number;
  /** 已经算好的基础费用（null 表示已封顶） */
  cost: number | null;
}

export interface KillCtx {
  state: GameState;
  victim: Unit;
  /** 击杀者；同归于尽时为 undefined */
  killer?: Unit;
  killerOwner: PlayerId;
}

export interface TurnStartCtx {
  state: GameState;
  player: PlayerId;
}

/**
 * 回合末钩子。
 *
 * 和 `onTurnStart` 分开，是因为它能**改状态**：掉血、扣钱、写战报。
 * 但"死"这件事仍然归规则层——钩子只管把血扣到 0，
 * 清场、记击杀、判负由 rules 在钩子跑完之后统一做。
 * 这样扩展可以随便加伤害来源，又不会各自造一套半成品死亡逻辑。
 */
export interface TurnEndCtx {
  state: GameState;
  /** 刚刚结束回合的那一方 */
  player: PlayerId;
  /** 造成真实伤害（不吃护甲）；血量归零由规则层统一清场 */
  hurt: (u: Unit, amount: number) => void;
  /** 写一条战报 */
  log: (p: PlayerId, text: string) => void;
}

export interface MatchStartCtx {
  state: GameState;
}

export interface ExpansionHooks {
  /** 纯函数：修正伤害 */
  modifyDamage?: (c: DamageCtx) => number;
  /** 纯函数：修正攻城伤害（野战那套钩子不参与攻城） */
  modifySiegeDamage?: (c: SiegeDamageCtx) => number;
  /** 纯函数：修正护甲（会在破甲之前生效） */
  modifyArmor?: (c: ArmorCtx) => number;
  /** 纯函数：修正移动力 */
  modifyMove?: (c: MoveCtx) => number;
  /** 纯函数：修正兵种造价 */
  modifyCost?: (c: CostCtx) => number;
  /** 纯函数：修正金币之外的那部分造价（粮食、建材……） */
  modifyResourceCost?: (c: ResourceCostCtx) => ResourceCost;
  /** 纯函数：修正单位每回合的产出（金币换成粮食这类改写走这里） */
  modifyYield?: (c: YieldCtx) => ResourceCost;
  /** 纯函数：修正回合收入 */
  modifyIncome?: (c: IncomeCtx) => number;
  /** 纯函数：修正视野半径 */
  modifyVision?: (c: VisionCtx) => number;
  /** 纯函数：修正攻击范围 */
  modifyRange?: (c: RangeCtx) => number;
  /** 纯函数：修正城市每回合回血量 */
  modifyCityRegen?: (c: CityRegenCtx) => number;
  /** 纯函数：修正升级时代的费用（返回 null 表示已封顶） */
  modifyUpgradeCost?: (c: UpgradeCostCtx) => number | null;
  /** 有副作用：单位被消灭之后 */
  onUnitKilled?: (c: KillCtx) => void;
  /** 有副作用：某方回合开始时 */
  onTurnStart?: (c: TurnStartCtx) => void;
  /** 有副作用：某方回合结束时（可以扣血、扣钱、写战报） */
  onTurnEnd?: (c: TurnEndCtx) => void;
  /** 有副作用：开局时改初始状态 */
  onMatchStart?: (c: MatchStartCtx) => void;
  /**
   * 纯函数：整批换掉开局部队。
   *
   * 返回 `{ A: [...], B: [...] }` 就按这份名单重摆（兵种 id，按顺序落在
   * 各自城市附近）；返回 null 表示这一局不管，走默认的"3 战斗 + 2 经济"。
   * 只给名单、不自己摆，是为了让摆位、编号、存档一致性全留在 setup.ts 一处。
   */
  startRoster?: (c: MatchStartCtx) => Partial<Record<PlayerId, string[]>> | null;
  /**
   * 纯函数：后手开局额外金币的**比例**（0.05 = 多拿 5% 起始金）。
   *
   * 只返回比例、不动手：真正加钱和写战报由 setup.ts 统一做，
   * 因为那一步必须在"大征兵减半"之类的开局改动**之后**、第一回合收入**之前**。
   * 写成钩子里的副作用就会踩到顺序，钩子一多就说不清谁先谁后。
   */
  modifySecondGold?: (c: MatchStartCtx) => number;
}

export interface Expansion {
  id: string;
  name: string;
  /** 一句话说清它改变了什么 */
  summary: string;
  hooks: ExpansionHooks;
  /**
   * 这个扩展额外带来的兵种。
   * 不勾选这个扩展，这些兵种就不会出现在本局的兵种表里。
   */
  units?: UnitTypeDef[];
  /**
   * 纯表现层扩展：没有钩子、没有兵种，效果全在渲染层。
   *
   * 目前只有「浓雾蔽野」用这个标记（它让视野外的地形和城市不画出来）。
   * 单独开一个字段而不是塞个空钩子，是为了让测试能区分
   * "真的只影响画面" 和 "注册了一个什么都不干的包"。
   */
  presentationOnly?: boolean;
  /**
   * 前置扩展：这些 id 必须同时启用，本扩展才生效（钩子和兵种都不进场）。
   *
   * 存在的理由不是"权限"，是**语义**：奇想兵种包依赖"魔法/属性/状态/空中层"
   * 这套法则，单开一个兵种包会让玩家以为自己在玩数值包，实际上是半套规则。
   * 前置包把这件事变成显式的、可见的选择，而不是藏在代码里的隐式依赖。
   */
  requires?: string[];
  /**
   * 规则书怎么归册：'small' 进小型扩展合订本，'large' 单独成册。
   *
   * 不让生成器去猜（比如"带兵种就算大型"）——「奇想·法则」一个兵都不带，
   * 却带来一整套魔法/属性/状态规则，按兵种数分它会被错误地塞进合订本。
   * 归册是**编辑决定**，就该写在这个扩展自己的定义里。
   * 不写默认按 'small' 处理。
   */
  scale?: 'small' | 'large';
  /**
   * 这个扩展要求的主城边长（缺省 2）。
   *
   * 为什么写在扩展上而不是只给 config：城市占几格会改变地图的生成方式
   * （城间距、城郊清场、出生点半径），而地图是在开局那一刻生成的——
   * 玩家在开局界面勾一个扩展，城市就该当场变大，而不是要他再去调一个旋钮。
   * 多个扩展都声明时取最大值（谁要得大听谁的）。
   */
  citySize?: number;
}

function nameOf(state: GameState, typeId: string): string {
  return state.unitTypes[typeId]?.name ?? typeId;
}

/** 单位的血量上限。Unit 本身只存当前血量，上限在兵种表里。 */
function maxHpOf(state: GameState, typeId: string): number {
  return state.unitTypes[typeId]?.maxHp ?? 10;
}

function log(state: GameState, player: PlayerId, text: string): void {
  state.log.push({ turn: state.turn, player, text });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

/**
 * 血战的生效回合。
 *
 * 50 是照着基准数据定的：当前版本古典 12×12 平均 102 回合、首次升级在
 * 第 22 回合左右。也就是说前 50 回合足够走完"攒钱 → 第一次升级 → 前线成型"，
 * 之后再提速就不会把开局的手感改掉。
 */
export const BLOOD_TURN = 50;

/**
 * 涨价之前的升级费用表（下标 = 要升到的时代）。
 * 血战生效后按这个价走，也就是把第 20 轮那次涨价撤掉。
 */
export const LEGACY_UPGRADE_COST = [0, 120, 200, 320, 460];

/**
 * 先后手补偿的比例表：按**棋盘边长**给，不按时代给。
 *
 * 为什么分尺寸：先手优势的量级是跟着棋盘走的。小图上双方十个回合就照面，
 * 先手"先动一步"能顺势连成一片，兵力优势会被放大；大图上两边要先走上三四个
 * 回合才碰头，节奏优势被距离稀释掉了。
 *
 * 数据（同种子配对、每档 120 局、只开血战）：
 *   12×12 中世：不补 66.7%，+20% 才压到 60.0%——小图上钱这个杠杆很钝
 *   16×16 中世：不补 63.0%，+5% 落到 50.9%（刚好）、+10% 过冲到 46.4%
 *   16×16 火药：不补 57.7%，+5% 落到 44.2%（略过）、+10% 是 40.7%
 *
 * 注意曲线是先陡后平：16×16 上 0→5% 每 1% 值 -2.4pp，5%→10% 每 1% 只剩 -0.9pp。
 * 所以别把这张表当线性杠杆往里加钱——兵是整买的，多出来的钱要撞过"换个组合"的
 * 门槛才有用。
 */
export const TURN_ORDER_BONUS: ReadonlyArray<readonly [size: number, ratio: number]> = [
  [12, 0.2],
  [16, 0.05],
];

/** 中间尺寸线性插值，两头夹住（≤12 一律 20%，≥16 一律 5%） */
export function turnOrderBonusFor(size: number): number {
  const first = TURN_ORDER_BONUS[0] as readonly [number, number];
  const last = TURN_ORDER_BONUS[TURN_ORDER_BONUS.length - 1] as readonly [number, number];
  if (size <= first[0]) return first[1];
  if (size >= last[0]) return last[1];
  for (let i = 0; i < TURN_ORDER_BONUS.length - 1; i++) {
    const a = TURN_ORDER_BONUS[i] as readonly [number, number];
    const b = TURN_ORDER_BONUS[i + 1] as readonly [number, number];
    if (size >= a[0] && size <= b[0]) {
      const t = (size - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/**
 * 「哀兵必胜」的攻击加成比例。
 *
 * 10% 这个量级是挑过的：它够让劣势方在野战里换得更划算，但又小于
 * "差一个时代"的兵种差距（同代民兵 atk 10，下一时代的中坚大约 14~16，
 * 也就是 40%~60%）。所以它撮合对局，但翻不了盘——这正是这条规则该待的位置：
 * 给丢城的一方一口气，不给它一条捷径。
 *
 * 伤害是整数，10% 在低伤害上会被取整放大（10 → 11 是 10%，5 → 6 就是 20%），
 * 这是刻意的：小伤害的兵本来就该从这条规则里受益更多。
 */
export const LAST_STAND_BONUS = 0.1;

/**
 * 「哀兵必胜」的伤害修正，野战和攻城共用一份，免得两边取整规则走散。
 *
 * 靠 state.firstCityLost 而不是"当前城数"：城会被抢回来，抢回来那一刻
 * 当前城数就复原了，只有这条记录留得住"谁先丢的"。加成跟着人走、不跟着城走，
 * 所以抢回城之后它也不会消失。
 */
function lastStandDamage(state: GameState, owner: PlayerId, damage: number): number {
  return state.firstCityLost === owner ? Math.round(damage * (1 + LAST_STAND_BONUS)) : damage;
}

export const EXPANSIONS: Expansion[] = [
  {
    id: 'asym-opening',
    name: '非对称开局',
    summary:
      '两边开局不再一样：先手只有工兵和斥候（工事与侦察），后手拿两个农民、一个牧民、一个步兵、一个弓手（屯田与守备）。' +
      '先手是逆风局——用工地和视野去换对面那支已经成型的小部队。',
    hooks: {
      // 名单写死，是为了"这一局开局长什么样"能一眼看完——
      // 随机开局会让复盘时说不清"我开局为什么少一个兵"。
      startRoster: () => ({
        A: ['engineer', 'scout'],
        B: ['farmer', 'farmer', 'herder', 'militia', 'archer'],
      }),
    },
  },
  {
    id: 'war-economy',
    name: '战争经济',
    summary: '每消灭一个对方单位，立刻获得 15 金币。',
    hooks: {
      onUnitKilled: ({ state, victim, killerOwner }) => {
        state.players[killerOwner].gold += 15;
        log(state, killerOwner, `战争经济：歼灭 ${nameOf(state, victim.type)}，获得 15 金币`);
      },
    },
  },
  {
    id: 'veterans',
    name: '老兵不死',
    summary: '单位每击杀一个敌人永久 +1 攻击力，越打越硬。',
    hooks: {
      modifyDamage: ({ attacker, damage }) => damage + attacker.kills,
      onUnitKilled: ({ killer }) => {
        if (killer) killer.kills += 1;
      },
    },
  },
  {
    id: 'trench',
    name: '堑壕战',
    summary: '站在森林或丘陵上的单位额外 +2 护甲（吃破甲，也挡得住低时代攻击）。',
    hooks: {
      modifyArmor: ({ state, defender, armor }) => {
        const tile = state.tiles[defender.y * state.w + defender.x];
        if (tile && (tile.terrain === 'forest' || tile.terrain === 'hill')) {
          return armor + 2;
        }
        return armor;
      },
    },
  },
  {
    id: 'blitz',
    name: '闪电战',
    summary: '所有移动力 3 以上的快速单位移动 +2、造价 +10%。',
    hooks: {
      modifyMove: ({ state, unit, move }) =>
        (state.unitTypes[unit.type]?.move ?? 0) >= 3 ? move + 2 : move,
      modifyCost: ({ unitType, cost }) =>
        unitType.move >= 3 ? cost + Math.round(cost * 0.1) : cost,
    },
  },
  {
    id: 'conscription',
    name: '大征兵',
    summary: '所有时代的战斗单位造价 −20%，但双方起始金币 −50%。人多，但穷。',
    hooks: {
      modifyCost: ({ unitType, cost }) =>
        unitType.category === 'combat' ? Math.max(5, Math.round(cost * 0.8)) : cost,
      onMatchStart: ({ state }) => {
        for (const p of ['A', 'B'] as PlayerId[]) {
          state.players[p].gold = Math.max(0, Math.round(state.players[p].gold * 0.5));
        }
      },
    },
  },
  {
    id: 'night-raid',
    name: '大雾来了',
    summary: '大雾一起，所有单位视野 −1。撞上了才知道对面是谁。',
    hooks: {
      modifyVision: ({ base }) => Math.max(1, base - 1),
    },
  },
  {
    id: 'blackout',
    name: '浓雾蔽野',
    summary:
      '基础规则的雾只遮单位，地图永远看得见。这个扩展把地图本身也遮掉：视野外的格子、地形、城市全部隐去，只剩一片黑；而且迷雾锁定开启、不能关掉。',
    // 纯表现层扩展：不改任何规则数值，只让渲染层把"视野外"画成空白。
    //
    // 为什么不连 AI 一起遮：地形是静态的，走一遍就记住了，让 AI 忘掉地形
    // 只会让它的寻路整体失灵（一支部队卡在山口来回走），而不是变成"更笨的对手"。
    // 单位迷雾照旧——AI 本来就只拿 playerView，看不到视野外的敌人。
    hooks: {},
    presentationOnly: true,
  },
  {
    id: 'scorched-earth',
    name: '死亡枕藉',
    summary: '单位阵亡时，对它四周相邻的单位各造成它最大生命 20% 的伤害。',
    hooks: {
      onUnitKilled: ({ state, victim }) => {
        const dirs: ReadonlyArray<readonly [number, number]> = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];
        // 按"倒下这个人"的血量算，不是固定值：越厚重的单位倒下砸得越狠
        const blast = Math.max(1, Math.round(maxHpOf(state, victim.type) * 0.2));
        let hit = 0;
        for (const [dx, dy] of dirs) {
          const near = state.units.find((u) => u.x === victim.x + dx && u.y === victim.y + dy);
          if (near) {
            near.hp -= blast;
            hit += 1;
          }
        }
        if (hit > 0) {
          log(state, victim.owner, `焦土：阵亡时波及 ${hit} 个临近单位，各 ${blast} 点`);
          state.units = state.units.filter((u) => u.hp > 0);
        }
      },
    },
  },
  {
    id: 'fortress',
    name: '固若金汤',
    summary: '所有城市耐久上限 +20、护甲 +1。攻城变成真正的苦差事。',
    hooks: {
      onMatchStart: ({ state }) => {
        for (const city of state.cities) {
          city.armor += 1;
          city.maxHp += 20;
          city.hp = city.maxHp;
        }
      },
    },
  },
  // 五个奇想兵种包（奇想·法则 / 骑士团 / 荒兽 / 秘法 / 英雄）。
  // 兵种数据在 fantasy-packs.ts 里——六十个单位摆在这里会把钩子表淹掉。
  // 法则包是另外四个的前置（见 Expansion.requires）。
  ...FANTASY_PACKS,
  {
    id: 'bloodbath',
    name: '血战',
    summary: `第 ${BLOOD_TURN} 回合起：城市不再回血、升级时代恢复原价、全军移动与视野各 +1。后期不许再磨。`,
    hooks: {
      // 第 17～20 轮为了压节奏加的三样东西（机动/视野削减、城市回血、升级涨价）
      // 确实把对局从 30 多回合拉到了 100 回合，代价是后期变成谁都推不动的拉锯。
      // 血战给它们一个到期日：前 50 回合照常磨，之后全线提速，逼出一个结果。
      modifyCityRegen: ({ state, regen }) => (state.turn >= BLOOD_TURN ? 0 : regen),
      modifyUpgradeCost: ({ state, cost, nextEra }) => {
        if (cost === null) return null;
        return state.turn >= BLOOD_TURN ? (LEGACY_UPGRADE_COST[nextEra - 1] ?? cost) : cost;
      },
      // 只给移动力 ≥ 2 的加：机枪队那种 move 1 的单位本来就没被削过
      modifyMove: ({ state, move }) => (state.turn >= BLOOD_TURN && move >= 2 ? move + 1 : move),
      modifyVision: ({ state, base }) => (state.turn >= BLOOD_TURN ? base + 1 : base),
      onTurnStart: ({ state, player }) => {
        if (state.turn === BLOOD_TURN && player === 'A') {
          log(state, 'A', `血战开始：城市不再回血、升级恢复原价、全军移动与视野各 +1`);
        }
      },
    },
  },
  {
    id: 'turn-order-comp',
    name: '先后手补偿',
    summary:
      '后手开局多拿一笔起始金：12×12 补 20%、16×16 补 5%，中间尺寸线性插值。小图补得多，大图补得少。',
    hooks: {
      // 只报比例，具体加多少钱由 setup.ts 在"开局改动之后、第一回合收入之前"结算
      modifySecondGold: ({ state }) => turnOrderBonusFor(state.w),
    },
  },
  {
    id: 'last-stand',
    name: '哀兵必胜',
    summary: `先丢掉一座城的一方，全军攻击 +${Math.round(LAST_STAND_BONUS * 100)}%——野战、反击、攻城都算。城没了，气还在。`,
    hooks: {
      modifyDamage: ({ state, attacker, damage }) => lastStandDamage(state, attacker.owner, damage),
      modifySiegeDamage: ({ state, attacker, damage }) => lastStandDamage(state, attacker.owner, damage),
    },
  },
  // 五个时代兵种包（大型模组）。放在最后是为了不改动既有扩展的注册顺序——
  // 顺序会进存档，也影响钩子叠加次序。
  ...ERA_PACKS,
  CITY_WORKS,
  SEASONS,
];

export function expansionById(id: string): Expansion | undefined {
  return EXPANSIONS.find((e) => e.id === id);
}

/** 按配置里勾选的顺序取出启用的扩展（顺序固定，保证确定性） */
export function activeExpansions(state: GameState): Expansion[] {
  const out: Expansion[] = [];
  const on = enabledExpansionIds(state.config.expansionIds);
  for (const id of state.config.expansionIds) {
    if (!on.has(id)) continue;
    const e = expansionById(id);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 把"勾了什么"过滤成"真正生效了什么"。
 *
 * 前置关系可能成链（A 要 B、B 要 C），所以这里跑到不动点：
 * 每轮剔掉前置没满足的，直到没有可剔的。写成一次遍历会在
 * "C 被剔掉"和"B 要 C"之间随机出结果——取决于数组顺序，那是不可接受的。
 */
export function enabledExpansionIds(ids: readonly string[]): Set<string> {
  const on = new Set(ids.filter((id) => !!expansionById(id)));
  for (;;) {
    let changed = false;
    for (const id of Array.from(on)) {
      const need = expansionById(id)?.requires ?? [];
      if (need.every((r) => on.has(r))) continue;
      on.delete(id);
      changed = true;
    }
    if (!changed) return on;
  }
}

/**
 * 这个兵种来自哪个扩展包（原版兵种返回 null）。
 *
 * 兵种从 49 个涨到 118 个之后，"这兵哪来的"变成了常问的问题：
 * 同一个面板里会同时出现原版、时代包和奇想包，光看名字看不出来。
 * 兵种包自己声明了 units，这里反查一遍就够了，不用再维护第二张表。
 */
export function unitSourceOf(id: string): string | null {
  for (const e of EXPANSIONS) {
    if (e.units?.some((u) => u.id === id)) return e.name;
  }
  return null;
}

/**
 * 同上的 id 版。
 *
 * 名字是给人看的，id 是给筛选用的：面板上要按包分组/筛选，
 * 拿名字当 key 会在改文案的那天悄悄坏掉（而名字本来是随时会改的）。
 * 原版兵种返回 null。
 */
export function unitSourceIdOf(id: string): string | null {
  for (const e of EXPANSIONS) {
    if (e.units?.some((u) => u.id === id)) return e.id;
  }
  return null;
}
