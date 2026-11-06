/**
 * 上线用的那份策略网络权重，能不能被产品「原样」加载并下完一局。
 *
 * ── 这个文件在防什么 ────────────────────────────────────────────────────
 *
 * 1. **两份权重文件漂了。**
 *    训练产物在 `scripts/rl/weights/v2-specialist.json`，产品读的是
 *    `public/ai/net-v2.json`。复制一次没问题，问题在"下次又训了一版、
 *    只换了一边"——线上跑的还是旧脑子，而所有离线评估都是新数字。
 *    这里直接按字节比。
 *
 * 2. **维度和编码器对不上。**
 *    权重里写了 `spec.state / spec.action`。它们必须等于 `features.ts` 导出的
 *    `STATE_DIM / ACTION_DIM`。这两个数任何一边单独改（加一个特征、加一类动作）
 *    都不会报错：`Policy` 会把数组按新长度读，读出来的是一片错位的垃圾，
 *    表现是"棋力莫名下降"，而不是崩溃。
 *
 * 3. **产品路径下根本走不动。**
 *    离线评估用的是 eval.ts 的循环，产品用的是 main.ts 里那套
 *    （`netNextAction` + 每回合 AI_MAX_STEPS 步 + 被拒就重挑）。这里按产品的
 *    口径真打一局：**开雾**、10×10、青铜开局、两边都是网络内核。
 *    顺带钉住"开雾时它照样有动作"——它不看 `playerView`，这是刻意保留的能力
 *    （见 rl/brain.ts 的说明），不是漏了遮蔽。
 *
 * 用法：`npm run test:net`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { AI_MAX_STEPS } from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { Action, GameState, PlayerId } from '../src/core/types.ts';
import { installNetPolicy, netNextAction, mulberry32 } from '../src/rl/brain.ts';
import { ACTION_DIM, STATE_DIM } from '../src/rl/features.ts';
import { weightsFromJson } from '../src/rl/policy.ts';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

const PUBLISHED = path.join('public', 'ai', 'net-v2.json');
const TRAINED = path.join('scripts', 'rl', 'weights', 'v2-specialist.json');

const publishedRaw = fs.readFileSync(PUBLISHED);
const trainedRaw = fs.readFileSync(TRAINED);

test('线上那份权重和训练产物逐字节一致', () => {
  assert.equal(
    publishedRaw.length,
    trainedRaw.length,
    `${PUBLISHED}（${publishedRaw.length}B）和 ${TRAINED}（${trainedRaw.length}B）长度就不一样，` +
      '说明只换了一边——重新 cp 一次再发版',
  );
  assert.ok(publishedRaw.equals(trainedRaw), `${PUBLISHED} 和训练产物内容不一致：把训练产物重新复制过去`);
  console.log(`    权重 ${(publishedRaw.length / 1024).toFixed(0)} KB`);
});

const rawJson = JSON.parse(publishedRaw.toString('utf8')) as { version?: number; spec?: Record<string, number> };

test('权重里的 spec 和编码器的维度对得上', () => {
  assert.equal(rawJson.version, 2, 'WEIGHTS_VERSION 必须是 2（v1 的动作空间没有 BUILD/LOAD/HERO_SKILL）');
  const spec = rawJson.spec ?? {};
  assert.equal(spec.state, STATE_DIM, `权重按 ${spec.state} 维观测训练，编码器现在是 ${STATE_DIM} 维`);
  assert.equal(spec.action, ACTION_DIM, `权重按 ${spec.action} 维动作训练，枚举器现在是 ${ACTION_DIM} 维`);
  assert.equal(spec.joint, STATE_DIM + ACTION_DIM, 'joint 必须等于 state + action');
});

/** 一局里两边都是网络内核，按**产品**那套口径走（见 main.ts 的 runAiTurn） */
function playNetVsNet(seed: number, cap = 60): {
  state: GameState;
  actions: number;
  rejected: number;
  kinds: Record<string, number>;
} {
  let s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 10,
      startEra: 1,
      playerCount: 2,
      draftMode: false,
      aiOpponent: true,
      aiAlly: false,
      aiBrain: 'net',
      aiLevel: 'advanced',
      expansionIds: ['bloodbath', 'turn-order-comp'],
    },
    seed,
  );
  // 迷雾就用开局默认的那份（captureConfig.fogDefault = true）：要测的正是"开着雾它还走不走"
  const policy = installNetPolicy(weightsFromJson(JSON.parse(publishedRaw.toString('utf8'))));

  // 一局一家一条随机流，和 main.ts 的 netRands 同构
  const rands = new Map<PlayerId, () => number>();
  const randFor = (seat: PlayerId): (() => number) => {
    let r = rands.get(seat);
    if (!r) {
      r = mulberry32((seed * 2654435761 + (seat === 'A' ? 1 : 2)) >>> 0);
      rands.set(seat, r);
    }
    return r;
  };

  const kinds: Record<string, number> = {};
  let actions = 0;
  let rejected = 0;
  let turnSeat: PlayerId | null = null;
  let inTurn = 0;
  let avoid = new Set<string>();
  let guard = 0;

  while (!s.winner && s.turn <= cap) {
    if (++guard > 20000) {
      throw new Error(`走了 ${guard} 步还没结束（种子 ${seed}）：有动作没推进局面`);
    }
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      avoid = new Set();
    }
    if (inTurn >= AI_MAX_STEPS) {
      const end = applyAction(s, { type: 'END_TURN' });
      assert.ok(end.ok, '到了每回合的步数上限却结束不了回合');
      s = end.state;
      inTurn += 1;
      continue;
    }
    const action: Action | null = netNextAction(s, seat, randFor(seat), policy, avoid);
    if (!action) {
      const end = applyAction(s, { type: 'END_TURN' });
      assert.ok(end.ok, '这一方没动作可走，却也结束不了回合');
      s = end.state;
      inTurn += 1;
      continue;
    }
    const r = applyAction(s, action);
    if (!r.ok) {
      // 产品的做法是"记下来、下一步避开"，而不是抛错。这里同样不抛，只计数。
      rejected += 1;
      avoid.add(JSON.stringify(action));
      assert.ok(rejected <= 20, `被拒的动作太多（${rejected} 个），枚举器和规则已经漂了`);
      continue;
    }
    avoid.clear();
    s = r.state;
    actions += 1;
    inTurn += 1;
    kinds[action.type] = (kinds[action.type] ?? 0) + 1;
  }

  return { state: s, actions, rejected, kinds };
}

test('开雾的 10×10 上，网络内核能自己下完一局（两边都是它）', () => {
  const t0 = Date.now();
  const { state, actions, rejected, kinds } = playNetVsNet(20261106);
  const ms = Date.now() - t0;

  assert.equal(state.fog, true, '这一局必须开着迷雾——不然测的不是产品口径');
  assert.equal(rejected, 0, `有 ${rejected} 个动作被规则拒了：枚举和规则漂了`);
  assert.ok(actions > 100, `只走了 ${actions} 步，不像一局完整的棋`);

  // 只会"一直结束回合"的网络也能下完一局，所以这里要看它真的在干这几件事
  assert.ok((kinds.RECRUIT ?? 0) > 0, '一局下来一个兵都没造');
  assert.ok((kinds.MOVE ?? 0) > 0, '一局下来一步都没走');
  assert.ok((kinds.ATTACK ?? 0) > 0, '一局下来一次都没打——这不像跟自己对打');

  console.log(
    `    ${actions} 步 / ${state.turn} 回合 / ${state.winner ? `${state.winner} 座胜` : '到回合上限未决'} / ` +
      `${ms}ms`,
  );
  console.log(
    `    动作构成：${Object.entries(kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
  );
});

test('同一个种子跑两遍，走出来的棋一模一样', () => {
  /*
   * 产品里存档、复盘、双 AI 观战都靠这条：网络内核的随机性必须全部来自
   * 那条从 seed 派生的流。只要有一处摸到 Math.random，这里就会分叉。
   */
  const a = playNetVsNet(4242, 30);
  const b = playNetVsNet(4242, 30);
  assert.equal(a.actions, b.actions, '两次的步数不一样');
  assert.equal(a.state.turn, b.state.turn, '两次的回合数不一样');
  assert.equal(a.state.winner, b.state.winner, '两次的胜负不一样');
});

console.log(`\n${passed} 条用例全部通过`);
