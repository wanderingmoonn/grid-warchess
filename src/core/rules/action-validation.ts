import type { Action } from '../types.ts';

/** TypeScript 无法校验从存档、网络或控制台传入的值，在迁移前验证命令形状。 */
export function actionError(action: unknown): string | null {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return '行动格式无效';
  }
  const a = action as Record<string, unknown>;
  const id = (key: string): boolean => typeof a[key] === 'string' && a[key].length > 0;
  const position = (): boolean => Number.isInteger(a.x) && Number.isInteger(a.y);
  let valid: boolean;
  switch (a.type as Action['type']) {
    case 'MOVE': valid = id('unitId') && position(); break;
    case 'ATTACK': valid = id('unitId') && id('targetId'); break;
    case 'SIEGE': valid = id('unitId') && id('cityId'); break;
    case 'BUILD': valid = id('unitId') && id('unitType') && position(); break;
    case 'LOAD': valid = id('unitId') && id('cargoId'); break;
    case 'UNLOAD': valid = id('unitId') && id('cargoId') && position(); break;
    case 'UPGRADE': valid = id('cityId'); break;
    case 'RECRUIT':
      valid = id('unitType') && ((id('cityId') && a.unitId === undefined)
        || (id('unitId') && a.cityId === undefined));
      break;
    case 'SET_ORDERS':
      valid = Array.isArray(a.queue) && a.queue.every(value => typeof value === 'string');
      break;
    case 'END_TURN': valid = true; break;
    default: return '未知的行动类型';
  }
  return valid ? null : '行动参数无效';
}
