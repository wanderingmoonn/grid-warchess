/**
 * 对局复盘：把一份**报告文件**（就是"结束后上传"那个 JSON）还原成可逐帧翻看的对局。
 *
 * ── 为什么能还原 ────────────────────────────────────────────────────────
 *
 * 引擎是确定性的：`createMatch(config, seed)` 用种子生成地图、落城、发初始兵，
 * 之后每一步都是 `applyAction(s, a)` 的纯函数。所以只要凑齐三样东西，
 * 就能把一局原样走一遍：
 *
 *   1. **开局的全部参数**（`config` + `seed`）；
 *   2. **动作序列**（报告里的 `actions`，v3 起才有）；
 *   3. 同一版本的规则代码。
 *
 * 第 3 条不由我们控制——版本升级后老报告可能走不通。这个模块的态度是
 * **走不通就说清楚走在哪一步、为什么**，绝不"尽力而为地糊过去"：
 * 一份看起来能放、实际第 37 步就悄悄歪掉的复盘，比一个明确的报错坏得多。
 *
 * ── 老报告（没有 config 字段）怎么办 ────────────────────────────────────
 *
 * 报告里本来就有 `seed / board / startEra / playerCount / expansions`，
 * 足够重建**绝大多数**对局：地图、城、开局兵都是种子决定的，兵种池按"全开"补。
 * 重不出来的只有两种：选卡模式（池子是当场 BP 出来的）和自定义兵种（只在本机）。
 * 这两种会带上一条 `warning`，并在文件名旁边显示——**不能让玩家以为它是准的**。
 */
import { applyAction } from './rules.ts';
import { createMatch } from './setup.ts';
import { UNIT_TYPES } from './config.ts';
import type { Action, GameState, MatchConfig, PlayerId } from './types.ts';

/** 报告里要用到的那些字段。刻意宽松：老版本、缺字段都要能读进来 */
export interface ReplayReport {
  v?: number;
  at?: string;
  build?: string;
  seed?: number;
  board?: { w?: number; h?: number };
  startEra?: number;
  playerCount?: number;
  expansions?: string[];
  ai?: { level?: string };
  winner?: PlayerId | null;
  turns?: number;
  actions?: Action[];
  actionsDropped?: number;
  config?: MatchConfig;
  fog?: boolean;
}

export interface ReplayMeta {
  seed: number;
  size: number;
  startEra: number;
  players: number;
  expansions: string[];
  expansionsText: string;
  /** 报告生成时的构建版本（老报告没有就是空串） */
  build: string;
  at: string;
  /** 报告里声明的终局方；null = 和棋或超时 */
  declaredWinner: PlayerId | null;
  /** 报告里声明的总行动数 */
  declaredTurns: number;
  /** 报告里声明的动作总数 */
  actionCount: number;
  /** 有没有 config：没有就是"重建"，不是"还原" */
  exact: boolean;
  actionsDropped: number;
}

export interface ReplaySession {
  meta: ReplayMeta;
  actions: Action[];
  /** 真的被引擎接受的动作数。小于 actions.length 就是中途对不上了 */
  applied: number;
  /** 对不上的原因（null = 全走通了） */
  stopReason: string | null;
  /** 需要提醒玩家的事情（重建、截断、终局不一致…） */
  warnings: string[];
  /** 第 i 步之后的状态；0 = 开局 */
  stateAt(index: number): GameState;
  /** 最后能走到的状态 */
  readonly finalState: GameState;
  /** 终局胜方与报告是否一致；null = 没法比 */
  finalMatches: boolean | null;
}

export type ReplayBuild =
  | { ok: true; session: ReplaySession }
  | { ok: false; reason: string };

/** 每隔这么多步留一个完整状态：往回拖的时候不必从第 0 步重算 */
const KEYFRAME_EVERY = 24;

/**
 * 解析文本 → 报告对象。
 *
 * 单独拎出来是为了把"这不是 JSON"和"这是 JSON 但不是对局报告"两句区分开——
 * 玩家拖进来的十有八九是别的东西（截图、存档、装错的压缩包），
 * 一句"文件读不了"帮不上任何忙。
 */
export function parseReplayFile(text: string): { ok: true; report: ReplayReport } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '这个文件不是 JSON。复盘的输入是「结束后上传」的那份对局数据（一个 .json 文件）。' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '文件内容不是一份对局报告（应该是一个 JSON 对象）。' };
  }
  const r = raw as ReplayReport;
  if (typeof r.seed !== 'number' || !Number.isFinite(r.seed)) {
    return { ok: false, reason: '这份数据里没有开局种子，重建不出地图。' };
  }
  if (!Array.isArray(r.actions) || r.actions.length === 0) {
    return {
      ok: false,
      // 三种来源都会走到这里，一句"没有动作"没法让人知道下一步该做什么，所以把三种都写出来：
      // 没勾开关、老版本、别的东西。玩家自己那份文件属于哪一种，他一对照就知道。
      reason:
        '这份数据里没有动作序列，没法逐帧复盘。原因通常是下面之一：' +
        '开局时没勾「结束后上传详细数据」（下一局勾上，结算卡下载的 .json 就能复盘）；' +
        '或者这是 2026-11-04 之前导出的老数据。',
    };
  }
  return { ok: true, report: r };
}

/** 从报告里凑一份能开局的配置。有 `config` 就直接用，没有就按报告里的字段补 */
function configOf(r: ReplayReport): { config: MatchConfig; exact: boolean; warns: string[] } {
  const warns: string[] = [];
  const size = Math.max(6, Math.round(r.board?.w ?? r.config?.size ?? 12));
  const startEra = Math.round(r.startEra ?? r.config?.startEra ?? 1);
  const playerCount = Math.min(4, Math.max(2, Math.round(r.playerCount ?? r.config?.playerCount ?? 2))) as 2 | 3 | 4;
  const expansions = r.expansions ?? r.config?.expansionIds ?? [];

  if (r.config) {
    // 新报告：原样用它。这里也要覆盖 size/startEra —— 报告顶层的这几个字段是
    // 从同一个 config 抄出来的，两边不一致说明文件被改过，以 config 为准。
    return {
      config: { ...r.config, size: r.config.size || size, startEra: r.config.startEra ?? startEra, playerCount },
      exact: true,
      warns,
    };
  }

  // 老报告：只能按"原版全军 + 报告的扩展"重建
  const config: MatchConfig = {
    size,
    startEra,
    playerCount,
    aiOpponent: r.ai ? false : false,
    aiAlly: false,
    expansionIds: [...expansions],
    enabledUnits: Object.keys(UNIT_TYPES),
  };
  warns.push('这份数据是旧格式（没存开局参数），地图和兵力按种子重建，可能和当时不完全一致。');
  return { config, exact: false, warns };
}

/**
 * 报告 → 会话。
 *
 * 会把动作序列**完整走一遍**（这是唯一能知道"走到第几步对不上"的办法），
 * 途中只留每 `KEYFRAME_EVERY` 步一份完整状态，其余现算。
 */
export function buildReplay(report: ReplayReport): ReplayBuild {
  const actions = report.actions ?? [];
  if (actions.length === 0) return { ok: false, reason: '这份数据里没有动作序列。' };

  const { config, exact, warns } = configOf(report);

  let initial: GameState;
  try {
    initial = createMatch(config, report.seed as number);
  } catch (err) {
    return { ok: false, reason: `按这份参数开不出局（${(err as Error).message}）。可能是自定义兵种或选卡模式的对局。` };
  }
  if (report.board?.w && initial.w !== report.board.w) {
    warns.push(`报告里是 ${report.board.w}×${report.board.h}，重建出来是 ${initial.w}×${initial.h}——参数和当时不完全一样。`);
  }
  if (config.draftMode) {
    warns.push('这是一局选卡对局：当时的禁用/选用名单没存在报告里，兵种池可能对不上。');
  }
  /*
   * 迷雾要照报告还原，不能只靠 `createMatch` 的默认值。
   *
   * 报告 v3 起记了 `fog`，而 `createMatch` 的默认是**开**（`fogDefault: true`）。
   * 于是"关雾打的那一局"被复盘成"开雾"：隐身 / 潜行那几条判定只认 `s.fog`，
   * 一旦这局里有这类单位，同一串动作会在复盘里走出不一样的结果——
   * 表现是莫名其妙地"第 N 步走不下去"，而真正的原因是开局参数被换掉了。
   * 训练口径的对局全是 `fog = false`（见 scripts/rl/play.ts），正好踩在这上面。
   *
   * 老报告没有这个字段：保持 `createMatch` 的默认（＝开），和当年一致。
   */
  if (typeof report.fog === 'boolean' && initial.fog !== report.fog) {
    initial = { ...initial, fog: report.fog };
  }
  if ((report.actionsDropped ?? 0) > 0) {
    warns.push(`原始日志超过上限，丢了 ${report.actionsDropped} 步——复盘会停在能走到的地方。`);
  }

  // 关键帧 + 一个"游标"：播放前进时不必从第 0 步重算
  const keys: GameState[] = [initial];
  let cursorIndex = 0;
  let cursorState = initial;

  let applied = 0;
  let stopReason: string | null = null;
  let s = initial;
  for (let i = 0; i < actions.length; i++) {
    const r = applyAction(s, actions[i] as Action);
    if (!r.ok) {
      stopReason = `第 ${i + 1} 步走不下去：${r.reason}（动作 ${actions[i]?.type ?? '?'}）`;
      break;
    }
    s = r.state;
    applied += 1;
    if (applied % KEYFRAME_EVERY === 0) keys.push(s);
  }
  const finalState = s;

  if (stopReason) warns.push(stopReason);

  const finalMatches =
    report.winner === undefined ? null : (finalState.winner ?? null) === (report.winner ?? null);
  if (finalMatches === false && !stopReason) {
    warns.push(`走完了 ${applied} 步，但终局和报告对不上（报告说 ${report.winner ?? '平局'}）。`);
  }

  const stateAt = (index: number): GameState => {
    const target = Math.max(0, Math.min(applied, Math.round(index)));
    if (target < cursorIndex) {
      // 往回跳：从"不超过目标"的最近一个关键帧重新走。往回拖滑块是复盘的高频动作，
      // 所以这一段必须是"最多走 KEYFRAME_EVERY 步"，而不是从第 0 步重来。
      const k = Math.min(Math.floor(target / KEYFRAME_EVERY), keys.length - 1);
      cursorIndex = k * KEYFRAME_EVERY;
      cursorState = keys[k] ?? initial;
    }
    while (cursorIndex < target) {
      const r = applyAction(cursorState, actions[cursorIndex] as Action);
      // 构建期已经全走通过了，这里不该失败；真失败就停在原地，不要假装前进了
      if (!r.ok) break;
      cursorState = r.state;
      cursorIndex += 1;
    }
    return cursorState;
  };

  return {
    ok: true,
    session: {
      meta: {
        seed: report.seed as number,
        size: initial.w,
        startEra: config.startEra,
        players: config.playerCount ?? 2,
        expansions: [...config.expansionIds],
        expansionsText: config.expansionIds.length > 0 ? config.expansionIds.join(' + ') : '原版',
        build: report.build ?? '',
        at: report.at ?? '',
        declaredWinner: report.winner ?? null,
        declaredTurns: report.turns ?? 0,
        actionCount: actions.length,
        exact,
        actionsDropped: report.actionsDropped ?? 0,
      },
      actions,
      applied,
      stopReason,
      warnings: warns,
      stateAt,
      finalState,
      finalMatches,
    },
  };
}

/** 从原始文本一步到位（界面用的就是它） */
export function buildReplayFromText(text: string): ReplayBuild {
  const parsed = parseReplayFile(text);
  if (!parsed.ok) return parsed;
  return buildReplay(parsed.report);
}
