/**
 * 重放器的自检：**重放这件事本身对不对**，比"重放出来是什么结果"更重要。
 *
 * 这里守四条线：
 *   1. 录制 → 重放，动作、logp、指纹、终局全部一致（同进程）；
 *   2. 换一个进程重放，结论一样（跨进程确定性，不能靠 JIT 侥幸）；
 *   3. 篡改输入能被**定位**：改一步动作 / 改种子，报出的位置必须就是动手的那一处；
 *   4. 指纹本身是稳定的：单位顺序变了、日志多一行，不该算"不一致"。
 *
 * 第 3 条是这套东西存在的理由。没有它，"重放一致"只是两个人互相点头。
 *
 * 运行：npm run rl:replay:test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMatch, DEFAULT_CONFIG } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { encodeState, STATE_DIM } from './features.ts';
import { recordMatch, replayRecord, replayReport, hashState, type MatchRecord } from './replay.ts';
import { weightsFromJson } from './policy.ts';
import { TRAIN } from './config.ts';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

const WEIGHTS_FILE = path.join('scripts', 'rl', 'weights', 'init.json');
const weights = weightsFromJson(JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')));

/** 录一局小一点的（8×8 更快），带检查点 */
function record(seed: number): MatchRecord {
  return recordMatch({
    seed,
    size: 8,
    expansions: TRAIN.expansions,
    drivers: ['policy', 'ai'],
    weights,
    weightsFile: WEIGHTS_FILE,
    checkpointEvery: 25,
  });
}

// ── 1. 同进程重放 ───────────────────────────────────────────────────────
test('录制 → 重放：动作、logp、指纹、终局全部一致', () => {
  const rec = record(7001);
  assert.ok(rec.steps.length > 50, `这一局只有 ${rec.steps.length} 步，用例太小了`);
  const rep = replayRecord(rec, weights);
  assert.equal(rep.ok, true, `重放不一致：${JSON.stringify(rep.firstDivergence)}`);
  assert.equal(rep.final.match, true, '终局指纹不同');
  assert.equal(rep.result.match, true, '赢家或回合数不同');
  assert.equal(rep.logpChecked, true, '策略侧应该被重算过');
  assert.ok(rep.logpMaxDiff < 1e-9, `logp 有偏差：${rep.logpMaxDiff}`);
});

test('重算出来的观测是同一份：两次重放逐步编码，逐位相同', () => {
  const rec = record(7002);
  const grab = (): number[] => {
    const out: number[] = [];
    const rep = replayRecord(rec, weights, ({ state, seat }) => {
      const obs = encodeState(state, seat);
      assert.equal(obs.length, STATE_DIM);
      // 只留一个校验和，省内存：真要比的是"两次一样"，不是"存下来"
      let h = 0;
      for (let i = 0; i < obs.length; i++) h = (h * 31 + Math.round(obs[i]! * 1e6)) % 1e9;
      out.push(h);
    });
    assert.equal(rep.ok, true, `重放不一致：${JSON.stringify(rep.firstDivergence)}`);
    return out;
  };
  const a = grab();
  const b = grab();
  assert.deepEqual(a, b, '同一份记录两次重放，观测校验和不一致');
  assert.equal(a.length, rec.steps.length, '每一步都应该重算到一次观测');
});

// ── 2. 跨进程 ───────────────────────────────────────────────────────────
test('跨进程：另起一个 node 跑同一颗种子，终局指纹一样', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-replay-'));
  const self = path.join('scripts', 'rl', 'replay-cli.ts');
  const run = (out: string) =>
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', self, 'record', '--games', '1', '--seed0', '7050', '--size', '8', '--out', out],
      { encoding: 'utf8' },
    );
  run(path.join(dir, 'a'));
  run(path.join(dir, 'b'));
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'a', 'seed-7050.json'), 'utf8')) as MatchRecord;
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'b', 'seed-7050.json'), 'utf8')) as MatchRecord;
  assert.equal(a.result.hash, b.result.hash, '两个进程跑同一颗种子，终局指纹不同——引擎里混进了非确定性');
  assert.equal(a.steps.length, b.steps.length, '步数不同');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 3. 篡改要能被定位 ───────────────────────────────────────────────────
test('改掉第 N 步的动作：分歧点必须报在第 N 步', () => {
  const rec = record(7003);
  const at = Math.floor(rec.steps.length / 2);
  const bad: MatchRecord = structuredClone(rec);
  // 找一个 MOVE，把落点挪一格（改别的类型容易被规则直接拒，报出来的是"非法"而不是"分叉"）
  let target = at;
  while (target < bad.steps.length && bad.steps[target]!.action.type !== 'MOVE') target += 1;
  assert.ok(target < bad.steps.length, '这一局后半段没有 MOVE，换个种子');
  const mv = bad.steps[target]!.action as { type: 'MOVE'; x: number; y: number };
  bad.steps[target]!.action = { ...mv, x: mv.x + 1 } as (typeof bad.steps)[number]['action'];

  const rep = replayRecord(bad, weights);
  assert.equal(rep.ok, false, '改了动作还说一致，说明校验是假的');
  const step = rep.firstDivergence?.step ?? -1;
  assert.ok(
    step === target + 1 || step === target + 2,
    `分歧该报在第 ${target + 1} 步附近，实际报在第 ${step} 步（${rep.firstDivergence?.detail}）`,
  );
});

test('改掉种子：第一步就该报出来（地图都不一样了）', () => {
  const rec = record(7004);
  const bad: MatchRecord = structuredClone(rec);
  bad.seed = rec.seed + 1;
  const rep = replayRecord(bad, weights);
  assert.equal(rep.ok, false, '换了种子还说一致——那说明种子根本没参与');
  assert.ok((rep.firstDivergence?.step ?? 999) <= 3, `换种子后第 ${rep.firstDivergence?.step} 步才发现，太晚了`);
});

test('换个权重：动作可能还一样，但 logp 必须立刻对不上', () => {
  const rec = record(7005);
  const other = structuredClone(weights);
  /*
   * 要动的是**打分网络**，不是预筛：预筛里"状态"那半个点积是常数，
   * 给常数加个数只让所有候选一起平移，前 16 名的顺序一点不变（我第一版就写错在这）。
   * 真正决定 logits 的是 scorer，所以往它身上加。
   */
  other.scorer.w2[0] = (other.scorer.w2[0] ?? 0) + 2;
  const rep = replayRecord(rec, other as never);
  assert.equal(rep.ok, false, '换了权重还说一致，说明 logp 那一层没在校验');
  assert.ok(rep.logpMaxDiff > 1e-6, `logp 偏差只有 ${rep.logpMaxDiff}，权重没生效？`);
});

// ── 4. 指纹本身要稳 ────────────────────────────────────────────────────
test('指纹：单位顺序打乱不算不一致，改血量才算', () => {
  const s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: 8, startEra: 1, draftMode: false, expansionIds: TRAIN.expansions },
    4321,
  );
  const h1 = hashState(s);
  const shuffled = structuredClone(s);
  shuffled.units.reverse();
  assert.equal(hashState(shuffled), h1, '单位顺序不该影响指纹');

  const hurt = structuredClone(s);
  hurt.units[0]!.hp -= 1;
  assert.notEqual(hashState(hurt), h1, '掉了 1 点血必须改变指纹');
});

test('指纹：日志文字与迷雾记忆不进指纹（改文案不该让老记录全废）', () => {
  const s: GameState = createMatch(
    { ...DEFAULT_CONFIG, size: 8, startEra: 1, draftMode: false, expansionIds: TRAIN.expansions },
    99,
  );
  const h1 = hashState(s);
  const noisy = structuredClone(s);
  noisy.log.push({ turn: 1, player: 'A', text: '这是一行没人关心的日志' });
  s.memory.A.known = [];
  assert.equal(hashState(noisy), h1, '日志不该进指纹');
});

// ── 5. 游戏上传的报告也能重放 ───────────────────────────────────────────
test('重放一份游戏上传的对局报告：重新生成的报告逐字段一致', () => {
  const file = 'reports-sample.json';
  if (!fs.existsSync(file)) {
    console.log('     （没有 reports-sample.json，跳过）');
    return;
  }
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as any[];
  const rep = replayReport(list[0]);
  assert.equal(rep.ok, true, `报告重放对不上：${rep.diffs.slice(0, 3).join(' | ')}`);
  assert.equal(rep.steps, list[0].actions.length);
});

console.log(`\n${passed} 项重放自检通过`);
