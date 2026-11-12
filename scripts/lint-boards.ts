/**
 * 多图护栏：盯着"又有人把地球当成唯一那张图"。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 多图之后，`state.tiles` / `idx()` / `tileAt()` / `inBounds()` / `xyOf()` /
 * `unitAt()` 这一批**默认指地球**。在地球上写对了、在月球上静默写错，
 * 编译器一句话都不说——这类错误只能靠人肉复查，而复查会漏。
 *
 * 所以这里做一道"棘轮"：把当前每个文件里的"地球口径调用次数"存成基线，
 * 以后**只能变少、不能变多**。新代码想用裸 `s.tiles`，先过这一关。
 *
 * ── 怎么让它满意 ──────────────────────────────────────────────────────
 *
 *   1. 手里有单位 → 用按单位的原语：`tileUnder` / `tileOf` / `spawnNear` /
 *      `boardStateOf`（扩展侧是 `c.view`、`c.api.tileOf`）；
 *   2. 手里只有坐标 → 显式要一个 board：`tileAtOn` / `idxOn` / `boardOf`；
 *   3. 确实是"只可能在地球"的地方（桥、地雷、城市经济）→ 在基线里留着，
 *      但**别让它变多**；
 *   4. 真的把某处改好了 → `npm run lint:boards -- --update` 把基线压下去。
 *
 * ── 不算违规的文件 ────────────────────────────────────────────────────
 *
 * `board.ts` / `query.ts` 是这些原语自己的实现；`fixed-maps.ts` 是地图数据。
 * 它们本来就该直接读写格表和索引。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts', 'lint-boards.baseline.json');

/** 原语的实现处与地图数据：它们本来就该直接摸格表 */
const EXEMPT = new Set([
  'src/core/board.ts',
  'src/core/query.ts',
  'src/core/fixed-maps.ts',
]);

/**
 * 要盯的写法。
 *
 * 注意每一条都以 `(` 结尾或带反引号——`idxOn(` 不该被 `idx(` 命中，
 * `tileAtOn(` 也不该被 `tileAt(` 命中。名字长得像是有意的：
 * 新代码一眼能看出"这是地球版"。
 */
const PATTERNS: Array<{ name: string; re: RegExp; why: string }> = [
  { name: 'state.tiles', re: /\.tiles\b/g, why: '`state.tiles` 永远是地球那张；别的图用 boardOf(s,id).tiles' },
  { name: 'idx(', re: /\bidx\(/g, why: 'idx 按地球宽度算格号；按图用 idxOn' },
  { name: 'tileAt(', re: /\btileAt\(/g, why: 'tileAt 读地球格；按图用 tileAtOn / tileUnder' },
  { name: 'inBounds(', re: /\binBounds\(/g, why: 'inBounds 按地球宽高判；按图用 boardOf' },
  { name: 'xyOf(', re: /\bxyOf\(/g, why: 'xyOf 按地球宽度反算坐标；按图用 xyOn' },
  { name: 'unitAt(', re: /\bunitAt\(/g, why: 'unitAt 只认地球那一格；按图用 boardStateOf 的投影' },
  { name: 'unitsAt(', re: /\bunitsAt\(/g, why: '同上：多图时先取视图，再问这一格有谁' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 统计一个文件里的违规次数（按行匹配，避免一行多计） */
function countIn(file: string): Record<string, number> {
  const text = readFileSync(file, 'utf8');
  const hits: Record<string, number> = {};
  for (const { name, re } of PATTERNS) {
    // 逐行跑：注释里提到这些名字（比如说明"别用 idx("）不该算违规
    let n = 0;
    for (const line of text.split('\n')) {
      const code = line.split('//')[0] ?? '';
      re.lastIndex = 0;
      if (re.test(code)) n += 1;
    }
    if (n > 0) hits[name] = n;
  }
  return hits;
}

const current: Record<string, Record<string, number>> = {};
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (EXEMPT.has(rel)) continue;
  const hits = countIn(file);
  if (Object.keys(hits).length > 0) current[rel] = hits;
}

const update = process.argv.includes('--update');
if (update) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n', 'utf8');
  const total = Object.values(current).reduce(
    (a, h) => a + Object.values(h).reduce((x, y) => x + y, 0),
    0,
  );
  console.log(`基线已更新：${Object.keys(current).length} 个文件，共 ${total} 处地球口径调用`);
  process.exit(0);
}

let base: Record<string, Record<string, number>> = {};
try {
  base = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof base;
} catch {
  console.error(`✗ 读不到基线 ${relative(ROOT, BASELINE)}；先跑一次 \`npm run lint:boards -- --update\``);
  process.exit(1);
}

interface Bad {
  file: string;
  name: string;
  was: number;
  now: number;
  why: string;
}

const bad: Bad[] = [];
for (const [file, hits] of Object.entries(current)) {
  for (const [name, now] of Object.entries(hits)) {
    const was = base[file]?.[name] ?? 0;
    if (now > was) {
      bad.push({ file, name, was, now, why: PATTERNS.find((p) => p.name === name)?.why ?? '' });
    }
  }
}

if (bad.length > 0) {
  console.error('✗ 又用了"默认地球"的写法（多图之下会静默出错）：\n');
  for (const b of bad) {
    console.error(`  ${b.file}  ${b.name}  ${b.was} → ${b.now}`);
    console.error(`      ${b.why}`);
  }
  console.error(
    '\n如果这次改动确实只可能在地球上（桥、地雷、城市经济），' +
      '用 `npm run lint:boards -- --update` 确认基线；\n' +
      '否则改成按单位/按图的写法（见 scripts/lint-boards.ts 开头）。',
  );
  process.exit(1);
}

const total = Object.values(current).reduce(
  (a, h) => a + Object.values(h).reduce((x, y) => x + y, 0),
  0,
);
console.log(`✓ 多图护栏：${Object.keys(current).length} 个文件、${total} 处地球口径调用，没有新增`);
