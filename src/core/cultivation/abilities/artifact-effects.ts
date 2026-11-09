/**
 * 法器自带的**命中效果**：打上去就挂一个 debuff。
 *
 * 和 `artifact-auras.ts` 的分工：那里是"站在旁边就受益"，这里是"打中才生效"。
 *
 * ── 为什么每个能力都写了两条钩子 ────────────────────────────
 *
 * `onHit` 只对**主目标**触发，`onSplash` 只对**被波及的**触发——两者是互斥的，
 * 不是包含关系。所以"冻住一片"必须两条都写：漏了 `onSplash` 就变成
 * "只冻住我点的那个人"，而法器最贵的地方恰恰是那片范围。
 *
 * 这也是这两个能力没有直接复用「霜缚」（`slow-hit`）的原因：那条是老能力，
 * 只挂 `onHit`，改成两条会一次动到所有带霜缚的兵种。
 */
import type { AbilityDef } from '../../abilities.ts';
import type { AbilityHooks } from '../../ability-hooks.ts';
import { HIT_STAGE } from '../../ability-hooks.ts';

/** debuff 持续几个回合。不叠加：再打一次只是把回合数刷新回这个值。 */
export const ARTIFACT_DEBUFF_TURNS = 2;

export const CHILL_HIT_ID = 'artifact-chill';
export const CHILL_HIT_LABEL = '寒霜';
export const SUNDER_HIT_ID = 'artifact-sunder';
export const SUNDER_HIT_LABEL = '熔甲';

export const CHILL_HIT: AbilityDef = {
  id: CHILL_HIT_ID,
  name: CHILL_HIT_LABEL,
  summary:
    `命中让目标「迟缓」${ARTIFACT_DEBUFF_TURNS} 回合：移动力减半，至少留 1 格。` +
    '被溅射波及的敌人同样生效。',
  group: 'attack',
  hooks: {
    onHit: [
      {
        stage: HIT_STAGE.status,
        apply: (c) => {
          if (c.api.putStatus(c.target, 'chill', ARTIFACT_DEBUFF_TURNS)) c.touched.push('迟缓');
        },
      },
    ],
    // 溅射受害者：只挂状态，不写战报（一场 AOE 冻三个人不该刷三行）
    onSplash: (c) => {
      c.api.putStatus(c.victim, 'chill', ARTIFACT_DEBUFF_TURNS);
    },
  } satisfies AbilityHooks,
};

export const SUNDER_HIT: AbilityDef = {
  id: SUNDER_HIT_ID,
  name: SUNDER_HIT_LABEL,
  summary:
    `命中让目标「熔甲」${ARTIFACT_DEBUFF_TURNS} 回合：护甲减半（按**当前**护甲算，含光环与地形）。` +
    '被溅射波及的敌人同样生效。',
  group: 'attack',
  hooks: {
    onHit: [
      {
        stage: HIT_STAGE.status,
        apply: (c) => {
          if (c.api.putStatus(c.target, 'sunder', ARTIFACT_DEBUFF_TURNS)) c.touched.push('熔甲');
        },
      },
    ],
    onSplash: (c) => {
      c.api.putStatus(c.victim, 'sunder', ARTIFACT_DEBUFF_TURNS);
    },
  } satisfies AbilityHooks,
};
