/**
 * 决战判决探针：打印一局里"该打还是该等"的变化序列。
 *
 * 为什么要有它：`aiCalls` 只在**结论变化**时记一条，光看回放的 HUD
 * 看不出"它当时算出来的比值是多少、还差几回合"。这个脚本把每一判决点
 * 摊平成一行，用来判断"这次输是不是因为判早了/判晚了"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-decisive.ts --size 16 --era 3 --seed 31 --side A
 *   … --old        # 用 `baselines/ai-decisive-before.ts`（07a2742）当对照
 *
 * `--side` 是打印哪一席的判决（默认 A）。`--old` 只影响这一局的执行者，
 * 用来对比"同一颗种子、不同口径"的判决序列。
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const size = Number(argOf('size', '12'));
const era = Number(argOf('era', '2'));
const seed = Number(argOf('seed', '32'));
const side = argOf('side', 'A') as PlayerId;
const useOld = process.argv.includes('--old');
const cap = Number(argOf('cap', '260'));

const mod = await import(useOld ? './baselines/ai-decisive-before.ts' : '../src/core/ai-v3.ts');
const ai = mod.aiNextAction;

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, startEra: era, aiLevel: 'tactic', size, mapSymmetry: 'fair' },
  seed,
);
while (!s.winner && s.turn <= cap) {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = ai(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
      rejected.add(aiActionKey(a));
      continue;
    }
    rejected.clear();
    s = r.state;
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
  }
  if (s.winner) break;
  const r = applyAction(s, { type: 'END_TURN' });
  if (!r.ok) break;
  s = r.state;
}

console.log(`winner=${s.winner} turn=${s.turn} 版本=${useOld ? '旧(07a2742)' : '当前'}`);
// 计划当值统计：验"某条计划有没有真的被用上"（一条写坏的计划 = 和没装一样）
const keepScout = (s.aiFocus?.[side]?.plan?.keep as { scout?: { unitId?: string | null } } | undefined)
  ?.scout;
if (keepScout?.unitId) console.log(`侦查任务：unitId=${keepScout.unitId}`);
const planCount = new Map<string, number>();
for (const t of s.aiPlanTrace ?? []) {
  if (t.me !== side) continue;
  planCount.set(t.plan ?? '无', (planCount.get(t.plan ?? '无') ?? 0) + 1);
}
if (planCount.size > 0) {
  console.log(
    '计划当值：' +
      [...planCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}×${v}`)
        .join(' · '),
  );
}
for (const c of (s.aiCalls ?? []).filter((x) => x.me === side)) {
  console.log(
    `T${String(c.turn).padStart(3)} ${c.call.padEnd(7)} 行军${String(c.marchTurns).padStart(2)} ` +
      `我${String(Math.round(c.myPower)).padStart(4)} 敌${String(Math.round(c.foePower)).padStart(4)} ` +
      `产能${Math.round(c.myPerTurn)}/${Math.round(c.foePerTurn)} | ${c.why}`,
  );
}
