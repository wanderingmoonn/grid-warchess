/**
 * 地图统计：不画图，只量数字。
 *
 * 关心三件事：
 *   1. 水占比够不够"成规模"（不是零散碎片）
 *   2. 最大连通水体有多大（汪洋 / 大河）
 *   3. 城市布局 split / diagonal 的分布，以及横河纵河是不是真的不一样
 */
import { generateLayout } from '../src/core/mapgen.ts';
import type { MapStyle } from '../src/core/mapgen.ts';

function stats(rows: string[]) {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const water: boolean[] = [];
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isW = rows[y]?.[x] === '~';
      water[y * w + x] = isW;
      if (isW) count++;
    }
  }
  // 最大连通水体（四连通）
  const seen = new Uint8Array(w * h);
  let biggest = 0;
  let bodies = 0;
  for (let i = 0; i < w * h; i++) {
    if (!water[i] || seen[i]) continue;
    bodies++;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!water[q] || seen[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    biggest = Math.max(biggest, size);
  }
  return { ratio: count / (w * h), biggest, bodies };
}

const styles: MapStyle[] = ['random', 'river-h', 'river-v', 'ridge', 'open'];
const perStyle: Record<string, { ratios: number[]; biggest: number[]; bodies: number[]; split: number; diag: number }> = {};

for (const style of styles) {
  perStyle[style] = { ratios: [], biggest: [], bodies: [], split: 0, diag: 0 };
}

for (const size of [12, 16, 20]) {
  for (let seed = 1; seed <= 60; seed++) {
    for (const style of styles) {
      const m = generateLayout(size, seed * 97 + size, ['infantry', 'archer'], { style });
      const st = stats(m.rows);
      const rec = perStyle[style] as NonNullable<(typeof perStyle)[string]>;
      rec.ratios.push(st.ratio);
      rec.biggest.push(st.biggest / (size * size));
      rec.bodies.push(st.bodies);
      if (m.layout === 'split') rec.split++;
      else rec.diag++;
    }
  }
}

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] ?? 0;
const max = (a: number[]) => Math.max(...a);

console.log('style      水占比  最大水体占比  水体块数  split/diagonal');
for (const style of styles) {
  const r = perStyle[style];
  if (!r) continue;
  console.log(
    `${style.padEnd(10)} avg ${avg(r.ratios).toFixed(2)}  p90 ${p90(r.ratios).toFixed(2)}  ` +
      `max ${max(r.ratios).toFixed(2)} | avg ${avg(r.biggest).toFixed(2)} max ${max(r.biggest).toFixed(2)} | ` +
      `avg ${avg(r.bodies).toFixed(1)} | ${r.split}/${r.diag}`,
  );
}
