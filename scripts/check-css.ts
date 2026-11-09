/**
 * 样式表结构检查：括号配平 + 不许嵌套规则 + 关键顶层选择器还在。
 *
 * 守的是 2026-11-09 那次线上事故：合并 `src/style.css` 时少写了一个 `}`，
 * `.status-chip.st-exposed` 的块一直开到最后，**它之后的几千行样式全成了它的
 * 嵌套内容**。浏览器把嵌套当 CSS Nesting 解析，等于把后半份样式表废掉——
 * 首页布局整体失效、点什么都没反应。而 `tsc` 和 200 多条 DOM 用例全是绿的：
 * 类型系统不管 CSS，jsdom 也不排版。
 *
 * 所以这条检查只看结构，不看好不好看：
 *   1. `{` 和 `}` 必须配平（这是那次事故的直接症状）；
 *   2. 规则不能嵌套在规则里（我们不用 CSS Nesting，出现就是切错了花括号）；
 *   3. `body` / `.main` / `.board-wrap` / `.topbar` 必须作为顶层规则存在
 *      （它们是最早被"吞掉"的那批，缺一个就说明布局已经没了）。
 *
 * 运行：npm run test:css
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = 'src/style.css';

/** 去掉注释与字符串：它们里面出现的花括号不算结构 */
function strip(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/**
 * 逐字符走一遍，返回问题清单。
 *
 * `stack` 记录每个未闭合块是什么：`@media` 这类 at-rule 允许包规则，
 * 普通规则不允许——后者就是那次事故的形态。
 */
function inspect(css) {
  const text = strip(css);
  const problems = [];
  const stack = [];
  let prelude = '';
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line += 1;

    if (ch === '{') {
      const name = prelude.trim().split('\n').pop()?.trim() ?? '';
      const parent = stack[stack.length - 1];
      if (parent === 'rule') {
        problems.push(`第 ${line} 行：规则嵌套在规则里——「${name}」落在了「${parent.prelude}」内部，多半是上一个块少写了 }`);
      }
      const isAt = name.startsWith('@');
      stack.push({ kind: isAt ? 'at' : 'rule', prelude: name, line });
      prelude = '';
      continue;
    }

    if (ch === '}') {
      if (stack.length === 0) {
        problems.push(`第 ${line} 行：多了一个 }，前面没有对应的 {`);
      } else {
        stack.pop();
      }
      prelude = '';
      continue;
    }

    if (ch === ';') {
      prelude = '';
      continue;
    }

    prelude += ch;
  }

  for (const open of stack) {
    problems.push(`第 ${open.line} 行：「${open.prelude}」这个块没有闭合（到文件末尾还差 }）`);
  }

  return problems;
}

const css = fs.readFileSync(SRC, 'utf8');

/* 1 + 2. 结构 */
const problems = inspect(css);
assert.deepEqual(problems, [], `${SRC} 结构有问题：\n  - ${problems.join('\n  - ')}`);

/* 3. 关键顶层规则还在（用最朴素的方式：行首就是选择器） */
const stripped = strip(css);
for (const sel of ['body', '.main', '.board-wrap', '.topbar']) {
  const re = new RegExp(`^\\s*${sel.replace('.', '\\.')}\\s*(,|\\{)`, 'm');
  assert.ok(re.test(stripped), `${SRC} 里找不到顶层规则「${sel}」——布局可能被谁吞掉了`);
}

const lines = css.split('\n').length;
console.log(`  ok   ${SRC}：${lines} 行，括号配平、无嵌套规则、关键布局规则在位`);
console.log('\n通过：样式表结构正常\n');
