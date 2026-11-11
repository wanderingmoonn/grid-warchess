/**
 * 界面截图：用本机 Edge 的无头模式 + CDP 驱动真页面，把界面拍下来。
 *
 * 为什么需要它：UI 重构做了三轮，前两轮的 bug（白底白字、浅底浅字）**都是用户
 * 先看见的**——jsdom 能验"属性写对了"，但验不了"看得见"。改组件形状和布局之前
 * 先得有一双眼睛，否则就是在盲改。
 *
 * 不装 playwright/puppeteer：Windows 自带 Edge，用 `--remote-debugging-port` 起一个
 * 无头实例，再用 Node 22 自带的全局 WebSocket 说 CDP。零依赖。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ui-shot.ts            # 拍默认几张
 *   node --experimental-strip-types scripts/ui-shot.ts setup      # 只拍某一幕
 *
 * 产物在 `.tmp/shots/`。不出现在 npm test 里：它依赖本机浏览器和端口，
 * 不适合当 CI 闸门。
 */

// @ts-nocheck

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const W = 1440;
const H = 900;
/* 自带静态服务：不依赖外部的 python http.server。
   靠 `&` 起的后台进程会跟着上一条命令一起被收走，第一次就栽在这上面
   ——截出来一张"无法访问此页面"。服务写在脚本里，跑一次就有一套完整的。 */
const PORT_HTTP = 8099;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function startStatic(root: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(PORT_HTTP, '127.0.0.1', () => resolve(server)));
}

const staticServer = await startStatic('_publish');
const BASE = `http://127.0.0.1:${PORT_HTTP}/`;
const OUT = '.tmp/shots';

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl as string;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Edge 没起来（CDP 连不上）');
}

class Client {
  ws: WebSocket;
  id = 0;
  waiting = new Map<number, (v: any) => void>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data));
      const cb = this.waiting.get(msg.id);
      if (cb) {
        this.waiting.delete(msg.id);
        cb(msg.result);
      }
    });
  }

  async open() {
    await new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.cwd()}/.tmp/edge-profile`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--disable-gpu',
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

proc.stderr?.on('data', (b: Buffer) => {
  const t = String(b);
  if (/DevTools|error/i.test(t)) process.stderr.write('[edge] ' + t.trim().slice(0, 160) + '\n');
});

const browserUrl = await cdp();
const root = new Client(browserUrl);
await root.open();

// 建一个标签页
const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });
const page = (method: string, params: object = {}) => root.send(method, params, sessionId);

await page('Page.enable');
await page('Runtime.enable');
await page('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});

async function goto(url: string) {
  await page('Page.navigate', { url });
  await sleep(1400);
}

async function shot(name: string) {
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  拍下', file);
  return file;
}

async function evaluate(expression: string) {
  const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
}

/**
 * 按**文字**点按钮。
 *
 * 比选择器稳：这个项目的按钮大多没有稳定的 data-act（标题页、设置页都是
 * 直接写 <button>），而文字是玩家看得见的东西，改版时也不会悄悄变。
 */
async function clickText(re: string): Promise<boolean> {
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button, a, [data-act]')]
      .find((x) => new RegExp(${JSON.stringify(re)}).test((x.textContent || '').trim()));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (ok) await sleep(400);
  return ok;
}

/** 点一个选择器（先用 JS 找，找不到再报） */
async function click(selector: string) {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!ok) throw new Error('点不到 ' + selector);
  await sleep(280);
}

/* ── 场景 ─────────────────────────────────────────────────────────────── */

const theme = process.argv[2] === 'modern' ? '&ui=modern' : '';
const tag = theme ? 'modern' : 'legacy';

await goto(BASE + '?home=1' + theme);
await shot(`01-title-${tag}`);

// 标题页 → 开始对局（按文字点，选择器在这个项目里不稳）
if (!(await clickText('开始对局'))) console.log('  （标题页没找到「开始对局」）');
await sleep(900);
await shot(`02-setup-${tag}`);

// 设置页 → 开打。按钮文案随状态变（"开始""进入战场"…），逐个别名试
for (const label of ['开始对局', '开始', '进入战场', '开战', '确认']) {
  if (await clickText(label)) {
    console.log('  点了「' + label + '」');
    break;
  }
}
await sleep(2000);
await shot(`03-battle-${tag}`);

// 顶栏「更多」菜单展开。
// 必须用**真鼠标事件**（CDP Input）：<summary> 的展开走的是浏览器默认动作，
// 合成的 MouseEvent 不会触发它——第一版就是这么截出一张"菜单没开"的图。
const box = await evaluate(`(() => {
  const s = document.querySelector('.topbar-more > summary');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
if (box) {
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
await sleep(400);
await shot(`05-menu-${tag}`);
await evaluate(`document.querySelector('.topbar-more')?.removeAttribute('open')`);
await sleep(200);

// 侧栏：点一个自己的单位，看属性卡（信息密度最高的地方）
await evaluate(`(() => {
  const u = document.querySelector('.unit');
  if (u) u.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
})()`);
await sleep(700);
await shot(`04-unit-${tag}`);

// 交接遮罩：每次换手都会出现，且刚改过（--mask 跟着主题走）
await clickText('结束行动');
await sleep(900);
await shot(`06-handoff-${tag}`);

proc.kill();
staticServer.close();
console.log('\n完成：', OUT);
process.exit(0);
