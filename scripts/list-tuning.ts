/**
 * 参数台账：把所有"拍的、以后要调"的常量列出来。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 *
 * "以后调"是最容易消失的承诺：值写在代码里、理由写在注释里、改过几次写在
 * 提交信息里，三个月后没人说得清哪个数是标定过的、哪个是拍的。
 * 这个脚本只做一件事：**把带 `@tune` 标记的常量扫出来排成一张表**，
 * 让"现在有哪些旋钮、各自是多少"有一个唯一的答案。
 *
 * ── 约定 ───────────────────────────────────────────────────────
 *
 * 新增"拍的值"时，在常量注释里写一行 `@tune`，后面跟一句"为什么是这个数"：
 *
 *   /** @tune 每座城的先验战力：开局看不见敌人时的下限，待跑批标定 *\/
 *   const FOE_FLOOR_PER_CITY = 60;
 *
 * 有推导、有实测的常量**不要**标（它们不是旋钮，是结论）。
 *
 * 用法：`npm run tune:list`（可加 `--md` 输出纯表格，便于贴进文档）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MD = process.argv.includes('--md');

interface Tune {
  file: string;
  line: number;
  name: string;
  value: string;
  note: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(p, out);
    } else if (entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

const found: Tune[] = [];
for (const file of walk(join(ROOT, 'src'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = line.indexOf('@tune');
    if (at < 0) continue;
    const note = line.slice(at + 5).replace(/\*\/\s*$/, '').trim();
    // 常量可能写在下一行（注释块与声明分开），往后找 6 行
    for (let j = i; j < Math.min(lines.length, i + 14); j++) {
      const m = lines[j]!.match(/const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*([^;]+);/);
      if (!m) continue;
      found.push({
        file: relative(ROOT, file),
        line: j + 1,
        name: m[1]!,
        value: m[2]!.trim().slice(0, 40),
        note,
      });
      break;
    }
  }
}

if (found.length === 0) {
  console.log('没有找到 @tune 标记。');
  process.exit(0);
}

// 同名常量只留第一次出现（避免 import 处的重复命中）
const seen = new Set<string>();
const rows = found.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));

if (MD) {
  console.log('| 参数 | 当前值 | 位置 | 为什么是这个数 |');
  console.log('|---|---|---|---|');
  for (const t of rows) console.log(`| \`${t.name}\` | \`${t.value}\` | ${t.file}:${t.line} | ${t.note} |`);
} else {
  console.log(`可调参数 ${rows.length} 个（带 @tune 标记）：\n`);
  let lastFile = '';
  for (const t of rows) {
    if (t.file !== lastFile) {
      console.log(`\n${t.file}`);
      lastFile = t.file;
    }
    console.log(`  ${t.name} = ${t.value}   ← ${t.note || '(没写理由)'}`);
  }
  console.log('\n提示：`npm run tune:list -- --md` 输出表格，便于贴进文档。');
}
