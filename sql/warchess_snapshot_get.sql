-- 反馈快照：按 id 读单条（2026-11-19）
--
-- 为什么需要它：快照表只给了 insert 策略，客户端读不到任何一条，
-- 于是"反馈上传成功"和"开发者能看到"之间断了一截。
--
-- 设计取舍：**不知道 id 就查不到**（不是全表可读），id 由上传成功后显示给玩家。
-- 这样既让开发者能按编号定位，也不至于把所有人的反馈摊开在任何拿到 anon key 的人面前。

create or replace function public.warchess_snapshot_get(sid bigint)
returns jsonb
language sql
security definer
set search_path = public
as $fn$
  select to_jsonb(s)
  from public.warchess_snapshots s
  where s.id = sid
  limit 1;
$fn$;

grant execute on function public.warchess_snapshot_get(bigint) to anon, authenticated;
