import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { UNIT_TYPES } from '../src/core/config.ts';
import { describeOutcomes, describePackOverview, exchangeVerdict, percentageChange, relativeExchange } from './pack-report-summary.ts';

test('摘要随同份数据变化，展示实际比值范围与各时代局数', () => {
  const first = describePackOverview([
    { name: '甲', games: 30, packRatio: 0.65, vanillaRatio: 1 },
    { name: '乙', games: 60, packRatio: 2.4, vanillaRatio: 2 },
  ]);
  assert.match(first, /×0\.65～×1\.20/);
  assert.match(first, /甲 ×0\.65、乙 ×1\.20/);
  assert.match(first, /甲 30 局、乙 60 局/);
  const updated = describePackOverview([{ name: '甲', games: 120, packRatio: 1.8, vanillaRatio: 1 }]);
  assert.match(updated, /×1\.80～×1\.80/);
  assert.match(updated, /甲 120 局/);
  assert.ok(!updated.includes('×0.65'));
});

test('没有承伤或有效基线时摘要保留样本不足，不产生无穷或NaN', () => {
  for (const pair of [[null, 1], [1, 0], [1, null], [Infinity, 1], [1, NaN], [-1, 1]] as const) {
    assert.equal(relativeExchange(pair[0], pair[1]), null);
  }
  const text = describePackOverview([{ name: '未知', games: 0, packRatio: null, vanillaRatio: 0 }]);
  assert.match(text, /样本不足/);
  assert.ok(!/NaN|Infinity/.test(text));
  assert.match(describePackOverview([]), /0 局/);
});

test('摘要和表格使用相同的比值与判定阈值', () => {
  assert.equal(exchangeVerdict(2.5, 2), '**偏强**（×1.25）');
  assert.equal(exchangeVerdict(2.2, 2), '略强（×1.10）');
  assert.equal(exchangeVerdict(2, 2), '**持平**（×1.00）');
  assert.equal(exchangeVerdict(1.6, 2), '略弱（×0.80）');
  assert.equal(exchangeVerdict(1.5, 2), '**偏弱**（×0.75）');
  assert.equal(exchangeVerdict(null, 2), '样本不足');
});

test('旧draws不标记成正式平局，新数据明确区分平局和未决', () => {
  assert.equal(describeOutcomes({ draws: 4 }, 30), '历史未获胜 4/30（旧数据未区分正式平局与模拟截断）');
  assert.equal(describeOutcomes({ draws: 1, unresolved: 3 }, 30), '正式平局 1/30、未决 3/30');
});

test('回合数变化只带一个正确符号，无有效基线时不计算', () => {
  assert.equal(percentageChange(100, 120), '+20%');
  assert.equal(percentageChange(100, 80), '-20%');
  assert.equal(percentageChange(100, 100), '+0%');
  assert.equal(percentageChange(0, 80), '-');
});

test('已有报告摘要覆盖实际五代JSON，且声明版本和样本边界', () => {
  interface Stat { type: string; category: string; built: number; dealt: number; taken: number }
  const names = ['古典', '中世', '火药', '工业', '现代'];
  const entries = names.map((name, index) => {
    const run = JSON.parse(fs.readFileSync(`results/packs/era${index + 1}.json`, 'utf8')) as { games: number; stats: Stat[] };
    const ratio = (pack: boolean) => {
      const pick = run.stats.filter((stat) => stat.category === 'combat' && stat.built > 0 && Object.hasOwn(UNIT_TYPES, stat.type) !== pack);
      const taken = pick.reduce((total, stat) => total + stat.taken, 0);
      return taken > 0 ? pick.reduce((total, stat) => total + stat.dealt, 0) / taken : null;
    };
    return { name, games: run.games, packRatio: ratio(true), vanillaRatio: ratio(false) };
  });
  const report = fs.readFileSync('results/packs/report.md', 'utf8');
  assert.ok(report.includes(describePackOverview(entries)), '摘要必须来自当前保存的JSON');
  assert.match(report, /不能当作当前 v5 合并版本的验证/);
  assert.match(report, /基线和模组不保证由同一版本 AI 生成/);
});
