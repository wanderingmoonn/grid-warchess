/**
 * 单位贴图的清单生成器。
 *
 * 为什么不手写 `manifest.json`：加一张图要记得改两处，迟早漏一处；漏了的表现是
 * "图明明在目录里却显示成汉字"，排查起来还得想到清单这一层。
 *
 * 为什么不让运行时"猜路径、404 就回退"：每个没图的兵种都会在控制台刷一条 404，
 * 330 个兵种就是 330 条红字——把真问题淹掉。所以先给一份能查的名单。
 *
 * 用法：`npm run art:index`（`build:static` 里已经串上）。
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'public/art/units';
const OUT = path.join(DIR, 'manifest.json');

if (!fs.existsSync(DIR)) {
  console.log(`没有 ${DIR}/，跳过（全部兵种继续用汉字）`);
  process.exit(0);
}

const ids = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .sort();

fs.writeFileSync(OUT, `${JSON.stringify({ units: ids }, null, 0)}\n`, 'utf-8');
console.log(`贴图清单：${ids.length} 个兵种 → ${OUT}`);
if (ids.length > 0) console.log('  ' + ids.join(' '));
