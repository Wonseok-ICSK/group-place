-- Supabase 흉내 (PGlite 시험 전용, 운영 DB에는 절대 실행하지 않음)
-- 역할(anon·authenticated·service_role), auth 스키마(auth.users, auth.uid()), extensions 스키마의 pgcrypto,
-- storage 스키마(buckets, objects, foldername)만 schema.sql이 쓰는 만큼 만든다.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- Supabase처럼 public 스키마에 새로 만드는 표·함수·시퀀스를 세 역할에 기본으로 열어 둔다
-- (그래서 SQL 파일이 revoke를 빠뜨리면 시험에서 드러난다)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------- extensions ----------
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- ---------- auth ----------
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}'
);
-- PostgREST가 요청마다 넣는 JWT의 sub를 흉내: 시험은 set_config('request.jwt.claim.sub', <uuid>, true)로 넣는다
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- ---------- storage ----------
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  metadata jsonb -- Supabase처럼 { "size": <바이트>, … } (public_room_view가 사진 크기를 봄)
);
alter table storage.objects enable row level security;
grant select, insert, delete on storage.objects to authenticated;
grant all on storage.objects to service_role;
-- 'a/b/c.jpg' → {a,b} (마지막 조각인 파일 이름을 뺀 폴더들)
create function storage.foldername(name text) returns text[]
language sql immutable
as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
