/**
 * 地图打印机：把若干种子生成的地图打出来看。
 *
 * 地图这种东西只能靠眼睛验收——连通性可以测，但"看起来是不是每张都一个样"
 * 必须自己看。用法：
 *   node --experimental-strip-types scripts/dump-map.ts [尺寸] [数量]
 */

import { generateLayout, type MapStyle, type MapSymmetry } from '../src/core/mapgen.ts';

const size = Number(process.argv[2] ?? 16);
const count = Number(process.argv[3] ?? 6);

const styles: MapStyle[] = ['random'];
const symmetry: MapSymmetry = 'fair';

for (let i = 0; i < count; i++) {
  const seed = 1000 + i * 137;
  const layout = generateLayout(size, seed, ['militia'], { style: styles[0], symmetry });
  const marks = new Set(layout.citiesA.map((c) => `${c.x},${c.y}`));
  const marksB = new Set(layout.citiesB.map((c) => `${c.x},${c.y}`));
  const spawnA = new Map(layout.spawnsA.map((s) => [`${s.x},${s.y}`, 'a']));
  const spawnB = new Map(layout.spawnsB.map((s) => [`${s.x},${s.y}`, 'b']));

  console.log(`\nseed=${seed} 地貌=${layout.style} 对称=${layout.symmetry}`);
  layout.rows.forEach((row, y) => {
    let line = '';
    for (let x = 0; x < size; x++) {
      const k = `${x},${y}`;
      if (marks.has(k) || marksB.has(k)) {
        // 城市左上角标 A/B
        line += marks.has(k) ? 'A' : 'B';
        continue;
      }
      const unit = spawnA.get(k) ?? spawnB.get(k);
      if (unit) line += unit;
      else if (row[x] === 'f') line += 'f';
      else if (row[x] === 'h') line += 'h';
      else if (row[x] === '~') line += '~';
      else if (row[x] === '^') line += '^';
      else line += '.';
    }
    console.log(String(y).padStart(2) + ' ' + line);
  });
}
