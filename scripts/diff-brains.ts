/**
 * 行为量表：同一张图、同一颗种子，让两个内核各打一遍，把"它们哪儿不一样"量出来。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 前三道题里有两道是照"叙事"猜出来的病（S-003 废墟接管、S-005 桥头让位），
 * 实测都不成立——v3 接管得很及时，也会自己把桥让开。
 * 猜错的代价是整道题白做，所以改成先量、再出题。
 *
 * ── 量什么 ────────────────────────────────────────────────────
 *
 * 只量**能直接对应到"一手棋好不好"**的量，不量胜负（胜负噪声太大，见 S-002）：
 *
 *   · `忙`  每手发出的动作数 —— 太低说明在发呆
 *   · `闲`  一手结束时"没走也没打"的单位占比 —— 这就是"磨"的量化
 *   · `近`  最靠前的战斗单位离敌城几格 —— 推进速度
 *   · `集`  敌城 6 格内的战斗单位数 —— 有没有集结
 *   · `金`  手上的钱 —— 攒钱冻结
 *   · `产`  经济兵本手总产出 —— 经济有没有跑起来
 *
 * 用法：
 *   node --experimental-strip-types scripts/diff-brains.ts --me v3 --foe v1 --seeds 4 --turns 60
 *   node --experimental-strip-types scripts/diff-brains.ts --me both        # 两边各跑一遍再对比
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { loadCustomUnits } from '../src/core/customUnits.ts';
import { applyAction, unitYieldAt } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const ME_KIND = argOf('me', 'both'); // 'v1' | 'v3' | 'both'
const FOE_KIND = argOf('foe', 'v1');
const SEEDS = Number(argOf('seeds', '3'));
const TURNS = Number(argOf('turns', '60'));
const SIZE = Number(argOf('size', '12'));

type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;

async function loadAi(kind: string): Promise<AiFn> {
  if (kind === 'v3') return ((await import('../src/core/ai-v3.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'v1') return ((await import('./baselines/ai-9efb961.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'auto') return ((await import('../src/core/ai.ts')) as { aiNextAction: AiFn }).aiNextAction;
  throw new Error(`不认识的引擎：${kind}`);
}

interface Sample {
  turn: number;
  acts: number;
  idleShare: number;
  /** 战斗单位里"没走也没打"的占比 —— 这才是"磨"，经济兵闲着是本职 */
  idleCombat: number;
  idleEcon: number;
  nearest: number;
  near: number;
  gold: number;
  yieldSum: number;
}

/** 打一局，回收每手样本 */
function play(meAi: AiFn, foeAi: AiFn, seed: number): Sample[] {
  let s = createMatch({ ...DEFAULT_CONFIG, size: SIZE, startEra: 2, mapSymmetry: 'fair' }, seed, loadCustomUnits());
  const foeCity = () => s.cities.filter((c) => c.owner !== 'A' && !c.ruined);
  const out: Sample[] = [];
  const cap = TURNS;

  while (!s.winner && s.turn <= cap) {
    const actor = s.current;
    const ai = actor === 'A' ? meAi : foeAi;
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    let acts = 0;
    const touched = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = ai(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      acts += 1;
      if ('unitId' in a) touched.add(String((a as { unitId?: string }).unitId));
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      s = r.state;
    }

    // 这一手结束时的局面（我方视角）
    if (actor === 'A') {
      const mine = s.units.filter((u) => u.owner === 'A');
      const combat = mine.filter((u) => (s.unitTypes[u.type] ?? { category: 'x' }).category === 'combat');
      const fc = foeCity();
      const nearest = fc.length === 0 || combat.length === 0
        ? -1
        : Math.min(
            ...combat.map((u) =>
              Math.min(...fc.map((c) => Math.max(Math.abs(u.x - c.x), Math.abs(u.y - c.y)))),
            ),
          );
      const near = fc.length === 0
        ? 0
        : combat.filter((u) =>
            fc.some((c) => Math.max(Math.abs(u.x - c.x), Math.abs(u.y - c.y)) <= 6),
          ).length;
      const isIdle = (u: GameState['units'][number]) => !touched.has(u.id) && !u.moved && !u.acted;
      const idle = mine.filter(isIdle).length;
      const combatAll = mine.filter((u) => (s.unitTypes[u.type] ?? { category: 'x' }).category === 'combat');
      const econAll = mine.filter((u) => (s.unitTypes[u.type] ?? { category: 'x' }).category === 'economy');
      const idleCombatN = combatAll.filter(isIdle).length;
      const idleEconN = econAll.filter(isIdle).length;
      const yieldSum = s.units
        .filter((u) => u.owner === 'A' && (s.unitTypes[u.type] ?? { category: 'x' }).category === 'economy')
        .reduce((n, u) => n + (unitYieldAt(s, u, u.x, u.y).gold ?? 0), 0);
      out.push({
        turn: s.turn,
        acts,
        idleShare: mine.length === 0 ? 1 : idle / mine.length,
        idleCombat: combatAll.length === 0 ? 0 : idleCombatN / combatAll.length,
        idleEcon: econAll.length === 0 ? 0 : idleEconN / econAll.length,
        nearest,
        near,
        gold: s.players.A.gold,
        yieldSum,
      });
    }

    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  return out;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function summarize(samples: Sample[]): Record<string, number> {
  // 跳过前 4 手：开局那会儿两家都还没接触，混进去会把差别冲淡
  const body = samples.filter((x) => x.turn > 4);
  return {
    样本手数: body.length,
    每手动作数: mean(body.map((x) => x.acts)),
    闲置占比: mean(body.map((x) => x.idleShare)) * 100,
    战斗闲置: mean(body.map((x) => x.idleCombat)) * 100,
    经济闲置: mean(body.map((x) => x.idleEcon)) * 100,
    离敌城格数: mean(body.filter((x) => x.nearest >= 0).map((x) => x.nearest)),
    敌城六格内: mean(body.map((x) => x.near)),
    手上金币: mean(body.map((x) => x.gold)),
    经济兵总产: mean(body.map((x) => x.yieldSum)),
  };
}

const kinds = ME_KIND === 'both' ? ['v1', 'v3'] : [ME_KIND];
const foeAi = await loadAi(FOE_KIND);
const rows: Array<{ kind: string; agg: Record<string, number> }> = [];

for (const kind of kinds) {
  const meAi = await loadAi(kind);
  const all: Sample[] = [];
  for (let i = 0; i < SEEDS; i++) {
    // 种子从 60 起：那是留给 v4 体检的区间，这里只用它做"同为随机图"的样本
    all.push(...play(meAi, foeAi, 6001 + i));
  }
  rows.push({ kind, agg: summarize(all) });
}

const keys = Object.keys(rows[0]!.agg);
const pad = (s: string, n: number) => s.padEnd(n, ' ');
console.log(`\n地图 ${SIZE}×${SIZE} · 起始 2 代 · 对手 ${FOE_KIND} · ${SEEDS} 颗种子 × ${TURNS} 手\n`);
console.log(pad('指标', 16) + rows.map((r) => pad(r.kind, 10)).join(''));
for (const k of keys) {
  const vals = rows.map((r) => r.agg[k]!);
  const diff = vals.length === 2 && vals[0] !== 0 ? ((vals[1]! - vals[0]!) / Math.abs(vals[0]!)) * 100 : NaN;
  console.log(
    pad(k, 16) +
      rows.map((r) => pad(r.agg[k]!.toFixed(2), 10)).join('') +
      (Number.isFinite(diff) ? `  ${diff > 0 ? '+' : ''}${diff.toFixed(0)}%` : ''),
  );
}
console.log('\n读法：闲置占比越低越好；离敌城格数越低越好；敌城六格内越高越好。');
