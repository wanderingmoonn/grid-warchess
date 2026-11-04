/**
 * 建造体检：AI 到底在建什么、建了多少、建的时候有没有敌人在附近。
 *
 * 线上对局里 AI 有一半产能花在"不打架的人"身上（工程师/劳工），
 * 而这些人最常干的事就是盖东西。这个脚本按兵种统计 BUILD 的次数，
 * 并且记录建造那一刻"最近敌人有多远"，用来区分"前线工事"和"后方刷建筑"。
 *
 *   node --experimental-strip-types scripts/diag-build.ts --games 4 --size 16
 */
import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, distance, unitsOf } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
};
const SIZE = Number(argOf('size', '16'));
const GAMES = Number(argOf('games', '4'));
const CAP = Number(argOf('cap', '120'));
const EXP = argOf('exp', '').split(',').filter(Boolean);
const ERA = Number(argOf('era', '1'));
// 地貌：验海军内容必须能指定有水的地图。缺省 random 在 20×20 上常常只有 5% 水，
// 而 AI 的 seaDemand 在水域 < 8% 时判 0——那时候"不造造船厂"是对的，
// 拿这种图去证明"造船厂没人用"会得出完全错误的结论。
const MAP = argOf('map', '');

const built: Record<string, { n: number; foeDist: number[]; gold: number[] }> = {};
const kept: Record<string, number> = {};
let wetSum = 0;

for (let g = 0; g < GAMES; g += 1) {
  const seed = 8100 + g * 91;
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: SIZE, startEra: ERA, aiOpponent: true, aiAlly: true, aiLevel: 'advanced',
      ...(MAP ? { mapStyle: MAP } : {}),
      ...(EXP.length ? { expansionIds: EXP } : {}) } as never,
    seed,
  );
  let ended = false;
  wetSum += s.tiles.filter((t) => t.terrain === 'water').length / Math.max(1, s.tiles.length);
  while (!ended && s.turn <= CAP) {
    const me: PlayerId = s.current;
    const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
    for (let step = 0; step < AI_MAX_STEPS; step += 1) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      if (a.type === 'BUILD') {
        const foe = unitsOf(s, me === 'A' ? 'B' : 'A');
        const d = foe.length ? Math.min(...foe.map((u) => distance(u, a))) : 99;
        const rec = (built[a.unitType] ??= { n: 0, foeDist: [], gold: [] });
        rec.n += 1;
        rec.foeDist.push(d);
        rec.gold.push(s.players[me].gold);
      }
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (s.winner) { ended = true; break; }
    }
    if (ended) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  for (const u of s.units) kept[u.type] = (kept[u.type] ?? 0) + 1;
}

const rows = Object.entries(built).sort((a, b) => b[1].n - a[1].n);
const total = rows.reduce((n, [, r]) => n + r.n, 0);
console.log(`共 ${GAMES} 局 × ${SIZE}×${SIZE}：BUILD ${total} 次（水域 ${((wetSum / Math.max(1, GAMES)) * 100).toFixed(1)}%）\n`);
console.log('兵种                 次数  平均敌距  远于8格  平均余额');
for (const [id, r] of rows) {
  const far = r.foeDist.filter((d) => d > 8).length;
  const avg = r.foeDist.reduce((a, b) => a + b, 0) / r.foeDist.length;
  const gold = r.gold.reduce((a, b) => a + b, 0) / r.gold.length;
  console.log(
    `${id.padEnd(20)} ${String(r.n).padStart(4)}  ${avg.toFixed(1).padStart(7)}  ` +
      `${String(far).padStart(7)}  ${gold.toFixed(0).padStart(7)}`,
  );
}
