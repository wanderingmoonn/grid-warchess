/**
 * 地图打印机：把若干种子生成的地图打出来看。
 *
 * 地图这种东西只能靠眼睛验收——连通性可以测，但"看起来是不是每张都一个样"
 * 必须自己看。用法：
 *   node --experimental-strip-types scripts/dump-map.ts [尺寸] [数量]
 */

import { EXPANSIONS } from '../src/core/expansions.ts';
import { generateLayout, type MapStyle, type MapSymmetry } from '../src/core/mapgen.ts';

// 全部扩展都开着：这样 --style 里点得出高原/峡谷/火山群/沼泽，
// 打印出来的字符也才会出现 P（台地）v（谷地）w（沼泽）d（沙丘）l（熔岩）V（火山）。
const ALL_EXPANSIONS = EXPANSIONS.map((e) => e.id);

const size = Number(process.argv[2] ?? 16);
const count = Number(process.argv[3] ?? 6);

const styles: MapStyle[] = [(process.argv[4] as MapStyle | undefined) ?? 'random'];
const symmetry: MapSymmetry = 'fair';

for (let i = 0; i < count; i++) {
  const seed = 1000 + i * 137;
  const layout = generateLayout(size, seed, ['militia'], {
    style: styles[0],
    symmetry,
    expansions: ALL_EXPANSIONS,
  });
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
      // 新地形原样打出来：看不清在界面上是什么颜色时，看字符最快
      else if (row[x] && 'PvwdlsV'.includes(row[x] as string)) line += row[x];
      else line += '.';
    }
    console.log(String(y).padStart(2) + ' ' + line);
  });
}
