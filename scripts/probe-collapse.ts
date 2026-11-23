/**
 * 探针：三局负的崩盘时间线（只量不改）。
 *
 * `V3-BACKLOG` P0-1 要求"先把崩盘时间点拉出来"：第几回合开始丢城/丢兵、
 * 当时经济投入窗口是多少、敌方兵力从第几回合超过我方。这里给最小版本。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-collapse.ts                       # 三局负串行
 *   node --experimental-strip-types scripts/probe-collapse.ts --queue Q1 --seed 30
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, distToCity } from '../src/core/rules.ts';
import { unitValue } from '../src/core/ai-tactics.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const QUEUES: Record<string, { size: number; era: number; cap: number }> = {
  Q1: { size: 12, era: 2, cap: 200 },
  Q2: { size: 16, era: 3, cap: 220 },
  Q3: { size: 24, era: 2, cap: 260 },
  Q4: { size: 24, era: 4, cap: 260 },
};

type Ai = (
  s: GameState,
  budget: typeof DEFAULT_BUDGET,
  rejected: ReadonlySet<string>,
) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
const modNew = (await import('../src/core/ai-v3.ts')) as {
  aiNextAction: Ai;
  aiRecruitTrace: { on: boolean; last: string | null };
};
const modOld = (await import('./baselines/ai-9efb961.ts')) as { aiNextAction: Ai };
const trace = modNew.aiRecruitTrace;

const GAMES = [
  { q: 'Q1', seed: 30, side: 'A' as PlayerId },
  { q: 'Q1', seed: 31, side: 'B' as PlayerId },
  { q: 'Q3', seed: 31, side: 'A' as PlayerId },
];

const fight = (s: GameState, me: PlayerId): { n: number; v: number } => {
  const list = s.units.filter(
    (u) => u.owner === me && u.hp > 0 && s.unitTypes[u.type]?.category === 'combat',
  );
  return { n: list.length, v: list.reduce((a: number, u: Unit) => a + unitValue(s, u), 0) };
};

const runOne = (QID: string, SEED: number, SIDE: PlayerId): void => {
  const q = QUEUES[QID]!;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: q.era,
      aiLevel: 'tactic',
      size: q.size,
      mapSymmetry: 'fair',
      // 和跑批对齐：不传就是全关（默认行为）
      ...(process.argv.includes('--hub') ? { aiHub: true } : {}),
      ...(process.argv.includes('--city-site') ? { aiCitySite: true } : {}),
      ...(process.argv.includes('--garrison') ? { aiGarrison: true } : {}),
    },
    SEED,
  );
  const aiFor = (p: PlayerId): Ai => (p === SIDE ? modNew.aiNextAction : modOld.aiNextAction);
  const foeSide = s.players ? (Object.keys(s.players).find((p) => p !== SIDE) as PlayerId) : 'B';

  // 经济投入窗口：和 recruitCandidate 里 econPlan 的 horizon 同一条公式（城到城路径近似）
  const own = s.cities.filter((c) => c.owner === SIDE);
  const foeC = s.cities.filter((c) => c.owner !== SIDE);
  let best = Infinity;
  for (const a of own) for (const b of foeC) best = Math.min(best, distToCity(a, b));
  const horizon = Number.isFinite(best) ? Math.max(4, Math.min(12, Math.round((best * 1.6) / 3))) : 8;

  console.log(`\n== ${QID} seed=${SEED} 新版坐 ${SIDE} · econHorizon=${horizon}（城到城 ${best} 格）==`);
  console.log(' 回合 | 我兵 值  | 敌兵 值  | 我城(hp) | 经济 | 金 | 本回合采购');
  let prevCities = new Set(s.cities.filter((c) => c.owner === SIDE).map((c) => c.id));
  while (!s.winner && s.turn <= q.cap) {
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    const buys: string[] = [];
    const foeBuys: string[] = [];
    const losses: string[] = [];
    let upg = 0;
    trace.on = s.current === SIDE;
    trace.last = null;
    const goldAtStart = s.players[SIDE].gold;
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const isMine = s.current === SIDE;
      const a = aiFor(s.current)(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      s = r.state;
      if (a.type === 'RECRUIT') {
        (isMine ? buys : foeBuys).push(a.unitType);
        budget.recruited += 1;
      }
      if (a.type === 'UPGRADE' && isMine) upg += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const nowCities = s.cities.filter((c) => c.owner === SIDE);
    for (const id of prevCities) if (!nowCities.some((c) => c.id === id)) losses.push(id);
    prevCities = new Set(nowCities.map((c) => c.id));

    const mine = fight(s, SIDE);
    const foe = fight(s, foeSide);
    const econ = s.units.filter(
      (u) => u.owner === SIDE && s.unitTypes[u.type]?.category === 'economy',
    ).length;
    const cityTxt = nowCities.map((c) => `${c.id}:${Math.round(c.hp)}`).join(' ');
    /*
     * "手里有钱却一个兵没买"的原因：`recruitCandidate` 自己会记拒绝理由，
     * 只在这一回合结束、我方没买到兵、而且钱不少的时候读一次。
     */
    if (s.turn % 4 === 0 || losses.length > 0) {
      const act = [
        losses.length ? '丢城 ' + losses.join(',') : '',
        buys.length ? '买 ' + buys.join(',') : '',
        upg ? '升城×' + upg : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        ` ${String(s.turn).padStart(3)} | ${String(mine.n).padStart(2)} ${String(Math.round(mine.v)).padStart(4)}` +
          ` | ${String(foe.n).padStart(2)} ${String(Math.round(foe.v)).padStart(4)}` +
          ` | ${cityTxt.padEnd(24)} | ${String(econ).padStart(2)} | ${Math.round(s.players[SIDE].gold).toString().padStart(4)}` +
          ` | ${act}`,
      );
    }
    if (trace.on && EACH) {
      const it = (s as unknown as {
        aiFocus?: Record<string, { save?: { goal?: string; cost?: number; since?: number } }>;
      }).aiFocus?.[SIDE]?.save;
      const mineNow = fight(s, SIDE);
      const delta = Math.round(s.players[SIDE].gold - goldAtStart);
      console.log(
        `    T${String(s.turn).padStart(3)} 兵${String(mineNow.n).padStart(2)} 金${String(Math.round(s.players[SIDE].gold)).padStart(4)}` +
          ` 净${delta >= 0 ? '+' : ''}${delta}` +
          ` 攒=${it?.goal ? `${it.goal}@${it.cost}(立${s.turn - (it.since ?? s.turn)})` : '—'}` +
          ` 买=${buys.length ? buys.join(',') : '—'}`,
      );
    }
    if (trace.on && buys.length === 0 && goldAtStart > 120) {
      /*
       * 攒的是什么：`aiIntent` 是跨回合的攒钱目标（见 `types.ts` 的 AiIntent）。
       * 只报"冻结"没法判断该不该解冻——要看得见 target 和"还差多少"。
       */
      const it = (s as unknown as {
        aiFocus?: Record<string, { save?: { goal?: string; cost?: number; unitId?: string; cityId?: string; since?: number } }>;
      }).aiFocus?.[SIDE]?.save;
      const target = it && it.cost
        ? `${it.goal}${it.unitId ? ':' + it.unitId : ''}${it.cityId ? '@' + it.cityId : ''} 要 ${it.cost}（还差 ${Math.max(0, it.cost - goldAtStart)}，立了 ${s.turn - (it.since ?? s.turn)} 回合）`
        : '（没有跨回合目标）';
      console.log(
        `     └ 钱 ${Math.round(goldAtStart)} 一个兵没买 · 拒绝理由：${trace.last ?? '（没走到采购）'}\n` +
          `       攒的：${target}`,
      );
    }
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }  console.log(` 终局：${s.winner ?? '平'} @ ${s.turn} 回合`);
};

const only = argOf('queue', '');
/** 逐回合打印（看"攒钱闸门"是不是在开/关之间抖） */
const EACH = process.argv.includes('--each');
if (only) runOne(only.toUpperCase(), Number(argOf('seed', '30')), (argOf('side', 'A').toUpperCase() as PlayerId));
else for (const g of GAMES) runOne(g.q, g.seed, g.side);
