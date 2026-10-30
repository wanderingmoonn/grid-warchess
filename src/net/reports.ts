/**
 * 对局报告的上传通道。
 *
 * 和联机房间共用同一个云数据库、同一套凭据（见 room.ts 的 cloudDatabase），
 * 但**表是分开的**：房间是"一局正在打的棋"，报告是"一局打完的结论"，
 * 两者的读写权限、清理节奏、谁能看都不一样，混在一张表里迟早出事。
 *
 * 这一层只干一件事：把一条报告塞进 `warchess_reports`。
 * 不做重试、不做队列、不偷偷在后台发——发不发是对局结束那一刻玩家的决定。
 *
 * 失败时必须说人话。最可能遇到的是"表还没建"：这时不要含糊成"网络不通"，
 * 那会让玩家以为是自己的网。所以错误按 code 分类，并给出下一步能做什么。
 */

import { REPORT_CONSENT_VERSION, reportSignature, type MatchReport } from '../core/report.ts';
import { campaignCode } from './campaign.ts';
import { clientId } from './client-id.ts';
import { cloudDatabase } from './room.ts';

const TABLE = 'warchess_reports';

export interface UploadResult {
  ok: boolean;
  /**
   * 云端已经有同一局了（跨设备 / 清了缓存又传一遍）。
   *
   * 对玩家来说这等于成功：数据在库里，不用再传。单独标出来是因为
   * "已存在"和"刚写进去"在排查时是两件不同的事。
   */
  duplicate?: boolean;
  /** 失败的具体原因，直接显示给玩家 */
  reason?: string;
  /** 失败后玩家能做的事（建表 / 核对域名 / 换个网络） */
  howTo?: string;
  /** 给玩家看的一句话结论（成功也带，比如"这局之前传过了"） */
  note?: string;
}

interface DbFailure {
  code?: string;
  message?: string;
}

function classify(err: DbFailure | undefined): UploadResult {
  // 云后端的错误码带前缀（实测是 DATABASE_23505 / DATABASE_P0001），
  // 直接拿 '23505' 去比永远比不上——先剥掉前缀再认。
  const code = (err?.code ?? '').replace(/^DATABASE_/, '');
  const msg = (err?.message ?? '').toLowerCase();

  // 表不存在：最常见的一种，而且一次建好就再也不出现
  if (code === '42P01' || /relation .*does not exist|undefined table|schema cache/.test(msg)) {
    return {
      ok: false,
      reason: '收集端还没开通（云数据库里没有 warchess_reports 这张表）',
      howTo: '在云数据库里执行一次 sql/warchess_reports.sql 就能开始收；没开通也不影响玩，报告可以复制或下载出来。',
    };
  }

  // 重传：跨设备去重靠的是 fingerprint 唯一索引，冲突就是"这局已经在库里了"
  if (code === '23505' || /duplicate key|unique constraint/.test(msg)) {
    return { ok: true, duplicate: true, note: '这局云端已经有了（换设备/清缓存后重传会自动认出）' };
  }

  // 限流：同一个浏览器代号一小时内传太多，触发器会拒
  if (/too many reports/.test(msg)) {
    return {
      ok: false,
      reason: '这一小时传得太频繁了，先歇一会儿',
      howTo: '限流是按浏览器算的，过一阵再传；报告还在，可以「复制 / 下载」。',
    };
  }

  // 凭据 / 域名不对：和联机面板那条自检是同一类事故
  if (code === '42501' || /permission denied|not authorized|invalid_client|origin/.test(msg)) {
    return {
      ok: false,
      reason: '服务端不接受这次上传（凭据或域名对不上）',
      howTo: '核对 src/net/cloud-config.ts 里的域名与密钥是不是当前发布的那一套。',
    };
  }

  return {
    ok: false,
    reason: `上传没成功：${err?.message ?? '网络不通'}`,
    howTo: '报告还在，可以「复制报告」或「下载 .json」，换个时间再试。',
  };
}

/**
 * 上传一条报告。
 *
 * 永远不抛：调用方是界面上的一个按钮，它需要的是"成功 / 为什么没成功"，
 * 而不是一个没人 catch 的 promise。
 */
export async function uploadReport(report: MatchReport): Promise<UploadResult> {
  try {
    const db = (await cloudDatabase()) as unknown as {
      from(name: string): {
        insert(row: Record<string, unknown>): PromiseLike<{ error?: DbFailure | null }>;
      };
    };

    // 列出来的是给人看的几个，整份报告再整块塞进 payload：
    // 以后加了字段，老表不用迁移也能把新数据存下来。
    const res = await db.from(TABLE).insert({
      // 只用于限流分组的随机代号（见 client-id.ts），不是身份
      client_id: clientId(),
      // 跨设备去重的键：种子+回合+胜负+双方终局+摘要规模
      fingerprint: reportSignature(report),
      // 批次码（邀请链接上的 ?campaign=）：只用来和某一批数据切割，不是身份
      campaign: campaignCode(),
      // 他同意的是哪一版说明——改文案必须换版本号，否则事后说不清
      consent: REPORT_CONSENT_VERSION,
      created_at: report.at,
      version: report.v,
      seed: report.seed,
      board_w: report.board.w,
      board_h: report.board.h,
      turns: report.turns,
      winner: report.winner,
      expansions: report.expansions,
      ai: report.ai,
      sides: report.sides,
      payload: report,
    });

    return res?.error ? classify(res.error) : { ok: true };
  } catch (err) {
    return classify(err as DbFailure);
  }
}

export const REPORT_TABLE = TABLE;
