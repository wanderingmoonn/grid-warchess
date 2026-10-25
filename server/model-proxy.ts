/** 仅在本机 Vite 服务内运行。凭证不会进入浏览器包、游戏状态或错误响应。 */
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CONTROLLER_INSTRUCTIONS } from '../src/controllers/instructions.ts';
import { CONTROLLER_REPLY_SCHEMA, parseControllerReply } from '../src/controllers/protocol.ts';
import type { ControllerRequest, ControllerReply } from '../src/controllers/protocol.ts';

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const MODEL_REQUEST_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 32 * 1024;
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODELS = new Set([DEFAULT_DEEPSEEK_MODEL, 'deepseek-v4-pro']);

export interface ModelProxyOptions {
  enabled: boolean;
  env?: Record<string, string | undefined>;
  /** 注入点供离线测试使用；生产代码只使用固定的 DeepSeek 地址。 */
  fetchImpl?: typeof fetch;
  credential?: () => Promise<string | null>;
  timeoutMs?: number;
  hourlyLimit?: number;
}

class ProxyFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Windows 当前用户 DPAPI 解密。文件名通过子进程环境传递，不拼接成脚本。 */
export function loadDeepSeekCredential(env: Record<string, string | undefined>): Promise<string | null> {
  const direct = env.DEEPSEEK_API_KEY?.trim();
  if (direct) return Promise.resolve(direct);
  const file = env.DEEPSEEK_CREDENTIAL_FILE;
  if (!file || process.platform !== 'win32') return Promise.resolve(null);
  const script = "$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString ([IO.File]::ReadAllText($env:GRID_WARCHESS_CREDENTIAL_FILE).Trim()); try { [Console]::Out.Write(([System.Net.NetworkCredential]::new('', $s)).Password) } finally { $s.Dispose() }";
  const shellRoot = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  const executable = join(shellRoot, 'powershell.exe');
  return new Promise((resolve) => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024,
      // 从 PowerShell 7 启动 Node 时，继承的模块路径会让 Windows PowerShell 5
      // 加载不兼容的 Security 模块；固定为该子进程自己的内置模块目录。
      env: { ...process.env, PSModulePath: join(shellRoot, 'Modules'), GRID_WARCHESS_CREDENTIAL_FILE: file },
    }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** 浏览器只可传观察协议，不能覆盖模型、指令、地址、token 上限或凭证。 */
function validRequest(value: unknown): value is ControllerRequest {
  if (!record(value) || !keys(value, ['protocolVersion', 'requestId', 'observation', 'controls'], ['feedback'])
    || value.protocolVersion !== 1 || typeof value.requestId !== 'string'
    || !value.requestId || value.requestId.length > 128 || !record(value.observation) || !record(value.controls)) return false;
  const o = value.observation;
  if (!keys(o, ['version', 'player', 'turn', 'current', 'round', 'maxRounds', 'winner', 'rules', 'self', 'board', 'cities', 'units', 'ghosts', 'unitTypes'])
    || o.version !== 1 || (o.player !== 'A' && o.player !== 'B') || o.current !== o.player
    || !Number.isSafeInteger(o.turn) || !record(o.rules) || !record(o.self) || !record(o.board)
    || !Array.isArray(o.cities) || !Array.isArray(o.units) || !Array.isArray(o.ghosts) || !record(o.unitTypes)) return false;
  if (!keys(value.controls, ['allowOrderEdits', 'remainingRequests']) || typeof value.controls.allowOrderEdits !== 'boolean'
    || !Number.isSafeInteger(value.controls.remainingRequests) || (value.controls.remainingRequests as number) < 1
    || (value.controls.remainingRequests as number) > 50) return false;
  if (value.feedback !== undefined && (!record(value.feedback)
    || !keys(value.feedback, ['status', 'code', 'message'], ['action'])
    || !['applied', 'rejected'].includes(String(value.feedback.status))
    || typeof value.feedback.code !== 'string' || typeof value.feedback.message !== 'string')) return false;
  return true;
}

function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function localOrigin(req: IncomingMessage): boolean {
  if (!loopback(req.socket.remoteAddress)) return false;
  try {
    const host = req.headers.host;
    if (!host || /[\s/@\\]/.test(host)) return false;
    const expected = new URL(`http://${host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== expected.origin) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    // POST 没有浏览器同源证明时也拒绝，防止表单与跨源脚本消耗本机凭证。
    return req.method !== 'POST' || origin === expected.origin;
  } catch { return false; }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

async function readRequest(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > MODEL_REQUEST_LIMIT) {
    throw new ProxyFailure(413, 'REQUEST_TOO_LARGE', '观察数据超过本地模型接口的大小限制。');
  }
  const buffers: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > MODEL_REQUEST_LIMIT) throw new ProxyFailure(413, 'REQUEST_TOO_LARGE', '观察数据超过本地模型接口的大小限制。');
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown; }
  catch { throw new ProxyFailure(400, 'INVALID_REQUEST', '请求必须是有效的观察 JSON。'); }
}

async function limitedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > RESPONSE_LIMIT) throw new Error('oversize');
      buffers.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown;
}

/** 返回 Promise 便于 HTTP 与离线测试复用，任何上游错误都仅转成固定文案。 */
export function createModelProxy(options: ModelProxyOptions) {
  const env = options.env ?? process.env;
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  const hourlyLimit = options.hourlyLimit ?? 120;
  let credential: Promise<string | null> | undefined;
  const getCredential = (): Promise<string | null> => {
    if (credential) return credential;
    // 并发状态检查共用正在进行的读取；临时解密失败不能让本机永久停在未配置状态。
    const pending: Promise<string | null> = Promise.resolve()
      .then(() => options.credential ? options.credential() : loadDeepSeekCredential(env))
      .catch(() => null)
      .then((key) => {
        if (!key && credential === pending) credential = undefined;
        return key;
      });
    credential = pending;
    return pending;
  };
  let busy = false;
  let windowStarted = Date.now();
  let requests = 0;

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/controller/')) { next(); return; }
    if (!options.enabled || !localOrigin(req)) {
      send(res, 403, { error: { code: 'LOCAL_ONLY', message: '模型操控仅供本机同源页面使用。' } }); return;
    }
    if (path !== '/api/controller/status' && path !== '/api/controller/decide') {
      send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } }); return;
    }
    const isStatus = path === '/api/controller/status';
    if (req.method !== (isStatus ? 'GET' : 'POST')) {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' } }); return;
    }
    if (isStatus) {
      const configured = MODELS.has(model) && !!await getCredential();
      send(res, 200, { configured, model: MODELS.has(model) ? model : DEFAULT_DEEPSEEK_MODEL,
        message: configured ? '已读取本机凭证，在线可用性以执行结果为准。' : 'DeepSeek 凭证或模型配置不可用，请检查本机服务配置。' });
      return;
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      send(res, 415, { error: { code: 'JSON_REQUIRED', message: '仅接受 application/json 请求。' } }); return;
    }
    if (busy) {
      send(res, 429, { error: { code: 'BUSY', message: '已有一个模型请求正在执行，请稍后重试。' } }); return;
    }
    busy = true;
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', onClose);
    const timer = setTimeout(() => {
      abort.abort();
      // 截止时间同时约束上传，不能让不结束请求体的客户端一直占用唯一名额。
      if (!req.complete) req.destroy();
    }, timeoutMs);
    try {
      const input = await readRequest(req);
      if (!validRequest(input)) throw new ProxyFailure(400, 'INVALID_REQUEST', '请求不符合单步操控者观察协议。');
      if (!MODELS.has(model)) throw new ProxyFailure(503, 'NOT_CONFIGURED', '本机模型配置不可用。');
      const key = await getCredential();
      if (!key) throw new ProxyFailure(503, 'NOT_CONFIGURED', '本机 DeepSeek 凭证不可用。');
      if (Date.now() - windowStarted >= 3600000) { windowStarted = Date.now(); requests = 0; }
      if (requests >= hourlyLimit) throw new ProxyFailure(429, 'REQUEST_BUDGET', '本机模型接口已达每小时请求上限，请稍后再试。');
      if (abort.signal.aborted) throw new Error('aborted');
      requests += 1;
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', signal: abort.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, thinking: { type: 'disabled' }, max_tokens: 512,
          temperature: 0.2, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${CONTROLLER_INSTRUCTIONS}\n回复 JSON Schema：${JSON.stringify(CONTROLLER_REPLY_SCHEMA)}\nJSON 格式示例：${JSON.stringify({ protocolVersion: 1, requestId: '原样使用本次 requestId', action: { type: 'END_TURN' }, explanation: '结束行动。' })}` },
            { role: 'user', content: JSON.stringify(input) },
          ],
        }),
      });
      if (!response.ok) {
        // 仅清除本机缓存，供用户下一次手动执行时重新读取；绝不自动重试付费请求。
        if (response.status === 401) credential = undefined;
        await response.body?.cancel().catch(() => {});
        const code = response.status === 401 ? 'CREDENTIAL_REJECTED' : response.status === 402 ? 'INSUFFICIENT_BALANCE' : response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE';
        const message = response.status === 401 ? 'DeepSeek 拒绝了本机凭证。' : response.status === 402 ? 'DeepSeek 测试账户余额不足。' : response.status === 429 ? 'DeepSeek 请求受限，请稍后重试。' : 'DeepSeek 暂时无法完成请求。';
        throw new ProxyFailure(502, code, message);
      }
      const output = await limitedResponse(response);
      const choice = record(output) && Array.isArray(output.choices) ? output.choices[0] as unknown : undefined;
      if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message) || typeof choice.message.content !== 'string') {
        throw new ProxyFailure(502, 'INVALID_PROVIDER_REPLY', '模型未返回完整的单步 JSON 指令。');
      }
      const parsed = parseControllerReply(choice.message.content, input.requestId);
      if (!parsed.ok) throw new ProxyFailure(502, 'INVALID_PROVIDER_REPLY', '模型回复未通过本地协议校验。');
      send(res, 200, parsed.reply satisfies ControllerReply);
    } catch (error) {
      if (error instanceof ProxyFailure) send(res, error.status, { error: { code: error.code, message: error.message } });
      else send(res, abort.signal.aborted ? 504 : 502, { error: {
        code: abort.signal.aborted ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        message: abort.signal.aborted ? '模型请求已取消或超时。' : '模型服务暂时不可用，请稍后重试。',
      } });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      busy = false;
    }
  };
}
