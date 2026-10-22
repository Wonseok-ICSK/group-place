-- 우리의 장소 기록: 전체 DB 구조 (2026-10-15 기준, 운영 DB에서 그대로 뽑음)
-- 새 Supabase 프로젝트라면 이 파일 하나만 SQL Editor에서 실행하면 됩니다.
-- 날짜가 붙은 다른 파일들은 기존 DB에 적용했던 변경 기록이고, 내용은 이미 여기에 들어 있습니다.
-- 구조를 바꿀 때는 날짜 붙은 변경 파일을 새로 만들고 이 파일도 같이 고쳐 주세요.

-- ---------- 표 ----------
create table public.couples (
  id uuid not null default gen_random_uuid(),
  name text not null default '우리의 장소 기록',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  invite_code text,
  constraint couples_pkey primary key (id),
  constraint couples_invite_code_key unique (invite_code)
);

create table public.couple_members (
  couple_id uuid not null references public.couples (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  display_name text not null default '',
  constraint couple_members_pkey primary key (couple_id, user_id),
  constraint couple_members_one_couple_per_user unique (user_id),
  constraint couple_members_role_check check (role in ('owner', 'member'))
);

-- 공간마다 두 사람이 함께 쓰는 카테고리. '전체'는 목록 필터 이름이라 못 씀
create table public.categories (
  id uuid not null default gen_random_uuid(),
  couple_id uuid not null references public.couples (id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint categories_pkey primary key (id),
  constraint categories_couple_name_key unique (couple_id, name),
  constraint categories_name_check check (name = trim(name) and char_length(name) between 1 and 20 and name <> '전체')
);

-- category는 카테고리 이름으로 연결: 이름을 바꾸면 장소도 같이 바뀌고, 쓰는 장소가 있으면 카테고리를 못 지움
create table public.places (
  id uuid not null default gen_random_uuid(),
  couple_id uuid not null references public.couples (id) on delete cascade,
  name text not null,
  address text,
  category text not null default '기타',
  naver_url text,
  status text not null default 'want_to_go',
  favorite boolean not null default false,
  shared_note text not null default '',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  photo_path text, -- 예전 사진 한 장 칸. v1.5부터 안 씀(사진은 place_photos), 되돌리기용으로 남김
  constraint places_pkey primary key (id),
  constraint places_status_check check (status in ('want_to_go', 'visited')),
  constraint places_category_fkey foreign key (couple_id, category) references public.categories (couple_id, name) on update cascade
);

-- 한 장소에 여러 번 방문. 같은 장소·같은 날 방문은 하나
create table public.visits (
  id uuid not null default gen_random_uuid(),
  place_id uuid not null references public.places (id) on delete cascade,
  visited_on date not null default current_date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  constraint visits_pkey primary key (id),
  constraint visits_place_day_key unique (place_id, visited_on),
  -- 후기의 (visit_id, place_id)가 같은 장소의 방문을 가리키도록 묶는 용도
  constraint visits_id_place_key unique (id, place_id)
);

-- 방문 하나에 한 사람이 후기 하나. 별점은 0.5 ~ 5, 0.5 단위
create table public.reviews (
  id uuid not null default gen_random_uuid(),
  place_id uuid not null references public.places (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  rating numeric(2,1),
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  visit_id uuid not null,
  constraint reviews_pkey primary key (id),
  constraint reviews_visit_author_key unique (visit_id, author_id),
  constraint reviews_visit_fkey foreign key (visit_id, place_id) references public.visits (id, place_id) on delete cascade,
  constraint reviews_rating_check check (rating >= 0.5 and rating <= 5 and rating * 2 = trunc(rating * 2))
);

-- 명예의 전당: 끝낸 장소 월드컵 결과. 사람·연도·카테고리마다 하나 (다시 하면 덮어씀)
-- year 비움 = 전체 기간(역대), category 비움 = 전체 카테고리(종합).
-- 장소를 지워도 기록은 남고(이름 보관), 카테고리 이름을 바꾸면 따라 바뀌고, 카테고리를 지우면 같이 지워짐
create table public.cup_results (
  id uuid not null default gen_random_uuid(),
  couple_id uuid not null references public.couples (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  year smallint,
  category text,
  champion_id uuid references public.places (id) on delete set null,
  champion_name text not null,
  runner_up_id uuid references public.places (id) on delete set null,
  runner_up_name text not null,
  candidates smallint not null,
  played_at timestamptz not null default now(),
  constraint cup_results_pkey primary key (id),
  constraint cup_results_one_per_cup unique nulls not distinct (couple_id, user_id, year, category),
  constraint cup_results_category_fkey foreign key (couple_id, category)
    references public.categories (couple_id, name) on update cascade on delete cascade,
  constraint cup_results_year_check check (year between 1 and 9999),
  constraint cup_results_candidates_check check (candidates >= 2),
  constraint cup_results_places_check check (champion_id <> runner_up_id),
  constraint cup_results_names_check check (char_length(champion_name) between 1 and 200 and char_length(runner_up_name) between 1 and 200)
);

-- 장소 사진 (여러 장). 순서(position)가 가장 앞인 사진이 대표 사진(목록 썸네일).
-- 파일 경로는 "<place_id>/<파일명>" (사진 저장소 권한이 장소 폴더 기준이라 그 밖은 막음)
create table public.place_photos (
  id uuid not null default gen_random_uuid(),
  place_id uuid not null references public.places (id) on delete cascade,
  path text not null,
  position integer not null default 0,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  constraint place_photos_pkey primary key (id),
  constraint place_photos_path_key unique (path),
  constraint place_photos_path_check check (split_part(path, '/', 1) = place_id::text and char_length(path) <= 300)
);
create index place_photos_place_idx on public.place_photos (place_id, position);

-- ---------- 함수 ----------
-- RLS에서 쓰는 멤버 확인. couple_members 자체의 RLS를 다시 타지 않도록 security definer.
create or replace function public.is_couple_member(target_couple_id uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.couple_members m
    where m.couple_id = target_couple_id
      and m.user_id = (select auth.uid())
  );
$$;

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

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reviews_touch_updated_at
  before update on public.reviews
  for each row execute function public.touch_updated_at();

-- ---------- 권한 ----------
-- 로그아웃 상태(anon)는 아무것도 못 함. 로그인 사용자도 고칠 수 있는 칸만 칸별로 허용.
revoke all on public.couples, public.couple_members, public.categories, public.places, public.visits, public.reviews, public.cup_results, public.place_photos from anon, authenticated;

grant select on public.couples to authenticated;
grant select on public.couple_members to authenticated;
grant update (display_name) on public.couple_members to authenticated;
grant select, insert, delete on public.categories to authenticated;
grant update (name, position) on public.categories to authenticated;
grant select, insert, delete on public.places to authenticated;
grant update (name, address, category, naver_url, status, favorite, shared_note, photo_path) on public.places to authenticated;
grant select, insert, delete on public.visits to authenticated;
grant update (visited_on) on public.visits to authenticated;
grant select, insert, delete on public.reviews to authenticated;
grant update (rating, body) on public.reviews to authenticated;
grant select, insert, delete on public.cup_results to authenticated;
-- 다시 한 월드컵은 upsert로 덮어써서 보낸 칸을 모두 다시 씀. 남의 기록·다른 공간으로는 RLS가 막음
grant update (couple_id, user_id, year, category, champion_id, champion_name, runner_up_id, runner_up_name, candidates, played_at)
  on public.cup_results to authenticated;
grant select, insert, delete on public.place_photos to authenticated;
grant update (position) on public.place_photos to authenticated;

revoke all on function public.is_couple_member(uuid) from public, anon;
revoke all on function public.create_couple(text, text) from public, anon;
revoke all on function public.join_couple(text, text) from public, anon;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
grant execute on function public.is_couple_member(uuid) to authenticated;
grant execute on function public.create_couple(text, text) to authenticated;
grant execute on function public.join_couple(text, text) to authenticated;

-- ---------- RLS ----------
alter table public.couples enable row level security;
alter table public.couple_members enable row level security;
alter table public.categories enable row level security;
alter table public.places enable row level security;
alter table public.visits enable row level security;
alter table public.reviews enable row level security;
alter table public.cup_results enable row level security;
alter table public.place_photos enable row level security;

create policy "Members can view their couples" on public.couples for select to authenticated
  using (public.is_couple_member(id));

create policy "Members can view membership" on public.couple_members for select to authenticated
  using (public.is_couple_member(couple_id));
create policy "Members can update own name" on public.couple_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Members can view categories" on public.categories for select to authenticated
  using (public.is_couple_member(couple_id));
create policy "Members can add categories" on public.categories for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy "Members can update categories" on public.categories for update to authenticated
  using (public.is_couple_member(couple_id))
  with check (public.is_couple_member(couple_id));
create policy "Members can delete categories" on public.categories for delete to authenticated
  using (public.is_couple_member(couple_id));

create policy "Members can view places" on public.places for select to authenticated
  using (public.is_couple_member(couple_id));
create policy "Members can add places" on public.places for insert to authenticated
  with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "Members can update places" on public.places for update to authenticated
  using (public.is_couple_member(couple_id))
  with check (public.is_couple_member(couple_id));
create policy "Members can delete places" on public.places for delete to authenticated
  using (public.is_couple_member(couple_id));

-- 방문 지우기는 상대 후기가 없는 방문만 (내 후기만 있거나 빈 방문)
create policy "Members can view visits" on public.visits for select to authenticated
  using (exists (select 1 from public.places p where p.id = visits.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can add visits" on public.visits for insert to authenticated
  with check (created_by = (select auth.uid())
              and exists (select 1 from public.places p where p.id = visits.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can update visits" on public.visits for update to authenticated
  using (exists (select 1 from public.places p where p.id = visits.place_id and public.is_couple_member(p.couple_id)))
  with check (exists (select 1 from public.places p where p.id = visits.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can delete visits without partner reviews" on public.visits for delete to authenticated
  using (exists (select 1 from public.places p where p.id = visits.place_id and public.is_couple_member(p.couple_id))
         and not exists (select 1 from public.reviews r where r.visit_id = visits.id and r.author_id <> (select auth.uid())));

create policy "Members can view reviews" on public.reviews for select to authenticated
  using (exists (select 1 from public.places p where p.id = reviews.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can add own reviews" on public.reviews for insert to authenticated
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.places p where p.id = reviews.place_id and public.is_couple_member(p.couple_id)));
create policy "Authors can update own reviews" on public.reviews for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
create policy "Authors can delete own reviews" on public.reviews for delete to authenticated
  using (author_id = (select auth.uid()));

-- 월드컵 기록: 같은 공간이면 보고, 자기 기록만 저장·덮어쓰기·삭제. 1위·준우승 장소는 같은 공간 장소만
create policy "Members can view cup results" on public.cup_results for select to authenticated
  using (public.is_couple_member(couple_id));
create policy "Members can add own cup results" on public.cup_results for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.is_couple_member(couple_id)
              and (champion_id is null or exists (select 1 from public.places p where p.id = cup_results.champion_id and p.couple_id = cup_results.couple_id))
              and (runner_up_id is null or exists (select 1 from public.places p where p.id = cup_results.runner_up_id and p.couple_id = cup_results.couple_id)));
create policy "Members can replace own cup results" on public.cup_results for update to authenticated
  using (user_id = (select auth.uid()) and public.is_couple_member(couple_id))
  with check (user_id = (select auth.uid())
              and public.is_couple_member(couple_id)
              and (champion_id is null or exists (select 1 from public.places p where p.id = cup_results.champion_id and p.couple_id = cup_results.couple_id))
              and (runner_up_id is null or exists (select 1 from public.places p where p.id = cup_results.runner_up_id and p.couple_id = cup_results.couple_id)));
create policy "Members can delete own cup results" on public.cup_results for delete to authenticated
  using (user_id = (select auth.uid()));

-- 장소 사진: 같은 공간 멤버면 누구든 보고, 올리고(올린 사람은 자기), 순서 바꾸고, 지움
create policy "Members can view place photos" on public.place_photos for select to authenticated
  using (exists (select 1 from public.places p where p.id = place_photos.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can add place photos" on public.place_photos for insert to authenticated
  with check (created_by = (select auth.uid())
              and exists (select 1 from public.places p where p.id = place_photos.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can reorder place photos" on public.place_photos for update to authenticated
  using (exists (select 1 from public.places p where p.id = place_photos.place_id and public.is_couple_member(p.couple_id)))
  with check (exists (select 1 from public.places p where p.id = place_photos.place_id and public.is_couple_member(p.couple_id)));
create policy "Members can delete place photos" on public.place_photos for delete to authenticated
  using (exists (select 1 from public.places p where p.id = place_photos.place_id and public.is_couple_member(p.couple_id)));

-- ---------- 사진 저장소 ----------
-- 비공개 버킷, 5MB 제한. 파일 경로는 "<place_id>/<파일명>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('place-photos', 'place-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- 그 장소를 볼 수 있는 사람(= places RLS를 통과한 커플 멤버)만 접근.
-- 주의: 하위 쿼리 안에서는 places.name(장소 이름)과 겹치므로 반드시 objects.name 으로 씀.
create policy "place photos select" on storage.objects for select to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));
create policy "place photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'place-photos'
              and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));
create policy "place photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'place-photos'
         and exists (select 1 from public.places p where p.id::text = (storage.foldername(objects.name))[1]));
