/**
 * 对局报告：一局打完时，把"能用来调平衡的东西"抽出来。
 *
 * 这份东西存在的理由很直白：AI 强不强、哪个兵种偏贵、哪套扩展一开就一边倒，
 * 靠自己和朋友打那几十局是看不出来的。但**收数据不能顺手把人也收了**——
 * 所以这里刻意见字段：只留"这一局长什么样"，不留"这一局是谁在打"。
 *
 * 有意不带的（不是忘了）：
 *   · 玩家名（`players[p].name`）——一个昵称就够把人认出来了；
 *   · 房间码、席位令牌——那是这局对外的钥匙；
 *   · 每一步的操作流水——带时间戳的流水等于作息表；
 *   · 自定义兵种的说明文字——玩家自己写的，什么都有可能。
 *
 * 报告本身是纯函数产物，不联网、不读 localStorage，所以规则测试能直接断言
 * "里面不许出现某个名字"。真发不发，由界面那边问玩家。
 */

import { underConstruction } from './rules.ts';
import { timelineSummary, type MatchTimeline } from './timeline.ts';
import type { GameState, PlayerId } from './types.ts';

/** 报告格式版本。加字段不一定动它，改语义一定要动 */
export const REPORT_VERSION = 1;

/**
 * 玩家点"上传"时同意的那份说明的版本。
 *
 * 和 REPORT_VERSION 是两码事：那个说的是**数据结构**变没变，这个说的是
 * **告知与授权**变没变。改一句"可能用于训练模型"，就必须换一个版本号——
 * 否则事后无法说清"这条数据是他按哪一版说明同意的"。
 * 形状跟着数据库的 CHECK：YYYY-MM-DD.vN。
 */
export const REPORT_CONSENT_VERSION = '2026-10-28.v1';

export interface ReportSide {
  /** 只写 A/B，不写名字 */
  side: PlayerId;
  cities: number;
  /** 非建筑单位数（兵） */
  units: number;
  buildings: number;
  /** 兵种 id -> 终局存活数。平衡分析真正要看的就是这个东西 */
  roster: Record<string, number>;
  gold: number;
  /** 金币以外的资源，按 id 记 */
  res: Record<string, number>;
  /** 各城时代，从高到低 */
  eras: number[];
  /** 终局总血量：一万个残血兵和一队满血兵是两回事 */
  hp: number;
}

export interface MatchReport {
  v: number;
  /** 生成时间（ISO）。只用来判断"这批数据是不是同一波版本打的" */
  at: string;
  seed: number;
  board: { w: number; h: number; terrain: Record<string, number> };
  startEra: number;
  expansions: string[];
  /** 兵种表的规模：装了几套自定义兵种，两批数据就没法直接比 */
  packSize: number;
  ai: { opponent: boolean; ally: boolean; level: string; commander: boolean; godMode: boolean };
  /** 打了多少次行动（不是"回合数"，一步一步数才对得上） */
  turns: number;
  winner: PlayerId | null;
  /** 终局还有几处工地：建造点数有没有拖慢节奏，看这个 */
  sites: number;
  logLines: number;
  sides: ReportSide[];
  /**
   * 逐回合摘要 + 行动/出兵计数。
   *
   * 只有开局勾了「结束后上传详细数据」的局才有；没勾就是 undefined——
   * 报告里少一块，不影响其余字段的可比性（version 一样就能比）。
   */
  timeline?: MatchTimeline;
}

function countTerrain(s: GameState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of s.tiles) out[t.terrain] = (out[t.terrain] ?? 0) + 1;
  return out;
}

/**
 * 生成报告。
 *
 * `now` 可以传进来，测试里钉死时间才能比两次产物一样不一样；
 * 生产代码不传，用当前时间。
 */
export function buildMatchReport(
  s: GameState,
  now: Date = new Date(),
  timeline?: MatchTimeline | null,
): MatchReport {
  const sides: ReportSide[] = (['A', 'B'] as PlayerId[]).map((side) => {
    const mine = s.units.filter((u) => u.owner === side);
    const roster: Record<string, number> = {};
    let buildings = 0;
    let hp = 0;
    for (const u of mine) {
      const def = s.unitTypes[u.type];
      if (def?.category === 'building') buildings += 1;
      else roster[u.type] = (roster[u.type] ?? 0) + 1;
      hp += Math.max(0, u.hp);
    }

    const cities = s.cities.filter((c) => c.owner === side);
    const res: Record<string, number> = {};
    for (const [id, n] of Object.entries(s.players[side].res ?? {})) {
      if (typeof n === 'number') res[id] = n;
    }

    return {
      side,
      cities: cities.length,
      units: mine.length - buildings,
      buildings,
      roster,
      gold: s.players[side].gold,
      res,
      eras: cities.map((c) => c.era).sort((a, b) => b - a),
      hp,
    };
  });

  return {
    v: REPORT_VERSION,
    at: now.toISOString(),
    seed: s.seed,
    board: { w: s.w, h: s.h, terrain: countTerrain(s) },
    startEra: s.config.startEra,
    expansions: [...s.config.expansionIds],
    packSize: Object.keys(s.unitTypes).length,
    ai: {
      opponent: s.config.aiOpponent === true,
      ally: s.config.aiAlly === true,
      level: s.config.aiLevel ?? 'advanced',
      commander: s.config.commanderMode === true,
      godMode: s.config.godMode === true,
    },
    turns: s.turn,
    winner: s.winner,
    sites: s.units.filter((u) => underConstruction(u)).length,
    logLines: s.log.length,
    sides,
    ...(timeline ? { timeline } : {}),
  } satisfies MatchReport;
}

/** 给一局已经打过的对局做个指纹：用来判断"这局是不是已经传过了" */
export function reportSignature(r: MatchReport): string {
  const tally = r.sides.map((x) => `${x.cities}-${x.units}-${x.hp}`).join('_');
  // 有没有逐回合摘要进指纹：同一局"详细版"和"精简版"是两份不同的东西，
  // 先传了精简版再传详细版不该被当成重复。
  const detail = r.timeline ? `+t${r.timeline.samples.length}` : '';
  return `${r.seed}:${r.turns}:${r.winner ?? '-'}:${tally}${detail}`;
}

/** 报告里那句"含多少逐回合数据"，给界面和日志用 */
export function reportDetailLine(r: MatchReport): string {
  return timelineSummary(r.timeline);
}

/**
 * 要发出去的正文。
 *
 * 缩进两格：玩家点「复制报告」时是能直接看懂的，
 * 而不是一坨压缩过的花括号——**能看，才谈得上同意**。
 */
export function reportJson(r: MatchReport): string {
  return JSON.stringify(r, null, 2);
}

/**
 * 下载用的文件名：只留 ASCII 字母数字和短横。
 *
 * 中文文件名在浏览器里没问题，但一进命令行、一进压缩包、一转手到别的系统
 * 就变成一串问号——而这份报告本来就是拿来发给别人的。
 */
export function reportFileName(r: MatchReport): string {
  const stamp = r.at.slice(0, 10);
  const who = r.winner ? r.winner.toLowerCase() : 'draw';
  return `warchess-${stamp}-${r.seed}-${who}.json`.replace(/[^\w.-]/g, '');
}
