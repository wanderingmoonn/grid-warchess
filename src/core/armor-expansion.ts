/**
 * 「装甲时代」（时代 7）——把 `armor.ts` 的那套表接进规则层。
 *
 * 这里只放"必须挂在引擎钩子上"的那部分：护甲 / 移速 / 视野 / 步耗的加法、
 * 无人机召唤、烟幕的减伤。装配、开火、设备效果都在 `armor.ts` 里，
 * 由规则层直接调——它们不是"每回合自动跑一次"的东西，套钩子反而绕。
 */

import type { Expansion } from './expansions.ts';
import type { GameState, Unit, UnitTypeDef } from './types.ts';
import type { MarkKindDef } from './marks.ts';
import type { AuraSpec } from './ability-hooks.ts';
import {
  MODULES,
  MINE_KIND,
  SMOKE_KIND,
  LANCE_KIND,
  OVERLOAD_PERIOD,
  defenseOf,
  hasAllTerrain,
  modulesOf,
  offlineModules,
} from './armor.ts';
import { marksAt } from './marks.ts';

/* ===========================================================================
 * 一、兵种表
 * ======================================================================== */

export const ARMOR_UNITS: UnitTypeDef[] = [
  // ── 素体（3 台。hover = 空中层，见 4.1） ─────────────────────────────
  {
    id: 'armor_hawk',
    name: '「隼」侦察型',
    short: '隼',
    era: 7,
    category: 'combat',
    cost: 420,
    move: 6,
    atk: 12,
    armor: 8,
    maxHp: 100,
    range: 1,
    vision: 7,
    layer: 'air',
    flight: true,
    armorFrame: true,
    draw: 14,
    ramAtk: 12,
    slots: { main: 1, sub: 0, plate: 0, system: 1, device: 1 },
    chassis: 'hover',
  },
  {
    id: 'armor_anvil',
    name: '「砧」主战型',
    short: '砧',
    era: 7,
    category: 'combat',
    cost: 520,
    move: 4,
    atk: 22,
    armor: 17,
    maxHp: 175,
    range: 1,
    vision: 3,
    armorFrame: true,
    draw: 20,
    ramAtk: 22,
    slots: { main: 1, sub: 1, plate: 2, system: 0, device: 1 },
    chassis: 'tracked',
  },
  {
    id: 'armor_forge',
    name: '「炉」支援型',
    short: '炉',
    era: 7,
    category: 'combat',
    cost: 470,
    move: 3,
    atk: 16,
    armor: 12,
    maxHp: 145,
    range: 1,
    vision: 4,
    armorFrame: true,
    draw: 24,
    ramAtk: 16,
    slots: { main: 0, sub: 2, plate: 0, system: 2, device: 2 },
    chassis: 'walker',
  },

  // ── 建筑（2 座） ─────────────────────────────────────────────────────
  {
    id: 'armor_dock',
    name: '装配坞',
    short: '坞',
    era: 7,
    category: 'building',
    cost: 420,
    move: 0,
    atk: 0,
    armor: 9,
    maxHp: 70,
    range: 0,
    vision: 2,
  },
  {
    id: 'armor_coal',
    name: '燃煤电站',
    short: '电',
    era: 7,
    category: 'building',
    cost: 620,
    move: 0,
    atk: 0,
    armor: 7,
    maxHp: 42,
    range: 0,
    vision: 2,
    // 供给：装甲这一套唯一的电能来源（派生指标，见 armor.ts 的口径 2）
    armorPower: 120,
  },

  // ── 生产单位（2 台。按 incomeByTerrain 出金，开了「城郭与物料」它自己折） ──
  {
    id: 'armor_minecrew',
    name: '无人矿队',
    short: '掘',
    era: 7,
    category: 'economy',
    cost: 400,
    move: 2,
    atk: 4,
    armor: 5,
    maxHp: 34,
    range: 1,
    vision: 2,
    incomeByTerrain: { hill: 88, forest: 48, city: 32, plain: 21 },
  },
  {
    id: 'armor_agri',
    name: '农产集团',
    short: '农',
    era: 7,
    category: 'economy',
    cost: 380,
    move: 2,
    atk: 4,
    armor: 3,
    maxHp: 30,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 84, city: 55, forest: 31, hill: 24 },
  },

  // ── 建造单位 ─────────────────────────────────────────────────────────
  {
    id: 'armor_engineer',
    name: '工程机组',
    short: '组',
    era: 7,
    category: 'builder',
    cost: 400,
    move: 2,
    atk: 6,
    armor: 5,
    maxHp: 34,
    range: 1,
    vision: 2,
    buildPower: 48,
    // 两代的建筑都写在它身上：第 8 代不再另出一个建造单位（设计稿 6.4）
    builds: ['armor_dock', 'armor_coal', 'armor_fusion', 'armor_yard', 'armor_cmd'],
  },

  // ── 无人机（召唤专用：不进产线、不占编制、不吃电） ────────────────────
  {
    id: 'armor_drone',
    name: '蜂群无人机',
    short: '蜂',
    era: 7,
    category: 'combat',
    cost: 60,
    move: 7,
    atk: 8,
    armor: 0,
    maxHp: 16,
    range: 3,
    vision: 5,
    layer: 'air',
    flight: true,
    summonedOnly: true,
  },
];

/* ===========================================================================
 * 一之二、第 8 代「聚变时代」的兵种（9 个）
 *
 * 三台素体把 7 代那三台的定位各自推到极端：塔是"走得慢、扛得住、打得远"，
 * 蜂群母体是"平台多、带电多"，猎手是"快到你打不着"。
 * 注意蜂群母体与猎手都是**空中层**——8 代只有塔还需要地面。
 * ======================================================================== */

export const ARMOR8_UNITS: UnitTypeDef[] = [
  {
    id: 'armor_tower',
    name: '「塔」重型',
    short: '塔',
    era: 8,
    category: 'combat',
    cost: 820,
    move: 3,
    atk: 34,
    armor: 24,
    maxHp: 330,
    range: 1,
    vision: 4,
    footprint: 2,
    armorFrame: true,
    draw: 36,
    ramAtk: 34,
    slots: { main: 2, sub: 1, plate: 2, system: 2, device: 1 },
    chassis: 'quad',
  },
  {
    id: 'armor_swarm',
    name: '「蜂群母体」',
    short: '群',
    era: 8,
    category: 'combat',
    cost: 720,
    move: 4,
    atk: 22,
    armor: 16,
    maxHp: 240,
    range: 1,
    vision: 5,
    layer: 'air',
    flight: true,
    armorFrame: true,
    draw: 30,
    ramAtk: 22,
    slots: { main: 0, sub: 1, plate: 0, system: 1, device: 3 },
    chassis: 'hover',
  },
  {
    id: 'armor_hunter',
    name: '「猎手」高速',
    short: '猎',
    era: 8,
    category: 'combat',
    cost: 760,
    move: 6,
    atk: 26,
    armor: 14,
    maxHp: 210,
    range: 1,
    vision: 6,
    layer: 'air',
    flight: true,
    armorFrame: true,
    draw: 26,
    ramAtk: 26,
    slots: { main: 1, sub: 2, plate: 0, system: 1, device: 2 },
    chassis: 'hover',
  },

  // ── 建筑（3 座） ─────────────────────────────────────────────────────
  {
    id: 'armor_fusion',
    name: '聚变堆',
    short: '堆',
    era: 8,
    category: 'building',
    cost: 1400,
    move: 0,
    atk: 0,
    armor: 9,
    maxHp: 58,
    range: 0,
    vision: 2,
    armorPower: 280,
  },
  {
    id: 'armor_yard',
    name: '装配总厂',
    short: '厂',
    era: 8,
    category: 'building',
    cost: 980,
    move: 0,
    atk: 0,
    armor: 10,
    maxHp: 78,
    range: 0,
    vision: 2,
  },
  {
    id: 'armor_cmd',
    name: '战区指挥车坞',
    short: '指',
    era: 8,
    category: 'building',
    cost: 620,
    move: 0,
    atk: 0,
    armor: 8,
    maxHp: 56,
    range: 0,
    vision: 4,
    armorPower: 60,
  },

  // ── 生产单位（2 台） ─────────────────────────────────────────────────
  {
    id: 'armor_forge8',
    name: '元素铸造局',
    short: '铸',
    era: 8,
    category: 'economy',
    cost: 520,
    move: 2,
    atk: 4,
    armor: 6,
    maxHp: 36,
    range: 1,
    vision: 2,
    incomeByTerrain: { hill: 120, forest: 65, city: 44, plain: 30 },
  },
  {
    id: 'armor_food8',
    name: '合成食品局',
    short: '食',
    era: 8,
    category: 'economy',
    cost: 500,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 32,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 116, city: 75, forest: 42, hill: 35 },
  },

  // ── 无人机（重装型，召唤专用） ────────────────────────────────────────
  {
    id: 'armor_drone2',
    name: '重装无人机',
    short: '重',
    era: 8,
    category: 'combat',
    cost: 110,
    move: 6,
    atk: 14,
    armor: 2,
    maxHp: 26,
    range: 4,
    vision: 6,
    layer: 'air',
    flight: true,
    summonedOnly: true,
  },
];

/* ===========================================================================
 * 二、留痕：地雷与烟幕（设备放上去的东西，见 armor.ts 六）
 * ======================================================================== */

/**
 * 反装甲地雷。
 *
 * 和「火器时代」那两种地雷（16 / 30）是同一张注册表的不同条目，伤害高一档：
 * 第七时代一个素体的血量是 145~175，40 点正好是"踩一枚必须处理掉"的量级，
 * 又不至于一发把人钉死。
 *
 * `trigger: 'enemy'` 是引擎负责的那一半（自己人踩不到自己布的雷），
 * 这里只管"炸多少、写什么战报"。扫雷兵踩上去减半，这条和两种老雷一致。
 */
const ARMOR_MINE: MarkKindDef = {
  id: MINE_KIND,
  name: '反装甲地雷',
  summary: '敌人踩上来炸 40 点（无视护甲），炸完就没。自己人不炸。',
  tags: ['mine', 'land'],
  hidden: true,
  on: ['plain', 'forest', 'hill', 'dune', 'valley', 'plateau', 'marsh', 'city'],
  trigger: 'enemy',
  detect: 1,
  onEnter: (c) => {
    if (!c.unit) return;
    const def = c.api.utype(c.unit.type);
    const swept = (def.abilities ?? []).includes('clear-mines');
    const dmg = swept ? 20 : 40;
    c.api.hurt(c.unit, dmg, `${def.name} 踩中反装甲地雷，损失 ${dmg} 点生命`);
    c.api.log(c.mark.owner, `反装甲地雷命中 ${def.name}`);
  },
};

/**
 * 烟幕。
 *
 * 两条要点：
 *   1. **不隐藏**——烟幕本来就是给双方看的地形，藏起来反而让人不知道自己站在没站在里面；
 *   2. 次数只在**布设者自己的回合开始**递减。`tickMarks` 是每个玩家的回合开始都会
 *      遍历所有留痕的，不挡一下的话，对面一结束回合烟就散了，两回合变成半回合。
 */
const ARMOR_SMOKE: MarkKindDef = {
  id: SMOKE_KIND,
  name: '烟幕',
  summary: '站里面的己方单位受远程伤害 −30%，两个自己回合后散去。',
  tags: ['smoke'],
  hidden: false,
  onTurnStart: (c) => {
    if (c.player !== c.mark.owner) return false; // 不消耗：还没轮到布设者
  },
};

/**
 * 轨道引导：下一回合开始时，3×3 里的**每一个**单位各吃 120。
 *
 * 不分敌我是刻意的：轨道打击本来就是"那片区域没了"。要是不打自己人，
 * 它就会退化成"贴脸放一发必中 120 的免费技能"，而不是"提前一回合标点"。
 * `charges: 1` 由引擎扣，不需要这里自己删。
 */
const ARMOR_LANCE: MarkKindDef = {
  id: LANCE_KIND,
  name: '轨道引导',
  summary: '下一回合开始时，这一片里的每个单位各受 120 伤害（不分敌我）。',
  tags: ['strike'],
  hidden: false,
  onTurnStart: (c) => {
    for (const t of [...c.state.units]) {
      if (t.hp <= 0) continue;
      if (Math.max(Math.abs(t.x - c.mark.x), Math.abs(t.y - c.mark.y)) > 1) continue;
      c.api.hurt(t, 120, `${c.api.utype(t.type).name} 被轨道打击命中，损失 120 点生命`);
    }
  },
};

/* ===========================================================================
 * 三、钩子：只做"加法"与"步耗"，不动任何判定顺序
 * ======================================================================== */

/**
 * 已装模块在某个字段上的累加值。
 *
 * **断电的模块不算**——这一条以前漏了，于是"电不够、模块停用"只停武器，
 * 护甲 / 移速 / 视野照给，断电等于白停。判据统一走 `offlineModules`，
 * 别在钩子里各自再算一遍。
 */
function moduleSum(
  s: GameState,
  u: { modules?: string[] } | undefined,
  key: 'armor' | 'move' | 'vision',
): number {
  if (!u) return 0;
  const off = offlineModules(s, u as Unit);
  let n = 0;
  for (const id of modulesOf(u as Unit)) {
    if (off.has(id)) continue;
    n += MODULES[id]?.[key] ?? 0;
  }
  return n;
}

/** 模块给的、只在"本回合没出过手"时才生效的移速（战术冲刺） */
function idleMoveBonus(s: GameState, u: Unit | undefined): number {
  if (!u || u.acted) return 0;
  const off = offlineModules(s, u);
  let n = 0;
  for (const id of modulesOf(u)) if (!off.has(id)) n += MODULES[id]?.moveIdle ?? 0;
  return n;
}


export const ARMOR_ERA7: Expansion = {
  id: 'armor-era7',
  name: '装甲时代',
  blurb: '解锁第七时代：装甲素体、模块装配与供电上限。',
  summary:
    '第七时代「装甲时代」：素体本身只有撞击，战斗力全靠模块；每台素体的耗能之和' +
    '不能超过己方电站的供电总额，超了就按装配顺序倒序断电。' +
    '装配要先造出素体、再走到装配坞旁边花一回合装上；拆卸不花回合、退一半金币。' +
    '设备槽是有次数的主动道具（烟幕 / 整备臂 / 布雷器 / 钩索 / 蜂群弹射器），' +
    '用一次要占掉本回合的行动，用完得贴着装配坞「整备」花钱补回来。' +
    '三种素体里「隼」会飞——空中层意味着近战得多走一格才够得着，但也拿不到地形护甲。',
  scale: 'large',
  unlockEra: 7,
  units: ARMOR_UNITS,
  marks: [ARMOR_MINE, ARMOR_SMOKE, ARMOR_LANCE],
  hooks: {
    /**
     * 烟幕：站在烟里的己方单位挨**远程**打时少掉 30%。
     *
     * 为什么用 `modifyDamage` 而不是 `modifyArmor`：烟幕是"看不清，打偏了"，
     * 不是"甲变厚了"。走护甲那一侧会被破甲削掉、也会影响"打不打得动"的判定，
     * 语义完全不对。贴脸打（切比雪夫距离 ≤1）不减——那已经不是视野问题了。
     *
     * 只保护**布设者自己那方**：烟幕挡住的是"被自己人扬起来的灰"，
     * 不是说对面站进去也能蹭到掩体（对面要能蹭，这设备就成了给敌人用的）。
     *
     * ── 为什么要"把甲补回去" ─────────────────────────────────────────────
     * 引擎在这一步**之后**才做 `damage − armor`，所以钩子手里的是扣甲之前的数。
     * 直接乘 0.7 得到的是"攻击力打七折"：22 攻打 12 甲，本来掉 10，打七折之后
     * 是 15−12=3 —— 实际掉了七成血，不是三成。想让**掉血量**正好是七成，
     * 就得把甲加回去再交给引擎：
     *     want = round(0.7 × max(0, damage − armor))；返回 want + armor，
     *     引擎再减一次 armor，正好落回 want。
     */
    modifyDamage: ({ state, attacker, defender, damage, armor, splash }) => {
      if (damage <= 0) return damage;
      const gap = Math.max(Math.abs(attacker.x - defender.x), Math.abs(attacker.y - defender.y));
      const post0 = Math.max(0, damage - armor);
      let post = post0;

      // 反应堆护罩：只削**溅射**那一下（主目标照吃满）
      if (splash) {
        const cut = defenseOf(state, defender).splashCut;
        if (cut > 0) post = Math.round(post * (1 - cut));
      }
      // 近防激光 / 矢量喷口：只对**远程**（贴脸打不吃）
      if (gap > 1) {
        const d = defenseOf(state, defender);
        if (d.ciws > 0) post = Math.max(0, post - d.ciws);
        if (d.vector > 0 && defender.moved) post = Math.max(0, post - d.vector);
      }
      // 烟幕：远程 −30%（按掉血量算，见上面那段说明）
      if (gap > 1) {
        const sheltered = marksAt(state, defender.x, defender.y).some(
          (m) => m.kind === SMOKE_KIND && m.owner === defender.owner,
        );
        if (sheltered) post = Math.round(post * 0.7);
      }
      if (post === post0) return damage; // 一条都没生效：原样交还，别动别的东西
      return Math.max(0, post) + armor;
    },
    /** 模块给的护甲：只有被装甲吃掉时才加（ctx.defender 才是挨打的那个） */
    modifyArmor: ({ state, defender, armor }) => {
      const extra = moduleSum(state, defender, 'armor');
      return extra === 0 ? armor : Math.max(0, armor + extra);
    },
    /** 模块给的移动力（含"只在没出手时生效"的战术冲刺） */
    modifyMove: ({ state, unit, move }) => {
      const extra = moduleSum(state, unit, 'move') + idleMoveBonus(state, unit);
      return extra === 0 ? move : Math.max(1, move + extra);
    },
    /** 模块给的视野 */
    modifyVision: ({ state, unit, base }) => {
      if (!unit) return base;
      const extra = moduleSum(state, unit, 'vision');
      return extra === 0 ? base : Math.max(1, base + extra);
    },
    /**
     * 全地形履带：森林 / 丘陵 / 沼泽按 1 步算。
     *
     * `cost > 1` 之前必须过 `Number.isFinite`——水面与高山的步耗是 Infinity，
     * 直接 `Math.min(cost, 1)` 会让履带车**开进海里**。这条是踩过的坑的类型：
     * "按 1 步算"这句话只对**本来走得进去**的地形成立。
     */
    modifyStepCost: ({ unit, cost }) => {
      if (!unit || typeof cost !== 'number') return undefined;
      if (!Number.isFinite(cost)) return undefined;
      if (cost <= 1) return undefined;
      if (!hasAllTerrain(unit)) return undefined;
      return 1;
    },
    /**
     * 召唤：无人机母舱每 2 回合放 1 架，场上最多 2 架。
     *
     * 引擎的 `summon` 只认兵种。按模块召唤要在这里自己数，所以先只做
     * 「母舱」那一条，`every` 用回合号取模——纯函数，不依赖任何随机。
     */
    onTurnStart: ({ state, player }) => {
      for (const u of state.units) {
        if (u.owner !== player || u.hp <= 0) continue;
        /*
         * 超载协议：每 `OVERLOAD_PERIOD` 个自己的回合停一次机。
         *
         * 计数落在 `custom` 上（不是武器账、也不是断电账）：它是"用了多久"的回数，
         * 断电/拆卸都不该清零。停机那一回合靠 `u.overheatTurn === state.turn`
         * 让 `offlineModules` 把整台打下来，下一个回合自然恢复。
         */
        if (modulesOf(u).includes('overload')) {
          const tick = Number(u.custom?.overloadTick ?? 0) + 1;
          u.custom = { ...(u.custom ?? {}), overloadTick: tick };
          if (tick % OVERLOAD_PERIOD === 0) u.overheatTurn = state.turn;
        }
        const bay = modulesOf(u).find((id) => MODULES[id]?.summon);
        if (!bay) continue;
        const spec = MODULES[bay]!.summon!;
        if (state.turn % spec.every !== 0) continue;
        const alive = state.units.filter((d) => d.owner === player && d.type === spec.type && d.hp > 0).length;
        if (alive >= spec.max) continue;
        // 放在身边最近的空格；满了就这一回合不放
        const spot = freeSpotNear(state, u);
        if (!spot) continue;
        state.units.push({
          id: `${u.id}-d${state.turn}`,
          type: spec.type,
          owner: player,
          x: spot.x,
          y: spot.y,
          hp: state.unitTypes[spec.type]?.maxHp ?? 16,
          kills: 0,
          summoned: true,
          moved: true,
          acted: true,
        });
      }
    },
    /**
     * 光环：8 代那两条（集群协议 / 反导穹顶）和指挥车坞都从这里进合并表。
     *
     * 为什么不走 `ability`：光环是**模块**带来的，而 `aurasOf` 只认兵种能力和
     * extraAbilities。给模块表挂函数字段会让它从纯数据变成能被序列化坏掉的东西，
     * 所以走这个钩子，模块表里只留一个 `aura: AuraSpec`。
     */
    extraAura: ({ state, unit }): AuraSpec[] => {
      const out: AuraSpec[] = [];
      if (unit.type === 'armor_cmd') out.push({ label: '战区指挥', allyArmor: 1, radius: 2 });
      const def = state.unitTypes[unit.type];
      if (!def?.armorFrame) return out;
      const off = offlineModules(state, unit);
      for (const id of modulesOf(unit)) {
        if (off.has(id)) continue;
        const a = MODULES[id]?.aura;
        if (a) out.push(a);
      }
      return out;
    },
    /**
     * 聚变堆被拆掉时自爆：半径 1，60 点，**不分敌我**。
     *
     * 为什么不分敌我：这是给"把电站堆在前线"判的刑。只炸对面的话，
     * 聚变堆就会变成一个"越挨打越赚"的诱饵——那和"又贵又脆"的定位正好相反。
     * 走 `api.hurt` 而不是自己改 hp：扣完得让引擎统一扫一遍尸体，
     * 自己删会漏掉战报和击杀归属。
     */
    onUnitKilled: ({ state, victim, api }) => {
      if (victim.type !== 'armor_fusion') return;
      for (const t of [...state.units]) {
        if (t.id === victim.id || t.hp <= 0) continue;
        if (Math.max(Math.abs(t.x - victim.x), Math.abs(t.y - victim.y)) > 1) continue;
        const name = api.utype(state, t.type).name;
        api.hurt(state, t, 60, { logText: `聚变堆爆炸，${name} 损失 60 点生命` });
      }
    },
  },
};

/** 身边一圈里第一个空着的格子（只看地形与层，不看是谁挡住） */
function freeSpotNear(state: { units: { x: number; y: number }[]; w: number; h: number; tiles: { terrain: string }[] }, u: { x: number; y: number }): { x: number; y: number } | null {
  const taken = (x: number, y: number) => state.units.some((d) => d.x === x && d.y === y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = u.x + dx;
      const y = u.y + dy;
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      if (taken(x, y)) continue;
      return { x, y };
    }
  }
  return null;
}

/* ===========================================================================
 * 五、第 8 代「聚变时代」
 *
 * **这个包故意不带钩子。**
 *
 * 它 `requires: ['armor-era7']`，所以只要有 8 代，7 代的钩子就必然在场上；
 * 而模块行为完全是数据驱动的（护甲 / 移速 / 视野 / 减伤全部读 `MODULES`），
 * 7 代那份钩子对 8 代素体一样管用。
 *
 * 一开始写的是 `hooks: ARMOR_ERA7.hooks`，图的是"两代绝不分叉"。实测立刻炸：
 * `activeExpansions` 会把**每一个**扩展的钩子都跑一遍，于是同一条伤减算两次——
 * 近防激光写着 −8，实际 −16；护甲 +3 变成 +6。这类错误在面板上完全看不出来。
 * ======================================================================== */

export const ARMOR_ERA8: Expansion = {
  id: 'armor-era8',
  name: '聚变时代',
  blurb: '解锁第八时代：重型平台、超载与光环，以及聚变供电。',
  summary:
    '第八时代「聚变时代」：三台更极端的素体（塔 / 蜂群母体 / 猎手）与 24 件新模块。' +
    '「超载协议」是唯一允许耗能超过供电的东西——它自己发 40 点额度。' +
    '三条光环（集群协议 / 反导穹顶 / 战区指挥车坞）复用现成的 AuraSpec。' +
    '「反重力悬浮」把地面素体改成空中单位，代价是拿不到地形护甲。',
  scale: 'large',
  unlockEra: 8,
  requires: ['armor-era7'],
  units: ARMOR8_UNITS,
  // 空对象，不是"忘了写"：留痕种类按 id 注册进全局表（7 代那份已经在了），
  // 钩子也全走 7 代。这里再填一份就会跑两遍（见本节开头）。
  hooks: {},
};
