/**
 * **v4 实战台**：v4 打随机图，B 方是冻结的旧 AI（或 v3）。
 *
 * ── 为什么不用现成的 `ai-duel` ────────────────────────────────
 *
 * `ai-duel` 能跑（`--new ../src/core/v4/ai-v4.ts`），但有**两件事会毁掉读数**：
 *
 *   1. **v4 有模块级缓存**（`ai-v4.ts` 的 `cache`，键是
 *      `回合:当前方:单位数:金币:城数`）。同一个进程连跑几十局，新局第一手的键
 *      和上一局某一手**完全可能相同** → 命中上一局的 `world`。
 *      所以这里每局开头必须 `resetV4()`，否则测的不是这一局。
 *   2. **只看胜负看不出"输在哪"**。v4 的特点是"部队能到城下但展不开"，
 *      光看 17% 胜率不能判断是没出兵、没送上去、还是送上去打不动。
 *
 * ── 输出的三样 ─────────────────────────────────────────────
 *
 *   每局：种子 / 先后手 / 胜负 / 回合 / 双方城的血 / v4 兵数、金、桥数
 *   汇总：v4 胜率 + 二项 z + 平局率 + 平均回合
 *   形状：把"v4 输的局"按终局形态分三类（城先塌 / 兵力差 / 撞上限），
 *         每类给数量——这是"下一步该修哪"的入口，不是评分
 *
 * ── 用法 ───────────────────────────────────────────────────
 *
 *   node --experimental-strip-types scripts/v4-duel.ts --games 20 --era 3
 *   ... --games 20 --size 24 --era 3          # 大图（24×24，长局形状）
 *   ... --foe v3                              # 对手换成 v3
 *   ... --seed 900 --cap 160                  # 换个种子起点 / 回合上限
 *
 * `--games N` 是**种子数**，实际对局 = N × 2（同一颗种子两边各执一次先手）。
 */

import { applyAction, utype } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { resetV4 } from '../src/core/v4/ai-v4.ts';
import { aiNextAction as v4Next } from '../src/core/v4/ai-v4.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const GAMES = Number(argOf('games', '20'));
const ERA = Number(argOf('era', '3'));
const SIZE = Number(argOf('size', String(DEFAULT_CONFIG.size)));
const BASE_SEED = Number(argOf('seed', '900'));
const CAP = Number(argOf('cap', '160'));
const FOE = argOf('foe', 'old');
const FOE_FILE =
  argOf('foe-file', '') || (FOE === 'v3' ? '../src/core/ai-v3.ts' : './baseline-ai.ts');

const foeNext = (await import(FOE_FILE)).aiNextAction as typeof v4Next;

type Result = {
  seed: number;
  /** v4 这一局执哪一方（A 先手 / B 后手） */
  v4Side: PlayerId;
  winner: PlayerId | null;
  turns: number;
  v4CityHp: number;
  foeCityHp: number;
  v4Units: number;
  foeUnits: number;
  v4Gold: number;
  v4Bridges: number;
};

/** 城的血合计（含废墟算 0）；没有城 = 0 */
const cityHpOf = (s: GameState, owner: PlayerId): number =>
  s.cities.filter((c) => c.owner === owner).reduce((n, c) => n + (c.ruined ? 0 : c.hp), 0);

function playOne(seed: number, v4Side: PlayerId): Result {
  /*
   * **每局必须清缓存**：v4 的 `cache` 键只看
   * `回合:当前方:单位数:金币:城数`，跨局会撞上。
   */
  resetV4();
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: ERA,
      size: SIZE,
      mapSymmetry: 'fair',
    },
    seed,
  );

  const aiFor = (p: PlayerId): typeof v4Next => (p === v4Side ? v4Next : foeNext);

  while (!s.winner && s.turn <= CAP) {
    const ai = aiFor(s.current);
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    const moveTries = new Map<string, number>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = ai(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        /* MOVE 被友军占格时下一步可能就合法，同一单位别急着拉黑（同 ai-duel 口径） */
        if (a.type === 'MOVE' && 'unitId' in a) {
          const uid = String((a as { unitId?: string }).unitId ?? '');
          const n = (moveTries.get(uid) ?? 0) + 1;
          moveTries.set(uid, n);
          if (n < 2) continue;
        }
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

  const v4: PlayerId = v4Side;
  const foe: PlayerId = v4Side === 'A' ? 'B' : 'A';
  return {
    seed,
    v4Side,
    winner: s.winner ?? null,
    turns: s.turn,
    v4CityHp: cityHpOf(s, v4),
    foeCityHp: cityHpOf(s, foe),
    v4Units: s.units.filter((u) => u.owner === v4 && utype(s, u.type).category === 'combat').length,
    foeUnits: s.units.filter((u) => u.owner === foe && utype(s, u.type).category === 'combat').length,
    v4Gold: s.players[v4]?.gold ?? 0,
    v4Bridges: s.units.filter(
      (u) => u.owner === v4 && (utype(s, u.type).bridges ?? false),
    ).length,
  };
}

/** 二项检验的 z（对 0.5） */
const zOf = (win: number, lose: number): number => {
  const n = win + lose;
  if (n === 0) return 0;
  return (win - n / 2) / Math.sqrt(n / 4);
};

const results: Result[] = [];
for (let i = 0; i < GAMES; i++) {
  const seed = BASE_SEED + i;
  for (const v4Side of ['A', 'B'] as const) {
    const r = playOne(seed, v4Side);
    results.push(r);
    const tag = v4Side === 'A' ? 'v4执A（先手）' : 'v4执B（后手）';
    const w = r.winner === null ? '平' : r.winner === r.v4Side ? 'v4胜' : 'v4负';
    process.stdout.write(
      `era${ERA} ${SIZE}×${SIZE} seed=${seed} ${tag} → ${w} (${r.turns} 手) ` +
        `城 ${r.v4CityHp}/${r.foeCityHp} 兵 ${r.v4Units}/${r.foeUnits} ` +
        `金 ${r.v4Gold} 桥 ${r.v4Bridges}\n`,
    );
  }
}

const v4Wins = results.filter((r) => r.winner === r.v4Side).length;
const foeWins = results.filter((r) => r.winner !== null && r.winner !== r.v4Side).length;
const draws = results.length - v4Wins - foeWins;
const avgTurns = (results.reduce((n, r) => n + r.turns, 0) / results.length).toFixed(1);
const z = zOf(v4Wins, foeWins);

const lost = results.filter((r) => r.winner !== null && r.winner !== r.v4Side);
/** 输的三种形状（不是评分，是用来决定下一步修哪） */
const shape = {
  /** 自己的城先塌：守不住 */
  城先塌: lost.filter((r) => r.v4CityHp === 0).length,
  /** 兵力差一半以上：没造出来 / 造了没送到 */
  兵力差: lost.filter((r) => r.v4CityHp > 0 && r.v4Units * 2 < r.foeUnits).length,
  /** 撞回合上限且两边城都在：收不了尾 */
  撞上限: lost.filter((r) => r.v4CityHp > 0 && r.turns > CAP && r.v4Units * 2 >= r.foeUnits).length,
};

console.log(
  `\nera${ERA} ${SIZE}×${SIZE} ${results.length} 局：` +
    `v4 ${v4Wins} 胜 / 对手 ${foeWins} 胜 / 平 ${draws} → ` +
    `v4 胜率 ${((v4Wins / results.length) * 100).toFixed(1)}% (z=${z.toFixed(2)}) ` +
    `平局率 ${((draws / results.length) * 100).toFixed(0)}% 均 ${avgTurns} 手`,
);
console.log(
  `v4 输的 ${lost.length} 局形状：城先塌 ${shape.城先塌} / 兵力差一半以上 ${shape.兵力差} / 撞上限 ${shape.撞上限}`,
);
console.log(
  `v4 平均：城血 ${(results.reduce((n, r) => n + r.v4CityHp, 0) / results.length).toFixed(1)}` +
    ` · 战斗兵 ${(results.reduce((n, r) => n + r.v4Units, 0) / results.length).toFixed(1)}` +
    ` · 桥 ${(results.reduce((n, r) => n + r.v4Bridges, 0) / results.length).toFixed(2)}`,
);
