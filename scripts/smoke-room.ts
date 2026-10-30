/**
 * 联机房间的联调脚本（不是常规测试，需要真实云端）。
 *
 * 它跑的是 src/net/room.ts 里那套函数，和浏览器里用的是同一份代码：
 * 建房间 → 拉取 → 抢席位 → 提交 → 再拉取 → 撞车保护。
 *
 * 运行：node --experimental-strip-types scripts/smoke-room.ts
 */

import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { remainingUnits } from '../src/core/draft.ts';
import {
  claimSeat,
  createRoom,
  fetchRoom,
  newToken,
  submitDraft,
  submitTurn,
} from '../src/net/room.ts';

const state = createMatch(DEFAULT_CONFIG, 20260101);
const tokenA = newToken();
const tokenB = newToken();

const seat = await createRoom(state, 'A', tokenA);
console.log('房间码', seat.code);

const first = await fetchRoom(seat.code);
if (!first) throw new Error('建完立刻读不到，写入有问题');
console.log('初始', { turn: first.turn, current: first.current, units: first.state.units.length, seats: first.seats });
if (first.current !== 'A' || first.state.units.length !== state.units.length) throw new Error('初始状态不对');

console.log('B 抢座', await claimSeat(seat.code, 'B', tokenB));
const againA = await claimSeat(seat.code, 'A', tokenB);
console.log('B 想抢 A 的座', againA);
if (againA !== 'taken') throw new Error('席位没挡住');
const reconfirmA = await claimSeat(seat.code, 'A', tokenA);
if (reconfirmA !== 'ok') throw new Error('自己回到原席位应该成功');

// A 走完一回合再提交
const prevTurn = state.turn;
const moved = state.units.find((u) => u.owner === 'A' && u.type === 'militia');
if (moved) moved.hp = Math.max(1, moved.hp - 3); // 造一个可见的变化
const ended = applyAction(state, { type: 'END_TURN' });
if (!ended.ok) throw new Error(ended.reason);
console.log('提交', await submitTurn(seat.code, ended.state, prevTurn));

const second = await fetchRoom(seat.code);
console.log('提交后', { turn: second?.turn, current: second?.current });
if (!second || second.current !== 'B' || second.turn <= prevTurn) throw new Error('提交后状态不对');

console.log('用过期的回合号再提交一次', await submitTurn(seat.code, ended.state, prevTurn));
if (await submitTurn(seat.code, ended.state, prevTurn)) throw new Error('撞车保护失效了');

/* ---------------------------------------------------------------------------
 * 联机 BP：两台机器轮流在同一把锁上提交
 *
 * 这一段是真刀真枪的协议验证，不是"函数能不能跑"：
 *   1. 建房时 turn 列存的是**进度号**（不是回合数 1）；
 *   2. 每一步都用"我看到的进度号"做乐观锁，过期的号必须被挡；
 *   3. 被挡之后重新拉、把这一步补到最新状态上，还能交上去（禁用期双方同时提交）；
 *   4. 选完之后 turn 交还给 1，正常对局的那把锁完好无损。
 * ------------------------------------------------------------------------- */

const bpBase = createMatch(
  { ...DEFAULT_CONFIG, size: 12, expansionIds: ['naval-fleet'], draftMode: true },
  20260102,
);
const bpRoom = await createRoom(bpBase, 'A', tokenA);
const bpRow = await fetchRoom(bpRoom.code);
console.log('\nBP 房间', bpRoom.code, '锁 =', bpRow?.turn, '进度号 =', bpBase.draft?.seq);
if (!bpRow) throw new Error('BP 房间建完读不到');
if (bpRow.turn !== bpBase.draft!.seq) throw new Error('建房时 turn 列应该是进度号，不是回合数');

let bp = bpBase;
const seq0 = bp.draft!.seq;
const aBan = applyAction(bp, { type: 'DRAFT_BAN', unitId: bp.draft!.pool[0]!, at: bp.draft!.deadline }, 'A');
if (!aBan.ok) throw new Error(aBan.reason);
bp = aBan.state;
if (!(await submitDraft(bpRoom.code, bp, seq0))) throw new Error('A 的禁用没交上去');

// B 在自己那台机器上：先拉最新，再禁
let remote = (await fetchRoom(bpRoom.code))!;
const seq1 = remote.state.draft!.seq;
if (seq1 !== seq0 + 1) throw new Error('A 提交后进度号应该 +1');
const bBan = applyAction(
  remote.state,
  { type: 'DRAFT_BAN', unitId: remote.state.draft!.pool[1]!, at: remote.state.draft!.deadline },
  'B',
);
if (!bBan.ok) throw new Error(bBan.reason);
if (!(await submitDraft(bpRoom.code, bBan.state, seq1))) throw new Error('B 的禁用没交上去');

// 拿已经过期的进度号再交一次：必须被挡（这就是"不会互相覆盖"的保证）
if (await submitDraft(bpRoom.code, bBan.state, seq0)) throw new Error('过期进度号居然也能交');

// 被挡之后的标准动作：拉最新 + 把自己的这一步补上去 + 用新号重交
remote = (await fetchRoom(bpRoom.code))!;
const merged = applyAction(
  remote.state,
  { type: 'DRAFT_PICK', unitId: remote.state.draft!.pool[3]!, at: remote.state.draft!.deadline },
  remote.state.draft!.order[remote.state.draft!.step]!,
);
if (!merged.ok) throw new Error(merged.reason);
if (!(await submitDraft(bpRoom.code, merged.state, remote.state.draft!.seq))) {
  throw new Error('合并之后仍然交不上去');
}

// 剩下的步数：谁该选谁就拉最新、选一个、交上去
for (let guard = 0; guard < 40; guard++) {
  const snap = await fetchRoom(bpRoom.code);
  if (!snap) throw new Error('房间丢了');
  if (snap.state.draft!.phase === 'done') break;
  const d = snap.state.draft!;
  const side = d.order[d.step]!;
  const left = remainingUnits(snap.state);
  const pick = applyAction(
    snap.state,
    { type: 'DRAFT_PICK', unitId: left[0]!, at: d.deadline },
    side,
  );
  if (!pick.ok) throw new Error(pick.reason);
  if (!(await submitDraft(bpRoom.code, pick.state, d.seq))) throw new Error(`${side} 第 ${d.step} 步没交上去`);
}

const done = (await fetchRoom(bpRoom.code))!;
const finalDraft = done.state.draft!;
console.log('BP 结束', {
  phase: finalDraft.phase,
  a: finalDraft.picks.A.length,
  b: finalDraft.picks.B.length,
  锁: done.turn,
  进度号: finalDraft.seq,
});
if (finalDraft.phase !== 'done') throw new Error('BP 没打完');
if (finalDraft.picks.A.length !== finalDraft.pickSlots) throw new Error('甲方名单数量不对');
if (finalDraft.picks.B.length !== finalDraft.pickSlots) throw new Error('乙方名单数量不对');
if (done.turn !== 1) throw new Error('BP 结束后 turn 要交还给 1，否则正常对局那把锁是坏的');

console.log('\n全部通过。测试房间码：', seat.code, '/ BP', bpRoom.code);
