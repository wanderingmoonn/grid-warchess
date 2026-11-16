/**
 * 关卡的"文件进出"：导出成 .json 下载、从文件读回来。
 *
 * 为什么先把这条做扎实（而不是先做云端）：
 *   · 文件是唯一**永远能用**的备份方式——云端表没开通、域名换了、服务停了，文件还在；
 *   · 分享也不依赖任何人：把 .json 发给朋友，他拖进来就能玩。
 *
 * 格式只有一种：**能直接喂给 `validateLevel` 的对象**。
 * 多关导出时外面套一层 `{ v, kind, levels }`，导入时也接受"单个关卡"和"裸数组"——
 * 手写文件的人不该被迫背外壳。
 */

import { validateLevel, type LevelDef } from './level.ts';

/** 文件外壳的版本。加字段时可以据此迁移；现在只有 v1 */
export const LEVEL_FILE_VERSION = 1;

export interface LevelFileEnvelope {
  v: number;
  kind: 'warchess-levels';
  levels: LevelDef[];
}

/** 文件名：去掉路径分隔符和 Windows 不认的字符，再带上 id 尾巴避免重名覆盖 */
export function levelFileName(level: LevelDef): string {
  const safe = level.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || '关卡';
  const tail = level.id.replace(/^user:/, '').replace(/[^\w-]/g, '');
  return `${safe}-${tail}.json`;
}

export function buildLevelEnvelope(levels: LevelDef[]): LevelFileEnvelope {
  return { v: LEVEL_FILE_VERSION, kind: 'warchess-levels', levels };
}

/**
 * 从一段文本读关卡。
 *
 * 三种外壳都收：
 *   1. 单个关卡对象（最常见的"别人发我一个 .json"）；
 *   2. `{ v, kind, levels }`（我们导出的多关文件）；
 *   3. 裸数组（有人手工攒的）。
 *
 * 每条都过 `validateLevel`。**一条坏的不拖累其他条**：能读几条就读几条，
 * 坏的逐条报错——批量导入时"因为第 3 个文件坏了所以 1、2 也没进来"是最气人的。
 */
export function parseLevelFileText(
  text: string,
): { ok: true; levels: LevelDef[]; errors: string[] } | { ok: false; errors: string[] } {
  const src = text.trim();
  if (!src) return { ok: false, errors: ['文件是空的'] };

  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unexpected end of json input/i.test(msg)) {
      return { ok: false, errors: ['JSON 语法错：内容没写完，括号或引号没有闭合。'] };
    }
    const at = /position (\d+)/.exec(msg)?.[1];
    return {
      ok: false,
      errors: [at ? `JSON 语法错（大约第 ${src.slice(0, Number(at)).split('\n').length} 行）：${msg}` : `JSON 语法错：${msg}`],
    };
  }

  const raw: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as LevelFileEnvelope).levels)
      ? ((data as LevelFileEnvelope).levels as unknown[])
      : [data];

  const levels: LevelDef[] = [];
  const errors: string[] = [];
  for (const [i, item] of raw.entries()) {
    const checked = validateLevel(item);
    if (checked.ok) {
      levels.push(checked.level);
    } else {
      const label = raw.length > 1 ? `第 ${i + 1} 个关卡：` : '';
      errors.push(`${label}${checked.errors.join('；')}`);
    }
  }
  if (levels.length === 0) return { ok: false, errors: errors.length > 0 ? errors : ['文件里没有关卡'] };
  return { ok: true, levels, errors };
}

/**
 * 触发一次下载。
 *
 * 用 Blob + a[download]，不碰服务器：这条路在任何静态托管下都能用，
 * 也是"备份"该有的样子——不依赖我们把文件存到哪儿。
 */
function downloadText(filename: string, text: string): void {
  /*
   * 没有 document 就直接跳过。
   *
   * Node 里 `URL.createObjectURL` 是**存在的**（22 起），所以只判 URL 会漏过去，
   * 然后在 `document.createElement` 上炸——而这条路径本来只是"点一下导出"，
   * 不该让探针（或任何无 DOM 环境）跟着崩。
   */
  if (typeof document === 'undefined') return;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器上会让下载拿不到数据，给一拍再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadLevelFile(level: LevelDef): void {
  downloadText(levelFileName(level), JSON.stringify(level, null, 2));
}

export function downloadLevelsFile(levels: LevelDef[], name = '我的关卡'): void {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || 'levels';
  downloadText(`${safe}-${levels.length}张.json`, JSON.stringify(buildLevelEnvelope(levels), null, 2));
}

/** 读一个本地文件。用 FileReader 而不是 `file.text()`：后者在旧 WebView 上没有 */
export function readLevelFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** 存成".json"调色板之外的类型也别拦——有些系统给的 type 是空的 */
export function looksLikeJsonFile(file: File): boolean {
  return /\.json$/i.test(file.name) || file.type === 'application/json' || file.type === '';
}
