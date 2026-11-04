/**
 * 一条小桥：让 `npm run` 能调起项目内的虚拟环境。
 *
 * 为什么不直接在 package.json 里写 `.venv/Scripts/python.exe`：
 * npm 在 Windows 上走 cmd、在 bash 里走 sh，正反斜杠和相对路径的解析规则不一样，
 * 同一个字符串总有一种环境跑不通（实测 `'.venv' 不是内部或外部命令`）。
 * 与其在脚本里写两套，不如让 node 去找解释器——它两边都认。
 *
 * 用法：node scripts/rl/py/bridge.mjs <脚本名> [参数...]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('用法：node scripts/rl/py/bridge.mjs <parity|train|loop> [参数...]');
  process.exit(1);
}

const venvPy =
  process.platform === 'win32' ? path.join('.venv', 'Scripts', 'python.exe') : path.join('.venv', 'bin', 'python');

let py = venvPy;
if (!existsSync(py)) {
  // 没建虚拟环境就别硬碰：直接用 PATH 里的 python，让报错落在"缺包"而不是"找不到文件"
  console.warn(`（没找到 ${venvPy}，退回系统 python）`);
  py = process.platform === 'win32' ? 'python' : 'python3';
}

const file = path.join('scripts', 'rl', 'py', `${script}.py`);
const r = spawnSync(py, [file, ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
