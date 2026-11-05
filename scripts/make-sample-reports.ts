/**
 * 造一份"样本报告"，用来验证复盘脚本的管道（不是分析工具）。
 *
 * 为什么要它：真实对局数据要从云端导，导出来之前谁也不知道字段对不对得上。
 * 与其等导完了发现解析器读不进去，不如先用引擎自己跑两局、按**生产代码同一条路径**
 * 生成报告（`buildMatchReport` + `MatchTimeline`），把 JSON / CSV 两条读法都验一遍。
 *
 * 用法：
 *   node --experimental-strip-types scripts/make-sample-reports.ts
 * 产出：
 *   reports-sample.json   数组，每条是一个 payload
 *   reports-sample.csv    只有一列 payload（模拟 Supabase 的 Export → CSV）
 */
import { writeFileSync } from 'node:fs';

import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import { buildMatchReport } from '../src/core/report.ts';
import { newTimeline, noteAction, noteDeaths, sampleTurn, sealTimeline } from '../src/core/timeline.ts';
import type { GameState } from '../src/core/types.ts';

/** 一局：两边都交给 AI，边打边记时间线——和 `main.ts` 的调用顺序一模一样 */
function playOne(seed: number): ReturnType<typeof buildMatchReport> {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 2, aiOpponent: true, aiAlly: true, aiLevel: 'tactic' },
    seed,
  );
  const tl = newTimeline(s.turn);
  const log: Parameters<typeof buildMatchReport>[3] = [];
  noteDeaths(tl, s);
  sampleTurn(s, tl, true);

  while (!s.winner && s.turn <= 120) {
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i += 1) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET });
      if (!a) break;
      noteAction(tl, s.current, a);
      log!.push(a);
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      noteDeaths(tl, s, a);
      sampleTurn(s, tl);
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    log!.push({ type: 'END_TURN' });
    s = e.state;
  }
  sampleTurn(s, tl, true);
  return buildMatchReport(s, new Date('2026-11-04T02:00:00Z'), sealTimeline(tl), log);
}

const reports = [playOne(900), playOne(901)];
writeFileSync('reports-sample.json', JSON.stringify(reports, null, 2));

/** CSV 的引号要翻倍，和 Supabase 导出的一致 */
const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;
const csv = ['payload', ...reports.map((r) => cell(JSON.stringify(r)))].join('\n');
writeFileSync('reports-sample.csv', csv);

for (const r of reports) {
  console.log(
    `seed=${r.seed} 回合 ${r.turns} 胜者 ${r.winner ?? '平'}`
      + `　造兵 ${Object.values(r.timeline?.made ?? {}).reduce((n, bag) => n + Object.values(bag).reduce((a, b) => a + b, 0), 0)}`,
  );
}
console.log('已写出 reports-sample.json / reports-sample.csv');
