-- colors.sql 되돌리기: 예전 40색(groups.sql)과 예전 set_member_color·pick_member_color로 돌아감.
-- 순서: 홈 서버를 이전 릴리스(v0.1.1 화면)로 먼저 되돌림 → 이 SQL 실행. groups_rollback.sql까지 되돌릴 때는 이 파일을 먼저.
-- 지금 멤버 색(직접 고른 색 포함)은 backup 스키마(backup.couple_colors_v012_<시각>)에 복사해 둠.
-- 멤버 색은 예전 40색 중 가장 가까운 색으로 옮김: 방마다 방장 → 들어온 순서로, 선명한 20색 중 색상각(OKLCH hue)이
-- 가장 가까운 색(방 안에서 겹치면 다음으로 가까운 색). 회색에 가까운 직접 고른 색(채도 0.03 미만)은 OKLab 거리로 가장 가까운 색.
-- colors.sql을 적용하기 전 색을 정확히 되살리려면 backup.couple_colors_v011_<시각> 표를 쓰면 됨(그사이 바뀐 멤버는 주의).
-- 다시 적용하려면 colors.sql을 그대로 실행하면 됨.

begin;

-- 예전 40색 (groups.sql 순서). light는 화면 v0.1.1의 밝은 화면 값으로, 가장 가까운 색을 고를 때만 씀
create temp table _gp_old_colors (id text primary key, position smallint not null, light text not null) on commit drop;
insert into _gp_old_colors (id, position, light) values
  ('orange', 1, '#d76f05'), ('tangerine', 2, '#c97801'), ('amber', 3, '#bd7a05'), ('mustard', 4, '#a48904'),
  ('olive', 5, '#8f900d'), ('lime', 6, '#73970b'), ('green', 7, '#459d2e'), ('emerald', 8, '#0f9f5c'),
  ('jade', 9, '#119d7c'), ('teal', 10, '#0e8c86'), ('cyan', 11, '#0a9aa1'), ('sky', 12, '#0698b2'),
  ('azure', 13, '#0296c5'), ('blue', 14, '#0091e4'), ('cobalt', 15, '#4b89f2'), ('indigo', 16, '#7281f4'),
  ('violet', 17, '#9079ef'), ('purple', 18, '#a971e3'), ('orchid', 19, '#be6ad1'), ('pink', 20, '#d362b2'),
  ('orange-deep', 21, '#8d561e'), ('tangerine-deep', 22, '#875913'), ('amber-deep', 23, '#7c5f08'),
  ('mustard-deep', 24, '#6e640d'), ('olive-deep', 25, '#5d681c'), ('lime-deep', 26, '#4a6c2d'),
  ('green-deep', 27, '#346f3e'), ('emerald-deep', 28, '#13714e'), ('jade-deep', 29, '#027060'),
  ('teal-deep', 30, '#106e6c'), ('cyan-deep', 31, '#126d78'), ('sky-deep', 32, '#076c86'),
  ('azure-deep', 33, '#186994'), ('blue-deep', 34, '#36659a'), ('cobalt-deep', 35, '#4b619d'),
  ('indigo-deep', 36, '#5d5c9c'), ('violet-deep', 37, '#6d5898'), ('purple-deep', 38, '#7a5490'),
  ('orchid-deep', 39, '#855084'), ('pink-deep', 40, '#904d71');

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'member_colors' and column_name = 'light') then
    raise exception '되돌릴 것이 없어요 (member_colors.light 칸이 없음).';
  end if;
  -- backup과 옮기기가 한 시점의 데이터를 보게 먼저 잠금 (그사이 직접 고른 색을 저장하면 backup에 안 남고 사라질 수 있음)
  lock table public.couple_members, public.member_colors in access exclusive mode;
  create schema if not exists backup;
  execute format('create table backup.%I as select couple_id, user_id, color from public.couple_members',
                 'couple_colors_v012_' || to_char(now() at time zone 'Asia/Seoul', 'YYYYMMDD_HH24MISS'));
end $$;

-- ---------- 색 칸 되돌리기 ----------
alter table public.couple_members drop constraint couple_members_palette_color_fkey;
alter table public.couple_members drop column palette_color;
alter table public.couple_members drop constraint couple_members_color_check;
-- 새 id와 예전 id가 겹치므로 먼저 'new:'를 붙여 비켜 둠
update public.couple_members set color = 'new:' || color;

-- 방마다 방장 → 들어온 순서로 가장 가까운 예전 색 (그 방에서 이미 누가 받은 색은 건너뜀)
do $$
declare
  r record;
  v_hex text;
  v_old text;
begin
  for r in
    select m.couple_id, m.user_id,
           coalesce(c.light, substr(m.color, 5)) as hex  -- 팔레트 id면 그 색의 밝은 화면 값, 직접 고른 색이면 그 값
    from public.couple_members m
    left join public.member_colors c on 'new:' || c.id = m.color
    order by m.couple_id, (m.role = 'owner') desc, m.created_at, m.user_id
  loop
    v_hex := r.hex;
    if v_hex is null or v_hex !~ '^#[0-9a-f]{6}$' then
      v_hex := '#808080'; -- 있을 수 없는 값(제약으로 막힘)이지만 혹시 있으면 회색으로 보고 고름
    end if;
    select o.id into v_old
    from _gp_old_colors o
    where not exists (select 1 from public.couple_members x where x.couple_id = r.couple_id and x.color = o.id)
    order by
      case when sqrt(power((public.member_color_lab(v_hex))[2], 2) + power((public.member_color_lab(v_hex))[3], 2)) < 0.03
           then public.member_color_delta(v_hex, o.light) end,   -- 회색에 가까우면 OKLab 거리
      o.position > 20,                                            -- 그 밖에는 선명한 20색 먼저
      public.member_color_hue_gap(v_hex, o.light),                -- 색상각이 가까운 순
      public.member_color_delta(v_hex, o.light),
      o.position
    limit 1;
    update public.couple_members set color = v_old where couple_id = r.couple_id and user_id = r.user_id;
  end loop;
end $$;

-- ---------- 예전 색 목록 ----------
delete from public.member_colors;
alter table public.member_colors drop constraint member_colors_id_check;
alter table public.member_colors drop constraint member_colors_light_check;
alter table public.member_colors drop constraint member_colors_dark_check;
alter table public.member_colors drop column light;
alter table public.member_colors drop column dark;
alter table public.member_colors add constraint member_colors_id_check check (id ~ '^[a-z]+(-deep)?$');
insert into public.member_colors (id, position) select id, position from _gp_old_colors order by position;
alter table public.couple_members
  add constraint couple_members_color_fkey foreign key (color) references public.member_colors (id);

-- ---------- 예전 함수 본문 (groups.sql 그대로) ----------
-- 그 방에서 아무도 안 쓰는 색 하나를 무작위로 (내부 전용)
create or replace function public.pick_member_color(p_couple uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_color text;
begin
  select c.id into v_color
  from public.member_colors c
  where not exists (select 1 from public.couple_members m where m.couple_id = p_couple and m.color = c.id)
  order by random()
  limit 1;
  if v_color is null then
    raise exception 'no_free_color'; -- 5명·40색이라 실제로는 안 남
  end if;
  return v_color;
end;
$$;

-- 내 색 바꾸기: 그 방에서 아무도 안 쓰는 색만. 저장된 색 id를 돌려줌
-- (앱에는 color 칸 update 권한이 없어서 이 함수로만 바꿈)
create or replace function public.set_member_color(p_couple uuid, p_color text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_now text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select color into v_now from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_now is null then
    raise exception 'not_member';
  end if;
  if p_color is null or not exists (select 1 from public.member_colors where id = p_color) then
    raise exception 'invalid_color';
  end if;
  if v_now = p_color then
    return v_now;
  end if;
  if exists (select 1 from public.couple_members where couple_id = p_couple and color = p_color) then
    raise exception 'color_taken';
  end if;
  begin
    update public.couple_members set color = p_color where couple_id = p_couple and user_id = v_uid;
  exception when unique_violation then
    raise exception 'color_taken';
  end;
  return p_color;
end;
$$;

-- 색 계산 함수는 colors.sql에서만 씀
drop function public.member_color_distance(text, text);
drop function public.member_color_fills(text);
drop function public.member_color_hue_gap(text, text);
drop function public.member_color_delta(text, text);
drop function public.member_color_lab(text);

-- ---------- 권한 (groups.sql 그대로) ----------
revoke all on function public.set_member_color(uuid, text) from public, anon;
grant execute on function public.set_member_color(uuid, text) to authenticated;
revoke all on function public.pick_member_color(uuid) from public, anon, authenticated;

commit;
