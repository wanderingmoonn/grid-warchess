-- 玩家上传的地图库（上帝模式 → 地图工坊）
--
-- 什么时候要执行这个文件：想让大家能互相玩到对方画的地图时，一次性执行。
-- 不执行也不影响玩：内置地图照常可选，上传按钮会明说"地图库还没开通"。
--
-- 和 warchess_reports 的区别（别照抄那张表的权限）：
--   · 报告表是"只写不读"，谁都能交，没人能顺着它把别人的东西拉下来；
--   · 这张表是"公开读、公开写"——它的存在意义就是给别人用。
-- 所以安全边界不放在权限上，放在**校验**上：客户端只认
-- `validateFixedMap` 放行的数据，一份坏图最多是"列表里点不动"，不会被执行。
--
-- 只存地形与城位。没有任何脚本、URL 或可执行内容。

create table if not exists public.warchess_maps (
  id          bigserial   primary key,
  created_at  timestamptz not null default now(),
  name        text        not null,
  author      text,
  w           smallint    not null,
  h           smallint    not null,
  -- 地形：每行一个字符串（'.' 平原 / 'f' 森林 / 'h' 丘陵 / '~' 水 / '^' 山 / '=' 桥）
  rows        jsonb       not null,
  -- 城位：只存左上角，边长由局内设置决定
  cities_a    jsonb       not null,
  cities_b    jsonb       not null,
  -- 留着以后做"隐藏某张图"的余地；列表只查 true
  listed      boolean     not null default true
);

create index if not exists warchess_maps_created_idx
  on public.warchess_maps (created_at desc);

alter table public.warchess_maps enable row level security;

-- 读：只给列出来的那些
drop policy if exists warchess_maps_read on public.warchess_maps;
create policy warchess_maps_read on public.warchess_maps
  for select using (listed);

-- 写：谁都能交一张。形状校验在客户端做（见 src/core/fixed-maps.ts），
-- 这里只挡明显不成立的尺寸，免得一条脏数据把列表撑爆。
drop policy if exists warchess_maps_insert on public.warchess_maps;
create policy warchess_maps_insert on public.warchess_maps
  for insert with check (w between 8 and 40 and h between 8 and 40 and length(name) between 1 and 24);

grant select, insert on public.warchess_maps to anon, authenticated;
grant usage, select on sequence public.warchess_maps_id_seq to anon, authenticated;
