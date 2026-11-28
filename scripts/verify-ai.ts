/**
 * 动 AI 之后的收尾验证（2026-11-23）。
 *
 * 为什么要有它：改 AI 的验证链是"类型 → 规则 → 界面 → 对打"四段，散在四条命令里，
 * 每次都靠人记顺序、记哪个该跳过。把它串成一条，agent 和人用同一个入口，
 * 也顺手把"跑多少局"这件事写死在命令里（默认不跑，要跑显式加 --duel）。
 *
 * 用法：
 *   npm run verify:ai                       # 类型 + 规则 + 冒烟（最常用的三件）
 *   npm run verify:ai -- --duel 60          # 再加 60 局 AI 对打（约 2~3 分钟）
 *   npm run verify:ai -- --duel 60 --shot   # 再加一张斜俯视截图
 *   npm run verify:ai -- --skip-ui          # 只动核心时跳过界面冒烟
 *
 * 注意：**这不是 `npm run ci` 的替代**。ci 还包含规则书比对与构建，
 * 发版前仍然要跑一次完整的 ci；这里只解决"改 AI 时该验什么、跑多少"。
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};

const DUEL = Number(argOf('duel', '0'));
const ERA = argOf('era', '1');
const PARALLEL = Number(argOf('parallel', String(Math.min(20, os.cpus().length))));
const SKIP_UI = args.includes('--skip-ui');
const SHOT = args.includes('--shot');

interface Step {
  name: string;
  cmd: string;
}

const steps: Step[] = [
  { name: '类型检查', cmd: 'npx tsc --noEmit' },
  { name: '规则测试', cmd: 'npm run test:rules' },
];
if (!SKIP_UI) steps.push({ name: '界面冒烟', cmd: 'npm run test:ui' });
if (DUEL > 0) {
  steps.push({
    name: `AI 对打（${DUEL} 局 · ${ERA} 代 · ${PARALLEL} 路并行）`,
    cmd: `npm run duel:batch -- --games ${DUEL} --era ${ERA} --parallel ${PARALLEL}`,
  });
}
if (SHOT) steps.push({ name: '斜俯视截图', cmd: 'node --experimental-strip-types scripts/ui-shot.ts angled' });

const started = Date.now();
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const t0 = Date.now();
  // `shell: true`：Windows 上 npm/npx 是 .cmd，直接 spawn 会 ENOENT
  const result = spawnSync(step.cmd, { shell: true, stdio: 'inherit' });
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  if (result.status !== 0) {
    console.error(`\n✗ ${step.name} 失败（${seconds}s）——后续步骤没有跑`);
    process.exit(1);
  }
  console.log(`✓ ${step.name} 通过（${seconds}s）`);
}

console.log(`\n全部通过（${((Date.now() - started) / 1000).toFixed(0)}s）。`);
if (DUEL === 0) {
  console.log('提示：这次没跑对打。要证"新 AI 更强"，加 `--duel 60`；');
  console.log('     要按老规矩先量动作变化率，用 `npm run probe:agreement`。');
}
