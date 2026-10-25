/** 报告摘要与表格共用的格式化；不把历史模拟上限当成正式平局。 */
export interface PackOverviewEntry {
  name: string;
  games: number;
  packRatio: number | null;
  vanillaRatio: number | null;
}

export function relativeExchange(packRatio: number | null, vanillaRatio: number | null): number | null {
  if (packRatio === null || vanillaRatio === null || !Number.isFinite(packRatio)
    || !Number.isFinite(vanillaRatio) || packRatio < 0 || vanillaRatio <= 0) return null;
  const relative = packRatio / vanillaRatio;
  return Number.isFinite(relative) ? relative : null;
}

export function exchangeVerdict(packRatio: number | null, vanillaRatio: number | null): string {
  const relative = relativeExchange(packRatio, vanillaRatio);
  if (relative === null) return '样本不足';
  if (relative >= 1.25) return `**偏强**（×${relative.toFixed(2)}）`;
  if (relative >= 1.1) return `略强（×${relative.toFixed(2)}）`;
  if (relative > 0.9) return `**持平**（×${relative.toFixed(2)}）`;
  if (relative > 0.75) return `略弱（×${relative.toFixed(2)}）`;
  return `**偏弱**（×${relative.toFixed(2)}）`;
}

export function describePackOverview(entries: readonly PackOverviewEntry[]): string {
  const relatives = entries.map((entry) => relativeExchange(entry.packRatio, entry.vanillaRatio))
    .filter((value): value is number => value !== null);
  const range = relatives.length ? `×${Math.min(...relatives).toFixed(2)}～×${Math.max(...relatives).toFixed(2)}` : '样本不足';
  const details = entries.map((entry) => {
    const relative = relativeExchange(entry.packRatio, entry.vanillaRatio);
    return `${entry.name} ${relative === null ? '样本不足' : `×${relative.toFixed(2)}`}`;
  }).join('、');
  const samples = entries.map((entry) => `${entry.name} ${entry.games} 局`).join('、');
  return `现有历史样本中，模组战斗单位相对同局原版单位的交换比为 **${range}**。\n`
    + `${details || '尚无时代样本'}。样本规模：${samples || '0 局'}。\n`
    + '这些数值描述已保存对局中的单位交换，不能单独证明整体胜率、城墙堵路价值或当前合并版本的平衡性。';
}

export function describeOutcomes(summary: { draws: number; unresolved?: number }, games: number): string {
  if (summary.unresolved === undefined) return `历史未获胜 ${summary.draws}/${games}（旧数据未区分正式平局与模拟截断）`;
  return `正式平局 ${summary.draws}/${games}、未决 ${summary.unresolved}/${games}`;
}

export function percentageChange(before: number, after: number): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return '-';
  const change = (after / before - 1) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
}
