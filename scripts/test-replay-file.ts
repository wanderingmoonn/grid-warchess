/**
 * 复盘的核心用例：**一份报告文件能不能把那一局原样走回来**。
 *
 * 这条链上有三个容易坏的地方，各来一条：
 *   1. 报告里存的 `config` 和开局参数对不上 → 第 N 步就废；
 *   2. `stateAt(i)` 往回跳时算错关键帧 → 拖进度条会看到错位的局面；
 *   3. 老报告（没有 config）只能"重建"，这件事必须**被说出来**，
 *      而不是悄悄给一份看起来一样的假棋。
 *
 * 用法：`npm run test:replay`
 */
import assert from 'node:assert/strict';
import { applyAction } from '../src/core/rules.ts';
import { buildMatchReport } from '../src/core/report.ts';
import { buildReplay, buildReplayFromText, parseReplayFile } from '../src/core/replay-file.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import type { Action, GameState } from '../src/core/types.ts';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

/**
 * 打一小局（两边都由手写 AI 走），返回终局和完整动作序列。
 *
 * 为什么要真打而不是拼一串 END_TURN：复盘的难点全在"动作里有单位、有坐标、
 * 有兵种"，一串回合结束走不出 RECRUIT/MOVE/ATTACK 那几条分支。
 */
function playSome(seed: number, cap = 26): { state: GameState; actions: Action[] } {
  let s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 10,
      startEra: 1,
      playerCount: 2,
      draftMode: false,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['bloodbath'],
      aiLevel: 'advanced',
    },
    seed,
  );
  s.fog = false;
  const actions: Action[] = [];
  let turnSeat: string | null = null;
  let inTurn = 0;
  let budget = { ...DEFAULT_BUDGET };
  let rejected = new Set<string>();

  while (!s.winner && s.turn <= cap) {
    const seat = s.current;
    if (seat !== turnSeat) {
      turnSeat = seat;
      inTurn = 0;
      budget = { ...DEFAULT_BUDGET };
      rejected = new Set();
    }
    const picked = inTurn >= AI_MAX_STEPS ? null : aiNextAction(s, budget, rejected);
    if (!picked) {
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      actions.push({ type: 'END_TURN' });
      s = end.state;
      inTurn += 1;
      continue;
    }
    if (picked.type === 'RECRUIT') budget.recruited += 1;
    if (picked.type === 'UPGRADE') budget.upgraded += 1;
    const r = applyAction(s, picked);
    if (!r.ok) {
      rejected.add(JSON.stringify(picked));
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) break;
      actions.push({ type: 'END_TURN' });
      s = end.state;
      inTurn += 1;
      continue;
    }
    actions.push(picked);
    s = r.state;
    inTurn += 1;
  }
  return { state: s, actions };
}

const seed = 4321;
const played = playSome(seed);
const report = buildMatchReport(played.state, new Date('2026-11-05T00:00:00Z'), null, played.actions);
const text = JSON.stringify(report);

test('报告里带上了能还原开局的那一份配置', () => {
  assert.ok(report.config, '报告应当带 config');
  assert.equal(report.config!.size, 10);
  assert.deepEqual(report.config!.expansionIds, ['bloodbath']);
  assert.ok(report.fog === false, '迷雾状态也要记下来');
  assert.ok((report.actions ?? []).length > 10, `动作序列太短：${(report.actions ?? []).length}`);
});

test('完整走回来：步数一致、终局一致、兵力一致', () => {
  const built = buildReplayFromText(text);
  assert.ok(built.ok, built.ok ? '' : built.reason);
  if (!built.ok) return;
  const s = built.session;
  assert.equal(s.meta.exact, true, '新报告应当是"原样还原"，不是重建');
  assert.equal(s.applied, played.actions.length, '每一步都该被引擎接受');
  assert.equal(s.stopReason, null);
  assert.equal(s.finalState.winner, played.state.winner, '终局胜方要一致');
  assert.equal(s.finalState.turn, played.state.turn, '回合数要一致');
  assert.equal(s.finalState.units.length, played.state.units.length, '终局兵力要一致');
  assert.equal(s.finalMatches, true);
});

test('逐帧能对上：第 i 帧 == 手动走 i 步', () => {
  const built = buildReplayFromText(text);
  assert.ok(built.ok);
  if (!built.ok) return;
  // 随便挑几个位置，其中包含"往回跳"（关键帧是每 24 步一个）
  for (const i of [0, 1, 5, 12, 13, 24, 25, 3]) {
    const frame = built.session.stateAt(i);
    let manual = createMatch(report.config!, seed);
    for (let k = 0; k < i; k++) {
      const r = applyAction(manual, played.actions[k]!);
      assert.ok(r.ok, `手动第 ${k + 1} 步就失败了`);
      manual = r.state;
    }
    assert.equal(frame.turn, manual.turn, `第 ${i} 帧的回合数不对`);
    assert.deepEqual(
      frame.units.map((u) => `${u.id}@${u.x},${u.y}:${u.hp}`),
      manual.units.map((u) => `${u.id}@${u.x},${u.y}:${u.hp}`),
      `第 ${i} 帧的兵力对不上`,
    );
    assert.equal(frame.players.A.gold, manual.players.A.gold, `第 ${i} 帧的金币对不上`);
  }
});

test('往回拖再往前拖，结果还是同一帧（关键帧跳转不许算错）', () => {
  const built = buildReplayFromText(text);
  assert.ok(built.ok);
  if (!built.ok) return;
  const s = built.session;
  const later = s.stateAt(28);
  const stamp = later.units.map((u) => `${u.id}@${u.x},${u.y}:${u.hp}`).join('|');
  for (const back of [0, 7, 24, 1]) {
    s.stateAt(back);
    const again = s.stateAt(28);
    assert.equal(
      again.units.map((u) => `${u.id}@${u.x},${u.y}:${u.hp}`).join('|'),
      stamp,
      `从第 ${back} 帧跳回第 28 帧之后对不上了`,
    );
  }
});

test('老报告（没有 config）只能重建，而且会说出来', () => {
  const old = { ...report } as Record<string, unknown>;
  delete old.config;
  delete old.fog;
  const built = buildReplay(JSON.parse(JSON.stringify(old)));
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(built.session.meta.exact, false, '没有 config 就必须标成"重建"');
  assert.ok(
    built.session.warnings.some((w) => w.includes('旧格式')),
    '重建必须带一条提示，不能悄悄给一份看起来一样的棋',
  );
});

test('中途对不上就停在那一刻，并说明是第几步', () => {
  const broken = JSON.parse(text) as Record<string, unknown>;
  const acts = (broken.actions as Action[]).slice();
  // 把中间某一步换成一个这一刻绝不合法的动作：让它在第 4 步卡住
  acts[3] = { type: 'UPGRADE', cityId: 'no-such-city' };
  broken.actions = acts;
  const built = buildReplay(broken);
  assert.ok(built.ok, '构造失败本身不是错：能走到第 3 步就算对');
  if (!built.ok) return;
  assert.equal(built.session.applied, 3, '应当停在坏掉那一步之前');
  assert.ok(built.session.stopReason?.includes('第 4 步'), `原因要指名第几步：${built.session.stopReason}`);
  assert.ok(built.session.warnings.length > 0, '提示行要能看到');
});

test('拖进来的不是对局数据时，理由要说得具体', () => {
  assert.equal(parseReplayFile('not json').ok, false);
  const noSeed = parseReplayFile(JSON.stringify({ actions: [1] }));
  assert.ok(!noSeed.ok && noSeed.reason.includes('种子'), '缺种子要说缺种子');
  const noActions = parseReplayFile(JSON.stringify({ seed: 1 }));
  assert.ok(!noActions.ok && noActions.reason.includes('动作序列'), '缺动作要说缺动作序列');
});

test('报告体积：一局三十步的配置+动作还在可接受的量级', () => {
  const bytes = Buffer.byteLength(text, 'utf8');
  // 一步约 50 字节；config 里的 enabledUnits 是最大的一块（几百个 id）。
  // 这条不是"越小越好"，是"别一不小心把它撑到几百 KB"——库里有 256 KB 上限。
  assert.ok(bytes < 120_000, `这份报告 ${bytes} 字节，太大了`);
  console.log(`     · ${played.actions.length} 步 / ${(bytes / 1024).toFixed(1)} KB`);
});

console.log(`\n${passed} 项复盘用例通过`);
