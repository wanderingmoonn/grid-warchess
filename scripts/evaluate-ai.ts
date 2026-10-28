/** Frozen-opponent, paired-seat evaluation. A capped game remains unresolved. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { aiNextAction, aiMood, aiActionKey, DEFAULT_BUDGET, AI_MAX_STEPS } from '../src/core/ai.ts';
import { aiNextAction as baseline } from './baselines/ai-004d48a.ts';
import { playerView } from '../src/core/fog.ts';
import { applyAction, incomeOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { MatchConfig, PlayerId } from '../src/core/types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replaceAll('\r\n', '\n');
const profiles: Record<string, Partial<MatchConfig>> = {
  ancient: { size: 12, startEra: 1 },
  medieval: { size: 16, startEra: 2 },
  gunpowder: { size: 20, startEra: 3 },
  industry: { size: 20, startEra: 4 },
  modern: { size: 20, startEra: 5 },
  heroes: { size: 16, startEra: 3, expansionIds: [...DEFAULT_CONFIG.expansionIds, 'fantasy-core', 'fantasy-heroes', 'fantasy-knights'] },
  cityworks: { size: 16, startEra: 2, expansionIds: [...DEFAULT_CONFIG.expansionIds, 'city-works'] },
  seasons: { size: 16, startEra: 2, expansionIds: [...DEFAULT_CONFIG.expansionIds, 'seasons'] },
};
interface Task { profile: string; seed: number; cap: number; self: boolean }

function game(task: Task, newSide: PlayerId) {
  let s = createMatch({ ...DEFAULT_CONFIG, ...profiles[task.profile], aiAlly: true, aiOpponent: true }, task.seed);
  const config = structuredClone(s.config);
  const errors = { new: 0, old: 0 };
  const rejectionReasons: Record<string,number> = {};
  const actions = { new: 0, old: 0 };
  const ms = { new: 0, old: 0 };
  const doctrine = { rush: 0, harass: 0, boom: 0 };
  const development = { economy: 0, buildings: 0, upgrades: 0, heroes: 0 };
  const abandonment: Array<{ turn: number; city: string; gold: number; income: number }> = [];
  let switches = 0, largestWeightStep = 0;
  let previous: ReturnType<typeof aiMood> | null = null;
  let capHits = 0;
  while (!s.winner && s.turn <= task.cap) {
    const who = s.current === newSide ? 'new' : 'old';
    const choose = who === 'new' && !task.self ? aiNextAction : baseline;
    if (who === 'new') {
      const mood = aiMood(playerView(s, s.current).state);
      doctrine[mood.lead]++;
      if (previous) {
        if (previous.lead !== mood.lead) switches++;
        largestWeightStep = Math.max(largestWeightStep, ...Object.keys(doctrine).map(k => Math.abs(mood.weight[k as keyof typeof doctrine] - previous!.weight[k as keyof typeof doctrine])));
      }
      previous = mood;
      if (mood.abandonedCityId && abandonment.at(-1)?.city !== mood.abandonedCityId) {
        abandonment.push({ turn: s.turn, city: mood.abandonedCityId, gold: s.players[s.current].gold, income: incomeOf(s, s.current) });
      }
    }
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    let steps = 0;
    for (; steps < AI_MAX_STEPS && !s.winner; steps++) {
      const start = performance.now();
      const action = choose(s, budget, rejected);
      ms[who] += performance.now() - start;
      if (!action) break;
      const result = applyAction(s, action);
      if (!result.ok) { errors[who]++; const key=`${who}:${action.type}:${result.reason}`; rejectionReasons[key]=(rejectionReasons[key]??0)+1; if (who==='new' && !task.self) { rejected.add(aiActionKey(action)); continue; } break; }
      rejected.clear();
      actions[who]++;
      s = result.state;
      if (action.type === 'RECRUIT') {
        budget.recruited++;
        if (who === 'new') {
          const def = s.unitTypes[action.unitType]!;
          if (def.category === 'economy') development.economy++;
          if (def.hero) development.heroes++;
        }
      }
      if (action.type === 'UPGRADE') { budget.upgraded++; if (who === 'new') development.upgrades++; }
      if (action.type === 'BUILD' && who === 'new') development.buildings++;
    }
    if (steps === AI_MAX_STEPS) capHits++;
    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) throw new Error(`END_TURN failed: ${end.reason}`);
    s = end.state;
  }
  return { profile: task.profile, seed: task.seed, newSide, config, version: s.version,
    outcome: s.winner === null ? 'unresolved' : s.winner === newSide ? 'win' : 'loss',
    winner: s.winner, turns: s.turn, errors, rejectionReasons, actions, decisionMs: ms, capHits,
    doctrine, switches, largestWeightStep, abandonment, development,
    final: (['A', 'B'] as const).map(side => ({ side, gold: s.players[side].gold, income: incomeOf(s, side),
      cities: s.cities.filter(c => c.owner === side).map(c => ({ id: c.id, era: c.era, ruined: !!c.ruined })),
      units: s.units.filter(u => u.owner === side).length })) };
}
type Game = ReturnType<typeof game>;

/** Pair is the independent sampling unit. Unresolved games score zero new wins. */
export function summarize(games: Game[]) {
  const wins = games.filter(g => g.outcome === 'win').length;
  const losses = games.filter(g => g.outcome === 'loss').length;
  const unresolved = games.length - wins - losses;
  const pairMap = new Map<string, Game[]>();
  for (const g of games) {
    const key = `${g.profile}:${g.seed}`;
    const pair = pairMap.get(key) ?? [];
    if (pair.some(p => p.newSide === g.newSide)) throw new Error('Duplicate seat');
    pair.push(g); pairMap.set(key, pair);
  }
  const pairs = [...pairMap.values()];
  if (pairs.some(p => p.length !== 2)) throw new Error('Incomplete seat pair');
  const pairRates = pairs.map(p => p.filter(g => g.outcome === 'win').length / 2);
  let random = 0x6c8e9cf5;
  const sample = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) / 4294967296; };
  const bootstrap: number[] = [];
  for (let k = 0; k < 10000; k++) {
    let rate = 0;
    for (let i = 0; i < pairs.length; i++) rate += pairRates[Math.floor(sample() * pairs.length)]!;
    bootstrap.push(rate / pairs.length);
  }
  bootstrap.sort((a,b) => a-b);
  const interval95 = [bootstrap[250]!, bootstrap[9750]!];
  const lowerBound95 = Math.max(0,wins/games.length-Math.sqrt(Math.log(20)/(2*pairs.length)));
  return { games: games.length, pairs: pairs.length, wins, losses, unresolved,
    observedWinRate: wins / games.length, decisiveWinRate: wins + losses ? wins / (wins + losses) : null,
    pairedBootstrap95: interval95,
    pairedHoeffdingLower95: lowerBound95,
    clearlyBetter: pairs.length >= 32 && wins / games.length >= 0.60 && interval95[0]! > 0.50 && lowerBound95>0.50,
    errors: { new: games.reduce((n,g) => n+g.errors.new,0), old: games.reduce((n,g) => n+g.errors.old,0) },
    meanTurns: games.reduce((n,g) => n+g.turns,0)/games.length,
    meanDecisionMs: Object.fromEntries((['new','old'] as const).map(w => [w, games.reduce((n,g) => n+g.decisionMs[w],0)/Math.max(1,games.reduce((n,g) => n+g.actions[w],0))])),
    doctrineTurns: Object.fromEntries((['rush','harass','boom'] as const).map(d => [d,games.reduce((n,g) => n+g.doctrine[d],0)])),
    gamesWithAbandonment: games.filter(g => g.abandonment.length > 0).length };
}

function fingerprint(): string {
  const files = fs.readdirSync(path.join(root, 'src/core'), { recursive: true }).map(String).filter(p => p.endsWith('.ts')).sort();
  return digest(files.map(p => `${p}\0${read(`src/core/${p}`)}`).join('\0') + read('scripts/evaluate-ai.ts') + read('scripts/baselines/ai-004d48a.ts') + read('src/main.ts') + read('package.json') + read('package-lock.json'));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string, fallback: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i+1] ?? ''; };
  const count = Number(option('pairs', '8')), seed = Number(option('seed', '90000'));
  const cap = Number(option('cap', '200')), workers = Number(option('workers', '4'));
  if (![count, seed, cap, workers].every(n => Number.isSafeInteger(n) && n > 0) || workers > 16 || count>1000) throw new Error('Expected positive integer arguments; workers <= 16, pairs <= 1000');
  const selected = option('profiles', Object.keys(profiles).join(',')).split(',');
  if (new Set(selected).size !== selected.length || selected.some(p => !profiles[p])) throw new Error('Unknown or repeated profile');
  const output = path.resolve(root, option('out', 'results/ai-evaluation.json'));
  if (fs.existsSync(output)) throw new Error('Output exists; use a new run name');
  const baselineMeta = JSON.parse(read('scripts/baselines/ai-004d48a.json')) as { sha256: string; commit: string };
  if (digest(read('scripts/baselines/ai-004d48a.ts').replaceAll("from '../../src/core/", "from './")) !== baselineMeta.sha256) throw new Error('Frozen baseline hash mismatch');
  const before = fingerprint();
  // Different profiles get disjoint seeds; the two seats of each pair share a seed.
  const tasks = selected.flatMap(profile => Array.from({ length: count }, (_,i) => ({ profile, seed: seed+Object.keys(profiles).indexOf(profile)*1000+i, cap, self: args.includes('--self') })));
  const games: Game[] = [];
  let next = 0, finished = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, () => new Promise<void>((resolve,reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: true });
    let done = false;
    const send = () => {
      const task = tasks[next++];
      if (!task) { done = true; void worker.terminate(); resolve(); }
      else worker.postMessage(task);
    };
    worker.on('message', (pair: Game[]) => {
      games.push(...pair); finished++;
      process.stdout.write(`${finished}/${tasks.length} ${pair[0]!.profile} seed=${pair[0]!.seed} ${pair.map(g => `${g.newSide}:${g.outcome}/${g.turns}`).join(' ')}\n`);
      send();
    });
    worker.on('error', reject);
    worker.on('exit', code => { if (!done && code !== 0) reject(new Error(`Worker exit ${code}`)); });
    send();
  })));
  if (fingerprint() !== before) throw new Error('Source changed during evaluation; output refused');
  games.sort((a,b) => a.profile.localeCompare(b.profile) || a.seed-b.seed || a.newSide.localeCompare(b.newSide));
  const report = { schema: 1, baseline: baselineMeta, fingerprint: before, args, cap, maxSteps: AI_MAX_STEPS, budget: DEFAULT_BUDGET,
    acceptance: 'At least 32 independent seed pairs; observed wins / ALL games >= 60%; paired bootstrap and one-sided distribution-free Hoeffding 95% lower bounds > 50%. Unresolved are not draws or wins.',
    elapsedSeconds: (performance.now()-start)/1000, summary: summarize(games),
    byProfile: Object.fromEntries(selected.map(p => [p,summarize(games.filter(g => g.profile===p))])), games };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n', { flag: 'wx' });
  console.log(JSON.stringify(report.summary,null,2));
  console.log(output);
}

if (!isMainThread && workerData) parentPort!.on('message', (task: Task) => parentPort!.postMessage([game(task,'A'),game(task,'B')]));
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
