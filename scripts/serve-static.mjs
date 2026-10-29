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
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';

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

function resolvePath(urlPath) {
  let clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  if (clean.endsWith('/')) clean += 'index.html';
  // 挡住 ../ 穿越：拼完必须还在 ROOT 里面
  const full = normalize(join(ROOT, clean));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

async function send(req, res, filePath, status = 200) {
  const ext = extname(filePath).toLowerCase();
  const info = await stat(filePath);
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
    // 产物都是几 MB 以内的单文件，压一次放内存就够；不值得为它做磁盘缓存
    const body = gzipSync(await readFile(filePath));
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
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
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
    res.writeHead(400);
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
    // 没这个文件：给首页。战棋是单页应用，`?sharecode=...` 这类地址都得能进
    try {
      await send(req, res, join(ROOT, 'index.html'), 200);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT} on http://${HOST}:${PORT}`);
});
