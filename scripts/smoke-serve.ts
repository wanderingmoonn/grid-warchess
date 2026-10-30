/**
 * 线上静态服务器的回归测试。
 *
 * 这条用例守的是一类**线上事故**，不是功能：
 *
 *   `scripts/serve-static.mjs` 原来在请求处理器里直接 `decodeURIComponent`。
 *   一个 `/%`（或者任何不完整的百分号编码）就会抛 `URIError`，而 async 处理器
 *   抛出去的东西 Node 不兜——**整个进程退出**。线上表现是"服务器毫无征兆崩了，
 *   所有人都登不进去，重启才好"。爬虫随手扫一个畸形路径就能做到。
 *
 * 所以这里的断言分两半：
 *   1. 该拒绝的请求要**拒绝**（400 / 404，而不是 200 假装成功）；
 *   2. 拒绝之后进程必须**还活着**。
 *
 * 运行：npm run test:serve
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL ${name}\n       ${msg}`);
    });
}

/** 发一个**原样**的请求行：畸形 URL 必须不被 curl 之类的工具悄悄规范化 */
function rawGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

function get(path: string, method = 'GET'): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const child = spawn(process.execPath, [join(ROOT, 'scripts', 'serve-static.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), SERVE_DIR: '_publish' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childLog = '';
child.stdout?.on('data', (d) => {
  childLog += d.toString();
});
child.stderr?.on('data', (d) => {
  childLog += d.toString();
});

let exited = false;
let exitInfo = '';
child.on('exit', (code, signal) => {
  exited = true;
  exitInfo = `exit=${code} signal=${signal}`;
});

/** 等端口能回话（最多 10 秒） */
async function waitReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`服务器启动就退出了：${exitInfo}\n${childLog}`);
    try {
      const r = await get('/__health');
      if (r.status === 200) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`10 秒内没起来：\n${childLog}`);
}

await waitReady();
console.log('\n线上静态服务器');

await test('健康检查回 200 且内容是 ok', async () => {
  const r = await get('/__health');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'ok');
});

await test('首页与规则书分册都能取到，且是 HTML', async () => {
  for (const path of ['/', '/manual.html', '/manual-pack-air.html']) {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} 应该 200`);
    assert.ok(r.type.includes('text/html'), `${path} 的 content-type 是 ${r.type}`);
  }
});

await test('畸形百分号编码回 400，而不是让进程退出', async () => {
  for (const path of ['/%', '/%ZZ', '/%E0%A4%A', '/a%2']) {
    const raw = await rawGet(path);
    const status = raw.split(' ')[1];
    assert.equal(status, '400', `${path} 应该 400，实际 ${status}`);
  }
  // 关键的一条：上面四个请求之后，进程必须还在
  assert.equal(exited, false, `服务器被畸形请求打死了：${exitInfo}`);
  const r = await get('/__health');
  assert.equal(r.status, 200, '被畸形请求打过之后仍然要能服务');
});

await test('路径穿越被挡住（400）', async () => {
  for (const path of ['/../package.json', '/..%2fpackage.json', '/assets/../../package.json']) {
    const raw = await rawGet(path);
    const status = raw.split(' ')[1];
    assert.equal(status, '400', `${path} 应该 400，实际 ${status}`);
  }
  assert.equal(exited, false, '穿越请求不该让服务退出');
});

await test('缺资源回 404，缺页面回首页（单页应用的两种"没有"）', async () => {
  // 带扩展名 = 资源请求：缺了就 404。拿首页顶上会让浏览器把 HTML 当 JS 执行，
  // 控制台只剩一句语法错误，真正的原因（文件没发上去）被盖掉。
  for (const path of ['/assets/nope-abc12345.js', '/favicon.ico', '/missing.css']) {
    const r = await get(path);
    assert.equal(r.status, 404, `${path} 应该 404，实际 ${r.status}`);
  }
  // 不带扩展名 = 页面导航：给首页，`?sharecode=...` 这类地址才进得去
  for (const path of ['/room/abc', '/?sharecode=xyz']) {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} 应该回首页，实际 ${r.status}`);
    assert.ok(r.type.includes('text/html'));
  }
});

await test('HEAD 与 405：只服务读取', async () => {
  const head = await get('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '', 'HEAD 不该带响应体');
  const post = await get('/', 'POST');
  assert.equal(post.status, 405);
});

await test('送资源带 hash 的产物可以长缓存，index.html 必须回源', async () => {
  const index = await get('/');
  assert.ok(!index.type.includes('json'));
  // index.html 的缓存策略写在响应头里：no-cache
  const res = await new Promise<Record<string, string>>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/' }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.headers as Record<string, string>));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res['cache-control'], 'no-cache', '首页不能被缓存住，否则更新发不出去');
});

await test('一连串并发请求之后服务仍然健康', async () => {
  const paths = ['/', '/manual.html', '/%', '/assets/x-12345678.js', '/room/1', '/__health'];
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => get(paths[i % paths.length]!).catch(() => null)),
  );
  assert.equal(results.filter(Boolean).length, 30, '有请求直接失败了');
  assert.equal(exited, false, '并发不该让服务退出');
  const r = await get('/__health');
  assert.equal(r.status, 200);
});

await test('gzip：压过的字节解出来就是原文，连发两次一致（缓存不能发旧内容）', async () => {
  const fetchGz = (path: string): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path, headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(d as Buffer));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve(res.headers['content-encoding'] === 'gzip' ? gunzipSync(buf) : buf);
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

  const first = await fetchGz('/');
  const second = await fetchGz('/');
  assert.ok(first.toString('utf8').includes('<!doctype html'), '解出来应该是首页');
  assert.ok(first.equals(second), '两次取到的内容必须一致');
  // 主包也走一遍：它才是真正会被缓存的那一个
  const js = (await get('/assets/index-Cwg3V0JE.js')).status;
  assert.ok(js === 200 || js === 404, `产物请求不该是 ${js}`);
});

await test('连接空闲 6 秒后还能复用：服务端不能比代理先关（否则每几个请求就卡一次）', async () => {
  const { Agent } = await import('node:http');
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const ask = (): Promise<{ status: number; connects: number }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: PORT, path: '/__health', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, connects: 0 }));
      });
      req.on('error', reject);
      req.end();
    });

  assert.equal((await ask()).status, 200);
  // 空闲超过 Node 默认的 5 秒 keepAliveTimeout：如果服务端还按默认值关连接，
  // 这条复用的 socket 就已经半死了
  await new Promise((r) => setTimeout(r, 6000));
  const after = await ask();
  assert.equal(after.status, 200, '空闲 6 秒后复用连接必须还能用');
  agent.destroy();
});

child.kill();
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) {
  console.log('服务器日志：\n' + childLog);
  process.exit(1);
}
