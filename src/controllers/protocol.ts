/** 服务商无关的单步决策协议；这里只校验格式，行动合法性由 applyAction 决定。 */
import { CONFIG } from '../core/config.ts';
import type { Action } from '../core/types.ts';
import type { ControllerObservation } from './observation.ts';

export const CONTROLLER_PROTOCOL_VERSION = 1;
export const MAX_CONTROLLER_REPLY_BYTES = 16 * 1024;
export const MAX_CONTROLLER_ID_LENGTH = 128;
export const MAX_CONTROLLER_EXPLANATION_LENGTH = 500;

export interface ControllerFeedback {
  status: 'applied' | 'rejected';
  code: string;
  /** 调用方生成的简短反馈，不包含服务商原始错误或完整游戏状态。 */
  message: string;
  action?: Action;
}

export interface ControllerRequest {
  protocolVersion: 1;
  requestId: string;
  observation: ControllerObservation;
  controls: {
    allowOrderEdits: boolean;
    /** 包含本次请求，模型可以在额度用完前主动结束回合。 */
    remainingRequests: number;
  };
  feedback?: ControllerFeedback;
}

export interface ControllerReply {
  protocolVersion: 1;
  requestId: string;
  action: Action;
  /** 供界面解释操作；不会当作新的命令执行。 */
  explanation?: string;
}

export interface GameController {
  id: string;
  decide(request: ControllerRequest, signal: AbortSignal): Promise<unknown>;
}

type ParseFailure = { ok: false; code: 'INVALID_REPLY' | 'REPLY_TOO_LARGE' | 'INVALID_ACTION' | 'STALE_REPLY'; message: string };
export type ParsedControllerReply = { ok: true; reply: ControllerReply } | ParseFailure;

const idSchema = { type: 'string', minLength: 1, maxLength: MAX_CONTROLLER_ID_LENGTH } as const;
const coordinateSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

function actionSchema(type: Action['type'], properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties: { type: { const: type }, ...properties },
    required: ['type', ...Object.keys(properties)],
    additionalProperties: false,
  };
}

/** 通用 JSON Schema，不依赖某个供应商的工具调用或结构化输出扩展。 */
export const CONTROLLER_REPLY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'GridWarchessControllerReplyV1',
  type: 'object',
  properties: {
    protocolVersion: { const: CONTROLLER_PROTOCOL_VERSION },
    requestId: idSchema,
    action: {
      oneOf: [
        actionSchema('MOVE', { unitId: idSchema, x: coordinateSchema, y: coordinateSchema }),
        actionSchema('ATTACK', { unitId: idSchema, targetId: idSchema }),
        actionSchema('SIEGE', { unitId: idSchema, cityId: idSchema }),
        actionSchema('RECRUIT', { cityId: idSchema, unitType: idSchema }),
        actionSchema('RECRUIT', { unitId: idSchema, unitType: idSchema }),
        actionSchema('BUILD', { unitId: idSchema, unitType: idSchema, x: coordinateSchema, y: coordinateSchema }),
        actionSchema('LOAD', { unitId: idSchema, cargoId: idSchema }),
        actionSchema('UNLOAD', { unitId: idSchema, cargoId: idSchema, x: coordinateSchema, y: coordinateSchema }),
        actionSchema('UPGRADE', { cityId: idSchema }),
        actionSchema('SET_ORDERS', { queue: {
          type: 'array', maxItems: CONFIG.commanderSlots,
          items: { type: 'string', maxLength: MAX_CONTROLLER_ID_LENGTH },
        } }),
        actionSchema('END_TURN', {}),
      ],
    },
    explanation: { type: 'string', maxLength: MAX_CONTROLLER_EXPLANATION_LENGTH },
  },
  required: ['protocolVersion', 'requestId', 'action'],
  additionalProperties: false,
} as const;

/** 只接收 JSON 数据对象；拒绝原型实例、符号及 getter，避免隐式执行提供方代码。 */
function dataObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const keys = Object.getOwnPropertyNames(value);
  // 每个协议对象最多五个字段，先限制再检查，避免巨大未知对象占用额外工作。
  if (keys.length > 5) return null;
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    data[key] = descriptor.value as unknown;
  }
  return data;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

/** JSON Schema 的 maxLength 按 Unicode 码点计数。 */
function textWithin(value: unknown, maximum: number, minimum = 0): value is string {
  if (typeof value !== 'string' || value.length > maximum * 2) return false;
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

const identifier = (value: unknown): value is string => textWithin(value, MAX_CONTROLLER_ID_LENGTH, 1);
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function orderQueue(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CONFIG.commanderSlots || Object.getOwnPropertySymbols(value).length > 0) return null;
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) return null;
  const queue: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
      || !textWithin(descriptor.value, MAX_CONTROLLER_ID_LENGTH)) return null;
    queue.push(descriptor.value);
  }
  return queue;
}

function parseAction(value: unknown): Action | null {
  const action = dataObject(value);
  if (!action) return null;
  const is = (...keys: string[]) => exactKeys(action, ['type', ...keys]);
  switch (action.type) {
    case 'MOVE':
      return is('unitId', 'x', 'y') && identifier(action.unitId) && coordinate(action.x) && coordinate(action.y)
        ? { type: 'MOVE', unitId: action.unitId, x: action.x, y: action.y } : null;
    case 'ATTACK':
      return is('unitId', 'targetId') && identifier(action.unitId) && identifier(action.targetId)
        ? { type: 'ATTACK', unitId: action.unitId, targetId: action.targetId } : null;
    case 'SIEGE':
      return is('unitId', 'cityId') && identifier(action.unitId) && identifier(action.cityId)
        ? { type: 'SIEGE', unitId: action.unitId, cityId: action.cityId } : null;
    case 'RECRUIT':
      if (!identifier(action.unitType)) return null;
      if (is('cityId', 'unitType') && identifier(action.cityId)) {
        return { type: 'RECRUIT', cityId: action.cityId, unitType: action.unitType };
      }
      if (is('unitId', 'unitType') && identifier(action.unitId)) {
        return { type: 'RECRUIT', unitId: action.unitId, unitType: action.unitType };
      }
      return null;
    case 'BUILD':
      return is('unitId', 'unitType', 'x', 'y') && identifier(action.unitId) && identifier(action.unitType)
        && coordinate(action.x) && coordinate(action.y)
        ? { type: 'BUILD', unitId: action.unitId, unitType: action.unitType, x: action.x, y: action.y } : null;
    case 'LOAD':
      return is('unitId', 'cargoId') && identifier(action.unitId) && identifier(action.cargoId)
        ? { type: 'LOAD', unitId: action.unitId, cargoId: action.cargoId } : null;
    case 'UNLOAD':
      return is('unitId', 'cargoId', 'x', 'y') && identifier(action.unitId) && identifier(action.cargoId)
        && coordinate(action.x) && coordinate(action.y)
        ? { type: 'UNLOAD', unitId: action.unitId, cargoId: action.cargoId, x: action.x, y: action.y } : null;
    case 'UPGRADE':
      return is('cityId') && identifier(action.cityId) ? { type: 'UPGRADE', cityId: action.cityId } : null;
    case 'SET_ORDERS': {
      const queue = orderQueue(action.queue);
      return is('queue') && queue !== null ? { type: 'SET_ORDERS', queue } : null;
    }
    case 'END_TURN': return is() ? { type: 'END_TURN' } : null;
    default: return null;
  }
}

const invalidReply = (): ParseFailure => ({ ok: false, code: 'INVALID_REPLY', message: '回复必须是协议 v1 的单条 JSON 指令' });
const tooLarge = (): ParseFailure => ({ ok: false, code: 'REPLY_TOO_LARGE', message: '回复超过允许的字节数' });

/** 不接受 Markdown、动作列表或状态修改；返回的对象不与输入共享引用。 */
export function parseControllerReply(value: unknown, expectedRequestId: string): ParsedControllerReply {
  try {
    if (typeof value === 'string') {
      if (value.length > MAX_CONTROLLER_REPLY_BYTES || new TextEncoder().encode(value).byteLength > MAX_CONTROLLER_REPLY_BYTES) return tooLarge();
      value = JSON.parse(value) as unknown;
    }
    const record = dataObject(value);
    if (!record || !exactKeys(record, ['protocolVersion', 'requestId', 'action'], ['explanation'])
      || record.protocolVersion !== CONTROLLER_PROTOCOL_VERSION || !identifier(record.requestId)
      || !identifier(expectedRequestId)
      || (Object.hasOwn(record, 'explanation') && !textWithin(record.explanation, MAX_CONTROLLER_EXPLANATION_LENGTH))) return invalidReply();
    if (record.requestId !== expectedRequestId) {
      return { ok: false, code: 'STALE_REPLY', message: '回复不属于当前决策请求' };
    }
    const action = parseAction(record.action);
    if (!action) return { ok: false, code: 'INVALID_ACTION', message: '行动字段不符合协议格式' };
    const reply: ControllerReply = { protocolVersion: 1, requestId: record.requestId, action };
    if (typeof record.explanation === 'string') reply.explanation = record.explanation;
    if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > MAX_CONTROLLER_REPLY_BYTES) return tooLarge();
    return { ok: true, reply };
  } catch {
    return invalidReply();
  }
}
