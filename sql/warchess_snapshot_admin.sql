-- 反馈快照：带口令的列表查询（2026-11-19）
--
-- 用途：开发者不在云数据库控制台时，也能在 App 里翻"最近 N 条反馈"。
--
-- 安全口径：
--   · 表本身仍然不给客户端任何读权限（RLS 不动）；
--   · 只有拿着口令调用这个函数才拿得到列表——口令错了返回空数组，不报错（不给爆破线索）；
--   · 只返回**摘要字段**，不返回整份 payload：反馈里可能有玩家的对局细节，
--     翻列表时不需要全部。

create or replace function public.warchess_snapshot_list(pin text, lim int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- 改这一行就换口令；留空字符串等于关闭这个入口
  expected constant text := 'chick-fish-2026';
begin
  if pin is null or pin <> expected or length(expected) = 0 then
    return '[]'::jsonb;
  end if;

  return coalesce(
    (
      select jsonb_agg(row_to_json(t)::jsonb)
      from (
        select id, created_at, build, turn, note,
               (payload->>'headline') as headline
        from public.warchess_snapshots
        order by id desc
        limit greatest(1, least(coalesce(lim, 30), 200))
      ) t
    ),
    '[]'::jsonb
  );
end;
$fn$;

grant execute on function public.warchess_snapshot_list(text, int) to anon, authenticated;
