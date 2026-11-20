/**
 * 机制计数：**胜率之外**的第二把尺子。
 *
 * 为什么需要它：AI 打 AI 的胜率经常是 50%，而 50% 既可能是"两边一样强"，
 * 也可能是"这套内容根本没跑起来"。装甲那次就是这样——电站建了 4 座、
 * 素体一台没买，胜率照样 50%，光看胜率会以为一切正常。
 *
 * 所以每一步验收都该同时看两样：
 *
 *   · 胜率：`scripts/ai-duel.ts --old ./baselines/ai-<sha>.ts`
 *   · 机制计数：这个脚本
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-mechanics.ts --games 4 --size 24 --era 7
 *   node --experimental-strip-types scripts/diag-mechanics.ts --exp cultivation --era 1
 *
 * 输出：每局一行 + 汇总（出现在几局里 / 平均每局几个）。
 */
// @ts-nocheck
import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, unitsOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const GAMES = Number(argOf('games', '4'));
const SIZE = Number(argOf('size', '24'));
const ERA = Number(argOf('era', '1'));
const CAP = Number(argOf('cap', '160'));
const EXP = argOf('exp', 'cultivation,naval,armor-era7').split(',').filter(Boolean);

/**
 * 要数的东西。**按内容分组**，加新链时往这里加一行就够——
 * id 用兵种表里的真实 id，这里只是"读表"，不参与任何决策。
 */
const WATCH: Array<{ group: string; label: string; ids: string[] }> = [
  { group: '海军', label: '船坞', ids: ['nv-dock', 'nv-shipyard', 'nv-yard'] },
  { group: '装甲', label: '电站', ids: ['armor_coal', 'armor_fusion'] },
  { group: '装甲', label: '装配坞', ids: ['armor_dock', 'armor_yard'] },
  { group: '装甲', label: '素体', ids: ['armor_hawk', 'armor_bastion', 'armor_lancer', 'armor_anvil'] },
  { group: '修真', label: '灵田', ids: ['cultivation-spirit-field'] },
  { group: '修真', label: '宗门', ids: ['cultivation-sect'] },
  { group: '修真', label: '藏经阁', ids: ['cultivation-scripture-pavilion'] },
  { group: '修真', label: '修士', ids: ['qi-cultivator', 'sword-cultivator', 'body-cultivator'] },
];

const totals = new Map<string, number>();
const hits = new Map<string, number>();

for (let g = 0; g < GAMES; g += 1) {
  const seed = 8100 + g * 91;
  let s: any = createMatch(
    { ...DEFAULT_CONFIG, size: SIZE, startEra: ERA, aiOpponent: true, aiAlly: true, expansionIds: EXP } as any,
    seed,
  );
  const rej = new Set<string>();
  for (let t = 0; t < CAP; t += 1) {
    const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
    for (let k = 0; k < AI_MAX_STEPS && !s.winner; k += 1) {
      const a = aiNextAction(s, budget, rej);
      if (!a) break;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, a);
      if (!r.ok) {
        rej.add(JSON.stringify(a));
        continue;
      }
      rej.clear();
      s = r.state;
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }

  // 终局存量：两方加起来，比"建造次数"更接近"这东西真的在场上"
  const line: string[] = [];
  for (const w of WATCH) {
    const n = ['A', 'B'].reduce(
      (sum, p) => sum + unitsOf(s, p).filter((u: any) => w.ids.includes(u.type)).length,
      0,
    );
    totals.set(w.label, (totals.get(w.label) ?? 0) + n);
    if (n > 0) hits.set(w.label, (hits.get(w.label) ?? 0) + 1);
    line.push(`${w.label} ${n}`);
  }
  const research = ['A', 'B'].reduce((n, p) => n + (s.researched?.[p] ?? []).length, 0);
  totals.set('研发', (totals.get('研发') ?? 0) + research);
  if (research > 0) hits.set('研发', (hits.get('研发') ?? 0) + 1);
  console.log(`seed ${seed}: ${line.join(' · ')} · 研发 ${research} · 终局 ${s.winner ?? '未决'}@${s.turn}`);
}

console.log(`\n${GAMES} 局 × ${SIZE}×${SIZE} × ${ERA} 代 · 扩展 ${EXP.join('+') || '无'}`);
for (const w of [...WATCH.map((x) => x.label), '研发']) {
  const total = totals.get(w) ?? 0;
  const hit = hits.get(w) ?? 0;
  console.log(
    `  ${w.padEnd(4, '　')} 合计 ${String(total).padStart(3)} · ${hit}/${GAMES} 局出现过 · 平均 ${(total / GAMES).toFixed(1)}/局`,
  );
}
