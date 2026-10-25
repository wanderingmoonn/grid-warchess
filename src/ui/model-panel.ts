/** 一次明确启动一批模型决策；面板关闭或取消时由宿主中止任务。 */
import type { ControllerEvent, ControllerTurnResult, ControllerTurnStatus } from '../app/controller-turn.ts';
import { getLocalModelStatus, type ModelFetch } from '../controllers/local-model.ts';

export interface ModelPanelHandle {
  isOpen(): boolean;
  update(event: ControllerEvent): void;
  finish(result: ControllerTurnResult): void;
  close(): void;
}

export interface ModelPanelOptions {
  player: string;
  canRun: boolean;
  disabledReason?: string;
  onRun(panel: ModelPanelHandle): Promise<ControllerTurnResult>;
  onCancel(): void;
  /** 可注入离线传输；正常页面使用同源 fetch。 */
  fetcher?: ModelFetch;
}

const stoppedText: Record<ControllerTurnStatus, string> = {
  'turn-ended': '本回合已结束，已交给下一方。',
  'game-over': '对局已结束。',
  cancelled: '已暂停，保留已经执行的合法动作。',
  'stale-state': '局面已变化，旧任务已停止。',
  'request-limit': '已达到本批请求上限，当前回合暂停。',
  'request-too-large': '当前局面超过请求大小限制，已暂停。',
  'invalid-replies': '模型连续给出无效指令，已暂停。',
  timeout: '模型请求超时，已暂停。',
  'provider-error': '模型服务暂不可用，已暂停。',
  'fallback-completed': '算法 AI 已完成接管。',
  'fallback-stopped': '算法 AI 已停止。',
};

export function openModelPanel(options: ModelPanelOptions): ModelPanelHandle {
  const previousFocus = document.activeElement as HTMLElement | null;
  const mask = document.createElement('div');
  mask.className = 'modal-mask model-mask';
  mask.innerHTML = `<div class="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="model-title">
    <div class="modal-head"><h2 id="model-title">DeepSeek 操控者</h2><p data-model-side></p></div>
    <div class="modal-body">
      <section class="field"><div class="field-label">连接状态</div><p class="field-hint" data-model-status role="status">正在检查本地代理…</p></section>
      <section class="field"><div class="field-label">执行范围</div>
        <p class="field-hint">只执行当前方的本回合，每批最多 12 次决策请求。每一步都经过游戏规则校验；失败或达到上限即暂停，已执行动作会保存。</p>
        <p class="field-hint">点击执行会调用 DeepSeek 并产生 API 用量。结束后不会自动连续运行；关闭或暂停会中止当前等待。</p>
        <p class="field-hint" data-model-disabled></p>
      </section>
      <section class="field"><div class="field-label">决策进度</div><p data-model-progress role="status">尚未运行</p><ol class="online-notes" data-model-events aria-live="polite"></ol></section>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" data-act="model-run" disabled>执行本回合</button><button class="btn" data-act="model-cancel" hidden>暂停并接管</button><button class="btn" data-act="model-close">关闭</button></div>
  </div>`;
  const pick = <T extends Element>(selector: string) => mask.querySelector<T>(selector)!;
  const run = pick<HTMLButtonElement>('[data-act="model-run"]');
  const cancel = pick<HTMLButtonElement>('[data-act="model-cancel"]');
  const closeButton = pick<HTMLButtonElement>('[data-act="model-close"]');
  const status = pick<HTMLElement>('[data-model-status]');
  const progress = pick<HTMLElement>('[data-model-progress]');
  const events = pick<HTMLOListElement>('[data-model-events]');
  pick<HTMLElement>('[data-model-side]').textContent = `当前操控方：${options.player}。模型只能获得本方可见的观察。`;
  pick<HTMLElement>('[data-model-disabled]').textContent = options.canRun ? '' : options.disabledReason ?? '当前状态不能运行模型。';
  const statusAbort = new AbortController();
  let closed = false;
  let running = false;
  let started = false;
  let requests = 0;
  let cancelRequested = false;

  const requestCancel = () => {
    if (!running || cancelRequested) return;
    cancelRequested = true;
    cancel.disabled = true;
    progress.textContent = '正在暂停…';
    options.onCancel();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); handle.close(); }
    if (event.key === 'Tab') {
      const buttons = [...mask.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.disabled && !button.hidden);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const append = (message: string) => {
    const item = document.createElement('li');
    item.textContent = message;
    events.appendChild(item);
    // 上限也约束 UI 日志长度，连续拒绝/动作不会无限累积节点。
    while (events.children.length > 20) events.firstElementChild?.remove();
  };
  const handle: ModelPanelHandle = {
    isOpen: () => !closed,
    update(event) {
      if (closed) return;
      if (event.type === 'requested') {
        requests++;
        progress.textContent = `第 ${requests} / 12 次决策：模型正在选择行动…`;
      } else if (event.type === 'applied') {
        append(`${event.action.type}：${event.explanation ?? '行动已执行。'}`);
      } else if (event.type === 'rejected') {
        append(`指令被拒绝：${event.message}`);
      } else if (event.type === 'stopped') {
        progress.textContent = stoppedText[event.status];
      } else if (event.type === 'fallback') {
        append('正在切换算法 AI。');
      }
    },
    finish(result) {
      if (closed) return;
      running = false;
      run.disabled = true;
      cancel.hidden = true;
      progress.textContent = `${stoppedText[result.status]} 本批 ${result.requests} 次请求，${result.appliedActions} 个动作成功，${result.rejectedReplies} 次拒绝。`;
      closeButton.textContent = '回到棋盘';
    },
    close() {
      if (closed) return;
      requestCancel();
      closed = true;
      statusAbort.abort();
      document.removeEventListener('keydown', keydown);
      mask.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    },
  };
  run.addEventListener('click', () => {
    if (closed || started || run.disabled) return;
    started = true;
    running = true;
    run.disabled = true;
    cancel.hidden = false;
    progress.textContent = '正在启动本回合…';
    void Promise.resolve().then(() => closed ? undefined : options.onRun(handle)).then((result) => {
      if (result) handle.finish(result);
    }, () => handle.finish({ status: 'provider-error', requests, appliedActions: 0, rejectedReplies: 0, fallbackUsed: false }));
  });
  cancel.addEventListener('click', requestCancel);
  closeButton.addEventListener('click', () => handle.close());
  mask.addEventListener('click', (event) => { if (event.target === mask) handle.close(); });
  document.addEventListener('keydown', keydown);
  document.body.appendChild(mask);
  closeButton.focus();
  void getLocalModelStatus(statusAbort.signal, options.fetcher).then((result) => {
    if (closed) return;
    status.textContent = [result.model, result.message].filter(Boolean).join(' · ');
    run.disabled = !result.configured || !options.canRun || started;
  }, () => {
    if (!closed) status.textContent = '本地代理不可用。请使用本机开发服务器，并检查 DeepSeek 凭证配置。';
  });
  return handle;
}
