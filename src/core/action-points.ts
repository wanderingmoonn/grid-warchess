/**
 * 「行动点」扩展：把移动 / 攻击 / 驻扎 / 上下船 / 释放技能统一成一件事——**行动**，
 * 每一次行动都从单位自己的行动点池（下称 E）里扣钱。
 *
 * 这一整个文件都在**扩展区**里：核心引擎（rules.ts / types.ts）一行没改，
 * 用的全是 Expansion 已经开好的钩子（modifyMove / modifyAttacks / modifyArmor /
 * getUnitPanelLines / onTurnStart / onTurnEnd / onMatchStart）和 `Unit.custom`
 * 这个"扩展专用沙盒"。
 *
 * ── 为什么 E 是"算出来的"，不是"扣出来的" ─────────────────────────────
 *
 * 最直白的实现是"每做一次行动就 u.E -= 20"。这在这套引擎里做不到，而且原因不是懒：
 *
 *   · 引擎没有任何"行动发生的那一刻"的扩展钩子。`modify*` 系列是纯函数
 *     （界面预览、AI 试算都会反复调用，写进去就会把预览变成真扣钱）；
 *     能改状态的只有 onMatchStart / onTurnStart / onTurnEnd 三个时点，
 *     它们都在回合边界上，不在行动边界上。
 *   · 于是 E 改成**从引擎已经记下的事实里投影出来**：
 *       移动/上下船 → 站位和本回合开账时不一样（`u.x/u.y` 对不上 `custom.ap`）
 *       攻击       → `u.attacksLeft` 比"本回合允许的次数"少了几次
 *       技能       → `u.skillTurn === 本回合`
 *       驻扎       → 以上都没有（这一回合什么都没干）
 *     这些都是引擎自己的字段，E 只是把它们折算成点数。
 *
 * 这么做的副作用是**好处**：E 天然跟着存档走（存在 `Unit.custom` 里只有一个
 * "开账时的站位"）、撤销重算不会漂、联机两端算出来一致、AI 试算同一份代码。
 *
 * ── 拦得住的和拦不住的（重要，规则书里也写了）────────────────────────
 *
 *   · 移动**拦得住**：`modifyMove` 返回 0 是引擎认可的口径（"这一回合动不了"，
 *     封冻的海军就是这么实现的），所以 E 不够就是走不了。
 *   · 额外攻击**拦得住**：`modifyAttacks` 决定这一回合能有几次攻击，
 *     E 不够就不给第二次。
 *   · 首击、技能**拦不住**：`doAttack` 在第一次攻击时把次数兜底成 `max(1, …)`，
 *     `doHeroSkill` 只看冷却/充能，两处都没有扩展的否决位。所以这两件事
 *     照常发生，但**账要记**：超支的部分变成"透支"，下个回合从池里先扣掉。
 *     与其假装拦住（把伤害改成 0），不如把"透支"写成规则——玩家看得懂，
 *     也不会出现"我明明没 E 了却打空了"这种说不清的结果。
 */

import type { GameState, Unit, UnitTypeDef } from './types.ts';
import type { Expansion } from './expansions.ts';

/* ══════════════════════════════════════════════════════════════════
 * 一、配置：所有数值都在这一段里
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一个单位一个回合的行动点上限（E）——**兵种自身属性**，不是全局常数。
 *
 * 2026-10-30 从固定的 100 改成「和血量一样写在兵种身上」：有的兵行动能力强，
 * 一回合能干的事就多，这是它的优势（灵活）。没写 `def.ap` 的兵按下面这几档。
 */
export const AP_BY_TIER = {
  mounted: 120,
  vehicle: 120,
  ranged: 110,
  base: 100,
  building: 0,
} as const;

/** 三类行动的默认消耗 */
export const AP_COST = {
  /** 移动 / 上下船：一次行动一个价，和地形无关（地形的代价走移动力，不进 E） */
  move: 20,
  /** 一次攻击。多段攻击（burst = n）的单位把它拆成 n 段，每段 40/n */
  attack: 40,
  /**
   * 释放一次主动技能。
   *
   * **待定**：设计表上写的是「待定」，先沿用 60。引擎只记 `skillTurn`（哪一回合放的），
   * 不记技能 id，所以眼下也只能是一个统一价；要分档得让核心先多记一个字段。
   */
  skill: 60,
} as const;

/** 三档行动在界面上怎么念（上下船并入移动那一档）。表驱动，免得面板里散落中文字面量 */
export const AP_ACTION_NAME = {
  move: '移动',
  attack: '攻击',
  skill: '技能',
} as const;

export type ApAction = keyof typeof AP_COST;

export const AP_CLASS_MOD = {
  /** 骑兵类：机动更省 —— 移动 −5E */
  mounted: { move: -5 },
  /** 车类（攻城器械、装甲车辆）：机动更省 —— 移动 −5E */
  vehicle: { move: -5 },
  /** 近战类：出手更省 —— 攻击 −10E */
  melee: { attack: -10 },
} as const;

export type ApClass = keyof typeof AP_CLASS_MOD;

/**
 * 骑兵类与车类的兵种 id。
 *
 * 为什么不从数值里推：兵种表里没有"骑"这个字段，`move / range / armor`
 * 也推不出来（游骑和弓手一样是 range 2，坦克和火炮的 armor 又差一截）。
 * 这类归属是**设计决定**，写在表里才能被读、被改、被测试点名核对。
 *
 * 漏写的后果是安全的：那个兵按标准价付 E（多花 5 点），不会凭空变强。
 * `test-rules` 里有一条用例专门核对这张表里的 id 都真实存在，
 * 改兵种 id 或写错字会当场变红。
 */
export const MOUNTED_IDS: readonly string[] = [
  // 原版
  'scout', // 斥候
  'knight', // 骑士
  'hussar', // 骠骑兵
  // 时代兵备
  'med_horsearcher', // 骑射手
  'gp_cuirassier', // 胸甲骑兵
  'gp_dragoon', // 龙骑兵
  // 奇想（`kite` 是"游骑"这条**能力**的 id，不是兵种，别抄进来）
  'elite-cavalry', // 精英骑兵（原「皇家骑兵」，2 代）
  'royal-cavalry', // 皇家骑兵（3 代，精英骑兵的晋升版）
  'cataphract', // 超级重骑
  'paladin', // 圣骑士
  'wolf-rider', // 狼骑士
  'spider-rider', // 蜘蛛骑士
  'centaur', // 半人马
  'griffin-rider', // 狮鹫骑士
  'dragoon-rider', // 龙骑兵（奇想）
  'cursed-knight', // 诅咒骑士
];

export const VEHICLE_IDS: readonly string[] = [
  // 原版
  'mortar', // 臼炮
  'artillery', // 火炮
  'armoredcar', // 装甲车
  'tank', // 坦克
  // 时代兵备：战车与各类火炮
  'anc_chariot', // 战车
  'anc_ballista', // 弩炮
  'med_trebuchet', // 投石机
  'gp_siegecannon', // 攻城加农炮
  'gp_culverin', // 长管炮
  'ind_trenchmortar', // 战壕迫击炮
  'ind_howitzer', // 榴弹炮
  'ind_railwaygun', // 列车炮
  'ind_landship', // 马克 I 坦克
  'ind_armoredtrain', // 装甲列车
  'mod_atgun', // 反坦克炮
  'mod_katyusha', // 火箭炮
  'mod_heavytank', // 重型坦克
  'mod_spg', // 自行火炮
  'mod_flak', // 高射炮
  'mod_heavy_mortar', // 重型迫击炮
  'mod_supply', // 补给车队
  // 现代 / 现代战争
  'ct_tank', // 坦克（现代）
  'ct_howitzer', // 榴弹炮（现代）
  'ct_recon', // 装甲侦察车
  'cnt_mbt', // 主战坦克
  'cnt_sph', // 自行榴弹炮
  'cnt_mlrs', // 远程火箭炮
];

/**
 * 近战类不写名单，按定义推：**射程 1 的战斗单位**。
 *
 * 两百多个兵种手写一遍不现实，而且"射程 1 就是贴上去打"本来就是它的定义
 * （射程 2 以上是远程，射程 0/建筑不参与）。斥候、民兵、长枪兵都在里面，
 * 骑士也在里面——一个人既可以算骑兵（机动便宜）也可以算近战（出手便宜），
 * 两类**叠加**，这正是规则想要的效果。
 */
function isMelee(def: UnitTypeDef): boolean {
  return def.category === 'combat' && def.range <= 1 && def.domain !== 'water';
}

/** 这个兵种命中哪些类别。界面用它解释"为什么单价不一样" */
export function apClassesOf(def: UnitTypeDef | undefined, id: string): ApClass[] {
  const out: ApClass[] = [];
  if (MOUNTED_IDS.includes(id)) out.push('mounted');
  if (VEHICLE_IDS.includes(id)) out.push('vehicle');
  if (def && isMelee(def)) out.push('melee');
  return out;
}

/**
 * 某个兵种做某件事要多少 E。
 *
 * 顺序是"先减修正、再保底 5"：保底是给以后可能出现的怪兵种留的活口
 * （比如某个扩展给兵挂了一条"移动 −20"），不让 E 变成负数。
 */
export function apActionCost(
  def: UnitTypeDef | undefined,
  id: string,
  action: ApAction,
): number {
  let e: number = AP_COST[action];
  // 攻击按段数拆：burst = n 的单位每次 40/n（打满 n 段仍是 40）
  if (action === 'attack') e = e / Math.max(1, def?.burst ?? 1);
  for (const cls of apClassesOf(def, id)) {
    const mod = AP_CLASS_MOD[cls] as Partial<Record<ApAction, number>>;
    e += mod[action] ?? 0;
  }
  return Math.max(5, Math.round(e * 100) / 100);
}

/**
 * 这个兵种每回合的行动点上限。
 *
 * `def.ap` 优先（兵种编辑器里能改），否则按分档：建筑 0、骑兵/车 120、
 * 远程 110、其余 100。建筑返回 0 表示「不参与」。
 */
export function apMaxOf(def: UnitTypeDef | undefined, id: string): number {
  if (def?.category === 'building') return AP_BY_TIER.building;
  if (typeof def?.ap === 'number' && def.ap > 0) return def.ap;
  const classes = apClassesOf(def, id);
  if (classes.includes('mounted') || classes.includes('vehicle')) return AP_BY_TIER.mounted;
  if ((def?.range ?? 1) >= 2 && def?.category === 'combat') return AP_BY_TIER.ranged;
  return AP_BY_TIER.base;
}

/* ══════════════════════════════════════════════════════════════════
 * 二、账本：靠 `Unit.custom.ap` 里的一个开账记录
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 每个单位每回合的"开账记录"，存在 `u.custom.ap`。
 *
 * `custom` 是引擎明说的扩展沙盒（"核心永远不会读取或修改这里的任何字段，
 * 它只是用来让扩展把自定义属性安全地存进存档里"），所以：
 *   · 它会跟着存档、读档、联机快照一起走；
 *   · 不需要在 types.ts 里加字段（那就成改核心了）。
 *
 * 只有四个数：
 *   turn  —— 这份账属于哪个回合（`s.turn`）。对不上＝还没开账。
 *   x, y  —— 开账那一刻站在哪。用来判断"这一回合走没走过"。
 *   debt  —— 本回合一开始就欠着的 E（上回合透支）。
 *   over  —— 本回合结算出的透支额，下回合开账时变成 debt。
 */
interface ApMark {
  turn: number;
  x: number;
  y: number;
  debt?: number;
  over?: number;
}

function readMark(u: Unit): ApMark | undefined {
  const raw = (u.custom as { ap?: unknown } | undefined)?.ap;
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Partial<ApMark>;
  if (typeof m.turn !== 'number' || typeof m.x !== 'number' || typeof m.y !== 'number') {
    return undefined;
  }
  return {
    turn: m.turn,
    x: m.x,
    y: m.y,
    debt: typeof m.debt === 'number' ? m.debt : 0,
    over: typeof m.over === 'number' ? m.over : 0,
  };
}

function writeMark(u: Unit, mark: ApMark): void {
  u.custom = { ...(u.custom ?? {}), ap: mark };
}

/** 一条消耗明细，界面直接拿来念："移动 −20" */
export interface ApSpend {
  action: ApAction;
  label: string;
  e: number;
}

export interface ApLedger {
  /** 这个单位参不参与行动点（建筑不参与：它没有"行动"这回事） */
  active: boolean;
  /** 本回合的账开过没有（刚招出来、刚下船的单位还没开账） */
  settled: boolean;
  /** 上限 */
  max: number;
  /** 本回合起点 = 上限 − 上回合透支 */
  start: number;
  /** 上回合透支、这一回合先扣掉的部分 */
  debt: number;
  spent: number;
  left: number;
  /** 本回合超支了多少（> 0 表示透支） */
  over: number;
  items: ApSpend[];
  /** 这一回合还能出手几次（`modifyAttacks` 用它；0 表示引擎那记保底首击之外不给） */
  attacksAllowed: number;
  /** 这个单位做各类行动的单价，界面用来说明"为什么是 15 而不是 20" */
  cost: Record<ApAction, number>;
  classes: ApClass[];
}

/**
 * 这个单位和"当前回合"的对应关系。
 *
 * 引擎里 `s.turn` 是**全局**回合数（每方结束回合就 +1），所以：
 *   · 轮到我：我的账就是 `s.turn` 这一本；
 *   · 不是我（对面回合，或者我在观战对方的单位）：他上一回合的账就是 `s.turn - 1`。
 *
 * 后一种情况是必要的：`resetUnitsFor` 只重置"轮到的这一方"，所以对方单位的
 * `moved / acted / attacksLeft` 在他们自己的回合结束后一直保留到下次轮到他。
 * 也就是说"他上一回合干了什么"在别人回合里仍然读得出来——驻扎的护甲加成
 * 正是靠这一点，在整个对面回合里都还挂着。
 */
function ledgerTurn(s: GameState, u: Unit): number {
  return u.owner === s.current ? s.turn : s.turn - 1;
}

/**
 * 算出这个单位这一刻的账。
 *
 * 纯函数：只读 state，不写任何东西。界面预览、`modifyMove` 反复问它都安全。
 */
export function apLedger(s: GameState, u: Unit): ApLedger {
  const def = s.unitTypes[u.type];
  const classes = apClassesOf(def, u.type);
  const cost: Record<ApAction, number> = {
    move: apActionCost(def, u.type, 'move'),
    attack: apActionCost(def, u.type, 'attack'),
    skill: apActionCost(def, u.type, 'skill'),
  };
  /** 这个兵这一回合的池子：和血量一样写在兵种身上（没写就按分档） */
  const max = def?.category === 'building' ? 0 : apMaxOf(def, u.type);
  const base: ApLedger = {
    active: def?.category !== 'building',
    settled: false,
    max,
    start: max,
    debt: 0,
    spent: 0,
    left: max,
    over: 0,
    items: [],
    attacksAllowed: Math.max(1, def?.burst ?? 1),
    cost,
    classes,
  };
  // 建筑不参与：城墙不会"走"，把 20E 记在它头上纯属噪音
  if (!base.active) return base;

  const mark = readMark(u);
  const turn = ledgerTurn(s, u);
  const debt = Math.max(0, mark?.debt ?? 0);
  base.debt = debt;
  base.start = Math.max(0, max - debt);
  base.left = base.start;
  if (!mark || mark.turn !== turn) return base; // 还没开账：按满池显示
  base.settled = true;

  const items: ApSpend[] = [];
  // ① 机动（移动 / 上下船）：站位和开账时不一样就是走过
  const moved = u.x !== mark.x || u.y !== mark.y;
  const moveE = cost.move;
  if (moved) items.push({ action: 'move', label: AP_ACTION_NAME.move, e: moveE });

  // ② 技能：`skillTurn` 记的是"上一次放技能在哪个回合"
  const skilled = u.skillTurn === turn;
  if (skilled) items.push({ action: 'skill', label: AP_ACTION_NAME.skill, e: cost.skill });

  // ③ 攻击：先算这一回合允许几次，再由 attacksLeft 反推已经打了几次。
  //    `attacksLeft` 只在 doAttack 里第一次攻击时才会被赋值，所以
  //    "有值"就等于"打过至少一次"，这正好用来兜住引擎那记保底首击
  //    （允许 0 次时 attacksLeft 仍会被填成 1，于是这里记 1 次并透支出钱）。
  const budget = base.start - (moved ? moveE : 0) - (skilled ? cost.skill : 0);
  const allowed = Math.max(0, Math.floor(Math.max(0, budget) / cost.attack));
  const ceiling = Math.max(1, def?.burst ?? 1);
  const total = Math.min(ceiling, allowed);
  const used = u.attacksLeft === undefined ? 0 : Math.max(1, total - u.attacksLeft);
  base.attacksAllowed = total;
  if (used > 0) {
    items.push({ action: 'attack', label: AP_ACTION_NAME.attack, e: used * cost.attack });
  }

  const spent = items.reduce((n, it) => n + it.e, 0);
  base.items = items;
  base.spent = spent;
  base.over = Math.max(0, spent - base.start);
  base.left = Math.max(0, base.start - spent);
  return base;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、扩展本体
 * ══════════════════════════════════════════════════════════════════ */

export const ACTION_POINTS: Expansion = {
  id: 'action-points',
  name: '行动点',
  summary:
    '移动、攻击、上下船、释放技能统一成"行动"，每次从单位自己的行动点（E）里扣：' +
    `移动/上下船 ${AP_COST.move}E、攻击每段 ${AP_COST.attack}/段数 E、技能 ${AP_COST.skill}E；` +
    `池子按兵种分档：骑兵/车 ${AP_BY_TIER.mounted}、远程 ${AP_BY_TIER.ranged}、其余 ${AP_BY_TIER.base}。` +
    `E 不够就走不动、也打不出第二下；技能与保底那一击拦不住，会记成透支，下回合先扣回去。`,
  scale: 'small',

  hooks: {
    /**
     * 开账：把"这一回合从哪开始算"钉在单位身上。
     *
     * 两处都要：开局时先手方的第一回合不走 `onTurnStart`（那是"结束回合"时才触发的），
     * 不在 `onMatchStart` 里补一次，先手第一回合就永远读不到"走没走过"。
     */
    onMatchStart: ({ state }) => {
      for (const u of state.units) {
        if (u.owner !== state.current) continue;
        writeMark(u, { turn: state.turn, x: u.x, y: u.y, debt: 0, over: 0 });
      }
    },

    /**
     * 每方回合开始，重新开账。
     *
     * 上回合的 `over` 在这里变成 `debt`：透支只滚一回合，不滚雪球
     * （否则一次超支会让这支部队永远慢半拍，而玩家没有任何办法洗掉它）。
     */
    onTurnStart: ({ state, player }) => {
      for (const u of state.units) {
        if (u.owner !== player) continue;
        if (state.unitTypes[u.type]?.category === 'building') continue;
        const prev = readMark(u);
        writeMark(u, {
          turn: state.turn,
          x: u.x,
          y: u.y,
          debt: Math.max(0, prev?.over ?? 0),
          over: 0,
        });
      }
    },

    /**
     * 回合结束：结算这一回合的账，把透支记下来给下回合用。
     *
     * 这里读得到"刚结束的这一回合"的所有事实：`onTurnEnd` 排在
     * `resetUnitsFor` 之前，`moved / acted / attacksLeft` 都还在。
     * （`s.turn` 已经 +1 了，但 `ledgerTurn` 对"不是当前行动方"的单位
     *   自动回退一格，正好对上他们刚结束的那本账。）
     */
    onTurnEnd: ({ state, player, log }) => {
      for (const u of state.units) {
        if (u.owner !== player) continue;
        if (state.unitTypes[u.type]?.category === 'building') continue;
        const mark = readMark(u);
        if (!mark) continue;
        const L = apLedger(state, u);
        if (!L.settled) continue;
        writeMark(u, { ...mark, over: L.over });
        if (L.over > 0) {
          const name = state.unitTypes[u.type]?.name ?? u.type;
          log(player, `${name} 透支行动 ${L.over} E，下回合从行动点里先扣`);
        }
      }
    },

    /**
     * E 不够就走不动。
     *
     * `modifyMove` 返回 0 是引擎写明的口径（"这个回合动不了"，封冻的海军同款），
     * 所以这里不需要另造一套拦截。
     *
     * 注意：这一步只在**还没开账**（刚招出来）和**池子被透支掏空**时才会真的拦住。
     * 正常回合里移动总是第一个发生的行动，池子是满的——E 对"能不能动"的影响
     * 主要体现在透支之后，而不是每一次移动。
     */
    modifyMove: ({ state, unit, move }) => {
      if (move <= 0) return move;
      const L = apLedger(state, unit);
      if (!L.settled) return move;
      return L.left >= L.cost.move ? move : 0;
    },

    /**
     * 这一回合能有几次攻击，由 E 决定。
     *
     * 取 `min(引擎本来给几次, 池子买得起几次)`：`burst` 高的单位照样被 E 压回来，
     * 而池子富裕时不会凭空多给（多给就是在改 `burst` 的设计）。
     */
    modifyAttacks: ({ state, unit, attacks }) => {
      const L = apLedger(state, unit);
      if (!L.settled) return attacks;
      return Math.min(attacks, L.attacksAllowed);
    },

    /**
     * 面板上的三行。
     *
     * 引擎只负责把它们画出来（`getUnitPanelLines`），排版归 UI——
     * 扩展写数据，界面写样式，这条分工在 cultivation-packs 里已经用了一次。
     */
    getUnitPanelLines: ({ state, unit }) => {
      const L = apLedger(state, unit);
      if (!L.active) return [];
      const lines: string[] = [];

      const overNote = L.over > 0 ? `，已超支 ${L.over}` : '';
      const debtNote = L.debt > 0 ? `（上回合透支 ${L.debt}）` : '';
      lines.push(`行动点 ${L.left} / ${L.start} E${overNote}${debtNote}`);

      if (!L.settled) {
        lines.push('本回合还没开账（刚上场，轮到自己才开始算）');
      } else {
        lines.push(
          L.items.length > 0
            ? `本回合：${L.items.map((it) => `${it.label} −${it.e}`).join('、')}`
            : '本回合：什么都没做（不扣 E）',
        );
      }

      // 单价只在"有减免"时写出来：没有减免时它和规则书的默认值一样，纯占地方
      const clsName: Record<ApClass, string> = { mounted: '骑兵', vehicle: '车', melee: '近战' };
      const whoFor = (action: ApAction): string =>
        L.classes
          .filter((c) => (AP_CLASS_MOD[c] as Partial<Record<ApAction, number>>)[action])
          .map((c) => clsName[c])
          .join('·');
      const notes: string[] = [];
      if (L.cost.move !== AP_COST.move) notes.push(`机动 ${L.cost.move}E（${whoFor('move')}）`);
      if (L.cost.attack !== AP_COST.attack) {
        notes.push(`出手 ${L.cost.attack}E（${whoFor('attack')}）`);
      }
      if (L.settled && L.left < L.cost.move) notes.push('走不动了');
      if (L.settled && L.left < L.cost.attack) notes.push('不够再出手');
      if (notes.length > 0) lines.push(notes.join(' · '));
      return lines;
    },
  },
};
