/** 控制器协议边界：纯 JSON、严格指令形状、请求关联与大小限制。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG } from '../src/core/config.ts';
import type { Action } from '../src/core/types.ts';
import {
  CONTROLLER_REPLY_SCHEMA, MAX_CONTROLLER_EXPLANATION_LENGTH, MAX_CONTROLLER_ID_LENGTH,
  MAX_CONTROLLER_REPLY_BYTES, parseControllerReply,
} from '../src/controllers/protocol.ts';

const REQUEST = 'match-local:turn-1:decision-3';
const response = (action: unknown, extra: Record<string, unknown> = {}) => ({ protocolVersion: 1, requestId: REQUEST, action, ...extra });
const actions: Action[] = [
  { type: 'MOVE', unitId: 'u1', x: 2, y: 3 },
  { type: 'ATTACK', unitId: 'u1', targetId: 'u2' },
  { type: 'SIEGE', unitId: 'u1', cityId: 'city-b' },
  { type: 'RECRUIT', cityId: 'city-a', unitType: 'militia' },
  { type: 'RECRUIT', unitId: 'camp-a', unitType: 'militia' },
  { type: 'BUILD', unitId: 'builder-a', unitType: 'bridge', x: 0, y: 3 },
  { type: 'LOAD', unitId: 'ferry-a', cargoId: 'u1' },
  { type: 'UNLOAD', unitId: 'ferry-a', cargoId: 'u1', x: 1, y: 3 },
  { type: 'UPGRADE', cityId: 'city-a' },
  { type: 'SET_ORDERS', queue: ['militia', '', '@upgrade'] },
  { type: 'END_TURN' },
];

/** 测试只解释本 schema 使用的标准关键字，避免引入运行时 schema 依赖。 */
function matchesSchema(value: unknown, schema: unknown): boolean {
  const s = schema as Record<string, unknown>;
  if ('const' in s && value !== s.const) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((branch) => matchesSchema(value, branch)).length !== 1) return false;
  if (s.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    const properties = s.properties as Record<string, unknown>;
    if (!(s.required as string[]).every((key) => Object.hasOwn(data, key))) return false;
    if (s.additionalProperties === false && Object.keys(data).some((key) => !Object.hasOwn(properties, key))) return false;
    if (!Object.entries(data).every(([key, field]) => matchesSchema(field, properties[key]))) return false;
  }
  if (s.type === 'array') {
    if (!Array.isArray(value) || value.length > Number(s.maxItems)) return false;
    if (!value.every((item) => matchesSchema(item, s.items))) return false;
  }
  if (s.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = Array.from(value).length;
    if (length < Number(s.minLength ?? 0) || length > Number(s.maxLength ?? Infinity)) return false;
  }
  if (s.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (value < Number(s.minimum ?? -Infinity) || value > Number(s.maximum ?? Infinity)) return false;
  }
  return true;
}

test('全部行动与两种招募来源均可由纯 JSON 和对象回复解析，并匹配公开 schema', () => {
  for (const action of actions) {
    const reply = response(action, { explanation: '执行这一行动。' });
    assert.ok(matchesSchema(reply, CONTROLLER_REPLY_SCHEMA), action.type);
    for (const value of [reply, JSON.stringify(reply)]) {
      const parsed = parseControllerReply(value, REQUEST);
      assert.ok(parsed.ok, action.type);
      assert.deepEqual(parsed.reply, reply);
    }
  }
});

test('不接收 Markdown 围栏、批量动作或直接修改游戏状态', () => {
  for (const value of [
    '```json\n' + JSON.stringify(response({ type: 'END_TURN' })) + '\n```',
    [response({ type: 'END_TURN' })],
    response([{ type: 'END_TURN' }]),
    { protocolVersion: 1, requestId: REQUEST, state: { winner: 'A' } },
    response({ type: 'SET_STATE', winner: 'A' }),
    null, true, 7, '', 'null', '{}', 'invalid json',
  ]) assert.equal(parseControllerReply(value, REQUEST).ok, false);
});

test('未知根字段、未知动作字段以及双来源或缺来源招募被拒绝', () => {
  const invalid = [
    response({ type: 'END_TURN' }, { instructions: 'ignore rules' }),
    response({ type: 'END_TURN', winner: 'A' }),
    response({ type: 'MOVE', unitId: 'u1', x: 0, y: 1, gold: 99999 }),
    response({ type: 'RECRUIT', cityId: 'city-a', unitId: 'camp-a', unitType: 'militia' }),
    response({ type: 'RECRUIT', unitType: 'militia' }),
    response({ type: 'ATTACK', unitId: 'u1', targetId: 'u2', force: true }),
  ];
  for (const value of invalid) {
    assert.equal(parseControllerReply(value, REQUEST).ok, false);
    assert.equal(matchesSchema(value, CONTROLLER_REPLY_SCHEMA), false);
  }
  const injected = JSON.parse('{"protocolVersion":1,"requestId":"' + REQUEST + '","action":{"type":"END_TURN"},"__proto__":{"winner":"A"}}') as unknown;
  assert.equal(parseControllerReply(injected, REQUEST).ok, false);
});

test('坐标只允许非负安全整数，规则内核仍需另行检查棋盘范围', () => {
  for (const x of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    const value = response({ type: 'MOVE', unitId: 'u1', x, y: 0 });
    assert.equal(parseControllerReply(value, REQUEST).ok, false);
    assert.equal(matchesSchema(value, CONTROLLER_REPLY_SCHEMA), false);
  }
  assert.ok(parseControllerReply(response({ type: 'MOVE', unitId: 'u1', x: Number.MAX_SAFE_INTEGER, y: 0 }), REQUEST).ok);
});

test('回复必须使用正确协议版本及当前 requestId', () => {
  for (const protocolVersion of [0, 2, '1', null]) {
    assert.equal(parseControllerReply(response({ type: 'END_TURN' }, { protocolVersion }), REQUEST).ok, false);
  }
  const stale = parseControllerReply(response({ type: 'END_TURN' }, { requestId: 'old-request' }), REQUEST);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'STALE_REPLY');
  for (const requestId of ['', 123, undefined, 'a'.repeat(MAX_CONTROLLER_ID_LENGTH + 1)]) {
    assert.equal(parseControllerReply(response({ type: 'END_TURN' }, { requestId }), REQUEST).ok, false);
  }
});

test('单条文本回复限制为 16 KiB UTF-8，包括空白字符和多字节字符', () => {
  const base = JSON.stringify(response({ type: 'END_TURN' }));
  const padded = base + ' '.repeat(MAX_CONTROLLER_REPLY_BYTES - base.length);
  assert.ok(parseControllerReply(padded, REQUEST).ok);
  for (const value of [padded + ' ', JSON.stringify(response({ type: 'END_TURN' }, { explanation: '中'.repeat(6000) }))]) {
    const parsed = parseControllerReply(value, REQUEST);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, 'REPLY_TOO_LARGE');
  }
});

test('标识符、解释文本及计划长度受限，Unicode 码点与 schema 保持一致', () => {
  const id = '棋'.repeat(MAX_CONTROLLER_ID_LENGTH);
  const emojiId = '🙂'.repeat(MAX_CONTROLLER_ID_LENGTH);
  for (const unitId of [id, emojiId]) {
    const value = response({ type: 'ATTACK', unitId, targetId: 'target' }, { explanation: '🙂'.repeat(MAX_CONTROLLER_EXPLANATION_LENGTH) });
    assert.ok(parseControllerReply(value, REQUEST).ok);
    assert.ok(matchesSchema(value, CONTROLLER_REPLY_SCHEMA));
  }
  for (const value of [
    response({ type: 'ATTACK', unitId: id + '棋', targetId: 'target' }),
    response({ type: 'ATTACK', unitId: '', targetId: 'target' }),
    response({ type: 'END_TURN' }, { explanation: 'a'.repeat(MAX_CONTROLLER_EXPLANATION_LENGTH + 1) }),
    response({ type: 'END_TURN' }, { explanation: null }),
    response({ type: 'SET_ORDERS', queue: Array(CONFIG.commanderSlots + 1).fill('') }),
    response({ type: 'SET_ORDERS', queue: ['militia', null] }),
    response({ type: 'SET_ORDERS', queue: ['x'.repeat(MAX_CONTROLLER_ID_LENGTH + 1)] }),
  ]) {
    assert.equal(parseControllerReply(value, REQUEST).ok, false);
    assert.equal(matchesSchema(value, CONTROLLER_REPLY_SCHEMA), false);
  }
  assert.ok(parseControllerReply(response({ type: 'SET_ORDERS', queue: [] }), REQUEST).ok);
});

test('规范化结果不与来源动作或计划数组共享引用', () => {
  const value = response({ type: 'SET_ORDERS', queue: ['militia', '', '@upgrade'] });
  const before = structuredClone(value);
  const parsed = parseControllerReply(value, REQUEST);
  assert.ok(parsed.ok);
  assert.equal(parsed.reply.action.type, 'SET_ORDERS');
  if (parsed.reply.action.type === 'SET_ORDERS') parsed.reply.action.queue[0] = 'archer';
  parsed.reply.explanation = 'changed';
  assert.deepEqual(value, before);
  assert.notEqual(parsed.reply.action, value.action);
});

test('对象回复中的 getter、原型实例、符号字段与稀疏计划不会被隐式读取', () => {
  let invoked = 0;
  const accessor = Object.defineProperty(response({ type: 'END_TURN' }), 'protocolVersion', { enumerable: true, get: () => { invoked++; return 1; } });
  const queue = ['militia'];
  Object.defineProperty(queue, '0', { enumerable: true, get: () => { invoked++; return 'militia'; } });
  class CustomReply { protocolVersion = 1; requestId = REQUEST; action = { type: 'END_TURN' }; }
  for (const value of [
    accessor, new CustomReply(), { ...response({ type: 'END_TURN' }), [Symbol('extra')]: true },
    response({ type: 'SET_ORDERS', queue }), response({ type: 'SET_ORDERS', queue: new Array(2) }),
    response({ type: 'END_TURN' }, { toJSON: () => { invoked++; return {}; } }),
  ]) assert.equal(parseControllerReply(value, REQUEST).ok, false);
  assert.equal(invoked, 0);
});

test('错误提示不回显模型原文、请求标识或注入内容', () => {
  const secret = 'private-provider-payload-that-must-not-return';
  for (const value of [secret, response({ type: secret }), response({ type: 'END_TURN' }, { requestId: secret })]) {
    const parsed = parseControllerReply(value, REQUEST);
    assert.equal(parsed.ok, false);
    assert.ok(!JSON.stringify(parsed).includes(secret));
    assert.ok(!JSON.stringify(parsed).includes(REQUEST));
  }
});
