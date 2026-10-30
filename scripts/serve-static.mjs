/**
 * 线上用的静态服务器：托管 `_publish/`（vite build 的产物），不跑 vite。
 *
 * 为什么不用 `vite dev` 或 `vite preview`：
 *   - dev：浏览器要按 import 图逐个取 40 多个模块，每个请求都要过一次反代，
 *     首屏得等好几秒——"登上去好慢"就是它；
 *   - preview：得先 `vite build` 才能起，沙箱冷启动时构建加启动超过 60 秒，
 *     部署侧等不到端口就判失败。
 * 所以构建放在本地做，线上只负责把几个文件发出去。
 *
 * 只用 node 内置模块：不装依赖，起得快，也不会因为 lock 文件漂移而挂。
 */

import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(process.env.SERVE_DIR ?? '_publish');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** 能被 gzip 的类型。图片已经压过，再压一遍只是白烧 CPU。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);

/**
 * 带内容哈希的产物可以永久缓存——文件名变了 URL 就变了，不存在缓存错版本；
 * 其余（index.html）必须每次回源，否则用户会一直拿到旧页面。
 */
function cacheControl(path) {
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(path)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/**
 * 解码请求路径。
 *
 * `decodeURIComponent` 遇到不完整的百分号编码（`/%`、`/%E0%A4%A`、`/%ZZ`）会抛
 * `URIError`。这**不是**可以忽略的小事：它要是从请求处理器里漏出去，
 * Node 对 async handler 的 rejection 不做兜底，整个进程直接退出——
 * 线上表现就是"服务器毫无征兆地崩了，所有人都登不进去，重启才好"。
 * 一个爬虫随手扫一个畸形路径就能做到这件事，所以这里必须就地吃掉。
 */
function safeDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function resolvePath(urlPath) {
  const decoded = safeDecode(urlPath.split('?')[0] ?? '/');
  if (decoded === null) return null;
  let clean = decoded;
  if (clean.endsWith('/')) clean += 'index.html';
  // 挡住 ../ 穿越：拼完必须还在 ROOT 里面
  const full = normalize(join(ROOT, clean));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

/** 出错时的统一出口：头还没发就回一个状态码，已经发了就把连接断掉。 */
function fail(res, status, body, err) {
  if (err) console.error('[serve]', err?.code ?? '', err?.message ?? err);
  try {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    } else {
      res.destroy();
    }
  } catch {
    // 连接已经断了，没什么可做的
  }
}

/**
 * 压缩结果的缓存：`路径 → { key, body }`。
 *
 * 为什么必须有这一层：`gzipSync` 是**同步**的，压在事件循环上。主包 468KB，
 * 压一次的几十毫秒到几百毫秒里，整个进程一个请求都处理不了——包括 `/__health`。
 * 线上只有很薄的一份 CPU，一个人开页面就能把别人的请求一起拖住，
 * 表现成"点开链接半天没反应"。
 *
 * 键是 `size-mtime`：产物带内容哈希，文件名变了就是新文件；
 * 重新构建时同名文件的时间戳也会变，所以缓存不会发旧内容。
 */
const gzipCache = new Map();

/** 缓存上限：产物总共不到 10 个文件，留 24 个位置足够，超了整体清空 */
const GZIP_CACHE_MAX = 24;

function gzipBody(filePath, info) {
  const key = `${info.size}-${info.mtimeMs}`;
  const hit = gzipCache.get(filePath);
  if (hit && hit.key === key) return hit.body;
  const body = gzipSync(readFileSync(filePath));
  if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.clear();
  gzipCache.set(filePath, { key, body });
  return body;
}

async function send(req, res, filePath, status = 200) {
  const ext = extname(filePath).toLowerCase();
  const info = await stat(filePath);
  // 目录本身不该走到这里（调用方已经拼了 index.html）；真走到了就当没这个文件
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(36)}"`;

  // 重新验证：文件没变就 304，省掉整包传输
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl(filePath) });
    res.end();
    return;
  }

  const type = MIME[ext] ?? 'application/octet-stream';
  const headers = {
    'content-type': type,
    'cache-control': cacheControl(filePath),
    etag,
    vary: 'accept-encoding',
  };

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && COMPRESSIBLE.has(ext);
  if (wantsGzip) {
    // 压过的结果留在内存里，第二次起直接发（见 gzipBody）
    const body = gzipBody(filePath, info);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  headers['content-length'] = String(info.size);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // 用 pipeline 而不是裸 pipe：读文件失败（文件刚好被重新构建换掉）和
  // 客户端半路断开，都会变成这里能接住的一次异常。裸 pipe 的情况下
  // ReadStream 的 'error' 没人听，同样是一个能让进程退出的口子。
  await pipeline(createReadStream(filePath), res).catch(() => {});
}

async function handle(req, res) {
  // 客户端中途挂断（刷新、关标签页、网络切换）时不要连带抛错
  res.on('error', () => {});

  const urlPath = req.url ?? '/';

  // 健康检查：部署侧要的只是一个能回话的端口
  if (urlPath === '/__health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  const filePath = resolvePath(urlPath);
  if (!filePath) {
    // 畸形编码与路径穿越都走这里
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad path');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      await send(req, res, join(filePath, 'index.html'));
      return;
    }
    await send(req, res, filePath);
  } catch {
    // 带扩展名的路径（`/assets/index-xxx.js`、`/favicon.ico`）是资源请求，
    // 缺了就该老实回 404。要是像老版本那样一律拿首页顶上，
    // 浏览器会把 HTML 当 JS 执行，控制台里只剩一句莫名其妙的语法错误，
    // 而真正的原因（这个文件没发上去）被盖掉了。
    const ext = extname(filePath).toLowerCase();
    if (ext !== '' && ext !== '.html' && ext !== '.htm') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // 其余是页面导航：给首页。战棋是单页应用，`?sharecode=...` 这类地址都得能进
    try {
      await send(req, res, join(ROOT, 'index.html'), 200);
    } catch (err) {
      fail(res, 404, 'not found', err);
    }
  }
}

const server = createServer((req, res) => {
  // 任何漏网的异常都只影响这一个请求。静态文件服务器的职责只有"发字节"，
  // 一个坏请求把整个对局服务带走，代价远大于这一次请求失败。
  handle(req, res).catch((err) => fail(res, 500, 'internal error', err));
});

/**
 * 连接空闲超时。
 *
 * ⚠️ 这一行是"点开链接要等五到十秒，但刷新一下就好了"的原因，不是可选项。
 *
 * Node 默认 `keepAliveTimeout = 5s`：空闲五秒就把连接关掉。但前面那层反向代理
 * 的连接池会把它当成"还能用"，继续往这条正在关闭的 socket 上发请求——于是请求
 * 落进一个已经半关的连接里，代理只能等自己的超时再重试一次。
 * 表现就是**随机**的 5~10 秒停顿：同一个页面，有时 0.5 秒，有时 8 秒，
 * 连 `/__health` 这种一个字节都不读的路径也一样（这一点最能说明问题：
 * 慢的不是文件，是连接）。
 *
 * 反过来做就对了：服务端的空闲超时必须**比代理长**，让关闭永远由代理先发起。
 * 65 秒是业界常用的取值（比常见的 60 秒代理超时多留一点余量）。
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// 大文件在慢速链路上可能传很久，别让 node 从中间掐断
server.requestTimeout = 0;

// 畸形的请求行/头部（半截 HTTP、超长头）：回 400 并关掉这条连接
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
});

// 最后一道保险：真出现没接住的异常 / rejection，记一行日志继续服务，别静默退出。
// 线上没有终端，崩溃前那行错误是唯一线索——所以这里一定要打印。
process.on('uncaughtException', (err) => console.error('[serve] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[serve] unhandled', err));

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT} on http://${HOST}:${PORT}`);
});
