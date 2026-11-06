/**
 * 战术分布探针：跑 N 局自对弈，统计每一回合"AI 倾向于哪种战术"。
 *
 * 为什么需要：A/B 只回答"强不强"，回答不了"它还会不会换打法"。玩家能感到的
 * 单调/摇摆，全在分布里——所以改完战术层要有一份可对比的分布，而不是重跑
 * 一堆胜率。
 *
 * 用法（在项目根跑）：
 *   node --experimental-strip-types scripts/probe-doctrine.ts --games 24 --era 1 --level advanced
 *   node --experimental-strip-types scripts/probe-doctrine.ts --ai ./baselines/ai-cef2888.ts
 *
 * `--ai` 换成冻结副本就能给出改动前后的对照：同一批种子、同一套统计口径。
 */

import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const GAMES = Number(argOf('games', '24'));
const ERA = Number(argOf('era', '1'));
const SEED = Number(argOf('seed', '900'));
const LEVEL = argOf('level', 'advanced');
const AI_FILE = argOf('ai', '../src/core/ai.ts');

interface AiModule {
  aiNextAction: (s: GameState, b?: unknown, skip?: Set<string>) => { type: string } | null;
  aiActiveMood: (s: GameState) => { lead: string; weight: Record<string, number>; drive: Record<string, number> };
  DEFAULT_BUDGET: unknown;
}

const mod = (await import(AI_FILE)) as unknown as AiModule;

const turns: number = 0;
const leads: Record<string, number> = { rush: 0, harass: 0, boom: 0, '': 0 };
const weightSum: Record<string, number> = { rush: 0, harass: 0, boom: 0 };
const driveOn: Record<string, number> = { rush: 0, harass: 0, boom: 0 };
let samples = 0;
let switches = 0;
let pairs = 0;
const abandoned = { yes: 0, no: 0 };

for (let g = 0; g < GAMES; g++) {
  const seed = SEED + g;
  let s = createMatch({ ...DEFAULT_CONFIG, startEra: ERA, aiLevel: LEVEL as never, aiOpponent: true, aiAlly: true }, seed);
  s.aiControl = { A: true, B: true };
  let last: string | null = null;
  for (let round = 0; round < 300 && !s.winner; round++) {
    for (const p of ['A', 'B'] as const) {
      s.current = p;
      const m = mod.aiActiveMood(s);
      const lead = m.lead || '';
      leads[lead] = (leads[lead] ?? 0) + 1;
      for (const d of ['rush', 'harass', 'boom'] as const) {
        weightSum[d] = (weightSum[d] ?? 0) + (m.weight[d] ?? 0);
        if ((m.drive[d] ?? 0) > 0.3) driveOn[d] = (driveOn[d] ?? 0) + 1;
      }
      if (last !== null) {
        pairs += 1;
        if (last !== lead) switches += 1;
      }
      last = lead;
      samples += 1;
      const ab = (m as unknown as { abandonedCityId?: string | null }).abandonedCityId;
      if (ab) abandoned.yes += 1;
      else abandoned.no += 1;

      for (let i = 0; i < 80; i++) {
        const a = mod.aiNextAction(s, mod.DEFAULT_BUDGET);
        if (!a) break;
        const r = applyAction(s, a as never);
        if (!r.ok) break;
        s = r.state;
      }
      const e = applyAction(s, { type: 'END_TURN' });
      if (!e.ok) break;
      s = e.state;
    }
  }
}

const pct = (n: number): string => `${((n / Math.max(1, samples)) * 100).toFixed(1)}%`;
console.log(`战术分布：${GAMES} 局 · 第 ${ERA} 代开局 · ${LEVEL} 档 · 每条 = 一个席位的回合开始`);
console.log(`样本 ${samples} 个回合（已忽略 ${turns} 个）`);
console.log(`主导战术   rush ${pct(leads.rush!)} · harass ${pct(leads.harass!)} · boom ${pct(leads.boom!)}`);
console.log(`平均权重   rush ${(weightSum.rush! / samples).toFixed(3)} · harass ${(weightSum.harass! / samples).toFixed(3)} · boom ${(weightSum.boom! / samples).toFixed(3)}`);
console.log(`drive>0.3  rush ${pct(driveOn.rush!)} · harass ${pct(driveOn.harass!)} · boom ${pct(driveOn.boom!)}`);
console.log(`换手率     ${((switches / Math.max(1, pairs)) * 100).toFixed(1)}%（相邻回合主战术变了的比例）`);
console.log(`弃城         ${pct(abandoned.yes)} 的回合挂着一座要放弃的城`);
