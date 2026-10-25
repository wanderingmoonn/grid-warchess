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
// 五个时代兵种包放在单独文件里：六十多个单位的数据摆在这里会把钩子表淹掉。
// 循环依赖是安全的——那边只 `import type`，运行时没有回指。
import { ERA_PACKS } from './era-packs.ts';

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

export interface MoveCtx {
  state: GameState;
  unit: Unit;
  move: number;
}

export interface CostCtx {
  state: GameState;
  player: PlayerId;
  unitType: UnitTypeDef;
  cost: number;
}

export interface IncomeCtx {
  state: GameState;
  player: PlayerId;
  income: number;
}

export interface VisionCtx {
  state: GameState;
  player: PlayerId;
  base: number;
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

export interface MatchStartCtx {
  state: GameState;
}

export interface ExpansionHooks {
  /** 纯函数：修正伤害 */
  modifyDamage?: (c: DamageCtx) => number;
  /** 纯函数：修正护甲（会在破甲之前生效） */
  modifyArmor?: (c: ArmorCtx) => number;
  /** 纯函数：修正移动力 */
  modifyMove?: (c: MoveCtx) => number;
  /** 纯函数：修正兵种造价 */
  modifyCost?: (c: CostCtx) => number;
  /** 纯函数：修正回合收入 */
  modifyIncome?: (c: IncomeCtx) => number;
  /** 纯函数：修正视野半径 */
  modifyVision?: (c: VisionCtx) => number;
  /** 纯函数：修正城市每回合回血量 */
  modifyCityRegen?: (c: CityRegenCtx) => number;
  /** 纯函数：修正升级时代的费用（返回 null 表示已封顶） */
  modifyUpgradeCost?: (c: UpgradeCostCtx) => number | null;
  /** 有副作用：单位被消灭之后 */
  onUnitKilled?: (c: KillCtx) => void;
  /** 有副作用：某方回合开始时 */
  onTurnStart?: (c: TurnStartCtx) => void;
  /** 有副作用：开局时改初始状态 */
  onMatchStart?: (c: MatchStartCtx) => void;
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

export const EXPANSIONS: Expansion[] = [
  {
    id: 'war-economy',
    name: '战争经济',
    summary: '每消灭一个敌方单位，立刻获得 15 金币。',
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
  {
    id: 'fantasy-units',
    name: '奇想兵种包',
    summary: '加入龙骑兵、术士、巨兽三个不属于真实历史线的兵种。不勾选就没有。',
    hooks: {},
    units: [
      {
        id: 'dragoon',
        name: '龙骑兵',
        short: '龙',
        era: 3,
        category: 'combat',
        cost: 145,
        move: 6,
        atk: 21,
        armor: 3,
        maxHp: 38,
        range: 1,
        vision: 6,
      },
      {
        id: 'warlock',
        name: '术士',
        short: '术',
        era: 2,
        category: 'combat',
        cost: 100,
        move: 2,
        atk: 18,
        armor: 1,
        maxHp: 20,
        range: 3,
        vision: 5,
      },
      {
        id: 'behemoth',
        name: '巨兽',
        short: '兽',
        era: 4,
        category: 'combat',
        cost: 330,
        move: 2,
        atk: 32,
        armor: 9,
        maxHp: 85,
        range: 1,
        vision: 3,
      },
    ],
  },
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
  // 五个时代兵种包（大型模组）。放在最后是为了不改动既有扩展的注册顺序——
  // 顺序会进存档，也影响钩子叠加次序。
  ...ERA_PACKS,
];

export function expansionById(id: string): Expansion | undefined {
  return EXPANSIONS.find((e) => e.id === id);
}

/** 按配置里勾选的顺序取出启用的扩展（顺序固定，保证确定性） */
export function activeExpansions(state: GameState): Expansion[] {
  const out: Expansion[] = [];
  for (const id of state.config.expansionIds) {
    const e = expansionById(id);
    if (e) out.push(e);
  }
  return out;
}
