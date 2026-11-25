/**
 * 全套题库一把跑完，出矩阵。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 用户 2026-11-24 的担心：v3 是"实战发现一个问题、修一个问题"，越修越像那道题。
 * v4 换成题库，但**如果每次修改只让一道题变绿，性质是一样的**。
 *
 * 所以真正要看的不是"某道题绿了没有"，而是：
 *
 *   **这次修改，动了几道题？**
 *
 *   · 机制性修改（新约束、新流程）→ 会跨题动，而且方向一致；
 *   · 补丁式修改（调阈值、为某局面加特判）→ 只动一道题，别的纹丝不动。
 *
 * 这个脚本把"影响面"变成一张表：跑完和上一次对比，标出谁变了。
 *
 * 用法：
 *   node --experimental-strip-types scripts/exams-all.ts            # 打一张表
 *   ... --save                                                     # 同时存基线
 *   ... --diff                                                     # 和基线比，标出变化
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 在册的题。**故意写死**：作废的（S-003、S-007）不进来，
 * 否则每次跑都要重新读一遍 review.md 判断它还算不算数。
 * 加题在这里加一行——这也顺手挡住了"随手多造一道题"。
 *
 * 2026-11-25 补齐：原来只写到 S-017，新编号（`字母-档位-序号`）那 14 道没进来，
 * 于是"27 道"一直只能靠手跑。分组只为了读得懂，跑的时候一视同仁。
 *
 * · `S-xxx`：旧题，**只做参考**（太综合），红绿不参与"v4 行不行"的判断；
 * · `E/P/T/D`：四条意图轨（发展 / 打 / 接管 / 守），红了先去决定层、约束层找；
 * · `X`：打分层（集火、让位、靠拢这类跨意图动作），X 红了**不要去看 decide.ts**。
 *
 * 不进来：`S-003`/`S-007`（作废）、`S-014`/`S000L`/`Y-001`（没有 criteria）、
 * `Y-002`（关卡题，判据自己标了 `unusable`，红绿不作数）。
 */
const ACTIVE = [
  /* 旧题（参考） */
  'S-000', 'S-001', 'S-002', 'S-004', 'S-005', 'S-006',
  'S-009', 'S-011', 'S-012', 'S-013', 'S-015', 'S-016', 'S-017',
  /* 发展 · 打 */
  'E-1-01', 'E-1-02', 'P-1-01', 'P-1-02',
  /* 接管 */
  'T-1-01', 'T-1-02', 'T-2-01', 'T-2-02',
  /* 守 */
  'D-1-01', 'D-1-02', 'D-1-03',
  /* 打分层 */
  'X-1-01', 'X-1-02', 'X-2-01',
];

/** 答题者：空壳 / v1 / v3 / v4 */
const BRAINS = ['none', 'v1', 'v3', 'v4'] as const;

const BASE = '.tmp/exam-matrix.json';
const args = process.argv.slice(2);
const wantSave = args.includes('--save');
const wantDiff = args.includes('--diff');

interface Cell {
  verdict: '红' | '绿' | '?';
  /** 判据那一行原文，用来解释"为什么红" */
  detail: string;
}

function run(exam: string, brain: string): Cell {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/exam-grade.ts', '--exam', `exams/${exam}`, '--me-ai', brain, '--foe-ai', 'auto'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (err) {
    /*
     * 判分器**红的时候退出码是 1**（拿它当 CI 闸门用）。
     * 这里要的是"红"这个结论，不是"命令成功"，所以把 stdout 捞出来接着看。
     */
    const e = err as { stdout?: string; status?: number };
    out = e.stdout ?? '';
    if (!out) throw err;
  }
  const verdict = out.includes('结论：绿') ? '绿' : out.includes('结论：红') ? '红' : '?';
  /* 第一条"必须"判据的原文：红了多半就是它 */
  const must = out.split('\n').find((l) => l.includes('必须')) ?? '';
  return { verdict, detail: must.replace(/^\s+/, '').slice(0, 46) };
}

const matrix: Record<string, Record<string, Cell>> = {};
for (const exam of ACTIVE) {
  if (!existsSync(`exams/${exam}/criteria.json`)) {
    console.error(`⚠️ exams/${exam} 没有 criteria.json，跳过`);
    continue;
  }
  matrix[exam] = {};
  for (const brain of BRAINS) {
    process.stderr.write(`  ${exam} / ${brain} …\n`);
    matrix[exam]![brain] = run(exam, brain);
  }
}

/* ── 上一次的结果（有就比） ─────────────────────────────────── */
const prev: Record<string, Record<string, Cell>> | null =
  wantDiff && existsSync(BASE) ? (JSON.parse(readFileSync(BASE, 'utf8')) as typeof matrix) : null;

const mark = (exam: string, brain: string, now: Cell): string => {
  const before = prev?.[exam]?.[brain]?.verdict;
  if (!before || before === now.verdict) return now.verdict === '绿' ? '✅' : '  ';
  return now.verdict === '绿' ? '↑✅' : '↓❌';
};

const pad = (s: string, n: number): string => {
  /*
   * **终端宽度**，不是字符数：中文和 ✅ 都占两格。
   *
   * 原来只把汉字按 2 算（`/[\u4e00-\u9fa5]/`），于是 ✅ 按 1 算、实际渲染 2 格，
   * 整张表每列往右漂一格——27 行 4 列漂下来，看着像"空壳全绿"。
   * 凡是 `> 0xFF` 的字符都按 2 算（汉字、✅、❌ 都在里面；表头是 ASCII，不受影响）。
   */
  const w = [...s].reduce((a, ch) => a + (ch.codePointAt(0)! > 0xff ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

console.log('\n' + pad('题', 8) + BRAINS.map((b) => pad(b, 7)).join(''));
for (const exam of Object.keys(matrix)) {
  const row = BRAINS.map((b) => pad(mark(exam, b, matrix[exam]![b]!), 7)).join('');
  console.log(pad(exam, 8) + row);
}

/* 变化摘要：这才是判断"机制还是补丁"的地方 */
if (prev) {
  const changed: string[] = [];
  for (const exam of Object.keys(matrix)) {
    for (const b of BRAINS) {
      const before = prev[exam]?.[b]?.verdict;
      const now = matrix[exam]![b]!.verdict;
      if (before && before !== now) {
        changed.push(`${exam}/${b}: ${before} → ${now}`);
        continue;
      }
      /*
       * 红还是红，但判据上的数字动了也算"动了"。
       * 不加这条的话，"S-006 经济总产 13 → 39（还没到线）"会被当成"没生效"——
       * 那正好是最容易误判的一类：机制在起作用，只是还不够。
       */
      const was = prev[exam]?.[b]?.detail ?? '';
      const detailNow = matrix[exam]![b]!.detail;
      if (was && detailNow && was !== detailNow) changed.push(`${exam}/${b}: ${was} → ${detailNow}`);
    }
  }
  console.log('\n变化：' + (changed.length ? '\n  ' + changed.join('\n  ') : '无（这次修改一道题都没动）'));
  console.log(
    changed.length === 0
      ? '\n⚠️ 一道题都没动：那这次改的东西，要么没生效，要么只在你没测的地方有用。'
      : changed.length === 1
        ? '\n⚠️ 只动了一道题：**先假设是补丁**——问自己改的是机制还是数字。\n' +
          '   （例外：这次新增的机制本来就只有一道题在考，比如"经济兵站位"只有 S-006。）'
        : `\n动了 ${changed.length} 处：像机制性修改，再看方向一致不一致。`,
  );
}

if (wantSave) {
  writeFileSync(BASE, JSON.stringify(matrix, null, 2));
  console.log(`\n已存基线：${BASE}`);
}
