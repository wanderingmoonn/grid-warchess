/**
 * 关卡编辑器（E0 + E1）的探针。
 *
 * E0 回答一个问题：**玩家做的关能不能像内置关一样走完一局的一生**。
 * E1 回答另一个：**改错的地方能不能被指出来，而且指得对**。
 *
 * 这里刻意跑在 node 里（没有 localStorage）：`userLevels.ts` 在拿不到 localStorage 时
 * 退化成"只在内存里"，所以注册表、校验、建局、删除这几条照样能测。
 * 唯一测不到的是"真的写到磁盘上"——那条只能在浏览器里手动验，写在 PLAN 的固定动作第 3 条。
 *
 * 用法：npm run probe:level-editor
 */

import { aiNextAction } from '../src/core/ai.ts';
import { LEVELS, allLevels, levelById, playableLevels, validateLevel } from '../src/core/level.ts';
import { validateFixedMap } from '../src/core/fixed-maps.ts';
import { citiesOf } from '../src/core/rules.ts';
import { lintLevel } from '../src/core/level-lint.ts';
import { applyAction, isCitylessSeat, isEliminated } from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { downloadLevelFile, downloadLevelsFile, parseLevelFileText } from '../src/core/level-io.ts';
import { levelUploadBlocker } from '../src/net/levels.ts';
import {
  cloneAsUserLevel,
  deleteUserLevel,
  exportLevelText,
  isUserLevelId,
  loadUserLevels,
  parseLevelText,
  saveUserLevel,
  userLevelList,
} from '../src/core/userLevels.ts';
import type { LevelDef } from '../src/core/level.ts';
import type { GameState } from '../src/core/types.ts';

let failed = 0;
const ok = (what: string, extra = ''): void => {
  console.log(`  ✓ ${what}${extra ? `  ${extra}` : ''}`);
};
const bad = (what: string, why: string): void => {
  failed += 1;
  console.log(`  ✗ ${what}\n      ${why}`);
};
const check = (cond: boolean, what: string, why = ''): boolean => {
  if (cond) ok(what);
  else bad(what, why);
  return cond;
};
const line = (t: string): void => {
  console.log(`\n${t}`);
};

/** 一张"能开局"的最小关卡：改这个来造各种坏样本 */
function sample(over: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'user:probe-base',
    version: 1,
    name: '探针关',
    brief: '探针用，不给人玩',
    map: {
      id: 'levelmap:probe-base',
      name: '探针关',
      w: 10,
      h: 8,
      rows: [
        '..........',
        '..........',
        '....^^....',
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
      ],
      citiesA: [{ x: 1, y: 1 }],
      citiesB: [{ x: 7, y: 5 }],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'] },
    setup: { startEra: 1 },
    deploy: {
      A: [{ type: 'militia', x: 3, y: 3 }],
      B: [{ type: 'militia', x: 7, y: 3 }],
    },
    ...over,
  };
}

/* ── 1. 注册表：装得进去，且不污染内置 ─────────────────────────── */
line('1. 用户关卡注册表');
const builtinCount = LEVELS.length;
check(allLevels().length === builtinCount, '一开始没有用户关卡（不污染内置表）', `现在 ${allLevels().length} 张`);

const saved = saveUserLevel(sample());
if (!check(saved.ok, '一张合规的关卡能存进去', saved.ok ? '' : saved.errors.join('；'))) {
  console.log('\n存不进去，后面没法测');
  process.exit(1);
}
if (!saved.ok) process.exit(1);

check(LEVELS.length === builtinCount, '存了之后内置表长度不变', `内置 ${LEVELS.length} vs ${builtinCount}`);
check(allLevels().length === builtinCount + 1, 'allLevels() 能看见它');
check(
  playableLevels().some((l) => l.id === saved.level.id),
  'playableLevels() 里也有（否则选关页看不到）',
);
check(levelById(saved.level.id)?.name === '探针关', 'levelById 能按 id 找到它');
check(isUserLevelId(saved.level.id), `id 带 user: 前缀`, saved.level.id);

/* ── 2. 内置与用户的 id 冲突 ────────────────────────────────────── */
line('2. id 冲突时内置优先');
const builtinOne = LEVELS.find((l) => l.dev !== true) ?? LEVELS[0]!;
const collide = saveUserLevel(sample({ id: builtinOne.id, name: '假冒的内置关' }));
check(!collide.ok, '不允许用内置关的 id 存一张自己的关', collide.ok ? '竟然存进去了' : '被拦住了');
check(
  levelById(builtinOne.id)?.name === builtinOne.name,
  'levelById 仍然返回内置那一份',
  levelById(builtinOne.id)?.name ?? 'null',
);

/* ── 3. 版本号 ──────────────────────────────────────────────────── */
line('3. 每存一次版本号 +1');
const v1 = saveUserLevel(sample());
const v2 = saveUserLevel(sample());
check(v1.ok && v2.ok, '同一张关能存两次');
if (v1.ok && v2.ok) {
  check(v2.level.version === v1.level.version + 1, '版本号自增', `${v1.level.version} → ${v2.level.version}`);
  check(userLevelList().filter((it) => it.level.id === v2.level.id).length === 1, '同 id 只留一份（不是追加）');
}

/* ── 4. 用户关卡能开局、能推进 ───────────────────────────────────── */
line('4. 用户关卡能开局');
const mine = levelById(saved.level.id);
let state: GameState | null = null;
if (!mine) {
  bad('取到关卡', 'levelById 没返回这张关');
} else {
  ok('取到关卡');
  const s0 = createMatch({ ...DEFAULT_CONFIG, level: mine }, 11);
  check(s0.config.level?.id === mine.id, '局面里带的是这一份关卡快照');
  check(s0.w === 10 && s0.h === 8, '尺寸用的是关卡地图', `${s0.w}×${s0.h}`);
  let cur: GameState = s0;
  for (let i = 0; i < 6 && !cur.winner; i += 1) {
    const r = applyAction(cur, aiNextAction(cur) ?? { type: 'END_TURN' });
    if (r.ok) cur = r.state;
  }
  check(cur.turn > 0, '能往前推几步', `第 ${cur.turn} 次行动`);
  state = cur;
}

/* ── 5. 删除 ────────────────────────────────────────────────────── */
line('5. 删掉之后');
check(deleteUserLevel(saved.level.id), '删除成功');
check(levelById(saved.level.id) === null, 'levelById 找不到它了');
check(allLevels().length === builtinCount, '注册表回到只剩内置');
if (state) {
  // 删掉关卡不该影响正在打的那一局：它跑的是快照
  const r = applyAction(state, { type: 'END_TURN' });
  check(r.ok, '已经开局的那一局照样能继续走', r.ok ? '' : r.reason);
}

/* ── 6. 导入导出的文本 ──────────────────────────────────────────── */
line('6. 文本导入导出');
const text = exportLevelText(sample({ id: 'user:probe-text' }));
const back = parseLevelText(text);
check(back.ok, '导出再导入能过', back.ok ? '' : back.errors.join('；'));
check(/^\s*\{/.test(text) && text.includes('\n  '), '导出的是带缩进、人能读的 JSON');

const brokenJson = parseLevelText('{ "id": "user:x", ');
check(!brokenJson.ok, '坏 JSON 被拦住');
if (!brokenJson.ok) {
  check(brokenJson.errors[0]!.includes('JSON 语法错'), '说的是"JSON 语法错"，不是含糊的失败', brokenJson.errors[0]);
}
const missing = parseLevelText(JSON.stringify({ id: 'user:y', version: 1, name: '' }));
check(!missing.ok, '缺字段被拦住（交给 validateLevel 逐条说）');

/* ── 7. 另存为副本 ──────────────────────────────────────────────── */
line('7. 复制成我的关卡');
const copy = cloneAsUserLevel(sample({ id: 'user:probe-src', name: '原始关' }));
check(copy.id !== 'user:probe-src', 'id 换了', copy.id);
check(copy.map.id !== 'levelmap:probe-src', 'map.id 也换了（复盘和地图缓存按它认图）', copy.map.id);
check(copy.name === '原始关 副本', '名字带"副本"', copy.name);
check(copy.map.name === copy.name, '地图名跟着改（不然缩略图上名字对不上）');
check(copy.map.source === 'user', '地图来源标成 user');
const srcRes = parseLevelText(JSON.stringify(sample({ id: 'user:probe-src', name: '原始关' })));
check(srcRes.ok, '原版没被改坏');

/* ── 8. lint：能指到格子 ────────────────────────────────────────── */
line('8. 第二层校验（lintLevel）');

const issuesOf = (lv: LevelDef): ReturnType<typeof lintLevel> => lintLevel(lv);

// 8.1 兵种 id 不存在 → 警告（不是错：可能来自没启用的扩展，这里算不出来）
const unknown = issuesOf(sample({ deploy: { A: [{ type: 'no-such-unit', x: 2, y: 2 }] } }));
check(
  unknown.some((i) => i.severity === 'warn' && i.text.includes('找不到')),
  '不存在的兵种给警告',
  unknown.map((i) => `${i.severity}:${i.text}`).join(' | ') || '一条都没有',
);

/*
 * 8.2 跨时代的兵**一条提示都不给**。
 *
 * 两个理由叠在一起：实测上它确实能刷出来（默认 unitTypes 就是全部兵种），
 * 设计上"青铜关空投一辆坦克"是正经手法。编辑器替作者判断这件事就越界了——
 * 2026-11-16 用户明确要求"框架内的东西越自由越好"。
 */
const eraQuiet = issuesOf(sample({ deploy: { A: [{ type: 'knight', x: 3, y: 3 }] } }));
check(
  !eraQuiet.some((i) => i.text.includes('时代')),
  '跨时代的兵不提示（那是设计自由，不是配置错误）',
  eraQuiet.map((i) => `${i.severity}:${i.text}`).join(' | '),
);

// 8.3 站在山上 → 错，且带坐标
const onMountain = issuesOf(sample({ deploy: { A: [{ type: 'militia', x: 4, y: 2 }] } }));
const mt = onMountain.find((i) => i.severity === 'error');
check(!!mt, '摆在山上的兵报错');
check(mt?.at?.x === 4 && mt?.at?.y === 2, '错误带上了坐标（编辑器能跳过去）', JSON.stringify(mt?.at));

// 8.4 摆到别人城里 → 错
const inEnemyCity = issuesOf(sample({ deploy: { A: [{ type: 'militia', x: 7, y: 5 }] } }));
check(
  inEnemyCity.some((i) => i.severity === 'error' && i.text.includes('第 B 家的城里')),
  '摆到别人城里报错',
  inEnemyCity.map((i) => i.text).join(' | '),
);

// 8.5 hidden 席位没有 deploy 事件 → 错
const hiddenNoDeploy = issuesOf(
  sample({ seats: { count: 3, ai: ['B', 'C'], cities: { C: [{ x: 1, y: 6 }] }, hidden: ['C'] } }),
);
check(
  hiddenNoDeploy.some((i) => i.severity === 'error' && i.text.includes('永远不出现')),
  '未登场的席位没人叫它上场 → 报错',
  hiddenNoDeploy.map((i) => i.text).join(' | '),
);

// 8.6 assassinate 的目标能被造出来 → **只警告**（难成立，但不是不可能；
//     编辑器不替作者做这个决定，2026-11-16 定的口径）
const buildableGoal = issuesOf(
  sample({ goals: [{ kind: 'assassinate', winner: 'A', loser: 'B', unitType: 'militia' }] }),
);
check(
  buildableGoal.some((i) => i.severity === 'warn' && i.text.includes('一直补人')),
  '斩首目标选了能造出来的兵种 → 警告',
  buildableGoal.map((i) => `${i.severity}:${i.text}`).join(' | '),
);
check(
  !buildableGoal.some((i) => i.severity === 'error'),
  '但不拦（打光对面的城也是一条路，那是设计自由）',
  buildableGoal.filter((i) => i.severity === 'error').map((i) => i.text).join(' | '),
);

// 8.7 改地形没配播报 → 警告
const noSay = issuesOf(
  sample({
    events: [
      {
        id: 'blow',
        when: { kind: 'turn', at: 4 },
        do: [{ kind: 'terrain', zone: { x0: 4, y0: 2, x1: 4, y1: 2 }, to: 'deep' }],
      },
    ],
  }),
);
check(
  noSay.some((i) => i.severity === 'warn' && i.text.includes('播报')),
  '改地形没播报 → 警告',
  noSay.map((i) => i.text).join(' | '),
);

// 8.8 合规的关：一条错都不该有
const clean = issuesOf(sample());
check(
  !clean.some((i) => i.severity === 'error'),
  '一张合规的关没有错误',
  clean.filter((i) => i.severity === 'error').map((i) => i.text).join(' | '),
);

/* ── 9. 重新读盘不会丢 ──────────────────────────────────────────── */
line('9. 重新读盘');
saveUserLevel(sample({ id: 'user:probe-reload', name: '读盘关' }));
const reloaded = loadUserLevels();
check(reloaded.length >= 1, 'loadUserLevels() 之后内存里还有东西', `${reloaded.length} 张`);
check(
  levelById('user:probe-reload')?.name === '读盘关',
  '重新读之后 levelById 照样能查到',
  levelById('user:probe-reload')?.name ?? 'null',
);

/* ── 10. 文件进出（E6） ────────────────────────────────────────── */
line('10. 文件进出');

const one = sample({ id: 'user:probe-file', name: '文件关' });
const single = parseLevelFileText(JSON.stringify(one));
check(single.ok, '单个关卡对象能读', single.ok ? '' : single.errors.join('；'));

const envelope = parseLevelFileText(
  JSON.stringify({ v: 1, kind: 'warchess-levels', levels: [one, sample({ id: 'user:probe-file-2', name: '文件关二' })] }),
);
check(envelope.ok, '多关文件（带外壳）能读');
if (envelope.ok) check(envelope.levels.length === 2, '两条都读进来了', `实际 ${envelope.levels.length}`);

const bareArray = parseLevelFileText(JSON.stringify([one]));
check(bareArray.ok, '裸数组也收（手攒的文件不该被迫背外壳）');

// 一条坏的不拖累好的：批量导入最气人的就是"第 3 个坏了所以 1、2 也没进来"
const mixed = parseLevelFileText(
  JSON.stringify({ v: 1, kind: 'warchess-levels', levels: [one, { id: '', name: '' }] }),
);
check(mixed.ok, '好坏混在一起时，好的那条照样读进来', mixed.ok ? '' : mixed.errors.join('；'));
if (mixed.ok) {
  check(mixed.levels.length === 1, '只收下能用的那条', `实际 ${mixed.levels.length}`);
  check(mixed.errors.length === 1, '坏的那条单独报错', `实际 ${mixed.errors.length}`);
}

check(!parseLevelFileText('{"id":').ok, '坏 JSON 被拦住');
check(!parseLevelFileText('').ok, '空文件被拦住');

// node 里没有 URL.createObjectURL；下载函数必须安静地什么都不做，而不是抛错
let threw = false;
try {
  downloadLevelFile(one);
  downloadLevelsFile([one], '批量');
} catch {
  threw = true;
}
check(!threw, '没有下载能力的环境里，导出不抛错（安静跳过）');

check(levelUploadBlocker(one) === null, '合规关卡可以上传');
check(
  levelUploadBlocker(sample({ name: '' })) !== null,
  '不合规关卡在上传前就被拦下（不占用一次审核名额）',
);

/* ── 11. 无城席位（F1 第二步：数据与校验） ─────────────────────── */
line('11. 无城席位');

/** 一张"甲方没城"的关卡：地图里 citiesA 是空的，靠 seats.cityless 放行 */
const citylessLevel = sample({
  id: 'user:probe-cityless',
  name: '无城探针',
  map: {
    id: 'levelmap:probe-cityless',
    name: '无城探针',
    w: 10,
    h: 8,
    rows: Array.from({ length: 8 }, () => '..........'),
    citiesA: [],
    citiesB: [{ x: 7, y: 5 }],
    source: 'user',
  },
  seats: { count: 2, ai: ['B'], cityless: ['A'] },
  deploy: { A: [{ type: 'militia', x: 3, y: 3 }, { type: 'archer', x: 4, y: 3 }] },
});

const checked = validateLevel(citylessLevel);
check(checked.ok, '标了无城的关卡能过校验', checked.ok ? '' : checked.errors.join('；'));

// 关键：**没有 cityless 这张免票，地图校验仍然要求两方都有城**。
// 放宽只发生在关卡那条路上，地图上传那条路必须保持原样。
const strictMap = validateFixedMap(citylessLevel.map);
check(!strictMap.ok, '地图单独校验（上传那条路）仍然要求双方有城');
check(
  validateFixedMap(citylessLevel.map, { allowEmpty: ['A'] }).ok,
  '带上 allowEmpty 才放行',
);

// 自相矛盾：既说没城，又给了城位
const contradictory = validateLevel({
  ...citylessLevel,
  map: { ...citylessLevel.map, citiesA: [{ x: 1, y: 1 }] },
});
check(!contradictory.ok, '「没城 + 有城位」被拦下', contradictory.ok ? '竟然过了' : contradictory.errors[0]);

// 建局：A 一座城都没有，B 照旧
if (checked.ok) {
  const s = createMatch({ ...DEFAULT_CONFIG, level: checked.level }, 31);
  check(citiesOf(s, 'A').length === 0, '无城席位建局后确实没有城', `实际 ${citiesOf(s, 'A').length}`);
  check(citiesOf(s, 'B').length > 0, '有城的那一方照旧有城', `实际 ${citiesOf(s, 'B').length}`);
  check(s.units.filter((u) => u.owner === 'A').length === 2, '无城方靠 deploy 拿到兵', `实际 ${s.units.filter((u) => u.owner === 'A').length}`);
}

// lint：无城席位必须写 deploy
const noDeploy = lintLevel({ ...citylessLevel, deploy: { B: [{ type: 'militia', x: 8, y: 4 }] } });
check(
  noDeploy.some((i) => i.severity === 'error' && i.text.includes('第一帧就出局')),
  '无城席位没写兵力 → 报错（不让它静默变成"开局即输"）',
  noDeploy.map((i) => i.text).join(' | '),
);
const okLint = lintLevel(citylessLevel);
check(
  !okLint.some((i) => i.severity === 'error'),
  '写了兵力的无城关卡没有错误',
  okLint.filter((i) => i.severity === 'error').map((i) => i.text).join(' | '),
);

/* ── 12. 无城席位的出局与收场（F1 第三步） ─────────────────────── */
line('12. 无城席位的出局与收场');

if (checked.ok) {
  const s0 = createMatch({ ...DEFAULT_CONFIG, level: checked.level }, 37);
  check(isCitylessSeat(s0, 'A'), '局面里认得出 A 是无城席位');
  check(!isCitylessSeat(s0, 'B'), 'B 不是无城席位');
  check(!isEliminated(s0, 'A'), '有兵就不算出局（哪怕一座城都没有）');
  check(!isEliminated(s0, 'B'), '有城的 B 正常');

  // 把 A 的兵拿掉：应当判出局
  const s1 = { ...s0, units: s0.units.filter((u) => u.owner !== 'A') };
  check(isEliminated(s1, 'A'), '兵打光 → 出局');
  check(!isEliminated(s0, 'A') === true, '（对照）同一份关卡里有兵时不出局');

  // 收场：推一次回合，应当由 B 拿下
  const r = applyAction(s1, { type: 'END_TURN' });
  check(r.ok && r.state.winner === 'B', '兵打光之后这一局能收场（不会永远打不完）', r.ok ? `winner=${r.state.winner}` : r.reason);

  // 正常有城的局不受影响：三张内置关里随便取一张
  const builtin = LEVELS.find((l) => l.dev !== true)!;
  const sb = createMatch({ ...DEFAULT_CONFIG, level: builtin }, 5);
  check(!isCitylessSeat(sb, 'A') && !isCitylessSeat(sb, 'B'), '内置关两张都不是无城席位');
  check(isEliminated(sb, 'A') === false, '内置关开局不会有人被误判出局');
}

/* ── 13. 无城局的 AI（F1 第四步） ───────────────────────────────── */
line('13. 无城局的 AI');

/*
 * 这条是拿实测换来的：一开始双方无城的关，AI 六百步只动了一次。
 * 原因有三个，都不是"权重没调好"：
 *   ① 没有敌城 → 距离场是空的 → 推进算不出值；
 *   ② 迷雾里看不见敌人 → foeVal=0 → "我比对面强"恒真 → 一开局就进"全军压城"，
 *      而压的对象不存在；
 *   ③ 什么都看不见时没有搜索行为（给两个点它就各守一个角，永远碰不到面）。
 * 所以断言不能只看"有没有赢"，要看**有没有真的在动**。
 */
const duel = sample({
  id: 'user:probe-duel',
  name: '决斗探针',
  map: {
    id: 'levelmap:probe-duel',
    name: '决斗探针',
    w: 10,
    h: 10,
    rows: Array.from({ length: 10 }, () => '..........'),
    citiesA: [],
    citiesB: [],
    source: 'user',
  },
  seats: { count: 2, ai: ['A', 'B'], cityless: ['A', 'B'] },
  deploy: {
    A: [
      { type: 'militia', x: 2, y: 3 },
      { type: 'militia', x: 3, y: 3 },
      { type: 'archer', x: 4, y: 3 },
      { type: 'militia', x: 2, y: 4 },
    ],
    B: [
      { type: 'militia', x: 7, y: 6 },
      { type: 'militia', x: 6, y: 6 },
      { type: 'archer', x: 5, y: 6 },
      { type: 'militia', x: 7, y: 5 },
    ],
  },
});

const duelChecked = validateLevel(duel);
check(duelChecked.ok, '双方无城的关能过校验', duelChecked.ok ? '' : duelChecked.errors.join('；'));
if (duelChecked.ok) {
  let st = createMatch({ ...DEFAULT_CONFIG, level: duelChecked.level }, 7);
  const snap = () => st.units.map((u) => `${u.id}:${u.x},${u.y}`).join('|');
  let last = snap();
  let moves = 0;
  let worstIdle = 0;
  let idle = 0;
  for (let i = 0; i < 900 && !st.winner; i += 1) {
    const act = aiNextAction(st) ?? { type: 'END_TURN' as const };
    const r = applyAction(st, act);
    if (r.ok) {
      st = r.state;
    } else {
      // AI 偶尔会给出非法动作（比如目标格已被占）：换成结束回合，别让探针中断
      const fallback = applyAction(st, { type: 'END_TURN' });
      if (!fallback.ok) break;
      st = fallback.state;
    }
    const now = snap();
    if (now !== last) {
      moves += 1;
      idle = 0;
    } else {
      idle += 1;
      worstIdle = Math.max(worstIdle, idle);
    }
    last = now;
  }
  check(moves >= 10, '双方无城时 AI 会动（不是全军立正）', `有位移的行动只有 ${moves} 次`);
  check(worstIdle <= 60, '不会长时间完全不动', `最长连续无位移 ${worstIdle} 步`);
  check(
    !!st.winner || st.turn >= 300,
    '这一局能推进到有结果（或者在时间上限前一直在打）',
    `winner=${st.winner ?? '-'} turn=${st.turn}`,
  );
}

/* ── 14. 点亮（reveal）─────────────────────────────────────────── */
line('14. 点亮区域');

/*
 * 护送关的核心场景：开着雾，玩家得知道"终点在哪"。
 * 点亮 = 把这片格子永久并进可见集，不随视野收回去。
 */
{
  const rows = Array.from({ length: 8 }, () => '..........');
  const v = validateLevel({
    id: 'user:probe-reveal',
    version: 1,
    name: '点亮探针',
    map: {
      id: 'levelmap:probe-reveal',
      name: '点亮探针',
      w: 10,
      h: 8,
      rows,
      citiesA: [{ x: 1, y: 1 }],
      citiesB: [{ x: 7, y: 5 }],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'] },
    deploy: {
      A: [{ type: 'militia', x: 2, y: 2 }],
      B: [{ type: 'militia', x: 7, y: 4 }],
    },
    events: [
      {
        id: 'reveal-far',
        // 用 turn 2：turn 1 的事件在建局时就会跑（`createMatch` 末尾调 runLevelEvents），
        // 写 1 的话'开局看不见'这条根本测不到
        when: { kind: 'turn', at: 2 },
        do: [
          { kind: 'reveal', zone: { x0: 8, y0: 0, x1: 9, y1: 1 } },
          // repeat 里重复点亮同一片：必须幂等，不该报错也不该重复堆
          { kind: 'reveal', zone: { x0: 8, y0: 0, x1: 9, y1: 1 } },
        ],
      },
    ],
  });
  check(v.ok, '带点亮动作的关卡能过校验', v.ok ? '' : v.errors.join('；'));
  if (v.ok) {
    // 默认开雾（DEFAULT_CONFIG.fog 是 true），才谈得上"点亮"
    const s = createMatch({ ...DEFAULT_CONFIG, level: v.level }, 3);
    check(s.fog === true, '这一关默认开着雾（不然"点亮"没有意义）');
    const far = 0 * 10 + 8; // (8,0)：离 A 的兵很远，没点亮时看不见
    const before = playerView(s, 'A');
    check(!before.visible.includes(far), '开局看不到远处那一片（雾是开着的）');

    // 推一步让 turn 2 的事件触发
    const r = applyAction(s, { type: 'END_TURN' });
    check(r.ok, '能推进一步触发事件', r.ok ? '' : (r as { reason: string }).reason);
    if (r.ok) {
      const after = playerView(r.state, 'A');
      check(after.visible.includes(far), '点亮之后，那片区域在玩家视野里');
      check((r.state.revealed ?? []).length === 4, '记下了 4 格（重复点亮是幂等的）', `实际 ${(r.state.revealed ?? []).length}`);
      // 别把整张图都点亮：同一条事件没点的地方仍然不可见
      const other = 0 * 10 + 0; // (0,0)
      check(!after.visible.includes(other), '没点亮的格子不会被顺带点亮');

      // 到期：默认亮 1 次，够当下 + 下一手；再往后就该重新没入迷雾
      let cur = r.state;
      for (let k = 0; k < 4 && !cur.winner; k += 1) {
        const rr = applyAction(cur, { type: 'END_TURN' });
        if (!rr.ok) break;
        cur = rr.state;
      }
      check(
        !playerView(cur, 'A').visible.includes(far),
        '点亮到期之后重新被迷雾遮住（不是永久可见）',
        `turn=${cur.turn}，仍在 ${(cur.revealed ?? []).filter((x) => x.i === far).length} 条记录里`,
      );
    }
  }
}

/* ── 汇总 ──────────────────────────────────────────────────────── */
console.log('');
if (failed === 0) {
  console.log('全部通过（用户关卡注册表 + 第二层校验）');
} else {
  console.log(`有 ${failed} 项没过`);
  process.exitCode = 1;
}
