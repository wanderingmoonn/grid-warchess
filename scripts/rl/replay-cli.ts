/**
 * 重放器的命令行入口。三个子命令，对应"同一局数据"的三种来源：
 *
 *   record  自博弈/对 AI 录一局，落成 `<out>/seed-<seed>.json`
 *   replay  重放录下来的记录，逐层核对（动作 / logp / 指纹 / 终局）
 *   report  重放**游戏上传的对局报告**（v3 自带 seed + 配置 + 动作序列）
 *
 * 为什么 report 单独一个子命令：报告的字段是"玩家的那一局"，不是"训练的轨迹"——
 * 里面没有 logp、也没有权重，能验的只有"动作序列能不能推出同一份终局报告"。
 * 两层混在一起写，报错时会分不清是"规则变了"还是"网络变了"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rl/replay-cli.ts record --games 5 --seed0 7000
 *   node --experimental-strip-types scripts/rl/replay-cli.ts replay --dir .tmp/rl-records
 *   node --experimental-strip-types scripts/rl/replay-cli.ts report --file reports-sample.json
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  recordMatch,
  replayRecord,
  replayReport,
  weightsFingerprint,
  type DriverKind,
  type MatchRecord,
} from './replay.ts';
import { weightsFromJson } from './policy.ts';
import { TRAIN } from './config.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'report';
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const OUT_DIR = argOf('out', path.join('.tmp', 'rl-records'));

/** 读权重 + 算指纹：指纹用来判断"这份记录是不是用这份权重录的" */
function loadWeights(file: string) {
  const text = fs.readFileSync(file, 'utf8');
  return { weights: weightsFromJson(JSON.parse(text)), sha1: weightsFingerprint(text) };
}

if (cmd === 'record') {
  const games = Number(argOf('games', '3'));
  const seed0 = Number(argOf('seed0', '7000'));
  const weightsFile = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
  const drivers = argOf('drivers', 'policy,ai').split(',') as [DriverKind, DriverKind];
  const topK = Number(argOf('topk', '0'));
  const temp = Number(argOf('temp', '1'));
  const every = Number(argOf('every', '50'));

  const loaded = fs.existsSync(weightsFile) ? loadWeights(weightsFile) : null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  for (let i = 0; i < games; i++) {
    const seed = seed0 + i;
    const t0 = performance.now();
    const rec = recordMatch({
      seed,
      size: Number(argOf('size', String(TRAIN.size))),
      expansions: TRAIN.expansions,
      drivers,
      weights: loaded?.weights,
      weightsFile,
      weightsSha1: loaded?.sha1,
      topK: topK || undefined,
      temperature: temp,
      checkpointEvery: every,
    });
    const file = path.join(OUT_DIR, `seed-${seed}.json`);
    fs.writeFileSync(file, JSON.stringify(rec));
    ok += 1;
    console.log(
      `  seed ${seed}: ${rec.steps.length} 步 / ${rec.result.turns} 回合 / 赢家 ${rec.result.winner ?? '平'} ` +
        `/ 指纹 ${rec.result.hash} · ${((performance.now() - t0) / 1000).toFixed(1)}s → ${file}`,
    );
  }
  console.log(`\n录了 ${ok} 局 → ${OUT_DIR}`);
} else if (cmd === 'replay') {
  const one = argOf('file', '');
  const dir = argOf('dir', OUT_DIR);
  const weightsFile = argOf('weights', path.join('scripts', 'rl', 'weights', 'init.json'));
  const files = one
    ? [one]
    : fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => path.join(dir, f))
      : [];
  if (files.length === 0) {
    console.error(`没找到可重放的记录（${one || dir}）。先用 record 录一局。`);
    process.exit(1);
  }
  const loaded = fs.existsSync(weightsFile) ? loadWeights(weightsFile) : null;
  let bad = 0;
  let logpMax = 0;
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8')) as MatchRecord;
    const rep = replayRecord(rec, loaded?.weights);
    logpMax = Math.max(logpMax, rep.logpMaxDiff);
    const tag = rep.ok ? '✓' : '✗';
    console.log(
      `  ${tag} ${path.basename(f)}  seed ${rep.seed} · ${rep.steps} 步 · 指纹 ${rep.final.got}` +
        ` · 终局 ${rep.result.got.winner ?? '平'}/${rep.result.got.turns} 回合 · logp 最大偏差 ${rep.logpMaxDiff.toExponential(1)}`,
    );
    if (!rep.ok) {
      bad += 1;
      const d = rep.firstDivergence;
      if (d) console.log(`      第一处分叉：第 ${d.step} 步（${d.seat}）${d.kind} —— ${d.detail}`);
      else console.log(`      终局指纹不同：记录 ${rep.final.expected} / 重算 ${rep.final.got}`);
      if (!rep.result.match) {
        console.log(
          `      终局结果不同：记录 ${JSON.stringify(rep.result.expected)} / 重算 ${JSON.stringify(rep.result.got)}`,
        );
      }
    }
    if (!rep.logpChecked) console.log(`      （${rep.note}）`);
  }
  console.log(`\n重放 ${files.length} 局：一致 ${files.length - bad}，不一致 ${bad}；logp 最大偏差 ${logpMax.toExponential(2)}`);
  process.exit(bad === 0 ? 0 : 2);
} else if (cmd === 'report') {
  const file = argOf('file', 'reports-sample.json');
  const only = Number(argOf('index', '-1'));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.reports ?? [raw]);
  const targets = only >= 0 ? [list[only]] : list;
  let bad = 0;
  for (const [i, report] of targets.entries()) {
    const idx = only >= 0 ? only : i;
    try {
      const rep = replayReport(report);
      const tag = rep.ok ? '✓' : '✗';
      console.log(`  ${tag} #${idx} seed ${rep.seed} · ${rep.steps} 步 · build ${report.build ?? '?'} v${report.v}`);
      if (!rep.ok) {
        bad += 1;
        for (const d of rep.diffs.slice(0, 6)) console.log(`      ${d}`);
        if (rep.diffs.length > 6) console.log(`      …还有 ${rep.diffs.length - 6} 处`);
      }
    } catch (err) {
      bad += 1;
      console.log(`  ✗ #${idx} 无法重放：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n报告重放 ${targets.length} 份：一致 ${targets.length - bad}，不一致 ${bad}`);
  process.exit(bad === 0 ? 0 : 2);
} else {
  console.error(`不认识的子命令：${cmd}（record / replay / report）`);
  process.exit(1);
}
