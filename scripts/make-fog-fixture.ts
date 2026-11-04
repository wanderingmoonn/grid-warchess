/*
 * 造一份 64×64 的存档，供浏览器探针加载。
 *
 * 用法：node --experimental-strip-types scripts/make-fog-fixture.ts <输出目录> [size] [fog:0|1]
 *
 * 产出两个文件：
 *   _fog-on.json / _fog-off.json —— 直接就是 warchess:match:v1 的值
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { refreshMemory } from '../src/core/rules.ts';

const outDir = process.argv[2] ?? '.';
const size = Number(process.argv[3] ?? 64);
mkdirSync(outDir, { recursive: true });

for (const fog of [true, false]) {
  const s = createMatch({ ...DEFAULT_CONFIG, size } as never, 12345, {});
  // fog 不是开局配置项（createMatch 里写死 CONFIG.fogDefault），是运行时开关，
  // 所以这里直接改状态位——和玩家点顶栏「迷雾」是同一件事
  s.fog = fog;
  refreshMemory(s);
  const text = JSON.stringify(s);
  const file = join(outDir, `_fog-${fog ? 'on' : 'off'}.json`);
  writeFileSync(file, text);
  console.log(`${file}  ${(text.length / 1024).toFixed(0)}KB  格数 ${s.w * s.h}  fog=${s.fog}`);
}
