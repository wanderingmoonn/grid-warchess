import { generateLayout } from '../src/core/mapgen.ts';
import { TERRAIN_HEIGHT } from '../src/core/height-terrain.ts';
import type { Terrain } from '../src/core/types.ts';

const CH: Record<string, Terrain> = {
  '.': 'plain',
  f: 'forest',
  h: 'hill',
  '~': 'water',
  '^': 'mountain',
  '=': 'bridge',
  P: 'plateau',
  v: 'valley',
  w: 'marsh',
  d: 'dune',
  s: 'shallow',
  l: 'lava',
  V: 'volcano',
};

function grid(rows: string[]): Terrain[][] {
  return rows.map((r) => Array.from(r).map((c) => CH[c] ?? 'plain'));
}

function stats(g: Terrain[][]) {
  const count: Record<string, number> = {};
  let cells = 0;
  for (const row of g) for (const t of row) (count[t] = (count[t] ?? 0) + 1), cells++;
  // 相邻高差
  let abrupt = 0; // |dh| >= 2 的边数
  let edges = 0;
  let mountainNoSkirt = 0; // 高山四邻里没有 台地/高山 的个数（"柱子"）
  const h = g.length;
  const w = g[0]!.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = g[y]![x]!;
      const hh = TERRAIN_HEIGHT[t] ?? 0;
      let tall = false;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const n = g[y + dy]?.[x + dx];
        if (!n) continue;
        edges++;
        if (Math.abs((TERRAIN_HEIGHT[n] ?? 0) - hh) >= 2) abrupt++;
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = g[y + dy]?.[x + dx];
        if (n && (TERRAIN_HEIGHT[n] ?? 0) >= 4) tall = true;
      }
      if (t === 'mountain' && !tall) mountainNoSkirt++;
    }
  }
  return { count, cells, abrupt, edges, mountainNoSkirt };
}

const args = process.argv.slice(2);
const size = Number(args[0] ?? 20);
const seed = Number(args[1] ?? 7);
const styles = (args[2] ?? 'open,ridge,river-h,highland,canyon,volcanic,marsh,isles,river').split(',');

for (const style of styles) {
  for (const ext of [false, true]) {
    const lay = generateLayout(size, seed, ['infantry'], {
      style: style as never,
      expansions: ext ? ['height-terrain'] : [],
      symmetry: 'fair',
    });
    const g = grid(lay.rows);
    const s = stats(g);
    const dist = Object.entries(s.count)
      .filter(([t]) => t !== 'plain')
      .map(([t, n]) => `${t}:${((n / s.cells) * 100).toFixed(0)}%`)
      .join(' ');
    console.log(
      `\n=== ${style} ext=${ext ? 'on ' : 'off'} seed=${seed} size=${size} -> ${lay.style} ` +
        `abrupt=${s.abrupt}/${s.edges} (${((s.abrupt / Math.max(1, s.edges)) * 100).toFixed(1)}%) ` +
        `lonelyMountain=${s.mountainNoSkirt} | ${dist}`,
    );
    if (args.includes('--map')) console.log(lay.rows.join('\n'));
  }
}
