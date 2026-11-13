/**
 * 格子之间补线。
 *
 * 只有一个用途：**拖动绘制时把手指/鼠标漏掉的格子补齐**。
 *
 * 为什么需要它：pointermove 不是按格子派发的。60Hz 下手指一划就是三四格，
 * 高刷新率鼠标一帧能跨半个屏幕（浏览器还会把中间采样压成一个事件）。
 * 只对"事件落点"那一格落笔，画出来是一条虚线——这正是"快速拖动会漏格"
 * 的唯一来源，跟渲染速度快慢无关。
 *
 * 为什么是 Bresenham 而不是浮点插值：棋盘是格子的，线要落在格子上。
 * 按步长采样再四舍五入会在斜线上来回抖（同一行被写两遍、相邻行漏掉），
 * 而 Bresenham 每一列/行恰好走一格，不会重也不会漏。
 *
 * 约定：**不含起点、含终点**。起点在上一次调用时已经画过了，
 * 重复画会让"来回划"在撤销记录里多出一堆无效格子。
 */
export function lineBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  if (x0 === x1 && y0 === y1) return out;

  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  /*
   * 上限按"棋盘最大 64×64 的对角线"给（64 格最多 64 步）。
   * 512 是留了余量的死循环保险：`err` 的步进在 dx=dy=0 时不会动，
   * 没有这个上限，将来谁改坏了分支条件就是一个卡死的拖动。
   */
  for (let guard = 0; guard < 512; guard += 1) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
  }
  return out;
}
