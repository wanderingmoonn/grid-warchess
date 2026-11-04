/*
 * 田字四区双城的落点体检。
 *
 * 回答三个问题，都是"随机"这个字容易被糊弄过去的地方：
 *   · 两座基地的间距实际抽成多少（最小值比下限高多少）；
 *   · 不同种子的摆法到底有几种（不是"只有对角"）；
 *   · 基地离区域边界留了几格。
 *
 * 用法：node --experimental-strip-types scripts/probe-quad.ts [size] [seeds]
 */
import { generateMultiLayout } from '../src/core/mapgen.ts';

const size = Number(process.argv[2] ?? 20);
const seeds = Number(process.argv[3] ?? 300);

const hist = new Map<number, number>();
const keys = new Set<string>();
let minD = 99;
let minEdge = 99;
let perQuadEdge = 0;

for (let seed = 1; seed <= seeds; seed += 1) {
  const L = generateMultiLayout(size, seed, ['militia'], { players: 4, twoCities: true });
  const per = [L.citiesA, L.citiesB, L.citiesC!, L.citiesD!];
  per.forEach((cities, qi) => {
    const [a, b] = cities as [{ x: number; y: number }, { x: number; y: number }];
    if (!a || !b) throw new Error(`seed ${seed} 第 ${qi} 家只有 ${cities.length} 座城`);
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    hist.set(d, (hist.get(d) ?? 0) + 1);
    if (d < minD) minD = d;
    keys.add(`${qi}:${a.x},${a.y}-${b.x},${b.y}`);
    // 离区域边界还剩多少格（只算城本体的外沿）
    const hw = Math.floor(size / 2);
    const hh = Math.floor(size / 2);
    const x0 = qi === 1 || qi === 2 ? hw : 0;
    const y0 = qi === 2 || qi === 3 ? hh : 0;
    const x1 = qi === 1 || qi === 2 ? size : hw;
    const y1 = qi === 2 || qi === 3 ? size : hh;
    const edge = Math.min(a.x - x0, y0 === 0 ? 999 : a.y - y0, x1 - (a.x + 2), y1 - (a.y + 2));
    if (edge < minEdge) minEdge = edge;
    if (edge <= 0) {
      perQuadEdge += 1;
      console.log(`  ! seed ${seed} 第 ${qi} 家的 (${a.x},${a.y}) 贴到区域边界（余 ${edge}）`);
    }
  });
}

console.log(`${size}×${size} / ${seeds} 个种子 / 4 家`);
console.log(`  同家两城间距（切比雪夫，锚点到锚点）分布：`);
for (const d of [...hist.keys()].sort((x, y) => x - y)) {
  const n = hist.get(d)!;
  const bar = '█'.repeat(Math.round((n / (seeds * 4)) * 60));
  console.log(`    ${String(d).padStart(2)} 格  ${String(n).padStart(4)} 次  ${bar}`);
}
console.log(`  最小间距 ${minD}，离区域边界最少余 ${minEdge} 格`);
console.log(`  不同摆法 ${keys.size} 种（理论上限 ${seeds * 4}）`);
console.log(`  贴边 ${perQuadEdge} 次`);
