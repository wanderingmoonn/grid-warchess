/** 浏览器只与本机代理通信，凭证始终留在代理进程。 */
import type { GameController } from './protocol.ts';

export type ModelFetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface LocalModelStatus {
  configured: boolean;
  model: string;
  message: string;
}

const defaultFetch: ModelFetch = (input, init) => fetch(input, init);
const unavailable = () => new Error('本地模型代理暂不可用，请检查开发服务器与凭证配置。');

export async function getLocalModelStatus(signal: AbortSignal, fetcher: ModelFetch = defaultFetch): Promise<LocalModelStatus> {
  const response = await fetcher('/api/controller/status', { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw unavailable();
  const status: unknown = await response.json();
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw unavailable();
  const value = status as Record<string, unknown>;
  if (typeof value.configured !== 'boolean' || typeof value.model !== 'string' || value.model.length > 128
    || typeof value.message !== 'string' || value.message.length > 500) throw unavailable();
  return { configured: value.configured, model: value.model, message: value.message };
}

export function createLocalModelController(fetcher: ModelFetch = defaultFetch): GameController {
  return {
    id: 'local-deepseek',
    async decide(request, signal) {
      const response = await fetcher('/api/controller/decide', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw unavailable();
      // 格式、requestId 和规则仍由 executeControllerTurn 统一校验。
      try { return await response.json() as unknown; } catch { throw unavailable(); }
    },
  };
}
