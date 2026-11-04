/**
 * 结构改动的 KPI 探针：**不看胜负，看机制有没有按预期变**。
 *
 * 为什么需要它：这一整天六次干预在胜率上全是中性（46~50%），可胜率是个很钝的尺子——
 * 它分不清"改动没生效"和"生效了但对手也差不多"。而结构改动有明确的机制预期，
 * 可以直接量：经济单位挨打的比例该降、阵亡÷造兵该降。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-economy.ts 6            # 当前代码
 *   node --experimental-strip-types scripts/probe-economy.ts 6 --old      # 冻结基线对照
 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import { newTimeline, noteAction, noteDeaths, sampleTurn, sealTimeline } from '../src/core/timeline.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const GAMES = Number(args[0] ?? 6);
const USE_OLD = args.includes('--old');
/**
 * `--raid`：A 席放"抢经济脚本"，B 席才是被测的 AI。
 *
 * 为什么要它：两个 AI 都不打对方工人（自对弈里经济单位只吃 5.9% 伤害，
 * 而真实人机对局是 30%）——所以"护经济"这条改动在 AI 打 AI 里没有对手可防。
 * 换成一个专门杀工人的对手，才能量出"经济单位挨打的比例有没有降"。
 */
const USE_RAID = args.includes('--raid');
const OLD_AI_FILE = './baselines/ai-87b9829.ts';

const oldMod = USE_OLD
  ? ((await import(OLD_AI_FILE)) as { aiNextAction: typeof aiNextAction })
  : null;
const next = oldMod ? oldMod.aiNextAction : aiNextAction;
const raid = USE_RAID
  ? ((await import('./script-raid.ts')) as { raidNextAction: typeof aiNextAction }).raidNextAction
  : null;

let econTaken = 0;
let allTaken = 0;
let econDeaths = 0;
let made = 0;
let lost = 0;

for (let g = 0; g < GAMES; g += 1) {
  let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 3, aiOpponent: true, aiAlly: true, aiLevel: 'advanced' }, 900 + g);
  const tl = newTimeline(s.turn);
  noteDeaths(tl, s);
  sampleTurn(s, tl, true);
  while (!s.winner && s.turn <= 120) {
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i += 1) {
      const a = raid && s.current === 'A' ? raid(s, { ...DEFAULT_BUDGET }) : next(s, { ...DEFAULT_BUDGET });
      if (!a) break;
      noteAction(tl, s.current, a);
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      noteDeaths(tl, s, a);
      sampleTurn(s, tl);
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  const sealed = sealTimeline(tl);
  const sides: PlayerId[] = raid ? ['B'] : ['A', 'B'];
  for (const side of sides) {
    const taken = sealed.takenByType[side] ?? {};
    for (const [type, dmg] of Object.entries(taken)) {
      const def = s.unitTypes[type];
      allTaken += dmg;
      if (def && def.category === 'economy') econTaken += dmg;
    }
    for (const [type, n] of Object.entries(sealed.lostByType[side] ?? {})) {
      const def = s.unitTypes[type];
      lost += n;
      if (def && def.category === 'economy') econDeaths += n;
    }
    for (const n of Object.values(sealed.made[side] ?? {})) made += n;
  }
  console.log(`第 ${g + 1} 局 回合 ${s.turn} 胜者 ${s.winner ?? '平'}`);
}

console.log('');
console.log(`${USE_OLD ? '冻结基线' : '当前代码'} · ${GAMES} 局（双方合计）`);
console.log(`  经济单位承伤占总承伤：${((econTaken / Math.max(1, allTaken)) * 100).toFixed(1)}%（${econTaken}/${allTaken}）`);
console.log(`  经济单位阵亡：${econDeaths} 个 · 总阵亡 ${lost} · 造兵 ${made}`);
console.log(`  阵亡 ÷ 造兵：${(lost / Math.max(1, made)).toFixed(2)}`);
