/**
 * 一次"决策"内的临时缓存层。
 *
 * 为什么需要它：规则层里有一批纯函数，单看每一行都不贵，但会在**同一次思考**
 * 里被反复问同一件事——"这个兵的光环加成是多少""这个兵的视野是几格"
 * "这一格看不看得见"。一次 AI 决策里攻防配对要算几万次，于是
 * `visionOf` 这种"每次都要扫一遍全场找驻扎建筑"的函数被乘成了 O(单位³)。
 * 实测 32×32、一百个兵时，单步思考从一秒多降下来，靠的就是别把同一件事问第二遍。
 *
 * 为什么是**显式作用域**，而不是"按状态永久记住"：
 * 状态在语义上是不可变的，但**构造过程中**会在同一个对象上原地改
 * （掉血、加状态、清尸体）。万一有钩子在改完之前读了一次并进了缓存，
 * 永久缓存就会把旧值一直递下去，那就成了改规则。这里只在
 * `aiNextAction` 的入口开、出口关：作用域内出现的局面都是"已经造好、
 * 不会再改"的，这条风险不存在。
 *
 * 用途约定：只在**热路径、且结果只取决于某个局面对象**的地方挂；
 * 不要拿它缓存"取决于玩家输入/时间"的东西。
 */

/** 当前是否在作用域内。0 表示没有，所有取缓存的调用都该走"现算"那条路 */
let depth = 0;

/** 按用途分表：每张表自己是一层 WeakMap<局面对象, 值>，局面回收时自动清掉 */
const tables = new Map<string, WeakMap<object, unknown>>();

/** 开一层。返回 true 表示这一层是你开的，出口要负责关掉（可重入） */
export function enterMemoScope(): boolean {
  depth += 1;
  if (depth === 1) tables.clear();
  return depth === 1;
}

export function exitMemoScope(): void {
  depth = Math.max(0, depth - 1);
  // 作用域一关，所有缓存整体失效：下一步的局面和这一步没有任何关系，
  // 留着只会在内存里攒一批永远读不到的死表
  if (depth === 0) tables.clear();
}

/**
 * 取一张按局面对象索引的缓存表。不在作用域里时返回 null，
 * 调用方据此走"现算"那条路——**行为完全一致，只是慢一点**。
 */
export function memoTable<V>(name: string): WeakMap<object, V> | null {
  if (depth === 0) return null;
  let t = tables.get(name) as WeakMap<object, V> | undefined;
  if (!t) {
    t = new WeakMap<object, V>();
    tables.set(name, t);
  }
  return t;
}

/** 在 `s` 这个局面下取/建一张 string 键的子表（多数缓存要按单位 id 索引） */
export function memoByState<V>(
  table: WeakMap<object, V>,
  s: object,
  create: () => V,
): V {
  const hit = table.get(s);
  if (hit !== undefined) return hit;
  const made = create();
  table.set(s, made);
  return made;
}
