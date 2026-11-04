/*
 * 生成"带内置存档 + 自测"的探针页，用来在真浏览器里量 64×64 迷雾。
 *
 * 用法：node --experimental-strip-types scripts/make-fog-probe.ts <publicDir> <size>
 *
 * 为什么要把存档内嵌进 HTML：探针页要和应用**同一个 origin**，才能先把
 * warchess:match:v1 写进 localStorage 再加载 bundle；如果先跳转再写，
 * 脚本就断了，量不到任何东西。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { refreshMemory } from '../src/core/rules.ts';

const dir = process.argv[2] ?? '.';
const size = Number(process.argv[3] ?? 64);
const shell = readFileSync(join(dir, 'index.html'), 'utf8');

const probe = (fog: boolean): string => {
  const s = createMatch({ ...DEFAULT_CONFIG, size } as never, 12345, {});
  s.fog = fog;
  refreshMemory(s);
  const payload = JSON.stringify(s);

  return `<script>
/* 探针：写存档 → 装错误捕获 → 等应用起来后量一遍 */
(function () {
  try { localStorage.setItem('warchess:match:v1', ${JSON.stringify(payload)}); } catch (e) {}
  var errs = [];
  window.addEventListener('error', function (e) {
    errs.push((e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errs.push('unhandled: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });
  function mem() {
    var m = performance.memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) + 'MB' : 'n/a';
  }
  function report(tag) {
    var tiles = document.querySelectorAll('.tile');
    var out = document.querySelectorAll('.tile.out');
    var units = document.querySelectorAll('.unit');
    var text = '[PROBE ' + tag + '] tiles=' + tiles.length +
      ' out=' + out.length + ' units=' + units.length +
      ' heap=' + mem() + ' errors=' + (errs.length ? errs.join(' | ') : 'none');
    document.title = text;
    var box = document.getElementById('probe-out');
    if (!box) {
      box = document.createElement('div');
      box.id = 'probe-out';
      document.body.appendChild(box);
    }
    box.textContent = text;
  }
  /* 三个时点各量一次：首帧、3 秒后（布局/滤镜都铺开了）、8 秒后 */
  window.addEventListener('load', function () {
    /* 首页会盖住棋盘（玩家看见的第一屏），量盘面之前先把它撤掉 */
    setTimeout(function () {
      var home = document.querySelector('.title-screen');
      if (home) home.remove();
    }, 500);
    setTimeout(function () { report('t1'); }, 1200);
    setTimeout(function () { report('t3'); }, 3000);
    setTimeout(function () { report('t8'); }, 8000);
  });
})();
</script>
`;
};

for (const fog of [true, false]) {
  const name = `_probe-fog-${fog ? 'on' : 'off'}.html`;
  // 插在 module script 之前，保证应用启动时存档已经就位
  const html = shell.replace('<script type="module"', `${probe(fog)}<script type="module"`);
  writeFileSync(join(dir, name), html);
  console.log(`${join(dir, name)}  ${(html.length / 1024).toFixed(0)}KB`);
}
