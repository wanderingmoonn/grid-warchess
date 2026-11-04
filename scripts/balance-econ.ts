/**
 * 经济单位 / 经济建筑跑批：青铜·铁器·火器 × 12/16/20 三种边长，各 60 局，共 540 局。
 *
 * 为什么要有这个脚本：
 *   · 只统计"每一个个体"的命运（哪回合造出来、赚了多少、活到最后没有），
 *     sim-ai 只记战线和兵力；
 *   · 每一局写死种子，样本 =（开局, 边长, 序号），换机器也一样；
 *   · 一局几秒，540 局串行要半小时，worker 池能压到两分钟级。
 *
 * 记账口径（报告里照这个解释）：
 *   · **经济单位**（category=economy，走 RECRUIT）与**经济建筑**
 *     （category=building，但有 income / incomeByTerrain / yield，走 BUILD）**都收**；
 *   · 采用率 = 造过至少一个该兵种的参战方占比（每局 2 方）；
 *   · 回本率 = 个体累计金币产出 ≥ 造价 的比例；平均回本进度 = income/cost 均值；
 *   · 生存率 = 终局仍存活的个体占比；
 *   · 胜率影响 = 分胜负的对局里，"造过 vs 没造过"两组的胜率差。
 *
 * 金币产出按 `unitIncomeAt` 逐回合累计到个体头上，与 settleIncome 同源；
 * 不含城市自身收入与资源产出（那两项不归属任何单位）。
 *
 * 运行：node --experimental-strip-types scripts/balance-econ.ts [--games=60] [--workers=32]
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

import { UNIT_TYPES, eraDef } from '../src/core/config.ts';
import { applyAction, unitIncomeAt } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { aiNextAction } from '../src/core/ai.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';
import type { PlayerId, UnitTypeDef } from '../src/core/types.ts';

/** 九个配置：三个开局 × 三种边长。纯原版，不开任何扩展。 */
export interface Config {
  era: number;
  size: number;
  key: string;
  label: string;
}

const ERAS = [1, 2, 3];
const SIZES = [12, 16, 20];

export const CONFIGS: Config[] = ERAS.flatMap((era) =>
  SIZES.map((size) => ({
    era,
    size,
    key: `e${era}-s${size}`,
    label: `${eraDef(era).name}开局 · ${size}×${size}`,
  })),
);

const MAX_ACTIONS = 4000;
const MAX_TURNS = 120;
const BASE_SEED = 20261101;

interface Instance {
  id: string;
  type: string;
  kind: 'unit' | 'building';
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
  config: string;
  era: number;
  size: number;
  seed: number;
  index: number;
  turns: number;
  actions: number;
  winner: PlayerId | null;
  instances: Instance[];
  sides: SideRecord[];
}

/** 这个兵种算不算"经济"：经济单位，或者带产出的建筑 */
function isEcon(def: UnitTypeDef | undefined): boolean {
  if (!def) return false;
  if (def.category === 'economy') return true;
  if (def.category !== 'building') return false;
  return !!def.income || !!def.incomeByTerrain || !!def.yield;
}

function runGame(cfg: Config, index: number): GameRecord {
  const seed = BASE_SEED + cfg.era * 100_000 + cfg.size * 1000 + index;
  let s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: cfg.size,
      startEra: cfg.era,
      aiOpponent: true,
      aiAlly: true,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    seed,
  );

  let actions = 0;
  let budget: AiBudget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  const tracked = new Map<string, Instance>();
  const sides: SideRecord[] = (['A', 'B'] as PlayerId[]).map((owner) => ({
    owner,
    recruited: {},
    won: false,
  }));
  const sideOf = (o: PlayerId) => sides[o === 'A' ? 0 : 1]!;

  const settle = () => {
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
      settle();
      continue;
    }
    const owner = s.current;
    const beforeIds = new Set(s.units.map((u) => u.id));
    const r = applyAction(s, action);
    if (!r.ok) break;
    s = r.state;
    actions += 1;

    const spawned =
      action.type === 'RECRUIT'
        ? { type: action.unitType, kind: 'unit' as const }
        : action.type === 'BUILD'
          ? { type: action.unitType, kind: 'building' as const }
          : null;
    if (spawned) {
      if (action.type === 'RECRUIT') budget.recruited += 1;
      const def = s.unitTypes[spawned.type];
      if (isEcon(def)) {
        const born = s.units.find((u) => !beforeIds.has(u.id) && u.type === spawned.type);
        if (born) {
          tracked.set(born.id, {
            id: born.id,
            type: spawned.type,
            kind: spawned.kind,
            owner,
            bornTurn: s.turn,
            cost: def?.cost ?? 0,
            income: 0,
            alive: true,
            lifeTurns: 0,
          });
          const rec = sideOf(owner);
          rec.recruited[spawned.type] = (rec.recruited[spawned.type] ?? 0) + 1;
        }
      }
    }
    if (action.type === 'UPGRADE') budget.upgraded += 1;
  }

  settle();
  for (const inst of tracked.values()) {
    if (inst.alive) inst.lifeTurns = s.turn - inst.bornTurn;
  }
  if (s.winner) sideOf(s.winner).won = true;

  return {
    config: cfg.key,
    era: cfg.era,
    size: cfg.size,
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
  cfg: Config;
  index: number;
}

/**
 * 把四个被改过的数值还原成"改前"，用于同种子的 A/B 对照。
 *
 * 直接改 `UNIT_TYPES` 是可行的：`createMatch` 是用展开语法拼兵种表的，
 * 基础兵种拿到的仍是同一个对象引用，所以这里改完，worker 里每一局都会看到旧值。
 * 只在 `--baseline` 时执行，跑完的 JSON 单独存一份，不会和"改后"混在一起。
 */
function applyBaseline(): void {
  const farmer = UNIT_TYPES.farmer;
  if (farmer) farmer.cost = 55;
  const factory = UNIT_TYPES.factory;
  if (factory?.incomeByTerrain) factory.incomeByTerrain.city = 20;
  const arsenal = UNIT_TYPES.arsenal;
  if (arsenal?.incomeByTerrain) arsenal.incomeByTerrain.city = 30;
  const agribusiness = UNIT_TYPES.agribusiness;
  if (agribusiness) agribusiness.era = 5;
}

if (!isMainThread) {
  const payload = workerData as { jobs: Job[]; baseline: boolean };
  if (payload.baseline) applyBaseline();
  const out: GameRecord[] = [];
  for (const job of payload.jobs) out.push(runGame(job.cfg, job.index));
  parentPort?.postMessage(out);
} else {
  const argOf = (name: string, fallback: number): number => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    const n = Number(hit.split('=')[1]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const gamesPerConfig = argOf('games', 60);
  const workers = Math.min(argOf('workers', 32), cpus().length);
  const baseline = process.argv.includes('--baseline');

  const jobs: Job[] = [];
  for (const cfg of CONFIGS) {
    for (let i = 0; i < gamesPerConfig; i += 1) jobs.push({ cfg, index: i });
  }
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
              workerData: { jobs: bucket, baseline },
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

  results.sort((a, b) => a.era - b.era || a.size - b.size || a.index - b.index);
  mkdirSync('results', { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = `results/econ-matrix-${stamp}${baseline ? '-baseline' : ''}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), configs: CONFIGS, gamesPerConfig, games: results },
      null,
      2,
    ),
  );
  process.stdout.write(
    `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${results.length} 局 → ${outPath}\n`,
  );
}
