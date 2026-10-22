-- public.sql 되돌리기: 공개 방 기능을 빼고 colors.sql까지 적용한 상태로 돌아감.
-- 순서: 홈 서버를 이전 릴리스(v0.1.2 화면·서버)로 먼저 되돌림 → 이 SQL 실행. (새 화면은 couples.visibility 등을 읽으므로
--   SQL만 되돌리면 앱이 깨짐. 새 서버도 시작할 때 public_rooms_version을 확인하므로 가입·참여가 꺼짐)
-- 공개 방은 개인 방이 됨(더 비공개인 쪽이라 안전). 장소·사진·후기·멤버는 그대로. 공개 키·소개·숨김 시각과 동의 기록은 지워짐.
-- 지우기 전 backup 스키마에 복사해 둠:
--   backup.public_rooms_v020_<시각>        공개 방(id, name, public_key, description, public_hidden_at)
--   backup.public_room_acks_v020_<시각>    동의 기록 표 전체
--   backup.place_photo_thumbs_v020_<시각>  썸네일 경로(id, place_id, thumb_path). 저장소의 썸네일 파일은 SQL로 못 지우므로
--                                         이 표의 경로로 나중에 Storage API(또는 대시보드)에서 지움
-- join_couple_for·begin_room_delete 본문은 groups.sql 그대로, 사진 저장소 정책 세 개는 schema.sql 그대로 되돌림.
-- 다시 적용하려면 public.sql을 그대로 실행하면 됨.

begin;

do $$
declare
  v_at text := to_char(now() at time zone 'Asia/Seoul', 'YYYYMMDD_HH24MISS');
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'couples' and column_name = 'visibility') then
    raise exception 'public.sql이 적용되지 않았어요.';
  end if;
  -- backup과 지우기가 한 시점의 데이터를 보게 먼저 잠금 (그사이 공개 방 만들기·사진 올리기는 끝날 때까지 기다림)
  lock table public.couples, public.place_photos, public.public_room_acks in access exclusive mode;
  create schema if not exists backup;
  execute format('create table backup.%I as select id, name, public_key, description, public_hidden_at
                  from public.couples where visibility = ''public''', 'public_rooms_v020_' || v_at);
  execute format('create table backup.%I as select id, couple_id, user_id, kind, version, acked_at
                  from public.public_room_acks', 'public_room_acks_v020_' || v_at);
  execute format('create table backup.%I as select id, place_id, thumb_path
                  from public.place_photos where thumb_path is not null', 'place_photo_thumbs_v020_' || v_at);
end $$;

-- ---------- 새로 만든 것 지우기 ----------
drop trigger if exists couples_freeze_visibility on public.couples;
drop trigger if exists couples_public_text on public.couples;
drop trigger if exists couple_members_public_nickname on public.couple_members;
drop function if exists public.create_room(text, text, text, text, integer);
drop function if exists public.public_create_status();
drop function if exists public.set_room_description(uuid, text);
drop function if exists public.regenerate_invite_code(uuid);
drop function if exists public.join_room_for(uuid, text, text, integer);
drop function if exists public.space_code_info(text);
drop function if exists public.public_room_list();
drop function if exists public.public_room_view(text);
drop function if exists public.admin_set_room_hidden(text, boolean);
drop function if exists public.admin_public_rooms();
drop function if exists public.public_rooms_version();
drop function if exists public.public_ack_version();
drop function if exists public.public_room_activity(uuid);
drop function if exists public.public_login_id(uuid);
drop function if exists public.public_text_ok(text);
drop function if exists public.public_nick_key(text);
drop function if exists public.couples_public_text();
drop function if exists public.couples_freeze_visibility();
drop function if exists public.enforce_public_nickname();

drop table public.public_room_acks;

alter table public.place_photos drop constraint if exists place_photos_thumb_path_key;
alter table public.place_photos drop constraint if exists place_photos_thumb_path_check;
alter table public.place_photos drop column if exists thumb_path;

alter table public.couples drop constraint if exists couples_public_key_key;
alter table public.couples drop constraint if exists couples_public_key_match;
alter table public.couples drop constraint if exists couples_public_key_check;
alter table public.couples drop constraint if exists couples_description_check;
alter table public.couples drop constraint if exists couples_visibility_check;
alter table public.couples drop column if exists public_hidden_at;
alter table public.couples drop column if exists public_key;
alter table public.couples drop column if exists description;
alter table public.couples drop column if exists visibility;

-- ---------- 예전 함수 본문 (groups.sql 그대로) ----------
-- 방 코드로 참여 (홈 서버가 횟수를 센 뒤 secret key로 부름).
-- 코드를 먼저 확인하므로 too_many_rooms·room_full도 "코드가 맞았다"는 뜻(서버는 이것도 시도로 셈).
-- 이미 그 방 멤버면 아무것도 안 바꾸고 그 방 id를 돌려줌(같은 요청을 다시 보내도 안전). 초대 코드는 지우지 않음.
create or replace function public.join_couple_for(p_user uuid, p_invite_code text, p_display_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user;
  v_display text := btrim(p_display_name);
  v_couple uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_display is null or char_length(v_display) not between 1 and 20 then
    raise exception 'invalid_display_name';
  end if;

  -- ① 사람 잠금 → ② 방 잠금 (지우는 중인 방은 15분 동안 코드가 없는 것처럼)
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || v_uid::text, 0));

  select id into v_couple
  from public.couples
  where invite_code = upper(btrim(p_invite_code))
    and (deleting_at is null or deleting_at <= now() - interval '15 minutes')
  for update;

  if v_couple is null then
    raise exception 'invalid_code';
  end if;

  if exists (select 1 from public.couple_members where couple_id = v_couple and user_id = v_uid) then
    return v_couple;
  end if;

  if (select count(*) from public.couple_members where user_id = v_uid) >= 3 then
    raise exception 'too_many_rooms';
  end if;

  if (select count(*) from public.couple_members where couple_id = v_couple) >= 5 then
    raise exception 'room_full';
  end if;

  -- 색은 트리거가 그 방의 빈 색으로 무작위
  insert into public.couple_members (couple_id, user_id, role, display_name)
  values (v_couple, v_uid, 'member', v_display);

  return v_couple;
end;
$$;

-- 마지막 멤버가 방을 지우기 전: 사진 파일 경로를 모두 돌려주고 15분 동안 새 참여를 막음.
-- (사진 파일은 SQL로 못 지워서 화면이 Storage API로 먼저 지운 뒤 leave_room을 부름)
create or replace function public.begin_room_delete(p_couple uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_paths text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id = v_uid) then
    raise exception 'not_member';
  end if;
  if exists (select 1 from public.couple_members where couple_id = p_couple and user_id <> v_uid) then
    raise exception 'not_last_member';
  end if;

  update public.couples set deleting_at = now() where id = p_couple;

  -- 사진 표(place_photos)의 경로 + 예전 사진 칸(places.photo_path).
  -- place_photos.path는 제약으로 '<장소 id>/…'만 들어가지만 photo_path는 아무 글이나 들어갈 수 있었으므로
  -- 그 장소 폴더 안의 경로만 돌려줌(다른 방 사진 경로를 넣어 두고 마지막 멤버가 지우게 하는 것을 막음)
  select coalesce(array_agg(x.path order by x.path), '{}') into v_paths
  from (
    select ph.path
    from public.place_photos ph
    join public.places p on p.id = ph.place_id
    where p.couple_id = p_couple
    union
    select p.photo_path
    from public.places p
    where p.couple_id = p_couple and p.photo_path is not null
      and split_part(p.photo_path, '/', 1) = p.id::text
  ) x;
  return v_paths;
end;
$$;

-- ---------- 사진 저장소 정책 (schema.sql 그대로) ----------
drop policy "place photos select" on storage.objects;
drop policy "place photos insert" on storage.objects;
drop policy "place photos delete" on storage.objects;
create policy "place photos select" on storage.objects for select to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));
create policy "place photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'place-photos'
              and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));
create policy "place photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));

-- ---------- 권한 (groups.sql 그대로) ----------
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated;
grant execute on function public.join_couple_for(uuid, text, text) to service_role;
revoke all on function public.begin_room_delete(uuid) from public, anon;
grant execute on function public.begin_room_delete(uuid) to authenticated;

commit;
