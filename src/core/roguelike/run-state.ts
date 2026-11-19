/**
 * 肉鸽一局（run）的状态与存档。
 *
 * 这里只放**数据与纯函数**：不碰 DOM、不碰 localStorage（存成字符串进出），
 * 这样能在 node 里直接单测。真正的落盘在 UI 层。
 */

/** 带进下一关的兵。HP 跨关保留（2026-11-19 定），城内回血已取消，靠整备关恢复。 */
export interface RosterUnit {
  /** 兵种 id（对应 UnitTypeDef.id） */
  type: string;
  /** 当前 HP：跨关保留，进战斗时原样写进 state.units */
  hp: number;
  /** 抽到这张卡时的等级（0 = 没升级） */
  cardLv: number;
}

/** 走过的一个节点。战斗关记关卡 id，整备关记 'rest'。 */
export interface StageRef {
  kind: 'battle' | 'rest';
  /** 战斗是关卡 id；整备关固定 'rest' */
  id: string;
  /** 这一关的种子：同一节点重开时用它，保证"重开的是同一局" */
  seed: number;
}

export interface RunState {
  /** 存档版本。结构变了就 +1，并在 parseRun 里写迁移 */
  v: 1;
  seed: number;
  gold: number;
  act: number;
  node: number;
  totalStages: number;
  roster: RosterUnit[];
  relics: string[];
  /** 兵种卡 id → 已抽到张数（3 张 = 1 级，见 cards.ts） */
  cards: Record<string, number>;
  path: StageRef[];
  /** 开局时选"是否允许重开本关"。false = 硬核 */
  allowRestart: boolean;
  restartsUsed: number;
  /** 城墙加固进度：累计 2 次才升一级（兵额 4 → 9） */
  wallProgress: number;
  /**
   * 城市时代（1~8）。**这是玩家花钱买来的成长**：整备关里可以升，
   * 升了之后高阶兵种卡更容易抽到、可上场的兵种更多（2026-11-19 定）。
   * 关卡不再写死时代，一律用这个值开局。
   */
  cityEra: number;
  /** 开局选的主分支（升级路线），决定卡池偏向 */
  branch: string;
  /** 战术卡背包（只放"下一关才生效"的那种，比如空投援军） */
  tactics: string[];
  /**
   * 城的血跨关保留（2026-11-19）。
   *
   * 之前每关 `createMatch` 都造一座满血新城，等于"城每关自动修满"，
   * 修城这个整备项就没有落点。现在把上一关结束时的城血带进下一关；
   * `null` 表示"这一关还没有记录"（第一关按满血开）。
   */
  cityHp: number | null;
  /** 整备里选了"修城"：下一关开局把城修满 */
  repairNext: boolean;
  /** 免费建造次数：每抽到一张兵种卡送一次，下一关造兵免单 */
  freeBuilds: number;
}

export const RUN_KEY = 'warchess:run:v1';

export interface NewRunOptions {
  allowRestart: boolean;
  totalStages?: number;
  /** 开局选的升级路线；不传就是步战 */
  branch?: string;
}

export function newRun(seed: number, opts: NewRunOptions): RunState {
  return {
    v: 1,
    seed,
    gold: 0,
    act: 1,
    node: 0,
    totalStages: opts.totalStages ?? 3,
    roster: [],
    relics: [],
    cards: {},
    path: [],
    allowRestart: opts.allowRestart,
    restartsUsed: 0,
    wallProgress: 0,
    cityEra: 1,
    branch: opts.branch ?? 'cold',
    tactics: [],
    cityHp: null,
    repairNext: false,
    freeBuilds: 0,
  };
}

export function serializeRun(run: RunState): string {
  return JSON.stringify(run);
}

/**
 * 读档。只认当前版本；不认识的版本返回 null（宁可让玩家重开，也不要带着
 * 半懂的结构跑下去——那会变成"数据看着在、其实全错"的 bug）。
 */
export function parseRun(raw: string | null): RunState | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<RunState>;
    if (!obj || obj.v !== 1) return null;
    if (typeof obj.seed !== 'number' || !Array.isArray(obj.roster)) return null;
    return {
      ...newRun(obj.seed, { allowRestart: obj.allowRestart === true, totalStages: obj.totalStages }),
      ...obj,
      // 老存档没有这个字段：当成青铜时代（第一幕的默认值）
      cityEra: typeof obj.cityEra === 'number' && obj.cityEra >= 1 ? obj.cityEra : 1,
      branch: typeof obj.branch === 'string' ? obj.branch : 'cold',
      tactics: Array.isArray(obj.tactics) ? (obj.tactics as string[]) : [],
      /*
       * 城血只可能是"几十到几百"这个量级：旧版本叠乘过翻倍，
       * 存档里出现过 4.5e24。超过 10000 一律当作脏数据丢掉（= 满血重开）。
       */
      cityHp:
        typeof obj.cityHp === 'number' && Number.isFinite(obj.cityHp) && obj.cityHp > 0 && obj.cityHp < 10000
          ? obj.cityHp
          : null,
      repairNext: obj.repairNext === true,
      freeBuilds: typeof obj.freeBuilds === 'number' ? obj.freeBuilds : 0,
      v: 1,
    } as RunState;
  } catch {
    return null;
  }
}

/** 这一局还能不能再开本关（重开次数由开局的 allowRestart 决定，次数不限） */
export function canRestart(run: RunState): boolean {
  return run.allowRestart;
}
