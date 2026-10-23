-- v0.3.1. stability.sql 다음. 휴지통은 사용자 API에서 읽을 수 없고 72시간 뒤 서버가 정리한다.
begin;
do $$ begin
  if to_regprocedure('public.stability_schema_version()') is null then raise exception 'stability.sql_required'; end if;
  if to_regprocedure('public.maintenance_version()') is not null then raise exception 'maintenance_already_applied'; end if;
end $$;

create table public.maintenance_rollback (name text primary key, definition text not null);
alter table public.maintenance_rollback enable row level security;
revoke all on public.maintenance_rollback from public, anon, authenticated, service_role;
insert into public.maintenance_rollback
select p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('leave_room','save_visit_review');
insert into public.maintenance_rollback
select policyname, format('create policy %I on storage.objects for %s to authenticated using (%s)',policyname,lower(cmd),qual)
from pg_policies where schemaname='storage' and tablename='objects' and policyname in ('place photos select','place photos delete');

create table public.trash_jobs (
  id uuid primary key default gen_random_uuid(), kind text not null, target uuid not null,
  payload jsonb not null, paths text[] not null default '{}',
  created_at timestamptz not null default now(), purge_after timestamptz not null default now()+interval '3 days',
  attempts integer not null default 0, next_attempt timestamptz not null default now(),
  lease uuid, lease_until timestamptz, last_error text,
  constraint trash_jobs_kind check (kind in ('place','photo','visit','review','category','cup','room','leave','upload'))
);
create index trash_jobs_due on public.trash_jobs(purge_after,next_attempt);
alter table public.trash_jobs enable row level security;
revoke all on public.trash_jobs from public, anon, authenticated, service_role;

-- 삭제 대기 경로를 다시 등록하면 정리 작업이 활성 사진을 지울 수 있으므로 재사용 금지.
create function public.maintenance_guard_photo() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.trash_jobs where new.path=any(paths) or new.thumb_path=any(paths)) then
  raise exception 'photo_path_retired';
 end if;
 return new;
end $$;
revoke all on function public.maintenance_guard_photo() from public,anon,authenticated,service_role;
create trigger maintenance_guard_photo before insert or update of path,thumb_path on public.place_photos
for each row execute function public.maintenance_guard_photo();

create function public.maintenance_archive(p_kind text,p_target uuid,p_payload jsonb,p_paths text[] default '{}')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 insert into public.trash_jobs(kind,target,payload,paths) values(p_kind,p_target,p_payload,coalesce(p_paths,'{}')) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.maintenance_archive(text,uuid,jsonb,text[]) from public,anon,authenticated,service_role;

create function public.maintenance_place_snapshot(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object(
 'places',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.places p where id=any(p_ids)),
 'visits',(select coalesce(jsonb_agg(to_jsonb(v)),'[]') from public.visits v where place_id=any(p_ids)),
 'reviews',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.reviews r where place_id=any(p_ids)),
 'place_photos',(select coalesce(jsonb_agg(to_jsonb(ph)),'[]') from public.place_photos ph where place_id=any(p_ids)),
 'cup_results',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cup_results c where champion_id=any(p_ids) or runner_up_id=any(p_ids)))
$$;
revoke all on function public.maintenance_place_snapshot(uuid[]) from public,anon,authenticated,service_role;

create function public.maintenance_photo_paths(p_ids uuid[]) returns text[]
language sql stable security definer set search_path='' as $$
select coalesce(array_agg(distinct x.p),'{}'::text[]) from (
 select ph.path as p from public.place_photos ph where ph.place_id=any(p_ids)
 union all select ph.thumb_path from public.place_photos ph where ph.place_id=any(p_ids)
 union all select p.photo_path from public.places p where p.id=any(p_ids) and split_part(p.photo_path,'/',1)=p.id::text
) x where x.p is not null
$$;
revoke all on function public.maintenance_photo_paths(uuid[]) from public,anon,authenticated,service_role;

create function public.trash_item(p_kind text,p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_place uuid; v_room uuid; v_table text; v_row jsonb; v_payload jsonb; v_paths text[]:='{}';
begin
 if v_uid is null then raise exception 'not_authenticated'; end if;
 v_table:=case p_kind when 'place' then 'places' when 'photo' then 'place_photos' when 'visit' then 'visits'
  when 'review' then 'reviews' when 'category' then 'categories' when 'cup' then 'cup_results' else null end;
 if v_table is null then raise exception 'invalid_trash_kind'; end if;
 execute format('select to_jsonb(t) from public.%I t where id=$1',v_table) into v_row using p_id;
 if v_row is null then return false; end if;
 if p_kind in ('category','cup') then v_room:=(v_row->>'couple_id')::uuid;
 else
  v_place:=case when p_kind='place' then p_id else (v_row->>'place_id')::uuid end;
  select couple_id into v_room from public.places where id=v_place;
 end if;
 if not public.is_couple_member(v_room) then raise exception 'not_member'; end if;
 perform 1 from public.couples where id=v_room for update;
 if not public.is_couple_member(v_room) then raise exception 'not_member'; end if;
 if v_place is not null then perform 1 from public.places where id=v_place for update; end if;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for update',v_table) into v_row using p_id;
 if v_row is null then return false; end if;
 if p_kind='review' and (v_row->>'author_id')::uuid<>v_uid then raise exception 'not_author'; end if;
 if p_kind='cup' and (v_row->>'user_id')::uuid<>v_uid then raise exception 'not_author'; end if;
 if p_kind='visit' and exists(select 1 from public.reviews where visit_id=p_id and author_id<>v_uid) then raise exception 'other_reviews'; end if;
 v_payload:=jsonb_build_object(v_table,jsonb_build_array(v_row));
 if p_kind='place' then
  v_payload:=public.maintenance_place_snapshot(array[p_id]); v_paths:=public.maintenance_photo_paths(array[p_id]);
 elsif p_kind='photo' then
  v_paths:=array_remove(array[v_row->>'path',v_row->>'thumb_path'],null);
 elsif p_kind='visit' then
  v_payload:=v_payload||jsonb_build_object('reviews',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.reviews r where visit_id=p_id));
 elsif p_kind='category' then
  v_payload:=v_payload||jsonb_build_object('cup_results',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cup_results c where couple_id=v_room and category=v_row->>'name'));
 end if;
 perform public.maintenance_archive(p_kind,p_id,v_payload,v_paths);
 execute format('delete from public.%I where id=$1',v_table) using p_id;
 return true;
end $$;
revoke all on function public.trash_item(text,uuid) from public,anon;
grant execute on function public.trash_item(text,uuid) to authenticated;
revoke delete on public.places,public.place_photos,public.visits,public.reviews,public.categories,public.cup_results from authenticated;

create function public.trash_uploads(p_paths text[]) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_path text; v_place uuid; v_paths text[]:='{}';
begin
 if auth.uid() is null then raise exception 'not_authenticated'; end if;
 if cardinality(p_paths)>20 then raise exception 'invalid_paths'; end if;
 foreach v_path in array p_paths loop
  if v_path !~ '^[0-9a-f-]{36}/(t/)?[0-9a-f-]{32,36}\.jpg$' then raise exception 'invalid_paths'; end if;
  v_place:=split_part(v_path,'/',1)::uuid;
  perform 1 from public.places where id=v_place and public.is_couple_member(couple_id) for update;
  if not found then continue; end if;
  if not exists(select 1 from public.place_photos where path=v_path or thumb_path=v_path) then v_paths:=array_append(v_paths,v_path); end if;
 end loop;
 if cardinality(v_paths)>0 then perform public.maintenance_archive('upload',gen_random_uuid(),'{}',v_paths); end if;
 return true;
end $$;
revoke all on function public.trash_uploads(text[]) from public,anon;
grant execute on function public.trash_uploads(text[]) to authenticated;

drop policy "place photos select" on storage.objects;
create policy "place photos select" on storage.objects for select to authenticated
using(bucket_id='place-photos' and exists(select 1 from public.place_photos ph join public.places p on p.id=ph.place_id
 where (ph.path=objects.name or ph.thumb_path=objects.name) and public.is_couple_member(p.couple_id)));
drop policy "place photos delete" on storage.objects;

create function public.maintenance_claim() returns table(id uuid,lease uuid,paths text[])
language sql volatile security definer set search_path='' as $$
 with due as (select id from public.trash_jobs where purge_after<=now() and next_attempt<=now()
  and (lease_until is null or lease_until<now()) order by purge_after for update skip locked limit 1)
 update public.trash_jobs j set lease=gen_random_uuid(),lease_until=now()+interval '30 minutes',attempts=attempts+1
 from due where j.id=due.id returning j.id,j.lease,j.paths
$$;
create function public.maintenance_finish(p_id uuid,p_lease uuid,p_error text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if p_error is null then delete from public.trash_jobs where id=p_id and lease=p_lease;
 else update public.trash_jobs set last_error=left(p_error,60),lease=null,lease_until=null,
  next_attempt=now()+make_interval(secs=>least(3600,60*power(2,least(attempts,6))::int)) where id=p_id and lease=p_lease; end if;
 return found;
end $$;
create function public.maintenance_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('pending',count(*),'due',count(*) filter(where purge_after<=now()),
 'retrying',count(*) filter(where last_error is not null),'next_purge_at',min(purge_after)) from public.trash_jobs
$$;
create function public.maintenance_photo_active(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.place_photos where path=p_path or thumb_path=p_path)
$$;
create function public.save_shared_note(p_place uuid,p_body text,p_base text) returns boolean
language plpgsql security invoker set search_path='' as $$
begin
 if char_length(p_body)>2000 then raise exception 'invalid_note'; end if;
 update public.places set shared_note=p_body where id=p_place and shared_note is not distinct from p_base;
 if not found then raise exception 'note_changed'; end if;
 return true;
end $$;
revoke all on function public.save_shared_note(uuid,text,text) from public,anon;
grant execute on function public.save_shared_note(uuid,text,text) to authenticated;
create function public.maintenance_version() returns integer language sql stable set search_path='' as $$ select 1 $$;
revoke all on function public.maintenance_claim(),public.maintenance_finish(uuid,uuid,text),public.maintenance_status(),public.maintenance_photo_active(text),public.maintenance_version() from public,anon,authenticated;
grant execute on function public.maintenance_claim(),public.maintenance_finish(uuid,uuid,text),public.maintenance_status(),public.maintenance_photo_active(text),public.maintenance_version() to service_role;
create or replace function public.leave_room(p_couple uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_new_owner uuid;
  v_ids uuid[]; v_payload jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  perform 1 from public.couples where id = p_couple for update;
  if not found then
    raise exception 'not_member';
  end if;
  select role into v_role from public.couple_members where couple_id = p_couple and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member';
  end if;

  if not exists (select 1 from public.couple_members where couple_id = p_couple and user_id <> v_uid) then
    -- 방을 지우는 것은 begin_room_delete(15분 참여 막기)를 15분 안에 부른 뒤에만.
    -- 둘이 거의 동시에 나가서 혼자 남게 된 경우 등: 화면이 한 번 더 확인받도록 'last_member'로 돌려보냄
    if not exists (select 1 from public.couples where id = p_couple and deleting_at > now() - interval '15 minutes') then
      raise exception 'last_member';
    end if;
    -- categories, places(→ visits, reviews, place_photos), cup_results, couple_members가 같이 지워짐
    select coalesce(array_agg(id),'{}') into v_ids from public.places where couple_id=p_couple;
    v_payload:=public.maintenance_place_snapshot(v_ids)||jsonb_build_object(
      'couples',(select jsonb_agg(to_jsonb(c)) from public.couples c where id=p_couple),
      'couple_members',(select jsonb_agg(to_jsonb(m)) from public.couple_members m where couple_id=p_couple),
      'categories',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.categories c where couple_id=p_couple),
      'cup_results',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cup_results c where couple_id=p_couple));
    perform public.maintenance_archive('room',p_couple,v_payload,public.maintenance_photo_paths(v_ids));
    delete from public.couples where id = p_couple;
    return jsonb_build_object('room_deleted', true, 'new_owner', null);
  end if;

  perform public.maintenance_archive('leave',gen_random_uuid(),jsonb_build_object(
    'couple_members',(select jsonb_agg(to_jsonb(m)) from public.couple_members m where couple_id=p_couple and user_id=v_uid),
    'reviews',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.reviews r join public.places p on p.id=r.place_id where p.couple_id=p_couple and r.author_id=v_uid),
    'visits',(select coalesce(jsonb_agg(to_jsonb(v)),'[]') from public.visits v join public.places p on p.id=v.place_id where p.couple_id=p_couple and v.created_by=v_uid),
    'cup_results',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.cup_results c where couple_id=p_couple and user_id=v_uid)), '{}');
  -- 멤버 줄을 먼저 지움: 이 뒤로 시작하는 내 후기 쓰기는 RLS(멤버만)에서 막힘
  delete from public.couple_members where couple_id = p_couple and user_id = v_uid;

  -- 다른 방의 내 후기는 그대로 (이 방 장소만)
  delete from public.reviews r
  using public.places p
  where p.id = r.place_id and p.couple_id = p_couple and r.author_id = v_uid;

  -- 내가 만든 방문 중 후기가 하나도 안 남은 것만
  delete from public.visits v
  using public.places p
  where p.id = v.place_id and p.couple_id = p_couple and v.created_by = v_uid
    and not exists (select 1 from public.reviews r where r.visit_id = v.id);

  delete from public.cup_results where couple_id = p_couple and user_id = v_uid;

  if v_role = 'owner' then
    select m.user_id into v_new_owner
    from public.couple_members m
    where m.couple_id = p_couple
    order by m.created_at, m.user_id
    limit 1;
    update public.couple_members set role = 'owner' where couple_id = p_couple and user_id = v_new_owner;
  end if;

  return jsonb_build_object('room_deleted', false, 'new_owner', v_new_owner);
end;
$$;


drop function public.save_visit_review(uuid,date,uuid,numeric,text);
create function public.save_visit_review(p_place uuid,p_day date,p_visit uuid,p_rating numeric,p_body text,p_base jsonb default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_visit uuid;v_body text:=btrim(coalesce(p_body,''));v_old public.reviews%rowtype;v_day date;
begin
 if v_uid is null then raise exception 'not_authenticated'; end if;
 if p_day is null or char_length(v_body)>3000 then raise exception 'invalid_review'; end if;
 perform 1 from public.places where id=p_place and public.is_couple_member(couple_id) for update;
 if not found then raise exception 'not_member'; end if;
 if p_visit is not null then
  select id,visited_on into v_visit,v_day from public.visits where id=p_visit and place_id=p_place;
  if v_visit is null then raise exception 'visit_gone'; end if;
  if p_base is not null and p_base->>'day' is not null then
   if p_day::text=p_base->>'day' then p_day:=v_day;
   elsif v_day::text<>p_base->>'day' then raise exception 'visit_changed'; end if;
  end if;
 else
  insert into public.visits(place_id,visited_on,created_by) values(p_place,p_day,v_uid)
   on conflict(place_id,visited_on) do nothing returning id into v_visit;
  if v_visit is null then select id into v_visit from public.visits where place_id=p_place and visited_on=p_day; end if;
 end if;
 select * into v_old from public.reviews where visit_id=v_visit and author_id=v_uid;
 -- 새 입력칸의 빈 저장은 다른 기기에 있던 내 후기를 지우지 않는다.
 if p_visit is null and p_rating is null and v_body='' then return v_visit; end if;
 if p_base is not null and (coalesce(v_old.body,'')<>coalesce(p_base->>'body','') or coalesce(v_old.rating,0)<>coalesce((p_base->>'rating')::numeric,0)) then
  raise exception 'review_changed';
 end if;
 -- 후기와 같은 트랜잭션에서 날짜 변경. 같은 날 중복·후기 오류면 함께 되돌린다.
 update public.visits set visited_on=p_day where id=v_visit and visited_on is distinct from p_day;
 if p_rating is null and v_body='' then
  if v_old.id is not null then perform public.maintenance_archive('review',v_old.id,jsonb_build_object('reviews',jsonb_build_array(to_jsonb(v_old))),'{}'); end if;
  delete from public.reviews where visit_id=v_visit and author_id=v_uid;
 else
  insert into public.reviews(place_id,visit_id,author_id,rating,body) values(p_place,v_visit,v_uid,p_rating,v_body)
   on conflict(visit_id,author_id) do update set rating=excluded.rating,body=excluded.body;
 end if;
 return v_visit;
end $$;
revoke all on function public.save_visit_review(uuid,date,uuid,numeric,text,jsonb) from public,anon;
grant execute on function public.save_visit_review(uuid,date,uuid,numeric,text,jsonb) to authenticated;
commit;
notify pgrst,'reload schema';
