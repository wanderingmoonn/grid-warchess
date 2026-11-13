/**
 * 海军扩展：「海战」（naval-fleet）+「现代海军」（naval-modern）。
 *
 * ── 放哪里、怎么组织 ──────────────────────────────────────────────────
 *
 *   src/core/naval-packs.ts     ← 这个文件：能力 + 兵种 + 两条舰队规则 + 两个扩展
 *   src/core/naval-carrier.ts   ← 航母甲板接口（空军扩展接进来的那道口子）
 *   src/core/expansions.ts      ← 只加两行：import + 展开进 EXPANSIONS
 *
 * 除了那两行注册，**没有一行代码落在核心引擎里**（`rules.ts` / `types.ts` /
 * `setup.ts` 一行不动）。所有效果都由现有的扩展接口表达：
 *   · 数值、造价、机位、运输 → `UnitTypeDef` 的既有字段；
 *   · 「岸轰 / 潜航 / 区域防空 / 海上补给 / 旗舰」→ `Expansion.abilities`
 *     （每条能力自带钩子，删掉这个包它们就一起消失）；
 *   · 「封锁 / 港口抢修 / 甲板整备」→ `ExpansionHooks` 的既有钩子。
 *
 * ── 为什么不给海军加新地形 ────────────────────────────────────────────
 *
 * "浅水 / 深水"听起来是海军该有的东西，但它会渗进三处核心：`navigable()`、
 * 寻路、以及城市生成。扩展虽然能登记新地形（`Expansion.terrains`），
 * 却没法告诉 `navigable()` "这一格也算水面"——那就只能改引擎。
 * 所以这一版**不加地形**，改用两条不需要新地形的规则表达"海权"：
 * 封锁（船贴着城，城不回血）和港口抢修（船贴着自家城，每回合修）。
 *
 * ── 数值口径 ─────────────────────────────────────────────────────────
 *
 * 沿用奇幻包那张粗糙的价值模型，只看**同代**对比（贵兵天然更不值，
 * 这是被编制上限压出来的，不是漏洞）：
 *
 *   V = 攻 + 0.45×血 + 5×甲 + 3×射程 + 2.5×移 + 1.5×视野（溅射每级 +4）
 *
 * 现有水军的 V/造价：舢板 1.03、三层桨 0.98、齿轮帆船 0.84、炮艇 0.70、
 * 风帆战列舰 0.67、雷击舰 0.50、铁甲舰 0.52（2026-11-02 挪回 E4 后重算）、
 * 驱逐舰 0.52、重巡洋舰 0.45、导弹驱逐舰 0.36。
 * 新船就按这条线上落位：E2 0.75~0.80、E3 0.57~0.87（火船是玻璃炮，给高一点）、
 * E4 0.50~0.54、E5 0.38~0.52、E6 0.24~0.37。
 */

import type { AbilityDef } from './abilities.ts';
import { DAMAGE_STAGE, TURN_START } from './ability-hooks.ts';
import type { Expansion } from './expansions.ts';
import { addMark, markCountOf, markKindOf, marksAt, marksOf, removeMark } from './marks.ts';
import type { MarkKindDef } from './marks.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import { navigable } from './config.ts';
import { cityGap } from './geo.ts';
import type { ResourceCost } from './resources.ts';
import { airwingOps, deckLine, deckSpecOf } from './naval-carrier.ts';

/* ===========================================================================
 * 一、能力（只在勾了这个包的局里存在）
 * ======================================================================== */

/**
 * 舰炮支援登陆：船打城的伤害 ×1.25。
 *
 * 为什么单开一条能力而不是给所有船：岸轰是**重炮舰**的活。
 * 舢板、火船、运输船打城墙本来就该是挠痒——把这条发给全体水面单位，
 * "海军"就变成了"从水上来的炮兵"，陆军的攻城单位当场失去意义。
 *
 * 它能和「破城」（×1.5）叠起来：战列舰打城是 1.5 × 1.25 ≈ 1.88 倍。
 * 这是有意的——一个一千多金的船，本来就该是攻城效率最高的东西。
 */
const SHORE_BOMBARD: AbilityDef = {
  id: 'nv-shore-bombard',
  name: '岸轰',
  summary: '攻城伤害 ×1.25。舰炮支援登陆，和「破城」可以叠。',
  group: 'attack',
  hooks: {
    siegeDamage: [
      {
        stage: 1,
        apply: (c) => {
          c.damage = Math.round(c.damage * 1.25);
        },
      },
    ],
  },
};

/**
 * 水雷：留在一格水面上的东西（engine 层见 core/marks.ts）。
 *
 * 它**不是单位**：不占格、不挡路、不行动、不进迷雾的单位名单。
 * 谁踩谁挨，踩完就没——这才是"雷"，而不是"一条站在那儿咬人的船"。
 *
 * 几条刻意的设定：
 *   · 只炸敌人（`trigger: 'enemy'`）：布雷舰自己的航线必须能穿过自己的雷区，
 *     不然它连"布完雷往外走"都做不到；
 *   · 只认水面（`on`）：陆军在浅滩涉水不会被水雷炸；
 *   · 默认隐藏、`detect: 1`：贴脸才发现。于是"派一条快船趟一遍"成了唯一的破法——
 *     这也是历史上扫雷/探雷的样子（先探后清，只是这里探到就等于踩到边缘）；
 *   · 伤害 14 点**不走进攻公式**：不加护甲、不算地形、不触发反击。
 *     地雷不跟你讲武德，扣血就是扣血。
 */
const NAVAL_MINE: MarkKindDef = {
  id: 'nv-mine',
  name: '水雷',
  summary: '敌舰踩上来就炸 14 点（按护甲结算），炸完就没。自己的船踩不到自己的雷。',
  // `mine` 这个标签是给扫雷舰用的：以后加磁性雷、音响雷，只要也打上它，
  // 扫雷舰就照样扫得掉——判定不能写死成"只认 nv-mine"。
  tags: ['mine', 'naval'],
  hidden: true,
  on: ['water', 'deep', 'shallow', 'bridge'],
  trigger: 'enemy',
  detect: 1,
  onEnter: (c) => {
    if (!c.unit) return;
    const def = c.api.utype(c.unit.type);
    // 扫雷舰切断了雷索：它踩响的雷只剩个响，4 点意思一下。
    // 这条写在"雷"这一边而不是"船"那一边，是因为它是雷的命中规则，
    // 换一条船来踩就该吃满 14 点。
    const swept = (def.abilities ?? []).includes('nv-sweep');
    const dmg = swept ? 4 : 14;
    // 水雷是物理伤害：走 hurtPhysical 先减甲（以前走 hurt，等于所有雷都无视护甲）
    c.api.hurtPhysical(c.unit, dmg, (dealt) =>
      swept ? `${def.name} 切断了雷索，只受 ${dealt} 点` : `${def.name} 撞上水雷，损失 ${dealt} 点生命`,
    );
    c.api.log(c.mark.owner, `水雷命中 ${def.name}`);
  },
};

/**
 * 扫雷：把相邻的敌方水雷清掉。
 *
 * 为什么不给"主动点一下扫一格"的按钮：这个游戏的操作全是"选中 → 点目标"，
 * 而扫雷本来就是**跟着船往前挪、一路扫过去**的动作，做成回合开始自动结算，
 * 玩家做的事就变成"把船开到雷区边上"——那正是扫雷舰该做的事。
 *
 * 只扫带 `mine` 标签的、只扫相邻一格、不扫自己的（自己的雷留着挡路）。
 */
const SWEEP: AbilityDef = {
  id: 'nv-sweep',
  name: '扫雷',
  summary: '自己回合开始时，清掉相邻的敌方水雷；自己踩到水雷只受 4 点。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.support,
        apply: (c) => {
          const s = c.state;
          let cleared = 0;
          for (const m of marksOf(s)) {
            if (m.owner === c.owner) continue;
            const kind = markKindOf(m.kind);
            if (!kind?.tags?.includes('mine')) continue;
            if (c.api.distance(m, c.self) > 1) continue;
            removeMark(s, m.id);
            cleared += 1;
          }
          if (cleared > 0) {
            c.api.pushLog(
              s,
              c.owner,
              `${c.api.utype(s, c.self.type).name} 扫掉 ${cleared} 枚水雷`,
            );
          }
        },
      },
    ],
  },
};

/**
 * 反潜：声纳能探到两格外的潜艇，对潜航单位的攻击翻倍。
 *
 * 两条一起给，是因为单给一条都不成立：
 *   · 只给发现距离——探到了也打不疼（22 攻打潜航 8 甲就是挠痒）；
 *   · 只给伤害翻倍——根本看不见它，翻倍也白搭（潜艇贴脸才现形）。
 *
 * 判定用"目标身上有没有 `nv-submerge`"，而不是"是不是某一条船"：
 * 以后加核潜艇、AIP 潜艇，只要带潜航就都算潜艇。
 */
const ASW: AbilityDef = {
  id: 'nv-asw',
  name: '反潜',
  summary: '潜航单位在两格内就会现形；对潜航单位攻击伤害 ×2。',
  group: 'attack',
  hooks: {
    detect: (c) =>
      (c.api.utype(c.state, c.target.type).abilities ?? []).includes('nv-submerge') ? 1 : 0,
    damage: [
      {
        stage: DAMAGE_STAGE.attackMul,
        apply: (c) => {
          // "我打潜艇更疼"，不是"我被潜艇打更疼"
          if (c.side !== 'attacker' || !c.foe) return;
          if (!(c.api.utype(c.state, c.foe.type).abilities ?? []).includes('nv-submerge')) return;
          c.damage = Math.round(c.damage * 2);
        },
      },
    ],
  },
};

/**
 * 布雷：每回合在自己相邻的一格水面上放一枚水雷。
 *
 * 为什么是"自动布"而不是"点一下放一枚"：这个游戏的操作全压在
 * "选中 → 点目标"上，多一个主动技能就要多一套按钮、冷却和 AI 判断；
 * 而布雷本身就是一种**等敌人送上门**的动作，自动反而更像它。
 *
 * 上限 6 枚（按布设者算）：不设上限的话，一条船蹲在港口外面闷头布雷，
 * 二十回合后整片海都是雷，游戏会退化成排雷模拟器。
 */
const LAY_MINES: AbilityDef = {
  id: 'nv-lay-mines',
  name: '布雷',
  summary: '自己回合开始时，在两格以内的水面上布一枚水雷（全场最多 6 枚，只炸敌舰）。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.support,
        apply: (c) => {
          const CAP = 6;
          if (markCountOf(c.state, 'nv-mine', c.owner) >= CAP) return;
          const s = c.state;
          const spots: Array<{ x: number; y: number }> = [];
          // 半径 2（不含自己这一格）：布雷舰布的是"一片雷区"，不是"脚边一枚"。
          // 只布四邻的话，一条船蹲住最多铺 4 枚，然后就没地方了——
          // 那不是雷区，是个包围圈。
          for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              if (Math.abs(dx) + Math.abs(dy) > 2) continue;
              const x = c.self.x + dx;
              const y = c.self.y + dy;
              if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
              const tile = s.tiles[y * s.w + x];
              if (!tile || !['water', 'deep', 'shallow', 'bridge'].includes(tile.terrain)) continue;
              // 那一格上已经有东西（自己的雷、别人的雷、或者一条船）就跳过：
              // 雷叠雷没有意义，把雷布到别人的船底下等于白送一次位移
              if (marksAt(s, x, y).length > 0) continue;
              if (s.units.some((u) => u.x === x && u.y === y && u.hp > 0)) continue;
              spots.push({ x, y });
            }
          }
          if (spots.length === 0) return;
          // 挑哪一格：按回合号轮转，而不是永远挑"第一个"。
          // 永远挑第一个的话，一条船蹲着不动就会把雷全堆在北边一格上。
          const pick = spots[(s.turn + c.self.x + c.self.y) % spots.length]!;
          addMark(s, {
            kind: 'nv-mine',
            owner: c.owner,
            x: pick.x,
            y: pick.y,
            charges: 1,
            hidden: true,
          });
          c.api.pushLog(
            s,
            c.owner,
            `${c.api.utype(s, c.self.type).name} 在 ${String.fromCharCode(65 + pick.x)}${pick.y + 1} 布下一枚水雷`,
          );
        },
      },
    ],
  },
};

/**
 * 潜航：只有贴到相邻格的敌人才发现得了它，而且打完不挨反击。
 *
 * 这两条都是既有机制，组合起来正好是潜艇：
 *   · `hidden` 走的是"潜行"那条判定（迷雾局里生效，而且**所有**观察者
 *     都要先贴到一格内才发现——这正是"声纳只有这么远"的意思）；
 *   · `noCounter` 是「先手」用的那个旗标：我打你，你没法立刻还手。
 *     水面舰追着潜艇打不到，潜艇却能从水下先动手，这个不对称就是它的全部价值。
 *
 * 注意它**不是无敌**：贴脸就现形，一旦被发现，护甲 9、血量 100 的船
 * 挨两轮齐射就没了。所以潜艇的正确用法是"打完就换位置"，不是站桩。
 */
const SUBMERGE: AbilityDef = {
  id: 'nv-submerge',
  name: '潜航',
  summary: '迷雾局里只有相邻的敌人才发现得了它；攻击不会引来反击。',
  group: 'move',
  hooks: { hidden: () => true, noCounter: true },
};

/**
 * 区域防空：对**空中层**目标多打 12 点。
 *
 * 空军扩展还没来，这条能力现在是"空转"的——但它是这道接口的一部分：
 * 等空军上线，带这条能力的船就是舰队的伞。写在这里而不是等空军包再补，
 * 是因为"哪条船能防空"是海军的设计决定，不该由空军包定义。
 *
 * 判据用 `layer === 'air'`（掠空和飞行最终都在这一层），不是"有没有飞行能力"：
 * 热气球只在天上、不一定会飞，但它照样是防空炮该打的东西。
 */
const AA_COVER: AbilityDef = {
  id: 'nv-aa-cover',
  name: '区域防空',
  summary: '对空中层目标造成 +12 伤害。空军扩展上线后是舰队的伞。',
  group: 'defense',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (!c.foe) return;
          const foe = c.api.utype(c.state, c.foe.type);
          if (foe.layer === 'air') c.damage += 12;
        },
      },
    ],
  },
};

/**
 * 海上补给：回合开始时，相邻的友方水面单位回 3 点。
 *
 * 用的是 `TURN_START.aura` 这个时机（治疗光环就在这一段），
 * 也就是"轮到我方回合，先处理各种补给，再干活"。
 * 只补水面单位：补给舰的油管子接不到岸上的坦克。
 */
const FLEET_REPAIR: AbilityDef = {
  id: 'nv-fleet-repair',
  name: '海上补给',
  summary: '每回合开始时，相邻的友方水面单位回复 3 点生命。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          let healed = 0;
          for (const u of c.state.units) {
            if (u.owner !== c.owner || u.id === c.self.id) continue;
            if (c.api.utype(c.state, u.type).domain !== 'water') continue;
            if (c.api.distance(u, c.self) > 1) continue;
            const max = c.api.utype(c.state, u.type).maxHp;
            if (u.hp >= max) continue;
            u.hp = Math.min(max, u.hp + 3);
            healed += 1;
          }
          if (healed > 0) {
            c.api.pushLog(c.state, c.owner, `海上补给：${c.api.utype(c.state, c.self.type).name} 给 ${healed} 艘友舰各补 3 点`);
          }
        },
      },
    ],
  },
};

/**
 * 旗舰：相邻友军 +2 攻 +2 甲。
 *
 * 航母在**没有空军扩展**的局里靠这条站住脚：它自己不打人（攻 26、射程 3），
 * 但它是全图视野最好（9）的移动指挥部。这条也让"航母必须待在舰队中间"
 * 成为一条真实的取舍——离得太远，光环就白给了。
 */
const FLEET_COMMAND: AbilityDef = {
  id: 'nv-fleet-command',
  name: '旗舰',
  summary: '相邻的友军 +2 攻击、+2 护甲。航母在空军接入前靠它站住脚。',
  group: 'support',
  hooks: { aura: { allyAtk: 2, allyArmor: 2 } },
};

/**
 * 潜母：给潜艇补氧、补雷、修耐压壳。
 *
 * 为什么单独一条、不复用「海上补给」：那条管水面舰，这条只管潜艇。
 * 合成一条的话，一艘潜母就能同时奶住整支舰队，"编队要带几种支援船"
 * 这个取舍就没了——而取舍正是这一版加这么多舰种的理由。
 */
const SUB_TENDER: AbilityDef = {
  id: 'nv-sub-tender',
  name: '潜母',
  summary: '每回合开始时，相邻的友方潜艇回复 6 点生命（只对潜艇有效）。',
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          let fixed = 0;
          for (const u of c.state.units) {
            if (u.owner !== c.owner || u.id === c.self.id) continue;
            const def = c.api.utype(c.state, u.type);
            if (!(def.abilities ?? []).includes('nv-submerge')) continue; // 只修潜艇
            if (c.api.distance(u, c.self) > 1) continue;
            if (u.hp >= def.maxHp) continue;
            u.hp = Math.min(def.maxHp, u.hp + 6);
            fixed += 1;
          }
          if (fixed > 0) {
            c.api.pushLog(c.state, c.owner, `潜母：给 ${fixed} 艘潜艇各补 6 点`);
          }
        },
      },
    ],
  },
};

/**
 * 远洋补给：相邻友舰 +1 移动。
 *
 * 和「海上补给」（回血）刻意分工：一个管血、一个管腿。
 * 两条都给同一条船的话，支援舰就只剩"哪个便宜买哪个"一个选择。
 */
const FLEET_OILER: AbilityDef = {
  id: 'nv-fleet-oiler',
  name: '远洋补给',
  summary: '相邻的友方水面单位 +1 移动力。',
  group: 'support',
  hooks: { aura: { allyMove: 1 } },
};

/**
 * 能力各归各家（引擎里有一条测试盯着这件事）。
 *
 * 「岸轰」两个包都会用（浅水重炮舰在「海战」、战列舰在「现代海军」），
 * 所以它挂在基础包上；其余四条只有第六时代的船用，就归「现代海军」。
 * 能力表是**全局合并**的（不看这一局勾了哪些包），所以现代包引用基础包的
 * 能力 id 完全没问题——但反过来"两个包各声明一份"会直接踩测试。
 */
const FLEET_ABILITIES: AbilityDef[] = [
  SHORE_BOMBARD,
  SUBMERGE,
  FLEET_REPAIR,
  SUB_TENDER,
  LAY_MINES,
  SWEEP,
  ASW,
];
const MODERN_ABILITIES: AbilityDef[] = [AA_COVER, FLEET_COMMAND, FLEET_OILER];

/* ===========================================================================
 * 二、兵种
 *
 * 全部参照真实历史舰型，按"这个时代的海战在解决什么问题"来定位：
 *   E1 只有舢板/三层桨（撞击与接舷）—— 本体与「青铜」已经有，不重复
 *   E2 帆桨并用 + 第一代运输船（德罗蒙、卡拉克）
 *   E3 舷侧炮列（盖伦）+ 纵火（火船）
 *   E2 帆桨并用（德罗蒙、卡拉克）+ 桨帆船（勒班陀那种）与宝船（郑和那种）——
 *      前者买"快"，后者买"一次运四个还沉不了"
 *   E3 舷侧炮列（盖伦）+ 纵火（火船）+ 风帆巡航舰（追得上跑得掉）+ 龟船（顶到跟前）
 *   E4 蒸汽与装甲（护卫舰、浅水重炮舰、潜艇、运输舰）
 *      + 水军的**入口价**：鱼雷艇 150、布雷舰 240（在水雷上留东西）、
 *      扫雷舰 220（扫雷 + 反潜，这一代唯一能破"看不见的东西"的船）——
 *      本体那条**铁甲舰**也在这一代（1859–1890 的舰种，2026-11-02 从 E5 挪下来）
 *   E5 1900–1945 的钢铁舰队：装巡（老式远洋主力）→ 重巡（条约型）→
 *      轻巡（舰队的眼睛）→ 战巡（薄皮大炮）→ 战列舰（顶线）；
 *      水下一支远洋潜艇（补上潜母终于有子可带），天上一艘舰队航母（三机位、2×2），
 *      外加登陆舰、轻母、潜母、维修舰、航空战列舰
 *   E6 航母、超巡、区域防空巡洋舰、核潜艇与常规潜艇、两栖舰、导弹艇、
 *      濒海战斗舰、无人艇、补给舰
 * ======================================================================== */

const FLEET_UNITS: UnitTypeDef[] = [
  {
    id: 'nv_dromon',
    name: '德罗蒙战舰',
    short: '德',
    era: 2,
    category: 'combat',
    cost: 132,
    move: 4,
    atk: 19,
    armor: 5,
    maxHp: 60,
    range: 3,
    vision: 4,
    domain: 'water',
    splash: 1,
    // 拜占庭的"希腊火"：喷出去是一道火墙，不是一根箭。
    // 溅射 1 在 E2 只有它和臼炮有，所以它贵、也脆（甲 5）。
    // V = 19 + 27 + 25 + 9 + 10 + 6 + 4(溅射) = 100 → 0.76 / 金
  },
  {
    id: 'nv_carrack',
    name: '卡拉克帆船',
    short: '卡',
    era: 3,
    category: 'combat',
    cost: 210,
    move: 4,
    atk: 22,
    armor: 6,
    maxHp: 84,
    range: 2,
    vision: 4,
    domain: 'water',
    carry: { hold: { max: 4 } },
    // 和齿轮帆船（98 金、容量 3）分工：卡拉克贵一半，换来 4 个舱位和 6 点甲。
    // 跨海投送是"一次运四个"还是"分两趟运两个"，在 20×20 的图上差一整回合。
  },
  {
    id: 'nv_galley',
    name: '桨帆船',
    short: '桨',
    era: 2,
    category: 'combat',
    cost: 110,
    move: 5,
    atk: 18,
    armor: 4,
    maxHp: 52,
    range: 2,
    vision: 3,
    domain: 'water',
    // 勒班陀（1571）那种地中海主力：一排桨手，快、便宜、撞角 + 接舷。
    // 铁器海战的主角是它，不是横帆船——横帆船在顺风时漂亮，逆风时只能等。
    // 所以它的移动力是全 E2 最高的 5，代价是视野 3、射程 2（桨帆船的炮很小）。
    // V = 18+23.4+20+6+12.5+4.5 = 84.4 → 0.77
  },
  {
    id: 'nv_treasure_ship',
    name: '宝船',
    short: '宝',
    era: 3,
    category: 'combat',
    cost: 235,
    move: 3,
    atk: 18,
    armor: 7,
    maxHp: 135,
    range: 2,
    vision: 4,
    domain: 'water',
    carry: { hold: { max: 4 } },
    // 郑和船队那种九桅大舶（1405–1433）：慢、笨、几乎不能打，但一次能把
    // 四个人送到对岸，而且血厚到不怕几轮乱箭。和卡拉克（150 金、4 舱位）
    // 分工：卡拉克"能打能运"，宝船"只运、但运得稳"——血多 48、甲多 1，
    // 移动少 1，正好是"从河港出发的巨舰"该有的样子。
    // V = 14+54+35+6+7.5+6 = 122.5 → 0.68（舱位不进公式，和卡拉克同档）
  },
  {
    id: 'nv_fireship',
    name: '火船',
    short: '火',
    era: 3,
    category: 'combat',
    cost: 105,
    move: 6,
    atk: 40,
    armor: 2,
    maxHp: 34,
    range: 1,
    vision: 3,
    domain: 'water',
    splash: 1,
    // 纵火船：装满火器和沥青冲进敌阵。攻高、血薄、移动快，溅射 1 让它
    // 贴上去就有交换价值。V = 40+15.3+10+3+15+4.5+4 = 92 → 0.87。
    // 这个比值偏高是故意的：它只活一回合，价值模型算不出"活不过一轮"。
    //
    // 阵亡自爆（`kamikaze`，本体就有那条能力）：它本来就是"一次性"的船，
    // 打沉它的那一方不该因为"它先沉了"而白赚——沉船时对四邻各打自身攻击的一半（20 点），
    // 于是"用一条便宜的船换掉对面贴脸的舰队"终于成立。注意它**不区分敌我**：
    // 这是老规矩（本体里带这条能力的单位都这样），别指望它能和友军叠着走。
    abilities: ['kamikaze'],
  },
  {
    id: 'nv_galleon',
    name: '盖伦帆船',
    short: '盖',
    era: 3,
    category: 'combat',
    cost: 240,
    move: 4,
    atk: 33,
    armor: 8,
    maxHp: 82,
    range: 3,
    vision: 5,
    domain: 'water',
    carry: { hold: { max: 3 } },
    // 远洋主力：打得过炮艇（130 金 25 攻），又能运三个兵。
    // 它是"海军独立成军"的起点——从这一代开始，海权不再只是过河的工具。
    // V = 33+36.9+40+9+10+7.5 = 136 → 0.57
  },
  {
    id: 'nv_turtle_ship',
    name: '龟船',
    short: '龟',
    era: 3,
    category: 'combat',
    cost: 245,
    move: 4,
    atk: 34,
    armor: 10,
    maxHp: 88,
    range: 1,
    vision: 3,
    domain: 'water',
    // 朝鲜的龟船（1592 鸣梁）：背上有钉板、船头有龙头喷烟，靠撞和贴。
    // 射程只有 1 是刻意的——它必须冲进去，那个"顶着炮火冲到跟前"的
    // 过程就是它的代价。换来的是 E3 最高的护甲 10（盖伦 8、风帆战列舰 8）：
    // 钉板让接舷的人无从下手，这一条只能表达成甲。
    // V = 34+39.6+50+3+10+4.5 = 141.1 → 0.58
  },
  {
    id: 'nv_sailing_frigate',
    name: '风帆巡航舰',
    short: '帆',
    era: 3,
    category: 'combat',
    cost: 175,
    move: 6,
    atk: 30,
    armor: 5,
    maxHp: 62,
    range: 3,
    vision: 5,
    domain: 'water',
    // 风帆时代的 frigate（宪法号那一级）：战列舰的活它干不了，
    // 但"追得上、看得远、跑得掉"这三件事它全占了。移动 6、视野 5 是 E3 顶格，
    // 甲只有 5——被战列舰逮住就没了。破交、侦察、抓运输船是它的活。
    // 和本体的炮艇（130 金、攻 25、射 4、带破甲）分工：炮艇打正面，它打侧翼。
    // V = 30+27.9+25+9+15+7.5 = 114.4 → 0.65
  },
  {
    id: 'nv_frigate',
    name: '护卫舰',
    short: '护',
    era: 4,
    category: 'combat',
    cost: 310,
    move: 6,
    atk: 30,
    armor: 8,
    maxHp: 78,
    range: 4,
    vision: 4,
    domain: 'water',
    burst: 2,
    // 蒸汽护卫舰的卖点是"追得上"：移动 6、两动。多动就是两次完整的一击，
    // 所以单发攻击力压到 30（对照雷击舰 38/单发）。
    // V = 60+35.1+40+12+15+6 = 168 → 0.54
  },
  {
    id: 'nv_monitor',
    name: '浅水重炮舰',
    short: '浅',
    era: 4,
    category: 'combat',
    cost: 330,
    move: 3,
    atk: 50,
    armor: 10,
    maxHp: 82,
    range: 4,
    vision: 3,
    domain: 'water',
    splash: 1,
    abilities: ['nv-shore-bombard'],
    // 内河与近岸的浮动炮台：慢、笨、打城墙特别狠（岸轰 + 溅射）。
    // 视野只有 3，离开己方侦察就是瞎子——这是它的代价。
    // V = 50+36.9+50+12+7.5+4.5+4 = 165 → 0.50
  },
  {
    id: 'nv_torpedo_boat',
    name: '鱼雷艇',
    short: '雷',
    era: 4,
    category: 'combat',
    cost: 150,
    move: 6,
    atk: 38,
    armor: 3,
    maxHp: 38,
    range: 2,
    vision: 3,
    domain: 'water',
    abilities: ['armor-pierce'],
    /*
     * 鱼雷艇（TB）：一条小艇扛一根鱼雷管，赌的是"贴上去换掉大船"。
     *
     * 这一档是**水军的入口价**：在此之前最便宜能打的船是 285 的雷击舰，
     * 开局根本下不了海。150 金让"三条艇围一条战列舰"成为可执行的方案。
     *
     * 代价写在数值里：射程 2（必须进到别人 4~5 格的炮口下）、血 38、
     * 甲 3——被溅射蹭一下就没了。带破甲是因为鱼雷本来就不吃装甲。
     *
     * V = 38+17.1+15+6+15+4.5 = 95.6 → 0.64。比值偏高是故意的，和火船同一个口径：
     * 价值模型算不出"它活不过一轮"。
     */
  },
  {
    id: 'nv_minelayer',
    name: '布雷舰',
    short: '布',
    era: 4,
    category: 'combat',
    cost: 240,
    move: 3,
    atk: 8,
    armor: 8,
    maxHp: 110,
    range: 1,
    vision: 3,
    domain: 'water',
    abilities: ['nv-lay-mines'],
    // 移动 3、几乎不还手，全部价值在它布下的那些雷上：
    // 它蹲在一条水道上布几天，对面的船要么绕一大圈，要么一条条去趟。
    // 血 110 是为了撑住"被集火也得站两轮"——但**雷不属于它**：
    // 它沉了，之前布下的水雷还在那儿（这就是"格子上留东西"这一层的意思）。
    // V = 8+49.5+40+3+7.5+4.5 = 112.5 → 0.47（雷不进公式，和维修舰同理偏低）
  },
  {
    id: 'nv_minesweeper',
    name: '扫雷舰',
    short: '扫',
    era: 4,
    category: 'combat',
    cost: 220,
    move: 4,
    atk: 22,
    armor: 6,
    maxHp: 76,
    range: 3,
    vision: 6,
    domain: 'water',
    abilities: ['nv-sweep', 'nv-asw'],
    /*
     * 扫雷舰：一战护航队里那种又小又慢、专门走在最前面的船。
     *
     * 它是这一版里唯一"能反制水雷"的东西，也是唯一"能反潜"的东西：
     *   · 扫雷：回合开始时清掉相邻的敌方水雷，自己踩雷只受 4 点；
     *   · 反潜：潜航单位在两格内就现形，打潜航单位伤害翻倍。
     *
     * 为什么两件事放在同一条船上：历史上它们是同一条船（minesweeper 兼
     * 护航/反潜），而且在这个游戏里它们面对的是同一个问题——**
     * "看不见的东西"**。雷是藏起来的格子，潜艇是藏起来的单位，
     * 一条船同时解决两者，玩家才有一张"我该怎么破"的答案。
     *
     * 代价写得很清楚：攻 22、甲 6、血 76，正面打不过任何一条正经战舰。
     * 它必须有人护航才有用——这恰好也是它历史上的处境。
     * V = 22+34.2+30+9+10+9 = 114.2 → 0.52
     */
  },
  {
    id: 'nv_submarine',
    name: '潜艇',
    short: '艇',
    era: 4,
    category: 'combat',
    cost: 300,
    move: 5,
    atk: 62,
    armor: 6,
    maxHp: 70,
    range: 3,
    vision: 5,
    domain: 'water',
    abilities: ['nv-submerge'],
    // 一战 U 艇：便宜、隐蔽、一发狠。它和第六时代的核潜艇是**同一条线**的两端，
    // 不是重复品——这里射程只有 3、甲 6，被逼出水面就是挨打。
    // V = 62+31.5+30+9+12.5+7.5 = 152 → 0.51
  },
  {
    id: 'nv_transport',
    name: '运输舰',
    short: '运',
    era: 4,
    category: 'combat',
    cost: 300,
    move: 5,
    atk: 6,
    armor: 8,
    maxHp: 110,
    range: 1,
    vision: 5,
    domain: 'water',
    carry: { hold: { max: 5 } },
    // 纯运输：五个舱位、几乎不还手。和第六时代的两栖攻击舰分工明确——
    // 两栖能带直升机、能防空、能自保；运输舰只负责"一次把五个人送过去"，
    // 便宜一半，但必须有人护航。V = 6+49.5+40+3+12.5+7.5 = 119 → 0.40
  },
  {
    id: 'nv_cruiser',
    name: '装甲巡洋舰',
    short: '巡',
    era: 5,
    category: 'combat',
    cost: 400,
    move: 5,
    atk: 56,
    armor: 12,
    maxHp: 100,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 无畏舰之前的远洋主力：射程 5、带破甲，专门去啃装了装甲的主力舰。
    // V = 56+45+60+15+12.5+7.5 = 196 → 0.49
  },
  {
    id: 'nv_heavy_cruiser',
    name: '重巡洋舰',
    short: '重',
    era: 5,
    category: 'combat',
    cost: 480,
    move: 5,
    atk: 70,
    armor: 12,
    maxHp: 110,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce'],
    /*
     * 条约型重巡（8 吋炮、一万海里、装甲只够挡 6 吋）：
     * 装巡上面、战巡下面那一格，补的是"中型舰太薄、主力舰太贵"的缝。
     *
     * 和装巡的分工不是单纯数值高低，而是**打谁**：
     *   · 装巡（400，带岸轰）—— 1890 年代的老船，跟着舰队去轰岸；
     *   · 重巡（480，只有破甲）—— 1930 年代的新船，去追、去护、去破交，
     *     便宜到可以豁出去换掉对面的驱逐舰，但撞上战列舰甲 18 一样白搭。
     * 所以它**不给岸轰**：能轰岸的中型舰已经有一条了，再加一条只会让
     * 浅水重炮舰和装巡同时失去位置。
     *
     * V = 70+49.5+60+15+12.5+7.5 = 214.5 → 0.45（E5 的带子 0.38~0.52）
     */
  },
  {
    id: 'nv_light_cruiser',
    name: '轻巡洋舰',
    short: '巡',
    era: 5,
    category: 'combat',
    cost: 430,
    move: 6,
    atk: 58,
    armor: 11,
    maxHp: 100,
    range: 5,
    vision: 6,
    domain: 'water',
    abilities: ['armor-pierce'],
    /*
     * 轻巡（利安得 / 最上 / 布鲁克林）：6 吋炮、三万马力、能跟着驱逐舰跑。
     *
     * 它补的是"驱逐舰 360 → 重巡 480"之间那一格，但分工不靠数值靠**眼睛**：
     * 视野 6 是全海军最高的（战列舰 5、航母之外没人比它看得远），
     * 移动 6 跟得上驱逐舰队。它是舰队的侦察与护航——
     * 迷雾局里"谁先看见谁"往往比"谁炮大"更决定胜负。
     *
     * 名字里带「轻」，但它不是"更弱的重巡"：重巡 480 是去换船的打手，
     * 这条 430 是去发现对方、然后把战列舰叫过来的。
     * V = 58+45+55+15+15+9 = 197 → 0.46
     */
  },
  {
    id: 'nv_fleet_sub',
    name: '远洋潜艇',
    short: '潜',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 5,
    atk: 78,
    armor: 8,
    maxHp: 78,
    range: 3,
    vision: 4,
    domain: 'water',
    abilities: ['nv-submerge'],
    /*
     * U 艇 / 伊号：机械化那一代远洋潜艇，射程 3、甲 8、一发够狠。
     *
     * 补的是一个明摆着的洞：E4 有潜艇、E6 有核潜艇，中间的 E5 反而没有——
     * 于是「潜母」（只给潜艇回血）在这一代成了没有孩子的母舰。
     * 现在三者的关系是：E4 潜艇便宜但脆、E5 远洋潜艇能真的破交、
     * E6 核潜艇快且不用上浮。
     *
     * 射程只有 3：它必须摸到船队跟前，而反潜的驱逐舰射程 5——
     * 被发现就是死，这正是 U 艇在 1943 年之后的处境。
     * V = 78+35.1+40+9+12.5+6 = 180.6 → 0.43
     */
  },
  {
    id: 'nv_landing_ship',
    name: '登陆舰',
    short: '登',
    era: 5,
    category: 'combat',
    cost: 210,
    move: 4,
    atk: 5,
    armor: 6,
    maxHp: 100,
    range: 1,
    vision: 3,
    domain: 'water',
    carry: { hold: { max: 3 } },
    /*
     * LST：船头能直接顶到滩上放跳板。
     *
     * 和运输舰（300 金、5 舱位）分工：一次运三个、但便宜九十金，
     * 而且血 100、甲 6，挨一轮岸防炮还开得回去。抢滩这种事本来就是
     * "多跑几趟、每趟少装点"——大船一次装满，沉一次就全没了。
     *
     * 它是 1×1，所以能进浅流（2×2 的大舰进不去，见吃水那条规则）：
     * 这一条不是新机制，是"小船"这个属性本来带来的。
     * V = 5+45+30+3+10+4.5 = 97.5 → 0.46（舱位不进公式）
     */
  },
  {
    id: 'nv_fleet_carrier',
    name: '舰队航母',
    short: '航',
    era: 5,
    category: 'combat',
    cost: 950,
    move: 4,
    atk: 22,
    armor: 12,
    maxHp: 190,
    range: 3,
    vision: 9,
    domain: 'water',
    // 2×2（和第六时代那条核动力航母同一套"大型单位"表达）：占四格、四格挡路、
    // 只在四格里挨一份溅射；代价是要 2×2 开阔水面，一寸宽的河开不进去。
    footprint: 2,
    // 三个机位、起飞半径 2：比轻母多一个机位、多一格起飞距离。
    carry: { deck: { max: 3, launchRange: 2 } },
    abilities: ['nv-aa-cover'],
    /*
     * 翔鹤 / 埃塞克斯那一级：机械化真正的主角。
     *
     * 之前 E5 只有轻母（2 机位、起飞 1 格）和航空战列舰（半吊子），
     * 正经的舰队航母要等到 E6 的核动力航母——中间空了整整一代。
     *
     * 它自己几乎不打人（攻 22、射 3），全部价值在甲板、视野 9 和那四格航道上。
     * 没开空军扩展时它是一艘"眼睛 + 防空平台"，不是废铁。
     * V = 22+85.5+60+9+10+13.5 = 200 → 0.21（甲板不进公式，和核动力航母同口径）
     */
  },
  {
    id: 'nv_battlecruiser',
    name: '战列巡洋舰',
    short: '巡',
    era: 5,
    category: 'combat',
    cost: 660,
    move: 6,
    atk: 92,
    armor: 12,
    maxHp: 140,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 费舍尔的赌注：战列舰的炮 + 巡洋舰的速度。跑得比战列舰快 2 格，
    // 甲薄 6 点、便宜 120 金——日德兰之后大家都知道"薄皮大炮"意味着什么。
    // 和战列舰**不是替代关系**：追歼、破交、抓巡洋舰用它；顶线用它换不起。
    // V = 92+63+60+15+15+7.5 = 252 → 0.38
  },
  {
    id: 'nv_battleship',
    name: '战列舰',
    short: '战',
    era: 5,
    category: 'combat',
    cost: 780,
    move: 4,
    atk: 95,
    armor: 18,
    maxHp: 180,
    range: 5,
    vision: 5,
    domain: 'water',
    splash: 2,
    abilities: ['armor-pierce', 'siege-master', 'nv-shore-bombard'],
    // **无畏舰**，历史定位落在第五时代（机械化），不是第六时代。
    // 全部三项攻城加成（破甲 + 破城 + 岸轰）都在它身上，射程 5、溅射 2——
    // 它是一战到机械化之间"大舰巨炮"这条路的终点。
    // 第六时代没有战列舰：1945 年之后没有任何国家再开工建一级，
    // 原因写在 docs/NAVAL-PACK.md（导弹、航母、成本三件事各补一刀）。
    // V = 95+81+90+15+10+7.5+8 = 306 → 0.39
  },
  {
    id: 'nv_light_carrier',
    name: '轻型航空母舰',
    short: '轻',
    era: 5,
    category: 'combat',
    cost: 640,
    move: 5,
    atk: 20,
    armor: 10,
    maxHp: 130,
    range: 3,
    vision: 8,
    domain: 'water',
    // 两个机位、起飞半径 1：船小甲板短，只能把飞机放到贴身一格。
    carry: { deck: { max: 2, launchRange: 1 } },
    abilities: ['nv-aa-cover'],
    // 独立级 / 护航航母：用巡洋舰船体改出来的应急航母。两个机位、
    // 视野 8、能防空，自己几乎不打人。和第六时代的舰队航母分工：
    // 轻母是"数量"，一艘航母的钱能买两艘半轻母。
    // V = 20+58.5+50+9+12.5+12 = 162 → 0.25（甲板的价值不在公式里）
  },
  {
    id: 'nv_aviation_battleship',
    name: '航空战列舰',
    short: '航',
    era: 5,
    category: 'combat',
    cost: 860,
    move: 4,
    atk: 70,
    armor: 16,
    maxHp: 165,
    range: 5,
    vision: 7,
    domain: 'water',
    splash: 1,
    // 拆了后主炮换来的一个机位，只能起降一架（半径 1）。
    carry: { deck: { max: 1, launchRange: 1 } },
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 伊势级那种"拆了后主炮换飞行甲板"的混血。它存在的意义不是强，
    // 而是**告诉你专精更划算**：炮不如战列舰（95→70）、机位只有一个、
    // 比轻母贵 220。造它是因为"我两样都想要"，而两样都想要通常两样都不够。
    // V = 70+74.25+80+15+10+10.5+4 = 264 → 0.31
  },
  {
    id: 'nv_sub_tender',
    name: '潜母',
    short: '母',
    era: 5,
    category: 'combat',
    cost: 460,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 140,
    range: 0,
    vision: 7,
    domain: 'water',
    abilities: ['nv-sub-tender'],
    // 潜水母舰：给潜艇补氧气、补鱼雷、修耐压壳。完全不打人，视野 7。
    // 它和维修舰的分工是**水下 / 水面**：潜母只修潜艇（一次 6 点，比维修舰高），
    // 维修舰只修水面舰。想两样都管就得带两艘船——这就是编队的成本。
    // V = 0+63+50+0+10+10.5 = 134 → 0.29
  },
  {
    id: 'nv_repair_ship',
    name: '维修舰',
    short: '修',
    era: 5,
    category: 'combat',
    cost: 420,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 130,
    range: 0,
    vision: 5,
    domain: 'water',
    abilities: ['nv-fleet-repair'],
    // 海上抢修船：把"回港修三个月"压成"跟着舰队慢慢回"。
    // 不打人、跑得慢，是整支舰队里最该被保护的那条船。
    // V = 0+58.5+50+0+10+7.5 = 126 → 0.30
  },
];

const MODERN_FLEET_UNITS: UnitTypeDef[] = [
  {
    id: 'nv_carrier',
    name: '航空母舰',
    short: '航',
    era: 6,
    category: 'combat',
    cost: 1350,
    move: 3,
    atk: 26,
    armor: 15,
    maxHp: 260,
    range: 3,
    vision: 9,
    domain: 'water',
    // 2×2：占四格、四格都挡路、只在四格里挨一份伤害（见 rules 的 distBetweenUnits）。
    // 这是引擎里"大型单位"的唯一表达方式，也是城市与兵营在用的那套。
    footprint: 2,
    // 四个机位、起飞半径 2（够到相邻格之外）。
    // 甲板规格以前写在 DECK_SPECS 那张表里，现在就在这一行上——
    // 加一艘能带飞机的船，只改这里，不用再去改接口文件。
    carry: { deck: { max: 4, launchRange: 2 } },
    abilities: ['nv-fleet-command', 'nv-aa-cover'],
    // 全图视野最好的船，自己几乎不打人。**它是 `naval-carrier.ts` 那道接口的宿主**：
    // 机位 4、起飞半径 2 就写在上面那行 `carry.deck` 里——
    // 甲板是这条船的属性，不再另存一份到接口表。
    //
    // **大型单位**（footprint 2，占 2×2 四格）：
    //   · 好处：四格一起挡路，是一条能封锁航道的船；只在四格里挨一份溅射；
    //   · 代价：需要 2×2 的开阔水面才能造、才能停（一寸宽的河里开不进航母），
    //     而且移动力压到 3——这么大的船掉头本来就慢。
    //   · 血量从 200 提到 260、护甲 14→15、造价 1250→1350：占到四格之后
    //     被围住的风险更高，光靠 200 血撑不住一轮集火。
    //
    // 没有空军扩展时它不是废铁：旗舰光环（相邻 +2/+2）+ 视野 9 + 防空，
    // 是一艘"移动指挥部"。V = 26+117+75+9+7.5+13.5 = 248 → 0.18，
    // 光是船体确实不值这个价——它的价值在甲板、光环和那四格航道上，这三样都不进公式。
  },
  {
    id: 'nv_large_cruiser',
    name: '超巡',
    short: '超',
    era: 6,
    category: 'combat',
    cost: 1050,
    move: 5,
    atk: 85,
    armor: 17,
    maxHp: 175,
    range: 6,
    vision: 6,
    domain: 'water',
    abilities: ['armor-pierce', 'nv-shore-bombard'],
    // 基洛夫级那种核动力大巡洋舰：**它接的是战列舰的位置，但不是战列舰**。
    // 导弹时代的"大舰"是巡洋舰体量——炮只是副业，主战武器是射程 6 的导弹。
    // 所以它没有溅射 2（舰炮不再是主角），但射程和护甲都压过普通巡洋舰。
    // V = 85+78.75+85+18+12.5+9 = 288 → 0.27
  },
  {
    id: 'nv_aegis',
    name: '防空巡洋舰',
    short: '防',
    era: 6,
    category: 'combat',
    cost: 880,
    move: 5,
    atk: 72,
    armor: 15,
    maxHp: 150,
    range: 6,
    vision: 7,
    domain: 'water',
    abilities: ['nv-aa-cover', 'armor-pierce'],
    // 舰队之伞：视野 7 比超巡好，区域防空对空中层多打 12 点。
    // 空军扩展上线之前，它就是"视野好、能打、跑得快"的通用巡洋舰。
    // V = 72+67.5+75+18+12.5+10.5 = 256 → 0.29
  },
  {
    id: 'nv_attack_sub',
    name: '攻击核潜艇',
    short: '潜',
    era: 6,
    category: 'combat',
    cost: 900,
    move: 5,
    atk: 92,
    armor: 9,
    maxHp: 100,
    range: 4,
    vision: 5,
    domain: 'water',
    abilities: ['nv-submerge'],
    // 水下刺客：迷雾局里贴脸才现形，先手不被反击。
    // 这条线现在有三段：E4 潜艇（便宜、射 3）→ E5 远洋潜艇（能真破交）
    // → 它（射 4、攻 92、不用频繁上浮）。价格翻三倍，差的是"能不能单挑一支护航队"。
    // V = 92+45+45+12+12.5+7.5 = 214 → 0.24（潜航的价值不在公式里）
  },
  {
    id: 'nv_ssk',
    name: '常规潜艇',
    short: '潜',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 5,
    atk: 74,
    armor: 7,
    maxHp: 72,
    range: 4,
    vision: 4,
    domain: 'water',
    abilities: ['nv-submerge'],
    /*
     * AIP 常规潜艇（基洛 / 苍龙）：不开核反应堆也能在水下憋两周。
     *
     * 补的是第六时代的**价位**：能潜的船原本只有 900 金的核潜艇，
     * 于是"穷的时候怎么办"没有答案。520 金这条能做的事和核潜艇很像，
     * 只是慢一点、脆一点——够用了，敢沉。
     *
     * 和核潜艇的分工不是"弱化版"：核潜艇 900 金可以跟着航母编队跑半个地图，
     * 这条只适合守家门口的水道（移 5、血 72，被发现就危险）。
     * V = 74+32.4+35+12+12.5+6 = 171.9 → 0.33
     */
  },
  {
    id: 'nv_amphib',
    name: '两栖攻击舰',
    short: '两',
    era: 6,
    category: 'combat',
    cost: 760,
    move: 5,
    atk: 22,
    armor: 12,
    maxHp: 165,
    range: 2,
    vision: 6,
    domain: 'water',
    // 两种装法并存：舱里的陆战队，甲板上的直升机。
    carry: { hold: { max: 4 }, deck: { max: 2, launchRange: 1 } },
    abilities: ['nv-aa-cover'],
    // 登陆作战的核心：4 个舱位 + 2 个直升机位（就写在上面那行 carry 里）。
    // 火力很弱（22 攻），它存在的意义是把四个兵送到对岸的城市旁边。
    // 和「运输舰」的分工：运输舰只运（容量 5、更便宜），两栖能自保、能防空、
    // 能带直升机——贵一倍多。
    // V = 22+74.25+60+6+12.5+9 = 184 → 0.24
  },
  {
    id: 'nv_missile_boat',
    name: '导弹快艇',
    short: '导',
    era: 6,
    category: 'combat',
    cost: 400,
    move: 7,
    atk: 58,
    armor: 5,
    maxHp: 58,
    range: 4,
    vision: 5,
    domain: 'water',
    // 空潜快里的"快"：400 金买不到的东西它都有——射程 4、移 7、58 攻。
    // 代价是甲 5、血 58：挨一发战列舰的溅射就没了。
    // V = 58+26.1+25+12+17.5+7.5 = 146 → 0.37（略高于同代，靠脆换来的）
  },
  {
    id: 'nv_lcs',
    name: '濒海战斗舰',
    short: '濒',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 7,
    atk: 56,
    armor: 10,
    maxHp: 100,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce'],
    /*
     * 濒海战斗舰 / 现代护卫舰（自由级、054A 那一档）：小、快、够用。
     *
     * 第六时代原来只有 620 的导弹驱逐舰和 880 的防空巡洋舰，
     * 中间缺"能干活但不心疼"的那一条。它比导弹快艇能扛（甲 10、血 100），
     * 比驱逐舰便宜一百金、快两格——适合贴着自家海岸线巡逻、反潜、护渔。
     *
     * 移 7 是全场并列最快（只有导弹快艇能比）：跑得掉，才敢去试探。
     * V = 56+45+50+15+17.5+7.5 = 191 → 0.37
     */
  },
  {
    id: 'nv_usv',
    name: '无人艇',
    short: '无',
    era: 6,
    category: 'combat',
    cost: 240,
    move: 8,
    atk: 26,
    armor: 2,
    maxHp: 26,
    range: 4,
    vision: 3,
    domain: 'water',
    /*
     * 无人水面艇（USV）：不载人，所以敢冲、敢死、敢贴近。
     *
     * 第六时代的水军一片"贵"，240 金这条是唯一的消耗品：
     * 移 8（全场最快）、射 4、血 26 甲 2——挨一下就散。
     * 用途是"先去探一下那片水域有没有雷/有没有潜艇"，或者凑数占航道。
     * 不带破甲：它那点火力本来就不指望打穿军舰，打商船和落单快艇就行。
     *
     * V = 26+11.7+10+12+20+4.5 = 84.2 → 0.35
     */
  },
  {
    id: 'nv_oiler',
    name: '舰队补给舰',
    short: '补',
    era: 6,
    category: 'combat',
    cost: 430,
    move: 4,
    atk: 0,
    armor: 10,
    maxHp: 130,
    range: 0,
    vision: 6,
    domain: 'water',
    abilities: ['nv-fleet-oiler'],
    // 和第五时代的「维修舰」刻意分工：维修舰修血，补给舰给**机动**
    // （相邻友舰 +1 移动）。两种支援不该是同一条船的两个数值版本——
    // 那样玩家只会买便宜的那条，另一条永远不出场。
    // V = 0+58.5+50+0+10+9 = 128 → 0.30
  },
  {
    id: 'nv_oil_platform',
    name: '海上钻井平台',
    short: '井',
    era: 6,
    // 经济类**建筑**：它是海面上的一座平台，不是一艘会自己开过去、也不是
    // 在港里下单就能刷出来的船。所以类型是 building —— 和磨坊、粮仓同一个口径，
    // 由建筑队在海上选址修起来（见下面的 buildOn / buildRange）。
    category: 'building',
    cost: 480,
    buildCost: 36,
    buildOn: ['water', 'deep', 'shallow'],
    // 平台的价值在深水，而深水通常离岸三格以上：按默认的 2 格，建筑队站在
    // 滩头永远够不着自己最想盖的地方。给到 6 格，地形与占位条件一条不松。
    buildRange: 6,
    move: 0,
    atk: 0,
    armor: 6,
    maxHp: 90,
    range: 0,
    vision: 3,
    domain: 'water',
    incomeByTerrain: { deep: 50, water: 34, shallow: 20 },
    // 海上经济单位：**造出来就不动了**，收入看它站在什么水上。
    // 深水 50 / 水域 34 / 浅流 20——「深水」是这一版新加的地形，
    // 越往外海走越肥，但也就越难守（离本土远、补给线长）。
    // 回本：480 / 50 = 9.6 回合（深水），比陆上的农业公司（7.2）慢，
    // 换来的是"陆地上没这块地"——岛上或者海峡中间的局，这是唯一的收入增长点。
    //
    // 和海军单位的互动：**敌舰贴着它，它就停产**（见 modifyYield）。
    // 所以它天然要求制海权；反过来，敌方的钻井平台也是最好的袭扰目标——
    // 打掉一座 480 金的平台，比击沉一条 300 金的运输舰更伤经济。
  },
];

/* ===========================================================================
 * 三、两条舰队规则（扩展钩子，纯规则、不绑兵种）
 * ======================================================================== */

/** 城市矩形到某点的曼哈顿距离（在城内为 0）。和 rules 里那套算法同一个口径 */

/** 封锁的税额：每座 8 金，最多 24 */
const BLOCKADE_PER_CITY = 8;
const BLOCKADE_CAP = 24;

/**
 * 被封锁的城市少交多少税。
 *
 * 纯函数：`incomeResOf` 在热路径上（AI 每回合算预算要问几十次），
 * 这里只数城、数船，不写任何状态。
 */
function blockedIncome(state: GameState, player: PlayerId, income: number): number {
  let lost = 0;
  for (const city of state.cities) {
    if (city.owner !== player || city.ruined) continue;
    if (!blockaded(state, city, player)) continue;
    lost += BLOCKADE_PER_CITY;
    if (lost >= BLOCKADE_CAP) return Math.max(0, income - BLOCKADE_CAP);
  }
  return Math.max(0, income - lost);
}

/** 这一方有没有水面单位贴在城边（封锁） */
function blockaded(s: GameState, city: { x: number; y: number; size: number }, owner: PlayerId): boolean {
  return s.units.some(
    (u) => u.owner !== owner && s.unitTypes[u.type]?.domain === 'water' && cityGap(city, u) <= 1,
  );
}

/* ---------------------------------------------------------------------------
 * 共用规则：两个包都会用到，所以只写一份
 *
 * 「海战」和「现代海军」都要封锁与抢修。两个包各写一遍的话，同时勾上就会
 * **跑两次**：城回血被掐两次（无害），港口修理却会变成每回合回 8 点（有害）。
 * 所以这里写成两个共享函数，并且修理带一个"这一回合已经修过"的标记——
 * 幂等靠数据，不靠"玩家不会同时勾两个包"这种假设。
 * ------------------------------------------------------------------------- */

/** 港口抢修：贴着自家城的水面单位每回合 +4（同回合只算一次） */
function portRepair(state: GameState, player: PlayerId): void {
  for (const u of state.units) {
    if (u.owner !== player) continue;
    const def = state.unitTypes[u.type];
    if (def?.domain !== 'water') continue;
    if (u.hp >= def.maxHp) continue;
    const atPort = state.cities.some((c) => c.owner === player && cityGap(c, u) <= 1);
    if (!atPort) continue;
    // 两个包同时开时这个钩子会被叫两次，靠哨兵挡住第二次
    if (u.custom?.portRepairedTurn === state.turn) continue;
    u.custom = { ...(u.custom ?? {}), portRepairedTurn: state.turn };
    u.hp = Math.min(def.maxHp, u.hp + 4);
  }
}

/**
 * 甲板整备：把"轮到你"这个时机转告空军扩展（没接入就什么都不做）。
 *
 * 两个海军包都挂了这个钩子，所以同一次回合开始会被叫两遍。空军那边的
 * `onDeckTurnStart` 是"先收、再修、后放"的完整一套——跑两遍的后果不是
 * 放两架，而是**刚放出去的那架立刻被收回来再修一次**，玩家看到的是
 * "飞机原地没动、血却多回了 8 点"。所以这里用和 `portRepair` 同一个办法：
 * 在船身上记一个本回合的哨兵，第二遍直接跳过。
 */
function deckUpkeep(state: GameState, player: PlayerId): void {
  const ops = airwingOps();
  if (!ops?.onDeckTurnStart) return;
  for (const u of state.units) {
    if (u.owner !== player) continue;
    if (!deckSpecOf(state.unitTypes[u.type])) continue;
    if (u.custom?.deckUpkeepTurn === state.turn) continue;
    u.custom = { ...(u.custom ?? {}), deckUpkeepTurn: state.turn };
    ops.onDeckTurnStart({ state, carrier: u });
  }
}

/** 面板行：甲板状态 + 封锁/停泊提示。两个包共用，免得各画一遍出现双份 */
function navalPanelLines(state: GameState, unit: Unit): string[] {
  const lines: string[] = [];
  // 大型单位的体量要写出来：玩家点了半天发现"怎么放不下"，
  // 得有一句话告诉他这不是 bug，是 2×2 的要求。
  if (state.unitTypes[unit.type]?.footprint === 2) {
    lines.push('占地 2×2：四格一起挡路，起飞/停泊都要 2×2 的开阔水面');
  }
  const deck = deckLine(state.unitTypes[unit.type], unit);
  if (deck) lines.push(deck);
  const def = state.unitTypes[unit.type];
  if (def?.domain === 'water') {
    const enemyCity = state.cities.find((c) => c.owner !== unit.owner && cityGap(c, unit) <= 1);
    if (enemyCity) lines.push(`正在封锁敌城外港：它这一回合少收 ${BLOCKADE_PER_CITY} 金`);
    const ownCity = state.cities.find((c) => c.owner === unit.owner && cityGap(c, unit) <= 1);
    if (ownCity) lines.push('停在自家港口：每回合回复 4 点');
  }
  return lines;
}

/* ---------------------------------------------------------------------------
 * 深水与钻井平台：两个包里都要用，同样只写一份
 * ------------------------------------------------------------------------- */

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 把离岸两格以上的 water 改写成 deep。
 *
 * 为什么走 `afterTerrain` 而不是让 mapgen 直接画：地形生成器是本体的事，
 * 让它认识一种"扩展才有的格子"，等于把扩展规则缝进核心。`afterTerrain`
 * 拿到的是已经画完的整张图，就地改——「地形高差」补山脚用的也是这一招。
 *
 * 只改 `water`，不动 `shallow`：浅流是"陆军能踩过去的水"，把它深水化
 * 等于偷偷改了整张图的可通行性（陆军的过河点会凭空消失）。
 */
const deepenWater: NonNullable<Expansion['afterTerrain']> = (g, w, h) => {
  // 从所有陆地出发做一遍 BFS，水格的层数就是"离岸几步"
  const far = new Int16Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < g.length; i++) {
    if (navigable(g[i]!)) continue;
    far[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = ny * w + nx;
      if (!navigable(g[k]!)) continue;
      if (far[k] !== -1) continue;
      far[k] = far[i]! + 1;
      queue.push(k);
    }
  }
  // 离岸 >=2 格才算外海：沿岸那一圈留成水域，
  // 这样"贴着岸能不能下水/靠港"的老判定一条都不用改。
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== 'water') continue;
    if (far[i]! >= 2) g[i] = 'deep';
  }
};

/**
 * 钻井平台：敌舰贴着就停产。
 *
 * 走 `modifyYield` 而不是"改 unit.income"：那个字段是兵种表里的共享定义，
 * 改它等于给全场所有平台一起停产。钩子是按单位算的，天然分得清。
 *
 * 只对**水上经济单位**生效：陆地上的农田不该被一条路过的船掐掉收入。
 */
function platformYield(state: GameState, unit: Unit, yields: ResourceCost): ResourceCost {
  const def = state.unitTypes[unit.type];
  // 钻井平台从「经济单位」改成「经济建筑」之后，这里的口径要跟着放宽：
  // 判的是"这条船贴着的那座东西挣不挣钱"，不是它在兵种表里挂哪个分类。
  const earning = def?.category === 'economy' || def?.category === 'building';
  if (!def || !earning || def.domain !== 'water') return yields;
  const cut = state.units.some((u) => {
    if (u.owner === unit.owner) return false;
    if (state.unitTypes[u.type]?.domain !== 'water') return false;
    return Math.abs(u.x - unit.x) + Math.abs(u.y - unit.y) <= 1;
  });
  return cut ? {} : yields;
}

/**
 * 「海战」：E2~E5 的七条船 + 封锁与抢修。
 *
 * 为什么这两条规则要单独放在包上、而不是做成能力：
 * 它们说的是"**海权**有什么意义"，不是某条船的特长。做成能力的话，
 * 玩家会以为"只有带这条能力的船才能封锁"，而现实是任何一条船堵在港口
 * 都能让城断粮——规则的口径应该和直觉一致。
 *
 * 封锁掐的是**税收**，不是回血。本来想掐回血的，翻了一遍核心才发现
 * `cityRegenOf()` 里已经有一条"城外有敌人就不回血"（围城），任何单位贴着
 * 城都算——再写一遍就是同一条规则的两份实现，看着像新机制，其实什么都不做。
 * 所以改成断收入：三座城被堵各自少 8 金，一回合少 24，这才是"海权"该有的疼。
 */
/**
 * 造船设施：把"船只能从沿海城市出"这条限制解开。
 *
 * ── 问题 ──────────────────────────────────────────────────────────────
 *
 * 水军的出生格是"城边那一格水面"（rules.recruitSpawnCells 的 water 分支）。
 * 这意味着两个条件同时成立才造得出船：**城的落点靠水**，而且**那一圈水面空着**。
 * 二十格图里，内陆城根本没法参与海战；玩家想做海军，先得赌开局城的位置。
 * 军营（camp）也产兵，但它只能扎在平地/丘陵上，靠水那条 `requiresWater`
 * 只是"挨着水盖"，兵还是从岸上出来，船一条也出不了。
 *
 * ── 解法 ──────────────────────────────────────────────────────────────
 *
 * 造船设施**直接盖在水面上**（`buildOn: ['shallow','water']`），自己就是产兵点：
 * 船从它四周的水面下水，和城在哪没关系。代价是它是个不动的靶子
 * （护甲有、血不厚），而且只能盖在会架桥的工程兵手上——开一条水道、修一座船坞，
 * 本来就是同一批人的活。
 *
 * 分三档，对应船的三个世代。白名单是显式列出来的 id：这样"哪一档能造什么"
 * 在数据里一眼看得见，不需要读规则去推。
 */
const SHIPYARDS: UnitTypeDef[] = [
  {
    id: 'nv-dock',
    name: '船坞',
    short: '坞',
    era: 2,
    category: 'building',
    cost: 120,
    move: 0,
    atk: 0,
    armor: 4,
    maxHp: 80,
    range: 0,
    vision: 4,
    buildCost: 10,
    buildOn: ['shallow', 'water'],
    // 二代的四条船。三代以后的不在这一档——想造大帆船得先把造船厂升起来。
    produce: {
      units: ['nv_galley', 'nv_dromon', 'nv_carrack', 'nv_treasure_ship'],
      costScale: 0.95,
    },
  },
  {
    id: 'nv-shipyard',
    name: '造船厂',
    short: '厂',
    era: 4,
    category: 'building',
    cost: 260,
    move: 0,
    atk: 0,
    armor: 6,
    maxHp: 130,
    range: 0,
    vision: 5,
    buildCost: 26,
    buildOn: ['shallow', 'water'],
    produce: {
      units: [
        'nv_fireship',
        'nv_galleon',
        'nv_turtle_ship',
        'nv_sailing_frigate',
        'nv_frigate',
        'nv_monitor',
        'nv_torpedo_boat',
        'nv_minelayer',
        'nv_minesweeper',
        'nv_submarine',
        'nv_transport',
      ],
      costScale: 0.9,
    },
  },
];

/**
 * 六代的海军船台：主力舰两回合下水一艘。
 *
 * `everyTurns: 2` 不是"削弱"，是**节奏**：一艘 780 金的战列舰如果当回合就成型，
 * 那"攒钱等它"这件事就不存在了，海战退化成"谁先攒够谁立刻多一条船"。
 * 两回合给对面一个反应窗口（布雷、封港、派潜艇），也让"同时开两条产线"有意义。
 */
const MODERN_SHIPYARDS: UnitTypeDef[] = [
  {
    id: 'nv-naval-yard',
    name: '海军船台',
    short: '台',
    era: 6,
    category: 'building',
    cost: 460,
    move: 0,
    atk: 0,
    armor: 8,
    maxHp: 190,
    range: 0,
    vision: 6,
    buildCost: 44,
    buildOn: ['shallow', 'water'],
    produce: {
      units: [
        'nv_cruiser',
        'nv_heavy_cruiser',
        'nv_light_cruiser',
        'nv_battlecruiser',
        'nv_battleship',
        'nv_fleet_carrier',
        'nv_light_carrier',
        'nv_aviation_battleship',
        'nv_landing_ship',
        'nv_fleet_sub',
        'nv_sub_tender',
        'nv_repair_ship',
        'nv_carrier',
        'nv_large_cruiser',
        'nv_aegis',
        'nv_attack_sub',
        'nv_ssk',
        'nv_amphib',
        'nv_missile_boat',
        'nv_lcs',
        'nv_usv',
        'nv_oiler',
      ],
      everyTurns: 2,
      costScale: 0.85,
    },
  },
];

/**
 * 把造船设施挂到"会架桥的工程兵"手上。
 *
 * 判据是"builds 里有 bridge"而不是写死 id 列表：能开一条水道的人，就能修一座船坞。
 * 这样基础版、时代兵备包、城郭与物料包里的各级工程兵会自动都拿到，
 * 以后再加工程兵也不用回来改这里。
 */
function attachShipyards(state: GameState, ids: readonly string[]): void {
  for (const def of Object.values(state.unitTypes)) {
    if (!def.builds || !def.builds.includes('bridge')) continue;
    for (const id of ids) if (!def.builds.includes(id)) def.builds.push(id);
  }
}

/**
 * 「海军」：第二到第六时代的水上力量，一个包。
 *
 * ---------------------------------------------------------------
 * 为什么从一个包变一个包（2026-11-04）
 * ---------------------------------------------------------------
 * 以前是两个：「海战」（桨帆船到护卫舰，29 个单位）+「现代海军」（第六代 12 个，
 * `requires: ['pack-contemporary']`）。分开的理由本来是"第六代要有前置"，
 * 但这件事不需要一整个包来表达——兵种级 `requiresPack` 就够了。
 * 分两个包的代价是"我要不要海军"多出一个中间答案：勾了「海战」没勾「现代海军」，
 * 航母和核潜艇就不出现，玩家只会觉得漏了什么。
 *
 * 现在：勾一个「海军」，第二到第五代的船全部到场；第六代那 12 个
 * 挂 `requiresPack: 'pack-contemporary'`——开了「信息化」自动出现，没开就不进场
 * （判据在 setup.ts 的 expansionUnitsFor，和开局面板的兵种池是同一处）。
 *
 * 钩子原来两个包各写一份、内容几乎一样（封锁 / 抢修 / 甲板），合并成一份之后
 * 不会再有"改一处忘一处"的问题，执行顺序也定死：先甲板整备，再港口抢修。
 */
export const NAVAL: Expansion = {
  id: 'naval',
  name: '海军',
  blurb: '从桨帆船到航母，加水雷与海权规则。',
  scale: 'large',
  summary:
    '第二到第六时代的水上力量：桨帆船、德罗蒙、卡拉克、盖伦、风帆巡航舰、护卫舰、鱼雷艇、' +
    '布雷舰、扫雷舰、浅水重炮舰、潜艇、运输舰、铁甲舰、装甲巡洋舰、战列巡洋舰、战列舰、' +
    '舰队航母；第六代再加航空母舰、超巡、防空巡洋舰、攻击核潜艇、濒海战斗舰、无人艇、' +
    '两栖攻击舰、导弹快艇、舰队补给舰、海上钻井平台——**第六代这批要同时开「信息化」**。' +
    '两条海权规则（封锁港口断税收、贴着自家城抢修）、**深水**地形（离岸两格以上的外海，' +
    '只有船进得去，大舰吃水深进不了浅流），以及水雷（布雷 / 扫雷 / 反潜）。',
  abilities: [...FLEET_ABILITIES, ...MODERN_ABILITIES],
  /**
   * 这个包带来的"格子上留东西"的种类：水雷。
   *
   * 引擎（core/marks.ts）只管"谁踩上来、什么时候结算"，水雷长什么样、
   * 炸多少，全在这个包里。以后做地雷、火场、雷区标记，各写一个 kind 挂到
   * 对应扩展的 `marks` 上就行，规则层一行都不用改。
   */
  marks: [NAVAL_MINE],
  units: [
    ...FLEET_UNITS,
    ...SHIPYARDS,
    // 第六代：靠 requiresPack 门控，不开「信息化」就不进本局兵种表
    ...[...MODERN_FLEET_UNITS, ...MODERN_SHIPYARDS].map((u) => ({
      ...u,
      requiresPack: 'pack-contemporary',
    })),
  ],
  terrains: ['deep'],
  afterTerrain: deepenWater,
  hooks: {
    /** 开局：会架桥的工程兵多会一样东西——修造船设施（两代的船台一起给） */
    onMatchStart: ({ state }) => {
      attachShipyards(state, SHIPYARDS.map((d) => d.id));
      attachShipyards(state, MODERN_SHIPYARDS.map((d) => d.id));
    },
    /** 钻井平台：敌舰贴着就停产 */
    modifyYield: ({ state, unit, yields }) => platformYield(state, unit, yields),
    /**
     * 封锁：敌方水面单位贴着你的城，那座城这一回合的税收断掉。
     *
     * 每座 −8 金、最多 −24（也就是三座城封顶）。为什么封顶：
     * 后期四城全开的话，一条 45 金的舢板堵满四条水路能让对面直接破产，
     * 而"派一条船过去"根本不该有这么高的赔率。
     */
    modifyIncome: ({ state, player, income }) => blockedIncome(state, player, income),

    /**
     * 回合开始：先甲板整备、再港口抢修。
     *
     * 整备在前：空军扩展可能在这一步把飞机放回甲板/扣燃油，顺序固定下来，
     * 海军空军同时开时行为一致。
     *
     * 抢修的数值（4 点）是照"回一趟港要两三个回合"定的：
     * 一条 100 血的巡洋舰从残血修回来要十几回合，所以它只是"不用回城"，
     * 不是"永不沉没"。真正让它沉的是被围住——围住就没有自家城可贴。
     */
    onTurnStart: ({ state, player }) => {
      deckUpkeep(state, player);
      portRepair(state, player);
    },

    /**
     * 面板：航母多一行甲板状态；船在封锁/停泊时给一句提示。
     *
     * 这一行是**接口的可见部分**：没有空军扩展时它明说"未接入"，
     * 而不是画一个空甲板让人以为飞机掉了。
     */
    getUnitPanelLines: ({ state, unit }) => navalPanelLines(state, unit),
  },
};

/** 空军扩展接入时用得上的：把一个已经贴着母舰的飞机收进甲板 */
export function tryRecoverPlane(state: GameState, carrier: Unit, plane: Unit): { ok: boolean; reason?: string } {
  const ops = airwingOps();
  if (!ops) return { ok: false, reason: '没有空军扩展接入' };
  return ops.recover({ state, carrier, plane });
}
