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
 *   node --experimental-strip-types scripts/ui-shot.ts              # 桌面（1440×900）
 *   node --experimental-strip-types scripts/ui-shot.ts modern       # 桌面 + 新版主题
 *   node --experimental-strip-types scripts/ui-shot.ts mobile       # 手机（390×844 @2x）
 *   node --experimental-strip-types scripts/ui-shot.ts modern mobile
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

/*
 * 尺寸：默认桌面 1440×900，加 `mobile` 参数换成 iPhone 14 的 390×844。
 *
 * 为什么要真的按手机尺寸拍：窄屏的问题（并排挤成一团、按钮被裁、面板顶出
 * 屏幕）在 1440 的画布上**一次都复现不出来**——CSS 断点全是按视口走的。
 * 不拍就只能在手机上被用户看见。
 */
const ARGS = process.argv.slice(2);
const MOBILE = ARGS.includes('mobile');
/* 只拍选卡（BP）一屏：它平时要先在开局面板里勾「选卡模式」才会出现 */
const DRAFT = ARGS.includes('draft');
/*
 * 还能临时指定宽度（`w=360`）：安卓常见窄屏就是 360，而"刚好放不下"这种情况
 * 只会在某个具体宽度上出现——390 能放下不代表 360 能，差 30px 就是横滚。
 */
const W_ARG = ARGS.find((a) => /^w=\d+$/.test(a));
const W = W_ARG ? Number(W_ARG.slice(2)) : MOBILE ? 390 : 1440;
const H = MOBILE || W_ARG ? 844 : 900;
/* 手机按 2 倍像素密度拍，否则 390 宽的字在图上糊成一团、看不清断行对不对 */
const DPR = MOBILE || W_ARG ? 2 : 1;
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
  width: W, height: H, deviceScaleFactor: DPR, mobile: MOBILE,
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

const theme = ARGS.includes('modern') ? '&ui=modern' : '';
const tag =
  (theme ? 'modern' : 'legacy') +
  (MOBILE ? '-m' : '') +
  (W_ARG ? `-${W}` : '') +
  (DRAFT ? '-draft' : '');

/*
 * 每次运行前清一次本机存储。
 *
 * 不清的话，上一次跑 `draft` 点过的「开启选卡模式」会留在同一个
 * `.tmp/edge-profile` 里（那个开关是"勾一次就记住"），下一次拍普通对局
 * 拍到的却是一屏 BP——图看着没报错，内容却是错的。
 * 截图必须可重复，这是前提。
 */
await goto(BASE);
await evaluate('localStorage.clear()');

if (ARGS.includes('manual')) {
  /*
   * 规则书：只看长表（兵种一多那种）。
   *
   * 长表在 .scroll-x.tall 里**自己滚**（表头吸顶），所以验它要滚那个容器，
   * 不是滚窗口——滚窗口的话表头当然一直不动，等于什么都没测。
   */
  await goto(BASE + 'manual-pack-eras.html');
  // 手册页开了 `html { scroll-behavior: smooth }`：默认的 scrollIntoView 是动画，
  // 截的时候可能还停在半路（第一次就是这么拍到页面顶部的）。一律用 instant。
  await evaluate(`(() => {
    const box = document.querySelector('.scroll-x.tall');
    if (!box) return;
    const top = box.getBoundingClientRect().top + window.scrollY - 6;
    window.scrollTo({ top, behavior: 'instant' });
  })()`);
  await sleep(400);
  await shot(`10-manual-top${MOBILE ? '-m' : ''}`);

  // 纵向滚到表格中段 + 横向滚一点：表头该还在，兵种名该还贴左边
  await evaluate(`(() => {
    const box = document.querySelector('.scroll-x.tall');
    if (!box) return;
    box.scrollTop = 900;
    box.scrollLeft = 220;
  })()`);
  await sleep(400);
  await shot(`11-manual-scrolled${MOBILE ? '-m' : ''}`);

  proc.kill();
  staticServer.close();
  console.log('\n完成：', OUT);
  process.exit(0);
}

await goto(BASE + '?home=1' + theme);
await shot(`01-title-${tag}`);

// 标题页 → 开始对局（按文字点，选择器在这个项目里不稳）
if (!(await clickText('开始对局'))) console.log('  （标题页没找到「开始对局」）');
await sleep(900);
await shot(`02-setup-${tag}`);

// 自定义棋盘边长那一行（输入框 + 说明）。手机上面板几乎占满一屏，首屏拍不到它——
// 而"输入框被旁边那段说明挤出去/压住"恰恰只在窄屏出现。
await evaluate(`(() => {
  const b = document.querySelector('.modal-body');
  if (b) b.scrollTop = b.scrollHeight;
  const r = document.querySelector('.size-row');
  if (r) r.scrollIntoView({ block: 'center' });
})()`);
await sleep(350);
await shot(`02b-setup-end-${tag}`);

if (DRAFT) {
  // 勾上「选卡模式」再开打，才会进 BP 那一屏（默认配置里它是关的）
  const on = await evaluate(`(() => {
    const b = document.querySelector('[data-draft-mode="on"]');
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!on) console.log('  （没找到「开启选卡模式」）');
  await sleep(400);
  for (const label of ['开始对局', '开始', '进入战场', '开战']) {
    if (await clickText(label)) break;
  }
  await sleep(1800);
  await shot(`08-draft-${tag}`);
  // 还有一屏：点「开始选卡」之后才是真正的池子（左池右人）
  if (await clickText('开始选卡')) {
    await sleep(1500);
    await shot(`09-draft-pool-${tag}`);
  }
  proc.kill();
  staticServer.close();
  console.log('\n完成：', OUT);
  process.exit(0);
}

// 设置页 → 开打。按钮文案随状态变（"开始""进入战场"…），逐个别名试
for (const label of ['开始对局', '开始', '进入战场', '开战', '确认']) {
  if (await clickText(label)) {
    console.log('  点了「' + label + '」');
    break;
  }
}
await sleep(2000);
await shot(`03-battle-${tag}`);

// 设置弹窗（顶栏那颗「设置」）
await clickText('^设置$');
await sleep(500);
await shot(`05-settings-${tag}`);
await evaluate(`document.querySelector('[data-act="settings-close"]')?.click()`);
await sleep(250);

// 侧栏：点一个自己的单位，看属性卡（信息密度最高的地方）
await evaluate(`(() => {
  const u = document.querySelector('.unit');
  if (u) u.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
})()`);
await sleep(700);
await shot(`04-unit-${tag}`);

// 城市卡：侧栏里最长的一张（属性 + 升级 + 整张产兵表），也是窄屏最容易顶出屏幕的。
// 城是 2×2，有的格子上压着兵（点下去选中的是兵），所以逐格试到面板标题变成「城市」为止；
// 同一格连点会轮换、反而更不稳，这里每格只点一次。
await evaluate(`(() => {
  const title = () => document.querySelector('#side .unit-title')?.textContent ?? '';
  const n = document.querySelectorAll('.tile.t-city.own-A').length;
  for (let i = 0; i < n; i += 1) {
    const t = document.querySelectorAll('.tile.t-city.own-A')[i];
    if (!t) continue;
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (title().includes('城市')) break;
  }
})()`);
await sleep(600);
await shot(`07-city-${tag}`);

// 侧栏底部：产兵表尾巴 + 战报卡 + 结束回合。
// 滚的是谁取决于断点：桌面是 #side 自己滚，手机是 .main（整条竖着滚）。
await evaluate(`(() => {
  const cands = [document.querySelector('#side'), document.querySelector('.main')];
  for (const el of cands) {
    if (el && el.scrollHeight > el.clientHeight + 4) {
      el.scrollTop = el.scrollHeight;
      return;
    }
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
})()`);
await sleep(350);
await shot(`07b-city-end-${tag}`);

// 交接遮罩：每次换手都会出现，且刚改过（--mask 跟着主题走）
await clickText('结束行动');
await sleep(900);
await shot(`06-handoff-${tag}`);

proc.kill();
staticServer.close();
console.log('\n完成：', OUT);
process.exit(0);
