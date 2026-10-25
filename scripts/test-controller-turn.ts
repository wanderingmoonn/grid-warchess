/** 外部控制器的离线集成：所有提供方均为内存函数，不调用网络。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeControllerTurn, type ControllerEvent, type ControllerTurnContext } from '../src/app/controller-turn.ts';
import type { ControllerReply, ControllerRequest, GameController } from '../src/controllers/protocol.ts';
import { CONFIG } from '../src/core/config.ts';
import { recruitCost } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, GameState } from '../src/core/types.ts';

function fixture(commanderMode = false): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, commanderMode, expansionIds: [] }, 207);
  state.tiles = Array.from({ length: state.w * state.h }, () => ({ terrain: 'plain', cityId: null }));
  state.cities = [
    { id: 'home', owner: 'A', x: 1, y: 8, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'foe', owner: 'B', x: 9, y: 0, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
  ];
  for (const city of state.cities) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      state.tiles[(city.y + dy) * state.w + city.x + dx] = { terrain: 'city', cityId: city.id };
    }
  }
  state.units = [{ id: 'own', owner: 'A', type: 'militia', x: 4, y: 5,
    hp: state.unitTypes.militia!.maxHp, kills: 0, moved: false, acted: false }];
  state.players.A.gold = 1000;
  state.players.B.gold = 1000;
  state.fog = true;
  state.log = [];
  state.memory = { A: { known: [] }, B: { known: [] } };
  state.orders = commanderMode ? { A: ['militia'] } : undefined;
  return state;
}

function harness(initial = fixture()) {
  const h = { state: initial, active: true, saves: 0, writes: 0, renders: 0, events: [] as ControllerEvent[] };
  const context: ControllerTurnContext = {
    getState: () => h.state,
    setState: (state) => { h.state = state; h.writes += 1; },
    active: () => h.active,
    save: () => { h.saves += 1; },
    render: () => { h.renders += 1; },
    sleep: async () => {},
    onEvent: (event) => { h.events.push(event); },
  };
  return { h, context };
}

const reply = (request: ControllerRequest, action: Action): ControllerReply => ({
  protocolVersion: 1, requestId: request.requestId, action,
});

function controller(decide: GameController['decide']): GameController { return { id: 'offline-test', decide }; }

function rejectionCodes(events: ControllerEvent[]): string[] {
  return events.filter((event) => event.type === 'rejected').map((event) => event.code);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('合法单步指令执行后重新观察，再明确结束回合', async () => {
  const { h, context } = harness();
  const initial = structuredClone(h.state);
  const requests: ControllerRequest[] = [];
  const result = await executeControllerTurn(context, controller(async (request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) return JSON.stringify(reply(request, { type: 'MOVE', unitId: 'own', x: 5, y: 5 }));
    assert.equal(request.observation.units.find((unit) => unit.id === 'own')!.x, 5);
    assert.equal(request.observation.units.find((unit) => unit.id === 'own')!.moved, true);
    assert.equal(request.feedback?.status, 'applied');
    return reply(request, { type: 'END_TURN' });
  }), { maxRequests: 2 });
  assert.deepEqual(result, { status: 'turn-ended', requests: 2, appliedActions: 2, rejectedReplies: 0, fallbackUsed: false });
  assert.equal(h.state.current, 'B');
  assert.equal(h.state.turn, 2);
  assert.equal(h.saves, 2);
  assert.equal(h.renders, 2);
  assert.notEqual(requests[0]!.requestId, requests[1]!.requestId);
  assert.deepEqual(requests.map((request) => request.controls.remainingRequests), [2, 1]);
  assert.equal(initial.units[0]!.x, 4);
});

test('规则拒绝不保存或扣钱，下一次请求包含固定反馈并可恢复', async () => {
  const { h, context } = harness();
  const initial = h.state;
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async (request) => {
    if (++calls === 1) return reply(request, { type: 'MOVE', unitId: 'own', x: 999, y: 999 });
    assert.equal(h.state, initial);
    assert.equal(h.saves, 0);
    assert.equal(request.feedback?.code, 'RULE_REJECTED');
    assert.equal(request.feedback?.status, 'rejected');
    return reply(request, { type: 'END_TURN' });
  }));
  assert.equal(result.status, 'turn-ended');
  assert.equal(result.rejectedReplies, 1);
  assert.equal(result.appliedActions, 1);
  assert.equal(h.state.players.A.gold, initial.players.A.gold);
  assert.equal(h.saves, 1);
});

test('非 JSON 回复可修正，原始内容不进入下一请求或事件', async () => {
  const { h, context } = harness();
  let calls = 0;
  const raw = 'private-provider-payload: not JSON';
  const result = await executeControllerTurn(context, controller(async (request) => {
    if (++calls === 1) return raw;
    assert.equal(request.feedback?.code, 'INVALID_REPLY');
    assert.equal(JSON.stringify(request).includes(raw), false);
    return reply(request, { type: 'END_TURN' });
  }));
  assert.equal(result.status, 'turn-ended');
  assert.equal(result.rejectedReplies, 1);
  assert.equal(JSON.stringify(h.events).includes(raw), false);
});

test('上一请求的回复不能重放到新请求，已经成功的动作只执行一次', async () => {
  const { h, context } = harness();
  let previous: ControllerReply;
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async (request) => {
    if (++calls === 1) {
      previous = reply(request, { type: 'MOVE', unitId: 'own', x: 5, y: 5 });
      return previous;
    }
    if (calls === 2) return previous;
    assert.equal(request.feedback?.code, 'STALE_REPLY');
    return reply(request, { type: 'END_TURN' });
  }));
  assert.equal(result.status, 'turn-ended');
  assert.equal(result.appliedActions, 2);
  assert.equal(result.rejectedReplies, 1);
  assert.equal(h.saves, 2);
  assert.deepEqual(rejectionCodes(h.events), ['STALE_REPLY']);
});

test('招募来源不能同时指定城市和单位，格式错误不触碰规则状态', async () => {
  const { h, context } = harness();
  const before = structuredClone(h.state);
  const result = await executeControllerTurn(context, controller(async (request) => ({
    protocolVersion: 1, requestId: request.requestId,
    action: { type: 'RECRUIT', cityId: 'home', unitId: 'own', unitType: 'militia' },
  })), { maxConsecutiveRejections: 1 });
  assert.equal(result.status, 'invalid-replies');
  assert.deepEqual(rejectionCodes(h.events), ['INVALID_ACTION']);
  assert.deepEqual(h.state, before);
  assert.equal(h.saves, 0);
});

test('不能操作非己方单位，且不可见与不存在的目标获得相同反馈', async () => {
  for (const target of ['hidden', 'does-not-exist']) {
    const { h, context } = harness();
    h.state.units.push({ ...h.state.units[0]!, id: 'hidden', owner: 'B', x: 10, y: 10 });
    const before = structuredClone(h.state);
    const result = await executeControllerTurn(context, controller(async (request) =>
      reply(request, { type: 'ATTACK', unitId: 'own', targetId: target })), { maxConsecutiveRejections: 1 });
    assert.equal(result.status, 'invalid-replies');
    assert.deepEqual(rejectionCodes(h.events), ['TARGET_NOT_OBSERVED']);
    assert.deepEqual(h.state, before);
  }
  const { h, context } = harness();
  const result = await executeControllerTurn(context, controller(async (request) =>
    reply(request, { type: 'MOVE', unitId: 'not-owned', x: 5, y: 5 })), { maxConsecutiveRejections: 1 });
  assert.equal(result.status, 'invalid-replies');
  assert.deepEqual(rejectionCodes(h.events), ['UNIT_NOT_OWNED']);
  assert.equal(h.saves, 0);
});

test('人类指挥官计划默认受保护，显式授权才可由控制器修改', async () => {
  for (const allowed of [false, true]) {
    const { h, context } = harness(fixture(true));
    const result = await executeControllerTurn(context, controller(async (request) => {
      assert.equal(request.controls.allowOrderEdits, allowed);
      return reply(request, { type: 'SET_ORDERS', queue: ['archer'] });
    }), { maxRequests: 1, maxConsecutiveRejections: 1, allowOrderEdits: allowed });
    assert.equal(result.status, allowed ? 'request-limit' : 'invalid-replies');
    assert.deepEqual(h.state.orders?.A, allowed ? ['archer'] : ['militia']);
    assert.equal(h.state.turn, 1);
    assert.equal(h.saves, allowed ? 1 : 0);
    if (!allowed) assert.deepEqual(rejectionCodes(h.events), ['ORDERS_LOCKED']);
  }
});

test('控制器无法绕过指挥官一次产能，重复招募失败不再扣钱', async () => {
  const { h, context } = harness(fixture(true));
  h.state.units = [];
  const gold = h.state.players.A.gold;
  const cost = recruitCost(h.state, 'A', h.state.unitTypes.militia!);
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async (request) => {
    if (++calls > 1) assert.equal(request.observation.self.production.recruited, 1);
    return reply(request, { type: 'RECRUIT', cityId: 'home', unitType: 'militia' });
  }), { maxRequests: 2 });
  assert.equal(result.status, 'request-limit');
  assert.equal(result.appliedActions, 1);
  assert.equal(result.rejectedReplies, 1);
  assert.equal(h.state.units.length, 1);
  assert.equal(h.state.players.A.gold, gold - cost);
  assert.equal(h.state.turnProduction!.recruited, 1);
  assert.equal(h.state.turn, 1);
  assert.equal(h.saves, 1);
});

test('提供方忽略 abort 且永不返回时，超时仍会结束等待并保留回合', async () => {
  const { h, context } = harness();
  const before = h.state;
  let requestSignal: AbortSignal | undefined;
  const result = await executeControllerTurn(context, controller(async (_request, signal) => {
    requestSignal = signal;
    return new Promise<never>(() => {});
  }), { timeoutMs: 10 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.fallbackUsed, false);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(h.state, before);
  assert.equal(h.saves, 0);
});

test('提供方同步或异步异常不会泄露内容，也不会默认交给算法继续', async () => {
  for (const synchronous of [true, false]) {
    const { h, context } = harness();
    const before = h.state;
    const secret = 'provider-internal-sensitive-error';
    const result = await executeControllerTurn(context, controller(() => {
      if (synchronous) throw new Error(secret);
      return Promise.reject(new Error(secret));
    }));
    assert.equal(result.status, 'provider-error');
    assert.equal(result.fallbackUsed, false);
    assert.equal(h.state, before);
    assert.equal(h.saves, 0);
    assert.equal(JSON.stringify(h.events).includes(secret), false);
  }
});

test('等待中取消立即停止，随后迟到的有效指令不能写入状态', async () => {
  const { h, context } = harness();
  const initial = h.state;
  const started = deferred<void>();
  const pending = deferred<unknown>();
  const cancellation = new AbortController();
  let requestId = '';
  let requestSignal: AbortSignal | undefined;
  const running = executeControllerTurn(context, controller((request, signal) => {
    requestId = request.requestId;
    requestSignal = signal;
    started.resolve();
    return pending.promise;
  }), { signal: cancellation.signal, timeoutMs: 1000, failurePolicy: 'algorithm' });
  await started.promise;
  cancellation.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.fallbackUsed, false);
  assert.equal(requestSignal?.aborted, true);
  pending.resolve({ protocolVersion: 1, requestId, action: { type: 'END_TURN' } });
  await Promise.resolve();
  assert.equal(h.state, initial);
  assert.equal(h.writes, 0);
});

test('同玩家同回合的存档替换也使等待中的旧回复失效', async () => {
  const { h, context } = harness();
  const started = deferred<void>();
  const pending = deferred<unknown>();
  let requestId = '';
  const running = executeControllerTurn(context, controller((request) => {
    requestId = request.requestId;
    started.resolve();
    return pending.promise;
  }), { failurePolicy: 'algorithm' });
  await started.promise;
  const replacement = structuredClone(h.state);
  h.state = replacement;
  pending.resolve({ protocolVersion: 1, requestId, action: { type: 'END_TURN' } });
  const result = await running;
  assert.equal(result.status, 'stale-state');
  assert.equal(result.fallbackUsed, false);
  assert.equal(h.state, replacement);
  assert.equal(h.writes, 0);
});

test('请求额度用完时保留已经完成的动作，默认暂停而非结束回合', async () => {
  const { h, context } = harness();
  const result = await executeControllerTurn(context, controller(async (request) =>
    reply(request, { type: 'MOVE', unitId: 'own', x: 5, y: 5 })), { maxRequests: 1 });
  assert.equal(result.status, 'request-limit');
  assert.equal(result.fallbackUsed, false);
  assert.equal(h.state.units[0]!.moved, true);
  assert.equal(h.state.turn, 1);
  assert.equal(h.state.current, 'A');
  assert.equal(h.saves, 1);
});

test('显式配置算法兜底后，提供方故障才交出剩余回合', async () => {
  const { h, context } = harness();
  h.state.units = [];
  const result = await executeControllerTurn(context, controller(async () => { throw new Error('offline'); }), {
    failurePolicy: 'algorithm', fallbackBudget: { maxRecruit: 0, maxUpgrade: 0 },
  });
  assert.equal(result.status, 'fallback-completed');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.appliedActions, 0);
  assert.equal(h.state.current, 'B');
  assert.equal(h.state.turn, 2);
  assert.equal(h.saves, 1);
  assert.ok(h.events.some((event) => event.type === 'fallback' && event.reason === 'provider-error'));
});

test('提供方篡改请求副本的观察和权限不能改变本地校验依据', async () => {
  const { h, context } = harness(fixture(true));
  const before = structuredClone(h.state);
  const result = await executeControllerTurn(context, controller(async (request) => {
    request.observation.self.gold = 999999;
    request.controls.allowOrderEdits = true;
    request.observation.units.push({ ...request.observation.units[0]!, id: 'forged' });
    return reply(request, { type: 'MOVE', unitId: 'forged', x: 5, y: 5 });
  }), { maxConsecutiveRejections: 1 });
  assert.equal(result.status, 'invalid-replies');
  assert.deepEqual(rejectionCodes(h.events), ['UNIT_NOT_OWNED']);
  assert.deepEqual(h.state, before);
  assert.equal(h.saves, 0);
});

test('提供方修改 requestId 不能修改当前请求绑定', async () => {
  const { h, context } = harness();
  const initial = h.state;
  const result = await executeControllerTurn(context, controller(async (request) => {
    request.requestId = 'forged-request';
    return reply(request, { type: 'END_TURN' });
  }), { maxConsecutiveRejections: 1 });
  assert.equal(result.status, 'invalid-replies');
  assert.deepEqual(rejectionCodes(h.events), ['STALE_REPLY']);
  assert.equal(h.state, initial);
  assert.equal(h.writes, 0);
});

test('已结束或预先取消的对局不向提供方发出请求', async () => {
  for (const ended of [false, true]) {
    const { h, context } = harness();
    const cancellation = new AbortController();
    if (ended) h.state.winner = 'draw';
    else cancellation.abort();
    let calls = 0;
    const result = await executeControllerTurn(context, controller(async (request) => {
      calls += 1;
      return reply(request, { type: 'END_TURN' });
    }), { signal: cancellation.signal });
    assert.equal(result.status, ended ? 'game-over' : 'cancelled');
    assert.equal(result.requests, 0);
    assert.equal(calls, 0);
    assert.equal(h.writes, 0);
  }
});

test('后手第100轮结束可触发正式平局，不再请求下一步', async () => {
  const { h, context } = harness();
  h.state.current = 'B';
  h.state.turn = CONFIG.maxRounds * 2;
  h.state.turnProduction = { player: 'B', turn: h.state.turn, recruited: 0, upgraded: 0 };
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async (request) => {
    calls += 1;
    return reply(request, { type: 'END_TURN' });
  }));
  assert.equal(result.status, 'game-over');
  assert.equal(h.state.winner, 'draw');
  assert.equal(h.state.resultReason, 'turn-limit');
  assert.equal(calls, 1);
  assert.equal(h.saves, 1);
});

test('兜底事件回调同步换局时，算法不能接管新局', async () => {
  const { h, context } = harness();
  const replacement = structuredClone(h.state);
  context.onEvent = (event) => {
    h.events.push(event);
    if (event.type === 'fallback') h.state = replacement;
  };
  const result = await executeControllerTurn(context, controller(async () => { throw new Error('offline'); }), {
    failurePolicy: 'algorithm', fallbackBudget: { maxRecruit: 0, maxUpgrade: 0 },
  });
  assert.equal(result.status, 'stale-state');
  assert.equal(h.state, replacement);
  assert.equal(h.writes, 0);
  assert.equal(result.fallbackUsed, false);
});

test('发出请求事件时取消或换局，不再真正调用提供方', async () => {
  for (const replace of [false, true]) {
    const { h, context } = harness();
    const replacement = structuredClone(h.state);
    context.onEvent = (event) => {
      h.events.push(event);
      if (event.type !== 'requested') return;
      if (replace) h.state = replacement;
      else h.active = false;
    };
    let calls = 0;
    const result = await executeControllerTurn(context, controller(async (request) => {
      calls += 1;
      return reply(request, { type: 'END_TURN' });
    }));
    assert.equal(result.status, replace ? 'stale-state' : 'cancelled');
    assert.equal(calls, 0);
    assert.equal(result.requests, 0);
    assert.equal(h.writes, 0);
    assert.equal(h.state.turn, 1);
  }
});

test('连续无效回复达到默认阈值后停止，不耗尽全部请求额度', async () => {
  const { h, context } = harness();
  const initial = h.state;
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async () => {
    calls += 1;
    return 'invalid JSON';
  }), { maxRequests: 5 });
  assert.equal(result.status, 'invalid-replies');
  assert.equal(calls, 2);
  assert.equal(result.requests, 2);
  assert.equal(result.rejectedReplies, 2);
  assert.equal(result.fallbackUsed, false);
  assert.equal(h.state, initial);
  assert.equal(h.writes, 0);
});

test('观察请求过大时在提供方调用前暂停，避免发送超出配置的数据量', async () => {
  const { h, context } = harness();
  const initial = h.state;
  let calls = 0;
  const result = await executeControllerTurn(context, controller(async (request) => {
    calls += 1;
    return reply(request, { type: 'END_TURN' });
  }), { maxRequestBytes: 100 });
  assert.equal(result.status, 'request-too-large');
  assert.equal(result.requests, 0);
  assert.equal(calls, 0);
  assert.equal(h.state, initial);
  assert.equal(h.writes, 0);
});

test('算法兜底等待中载入另一份已结束存档，不能误报旧任务完成', async () => {
  const { h, context } = harness();
  h.state.units = [];
  const replacement = { ...structuredClone(h.state), winner: 'draw' as const };
  context.sleep = async () => { h.state = replacement; };
  const result = await executeControllerTurn(context, controller(async () => { throw new Error('offline'); }), {
    failurePolicy: 'algorithm', fallbackBudget: { maxRecruit: 0, maxUpgrade: 0 },
  });
  assert.equal(result.status, 'stale-state');
  assert.equal(h.state, replacement);
  assert.equal(h.state.turn, 1);
  assert.equal(h.writes, 1, '只写入替换前的旧回合交接，不再写入替换存档');
});
