# 测试编写指南

`scripts/test-rules.ts` 是历史遗留下来的“大杂烩”，包含了核心规则和早期扩展的测试。为了保持工程可维护性，请遵循以下规范：

## 1. 核心规矩
**从今天起，所有新增的扩展包测试，必须写在单独的文件里，禁止塞进 `test-rules.ts`。**

## 2. 目录结构
- 扩展包的测试统一放在 `scripts/tests/packs/` 下。
- 文件名命名规范：`<扩展包id>.test.ts`（例如 `cultivation.test.ts`、`fantasy.test.ts`）。
- 公共的测试辅助函数（如 `fresh`, `place2`, `arena`）统一维护在 `scripts/tests/support.ts`。

## 3. 测试模版
新建测试文件时，请复制以下模版：
```ts
// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { test, assert, stats, fresh, place2 } from '../support.ts';
import { applyAction } from '../../../src/core/rules.ts';

export function run() {
  console.log('\n我的扩展包名');

  test('测试用例名', () => {
    // 你的断言
  });
}

// 魔法代码：允许单独运行此文件
//
// 一定要用 `pathToFileURL`。Windows 下 argv[1] 是 `G:\a\b.ts`，拼出来的
// `file://G:\a\b.ts` 永远不等于 `file:///G:/a/b.ts`——用例会静默跑 0 项并返回 0，
// 看起来通过、其实什么都没测。（`cultivation.test.ts` 就这样空转过一整轮。）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}