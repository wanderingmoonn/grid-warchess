# 测试编写指南

`scripts/test-rules.ts` 是历史遗留下来的“大杂烩”，包含了核心规则和早期扩展的测试。

**从今天起，所有新增的扩展包测试，必须按照以下规范写在单独的文件里，禁止塞进 `test-rules.ts`。**

## 目录结构
- 扩展包的测试放在 `scripts/tests/packs/` 下。
- 文件名必须叫 `<扩展包id>.test.ts`（例如 `cultivation.test.ts`）。

## 模版
```ts
// @ts-nocheck
import { test, assert, stats, fresh, place2 } from '../support.ts';
import { applyAction, ... } from '../../../src/core/rules.ts';

export function run() {
  console.log('\n我的扩展包名');

  test('测试用例名', () => {
    // 你的断言
  });
}

// 允许单独运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}