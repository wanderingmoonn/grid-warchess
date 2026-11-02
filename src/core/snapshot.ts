/**
 * 局面快照：对局打到一半，把"现在这盘棋"整个拍下来，用来报 bug。
 *
 * 和 `report.ts` 的终局报告是两件东西，别混：
 *
 *   · 报告 —— 打完之后，**匿名**的平衡数据（不带名字、不带坐标、不带流水），
 *     目的是回答"哪个兵种偏强""AI 行不行"；
 *   · 快照 —— 任何时刻，**可复现**的完整局面（带名字、带坐标、带最近日志），
 *     目的是回答"这一手为什么打成了这样"。
 *
 * 所以这里不做字段裁剪：找 bug 时最想知道的就是"哪个兵站在哪、刚才发生了什么"，
 * 裁掉这些等于把唯一的线索扔掉。同理，快照走的是**单独一张表**，不和匿名报告
 * 混在一起——混了之后，"匿名数据"这句话就不成立了。
 *
 * 好消息是这里面的 `state` 就是一个完整的存档对象，和「导出对局」里那份同构：
 * 收到快照的人把 JSON 存下来，用「导入对局」粘进去（`importMatch` 认得
 * `kind: 'snapshot'`），就原地站在报 bug 的那一格上，不用自己拼局面。
 */

import { BUILD_VERSION } from './build-info.ts';
import { seatsOf, type GameState, type MatchConfig, type PlayerId } from './types.ts';
import type { MatchTimeline } from './timeline.ts';

/** 快照格式版本。字段含义变了就动它，加字段不必 */
export const SNAPSHOT_VERSION = 1;

/**
 * 玩家勾「上传」时同意的那份说明的版本。
 *
 * 和 SNAPSHOT_VERSION 分开：那个说的是数据结构，这个说的是**告知与授权**。
 * 这份快照含玩家名与坐标，和匿名报告是两套口径，必须能各自说清"他当时同意的是什么"。
 * 形状跟着数据库的 CHECK：YYYY-MM-DD.vN。
 */
export const SNAPSHOT_CONSENT_VERSION = '2026-11-02.v1';

/** 默认带多少条日志。找 bug 看"刚才这十几手"就够，整本日志反而吵 */
const DEFAULT_LOG_LINES = 60;

export interface SnapshotEnv {
  /** 浏览器 UA —— 渲染错位、按键失效这类问题，第一个要问的就是它 */
  ua: string;
  lang: string;
  tz: string;
  w: number;
  h: number;
  dpr: number;
}

export interface BugSnapshot {
  v: number;
  at: string;
  /** 游戏版本：拿到快照第一件事是"这条是哪个版本报的" */
  build: string;
  /** 玩家自己写的一句话，可以为空 */
  note: string;
  kind: 'snapshot';
  seed: number;
  turns: number;
  playerCount: number;
  current: PlayerId;
  winner: PlayerId | null;
  /** 一行摘要，给列表/工单标题用：第 37 回合 · 20×20 · 红方 vs 蓝方 */
  headline: string;
  config: MatchConfig;
  /**
   * 报 bug 那一格上的完整局面。
   *
   * 和「导出对局」里的 `state` 同构，所以 `importMatch` 直接能吃：
   * 修 bug 的人不用猜怎么复现，粘进「导入对局」就站在同一格上。
   */
  state: GameState;
  /**
   * 最近若干条战报，一行一条：`T37 红方 建造了 步兵`。
   *
   * 这里是**摊平过的文本**，不是 `state.log` 的引用：结构化那份在 `state` 里
   * 一份不少，这里的用途是让人打开 JSON 就能顺着读"刚才这十几手"，
   * 不用先写个脚本去解析对象。
   */
  log: string[];
  /** 逐回合摘要：只在开局勾了「记录详细数据」时存在 */
  timeline?: MatchTimeline;
  env?: SnapshotEnv;
}

/** 一句话摘要：谁跟谁、打到第几回合、多大的图 */
export function snapshotHeadline(s: GameState): string {
  const seats = seatsOf(s);
  const names = seats.map((p) => s.players[p]?.name ?? p).join(' vs ');
  const who = seats.length > 2 ? `${seats.length} 家` : names;
  const now = s.players[s.current]?.name ?? s.current;
  return `第 ${s.turn} 回合 · ${s.w}×${s.h} · ${who} · 当前 ${now}`;
}

/**
 * 拍一张快照。
 *
 * `now` / `env` 都从外面传：这样规则测试能钉死时间与环境，断言"同一份局面
 * 拍两次得到完全一样的快照"。生产代码传当前时间与 `navigator` 那几项。
 */
export function buildSnapshot(
  s: GameState,
  opts: { note?: string; timeline?: MatchTimeline | null; env?: SnapshotEnv; now?: Date; logLines?: number } = {},
): BugSnapshot {
  const now = opts.now ?? new Date();
  const seats = seatsOf(s);
  const take = Math.max(0, opts.logLines ?? DEFAULT_LOG_LINES);
  return {
    v: SNAPSHOT_VERSION,
    at: now.toISOString(),
    build: BUILD_VERSION,
    note: (opts.note ?? '').trim().slice(0, 500),
    kind: 'snapshot',
    seed: s.seed,
    turns: s.turn,
    playerCount: seats.length,
    current: s.current,
    winner: s.winner,
    headline: snapshotHeadline(s),
    // config 单独抄一份：state.config 是"这一局怎么开的"，界面上的报错常常
    // 就出在这个对象的某个开关上（比如"勾了选卡却没进 BP"）。
    config: { ...s.config },
    state: s,
    // 摊平成文本：日志里已经写了"谁干了什么"，再套一层 {turn,player,text}
    // 只是把"读"变成"解"。想按字段筛的时候用 state.log。
    log: s.log.slice(-take).map((e) => `T${e.turn} ${e.player} ${e.text}`),
    ...(opts.timeline ? { timeline: opts.timeline } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  };
}

/**
 * 去重键：同一局同一回合、同一句描述，一分钟内重复点算同一条。
 *
 * 不按"内容哈希"去重：玩家很可能连点两次想传两份不同时刻的心得，
 * 而**完全相同**的重复（手滑、网络卡了又点）才值得合并。
 */
export function snapshotSignature(snap: BugSnapshot): string {
  const minute = snap.at.slice(0, 16); // YYYY-MM-DDTHH:MM
  return `${snap.seed}:${snap.turns}:${minute}:${snap.note}`.slice(0, 300);
}

/** 复制/下载用的正文 */
export function snapshotJson(snap: BugSnapshot): string {
  return JSON.stringify(snap, null, 2);
}

/**
 * 下载文件名：同样只留 ASCII。
 *
 * 前缀用 `bug-` 而不是 `warchess-`：这份东西是给修 bug 的人看的，
 * 落在下载夹里要和"导出对局"分得开。
 */
export function snapshotFileName(snap: BugSnapshot): string {
  const stamp = snap.at.slice(0, 16).replace(/[:T]/g, '');
  return `bug-${stamp}-${snap.seed}-t${snap.turns}.json`.replace(/[^\w.-]/g, '');
}
