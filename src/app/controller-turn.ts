/** 外部操控者的异步回合调度。仅接收注入的接口，本模块不发网络请求。 */
import { executeAiTurn, type AiTurnContext } from './ai-turn.ts';
import type { AiBudget } from '../core/ai.ts';
import { applyAction } from '../core/rules.ts';
import type { Action } from '../core/types.ts';
import { observeGame } from '../controllers/observation.ts';
import { parseControllerReply } from '../controllers/protocol.ts';
import type { ControllerFeedback, ControllerRequest, GameController } from '../controllers/protocol.ts';

export type ControllerTurnStatus = 'turn-ended' | 'game-over' | 'cancelled' | 'stale-state'
  | 'request-limit' | 'request-too-large' | 'invalid-replies' | 'timeout' | 'provider-error'
  | 'fallback-completed' | 'fallback-stopped';

export interface ControllerTurnResult {
  status: ControllerTurnStatus;
  requests: number;
  /** 仅统计控制器提出并成功执行的动作，包含 END_TURN。 */
  appliedActions: number;
  rejectedReplies: number;
  fallbackUsed: boolean;
}

export type ControllerEvent =
  | { type: 'requested'; requestId: string; turn: number; player: 'A' | 'B' }
  | { type: 'applied'; requestId: string; action: Action; explanation?: string }
  | { type: 'rejected'; requestId: string; code: string; message: string }
  | { type: 'fallback'; reason: ControllerTurnStatus }
  | { type: 'stopped'; status: ControllerTurnStatus };

export interface ControllerTurnContext extends AiTurnContext {
  /** explanation 是外部文本；界面必须使用 textContent 或转义后渲染。 */
  onEvent?(event: ControllerEvent): void;
}

export interface ControllerTurnOptions {
  signal?: AbortSignal;
  /** 每次请求的截止时间，默认 15 秒。提供方忽略 abort 时也能结束等待。 */
  timeoutMs?: number;
  /** 默认最多 12 次请求；达到上限暂停，绝不悄悄结束回合。 */
  maxRequests?: number;
  /** UTF-8 JSON 请求体上限，默认 128 KiB；具体模型的 token 限制由适配器另行处理。 */
  maxRequestBytes?: number;
  maxConsecutiveRejections?: number;
  delayMs?: number;
  /** 默认保护人类下达的指挥官计划；全权操控者可显式开启。 */
  allowOrderEdits?: boolean;
  /** stop 为默认。只有显式选择 algorithm 才会将剩余回合交给算法 AI。 */
  failurePolicy?: 'stop' | 'algorithm';
  fallbackBudget?: Partial<AiBudget>;
}

type ReplyResult = { kind: 'reply'; value: unknown }
  | { kind: 'timeout' } | { kind: 'cancelled' } | { kind: 'error' };
let runSequence = 0;

function boundedInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) throw new RangeError(`${name} 超出允许范围`);
  return chosen;
}

function awaitReply(
  controller: GameController, request: ControllerRequest, timeoutMs: number, signal?: AbortSignal,
): Promise<ReplyResult> {
  return new Promise((resolve) => {
    const requestAbort = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: 'cancelled' });
    const finish = (result: ReplyResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (result.kind !== 'reply') requestAbort.abort();
      resolve(result);
    };
    if (signal?.aborted) { finish({ kind: 'cancelled' }); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    // 同步 throw 与异步 rejection 都转换成固定错误，不回显提供方的响应或密钥。
    void Promise.resolve().then(() => settled ? undefined : controller.decide(request, requestAbort.signal))
      .then((value) => finish({ kind: 'reply', value }), () => finish({ kind: 'error' }));
  });
}

/**
 * 每次只提交一个 Action，成功后重新观察。取消、过期响应、错误都不能绕过规则或修改旧局。
 * 不改变现有页面的 AI 开关；接线由调用方负责，离线脚本可直接使用。
 */
export async function executeControllerTurn(
  context: ControllerTurnContext, controller: GameController, options: ControllerTurnOptions = {},
): Promise<ControllerTurnResult> {
  const timeoutMs = boundedInteger(options.timeoutMs, 15000, 120000, 'timeoutMs');
  const maxRequests = boundedInteger(options.maxRequests, 12, 50, 'maxRequests');
  const maxRequestBytes = boundedInteger(options.maxRequestBytes, 128 * 1024, 1024 * 1024, 'maxRequestBytes');
  const maxRejections = boundedInteger(options.maxConsecutiveRejections, 2, 5, 'maxConsecutiveRejections');
  const delayMs = options.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5000) throw new RangeError('delayMs 超出允许范围');
  const runId = `controller-${++runSequence}`;
  let expectedState = context.getState();
  const player = expectedState.current;
  const turn = expectedState.turn;
  let requests = 0;
  let appliedActions = 0;
  let rejectedReplies = 0;
  let consecutiveRejections = 0;
  let fallbackUsed = false;
  let feedback: ControllerFeedback | undefined;
  const active = () => context.active() && !options.signal?.aborted;
  const current = () => context.getState() === expectedState
    && expectedState.current === player && expectedState.turn === turn;
  const finish = (status: ControllerTurnStatus): ControllerTurnResult => {
    context.onEvent?.({ type: 'stopped', status });
    return { status, requests, appliedActions, rejectedReplies, fallbackUsed };
  };
  const fail = async (status: ControllerTurnStatus): Promise<ControllerTurnResult> => {
    if (!active()) return finish('cancelled');
    if (!current()) return finish('stale-state');
    if (options.failurePolicy !== 'algorithm') return finish(status);
    context.onEvent?.({ type: 'fallback', reason: status });
    if (!active()) return finish('cancelled');
    if (!current()) return finish('stale-state');
    fallbackUsed = true;
    const completed = await executeAiTurn({
      getState: () => context.getState(),
      setState: (state) => { expectedState = state; context.setState(state); },
      active,
      save: () => context.save(),
      render: () => context.render(),
      sleep: (ms) => context.sleep(ms),
    }, options.fallbackBudget, delayMs);
    if (!active()) return finish('cancelled');
    if (context.getState() !== expectedState) return finish('stale-state');
    return finish(completed || expectedState.winner ? 'fallback-completed' : 'fallback-stopped');
  };

  if (!active()) return finish('cancelled');
  if (expectedState.winner) return finish('game-over');

  while (requests < maxRequests) {
    if (!active()) return finish('cancelled');
    if (!current()) return finish('stale-state');
    const requestId = `${runId}:${player}:${turn}:${requests + 1}`;
    const observation = observeGame(expectedState, player);
    // 提供方拿到独立对象，修改自己的请求不能篡改本地校验依据。
    const request: ControllerRequest = {
      protocolVersion: 1, requestId, observation,
      controls: { allowOrderEdits: options.allowOrderEdits === true, remainingRequests: maxRequests - requests },
      ...(feedback ? { feedback: structuredClone(feedback) } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > maxRequestBytes) return fail('request-too-large');
    context.onEvent?.({ type: 'requested', requestId, turn, player });
    if (!active()) return finish('cancelled');
    if (!current()) return finish('stale-state');
    requests += 1;
    const response = await awaitReply(controller, structuredClone(request), timeoutMs, options.signal);
    if (!active() || response.kind === 'cancelled') return finish('cancelled');
    if (!current()) return finish('stale-state');
    if (expectedState.winner) return finish('game-over');
    if (response.kind === 'timeout') return fail('timeout');
    if (response.kind === 'error') return fail('provider-error');
    const parsed = parseControllerReply(response.value, requestId);
    let issue: { code: string; message: string } | undefined;
    let action: Action | undefined;
    if (!parsed.ok) {
      issue = parsed;
    } else {
      action = parsed.reply.action;
      const own = new Set(observation.units.filter((unit) => unit.owner === player).map((unit) => unit.id));
      const visible = new Set(observation.units.map((unit) => unit.id));
      if (action.type === 'SET_ORDERS' && !options.allowOrderEdits) {
        issue = { code: 'ORDERS_LOCKED', message: '当前控制权限不允许修改指挥官生产计划。' };
      } else if ('unitId' in action && action.unitId !== undefined && !own.has(action.unitId)) {
        issue = { code: 'UNIT_NOT_OWNED', message: '只能操作当前观察中的己方单位。' };
      } else if (action.type === 'ATTACK' && !visible.has(action.targetId)) {
        issue = { code: 'TARGET_NOT_OBSERVED', message: '只能攻击当前观察中可见的敌方单位。' };
      } else if (action.type === 'LOAD' && !own.has(action.cargoId)) {
        issue = { code: 'UNIT_NOT_OWNED', message: '只能装载当前观察中的己方单位。' };
      } else {
        const result = applyAction(expectedState, action, player);
        if (!result.ok) {
          issue = { code: 'RULE_REJECTED', message: '行动未通过游戏规则校验；请检查占位、距离、金币、时代与产能。状态未改变。' };
        } else {
          expectedState = result.state;
          appliedActions += 1;
          consecutiveRejections = 0;
          feedback = { status: 'applied', code: 'APPLIED', message: '行动已执行，请依据更新后的观察继续。', action };
          context.setState(result.state);
          context.save();
          context.render();
          context.onEvent?.({ type: 'applied', requestId, action: structuredClone(action),
            ...(parsed.reply.explanation === undefined ? {} : { explanation: parsed.reply.explanation }) });
          await context.sleep(delayMs);
          if (!active()) return finish('cancelled');
          if (context.getState() !== expectedState) return finish('stale-state');
          if (expectedState.winner) return finish('game-over');
          if (action.type === 'END_TURN') return finish('turn-ended');
          continue;
        }
      }
    }
    rejectedReplies += 1;
    consecutiveRejections += 1;
    feedback = { status: 'rejected', ...issue!, ...(action ? { action } : {}) };
    context.onEvent?.({ type: 'rejected', requestId, ...issue! });
    await context.sleep(0);
    if (consecutiveRejections >= maxRejections) return fail('invalid-replies');
  }
  return fail('request-limit');
}
