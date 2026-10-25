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
import { claimSeat, createRoom, fetchRoom, newToken, submitTurn } from '../src/net/room.ts';

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

console.log('\n全部通过。测试房间码：', seat.code);
