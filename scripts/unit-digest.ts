/**
 * 命令行：打印一批卡在当前数值下的指纹（和运行端同一个实现）。
 *
 * 生成先验表时由 `scripts/draft-metrics.py --emit-ts` 调用，写进表头；
 * 运行端 `card-prior.ts` 会重算一遍来对表。
 *
 * 用法：
 *   node --experimental-strip-types scripts/unit-digest.ts witch musketeer crossbow
 *   echo "witch\nmusketeer" | node --experimental-strip-types scripts/unit-digest.ts --stdin
 */

import { fullUnitCatalog, unitDigest } from './lib/unit-digest.ts';
import fs from 'node:fs';

const args = process.argv.slice(2);
let ids: string[] = [];

if (args.includes('--stdin')) {
  ids = fs.readFileSync(0, 'utf8').split(/\s+/).filter(Boolean);
} else {
  ids = args.filter((a) => !a.startsWith('--'));
}

if (ids.length === 0) {
  console.error('需要卡 id：unit-digest.ts <id...> | --stdin');
  process.exit(2);
}

const cat = fullUnitCatalog();
const missing = ids.filter((id) => !cat[id]);
if (missing.length > 0) {
  // 不退出：缺卡本身会进指纹（missing），但要说一声，免得以为是 bug
  console.error(`注意：全扩展表里找不到 ${missing.length} 张卡（已按 missing 计入）：${missing.join(', ')}`);
}
console.log(unitDigest(ids, cat));
