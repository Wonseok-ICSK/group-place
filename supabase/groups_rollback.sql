-- groups.sql 되돌리기: 예전 규칙(한 사람 한 방, 한 방 2명, 2명이 차면 초대 코드 폐기)으로 돌아감.
-- 순서: 홈 서버를 이전 릴리스로 먼저 되돌림(새 화면·서버는 groups.sql이 있어야 동작) → 이 SQL 실행.
-- 두 개 이상의 방에 든 사람이 있으면 멈춤(한 사람 한 방 제약을 다시 걸 수 없음). 한 방만 남기고 나간 뒤 다시 실행하세요.
-- 지우기 전 멤버 색은 backup 스키마(backup.couple_members_colors_<시각>)에 복사해 둠.
-- 남는 것: 3~5명이 된 방은 그대로 남음(예전 함수로는 새로 못 들어올 뿐). 방 이름·장소·후기 등 데이터는 그대로.
-- create_couple, join_couple, join_couple_for, space_code_open 본문은 schema.sql·friends-signup.sql 내용 그대로 되돌림.
-- 권한은 friends-signup.sql을 적용한 뒤 상태(join_couple은 앱에서 못 부름).
-- 후기 고치기 정책과 places.photo_path 고치기 권한도 schema.sql 그대로 되돌림.
-- 다시 적용하려면 groups.sql을 그대로 실행하면 됨.

begin;

do $$
declare
  v_n integer;
begin
  if to_regclass('public.member_colors') is null then
    raise exception '되돌릴 것이 없어요 (member_colors 표가 없음).';
  end if;
  select count(*) into v_n
  from (select user_id from public.couple_members group by user_id having count(*) > 1) x;
  if v_n > 0 then
    raise exception '여러 방에 들어간 사람이 %명 있어서 되돌릴 수 없어요. 한 방만 남기고 나간 뒤 다시 실행하세요.', v_n;
  end if;
  create schema if not exists backup;
  execute format('create table backup.%I as select couple_id, user_id, color from public.couple_members',
                 'couple_members_colors_' || to_char(now() at time zone 'Asia/Seoul', 'YYYYMMDD_HH24MISS'));
end $$;

-- ---------- 새로 만든 것 지우기 ----------
drop trigger if exists couple_members_enforce_caps on public.couple_members;
drop function if exists public.rename_room(uuid, text);
drop function if exists public.set_member_color(uuid, text);
drop function if exists public.begin_room_delete(uuid);
drop function if exists public.leave_room(uuid);
drop function if exists public.groups_schema_version();
drop function if exists public.pick_member_color(uuid);
drop function if exists public.enforce_member_caps();

alter table public.couple_members drop constraint if exists couple_members_couple_color_key;
drop index if exists public.couple_members_one_owner;
alter table public.couple_members drop constraint if exists couple_members_display_name_check;
alter table public.couples drop constraint if exists couples_name_check;

alter table public.couple_members drop column if exists color;
alter table public.couples drop column if exists deleting_at;
drop table public.member_colors;
drop index if exists public.couple_members_user_idx;

alter table public.couple_members add constraint couple_members_one_couple_per_user unique (user_id);

-- ---------- 예전 함수 본문 (schema.sql) ----------
create or replace function public.create_couple(p_display_name text, p_couple_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if exists (select 1 from public.couple_members where user_id = v_uid) then
    raise exception 'already_in_couple';
  end if;

  insert into public.couples (name, created_by, invite_code)
  values (
    coalesce(nullif(trim(p_couple_name), ''), '우리의 장소 기록'),
    v_uid,
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  )
  returning id into v_couple;

  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'owner', coalesce(trim(p_display_name), ''));

  insert into public.categories (couple_id, name, position)
  select v_couple, d.name, d.ord
  from unnest(array['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타']) with ordinality as d (name, ord);

  return v_couple;
end;
$$;

create or replace function public.join_couple(p_invite_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if exists (select 1 from public.couple_members where user_id = v_uid) then
    raise exception 'already_in_couple';
  end if;

  -- 동시에 두 명이 참여하는 경우를 막기 위해 행 잠금
  select id into v_couple
  from public.couples
  where invite_code = upper(trim(p_invite_code))
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 2 then
    raise exception 'couple_full';
  end if;

  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', coalesce(trim(p_display_name), ''));

  -- 두 사람이 모두 들어왔으니 초대 코드 폐기
  update public.couples set invite_code = null where id = v_couple;

  return v_couple;
end;
$$;

-- ---------- 예전 함수 본문 (friends-signup.sql) ----------
-- 공간 초대 코드(8자리)로 가입할 수 있는지 미리 확인: 코드가 있고 멤버가 2명 미만이면 true.
create or replace function public.space_code_open(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couples c
    where c.invite_code = upper(trim(p_code))
      and (select count(*) from public.couple_members m where m.couple_id = c.id) < 2
  );
$$;

-- 공간 코드로 참여: join_couple(schema.sql)과 같은 규칙(최대 2명, 다 차면 초대 코드 폐기)으로 p_user를 넣는다.
-- 홈 서버가 횟수를 센 뒤에만 부른다. join_couple 본문을 고치면 이것도 같이 고친다.
create or replace function public.join_couple_for(p_user uuid, p_invite_code text, p_display_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user;
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if exists (select 1 from public.couple_members where user_id = v_uid) then
    raise exception 'already_in_couple';
  end if;

  -- 동시에 두 명이 참여하는 경우를 막기 위해 행 잠금
  select id into v_couple
  from public.couples
  where invite_code = upper(trim(p_invite_code))
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 2 then
    raise exception 'couple_full';
  end if;

  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', coalesce(trim(p_display_name), ''));

  -- 두 사람이 모두 들어왔으니 초대 코드 폐기
  update public.couples set invite_code = null where id = v_couple;

  return v_couple;
end;
$$;

-- ---------- 권한 (friends-signup.sql 적용 뒤와 같게) ----------
revoke all on function public.create_couple(text, text) from public, anon;
grant execute on function public.create_couple(text, text) to authenticated;
revoke all on function public.join_couple(text, text) from public, anon, authenticated;
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated;
grant execute on function public.join_couple_for(uuid, text, text) to service_role;
revoke all on function public.space_code_open(text) from public, anon, authenticated;
grant execute on function public.space_code_open(text) to service_role;

-- ---------- 정책·열 권한 (schema.sql 그대로) ----------
drop policy if exists "Authors can update own reviews" on public.reviews;
create policy "Authors can update own reviews" on public.reviews for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
grant update (photo_path) on public.places to authenticated;

-- 예전 규칙: 멤버가 2명 이상인 방은 초대 코드가 없음
update public.couples c
set invite_code = null
where (select count(*) from public.couple_members m where m.couple_id = c.id) >= 2;

commit;
