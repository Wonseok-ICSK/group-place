-- v0.2.3: public.sql 다음에 실행. 사진 10장 제한 + 방문/후기 원자적 저장.
-- 기존 데이터는 지우지 않는다. 기존에 10장을 넘긴 장소는 사진을 줄여야 새 사진을 추가할 수 있다.
begin;

do $$ begin
  if to_regprocedure('public.public_rooms_version()') is null then
    raise exception 'public.sql_required';
  end if;
  if to_regprocedure('public.stability_schema_version()') is not null then
    raise exception 'stability.sql_already_applied';
  end if;
end $$;

create function public.enforce_place_photo_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 같은 장소의 동시 INSERT를 직렬화. 파일 수가 아니라 등록된 사진 행 수를 센다.
  perform 1 from public.places where id = new.place_id for update;
  if (select count(*) from public.place_photos where place_id = new.place_id) >= 10 then
    raise exception 'photo_limit';
  end if;
  return new;
end $$;
revoke all on function public.enforce_place_photo_limit() from public, anon, authenticated;
create trigger place_photos_enforce_limit before insert on public.place_photos
for each row execute function public.enforce_place_photo_limit();

-- SECURITY INVOKER: 기존 표 권한과 RLS를 그대로 적용한다.
create function public.save_visit_review(p_place uuid, p_day date, p_visit uuid, p_rating numeric, p_body text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_visit uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_day is null or char_length(v_body) > 3000 then raise exception 'invalid_review'; end if;
  -- 장소별 잠금: 같은 날 방문 생성과 같은 작성자의 재시도를 하나로 모은다.
  perform 1 from public.places where id = p_place for update;
  if not found then raise exception 'not_member'; end if;
  if p_visit is not null then
    select id into v_visit from public.visits where id = p_visit and place_id = p_place;
    if v_visit is null then raise exception 'visit_gone'; end if;
    update public.visits set visited_on = p_day where id = v_visit and visited_on is distinct from p_day;
  else
    insert into public.visits (place_id, visited_on, created_by)
      values (p_place, p_day, v_uid)
      on conflict (place_id, visited_on) do nothing returning id into v_visit;
    if v_visit is null then
      select id into v_visit from public.visits where place_id = p_place and visited_on = p_day;
    end if;
  end if;
  if p_rating is null and v_body = '' then
    delete from public.reviews where visit_id = v_visit and author_id = v_uid;
  else
    insert into public.reviews (place_id, visit_id, author_id, rating, body)
      values (p_place, v_visit, v_uid, p_rating, v_body)
      on conflict (visit_id, author_id) do update set rating = excluded.rating, body = excluded.body;
  end if;
  return v_visit;
end $$;
revoke all on function public.save_visit_review(uuid, date, uuid, numeric, text) from public, anon;
grant execute on function public.save_visit_review(uuid, date, uuid, numeric, text) to authenticated;

create function public.stability_schema_version() returns integer
language sql stable set search_path = '' as $$ select 1 $$;
revoke all on function public.stability_schema_version() from public, anon, authenticated;
grant execute on function public.stability_schema_version() to service_role;
commit;

notify pgrst, 'reload schema';
