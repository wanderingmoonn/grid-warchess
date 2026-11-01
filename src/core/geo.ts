/**
 * 几何小工具：只吃坐标和尺寸，不碰状态、不依赖任何规则。
 *
 * 单独一个文件的理由很实在：海军包和 AI 都要算"这条船离那座城多远"，
 * 而海军包不能 import rules——rules 那条链最终又会 import 回海军包，
 * 形成循环初始化（`Cannot access 'EXPANSIONS' before initialization`）。
 * 把这块纯几何放到最底层，两边都能拿，谁也不用绕开谁。
 */

/** 坐标到城市矩形的曼哈顿间距：贴着城边 = 1，城里 = 0 */
export function cityGap(
  city: { x: number; y: number; size: number },
  p: { x: number; y: number },
): number {
  const dx = Math.max(city.x - p.x, 0, p.x - (city.x + city.size - 1));
  const dy = Math.max(city.y - p.y, 0, p.y - (city.y + city.size - 1));
  return dx + dy;
}
