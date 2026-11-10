/**
 * 「装甲与装配」的数据表与工具（时代 7）。
 *
 * 三条口径，写在最前面，后面每一处都引它：
 *
 *   1. **素体是单位，模块不是。** 素体进卡池、占编制、上棋盘；模块只是挂在
 *      `Unit.modules` 里的 id，没有自己的血量与站位。所以"模块表"不进
 *      `state.unitTypes`，它是一张常量表（`MODULES`）。
 *   2. **能量是派生指标，不是资源。** 不存库存、不进 `player.res`：
 *      `supply - demand` 每次现算。做成库存就会出现"先攒电、一次性上十台"，
 *      上限形同虚设。
 *   3. **造价只写金币。** 建筑是 `UnitTypeDef`，开了「城郭与物料」它会自己按
 *      30/70 折算；模块不走造价钩子，纯金币。
 */

import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import type { AuraSpec } from './ability-hooks.ts';
import { navigable, passable } from './config.ts';
import { addMark, marksAt } from './marks.ts';

/* ===========================================================================
 * 一、模块表
 * ======================================================================== */

export type ArmorSlot = 'main' | 'sub' | 'plate' | 'system' | 'device';

/**
 * 设备的效果种类（见 4.4）。
 *
 * 一件设备 = 一个作用 + 一定次数；次数不自动恢复，得回装配坞「整备」买。
 * 这五种覆盖了"战场上的即时手段"这一格，没有一个是"造成伤害"——
 * 伤害已经归武器了，设备不需要再抢那条路。
 */
export type DeviceKind =
  | 'smoke'
  | 'repair'
  | 'mine'
  | 'grapnel'
  | 'swarm'
  /** 8 代：6 格瞬移（钩索的上一档） */
  | 'phase'
  /** 8 代：放两架重装无人机 */
  | 'swarm2'
  /** 8 代：给周围 1 格友军各 +30 额外生命 */
  | 'shield'
  /** 8 代：在 3×3 上打一发延迟落地的 120 伤害 */
  | 'lance';

/** 一件武器：每回合开火几次、一次几段、几回合一发 */
export interface WeaponProfile {
  damage: number;
  range: number;
  /** 每回合独立攻击次数（默认 1） */
  shots?: number;
  /** 单次攻击内的段数（默认 1） */
  burst?: number;
  /** 打完要冷却几回合（0 = 下回合就能再打） */
  reload?: number;
  /** 溅射半径 */
  splash?: number;
  /** 破甲：目标护甲减半（布尔，不是"减 N 点"） */
  pierce?: boolean;
  /** 只能打空中 / 只能打地面 / 都能 */
  targets?: 'ground' | 'air' | 'both';
  /** 对建筑的伤害倍率 */
  vsBuilding?: number;
  /** 打完给目标叠的状态（8 代的减速弹、电磁脉冲炮） */
  status?: { id: 'slow'; stacks: number };
}

export interface ModuleDef {
  id: string;
  name: string;
  slot: ArmorSlot;
  /** 金币造价（装配时一次性付清） */
  cost: number;
  /** 耗能 */
  draw: number;
  /** 武器槽才有 */
  weapon?: WeaponProfile;
  /** 非武器槽的纯加法修正 */
  armor?: number;
  move?: number;
  vision?: number;
  /**
   * 只在"本回合还没出过手"时给的移速（战术冲刺）。
   *
   * 单独一个字段而不是复用 `move`：`+3 移动、开过火就没有` 这条如果写成
   * "move +3 然后在钩子里扣回去"，面板、AI 估价、移动力三处都得记得扣，
   * 漏一处就是"走完了才发现打不了"或者"打完了还能多走三格"。
   */
  moveIdle?: number;
  /** 额外生命上限 */
  extraHp?: number;
  /** 每台只能装一件 */
  unique?: boolean;
  /** 白名单：只能装在这些素体上 */
  frames?: string[];
  /** 黑名单：装不上这些素体 */
  excludeFrames?: string[];
  /** 只能装在**地面**素体上（层级相关，见 4.1） */
  groundOnly?: boolean;
  /** 只能装在**空中**素体上 */
  airOnly?: boolean;
  /**
   * 装上之后本台变成**空中单位**（反重力悬浮）。
   *
   * 为什么不写成"mount 时把 `unit.layer` 存进存档"：断电、卸下、读旧档
   * 三条路都要把这个字段擦干净，漏一条就会出现"模块早拆了却还在天上飞"。
   * 现在改成**现算**（`hasHoverModule`），层级永远跟着模块表走。
   */
  layerAir?: boolean;
  /** 移动后开火不再吃 ×0.7 */
  steady?: boolean;
  /** 步耗：这些地形按 1 步算 */
  stepAsOne?: boolean;
  /** 召唤：装了就每 N 回合放一个 type，场上最多 max */
  summon?: { type: string; every: number; max: number };
  /** 设备槽：可用次数 */
  charges?: number;
  /**
   * 设备的效果种类。没写 = 这件装备装了也用不出来（面板会直接说）。
   *
   * 为什么用"种类"而不是给每件模块挂一个函数：效果要读写 `GameState`、
   * 要查装配坞、要布留痕，写成函数字段会让 `MODULES` 从一张纯数据表变成
   * 一堆能被序列化坏掉的东西（存档、联机快照、规则书生成都读它）。
   */
  device?: DeviceKind;
  /** 光环说明（实际生效由 auras.ts 的 AuraSpec 承担，这里只记文案） */
  note?: string;
  /* ── 8 代新增的四件"被动防御 / 供电"型模块 ─────────────────────────── */
  /** 给己方供能总额加这么多（只有「超载协议」用） */
  power?: number;
  /** 光环：和兵种能力的光环走同一条合并路径（见 auras.ts 的 extraAura） */
  aura?: AuraSpec;
  /** 本台受到的**远程**伤害再减这么多点（近防激光） */
  ciws?: number;
  /** 本台受到的**溅射**伤害按这个比例削（0.35 = −35%，反应堆护罩） */
  splashCut?: number;
  /** 本回合**移动过**时，受到的远程伤害减这么多点（矢量喷口） */
  vector?: number;
  /** 武器射程 +N（瞄准阵列） */
  rangeBonus?: number;
}

/** 时代 7 的全部模块（26 件） */
export const MODULES: Record<string, ModuleDef> = {
  // ── 主 / 副武器（10 件） ───────────────────────────────────────────────
  autocannon: {
    id: 'autocannon',
    name: '速射炮',
    slot: 'main',
    cost: 190,
    draw: 10,
    weapon: { damage: 38, range: 7, shots: 2 },
  },
  antitank: {
    id: 'antitank',
    name: '反装甲炮',
    slot: 'main',
    cost: 240,
    draw: 14,
    weapon: { damage: 74, range: 7, pierce: true },
    excludeFrames: ['armor_hawk'],
  },
  flamer: {
    id: 'flamer',
    name: '火焰喷射器',
    slot: 'main',
    cost: 170,
    draw: 12,
    weapon: { damage: 48, range: 4, splash: 1 },
    frames: ['armor_anvil', 'armor_forge'],
  },
  twin: {
    id: 'twin',
    name: '双联装炮塔',
    slot: 'main',
    cost: 280,
    draw: 14,
    weapon: { damage: 55, range: 8, burst: 2 },
    frames: ['armor_anvil', 'armor_tower'],
  },
  chainsaw: {
    id: 'chainsaw',
    name: '链锯臂',
    slot: 'main',
    cost: 140,
    draw: 6,
    weapon: { damage: 138, range: 1 },
  },
  coax: {
    id: 'coax',
    name: '同轴机枪',
    slot: 'sub',
    cost: 90,
    draw: 4,
    weapon: { damage: 26, range: 6, shots: 2 },
  },
  grenade: {
    id: 'grenade',
    name: '榴弹发射器',
    slot: 'sub',
    cost: 170,
    draw: 6,
    weapon: { damage: 56, range: 7, splash: 1, vsBuilding: 1.5 },
    excludeFrames: ['armor_hawk'],
  },
  flak: {
    id: 'flak',
    name: '防空炮',
    slot: 'sub',
    cost: 200,
    draw: 8,
    weapon: { damage: 44, range: 8, shots: 2, targets: 'air' },
  },
  dozer: {
    id: 'dozer',
    name: '破障铲',
    slot: 'sub',
    cost: 80,
    draw: 4,
    weapon: { damage: 34, range: 1, vsBuilding: 2 },
    frames: ['armor_anvil'],
  },
  maghammer: {
    id: 'maghammer',
    name: '磁力锤',
    slot: 'sub',
    cost: 160,
    draw: 8,
    weapon: { damage: 104, range: 1, pierce: true },
    frames: ['armor_anvil'],
    unique: true,
  },

  // ── 装甲槽（5 件） ────────────────────────────────────────────────────
  composite: {
    id: 'composite',
    name: '复合装甲板',
    slot: 'plate',
    cost: 160,
    draw: 0,
    armor: 3,
    frames: ['armor_anvil'],
  },
  reactive: {
    id: 'reactive',
    name: '反应装甲',
    slot: 'plate',
    cost: 200,
    draw: 2,
    unique: true,
    note: '受到的远程伤害 −15',
  },
  lightframe: {
    id: 'lightframe',
    name: '轻量化骨架',
    slot: 'plate',
    cost: 140,
    draw: 0,
    move: 1,
    armor: -1,
    frames: ['armor_hawk'],
  },
  skirts: {
    id: 'skirts',
    name: '防爆裙板',
    slot: 'plate',
    cost: 150,
    draw: 2,
    note: '免疫溅射',
  },
  tracks: {
    id: 'tracks',
    name: '全地形履带',
    slot: 'plate',
    cost: 200,
    draw: 4,
    move: 1,
    stepAsOne: true,
    groundOnly: true,
  },

  // ── 系统槽（6 件） ────────────────────────────────────────────────────
  radar: {
    id: 'radar',
    name: '战场雷达',
    slot: 'system',
    cost: 120,
    draw: 4,
    vision: 3,
  },
  shieldgen: {
    id: 'shieldgen',
    name: '护盾发生器',
    slot: 'system',
    cost: 280,
    draw: 8,
    extraHp: 60,
    unique: true,
  },
  jammer: {
    id: 'jammer',
    name: '电子压制',
    slot: 'system',
    cost: 240,
    draw: 6,
    unique: true,
    note: '相邻敌军叠 1 层减速',
  },
  gyro: {
    id: 'gyro',
    name: '陀螺稳定器',
    slot: 'system',
    cost: 260,
    draw: 6,
    unique: true,
    steady: true,
  },
  booster: {
    id: 'booster',
    name: '突进推进器',
    slot: 'system',
    cost: 220,
    draw: 6,
    move: 2,
    armor: -2,
    unique: true,
  },
  dronebay: {
    id: 'dronebay',
    name: '无人机母舱',
    slot: 'system',
    cost: 320,
    draw: 8,
    unique: true,
    summon: { type: 'armor_drone', every: 2, max: 2 },
  },

  // ── 设备槽（5 件） ────────────────────────────────────────────────────
  smoke: {
    id: 'smoke',
    name: '烟幕发生器',
    slot: 'device',
    cost: 110,
    draw: 4,
    charges: 2,
    device: 'smoke',
    note: '身下周及相邻格布烟幕，站里面的己方单位受远程伤害 −30%，两个自己回合后散去',
  },
  servicerig: {
    id: 'servicerig',
    name: '整备臂',
    slot: 'device',
    cost: 130,
    draw: 6,
    charges: 2,
    device: 'repair',
    note: '给相邻友军 +40 额外生命（一次性，打光不回来）',
  },
  miner: {
    id: 'miner',
    name: '布雷器',
    slot: 'device',
    cost: 120,
    draw: 5,
    charges: 1,
    device: 'mine',
    note: '在相邻空格布 2 枚地雷（敌方踩上炸 40，自己人不炸）',
  },
  grapnel: {
    id: 'grapnel',
    name: '弹射钩索',
    slot: 'device',
    cost: 180,
    draw: 6,
    charges: 2,
    device: 'grapnel',
    excludeFrames: ['armor_tower'],
    note: '瞬移到 3 格内的空地，当回合不能再移动',
  },
  swarmpod: {
    id: 'swarmpod',
    name: '蜂群弹射器',
    slot: 'device',
    cost: 240,
    draw: 6,
    charges: 2,
    device: 'swarm',
    note: '一次放出 2 架蜂群无人机（全场上限 2 架）',
  },

  // ══ 时代 8「聚变时代」的 24 件（同一张表：模块没有"代"字段，能不能装看素体） ══

  // ── 主 / 副武器（9 件） ───────────────────────────────────────────────
  railgun: {
    id: 'railgun',
    name: '轨道炮',
    slot: 'main',
    cost: 420,
    draw: 20,
    frames: ['armor_tower'],
    weapon: { damage: 210, range: 11, reload: 1, pierce: true },
  },
  plasmacannon: {
    id: 'plasmacannon',
    name: '等离子加农',
    slot: 'main',
    cost: 380,
    draw: 16,
    excludeFrames: ['armor_hawk', 'armor_hunter'],
    weapon: { damage: 104, range: 8, splash: 1 },
  },
  laserarray: {
    id: 'laserarray',
    name: '激光阵列',
    slot: 'main',
    cost: 340,
    draw: 14,
    weapon: { damage: 96, range: 9 },
  },
  empcannon: {
    id: 'empcannon',
    name: '电磁脉冲炮',
    slot: 'main',
    cost: 300,
    draw: 12,
    weapon: { damage: 58, range: 8, status: { id: 'slow', stacks: 2 } },
  },
  plasmaedge: {
    id: 'plasmaedge',
    name: '等离子刃',
    slot: 'main',
    cost: 380,
    draw: 18,
    weapon: { damage: 240, range: 1, pierce: true },
  },
  micromissile: {
    id: 'micromissile',
    name: '微型导弹巢',
    slot: 'sub',
    cost: 260,
    draw: 8,
    weapon: { damage: 30, range: 9, shots: 3, targets: 'both' },
  },
  ciws: {
    id: 'ciws',
    name: '近防激光',
    slot: 'sub',
    cost: 200,
    draw: 6,
    ciws: 8,
    weapon: { damage: 36, range: 5 },
  },
  slowmissile: {
    id: 'slowmissile',
    name: '缓速弹发射器',
    slot: 'sub',
    cost: 220,
    draw: 6,
    weapon: { damage: 46, range: 8, status: { id: 'slow', stacks: 1 } },
  },
  gravityhammer: {
    id: 'gravityhammer',
    name: '重力锤',
    slot: 'sub',
    cost: 280,
    draw: 12,
    excludeFrames: ['armor_tower'],
    weapon: { damage: 140, range: 1, splash: 1 },
  },

  // ── 装甲（3 件） ─────────────────────────────────────────────────────
  structlayer: {
    id: 'structlayer',
    name: '结构强化层',
    slot: 'plate',
    cost: 300,
    draw: 6,
    armor: 3,
    extraHp: 90,
  },
  phasearmor: {
    id: 'phasearmor',
    name: '相位装甲',
    slot: 'plate',
    cost: 360,
    draw: 10,
    armor: 6,
    move: -1,
    frames: ['armor_tower'],
  },
  reactorveil: {
    id: 'reactorveil',
    name: '反应堆护罩',
    slot: 'plate',
    cost: 280,
    draw: 8,
    splashCut: 0.35,
  },

  // ── 系统（8 件） ─────────────────────────────────────────────────────
  overload: {
    id: 'overload',
    name: '超载协议',
    slot: 'system',
    cost: 320,
    draw: 6,
    power: 40,
    unique: true,
  },
  swarmprotocol: {
    id: 'swarmprotocol',
    name: '集群协议',
    slot: 'system',
    cost: 340,
    draw: 8,
    unique: true,
    aura: { label: '集群协议', allyAtk: 6, radius: 2 },
  },
  targeting: {
    id: 'targeting',
    name: '瞄准阵列',
    slot: 'system',
    cost: 240,
    draw: 4,
    rangeBonus: 1,
  },
  aegisdome: {
    id: 'aegisdome',
    name: '反导穹顶',
    slot: 'system',
    cost: 380,
    draw: 10,
    unique: true,
    aura: { label: '反导穹顶', foeAtkPct: 0.15, radius: 2 },
  },
  antigrav: {
    id: 'antigrav',
    name: '反重力悬浮',
    slot: 'system',
    cost: 400,
    draw: 10,
    move: 2,
    unique: true,
    groundOnly: true,
    layerAir: true,
    note: '装上的地面素体会变成空中单位（近战得多走一格才够得着，但也不再吃地形护甲）',
  },
  vector: {
    id: 'vector',
    name: '矢量喷口',
    slot: 'system',
    cost: 300,
    draw: 6,
    move: 1,
    vector: 6,
  },
  sprint: {
    id: 'sprint',
    name: '战术冲刺',
    slot: 'system',
    cost: 320,
    draw: 8,
    moveIdle: 3,
    unique: true,
    note: '移动 +3；本回合开过火就没有这 +3',
  },
  heavybay: {
    id: 'heavybay',
    name: '重装母舱',
    slot: 'system',
    cost: 420,
    draw: 10,
    unique: true,
    summon: { type: 'armor_drone2', every: 2, max: 2 },
  },

  // ── 设备（4 件） ─────────────────────────────────────────────────────
  lance: {
    id: 'lance',
    name: '轨道引导',
    slot: 'device',
    cost: 400,
    draw: 14,
    charges: 1,
    device: 'lance',
    frames: ['armor_tower', 'armor_swarm'],
    note: '标记 3×3，下一个回合开始时其中的单位各受 120 伤害',
  },
  phasestep: {
    id: 'phasestep',
    name: '相位穿越',
    slot: 'device',
    cost: 400,
    draw: 12,
    charges: 2,
    device: 'phase',
    excludeFrames: ['armor_tower'],
    note: '瞬移到 6 格内的空地',
  },
  swarmheavy: {
    id: 'swarmheavy',
    name: '无人机蜂群',
    slot: 'device',
    cost: 320,
    draw: 8,
    charges: 2,
    device: 'swarm2',
    note: '一次放出 2 架重装无人机（全场上限 2 架）',
  },
  shieldproj: {
    id: 'shieldproj',
    name: '护盾投影器',
    slot: 'device',
    cost: 300,
    draw: 10,
    charges: 1,
    device: 'shield',
    note: '周围 1 格的友军各 +30 额外生命',
  },
};

/* ===========================================================================
 * 二、素体工具
 * ======================================================================== */

export const MODULE_LIST: readonly ModuleDef[] = Object.values(MODULES);

export function moduleById(id: string): ModuleDef | undefined {
  return MODULES[id];
}

/** 这台是不是装甲素体 */
export function isArmorFrame(def: UnitTypeDef | undefined): boolean {
  return !!def?.armorFrame;
}

/** 已装模块的 id 列表（存档里可能没有这个字段） */
export function modulesOf(u: Unit): string[] {
  return u.modules ?? [];
}

/** 模块装在这台素体上合不合法（只看槽位与黑白名单，不看电与钱） */
export function fitsFrame(u: Unit, def: UnitTypeDef, m: ModuleDef): boolean {
  if (m.frames && !m.frames.includes(def.id)) return false;
  if (m.excludeFrames && m.excludeFrames.includes(def.id)) return false;
  if (m.groundOnly && def.layer === 'air') return false;
  if (m.airOnly && def.layer !== 'air') return false;
  const cap = def.slots?.[m.slot] ?? 0;
  if (cap <= 0) return false;
  const used = modulesOf(u).filter((id) => MODULES[id]?.slot === m.slot).length;
  if (used >= cap) return false;
  if (m.unique && modulesOf(u).includes(m.id)) return false;
  return true;
}

/** 这台单位此刻的全部武器（素体自带撞击不算在内） */
export function weaponsOf(u: Unit): { id: string; m: ModuleDef; w: WeaponProfile }[] {
  const out: { id: string; m: ModuleDef; w: WeaponProfile }[] = [];
  for (const id of modulesOf(u)) {
    const m = MODULES[id];
    if (m?.weapon) out.push({ id, m, w: m.weapon });
  }
  return out;
}

/* ===========================================================================
 * 三、能量：派生指标
 * ======================================================================== */

export interface EnergyReport {
  supply: number;
  demand: number;
  headroom: number;
}

/** 某方此刻的供电 / 需求 / 余量 */
export function energyReport(s: GameState, player: PlayerId): EnergyReport {
  let supply = 0;
  let demand = 0;
  for (const u of s.units) {
    if (u.owner !== player || u.hp <= 0) continue;
    const def = s.unitTypes[u.type];
    if (!def) continue;
    if (def.armorPower) supply += def.armorPower;
    if (def.armorFrame) {
      demand += unitDraw(s, u);
      // 「超载协议」是唯一允许 demand > supply 的来源：它自己发 40 点额度。
      // 这条额度**不看断电**——它要是也被自己拖断电，"开了还过载"就变成死结。
      for (const id of modulesOf(u)) supply += MODULES[id]?.power ?? 0;
    }
  }
  return { supply, demand, headroom: supply - demand };
}

/**
 * 一件装备**具体在干什么**，压成一行字给面板用。
 *
 * 为什么需要它：装配坞以前每件只写「耗能 N」，武器再补一句伤害/射程，
 * **装甲板、系统槽那些纯加法修正全部隐身**——玩家看到"复合装甲 · 耗能 6"，
 * 不知道那是 +4 甲还是 +2 甲 +1 视野，只能去翻规则书。
 *
 * 这里是纯函数、只读 `ModuleDef`：面板、AI 复盘卡、规则书都能调，口径只有一处。
 * 顺序按"玩家最关心"排：伤害 → 射程 → 命中相关 → 防御 → 机动 → 其他。
 */
/**
 * 光环类的模块（集群协议、反导穹顶）以前在面板上**一个字都不写**——
 * 它们没有 weapon/armor 这些字段，效果全在 `aura` 里，于是装配坞只显示
 * "耗能 8"，玩家得去翻规则书才知道那是"半径 2 内友军攻击 +6"。
 *
 * 这里把 `AuraSpec` 翻成人话。只翻模块会用到的那些字段（见 MODULES），
 * 兵种能力那条路仍走 auras.ts 自己的文案。
 */
function auraSpecText(a: AuraSpec): string {
  const bits: string[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (a.allyAtk) bits.push(`友军攻击 +${a.allyAtk}`);
  if (a.allyAtkPct) bits.push(`友军攻击 +${pct(a.allyAtkPct)}`);
  if (a.allyArmor) bits.push(`友军护甲 +${a.allyArmor}`);
  if (a.allyArmorPct) bits.push(`友军护甲 +${pct(a.allyArmorPct)}`);
  if (a.allyMove) bits.push(`友军移速 +${a.allyMove}`);
  if (a.foeAtk) bits.push(`敌军攻击 −${a.foeAtk}`);
  if (a.foeAtkPct) bits.push(`敌军攻击 −${pct(a.foeAtkPct)}`);
  if (a.foeArmor) bits.push(`敌军护甲 −${a.foeArmor}`);
  return bits.length > 0 ? `光环（半径 ${a.radius}）：${bits.join(' · ')}` : '';
}

export function moduleSpecText(m: ModuleDef): string {
  const parts: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  const w = m.weapon;
  if (w) {
    parts.push(`伤害 ${w.damage}`);
    parts.push(`射程 ${w.range}`);
    if ((w.shots ?? 1) > 1) parts.push(`${w.shots} 连发`);
    if ((w.burst ?? 1) > 1) parts.push(`每次 ${w.burst} 段`);
    if (w.splash) parts.push(`溅射 ${w.splash}`);
    if (w.pierce) parts.push('破甲');
    if (w.targets === 'air') parts.push('只打空中');
    else if (w.targets === 'ground') parts.push('只打地面');
    if (w.vsBuilding && w.vsBuilding !== 1) parts.push(`对建筑 ×${w.vsBuilding}`);
    if (w.status) parts.push(`命中叠 ${w.status.stacks} 层减速`);
    if (w.reload) parts.push(`打完冷却 ${w.reload} 回合`);
  }

  // 纯加法修正（装甲板 / 系统槽的主力）
  if (m.armor) parts.push(`护甲 ${sign(m.armor)}`);
  if (m.extraHp) parts.push(`生命上限 ${sign(m.extraHp)}`);
  if (m.move) parts.push(`移速 ${sign(m.move)}`);
  if (m.moveIdle) parts.push(`未出手时移速 ${sign(m.moveIdle)}`);
  if (m.vision) parts.push(`视野 ${sign(m.vision)}`);
  if (m.rangeBonus) parts.push(`射程 ${sign(m.rangeBonus)}`);
  if (m.power) parts.push(`供电 ${sign(m.power)}`);
  if (m.steady) parts.push('移动后开火不吃减伤');
  if (m.stepAsOne) parts.push('森林丘陵按 1 步');
  if (m.layerAir) parts.push('装上后升空');
  if (m.ciws) parts.push(`远程伤害 −${m.ciws}`);
  if (m.splashCut) parts.push(`溅射伤害 −${Math.round(m.splashCut * 100)}%`);
  if (m.vector) parts.push(`移动后远程伤害 −${m.vector}`);
  if (m.summon) parts.push(`每 ${m.summon.every} 回合召唤，最多 ${m.summon.max} 个`);
  if (m.aura) {
    const aura = auraSpecText(m.aura);
    if (aura) parts.push(aura);
  }
  if (m.charges) parts.push(`${m.charges} 次使用`);
  if (m.note) parts.push(m.note);

  return parts.length > 0 ? parts.join(' · ') : '无属性修正';
}

/**
 * 电力的**分项**账：电站发多少、装备发多少、谁在吃。
 *
 * `energyReport` 只给三个总数（供给/需求/余量），够判"能不能装"，
 * 但玩家问"我这个余量是哪来的"时它答不上来。这里把发电拆成
 * 「发电厂」与「装备自带」两笔，面板据此画收支条。
 */
export function energyBreakdown(s: GameState, player: PlayerId): {
  /** 发电厂（armorPower）发的电 */
  plantPower: number;
  /** 装备自带（超载协议那种 power 字段） */
  modulePower: number;
  supply: number;
  demand: number;
  headroom: number;
  /** 几座发电厂 */
  plants: number;
  /** 几台装甲在吃电 */
  frames: number;
} {
  let plantPower = 0;
  let modulePower = 0;
  let demand = 0;
  let plants = 0;
  let frames = 0;
  for (const u of s.units) {
    if (u.owner !== player || u.hp <= 0) continue;
    const def = s.unitTypes[u.type];
    if (!def) continue;
    if (def.armorPower) {
      plantPower += def.armorPower;
      plants += 1;
    }
    if (def.armorFrame) {
      demand += unitDraw(s, u);
      frames += 1;
      for (const id of modulesOf(u)) modulePower += MODULES[id]?.power ?? 0;
    }
  }
  const supply = plantPower + modulePower;
  return { plantPower, modulePower, supply, demand, headroom: supply - demand, plants, frames };
}

/** 这台装甲的总耗能（素体基础 + 已装模块） */
export function unitDraw(s: GameState, u: Unit): number {
  const def = s.unitTypes[u.type];
  if (!def?.armorFrame) return 0;
  let n = def.draw ?? 0;
  for (const id of modulesOf(u)) n += MODULES[id]?.draw ?? 0;
  return n;
}

/**
 * 按装配顺序倒序算出"哪些模块断电了"。
 *
 * 规则：只停 `draw > 0` 的模块，素体本身永不停机。返回的是被停用的模块 id 集合。
 * 这是纯函数——面板、AI、攻击管线都读它，别各算一套。
 */
export function offlineModules(s: GameState, u: Unit): Set<string> {
  const def = s.unitTypes[u.type];
  const out = new Set<string>();
  if (!def?.armorFrame) return out;
  /*
   * 超载停机：这一回合整台离线。
   *
   * 「超载协议」用 "+40 额度" 换 "每 3 个自己的回合停 1 回合"，停机要停得彻底——
   * 只停武器不停护甲的话，玩家会发现"停机那回合反而最硬"，这个代价就成了笑话。
   * 所以这里是**整台**的：所有模块一起下线（素体本身仍然不停机，和断电同一条口径）。
   */
  if (u.overheatTurn === s.turn) {
    for (const id of modulesOf(u)) out.add(id);
    return out;
  }
  const rep = energyReport(s, u.owner);
  let over = -rep.headroom; // > 0 表示超了多少
  if (over <= 0) return out;
  const mods = modulesOf(u).slice().reverse(); // 后装的先停
  for (const id of mods) {
    if (over <= 0) break;
    const d = MODULES[id]?.draw ?? 0;
    if (d <= 0) continue;
    out.add(id);
    over -= d;
  }
  return out;
}

/** 这台装甲此刻还能不能开火（任何一件武器在线且没冷却） */
export function readyWeapons(s: GameState, u: Unit, turn: number): string[] {
  const off = offlineModules(s, u);
  const out: string[] = [];
  for (const { id, w } of weaponsOf(u)) {
    if (off.has(id)) continue;
    const used = u.weaponUse?.[id];
    if (!used) {
      out.push(id);
      continue;
    }
    if (used.turn === turn && (used.shots ?? 0) >= (w.shots ?? 1)) continue;
    if (used.readyTurn !== undefined && turn < used.readyTurn) continue;
    out.push(id);
  }
  return out;
}

/* ===========================================================================
 * 四、装配 / 拆卸（P1）
 * ======================================================================== */

/** 装配坞的兵种 id */
export const ARMOR_DOCK = 'armor_dock';
/** 装配总厂的兵种 id：每回合能装 2 次、整备半价 */
export const ARMOR_YARD = 'armor_yard';

/** 这台单位身边（相邻格，含自身格）有没有己方的装配坞 */
function dockNextTo(s: GameState, u: Unit): Unit | undefined {
  return s.units.find(
    (d) =>
      d.owner === u.owner &&
      d.hp > 0 &&
      (d.type === ARMOR_DOCK || d.type === ARMOR_YARD) &&
      Math.max(Math.abs(d.x - u.x), Math.abs(d.y - u.y)) <= 1,
  );
}

/**
 * 这座坞本回合还能用几次。
 *
 * 名额记在 `custom` 上，不再借用 `Unit.era`。借用那个字段有两个毛病：
 *   1. 它和法律意义上的"落成时代"共用一个格子，一旦别处给坞写了 era，
 *      就会莫名变成"本回合已经用过"；
 *   2. 一个数字装不下"每回合 2 次"（装配总厂）。
 */
function dockCapacity(dock: Unit): number {
  return dock.type === ARMOR_YARD ? 2 : 1;
}

function dockUsedThisTurn(dock: Unit, turn: number): number {
  const rec = dock.custom?.dockUses;
  return dock.custom?.dockTurn === turn && typeof rec === 'number' ? rec : 0;
}

function spendDock(dock: Unit, turn: number): void {
  dock.custom = { ...(dock.custom ?? {}), dockTurn: turn, dockUses: dockUsedThisTurn(dock, turn) + 1 };
}

export type MountResult = { ok: true } | { ok: false; reason: string };

export interface MountCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 能不能装。按"先说清为什么不行"的顺序排：位置 → 槽位 → 预算 → 钱。
 */
export function canMount(s: GameState, u: Unit, moduleId: string): MountCheck {
  const def = s.unitTypes[u.type];
  if (!def?.armorFrame) return { ok: false, reason: '只有装甲素体才能装配模块' };
  const m = MODULES[moduleId];
  if (!m) return { ok: false, reason: '没有这个模块' };
  if (!fitsFrame(u, def, m)) return { ok: false, reason: `${def.name} 装不上「${m.name}」` };
  const dock = dockNextTo(s, u);
  if (!dock) return { ok: false, reason: '要走到装配坞旁边才能装配' };
  if (dockUsedThisTurn(dock, s.turn) >= dockCapacity(dock)) {
    return { ok: false, reason: '这座装配坞本回合已经用过了' };
  }
  const rep = energyReport(s, u.owner);
  if (rep.headroom < m.draw) {
    return { ok: false, reason: `供电不足：还要 ${m.draw} 点，余量只有 ${Math.max(0, rep.headroom)}` };
  }
  const p = s.players[u.owner];
  if (p && p.gold < m.cost) return { ok: false, reason: `金币不足（要 ${m.cost}）` };
  return { ok: true };
}

/**
 * 装配：付钱、扣回合、占掉这座坞本回合的名额。
 *
 * 名额记在坞的 `custom` 上（见 `dockCapacity`）。以前借用 `Unit.era` 存回合号，
 * 理由是"那个字段在坞身上没有第二用途"——直到第 8 代的「装配总厂」要每回合
 * 2 次，一个数字装不下，才把这条债还掉。
 */
export function doMount(s: GameState, unitId: string, moduleId: string): MountResult {
  const u = s.units.find((x) => x.id === unitId && x.hp > 0);
  if (!u) return { ok: false, reason: '没有这个单位' };
  const chk = canMount(s, u, moduleId);
  if (!chk.ok) return { ok: false, reason: chk.reason ?? "装不上" };
  const m = MODULES[moduleId]!;
  const dock = dockNextTo(s, u)!;

  s.players[u.owner].gold -= m.cost;
  u.modules = [...modulesOf(u), moduleId];
  if (m.charges) {
    u.charges = { ...(u.charges ?? {}), [moduleId]: m.charges };
  }
  if (m.extraHp) u.extraHp = Math.min(extraHpCap(s, u), (u.extraHp ?? 0) + m.extraHp);
  spendDock(dock, s.turn);
  // 装配消耗这台单位一回合（每座坞每回合 1~2 次，所以这一条同时也是节流）
  u.acted = true;
  u.moved = true;
  return { ok: true };
}

/**
 * 拆卸：不消耗回合，退 50% 金币（只退金，模块没有材料成本）。
 *
 * 卸下 `extraHp` 类模块时当前额外生命要跟着截断——否则"装上补满、卸下带着走"
 * 就是无限血包。
 */
export function doUnmount(s: GameState, unitId: string, moduleId: string): MountResult {
  const u = s.units.find((x) => x.id === unitId && x.hp > 0);
  if (!u) return { ok: false, reason: '没有这个单位' };
  const list = modulesOf(u);
  if (!list.includes(moduleId)) return { ok: false, reason: '没装这个模块' };
  const m = MODULES[moduleId]!;
  u.modules = list.filter((id) => id !== moduleId);
  if (u.charges) delete u.charges[moduleId];
  if (u.weaponUse) delete u.weaponUse[moduleId];
  if (m.extraHp) u.extraHp = Math.max(0, Math.min(u.extraHp ?? 0, extraHpCap(s, u)));
  s.players[u.owner].gold += Math.floor(m.cost / 2);
  return { ok: true };
}

/** 额外生命上限 = 已装模块给的额度 + 别人给的授予（断电的模块不算） */
export function extraHpCap(s: GameState, u: Unit): number {
  const off = offlineModules(s, u);
  let n = u.extraHpBonus ?? 0;
  for (const id of modulesOf(u)) {
    if (off.has(id)) continue;
    n += MODULES[id]?.extraHp ?? 0;
  }
  return n;
}

/** 素体的撞击伤害：一件武器都没有时的唯一手段 */
export function ramAtkOf(s: GameState, u: Unit): number {
  return s.unitTypes[u.type]?.ramAtk ?? 0;
}

/** 这台装了「陀螺稳定器」吗：移动后开火不再吃 ×0.7 */
export function hasGyro(u: { modules?: string[] }): boolean {
  return modulesOf(u as Unit).some((id) => MODULES[id]?.steady);
}

/** 这台装了「全地形履带」吗：森林 / 丘陵 / 沼泽按 1 步 */
export function hasAllTerrain(u: { modules?: string[] }): boolean {
  return modulesOf(u as Unit).some((id) => MODULES[id]?.stepAsOne);
}

/**
 * 这台此刻因为模块而在**空中**吗（反重力悬浮）。
 *
 * 现算而不是读 `unit.layer`：断电、拆卸、旧存档三条路都不用额外擦字段。
 * 断电的悬浮模块不算——"断电先掉回地面"是设计稿 6.1.2 明写的。
 */
export function hasHoverModule(s: GameState, u: Unit): boolean {
  const ids = modulesOf(u).filter((id) => MODULES[id]?.layerAir);
  if (ids.length === 0) return false;
  const off = offlineModules(s, u);
  return ids.some((id) => !off.has(id));
}

/** 武器射程加成（瞄准阵列）：只对装甲自己的武器生效 */
export function armorRangeBonus(u: Unit): number {
  let n = 0;
  for (const id of modulesOf(u)) n += MODULES[id]?.rangeBonus ?? 0;
  return n;
}

/** 某个数值型字段在已装模块上的合计（断电的不算） */
function liveSum(s: GameState, u: Unit, key: 'ciws' | 'splashCut' | 'vector'): number {
  const off = offlineModules(s, u);
  let n = 0;
  for (const id of modulesOf(u)) {
    if (off.has(id)) continue;
    n += MODULES[id]?.[key] ?? 0;
  }
  return n;
}

/** 近防激光 / 反应堆护罩 / 矢量喷口：三个"挨打时"的减伤数 */
export function defenseOf(s: GameState, u: Unit): { ciws: number; splashCut: number; vector: number } {
  return {
    ciws: liveSum(s, u, 'ciws'),
    splashCut: liveSum(s, u, 'splashCut'),
    vector: liveSum(s, u, 'vector'),
  };
}

/* ===========================================================================
 * 五、这一发用的是哪件武器（P2）
 * ======================================================================== */

export type WeaponPick =
  | { kind: 'weapon'; moduleId: string; w: WeaponProfile }
  /** 一件武器都没装（或都不可用）：只能撞击 */
  | { kind: 'ram'; moduleId: null; w: WeaponProfile }
  | { kind: 'reject'; reason: string };

/**
 * 解析这一发用哪件武器。
 *
 * 三条拒绝理由，都要能说人话：没装这件、这件断电了、这件本回合打完了还没冷却。
 * 不传 `weaponId` 时退到"第一件能开火的武器"，再退到撞击——这样界面只发一个
 * ATTACK 也能用，AI 也不会因为没挑武器就哑火。
 */
export function resolveArmorWeapon(s: GameState, u: Unit, weaponId: string | undefined, turn: number): WeaponPick {
  const off = offlineModules(s, u);
  const list = weaponsOf(u).filter((x) => !off.has(x.id));

  if (weaponId) {
    const own = weaponsOf(u).find((x) => x.id === weaponId);
    if (!own) return { kind: 'reject', reason: '这台没有这件武器' };
    if (off.has(weaponId)) return { kind: 'reject', reason: `「${own.m.name}」断电了，用不了` };
    if (!shotReady(u, weaponId, own.w, turn)) {
      return { kind: 'reject', reason: own.w.reload ? `「${own.m.name}」还在冷却` : `「${own.m.name}」本回合打完了` };
    }
    return { kind: 'weapon', moduleId: weaponId, w: own.w };
  }

  for (const x of list) {
    if (shotReady(u, x.id, x.w, turn)) return { kind: 'weapon', moduleId: x.id, w: x.w };
  }

  // 没有任何武器可打：退到撞击（素体永远不会"不能还手"）
  return { kind: 'ram', moduleId: null, w: { damage: ramAtkOf(s, u), range: 1 } };
}

/** 这件武器这一回合还能不能再打一次 */
function shotReady(u: Unit, id: string, w: WeaponProfile, turn: number): boolean {
  const rec = u.weaponUse?.[id];
  if (!rec) return true;
  if (rec.readyTurn !== undefined && turn < rec.readyTurn) return false;
  if (rec.turn !== turn) return true; // 新回合，次数重置
  return (rec.shots ?? 0) < (w.shots ?? 1);
}

/** 打完一发之后记账：本回合次数 +1；要冷却的写 readyTurn */
export function noteWeaponFired(u: Unit, id: string, w: WeaponProfile, turn: number): void {
  const book = { ...(u.weaponUse ?? {}) };
  const rec = book[id];
  const shots = rec && rec.turn === turn ? (rec.shots ?? 0) + 1 : 1;
  const readyTurn = w.reload ? turn + w.reload + 1 : undefined;
  book[id] = { turn, shots, ...(readyTurn !== undefined ? { readyTurn } : {}) };
  u.weaponUse = book;
}

/** 这一回合这台装甲总共还能开几枪（给 `modifyAttacks` 用） */
export function shotsLeftThisTurn(s: GameState, u: Unit, turn: number): number {
  const off = offlineModules(s, u);
  let n = 0;
  for (const x of weaponsOf(u)) {
    if (off.has(x.id)) continue;
    const rec = u.weaponUse?.[x.id];
    const used = rec && rec.turn === turn ? (rec.shots ?? 0) : 0;
    if (rec?.readyTurn !== undefined && turn < rec.readyTurn) continue;
    n += Math.max(0, (x.w.shots ?? 1) - used);
  }
  return n;
}

/* ===========================================================================
 * 六、设备槽（P5）
 *
 * 设备 = 有次数的主动道具（见设计稿 4.4）。三条硬规则，写在这里以免各处各说一套：
 *   1. 用设备吃掉本回合的**非移动动作**（`acted`）——所以和开火互斥，
 *      但**不**影响移动：移动过照样能用设备，反过来也一样；
 *   2. 次数**不自动恢复**，只有回装配坞「整备」能买回来（`doRecharge`）；
 *   3. 设备照样占耗能，断电就连同效果一起停（`offlineModules`）。
 *
 * 效果一律写成"就地改状态"，不做成回调表：五种效果各自要去查的上下文
 * （装配坞、留痕、友军、空位）差得太远，硬凑成一张函数表反而更难读。
 * ======================================================================== */

/** 烟幕留痕的种类 id（真正的 kind 定义在 armor-expansion.ts，跟着扩展走） */
export const SMOKE_KIND = 'armor-smoke';
/** 地雷留痕的种类 id */
export const MINE_KIND = 'armor-mine';
/** 轨道引导留痕的种类 id */
export const LANCE_KIND = 'armor-lance';
/** 一团烟幕能撑几个"自己回合的开始" */
export const SMOKE_TURNS = 2;
/** 护盾投影器给每个友军多少额外生命 */
export const SHIELD_PROJ_HP = 30;

/** 充能补给：按模块造价的这个比例收费 */
export const CHARGE_REFILL_RATE = 0.3;
/** 额外生命补给：多少金买 1 点（见 4.6 的「1 金 / 2 点」） */
export const EXTRA_HP_PER_GOLD = 2;
/** 整备臂给出去的额外生命 */
export const SERVICE_BONUS_HP = 40;
/** 无人机场上上限（设计稿 6.5） */
export const DRONE_CAP = 2;
/** 超载协议：每这么多个"自己的回合"停一次机（见 6.3） */
export const OVERLOAD_PERIOD = 3;

/** 装着的设备，按装配顺序 */
export function devicesOf(u: Unit): { id: string; m: ModuleDef }[] {
  const out: { id: string; m: ModuleDef }[] = [];
  for (const id of modulesOf(u)) {
    const m = MODULES[id];
    if (m?.slot === 'device') out.push({ id, m });
  }
  return out;
}

/**
 * 这件设备还剩几次。
 *
 * 没记过账就当**满的**——和 `shotReady` 把"没有 weaponUse 记录"当成"没打过"
 * 是同一个约定。否则从存档/测试里拿到的 `modules` 会带着一个空 `charges`，
 * 表现出来是"刚装上的设备一次都用不了"。
 */
export function chargesLeft(u: Unit, id: string): number {
  const rec = u.charges?.[id];
  if (typeof rec === 'number') return Math.max(0, rec);
  return Math.max(0, MODULES[id]?.charges ?? 0);
}

/** 面板据此决定"点了就直接生效"还是"进选点模式" */
export function deviceTargetOf(kind: DeviceKind | undefined): 'tile' | 'unit' | 'none' {
  if (kind === 'grapnel') return 'tile';
  if (kind === 'repair') return 'unit';
  return 'none';
}

/** 这一发设备能不能用。四道闸：装了 → 没断电 → 有次数 → 本回合没出过手 */
export function canUseDevice(s: GameState, u: Unit, id: string): MountCheck {
  const def = s.unitTypes[u.type];
  if (!def?.armorFrame) return { ok: false, reason: '只有装甲素体才有设备槽' };
  const m = MODULES[id];
  if (!m || m.slot !== 'device') return { ok: false, reason: '这不是设备' };
  if (!modulesOf(u).includes(id)) return { ok: false, reason: `没装「${m.name}」` };
  if (!m.device) return { ok: false, reason: `「${m.name}」的效果还没接入` };
  if (offlineModules(s, u).has(id)) return { ok: false, reason: `「${m.name}」断电了，用不了` };
  if (chargesLeft(u, id) <= 0) return { ok: false, reason: `「${m.name}」没有充能了，回装配坞整备` };
  if (u.acted) return { ok: false, reason: '本回合已经出过手（开火和设备共用一个动作）' };
  return { ok: true };
}

export interface DeviceTarget {
  x?: number;
  y?: number;
  targetId?: string;
}

function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.w && y < s.h;
}

/** 八邻 */
function around(u: { x: number; y: number }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    out.push({ x: u.x + dx, y: u.y + dy });
  }
  return out;
}

function isAirDef(def: UnitTypeDef | undefined): boolean {
  return def?.layer === 'air' || def?.flight === true;
}

/**
 * 这一格这个单位站不站得住。
 *
 * 为什么在这里自己判而不去调 `rules.ts` 的 `canStandAt`：rules 已经 import 了
 * armor，反向再 import 会绕成循环。所以这里只做**设备落点够用的那一半**判断
 * （地形 + 同层占位），和规则层的主判定口径保持一致：
 *   · 空中单位无视地形；水军认水，陆军认 `passable`；
 *   · 占地 2×2 的建筑挡住四格；
 *   · 空中和地面**可以同格**（这条是 4.1 定的，别按"有人就挡住"写）。
 */
function standableFor(s: GameState, mover: Unit, x: number, y: number): boolean {
  if (!inBounds(s, x, y)) return false;
  const tile = s.tiles[y * s.w + x];
  if (!tile) return false;
  const def = s.unitTypes[mover.type];
  const air = isAirDef(def);
  if (!air) {
    if (def?.domain === 'water') {
      if (!navigable(tile.terrain)) return false;
    } else if (!passable(tile.terrain)) return false;
  }
  for (const other of s.units) {
    if (other.id === mover.id || other.hp <= 0) continue;
    const od = s.unitTypes[other.type];
    if (isAirDef(od) !== air) continue; // 不同层不互相挡
    const n = od?.footprint === 2 ? 2 : 1;
    if (x >= other.x && x < other.x + n && y >= other.y && y < other.y + n) return false;
  }
  return true;
}

/**
 * 瞬移类设备（钩索 3 格 / 相位穿越 6 格）的共同实现。
 * 返回"为什么不行"，能走返回 null。
 */
function teleportTo(s: GameState, u: Unit, target: DeviceTarget | undefined, max: number): string | null {
  const x = target?.x;
  const y = target?.y;
  if (typeof x !== 'number' || typeof y !== 'number') return '要指定落点';
  if (!inBounds(s, x, y)) return '落点越界';
  if (Math.max(Math.abs(x - u.x), Math.abs(y - u.y)) > max) return `这件设备只有 ${max} 格`;
  if (x === u.x && y === u.y) return '已经在那一格了';
  if (!standableFor(s, u, x, y)) return '那一格站不住';
  u.x = x;
  u.y = y;
  u.moved = true;
  return null;
}

/** 召唤无人机：一次最多 want 架，场上同一型号合计不超过 DRONE_CAP */
function spawnDrones(s: GameState, u: Unit, type: string, want: number): number {
  const alive = s.units.filter((d) => d.owner === u.owner && d.type === type && d.hp > 0).length;
  const room = Math.max(0, DRONE_CAP - alive);
  if (room === 0) return 0;
  const hostAir = isAirDef(s.unitTypes[u.type]);
  let n = 0;
  for (const sp of around(u)) {
    if (n >= Math.min(want, room)) break;
    if (!standableFor(s, u, sp.x, sp.y)) continue;
    if (!hostAir && blockedByAirOnly(s, sp.x, sp.y)) continue;
    s.units.push({
      id: `${u.id}-${type}-${s.turn}-${n}`,
      type,
      owner: u.owner,
      x: sp.x,
      y: sp.y,
      hp: s.unitTypes[type]?.maxHp ?? 16,
      kills: 0,
      summoned: true,
      moved: true,
      acted: true,
    });
    n += 1;
  }
  return n;
}

/**
 * 用一件设备。
 * 效果失败时**不扣次数**——只有真的发生了才记账。这条很重要：
 * 布雷器在身边没空地时扣掉一次充能，玩家会以为中了什么隐形减益。
 */
export function doUseDevice(s: GameState, unitId: string, deviceId: string, target?: DeviceTarget): MountResult {
  const u = s.units.find((x) => x.id === unitId && x.hp > 0);
  if (!u) return { ok: false, reason: '没有这个单位' };
  if (u.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  const chk = canUseDevice(s, u, deviceId);
  if (!chk.ok) return { ok: false, reason: chk.reason ?? '用不了' };

  const m = MODULES[deviceId]!;

  switch (m.device) {
    // 烟幕：自身格 + 八邻，持续两个自己回合。
    // 已经有自己人的烟的地方是**续上**（重置回两回合）而不是跳过：
    // 跳过的写法会让"烟还没散"的这回合里整件设备都用不出去，
    // 玩家点了没反应、还以为卡了。
    case 'smoke': {
      let n = 0;
      for (const sp of [{ x: u.x, y: u.y }, ...around(u)]) {
        if (!inBounds(s, sp.x, sp.y)) continue;
        const here = marksAt(s, sp.x, sp.y).filter(
          (k) => k.kind === SMOKE_KIND && k.owner === u.owner,
        );
        if (here.length > 0) {
          for (const k of here) k.charges = SMOKE_TURNS;
        } else {
          addMark(s, { kind: SMOKE_KIND, owner: u.owner, x: sp.x, y: sp.y, charges: SMOKE_TURNS });
        }
        n += 1;
      }
      if (n === 0) return { ok: false, reason: '这一圈放不出烟' };
      break;
    }

    // 整备臂：给相邻友军一笔"别人的"额外生命（不从自己的模块额度里扣）
    case 'repair': {
      const t = target?.targetId ? s.units.find((x) => x.id === target.targetId && x.hp > 0) : undefined;
      if (!t) return { ok: false, reason: '要指定一个相邻的友军' };
      if (t.owner !== u.owner) return { ok: false, reason: '只能整备己方单位' };
      if (Math.max(Math.abs(t.x - u.x), Math.abs(t.y - u.y)) > 1) {
        return { ok: false, reason: '整备臂只够得着相邻的单位' };
      }
      t.extraHpBonus = (t.extraHpBonus ?? 0) + SERVICE_BONUS_HP;
      t.extraHp = Math.min(extraHpCap(s, t), (t.extraHp ?? 0) + SERVICE_BONUS_HP);
      break;
    }

    // 布雷器：八邻里挑两格空地，各埋一枚
    case 'mine': {
      let n = 0;
      for (const sp of around(u)) {
        if (n >= 2) break;
        if (!standableFor(s, u, sp.x, sp.y)) continue;
        const tile = s.tiles[sp.y * s.w + sp.x];
        if (!tile || !passable(tile.terrain)) continue;
        if (marksAt(s, sp.x, sp.y).some((k) => k.kind === MINE_KIND)) continue;
        addMark(s, { kind: MINE_KIND, owner: u.owner, x: sp.x, y: sp.y, charges: 1 });
        n += 1;
      }
      if (n === 0) return { ok: false, reason: '身边没有能布雷的空地' };
      break;
    }

    // 弹射钩索 / 相位穿越：3 格 / 6 格内瞬移。
    // 落点**不结算留痕**——钩索是"吊过去、脚不沾地"，踩不到自己布在脚下的雷，
    // 也就不会因为落点上有一枚雷而白给。（迁移落点的那一套结算在 doMove 里。）
    case 'grapnel':
    case 'phase': {
      const max = m.device === 'phase' ? 6 : 3;
      const why = teleportTo(s, u, target, max);
      if (why) return { ok: false, reason: why };
      break;
    }

    // 蜂群弹射器：一次两架，但全场上限是 2
    case 'swarm': {
      const n = spawnDrones(s, u, 'armor_drone', 2);
      if (n === 0) return { ok: false, reason: `场上已经有 ${DRONE_CAP} 架无人机了，或身边没有空位` };
      break;
    }

    // 无人机蜂群：和上面同一套召唤，只是换一种无人机
    case 'swarm2': {
      const n = spawnDrones(s, u, 'armor_drone2', 2);
      if (n === 0) return { ok: false, reason: `场上已经有 ${DRONE_CAP} 架重装无人机，或身边没有空位` };
      break;
    }

    // 护盾投影器：周围 1 格（含自己）的友军各拿一笔额外生命
    case 'shield': {
      let n = 0;
      for (const t of s.units) {
        if (t.owner !== u.owner || t.hp <= 0) continue;
        if (Math.max(Math.abs(t.x - u.x), Math.abs(t.y - u.y)) > 1) continue;
        t.extraHpBonus = (t.extraHpBonus ?? 0) + SHIELD_PROJ_HP;
        t.extraHp = Math.min(extraHpCap(s, t), (t.extraHp ?? 0) + SHIELD_PROJ_HP);
        n += 1;
      }
      if (n === 0) return { ok: false, reason: '附近没有友军' };
      break;
    }

    // 轨道引导：在 3×3 上打一枚"下一回合开始结算"的标
    case 'lance': {
      if (marksAt(s, u.x, u.y).some((k) => k.kind === LANCE_KIND && k.owner === u.owner)) {
        return { ok: false, reason: '这一片已经引导过了' };
      }
      addMark(s, { kind: LANCE_KIND, owner: u.owner, x: u.x, y: u.y, charges: 1 });
      break;
    }

    default:
      return { ok: false, reason: '这件设备没有效果' };
  }
  u.charges = { ...(u.charges ?? {}), [deviceId]: chargesLeft(u, deviceId) - 1 };
  // 吃掉本回合的"非移动动作"：`acted` 一置位，`doAttack` 就会拒。
  u.acted = true;
  u.attacksLeft = 0;
  return { ok: true };
}

/** 无人机是空中单位：地面素体放出来时，得避开同一格里已经停着的空中单位 */
function blockedByAirOnly(s: GameState, x: number, y: number): boolean {
  return s.units.some(
    (d) => d.hp > 0 && d.x === x && d.y === y && isAirDef(s.unitTypes[d.type]),
  );
}

/* ---------------------------------------------------------------------------
 * 整备：把充能和额外生命补回来
 * ------------------------------------------------------------------------ */

export interface RechargeQuote {
  /** 有几件设备需要补次数 */
  devices: number;
  /** 补次数要多少钱 */
  chargeCost: number;
  /** 额外生命还差多少 */
  hpGap: number;
  /** 补额外生命要多少钱 */
  hpCost: number;
  total: number;
}

/** 这次整备要花多少、补多少（面板和 AI 都读它，别各算一套） */
export function rechargeQuote(s: GameState, u: Unit): RechargeQuote {
  // 装配总厂整备半价（设计稿 6.2）；没有总厂就按原价。
  const dock = dockNextTo(s, u);
  const rate = dock?.type === ARMOR_YARD ? 0.5 : 1;
  let devices = 0;
  let chargeCost = 0;
  for (const { id, m } of devicesOf(u)) {
    const cap = m.charges ?? 0;
    if (cap <= 0 || chargesLeft(u, id) >= cap) continue;
    devices += 1;
    chargeCost += Math.ceil(m.cost * CHARGE_REFILL_RATE * rate);
  }
  const hpGap = Math.max(0, extraHpCap(s, u) - (u.extraHp ?? 0));
  const hpCost = Math.ceil((hpGap / EXTRA_HP_PER_GOLD) * rate);
  return { devices, chargeCost, hpGap, hpCost, total: chargeCost + hpCost };
}

export function canRecharge(s: GameState, u: Unit): MountCheck {
  const def = s.unitTypes[u.type];
  if (!def?.armorFrame) return { ok: false, reason: '只有装甲素体才需要整备' };
  const dock = dockNextTo(s, u);
  if (!dock) return { ok: false, reason: '要贴着装配坞才能整备' };
  if (dockUsedThisTurn(dock, s.turn) >= dockCapacity(dock)) {
    return { ok: false, reason: '这座装配坞本回合已经用过了' };
  }
  const q = rechargeQuote(s, u);
  if (q.total <= 0) return { ok: false, reason: '充能和额外生命都是满的' };
  const p = s.players[u.owner];
  if (p && p.gold < q.total) return { ok: false, reason: `金币不足（整备要 ${q.total}）` };
  return { ok: true };
}

/**
 * 整备：按缺口付费，占掉这座坞本回合的名额。
 *
 * 为什么**不**顺手把这台单位的回合也用掉：设计稿 4.6 只写了"占该坞本回合 1 次"。
 * 多加一条"整备也算行动"，实际效果是"打完仗回坞补一口"这个最常见的用法
 * 永远做不出来——那还不如直接不做整备。
 */
export function doRecharge(s: GameState, unitId: string): MountResult {
  const u = s.units.find((x) => x.id === unitId && x.hp > 0);
  if (!u) return { ok: false, reason: '没有这个单位' };
  if (u.owner !== s.current) return { ok: false, reason: '这不是你的单位' };
  const chk = canRecharge(s, u);
  if (!chk.ok) return { ok: false, reason: chk.reason ?? '整备不了' };
  const dock = dockNextTo(s, u)!;
  const q = rechargeQuote(s, u);

  s.players[u.owner].gold -= q.total;
  for (const { id, m } of devicesOf(u)) {
    const cap = m.charges ?? 0;
    if (cap <= 0) continue;
    u.charges = { ...(u.charges ?? {}), [id]: cap };
  }
  u.extraHp = extraHpCap(s, u);
  spendDock(dock, s.turn);
  return { ok: true };
}
