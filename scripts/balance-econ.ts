/**
 * 经济单位统计跑批：180 局双 AI，古典 / 火药 / 现代三种开局各 60 局。
 *
 * 为什么要单独跑一个脚本而不是拿现成的 sim-ai：
 *   · 它要知道**每一个经济单位个体**的命运（哪回合造出来的、赚了多少、
 *     活到最后没有），sim-ai 只记战线和兵力总数；
 *   · 它要可复现：每一局都写死种子，样本 =（开局, 序号），换个机器也一样；
 *   · 它要能用满核：一局 3~4 秒，180 局串行要十几分钟，32 核能压到半分钟级。
 *
 * 记账口径（写死在这里，报告里也照这个解释）：
 *   · 采用率 = 该开局里"造过至少一个该兵种"的参战方占比（每局 2 方，故分母 = 60×2）；
 *   · 回本率 = 该兵种个体的累计金币产出 ≥ 造价 的比例（"回本的人数占比"）；
 *     另给平均回本进度 income/cost（含未回本的，等价于"平均赚回了多少"）；
 *   · 生存率 = 对局结束时仍存活的个体占比；平均存活回合数按"出场到阵亡/终局"算；
 *   · 胜率影响 = 造过该兵种的一方 vs 没造过的一方，各自胜率之差（含样本数）。
 *
 * 金币产出按 `unitIncomeAt` 逐回合累计到单位个体头上——和 settleIncome 同源，
 * 但不含城市收入与资源产出（那两项不归属任何经济单位）。
 *
 * 运行：node --experimental-strip-types scripts/balance-econ.ts [--games=60] [--workers=32]
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

import { UNIT_TYPES } from '../src/core/config.ts';
import { applyAction, unitIncomeAt } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { aiNextAction } from '../src/core/ai.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';
import { expansionById } from '../src/core/expansions.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

/** 三种开局：古典（1）、火药（3）、现代（6）。 */
export interface Group {
  key: string;
  label: string;
  startEra: number;
  expansions: string[];
}

/**
 * 现代开局必须带上「现代」扩展：`createMatch` 会用 `eraCeilingFor` 把
 * startEra 夹到上限，没有那个包时 era 6 会被夹回 5（二战），样本就不是"现代"了。
 * 古典与火药两档保持纯原版（零扩展）。
 */
export const GROUPS: Group[] = [
  { key: 'classical', label: '古典开局', startEra: 1, expansions: [] },
  { key: 'gunpowder', label: '火药开局', startEra: 3, expansions: [] },
  { key: 'modern', label: '现代开局', startEra: 6, expansions: ['pack-contemporary'] },
];

/** 一局最多走这么多步（含 END_TURN 之外的行动）。超了按"未决"记，种子仍然可复现。 */
const MAX_ACTIONS = 4000;
/** 一局最多这么多回合：防止平局互不接触时跑到天荒地老 */
const MAX_TURNS = 120;

const BASE_SEED = 20261101;

interface Instance {
  id: string;
  type: string;
  owner: PlayerId;
  bornTurn: number;
  cost: number;
  income: number;
  alive: boolean;
  lifeTurns: number;
}

interface SideRecord {
  owner: PlayerId;
  recruited: Record<string, number>;
  won: boolean;
}

interface GameRecord {
  group: string;
  startEra: number;
  seed: number;
  index: number;
  turns: number;
  actions: number;
  winner: PlayerId | null;
  /** 每个经济单位个体的完整账本（只收 economy 类） */
  instances: Instance[];
  sides: SideRecord[];
}

function isEconomy(s: GameState, typeId: string): boolean {
  return s.unitTypes[typeId]?.category === 'economy';
}

/** 跑一局，返回这一局的经济账本 */
function runGame(group: Group, index: number): GameRecord {
  const seed = BASE_SEED + GROUPS.findIndex((g) => g.key === group.key) * 100_000 + index;
  const hasModern = group.expansions.includes('pack-contemporary');
  const enabled = [
    ...Object.keys(UNIT_TYPES),
    ...(hasModern
      ? (expansionById('pack-contemporary')?.units ?? []).map((u) => u.id)
      : []),
  ];
  const s0 = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 16,
      startEra: group.startEra,
      aiOpponent: true,
      aiAlly: true,
      expansionIds: group.expansions,
      enabledUnits: enabled,
    },
    seed,
  );

  let s = s0;
  let actions = 0;
  let budget: AiBudget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  const tracked = new Map<string, Instance>();
  const sides: SideRecord[] = (['A', 'B'] as PlayerId[]).map((owner) => ({
    owner,
    recruited: {},
    won: false,
  }));
  const sideOf = (o: PlayerId) => sides[o === 'A' ? 0 : 1]!;

  /** 回合开始：给每个还活着的经济单位结一次自己的产出 */
  const settleUnitIncome = () => {
    for (const inst of tracked.values()) {
      if (!inst.alive) continue;
      const u = s.units.find((x) => x.id === inst.id);
      if (!u) {
        inst.alive = false;
        inst.lifeTurns = s.turn - inst.bornTurn;
        continue;
      }
      inst.income += unitIncomeAt(s, u, u.x, u.y);
    }
  };

  while (!s.winner && s.turn <= MAX_TURNS && actions < MAX_ACTIONS) {
    const action = aiNextAction(s, budget);
    if (!action) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      s = end.state;
      budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
      settleUnitIncome();
      continue;
    }
    const owner = s.current;
    const beforeIds = new Set(s.units.map((u) => u.id));
    const r = applyAction(s, action);
    if (!r.ok) break;
    s = r.state;
    actions += 1;
    if (action.type === 'RECRUIT') {
      budget.recruited += 1;
      if (isEconomy(s, action.unitType)) {
        const born = s.units.find((u) => !beforeIds.has(u.id) && u.type === action.unitType);
        if (born) {
          tracked.set(born.id, {
            id: born.id,
            type: action.unitType,
            owner,
            bornTurn: s.turn,
            cost: s.unitTypes[action.unitType]?.cost ?? 0,
            income: 0,
            alive: true,
            lifeTurns: 0,
          });
          const rec = sideOf(owner);
          rec.recruited[action.unitType] = (rec.recruited[action.unitType] ?? 0) + 1;
        }
      }
    }
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  }

  // 收尾：结算最后一回合、标注谁赢了
  settleUnitIncome();
  for (const inst of tracked.values()) {
    if (inst.alive) inst.lifeTurns = s.turn - inst.bornTurn;
  }
  if (s.winner) sideOf(s.winner).won = true;

  return {
    group: group.key,
    startEra: group.startEra,
    seed,
    index,
    turns: s.turn,
    actions,
    winner: s.winner,
    instances: Array.from(tracked.values()),
    sides,
  };
}

/* ---------- worker ---------- */

interface Job {
  group: Group;
  index: number;
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  const out: GameRecord[] = [];
  for (const job of jobs) out.push(runGame(job.group, job.index));
  parentPort?.postMessage(out);
} else {
  const argOf = (name: string, fallback: number): number => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    const n = Number(hit.split('=')[1]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const gamesPerGroup = argOf('games', 60);
  const workers = Math.min(argOf('workers', 32), cpus().length);

  const jobs: Job[] = [];
  for (const group of GROUPS) {
    for (let i = 0; i < gamesPerGroup; i += 1) jobs.push({ group, index: i });
  }
  // 轮流发牌：每个 worker 拿到的是"各种开局混着"的一摞，避免某个核专跑现代局
  const buckets: Job[][] = Array.from({ length: workers }, () => []);
  jobs.forEach((job, i) => buckets[i % workers]!.push(job));

  const t0 = Date.now();
  const results: GameRecord[] = [];
  let done = 0;

  await Promise.all(
    buckets
      .filter((b) => b.length > 0)
      .map(
        (bucket) =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), {
              workerData: bucket,
              execArgv: process.execArgv,
            });
            worker.on('message', (rows: GameRecord[]) => {
              results.push(...rows);
              done += rows.length;
              process.stderr.write(`\r已完成 ${done}/${jobs.length} 局`);
              resolve();
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
              if (code !== 0) reject(new Error(`worker exited ${code}`));
            });
          }),
      ),
  );
  process.stderr.write('\n');

  results.sort((a, b) => a.startEra - b.startEra || a.index - b.index);
  mkdirSync('results', { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = `results/econ-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), groups: GROUPS, games: results }, null, 2));
  process.stdout.write(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${results.length} 局 → ${outPath}\n`);

  // 结果摘要交给报告脚本；这里只打一行，避免脚本本身变成第二个报告
  const byGroup = new Map<string, number>();
  for (const g of results) byGroup.set(g.group, (byGroup.get(g.group) ?? 0) + 1);
  process.stdout.write(
    `样本：${Array.from(byGroup).map(([k, n]) => `${k}=${n}`).join(' / ')}\n`,
  );
}
