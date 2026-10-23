# 공개 방 설계와 API 계약 (v0.2.0)

현재 앱은 **V0.2.3**이다. 공개 방의 기본 계약은 이 문서를 유지하고, 사진 중계는 V0.2.1 보완을 따른다.
최신 빌드·사진 10장 DB 제한·원자적 방문/후기 저장·`/readyz`와 추가 SQL은 [V0.2.3 릴리스](release-v0.2.3.md)가 우선한다.

작성 2026-10-22. 대상: `docs/plan.md` 결정 12–14(공개 방)와 `docs/ideation-public-rooms.md`의 추천 범위, 그리고 그 문서 맨 위 **최종 결정**.
최종 결정이 아이디어 문서 본문과 다르면 최종 결정을 따른다. 현재 버전은 `APP_VERSION = 'v0.2.3-261023-<무작위 소문자 16진수 5자>'`(배포 때 다시 만듦).

이 문서는 병렬로 일하는 빌더(SQL·서버·화면·가짜 Supabase·시험·문서)가 같이 지키는 **계약**이다. 마지막의 [API 계약](#9-api-계약-요약)이 기준이고,
본문은 이유와 세부 동작을 적는다. 계약을 바꿔야 하면 이 문서부터 고친다.

**검토 반영 (2026-10-22)**: 빌드 뒤 검토에서 나온 것을 고쳐 이 문서에 맞췄다. 지도 링크는 아는 지도 주소만(§3.5), 방 응답의 썸네일은 장소마다 대표 하나 +
상세에서 `/thumbs`(§3.3·§3.6), 같은 사람이 같은 썸네일을 다시 받으면 세지 않음(§3.6), 토큰 없는 요청은 횟수 제한 전에 401(§3.4), 사진은 무작위 파일 이름·작은 파일만(§2.6·§3.5),
마지막 활동은 날짜 수 대신 `week|month|older`(§2.6), 공개 방 이름·소개·닉네임의 보이지 않는 글자·방향 글자 금지와 전각 아이디 막기(§2.3), 화면 정적 시험(§6.3), 담기의 빈 방 단추(§4.8).

용어: 표 이름(`couples`, `couple_members`)은 그대로 둔다. 화면 문구는 **방 / 멤버 / 방장 / 닉네임**. "방장" = `couple_members.role = 'owner'`.
"둘러보는 사람" = 그 방 멤버가 아닌 로그인 사용자(또는 "방문자에게 보이는 모습"으로 자기 방을 보는 멤버). "공개 키" = `couples.public_key`(보기 링크용, 초대 코드와 다름).

---

## 0. 최종 결정 요약 (이 설계가 지키는 것)

| # | 결정 | 이 설계에서 |
|---|---|---|
| 1 | 둘러보는 사람의 상세 화면은 멤버 상세와 **같은 배치**(읽기 전용). 주소 복사·지도 버튼을 키우지 않음 | §4.6. 같은 `detailView`에 `readOnly`만 더함 |
| 2 | **내 방에 담기** v0.2.0. 방 고르기(하나여도 확인), 기본 "가고 싶은 곳", 메모 "‘<공개 방 이름>’에서 담음", 사진·방문·후기·찜은 안 옮김 | §4.8. 앱이 대상 방에 평소처럼 insert(RLS 그대로) |
| 3 | 보기는 **로그인한 사람만**. 나중에 서버 설정으로 넓힐 수 있게 | §3.2·§3.9, §10 "누구나 보기로 넓히려면" |
| 4 | 돋보기 세 군데 | §4.3 |
| 5 | **찜은 비공개, 메모(`shared_note`)는 공개**, 방문 날짜는 월까지 | §2.6 허용 목록, §5 |
| 6 | 공개 방 한도(방장인 공개 방 1개, 7일 간격(지운 방 포함), 전체 30개). **초대 코드는 읽기 전용 화면·공개 API 어디에도 없음**(시험) | §2.5 `create_room`, §6 시험 P8·S6·C3·M4 |
| 7 | 방장의 **"초대 코드 다시 만들기"**(모든 방, 확인 창, 예전 코드 즉시 무효). 내보내기·방장 넘기기 없음 | §2.5 `regenerate_invite_code`, §4.10 |
| 8 | 스스로 공개 중단, 신고 버튼은 **만들지 않음** | §7 범위 밖 |
| 9 | 관리자 숨기기(`public_hidden_at`)와 끄기 스위치(`PUBLIC_ROOMS`)는 둠 | §2.2, §3.7, `deploy/home/public.sh` |

---

## 1. 지금 상태 (확인한 사실, v0.1.2 / main f27e06d)

| 항목 | 지금 | 근거 |
|---|---|---|
| `couples` 권한 | 앱(authenticated)은 select만(정책: 멤버만). insert·update 권한 없음 → 방 행은 함수로만 바뀐다 | schema.sql |
| 초대 코드 | `couples.invite_code` 8자리 대문자 16진수, 멤버면 행 전체를 읽음(코드 포함) | schema.sql, groups.sql |
| 방 만들기 | `create_couple(p_display_name, p_couple_name)` → uuid, 개인 방 하나 | groups.sql |
| 참여 | 앱 → `POST /api/join` → `join_couple_for(p_user, p_invite_code, p_display_name)`(service_role). 순서: 코드 → 이미 멤버 → **too_many_rooms → room_full** | groups.sql, signup.cjs |
| 가입 미리 확인 | `space_code_open(p_code) → boolean` | groups.sql |
| 사진 경로 | `<place_id>/<Date.now()>-<i>.jpg` (업로드 시각이 드러남), 썸네일 없음, 목록도 1080px 원본 | index.html `addPhotos` |
| 저장소 정책 | select/insert/delete 모두 "그 장소 행이 보이는지"만 확인(places RLS에 기댐) | schema.sql |
| 방 지우기 | `begin_room_delete` → 사진 경로(`place_photos.path` + 장소 폴더 안 `photo_path`) | groups.sql |
| 서버 화면 상수 | `SIGNUP_ENABLED`를 secret key 확인 뒤 true로 바꾼 화면으로 갈아 끼움 | server.cjs |
| 서버 경로 | 정해진 파일만(`/`, `/index.html`, `/manifest.json`, `/og.png`, `/icons/*`) + `/api/place|signup|join` + `/healthz` | server.cjs |
| 서비스 | `ProtectSystem=strict`라 쓸 수 있는 폴더가 없음 | our-places.service |
| 찜 | 메인 탭 하나(`fav`), 목록 카드 하트, 상세 하트(`toggle-fav`) | index.html |
| 상세 | 주소는 글자만(복사 버튼 없음), 지도 링크 하나, 머리 오른쪽에 하트 + "정보 수정" | index.html `detailView` |

---

## 2. DB 변경: `supabase/public.sql` (+ `supabase/public_rollback.sql`)

### 2.1 적용 조건과 형태

- 실행 순서: `schema.sql` → `friends-keepalive.sql` → `friends-signup.sql` → `groups.sql` → `colors.sql` → **`public.sql`**. SQL Editor에서 한 번.
- 파일 전체 `begin; … commit;`. 맨 위 주석은 기존 파일 말투(무엇을, 실행 순서, 설계 문서 §, 되돌리기 파일, "바뀌는 것" 목록, 잠금 순서).
- 맨 앞 `do $$ … $$` 사전 확인(한국어 `raise exception`):
  1. `member_colors.light` 칸이 있어야 함 — 아니면 "먼저 supabase/colors.sql을 실행하세요."
  2. `couples.visibility` 칸이 없어야 함 — 아니면 "이미 적용된 SQL이에요 (couples.visibility 칸이 있음)."
  3. `extensions.gen_random_bytes(integer)`가 있어야 함(기존 문구 그대로).
- 기존 방은 모두 개인 방이 된다(기본값). 기존 행은 바뀌는 값이 없다.
- 잠금 순서(교착 방지): ① 사람 잠금 `pg_advisory_xact_lock(hashtextextended('group-place:member:' || uid, 0))` → ② 공개 방 만들기 잠금 `pg_advisory_xact_lock(hashtextextended('group-place:public-create', 0))`(공개 방을 만들 때만) → ③ 방 잠금(`couples … for update`). 반대 순서는 없다.

### 2.2 표·칸 변경

```sql
-- couples
alter table public.couples
  add column visibility text not null default 'private',
  add column description text not null default '',
  add column public_key text,
  add column public_hidden_at timestamptz;          -- 관리자 숨기기. 앱에는 바꿀 권한 없음(couples update 권한이 원래 없음)
alter table public.couples
  add constraint couples_visibility_check check (visibility in ('private', 'public')),
  add constraint couples_description_check check (description = btrim(description) and char_length(description) <= 60
                                                  and (visibility = 'public' or description = '')),
  add constraint couples_public_key_check check (public_key ~ '^[a-km-np-z2-9]{10}$'),
  add constraint couples_public_key_match check ((visibility = 'public') = (public_key is not null)),
  add constraint couples_public_key_key unique (public_key);   -- null은 여러 개 가능

-- 공개 범위와 공개 키는 바꿀 수 없다 (service_role·SQL Editor도. 바꾸려면 트리거를 지워야 함)
create function public.couples_freeze_visibility() returns trigger … -- before update
  -- new.visibility is distinct from old.visibility → raise 'visibility_immutable'
  -- new.public_key is distinct from old.public_key → raise 'public_key_immutable'
create trigger couples_freeze_visibility before update on public.couples
  for each row execute function public.couples_freeze_visibility();

-- 사진 썸네일 (320px JPEG). 경로 '<place_id>/t/<무작위>.jpg'
alter table public.place_photos add column thumb_path text;
alter table public.place_photos
  add constraint place_photos_thumb_path_check check (thumb_path is null or (
    split_part(thumb_path, '/', 1) = place_id::text and split_part(thumb_path, '/', 2) = 't'
    and char_length(thumb_path) <= 300)),
  add constraint place_photos_thumb_path_key unique (thumb_path);
-- 앱의 place_photos 권한은 표 단위 insert(새 칸 포함)·update(position)만이라 썸네일 경로는 넣을 때만 정함

-- 동의 기록: 나가도, 방이 지워져도 남김(방 FK 없음). 생성 간격(7일) 확인에도 씀. service_role만
create table public.public_room_acks (
  id bigint generated always as identity,
  couple_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  version smallint not null,
  acked_at timestamptz not null default now(),
  constraint public_room_acks_pkey primary key (id),
  constraint public_room_acks_kind_check check (kind in ('create', 'join')),
  constraint public_room_acks_version_check check (version >= 1)
);
create index public_room_acks_user_idx on public.public_room_acks (user_id, kind, acked_at desc);
alter table public.public_room_acks enable row level security;            -- 정책 없음
revoke all on public.public_room_acks from public, anon, authenticated;
```

`public_key` 글자 모음: `abcdefghijkmnpqrstuvwxyz23456789`(32자, l·o·0·1 뺌) 10자 = 50비트. 초대 코드(대문자 16진수 8자)와 글자 모음·길이가 달라서 서로 헷갈리거나
같은 값이 될 수 없다. 만들기: `extensions.gen_random_bytes(10)`의 바이트마다 `% 32`(256이 32로 나눠떨어져 고르게).

### 2.3 닉네임 = 로그인 아이디 막기, 못 쓰는 글자 (공개 방만)

```sql
-- 공개 방에서: 못 쓰는 글자가 든 닉네임은 'invalid_display_name',
-- 닉네임이 로그인 아이디와 같으면(public_nick_key로 비교) 'nickname_is_login_id'.
-- 아이디 = auth.users.raw_app_meta_data->>'username', 없으면 이메일 @ 앞부분
create function public.enforce_public_nickname() returns trigger …  -- security definer, search_path ''
create trigger couple_members_public_nickname
  before insert or update of display_name on public.couple_members
  for each row execute function public.enforce_public_nickname();
-- 공개 방의 방 이름·소개에 못 쓰는 글자가 있으면 'invalid_room_name' / 'invalid_description'
create function public.couples_public_text() returns trigger …      -- security definer, search_path ''
create trigger couples_public_text
  before insert or update of name, description on public.couples
  for each row execute function public.couples_public_text();
```

- **못 쓰는 글자**(`public_text_ok`): 제어 문자(U+0001–001F, 007F–009F), 보이지 않는 글자(U+200B·200C·2060–2064·FEFF), 글자 방향을 바꾸는 글자
  (U+200E·200F·202A–202E·2066–2069). 둘러보기 목록에서 남의 방처럼 꾸미거나(방향 뒤집기) 아이디를 숨겨 넣는 것을 막는다. U+200D(이모지 잇기)는 이모지 닉네임에 쓰여서 허용.
  홈 서버 `signup.cjs` `cleanDisplayName`(가입 닉네임, 모든 방)과 화면 `BAD_TEXT_RE`(방 만들기·참여·이름·소개·닉네임 폼)가 같은 모음을 쓴다(정적 시험이 비교).
- **닉네임 = 아이디 비교**(`public_nick_key`): NFKC로 바꾸고(전각 `ｍｉｎｊｉ９２` → `minji92`) 보이지 않는 글자(U+200D 포함)를 지운 뒤 앞뒤 공백을 빼고 소문자.
  서버 가입 미리 확인(`nickKey`)과 화면 확인도 같은 방식.
- 개인 방은 검사하지 않는다(지금 쓰는 사람에게 영향 없음). 함수(`create_room`, `join_room_for`)도 같은 확인을 먼저 해서 순서대로 오류를 낸다(§2.5).
  `create_room`·`rename_room`·`set_room_description`은 모두 `couples_public_text` 트리거를 지난다.

### 2.4 저장소 정책 강화

`place photos select|insert|delete` 세 정책을 지우고 같은 이름으로 다시 만든다. 조건에 `public.is_couple_member(p.couple_id)`를 직접 넣는다:

```sql
using (bucket_id = 'place-photos'
       and exists (select 1 from public.places p
                   where p.id::text = (storage.foldername(objects.name))[1]
                     and public.is_couple_member(p.couple_id)))
```

썸네일 `<place_id>/t/<파일>`도 `foldername(...)[1]`이 장소 id라 같은 정책을 탄다. 지금은 places RLS 덕에 결과가 같지만,
나중에 places select를 넓히는 실수를 해도 사진을 올리거나 지울 수 없게 한다.

### 2.5 함수 (정확한 이름·인자·반환·오류)

공통: `language plpgsql`(짧은 것은 `sql`), `security definer`, `set search_path = ''`, 이름은 모두 `public.`/`auth.`/`extensions.`를 붙여 씀.
오류는 `raise exception '<코드>'`(PostgREST가 400 + `message = '<코드>'`). 이름 정리는 `btrim`. 상수: 방장 공개 방 1개, 간격 7일, 전체 30개, 소개 60자, 동의 문구 버전 1.

| 함수 | 부르는 쪽 | 반환 | 하는 일 | 오류 코드 (확인 순서) |
|---|---|---|---|---|
| `public_ack_version()` | 앱·서버 | `integer` (1) | 지금 동의 문구 버전. `language sql immutable` | — |
| `public_rooms_version()` | 서버 | `integer` (1) | 이 SQL이 적용됐는지(서버 시작 확인). 표를 읽지 않음 | — |
| `create_room(p_display_name text, p_room_name text, p_visibility text, p_description text, p_ack_version integer)` | 앱 | `uuid` | 개인/공개 방 만들기. 인자 기본값 없음(PostgREST 겹침 방지). 공개면 `public_key`·방장 동의 기록(`kind 'create'`)을 같이 저장. 카테고리 8개는 `create_couple`과 같음 | `not_authenticated` → `too_many_rooms` → `invalid_room_name` → `invalid_display_name` → `invalid_visibility` → `invalid_description`(60자 초과, 개인 방인데 비어 있지 않음) → (공개만) `invalid_room_name`·`invalid_description`·`invalid_display_name`(못 쓰는 글자, §2.3) → `nickname_is_login_id` → `ack_required`(`p_ack_version`이 지금 버전과 다름) → `public_owner_limit` → `public_create_gap` → `public_rooms_full` |
| `public_create_status()` | 앱 | `jsonb` §2.6 | 지금 공개 방을 만들 수 있는지(화면이 공개 카드를 회색으로 둘지). DB는 `create_room`에서 다시 확인 | `not_authenticated` |
| `set_room_description(p_couple uuid, p_description text)` | 앱 | `text` 저장된 소개 | 공개 방 소개 바꾸기(방장만, 앞뒤 공백 제거, null은 `''`). 멤버인지 먼저 보고 방을 잠금(`set_member_color`와 같은 방식) | `not_authenticated` → `not_member` → `description_owner_only` → `not_public` → `invalid_description`(60자 초과, 못 쓰는 글자는 트리거) |
| `regenerate_invite_code(p_couple uuid)` | 앱 | `text` 새 코드 | 방장만, 모든 방. 8자리 대문자 16진수 새 코드(예전 코드와 다르게, 겹치면 다시 뽑음). 예전 코드는 그 순간부터 `invalid_code` | `not_authenticated` → `not_member` → `invite_owner_only` |
| `join_room_for(p_user uuid, p_invite_code text, p_display_name text, p_ack_version integer)` | 서버 | `jsonb` §2.6 | 새 서버의 참여(개인·공개 모두). 공개 방이면 동의 확인 후 동의 기록(`kind 'join'`) | `not_authenticated` → `invalid_display_name` → (사람 잠금, 방 잠금) `invalid_code` → (이미 멤버면 `already_member` 반환) → `room_full` → `too_many_rooms` → (공개만) `invalid_display_name`(못 쓰는 글자) → `nickname_is_login_id` → (공개만, 동의 없음) `need_ack` **반환**(raise 아님, 아무것도 안 바꿈) |
| `space_code_info(p_code text)` | 서버 | `jsonb` §2.6 | 가입 전 미리 확인(계정 만들기 전). 공개 방이고 열려 있을 때만 방 이름을 돌려줌 | — |
| `public_room_list()` | 서버 | `jsonb` 배열 §2.6 | 둘러보기 목록(최대 50) | — |
| `public_room_view(p_key text)` | 서버 | `jsonb` 또는 `null` §2.6 | 방 하나의 허용 목록 JSON(사진 경로 포함, 서버가 서명 뒤 경로를 지움). 없음·개인·숨김·지우는 중이면 `null` | — |
| `admin_set_room_hidden(p_key text, p_hidden boolean)` | 관리자 스크립트 | `boolean` 그 키의 공개 방이 있으면 true(없는 키·null 인자는 false) | `public_hidden_at = now()`(이미 숨겼으면 시각 그대로) / `null` | — |
| `admin_public_rooms()` | 관리자 스크립트 | `table (key text, name text, hidden_at text, members integer, places integer, created_at text)` | 공개 방 목록(시각은 KST 문자열) | — |

**바뀌는 기존 함수** (이름·인자 그대로, `create or replace`):

| 함수 | 바뀌는 점 |
|---|---|
| `join_couple_for` | 공개 방 코드면(이미 멤버가 아닐 때, `too_many_rooms`·`room_full` 확인 뒤) `raise exception 'ack_required'`. 옛 서버가 공개 방에 동의 없이 넣지 못하게. 개인 방은 그대로 |
| `begin_room_delete` | 돌려주는 경로에 `place_photos.thumb_path`(null 빼고)를 더함. 나머지 그대로 |
| `create_couple`, `space_code_open`, `leave_room` | **바꾸지 않음**. `create_couple`은 늘 개인 방(캐시된 옛 화면도 안전). 동의 기록은 나가도 남음 |

**내부 함수**(트리거·위 함수 안에서만 씀, `public, anon, authenticated` 모두에서 회수): `public_login_id(p_user uuid) → text`(소문자 로그인 아이디:
`raw_app_meta_data->>'username'`, 없으면 이메일 @ 앞부분), `public_room_activity(p_couple uuid) → timestamptz`(§2.6의 마지막 활동 시각, 목록과 방 JSON이 같이 씀),
`public_text_ok(text) → boolean`·`public_nick_key(text) → text`(§2.3), 트리거 함수 `couples_freeze_visibility`·`couples_public_text`·`enforce_public_nickname`. 되돌리기가 모두 지운다.

`create_room` 세부:
- 사람 잠금 → (공개면) 공개 방 만들기 잠금 → 한도 확인 → `couples` insert(`visibility`, `description`(개인 방은 `''`), `invite_code`, `public_key`).
  `unique_violation`이면 두 값을 다시 뽑아 되풀이(최대 10번, 그래도 안 되면 `raise exception 'retry'`).
- `p_visibility`는 `'private' | 'public'`만. 개인 방이면 `p_description`은 null 또는 `''`만 받고 `p_ack_version`은 보지 않는다.
- 한도: `public_owner_limit` = 내가 방장이고 `visibility = 'public'`인 방이 이미 있음(지우는 중인 방도 셈). `public_create_gap` = 내 `kind = 'create'` 동의 기록 중 7일 안의 것이 있음
  (방을 지워도 기록이 남아 지운 방도 셈). `public_rooms_full` = `visibility = 'public'`인 방이 30개 이상(숨김·지우는 중 포함).
- 방장 멤버 insert(색은 트리거), 카테고리 8개, (공개면) `public_room_acks (couple_id, user_id, 'create', p_ack_version)`.

`join_room_for` 세부: 방 찾기는 `invite_code = upper(btrim(p_invite_code)) and (deleting_at is null or deleting_at <= now() - interval '15 minutes') for update`.
`room_full`을 `too_many_rooms`보다 먼저 본다(groups.sql의 `join_couple_for`와 순서가 다름. 계약: 코드 → 이미 멤버 → 방 참 → 내 방 3개 → 동의).
멤버 insert는 기존 트리거(5명·3방·색)를 그대로 탄다.

### 2.6 JSON 모양 (정확한 키)

**`public_create_status()`**
```json
{ "allowed": true, "reason": null, "next_at": null, "ack_version": 1 }
{ "allowed": false, "reason": "public_create_gap", "next_at": "2026-10-29T03:00:00+00:00", "ack_version": 1 }
```
`reason`: `null | "too_many_rooms" | "public_owner_limit" | "public_create_gap" | "public_rooms_full"`(이 순서로 첫 번째). `next_at`은 `public_create_gap`일 때만(마지막 생성 기록 + 7일).

**`join_room_for(...)`**
```json
{ "status": "joined",         "couple_id": "<uuid>", "public": true }
{ "status": "already_member", "couple_id": "<uuid>", "public": false }
{ "status": "need_ack",       "couple_id": null,     "public": true, "room_name": "서울 라멘 지도", "ack_version": 1 }
```

**`space_code_info(p_code)`**
```json
{ "open": false, "public": false, "room_name": null, "ack_version": 1 }
{ "open": true,  "public": false, "room_name": null, "ack_version": 1 }
{ "open": true,  "public": true,  "room_name": "서울 라멘 지도", "ack_version": 1 }
```
`open` = `space_code_open`과 같은 뜻(코드 있음, 5명 미만, 지우는 중 아님).

**`public_room_list()`** — 배열, 원소 키는 정확히 이 9개:
```json
[{ "key": "k7m2p9xa4c", "name": "서울 라멘 지도", "description": "함께 가 본 서울 라멘집",
   "member_count": 2, "colors": ["teal", "#8b5e3c"],
   "place_count": 32, "visited_count": 18, "review_count": 41, "active": "week" }]
```
- 조건: `visibility = 'public'`, `public_hidden_at is null`, `(deleting_at is null or deleting_at <= now() - interval '15 minutes')`, 장소 1곳 이상.
- `colors`: 지금 멤버 색, 들어온 순서(`created_at`, `user_id`). `review_count`: 그 방 장소의 `reviews` 행 수.
- `active` = 마지막 활동이 언제쯤인지 묶음만: d = KST 오늘 날짜 − KST 마지막 활동 날짜일 때 `d < 7` → `"week"`, `d < 31` → `"month"`, 그 밖 `"older"`.
  날짜 수(예전 `active_days_ago`)를 보내면 "어제 활동"과 방문한 달로 방문한 날이 드러나서(방문 날짜는 월까지만, 최종 결정 5) 묶음으로 바꿨다. 마지막 활동 = `greatest(couples.created_at, max(places.created_at), max(visits.created_at), max(reviews.updated_at), max(place_photos.created_at))`.
- 정렬: 마지막 활동 시각 내림차순 → `key`. 최대 50개.

**`public_room_view(p_key)`** — 키가 형식에 안 맞거나 조건(목록과 같음, 단 장소 0곳이어도 보임)에 안 맞으면 `null`. 키는 정확히:
```json
{ "v": 1, "key": "k7m2p9xa4c", "name": "서울 라멘 지도", "description": "…",
  "member_count": 2, "place_count": 32, "truncated": false, "active": "week",
  "members": [{ "m": "m1", "name": "민수", "color": "teal" }, { "m": "m2", "name": "지훈", "color": "#8b5e3c" }],
  "categories": ["맛집", "카페", "기타"],
  "places": [{
    "id": "<장소 uuid>", "name": "멘야 하나", "category": "맛집", "address": "서울 …", "map_url": "https://naver.me/…",
    "status": "visited", "shared_note": "토요일 11시 오픈런", "added_month": "2026-09", "added_by": "m1",
    "visits": [{ "month": "2026-10", "reviews": [{ "by": "m2", "rating": 4.5, "body": "국물이 진함" }] }],
    "photo_count": 5,
    "photos": [{ "path": "<장소 id>/<파일>", "thumb": "<장소 id>/t/<파일>" }]
  }]
}
```
- `members`: 지금 멤버만, 들어온 순서로 `m1`–`m5`(응답 안에서만 쓰는 번호). 방장 표시 없음. 나간 사람은 목록에 없고 그 사람이 담은 장소·후기는 `by: null`/`added_by: null`("예전 멤버").
- `categories`: `categories.position, created_at` 순 이름.
- `places`: 최대 300곳. 정렬 = `greatest(p.created_at, max(visits.created_at), max(reviews.updated_at))` 내림차순 → `id`. `truncated` = 300곳 넘음.
- `address`·`map_url`은 null 가능(`map_url` = `places.naver_url`). `added_month` = `to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM')`.
- `visits`: `visited_on desc, created_at desc`. `month` = `to_char(visited_on, 'YYYY-MM')`. `reviews`: 멤버 들어온 순서 → 나머지(`by: null`) 뒤. `rating`은 숫자 또는 null.
- `photos`: 순서(`position, created_at, id`)로 **앞의 3장만**, `photo_count`는 전체 수. `thumb`은 null 가능.
  **저장소 파일 크기가 작은 것만** 경로를 넣는다: `storage.objects.metadata->>'size'`가 썸네일 150,000바이트·큰 사진 2,000,000바이트 이하. 파일이 없거나 크기를 모르면 null
  (멤버가 5MB 파일을 썸네일 경로로 넣어 방문자 전송량을 쓰는 것을 막음. 앱이 만드는 썸네일은 보통 20–40KB, 큰 사진은 1080px로 200–500KB).
- **넣지 않는 것**: 방 uuid, `invite_code`, `created_by`, 사용자 uuid, 로그인 아이디·이메일, 방장 표시, `favorite`(찜), 정확한 날짜·시각(마지막 활동도 묶음만), `updated_at`, 월드컵 기록, `public_hidden_at`.
- 모든 JSON은 `jsonb_build_object`로 키를 하나씩 적는다(`to_jsonb(row)`·`select *` 금지).

### 2.7 권한

```sql
-- 앱
grant execute on function public.create_room(text, text, text, text, integer) to authenticated;
grant execute on function public.public_create_status() to authenticated;
grant execute on function public.set_room_description(uuid, text) to authenticated;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
grant execute on function public.public_ack_version() to authenticated, service_role;
-- 서버만
grant execute on function public.join_room_for(uuid, text, text, integer) to service_role;
grant execute on function public.space_code_info(text) to service_role;
grant execute on function public.public_room_list() to service_role;
grant execute on function public.public_room_view(text) to service_role;
grant execute on function public.public_rooms_version() to service_role;
grant execute on function public.admin_set_room_hidden(text, boolean) to service_role;
grant execute on function public.admin_public_rooms() to service_role;
-- 위 모두 먼저 `revoke all … from public, anon` (서버 전용은 authenticated에서도).
-- 내부 함수(public_login_id, public_room_activity, public_text_ok, public_nick_key)와 트리거 함수는 public, anon, authenticated 모두에서 회수
```

`couples`의 새 칸은 기존 `grant select on public.couples to authenticated` + 멤버 정책으로 **멤버에게만** 보인다(공개 키·소개·숨김 여부를 내 정보에 보여 주는 데 씀).
RLS·표 권한은 넓히지 않는다. 이유(아이디어 문서 6장 그대로): places를 남에게 보이게 하면 저장소 정책상 사진을 올리고 지울 수 있게 되고, couples를 보이게 하면 초대 코드(= 쓰기 권한)가 드러난다.

### 2.8 되돌리기: `supabase/public_rollback.sql`

순서: ① 홈 서버를 v0.1.2로 먼저 되돌림(새 화면은 `couples.visibility` 등을 읽으므로 SQL만 되돌리면 앱이 깨짐) → ② 이 파일.
- 사전 확인: `couples.visibility`가 있어야 함(아니면 "public.sql이 적용되지 않았어요.").
- 백업(`create schema if not exists backup`): `backup.public_rooms_v020_<KST 시각>`(id, name, public_key, description, public_hidden_at),
  `backup.public_room_acks_v020_<시각>`(표 전체), `backup.place_photo_thumbs_v020_<시각>`(id, place_id, thumb_path; **저장소의 썸네일 파일은 SQL로 못 지우니 이 표로 나중에 지움**).
- 함수·트리거 삭제(§2.5 새 함수와 내부 함수 `public_login_id`·`public_room_activity`·`public_text_ok`·`public_nick_key`, 트리거 `couples_freeze_visibility`·`couples_public_text`·`couple_members_public_nickname`과 그 함수), `join_couple_for`·`begin_room_delete`를 groups.sql 본문으로, 저장소 세 정책을 schema.sql 본문으로.
- 칸·제약 삭제(`couples`의 4칸, `place_photos.thumb_path`), `public_room_acks` 삭제. 공개 방은 개인 방이 된다(더 비공개인 쪽이라 안전).
- 되돌린 뒤 `public.sql`을 다시 적용할 수 있어야 한다(시험 P16).

---

## 3. 서버: `deploy/home/public.cjs` (새로) + `server.cjs`·`signup.cjs` 고침

### 3.1 설정 (`/etc/our-places/env`)

| 이름 | 값 | 기본 | 뜻 |
|---|---|---|---|
| `PUBLIC_ROOMS` | `on` \| `off` | `off` | 공개 방 전체 끄기 스위치. `off`면 공개 API 404, 화면 `PUBLIC_ROOMS_ENABLED = false` |
| `PUBLIC_PHOTOS` | `on` \| `off` | `on` | 둘러보기 사진만 끔(글은 그대로, `photos_paused: true`) |
| `PUBLIC_ANON` | `off`만 | `off` | 로그인 없이 보기(§10). **v0.2.0 서버는 `on`이면 설정 오류(78)로 시작하지 않는다**: "PUBLIC_ANON은 아직 켤 수 없어요(docs/public-rooms-design.md §10)" |
| `STATE_DIRECTORY` | 폴더 | systemd가 넣음 | 사진 한도 카운터 파일 위치. 서비스에 `StateDirectory=our-places` 추가(→ `/var/lib/our-places`). 없으면 메모리에만 두고 로그 한 줄 |

그 밖의 값은 정해진 형식이 아니면 `fail()`(예: `PUBLIC_ROOMS=yes` → "PUBLIC_ROOMS는 on 또는 off").

### 3.2 켜지는 조건과 화면 상수

- `index.html`에 `const PUBLIC_ROOMS_ENABLED = false;` 한 줄(바로 `SIGNUP_ENABLED` 아래). 서버는 `SIGNUP_ENABLED`처럼 정확히 한 줄을 찾아 바꾼다(못 찾으면 시작하지 않음).
- 화면은 네 벌 미리 만든다: `pages[signupOn][publicOn]`. 처음엔 둘 다 false.
- `verifySecretKey`(§3.8)가 통과하면 `signupReady = true`. 그때 `PUBLIC_ROOMS === 'on'`이면 `publicReady = true`이고 `PUBLIC_ROOMS_ENABLED = true` 화면으로 바꾼다.
  `verifySecretKey`는 `public_rooms_version`까지 확인하므로 public.sql이 없으면 가입·참여·공개 방이 모두 꺼진 채로 뜬다(groups.sql 때와 같은 방식, 로그에 이유).
- 공개 API 객체는 `PUBLIC_ROOMS === 'on'`이고 secret key가 있을 때만 만든다. 없으면 `/api/public/*`는 404.

### 3.3 경로

| 경로 | 처리 |
|---|---|
| `GET\|HEAD /r/<key>` (`^/r/[a-km-np-z2-9]{10}$`) | 지금 index.html(`/`과 같은 버퍼), `cache-control: no-cache`. 스위치와 상관없이 낸다(화면이 꺼짐 안내). 형식이 다른 `/r/...`은 404 |
| `GET /api/public/rooms` | 목록 |
| `GET /api/public/rooms/<key>` | 방 하나 (썸네일은 장소마다 대표 하나만) |
| `GET /api/public/rooms/<key>/thumbs?place=<uuid>` | 장소 하나의 썸네일 사진 주소(최대 3장). 상세를 열 때 (GET만) |
| `GET /api/public/rooms/<key>/photo?place=<uuid>&i=<0\|1\|2>` | 큰 사진 주소 하나 (GET만) |
| `GET /api/public/img/<만료 초>.<서명>/<경로>` | 사진 바이트 (v0.2.1, 위 두 API가 준 주소). `<img>`라 로그인 토큰 없이, GET만. §3.6 |
| 그 밖의 `/api/public/...`, GET 아닌 요청 | 404 / 405 JSON |

모든 응답(정적 파일 포함)에 `x-robots-tag: noindex, nofollow`를 더한다(`SECURITY` 헤더). OG 태그는 지금처럼 일반 카드뿐(방 이름·사진을 넣지 않음).

### 3.4 요청 처리 순서 (공개 API)

1. 메서드(GET·HEAD, `thumbs`·`photo`는 GET만) → 공개 API 없음 404 / `publicReady` 아님 503 `{ error }` + `retry-after: 60`.
2. 경로의 키 형식(틀리면 DB를 부르지 않고 404). `thumbs`·`photo`는 `place`가 uuid, `photo`는 `i`가 0–2 정수(아니면 400).
3. 토큰 모양: `Authorization: Bearer <JWT 모양>`(signup.cjs `bearer()` 재사용)이 없으면 **횟수를 세기 전에** 401 `{ error: MSG.login, login: true }`.
   위로 가는 요청이 없고, 토큰 없는 요청이 공개 API 전체 몫(분당 300)을 써서 로그인한 사람이 429를 받는 일을 막는다.
   (`allowAnonymous` 옵션이 true일 때만 토큰 없이 uid `null`로 다음 단계로. 큰 사진은 그래도 401. v0.2.0은 늘 false — §10)
4. 횟수 제한: 전체 → IP(아래 표, 넘으면 429 + `Retry-After`). IP에서 막히면 전체 몫은 돌려준다.
5. 로그인 확인: 토큰 → uid는 `GET /auth/v1/user`(공개 키 + 그 토큰). 결과를 토큰의 SHA-256으로 60초 캐시(최대 500개). 401/403/404 → 401, 그 밖 실패 → 502.
   **틀린 토큰·확인 실패는 전체 몫을 돌려준다**(IP 몫은 그대로 셈).
6. 사람 횟수 제한(uid 기준).
7. 캐시 → 없으면 service_role로 RPC → **서버 허용 목록 필터**(§3.5) → 사진 서명·한도(§3.6) → 응답.
8. 로그에는 경로 종류와 결과만(`public list ok`, `public view 404`, `public photo budget`). 키·uid·토큰·검색어는 남기지 않는다. 누가 어떤 방을 봤는지 기록하지 않는다.

횟수 제한(`createLimiter` 재사용, `windowMs: 60_000`):

| 요청 | 사람마다 | IP(/64)마다 | 전체 |
|---|---|---|---|
| 목록 | 분당 20 | 분당 20 | 공개 API 합쳐 분당 300 |
| 방 하나 | 분당 30 | 분당 30 | (위와 같이 셈) |
| 썸네일(`/thumbs`) | 분당 60 | 분당 60 | (위와 같이 셈) |
| 큰 사진 | 분당 20 | 분당 20 | (위와 같이 셈) |

### 3.5 응답 (화면이 받는 모양, 정확한 키)

공통 헤더: `content-type: application/json; charset=utf-8`, `cache-control: private, max-age=60`(오류는 `no-store`), `x-robots-tag: noindex, nofollow`, `x-content-type-options: nosniff`.

**`GET /api/public/rooms`** → 200
```json
{ "v": 1, "rooms": [ /* §2.6 public_room_list 원소 9개 키 그대로 */ ] }
```

**`GET /api/public/rooms/<key>`** → 200 (없으면 404 `{ "error": "이 공개 방을 찾을 수 없어요." }`)
```json
{ "v": 1, "key", "name", "description", "member_count", "place_count", "truncated", "active",
  "photos_paused": false,
  "members": [{ "m", "name", "color" }],
  "categories": ["…"],
  "places": [{ "id", "name", "category", "address", "map_url", "status", "shared_note", "added_month", "added_by",
               "visits": [{ "month", "reviews": [{ "by", "rating", "body" }] }],
               "photo_count", "photos": [{ "thumb_url": "<사진 주소>" | null }] }] }
```
- 서버는 SQL 결과를 **키 하나씩 새 객체로 옮겨 담는다**(`pickRoom`, `pickListItem`). 위에 없는 키는 SQL이 실수로 넣어도 버리고, 형식이 틀린 값(예: `m` 번호가 `^m[1-5]$`가 아님, 색이 팔레트 id·`#rrggbb`가 아님)은 그 값을 null로.
- `photos`의 `path`·`thumb`(저장소 경로)는 화면에 보내지 않는다. **방 응답에는 장소마다 첫(대표) 썸네일만** `thumb_url`을 넣고 2·3번째는 늘 `null`
  (목록 카드는 대표만 쓰고, 상세를 열 때 `/thumbs`로 받음). 썸네일이 없거나 한도가 찼으면 `thumb_url: null`.
- **지도 링크**(`map_url`)는 아는 지도 주소만: `naver.me`, `map.naver.com`·`m.map.naver.com`, `place.naver.com`·`m.place.naver.com`·`pcmap.place.naver.com`,
  `maps.app.goo.gl`, `goo.gl/maps…`, `google.<도메인>/maps…`·`maps.google.<도메인>`, `kko.to`, `map.kakao.com`·`place.map.kakao.com`·`m.map.kakao.com`.
  http·https만, 사용자 정보·포트가 있으면 안 됨, 2000자까지, https로 바꿔 보냄. 그 밖은 `null`(화면은 "네이버 지도에서 검색" 링크).
  개인 방은 멤버끼리 믿지만 공개 방은 모르는 사람에게 보이므로, 낚시 주소가 "네이버 지도에서 보기"로 보이거나 "내 방에 담기"로 남의 방에 들어가지 않게 한다. 화면 `publicMapUrl`도 같은 규칙(시험이 비교).
- **사진 경로**는 `'<장소 uuid>/[t/]<randomUUID 또는 16진수 32자>.jpg'`만 내보낸다. v0.1.2 화면(새로고침 안 한 탭)이 만드는 `'<장소>/<Date.now()>-<i>.jpg'`는 사진 주소에 업로드 시각이 드러나므로
  `null`(회색 자리), 큰 사진은 404. 큰 사진 경로에 `t/`가 있거나 썸네일 경로에 없으면 버린다.

**`GET /api/public/rooms/<key>/thumbs?place=<uuid>`** → 200 `{ "v": 1, "thumbs": ["<사진 주소>" | null, …], "photos_paused": false }`
- `thumbs`는 그 장소 `photos`와 같은 길이(최대 3). 없는 방 404 `{ error: '이 공개 방을 찾을 수 없어요.' }`, 없는 장소 404 `{ error: '사진을 찾을 수 없어요.' }`.
- 대표 썸네일은 방 응답에서 이미 셌으므로 다시 세지 않는다(§3.6). 한도가 차면 남은 것은 `null` + `photos_paused: true`.

**`GET /api/public/rooms/<key>/photo?place=<uuid>&i=<n>`** → 200 `{ "url": "<10분 사진 주소>" }`
- 캐시한 방 JSON(없으면 RPC)에서 그 장소의 `photos[i].path`를 찾는다. 없으면 404 `{ error: '사진을 찾을 수 없어요.' }`.
- 하루 한도가 찼으면 429 `{ error: '오늘은 사진 보기가 멈췄어요. 내일 다시 보여요.', budget: true }`(`Retry-After`는 KST 자정까지),
  월 추정 바이트가 찼으면 429 `{ error: '이번 달은 사진 보기가 멈췄어요. 다음 달에 다시 보여요.', budget: true }`(`Retry-After`는 다음 달 1일 0시 KST까지).
  `PUBLIC_PHOTOS=off`면 503 `{ error: '지금은 사진을 볼 수 없어요.' }`.

오류 공통: 401 `{ error, login: true }`, 429 `{ error }` + `Retry-After`, 502 `{ error: '지금은 공개 방을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.' }`, 503 같은 문구.

### 3.6 캐시·사진 서명·사진 한도

- **캐시**(메모리 LRU): 방 JSON(서버 내부 모양, 경로 포함) 120초, 목록 60초, `null`(없는 방)도 120초. 크기는 항목마다 JSON 글자 수 + 키 길이 + 128로 세어
  합계 약 8MB, 그리고 **항목 2,000개까지**(로그인한 사람이 없는 키를 계속 물어도 없는 방 결과가 쌓이지 않게). 넘으면 오래 안 쓴 것부터 버림.
  관리자 숨기기는 `public.sh`가 서비스를 다시 시작해 비운다. SQL Editor로 바꾸면 최대 2분 뒤 반영.
- **사진 주소 서명**(v0.2.1): 서버가 `/api/public/img/<만료 초>.<서명>/<경로>`를 만들어 준다. 서명은 `HMAC-SHA256(키, "<만료 초>|<경로>")`의 base64url 43자이고,
  키는 secret key에서 `HMAC-SHA256(secret key, "group-place public img v1")`로 뽑는다(다시 시작해도 같은 주소가 맞고, secret key는 주소에 안 들어감).
  저장소에 묻지 않는다(파일이 있고 크기가 상한 안인 경로만 `public_room_view`가 줌). 썸네일은 1시간, 경로별로 `{ url, exp }`를 두고 남은 시간이 30분 이상이면
  다시 씀(같은 주소라 브라우저 캐시가 맞음). 큰 사진은 누를 때마다 10분짜리.
- **사진 넘기기** `GET /api/public/img/…`(v0.2.1): v0.2.0은 Supabase 서명 URL을 그대로 줬는데, Storage 응답의 `Last-Modified`·`ETag`에 업로드 시각이 초까지 드러나서
  (대개 방문한 날) "날짜는 월까지만"이 지켜지지 않았다. 그래서 서버가 `GET {SUPABASE_URL}/storage/v1/object/authenticated/place-photos/<경로>`(secret key)로 받아
  `content-type`(jpeg·png·webp만)·`content-length`·`cache-control: private, max-age=<주소 수명: 썸네일 3600·큰 사진 600>`·`nosniff`·
  `cross-origin-resource-policy: same-origin`만 붙여 넘긴다.
  순서: GET만(그 밖 405) → 준비 전·사진 끔 503 → IP 횟수(분당 600, 다른 공개 API 몫과 따로) → 서명·경로 형식(틀리면 404, 저장소에 안 감) → 만료(지나면 404)
  → 전체 횟수(분당 3,000, 서명·만료가 맞은 요청만 셈: 로그인 없는 위조 주소로 모두의 사진을 막지 못하게) → 받기(없는 파일 404, 썸네일 150KB·큰 사진 2MB를 넘으면 404,
  그 밖 실패 502). 메모리 캐시는 썸네일 10분(합계 16MB)·큰 사진 2분(합계 32MB), 같은 경로를 동시에 받으면 저장소에는 한 번만 묻는다.
  저장소에서 동시에 받는 것은 8개까지이고 나머지는 300개까지 줄을 선다. 줄도 차면 503 + `Retry-After: 5`(버퍼가 한꺼번에 쌓여 서비스 MemoryMax 256M을 넘지 않게).
  다 된 요청은 로그를 남기지 않는다(방 하나에 수십 장). 주소에는 사이트 주소(`PUBLIC_ORIGIN`)를 앞에 붙여 준다(배포 전에 열어 둔 v0.2.0 탭은 https 주소만 받으므로).
  화면 `imgUrl`은 이 주소 모양(`PUBLIC_IMG_RE`, 같은 사이트면 경로만)·`data:`·개발용 localhost만 받는다(Supabase https 주소는 버림).
- **사진 한도**(월 1GB에서 거꾸로, 아이디어 문서 8장): 하루(KST) 썸네일 800개·큰 사진 60개, 사람마다 하루 썸네일 200개·큰 사진 20개,
  월 추정 합계 1,000,000,000바이트(썸네일 25,000, 큰 사진 200,000바이트로 셈).
  썸네일은 **(사람, 썸네일 경로) 짝을 하루에 한 번만** 센다: 같은 사람이 그날 이미 받은 썸네일은 다시 열기·다른 앱에 다녀오기·`/thumbs`에서 다시 받아도 세지 않고 URL을 다시 준다
  (서명은 30분 이상 남은 것을 다시 씀). 처음 받는 썸네일이 남은 한도보다 많으면 장소 순서대로 남은 만큼만 넣고 나머지는 `null`, `photos_paused: true`.
  방 응답은 대표 썸네일만이라, 장소 70곳인 방을 처음 열면 70개를 쓴다(예전 계획은 3장씩 210개를 응답마다 다시 셌다).
  로그인 없는 사람(§3.9)은 누구인지 몰라 늘 센다. 주소를 준 것만 센다(사진 바이트를 넘길 때는 세지 않음).
- **카운터 파일** `${STATE_DIRECTORY}/public-budget.json`(권한 0600): `{ "v":1, "day":"YYYY-MM-DD", "month":"YYYY-MM", "salt":"<16진수>", "thumbs":n, "large":n, "anon":n, "bytes":n,
  "users": { "<해시 16자>": [썸네일, 큰 사진] }, "seen": ["<해시 16자>", …] }`.
  사람 키 = `sha256(salt + uid)` 앞 16자, 본 썸네일 키 = `sha256(salt + '|' + uid + '|' + 경로)` 앞 16자(경로·uid 원문은 남기지 않음, 하루 썸네일 한도만큼만 쌓임, 최대 50,000).
  `salt`는 날마다 새로(날이 바뀌면 `users`·`seen`·`salt`·하루 수를 비움, 달이 바뀌면 `bytes`도). 바뀐 게 있으면 60초마다, 그리고 SIGTERM 때 임시 파일 → rename으로 저장.
  시작할 때 읽고, 날짜가 지났으면 새로 시작. 파일이 깨졌으면 로그 한 줄 + 새로 시작(그날 한도는 안전한 쪽으로 반만 남은 것으로 셈: `thumbs = 400`, `large = 30`).
- **JSON 전송량**: 하루 보낸 응답 바이트를 세고 200MB를 넘으면 로그 경고 한 번(`public json over 200MB today`).

### 3.7 관리자 스크립트 `deploy/home/public.sh` (invite.sh와 같은 방식, root)

```
public.sh list                 # admin_public_rooms() 표
public.sh hide <key>           # admin_set_room_hidden(key, true) → systemctl restart our-places (캐시 비우기)
public.sh show <key>           # admin_set_room_hidden(key, false) → restart
```
키는 `^[a-km-np-z2-9]{10}$`만 받는다. secret key는 invite.sh처럼 `curl -K -`로 넘기고 명령줄·화면에 남기지 않는다. kick·rotate는 만들지 않는다(최종 결정 7).

### 3.8 `signup.cjs` 바뀌는 것 (동의와 확인 순서)

- `verifySecretKey`: 마지막에 `POST rpc/public_rooms_version`. 404 → `{ ok:false, retry:false, reason:'친구용 프로젝트에 supabase/public.sql을 먼저 실행해 주세요' }`, 숫자 ≥ 1이 아니면 `retry:true`.
- `validate`(가입)·`validateJoin`(참여): 선택 칸 `ackVersion` — 없거나 null이면 null, 1–100 정수면 그 값, 그 밖의 형식이면 `BAD_REQUEST`.
- `joinSpace` → `join_room_for`(`p_ack_version`)로 바꾼다. 결과: `{ joined, coupleId }` | `{ needAck, roomName, ackVersion }` | `{ fail: 'invalid_code'|'room_full'|'too_many_rooms'|'invalid_display_name'|'nickname_is_login_id' }` | `null`.
- **`/api/join` 순서**: 형식 → 토큰 → 횟수(센다) → `join_room_for`(코드 → 이미 멤버 → 방 참 → 내 방 3개 → 닉네임=아이디 → 동의).

| 결과 | HTTP | 본문 | 시도 횟수 |
|---|---|---|---|
| 들어감 / 이미 멤버 | 200 | `{ joined: true, couple_id }` | 돌려줌 |
| `invalid_code` | 400 | `{ error: MSG.joinInvalid }` | 셈 |
| `room_full` | 400 | `{ error: MSG.joinFull }` | 셈 |
| `too_many_rooms` | 409 | `{ error: MSG.tooManyRooms }` | 셈 |
| `nickname_is_login_id` | 400 | `{ error: MSG.nickIsId, nickIsId: true }` | 돌려줌 |
| `need_ack` | 409 | `{ error: MSG.needAck, needAck: true, roomName, ackVersion }` | **돌려줌**(맞는 코드에서만 나옴) |
| 응답 놓침 | (기존 `memberOfCode` 확인) 200 / 502 | | |

- **`/api/signup` 방 코드 순서**: 형식 → 횟수 → 계정 수 → `space_code_info`:
  `open: false` → 400 `MSG.badCode`(셈) → (공개) 닉네임이 아이디와 같음(대소문자 무시) → 400 `MSG.nickIsId`(돌려줌, 계정 수도 돌려줌) →
  (공개) `ackVersion !== ack_version` → 409 `{ error: MSG.needAck, needAck: true, roomName, ackVersion }`(돌려줌, 계정 수도 돌려줌, **계정을 만들지 않음**) →
  계정 만들기 → 로그인 → `join_room_for(…, ackVersion)`. 그사이 문구 버전이 바뀌어 `need_ack`가 오면 계정을 지우고 같은 409. 나머지는 지금과 같다.
- 409를 받은 화면은 `needAck`로 아이디 중복(409 `MSG.duplicate`)·방 3개(409)와 구별한다.
- `MSG` 추가(화면 `friendly()`·동의 시트와 글자까지 같게):
  - `needAck: '공개 방이에요. 안내를 읽고 동의하면 들어갈 수 있어요.'`
  - `nickIsId: '공개 방에서는 아이디와 같은 닉네임을 쓸 수 없어요. 별명을 정해 주세요.'`
- 가입 코드(W-…)는 그대로(방에 들어가지 않으니 동의 없음).
- `cleanDisplayName`(가입·참여 닉네임, 모든 방): 1–20자에 더해 §2.3의 못 쓰는 글자(제어·보이지 않는·방향 글자, 줄 나눔 U+2028·2029)가 있으면 400 `MSG.displayName`.
  가입 미리 확인의 닉네임 = 아이디 비교는 `nickKey`(NFKC → 보이지 않는 글자 지움 → 소문자, SQL `public_nick_key`와 같음).

### 3.9 로그인 없이 보기를 위한 자리 (지금은 꺼 둠)

`createPublicApi({ …, allowAnonymous: false })`. true면 토큰이 없을 때 uid `null`로 통과하고: 사람 제한 대신 IP 제한만, 썸네일은 별도의 익명 하루 한도(`anonThumbs`, 기본 0 = 사진 없음),
큰 사진은 401. 이 갈래는 `public.test.cjs`가 시험하지만, v0.2.0 `server.cjs`는 `allowAnonymous: false`로만 만들고 `PUBLIC_ANON=on`이면 시작하지 않는다. 넓히기 전 할 일은 §10.

---

## 4. 화면: `index.html`

### 4.1 상수·상태

```js
const PUBLIC_ROOMS_ENABLED = false;      // 서버가 바꿔 넣음 (SIGNUP_ENABLED 바로 아래 한 줄)
const PUBLIC_ACK_VERSION = 1;            // DB public_ack_version()과 같아야 함 (시험이 비교)
const PUBLIC_KEY_RE = /^[a-km-np-z2-9]{10}$/;
const PUBLIC_DESC_MAX = 60;
const PENDING_KEY = 'group-place:pending-public';    // sessionStorage: 로그인 전에 연 /r/<key>
const EXPLORE_HINT_KEY = 'group-place:explore-hint'; // localStorage: 돋보기 첫 안내를 봤는지
const NOTICE_KEY = 'group-place:notice-v020';        // localStorage: "새 기능: 공개 방" 한 번 알림
// state에 추가
state.explore = null;   // { status: 'loading'|'ok'|'error', rooms: [], query: '', scroll: 0 }  둘러보기 화면
state.visit = null;     // { key, from: 'explore'|'direct'|'self', status: 'loading'|'ok'|'error'|'gone', data,
                        //   tab: 'visited', category: '전체', query: '', sort: 'rating',
                        //   loadedAt, thumbs: Map('<장소 id>|<번호>' → { url, at }), thumbsAsked: Map(장소 id → 시각) }  읽기 전용 보기
```

`state.rooms` 조회를 `select('id, name, invite_code, created_at, visibility, description, public_key, public_hidden_at')`로 넓힌다.
`localStorage`·`sessionStorage`는 모두 `try/catch`.

### 4.2 읽기 전용은 같은 화면에 표시만 (`readOnly`)

- `const ro = () => !!state.visit;` 읽기 전용이면 `viewMain`·`placeCard`·`listHtml`·`detailView`·`visitCard`·`galleryHtml`·`openViewer`가 같은 함수로 그린다.
  데이터·화면 상태는 접근 함수로: `curPlaces()`(`ro() ? state.visit.places : state.places`), `curMembers()`, `ui()`(`ro() ? state.visit : state` — `tab`·`category`·`query`·`sort`),
  `person(id)`(읽기 전용이면 `m1`–`m5` 번호로 찾고, 없으면 `{ name: '예전 멤버', cls: 'mc mc-none' }`).
- 받은 JSON을 기존 장소 모양으로 바꾸는 `visitPlace(raw)`: `{ id, name, category, address, naver_url: publicMapUrl(map_url), status, favorite: false, shared_note,
  created_by: added_by, addedMonth: added_month, visits: [{ id: '<장소 id>:<n>', month, reviews: [{ author_id: by, rating, body }] }], reviews: (방문 후기 펼친 것),
  photos: [{ thumb: thumb_url, i }], photoCount: photo_count }`.
- 날짜: 읽기 전용에서는 `fmtMonth('2026-09')` → `'2026년 9월'`(방문 카드 날짜, "…이 2026년 9월에 담음"). 정렬의 `lastDay`는 `visits[0].month || addedMonth`.
- **클릭 허용 목록** `VISIT_ACTIONS`: 읽기 전용일 때 click 위임 맨 앞에서 이 목록에 없는 `data-action`은 무시하고 끝낸다.
  `['visit-close', 'visit-retry', 'tab', 'cat', 'sort', 'clear-search', 'open', 'close', 'view-photo', 'close-viewer', 'copy-open', 'copy-room', 'copy-status', 'copy-save', 'copy-create', 'explore-back']`.
  (`copy-create`는 내 방이 없을 때 담기 시트의 "새 방 만들기", §4.8. 고치는 단추는 이 목록에 더하지 않는다)
  `submit`·`change`(사진 올리기, 카테고리 이름) 위임도 읽기 전용이면 바로 끝낸다. 숨기기를 빠뜨린 버튼이 있어도 아무 일도 하지 않는다(눌러도 RLS가 막지만 그 전에).
- 읽기 전용에서 **절대 그리지 않는 것**: 초대 띠·초대 코드·`copy-code`·`regen-code`, 톱니·트로피·장소 추가, 방 이름 ⌄ 버튼, 찜 탭·하트(목록·상세), 정보 수정, 사진 추가·대표·삭제,
  메모 입력칸·저장, 방문 추가·후기 쓰기·삭제, 장소 삭제. 이것들을 가리키는 코드는 `if (!ro())` 안에 두거나 `state.couple`을 읽지 않는 갈래로 나눈다.

### 4.3 돋보기 세 곳과 둘러보기 화면

`PUBLIC_ROOMS_ENABLED`가 false면 셋 다 그리지 않는다.
1. **방 선택 화면** `viewRooms`: 제목 줄 오른쪽에 `<button class="icon-btn" data-action="explore" aria-label="공개 방 둘러보기">${ICON.search}</button>`.
   `EXPLORE_HINT_KEY`가 없으면 목록 아래 안내 "다른 사람들의 공개 방을 둘러볼 수 있어요."(둘러보기를 한 번 열면 저장).
2. **방 바꾸기 시트** `roomsView`: 머리 오른쪽 빈 자리(`<span style="width:40px">`) 대신 같은 버튼.
3. **시작하기** `viewOnboard`: 폼 아래 `text-btn` "공개 방 둘러보기"(`data-action="explore"`).

`explore` 누름: 열린 시트 닫기 → `state.explore = { status: 'loading', … }` → `render()` → `GET /api/public/rooms`(Authorization: Bearer 지금 토큰) → `ok`/`error`.
`viewExplore()`(전체 화면, `render()`가 `state.visit` → `state.explore` → 기존 순서로 고름):
- 머리: [‹](`data-action="explore-back"`) "공개 방 둘러보기". 검색 칸(placeholder "방 이름·소개로 찾기", id `explore-q`). 줄 "공개 방 N곳 · 최근 활동순".
- 걸러내기는 폰에서만: 소문자로 바꾼 이름+소개에 검색어의 낱말이 모두 들어 있으면. 입력할 때마다 목록만 다시 그림(서버로 보내지 않음).
- 카드(`data-action="explore-open" data-key`): 방 이름 + "공개" 표시(내 방이면 "내 방" 표시도), 소개 2줄, "장소 32 · 다녀온 곳 18 · 후기 41", 색 점 + "멤버 N명",
  활동 `week` "최근 7일 안 활동" / `month` "최근 한 달 안 활동" / `older` "한 달 넘게 활동 없음"(§2.6, 날짜 수는 받지 않음). 내 방 판단 = `state.rooms`의 `public_key`와 같음.
- 빈 화면: 공개 방 없음 "아직 공개 방이 없어요" + [새 방 만들기](방 3개면 숨김) / 검색 결과 없음 "‘라멘’과 맞는 공개 방이 없어요. 다른 낱말로 찾아보세요." /
  실패 "지금은 공개 방을 불러올 수 없어요. 잠시 후 다시 시도해 주세요." + [다시 시도](`data-action="explore-retry"`).
- 카드 누름: 내 방이면 `closeExplore()` 후 `switchRoom(id)`, 아니면 `openVisit(key, 'explore')`(지금 스크롤을 `state.explore.scroll`에 기억).
- 닫기(‹·뒤로 가기): `state.explore = null` → 원래 화면(방 선택·시작하기·메인).

### 4.4 읽기 전용 보기 열기·닫기

`openVisit(key, from)`:
- 키 형식이 틀리면 토스트 "이 공개 방을 찾을 수 없어요." 내 방 키면(`from !== 'self'`) 둘러보기 대신 `switchRoom`.
- `loadGen++`(늦게 끝난 내 방 새로고침이 화면을 그리지 않게), 시트·사진 보기 닫기, `state.visit = { key, from, status: 'loading', tab: 'visited', sort: 'rating', category: '전체', query: '' }`, `render()`.
- `GET /api/public/rooms/<key>` → 200이면 `data`·`places`(=`visitPlace`)·`members`, `status 'ok'` / 404 `'gone'` / 그 밖 `'error'`. 응답이 왔을 때 `state.visit.key`가 다르면 버림.
- `ROOM_KEY`(마지막 방)는 바꾸지 않는다.

화면(`viewMain`의 읽기 전용 갈래):
- 맨 위 고정 띠(높이 40px): "둘러보는 중 · 읽기 전용" + [닫기](`data-action="visit-close"`, 누르는 영역 44px). `from === 'self'`면 "방문자에게 보이는 모습 · 읽기 전용".
- 머리: 방 이름(버튼 아님, ⌄ 없음) + "공개" 표시, 소개(있으면 한 줄 `.hint`), 멤버 칩(색 점 + 닉네임, 방장 표시 없음), 오른쪽 아이콘 없음.
- 탭: "가고 싶은 곳" / "다녀온 곳"(**찜 탭 없음**). 기본 "다녀온 곳" + 평점순. 처음 열었는데 다녀온 곳이 0곳이고 장소가 있으면 빈 화면 대신 "가고 싶은 곳"부터. 검색·카테고리·정렬은 그대로.
- `truncated`면 목록 위에 "앱에서는 300곳까지만 보여요.", `photos_paused`면 "지금은 사진 보기가 잠시 멈췄어요. 나중에 다시 보여요." 띠
  (하루 한도·월 한도·`PUBLIC_PHOTOS=off` 어느 것인지 화면은 모르므로 '내일'이라고 하지 않음. 큰 사진을 누르면 서버 문구가 하루/다음 달을 구별해 알림으로 나옴).
- `gone`: "이 공개 방을 찾을 수 없어요" 화면 + [닫기]. `error`: "지금은 공개 방을 불러올 수 없어요. 잠시 후 다시 시도해 주세요." + [다시 시도](`visit-retry`). 이미 받은 화면이 있으면 그대로 두고 토스트만.
- 다른 앱에 다녀오면(`visibilitychange`) 읽기 전용이면 그 방 JSON만 다시 받는다(내 방 `refresh` 대신). 단 **마지막으로 받은 지 5분이 지났을 때만**
  (`state.visit.loadedAt`): "네이버 지도에서 보기"로 지도 앱에 다녀올 때마다 다시 받지 않게.
- 썸네일 기억(`keepThumbs`): 받은 썸네일 URL을 `'<장소 id>|<번호>'`로 기억하고, 다시 받은 방 응답에 `null`이 와도 받은 지 25분 안이면 그대로 쓴다
  (서버는 30분 이상 남은 URL만 주므로 그 안에는 만료되지 않음). 보이던 사진이 회색으로 바뀌지 않게, 상세에서 받은 2·3번째 썸네일도 다시 받지 않게.

`closeVisit()`: `state.visit = null`, 시트 닫기. `from` 별로: `'explore'` → 둘러보기 목록(검색어·스크롤 그대로), `'self'` → 메인(내 정보 다시 열지 않음),
`'direct'` → 마지막 방이 있으면 그 방, 없으면 방 선택(2개 이상)이나 시작하기(0개) — `chooseRoom()` 규칙 그대로. 그 뒤 `refresh({ keepSheet: false })`.

### 4.5 뒤로 가기 층

`wantedLayers()` 맨 앞에 `'explore'`(state.explore), `'visit'`(state.visit)을 더한다(그다음 `'sheet'`·`'edit'`·`'sub'`·`'viewer'`).
popstate: `'visit'` → `closeVisit()`, `'explore'` → `closeExplore()`. 둘러보기 → 방 → 상세 → 사진에서 뒤로 가기를 누르면 한 층씩 닫힌다.

### 4.6 상세 (멤버 상세와 같은 배치, 최종 결정 1)

`detailView(p)`를 그대로 쓰고 읽기 전용이면:
- 머리 오른쪽: 하트·"정보 수정" 대신 `<button class="text-btn" data-action="copy-open">내 방에 담기</button>` 하나(같은 자리·같은 크기).
  글자색만 `--p1-ink`(강조색): 회색이면 누를 수 없는 단추처럼 보여서. 시작하기 화면의 "공개 방 둘러보기" 링크와 같은 색.
- 사진: `galleryHtml`이 썸네일(`thumb`)로 그림. 썸네일이 없거나 null이면 회색 자리 표시(`.photo-ph`). `photoCount > photos.length`면 갤러리 아래 `.hint` "사진 N장 더 있어요".
  상세를 열면(`open`) 사진이 2장 이상이고 빈 썸네일이 있을 때 `GET …/thumbs?place=<id>`를 한 번 부르고(25분 안에는 다시 안 부름), 받은 것만 회색 자리를 바꿔 넣는다(넘기던 위치는 그대로).
- 지도 링크 글자: 링크 없음 "네이버 지도에서 검색", 구글 "구글 지도에서 보기", 카카오(`kko.to`·`map.kakao.com`) "카카오맵에서 보기", 그 밖 "네이버 지도에서 보기"(멤버 상세도 같은 함수 `mapLinkText`).
  누르면 `openViewer`가 그 사진만 `GET /api/public/rooms/<key>/photo?place=<id>&i=<n>`으로 받아 바꿔 넣는다(받기 전엔 썸네일, 실패하면 토스트 `j.error`).
- 이름·카테고리·주소·지도 링크·도장 자리: 그대로(도장은 읽기 전용에서 없음). **주소 복사 버튼을 새로 두지 않는다.**
- 사진 추가·대표·삭제 줄: 그리지 않음.
- 상태(가고 싶은 곳/다녀왔어요): 같은 `.seg` 모양이되 `<span>`으로(`aria-current="true"`가 지금 상태). 누를 수 없음.
- "함께 쓰는 메모": 메모가 있으면 제목 + `<p class="note-text">`(줄바꿈 유지, `esc`), 없으면 칸째 없음.
- 방문 기록: 방문 카드(`fmtMonth` 날짜, 멤버별 후기 줄). 방문 추가·후기 쓰기·삭제 버튼 없음. 방문이 없으면 블록째 없음(안내 문구도 없음).
- 맨 아래 줄: "<닉네임>이 2026년 9월에 담음"(`added_by`가 null이면 "예전 멤버가 담음", 회색). 장소 삭제 버튼 없음.

### 4.7 공개 방 만들기 (방 만들기 폼)

`roomFormHtml('create', …)`에 `PUBLIC_ROOMS_ENABLED`일 때만 공개 범위 카드를 더한다(방 이름 칸 아래, 닉네임 칸 위):
- 라디오 두 장(전체 너비, 선택 영역 44px 이상, `name="visibility"`): (●) **개인 방** "멤버만 볼 수 있어요"(기본) / ( ) **공개 방** "앱을 쓰는 누구나 둘러볼 수 있어요". 아래 `.hint` "만든 뒤에는 바꿀 수 없어요."
- 공개를 고르면(그 폼만 다시 그리지 않고 칸을 펼침): 방 이름 placeholder "예: 서울 라멘 지도", 소개 칸(`name="description"`, maxlength 60, placeholder "예: 함께 가 본 서울 라멘집 모음", 선택),
  안내 상자 "공개 방에서는 장소·메모·사진·후기·별점·닉네임을 앱을 쓰는 누구나 볼 수 있어요. 방문 날짜는 월까지만 보여요. 아이디·초대 코드·찜은 보이지 않아요. 화면 캡처는 막을 수 없어요.",
  "공개 방 닉네임에는 실명 대신 별명을 추천해요.", [공개 방 안내 보기](`data-action="public-guide"`), 체크 `name="ack"` "이해했어요". 버튼 글자 "공개 방 만들기", 체크 전에는 `disabled`.
- 폼을 처음 그릴 때 `sb.rpc('public_create_status')`를 한 번 부른다. `allowed: false`면 공개 카드를 `aria-disabled`·회색으로 두고 이유 한 줄:
  `public_owner_limit` "공개 방은 한 사람당 1개까지 만들 수 있어요." / `public_create_gap` "공개 방은 7일에 1개 만들 수 있어요(N일 뒤 가능)."(N = `next_at`까지 올림한 날 수) /
  `public_rooms_full` "지금은 공개 방을 더 만들 수 없어요." / `too_many_rooms`는 원래 폼 안내로. 부르다 실패하면 카드는 그대로 두고 DB 확인에 맡긴다.
- 보내기: 개인 → 지금처럼 `create_couple`. 공개 → 닉네임이 내 아이디(`loginId`)와 같으면 바로 오류 문구(`friendly`의 `nickname_is_login_id`) →
  `sb.rpc('create_room', { p_display_name, p_room_name, p_visibility: 'public', p_description, p_ack_version: PUBLIC_ACK_VERSION })` → `switchRoom` → 토스트 "공개 방을 만들었어요."

### 4.8 내 방에 담기 (시트 `copy`, 최종 결정 2)

- 상세의 "내 방에 담기" → `openSheet('copy', placeId, { back: 'detail' })`(‹·Esc·뒤로 가기로 상세로. `wantedLayers`의 `'sub'`). 방이 하나여도 시트를 보여 확인받는다.
- 내용: 제목 "내 방에 담기", 장소 이름. 방 목록(라디오 카드 `data-action="copy-room" data-id`, `state.rooms` 전부, 방 이름 + 공개면 "공개" 표시) — 기본 선택은 `lastRoom()`이 내 방이면 그 방, 아니면 첫 방.
  상태 `.seg`(`data-action="copy-status"`): "가고 싶은 곳"(기본) / "다녀왔어요". 안내 `.hint` "카테고리는 그 방에 같은 이름이 있으면 그대로, 없으면 ‘기타’로 담겨요. ‘기타’도 없으면 그 방 맨 아래 카테고리로 들어가요. 메모에는 ‘<공개 방 이름>’에서 담음이 들어가요. 사진·방문·후기는 옮기지 않아요."
  고른 방이 공개 방이면 한 줄 더 "공개 방이라 담은 장소를 누구나 볼 수 있어요." 버튼 [담기](`data-action="copy-save"`).
- 내 방이 없으면(시작하기 화면의 "공개 방 둘러보기"로 온 사람): "담을 방이 아직 없어요. 먼저 방을 만들거나 초대 코드로 참여해 주세요." + [새 방 만들기](`data-action="copy-create"`).
  누르면 둘러보기·읽기 전용을 모두 닫고 시작하기 화면의 방 만들기로 간다(`copyCreate()`). 담으려던 장소는 기억하지 않는다.
- 담기(`copy-save`, `busy`):
  1. 대상 방의 장소 이름·주소: `sb.from('places').select('id, name, address').eq('couple_id', target)`. **같은 장소** = 이름이 같고(앞뒤 공백 제거·공백 여러 개를 하나로·소문자) 주소도 같거나(같은 정리) 둘 다 비었음 → 토스트 "‘<방 이름>’에 이미 있는 장소예요." 끝.
  2. 카테고리: `sb.from('categories').select('name, position').eq('couple_id', target).order('position')`. 규칙 = 원래 카테고리와 **같은 이름이 있으면 그것** → 없으면 `'기타'`가 있으면 `'기타'` →
     없으면 `position`이 가장 큰 카테고리 → 카테고리가 하나도 없으면 `insert({ couple_id: target, name: '기타', position: 0 })` 뒤 `'기타'`(unique 오류면 그대로 `'기타'`).
  3. `sb.from('places').insert({ couple_id: target, name, address: address || null, category, naver_url: safeUrl(map_url) || null, status, shared_note: \`‘${공개 방 이름}’에서 담음\`, created_by: uid() })`.
  4. 성공: 시트 안에 "담았어요" 화면(체크 + "‘<방 이름>’에 담았어요." + "가고 싶은 곳/다녀온 곳에 들어갔어요…")과 [그 방에서 보기]·[계속 둘러보기].
     [그 방에서 보기]는 `visit-close` 단추에 `data-go`(담은 방)를 붙인 것: 둘러보기를 모두 닫고 그 방으로 가서 담은 장소의 상세를 연다. [계속 둘러보기]는 시트만 닫음.
     알림(토스트) "‘<방 이름>’에 담았어요."는 그사이 시트를 닫았을 때만(알림이 단추를 가려서 시트 안 안내로 바꿈).
- **새 RPC를 만들지 않는 이유**: 대상 방에 장소를 넣는 것은 그 방 멤버가 평소 "장소 추가"로 하는 것과 같고, 기존 RLS("Members can add places": 멤버 + `created_by = 나`)와
  카테고리 FK가 그대로 지킨다. 옮기는 값(이름·주소·지도 링크·카테고리 이름)은 이미 공개 API가 허용한 것이라 서버가 DB에서 다시 읽을 필요가 없다. 함수를 두면 공개 방 행을
  service_role로 읽는 길이 하나 더 생길 뿐이다. 사진을 옮기지 않으므로 저장소 권한도 필요 없다.

### 4.9 공개 방에 참여할 때 동의 (시트 `public-ack`)

- 앱 안 참여(`room-form` join): `joinViaServer`가 서버 오류를 `err.status`·`err.body`와 함께 돌려주게 고친다(`postApi`가 `Error`에 `status`, `body`를 붙임).
  409 + `needAck`이면 폼 오류 대신 `openSheet('public-ack', null, { code, name, roomName, ackVersion, from: 'join', back: <있던 시트> })`.
- 가입(`signup-form`): 같은 409면 같은 시트(`from: 'signup'`, 입력값은 시트 상태에 두지 않고 폼에 남겨 둠).
- 시트 내용: 제목 "공개 방이에요". 본문(`roomName`·닉네임은 `esc`):
  > ‘서울 라멘 지도’는 앱을 쓰는 누구나 둘러볼 수 있는 방이에요. 이 방에 남기는 장소·메모·사진·후기와 닉네임 ‘지훈’이 공개돼요. 방문 날짜는 월까지만, 아이디·초대 코드·찜은 보이지 않아요.
  > 나가면 내 후기는 지워지지만, 내가 담은 장소와 사진은 방에 남아요.
  >
  > 공개 방 닉네임에는 실명 대신 별명을 추천해요.

  [공개 방 안내 보기](`public-guide`), 버튼 [동의하고 참여](가입이면 [동의하고 가입], `data-action="ack-accept"`) / [취소](`data-action="close"`).
- 동의: 같은 요청을 `ackVersion: <받은 ackVersion>`과 함께 다시 보냄. 성공 토스트 "공개 방에 들어왔어요." / "가입했어요. 공개 방에 들어왔어요." 취소: 시트만 닫힘(폼 값 그대로).
- 서버가 다시 409 `needAck`(문구 버전이 바뀜)를 주면 새 문구로 시트를 다시 그린다.
- `nickIsId`(400)면 시트를 닫고 폼 오류로 문구를 보여 준다. 동의 시트 전에 서버가 거르는 순서(코드·이미 멤버·방 참·방 3개)는 지금 문구 그대로 폼에 보인다.

### 4.10 방장의 "초대 코드 다시 만들기" (모든 방, 최종 결정 7)

- 내 정보의 초대 코드 묶음, `isOwner()`일 때만 코드 복사 아래 `<button class="text-btn" data-action="regen-code">초대 코드 다시 만들기</button>`.
- `confirm('초대 코드를 새로 만들까요? 지금 코드는 바로 못 쓰게 되고, 아직 안 들어온 친구에게는 새 코드를 다시 보내야 해요. 이미 들어온 멤버는 그대로예요.')` →
  `sb.rpc('regenerate_invite_code', { p_couple: state.roomId })` → `refresh()` → 내 정보 다시 그림 → 토스트 "새 초대 코드를 만들었어요."
- 멤버(방장 아님)에게는 버튼 없이 초대 코드 안내 문장 끝에 " 초대 코드는 방장이 다시 만들 수 있어요."를 붙인다.
- 메인의 첫 멤버 초대 띠는 `state.couple.invite_code`를 그대로 쓰므로 새 코드가 바로 보인다.

### 4.11 멤버가 보는 공개 방 표시

- "공개" 표시(`<span class="badge pub">공개</span>`): 방 카드(`roomCard`), 메인 방 이름 옆, 방 바꾸기 시트, 둘러보기 카드, 내 방에 담기 방 목록. `PUBLIC_ROOMS_ENABLED`와 상관없이(이미 있는 공개 방은 늘 표시).
- 쓰는 순간의 한 줄 안내(공개 방에서만, `.hint`): 장소 추가 폼 맨 위 "공개 방이라 담은 장소를 누구나 볼 수 있어요." / 상세 메모 칸 위 "공개 방이라 메모도 누구나 볼 수 있어요. 예약자 이름·전화번호·비밀번호는 적지 마세요." /
  사진 줄 "사진도 공개돼요. 얼굴, 특히 아이 사진은 올리지 마세요." / 내 후기 입력칸 아래 "후기와 별점도 공개돼요."
- 첫 멤버 초대 띠(공개 방): "친구에게 초대 코드를 보내 주세요" 대신 두 줄 — [둘러보기 링크 (보기만)](`data-action="share-link"`) / 초대 코드 + [복사], 그리고
  "초대 코드를 받은 사람은 멤버로 들어와 장소를 고치고 지울 수 있어요. 보기만 할 사람에게는 링크를 보내 주세요." (`PUBLIC_ROOMS_ENABLED`가 false면 링크 줄만 뺌)
- 내 정보 **"공개 방" 묶음**(방 묶음 바로 아래, 공개 방에서만):
  - 상태 한 줄: 숨김(`public_hidden_at`) "관리자가 둘러보기에서 숨겼어요. 멤버는 그대로 쓸 수 있어요." / 장소 0곳 "장소를 담으면 둘러보기 목록에 나와요." / 그 밖 "둘러보기 목록에 보여요."
  - `PUBLIC_ROOMS_ENABLED`일 때만: [방문자에게 보이는 모습](`data-action="visit-self"` → `openVisit(public_key, 'self')`), [둘러보기 링크 공유](`share-link`: `navigator.share({ title: 방 이름, url })`, 없거나 실패하면 클립보드 + 토스트 "둘러보기 링크를 복사했어요.").
    링크 = `${location.origin}/r/${public_key}`.
  - 소개: 방장이면 입력칸(maxlength 60) + [소개 저장](`form#room-desc-form` → `set_room_description`), 아니면 글자 + "소개는 방장만 바꿀 수 있어요."
  - [공개 방 안내 보기](`public-guide`).
  - 초대 코드 묶음 안내에 공개 방이면 위 경고 문구를 더한다. 링크를 먼저, 코드를 다음에(둘러보기 링크 줄이 공개 방 묶음 안에 있어 순서가 맞음).
- 나가기 확인(공개 방): 멤버가 남으면 기존 문구 뒤에 " 공개 방이라 내가 담은 장소와 올린 사진은 남아 계속 공개되고, 공개 화면에는 ‘예전 멤버’로 보여요. 내리고 싶은 사진은 나가기 전에 지워 주세요."
  혼자면 첫 확인을 "‘<이름>’에서 나가면 이 공개 방과 둘러보기 링크가 사라져요. 장소·사진·후기·월드컵 기록이 모두 지워지고 되돌릴 수 없어요."로.
- 공개 방 안내 시트 `public-guide`(정적 글, `back` 지원): 무엇이 공개되는지 / 누구에게(앱을 쓰는 사람, 가입은 초대로만) / 공개 안 되는 것(아이디, 초대 코드, 찜, 정확한 날짜, 월드컵 기록) /
  캡처는 막을 수 없음 / 지킬 것(남의 얼굴·아이 얼굴·남의 개인정보·욕설·남의 사진·광고 금지) / 문제가 있으면 이 앱을 알려 준 운영자에게 알려 주세요(숨길 수 있어요).
- 한 번 알림(흐름 E): 로그인 뒤 `PUBLIC_ROOMS_ENABLED`이고 `NOTICE_KEY`가 없으면 토스트(5초) "새 기능: 공개 방. 지금 방은 그대로 개인 방이에요. 방 선택 화면이나 방 이름(⌄)의 돋보기로 둘러볼 수 있어요." 후 저장.

### 4.12 `/r/<key>` 링크

- 시작할 때 `location.pathname`이 `/r/<key>`(형식 맞음)이면 `sessionStorage[PENDING_KEY] = key`, `history.replaceState(null, '', '/')`.
- 로그인 화면: 대기 키가 있으면 폼 위에 `.hint` "공개 방을 보려면 로그인해야 해요. 계정은 초대 코드로만 만들 수 있어요." 방 이름은 보여 주지 않는다.
- 로그인(또는 가입·이미 로그인)하고 첫 `loadAll`이 끝나면: 대기 키를 지우고 `PUBLIC_ROOMS_ENABLED`면 `openVisit(key, 'direct')`, 아니면 토스트 "지금은 공개 방을 볼 수 없어요."

### 4.13 사진: 썸네일, 무작위 파일 이름, 지우는 길

- `addPhotos`: 파일 이름을 `crypto.randomUUID()`로(없으면 `crypto.getRandomValues` 16바이트 16진수). 큰 사진 `<place>/<id>.jpg`(1080px), 썸네일 `shrink(file, 320)` → `<place>/t/<id>.jpg`.
  둘 다 올린 뒤 `place_photos.insert({ place_id, path, thumb_path, position, created_by })`. 썸네일 만들기·올리기가 실패하면 `thumb_path: null`로 넣고 계속(둘러보기는 자리 표시).
  insert 실패 시 두 파일 모두 지움.
- 지우는 길에 썸네일 더하기: `deletePhoto`(표 → 두 파일), 장소 삭제(`delete-place`: `path`와 `thumb_path` 모두), 방 지우기(`begin_room_delete`가 이미 돌려줌, 장소 폴더 필터 그대로 맞음).
- 멤버 목록 카드 사진(`photoUrl`)은 대표 사진에 `thumb_path`가 있으면 그 서명 URL(`signPhotos`가 썸네일 경로도 서명). 상세 갤러리·크게 보기는 원본 그대로.

### 4.14 `friendly()` 추가 (서버 `MSG`와 같은 글자인 것은 표시)

```js
if (/visibility|public_key|create_room|public_create_status|regenerate_invite_code|set_room_description/.test(m) && /does not exist|schema cache|Could not find/i.test(m))
  return '공개 방용 SQL(supabase/public.sql)을 먼저 실행해 주세요.';
if (/invite_owner_only/.test(m)) return '초대 코드는 방장만 다시 만들 수 있어요.';
if (/description_owner_only/.test(m)) return '소개는 방장만 바꿀 수 있어요.';
if (/not_public/.test(m)) return '공개 방이 아니에요. 새로고침해 주세요.';
if (/invalid_description|couples_description_check/.test(m)) return `소개는 ${PUBLIC_DESC_MAX}자까지 쓸 수 있어요.`;
if (/nickname_is_login_id/.test(m)) return '공개 방에서는 아이디와 같은 닉네임을 쓸 수 없어요. 별명을 정해 주세요.'; // = MSG.nickIsId
if (/ack_required|need_ack/.test(m)) return '공개 방이에요. 안내를 읽고 동의하면 들어갈 수 있어요.';          // = MSG.needAck
if (/public_owner_limit/.test(m)) return '공개 방은 한 사람당 1개까지 만들 수 있어요.';
if (/public_create_gap/.test(m)) return '공개 방은 7일에 1개 만들 수 있어요.';
if (/public_rooms_full/.test(m)) return '지금은 공개 방을 더 만들 수 없어요.';
if (/visibility_immutable|public_key_immutable/.test(m)) return '공개 범위는 바꿀 수 없어요.';
if (/invalid_visibility/.test(m)) return '공개 범위를 다시 골라 주세요.';
```
`not_owner`보다 앞에 둔다(새 코드는 `not_owner`를 포함하지 않게 이름을 정했다).

### 4.15 휴대폰 화면 기준

360–390px, 가로 스크롤 없음, 양옆 16px. 둘러보기 카드 88px 이상, 이름·소개 2줄 말줄임, 숫자 줄 한 줄 말줄임. 읽기 전용 띠 40px(360px에서도 줄바꿈 없음).
공개 범위 카드·동의 시트는 너비 전체, 누르는 영역 44px 이상. 색은 지금 토큰(`--surface`, `--sunken`, `--line`, `--ink`, `--muted`, `--p1`)만 쓰고 밝은·어두운 화면 모두.
`.badge.pub`은 `--p1` 테두리 + 글자(어두운 화면에서도 4.5:1).
동의·안내 문장(`.ack-text p`, `.pub-box p`, `.pub-guide p·li`, `.copy-done p`, `.invite.pub .hint`, `.sheet-body .hint`, `.gate .hint`)은 CSS 한 줄로 `word-break: keep-all; overflow-wrap: anywhere`
(낱말 중간에서 줄을 바꾸지 않음, 긴 방 이름은 overflow-wrap이 지킴). 나간 멤버('예전 멤버', `.mc-none`)의 칠한 별은 `--muted`로(빈 별 `--line-strong`과 구별돼 별점이 보임).

### 4.16 버전

`const APP_VERSION = 'v0.2.3-261023-<5자>';`(소문자 16진수 5자, 배포 때 다시 만듦). README 배지 `version-v0.2.3`.

---

## 5. 공개되는 것 / 안 되는 것 (최종)

| 구분 | 공개(로그인한 앱 사용자에게) | 공개 안 됨 |
|---|---|---|
| 방 | 이름, 소개, 멤버 수, 장소·다녀온 곳·후기 수, 마지막 활동 묶음(7일 안·31일 안·그 전) | 방 uuid, 초대 코드, `created_by`, 만든 시각, 숨김 여부, 마지막 활동 날짜 |
| 멤버 | 닉네임, 색, 응답 안 번호(m1–m5) | 사용자 id, 아이디·이메일, 방장 표시, 들어온 날짜, 다른 방 |
| 장소 | 이름, 카테고리, 주소, 지도 링크(아는 지도 주소만), 상태, **함께 쓰는 메모**, 담은 달, 담은 사람 번호, 장소 uuid(사진 주소에 어차피 들어감) | **찜**, 정확한 등록 시각, 지도 주소가 아닌 링크 |
| 방문·후기 | 방문한 달, 멤버별 별점·후기 글 | 정확한 날짜, 수정 시각 |
| 사진 | 장소마다 앞의 3장 썸네일(1시간 사진 주소, 목록은 대표만·상세에서 나머지), 누르면 큰 사진(10분), 전체 장 수 | 저장소 경로(화면에 안 보냄), 업로드 시각(무작위 파일 이름만, 저장소의 Last-Modified·ETag는 서버가 버림 — v0.2.1), EXIF/GPS(업로드 때 지워짐), 크기가 큰 파일(썸네일 150KB·큰 사진 2MB 넘음) |
| 월드컵·비공개 방 | — | 전부 |

---

## 6. 시험 계획

### 6.1 SQL: PGlite (`dev/sqltest/public.test.cjs`, `npm test`)

`helpers.cjs`의 `newDb`에 `public: false` 옵션(true면 colors 위에 `public.sql`). 도우미 `createPublicRoom(db, n, name, nick, desc)`(= `create_room` 'public', 버전 1).
`snapshot()`의 정책 칸은 `qual`·`with_check`에 이름을 붙여 둘 다 비교한다(전에는 같은 이름 `coalesce` 두 칸이라 `with_check`만 남았음). 시험 이름은 P1–P16에 P3b(전체 30개)·P6b(이름·소개 글자)·P11b(사진 크기)·P15b(RLS·저장소·썸네일 경로)를 나눠 둠.
`stubs.sql`의 `storage.objects`에는 Supabase처럼 `metadata jsonb`(`{ "size": … }`)가 있다.
운영·시험 Supabase에 연결하지 않는다.

| # | 확인할 것 |
|---|---|
| P1 | 빈 DB·기존 데이터 DB 둘 다 적용됨, 기존 방은 모두 `private`·`public_key` null·소개 `''`. 두 번 적용하면 사전 확인에서 멈춤. colors.sql 없이 실행하면 멈춤. `public_rooms_version() = 1`, `public_ack_version() = 1` |
| P2 | `create_room`: 개인 방(소개 `''`, 키 null, 동의 기록 없음), 공개 방(키 형식 `^[a-km-np-z2-9]{10}$`, 방장, 카테고리 8개, 동의 기록 `create`/1). 오류 순서대로 각각: `invalid_visibility`, 개인 방에 소개 → `invalid_description`, 61자 → `invalid_description`, 버전 null·2 → `ack_required`, 4번째 방 `too_many_rooms` |
| P3 | 한도: 방장인 공개 방이 있으면 `public_owner_limit`(남의 공개 방 멤버인 것은 안 셈), 7일 안에 만든 기록(방을 지운 뒤에도) → `public_create_gap`, 기록을 8일 전으로 바꾸면 됨, 공개 방 30개면 `public_rooms_full`(숨김 포함). `public_create_status`의 `reason`·`next_at`이 같은 판단 |
| P4 | 바꾸기 금지: superuser·service_role로 `update couples set visibility` → `visibility_immutable`, `public_key` 바꾸기 → `public_key_immutable`. 이름 바꾸기(`rename_room`)·숨기기·코드 다시 만들기는 됨. authenticated는 couples update 권한 없음 |
| P5 | `join_room_for`: 개인 방 `joined`, 같은 사람 다시 `already_member`(행 수 그대로), 틀린 코드 `invalid_code`, **5명 찬 방 + 방 3개인 사람 → `room_full`**(방 참이 먼저), 방 3개 `too_many_rooms`, 공개 방 버전 null → `need_ack` + 방 이름 + **아무것도 안 바뀜**, 버전 1 → `joined` + 동의 기록 `join`. 지우는 중인 방 `invalid_code` |
| P6 | 닉네임=아이디(공개 방만): `create_room`·`join_room_for`·`update couple_members set display_name`이 `nickname_is_login_id`(대소문자·전각·보이지 않는 글자 무시, `raw_app_meta_data.username` 없으면 이메일 앞부분). 보이지 않는 글자·방향 글자가 든 닉네임은 `invalid_display_name`, 이모지 잇기(U+200D)는 됨. 개인 방에서는 됨 |
| P6b | 공개 방 이름·소개의 못 쓰는 글자: `create_room`(`invalid_room_name`·`invalid_description`·`invalid_display_name`), `rename_room`, `set_room_description`, superuser 직접 update(트리거). 이모지는 됨, 개인 방은 검사 안 함 |
| P7 | 기존 함수: `join_couple_for`로 공개 방 → `ack_required`(개인 방은 그대로), `create_couple`은 늘 개인 방, `space_code_open` 그대로. `space_code_info` 세 모양(§2.6) |
| P8 | **`public_room_view` 허용 목록**: 키 집합이 §2.6과 정확히 같음(최상위·멤버·장소·방문·후기·사진 각각). JSON 문자열에 초대 코드, 방 uuid, 모든 사용자 uuid, `@`(이메일), `favorite`가 **없음**. `shared_note`는 있음. 찜한 장소도 다른 장소와 모양이 같음 |
| P9 | 날짜: `added_month`·`month`가 `^\d{4}-\d{2}$`, 그 밖에 `YYYY-MM-DD`·시각 모양 문자열 없음. KST 경계(UTC 15:00 = 다음 날 KST)에서 `added_month`가 KST 기준 |
| P10 | 예전 멤버: 나간 사람이 담은 장소 `added_by: null`, 남은 사람 번호는 들어온 순서 m1…, 방장이 나간 뒤에도 번호에 방장 표시 없음 |
| P11 | 사진: 앞의 3장만, `photo_count` 전체 수, 순서 `position`, `thumb` null 가능. 300곳 넘으면 `truncated: true`, 300개만 |
| P11b | 사진 크기: 저장소 `metadata.size`가 썸네일 150,000·큰 사진 2,000,000바이트 이하만(경계값 됨), 넘거나 파일이 없거나 크기가 숫자가 아니면 null(오류 없이) |
| P12 | `null`이 되는 경우: 없는 키, 형식 틀린 키(`'ABCDEF12'` 초대 코드를 넣어도), 개인 방, 숨김, 지우는 중(15분 안). 지우는 중이 15분 지나면 다시 보임. 장소 0곳 방은 보기는 되고 목록에는 없음 |
| P13 | `public_room_list`: 원소 키 9개 정확히, 숨김·빈 방·개인 방 없음, 최근 활동순, 50개까지, 초대 코드·uuid 없음, `active`가 3일 전 `week`·8일 전 `month`·40일 전 `older`(방 JSON도 같음) |
| P14 | `regenerate_invite_code`: 방장 성공(새 코드 형식, 예전과 다름), 예전 코드로 `join_room_for` → `invalid_code`, 새 코드로 됨, 멤버 `invite_owner_only`, 남 `not_member`. `set_room_description`: 방장 성공(앞뒤 공백 제거), 멤버 `description_owner_only`, 개인 방 `not_public`, 61자 `invalid_description` |
| P15 | 권한: anon은 새 함수 모두 실행 불가. authenticated는 `join_room_for`·`space_code_info`·`public_room_list`·`public_room_view`·`public_rooms_version`·`admin_*` 불가, `create_room`·`public_create_status`·`set_room_description`·`regenerate_invite_code`·`public_ack_version` 가능. `public_room_acks`는 authenticated select 불가. RLS로 남의 공개 방 couples·places를 못 봄(공개라도). 저장소 정책: 멤버 아닌 사람은 공개 방 장소 폴더에 insert·delete 못 함, 썸네일 경로 `<place>/t/x.jpg`도 같은 판정. `begin_room_delete`가 썸네일 경로도 돌려줌 |
| P16 | 되돌리기: backup 표 세 개, 칸·함수·트리거·표 없음, `join_couple_for`·`begin_room_delete`·저장소 정책·권한이 적용 전 저장본과 같음, 공개 방은 개인 방으로 남음. 그 뒤 `public.sql` 다시 적용 성공 |

### 6.2 서버: `node --test "deploy/home/*.test.cjs"`

`deploy/home/public.test.cjs`(새로, 가짜 Supabase: `/auth/v1/user`, `rpc/public_room_list|public_room_view`, `storage/v1/object/sign/...`) + `signup.test.cjs` 고침.

| # | 확인할 것 |
|---|---|
| S1 | 토큰 없음 401(`login: true`), 틀린 토큰 401, 토큰 확인 실패 502, 토큰→uid 60초 캐시(두 번째 요청은 `/auth/v1/user`를 안 부름) |
| S2 | 키 형식이 틀리면 DB를 안 부르고 404. 없는 방 404, 그 결과도 캐시 |
| S3 | 방 JSON 120초·목록 60초 캐시(시계 주입), 지나면 다시 부름. `cache-control: private, max-age=60`, `x-robots-tag: noindex, nofollow` |
| S4 | 횟수 제한: 같은 사람 방 보기 31번째 429 + `Retry-After`, 다른 사람은 됨, 같은 IP 다른 사람 합쳐 31번째 429, 전체 301번째 429 |
| S5 | 썸네일 서명: 방 응답은 장소마다 대표 하나만 서명(2·3번째 `thumb_url`은 null), 경로를 100개씩 묶어 서명, 30분 이상 남은 URL은 다시 씀(서명 호출 안 함), 응답에 `path`·`thumb`(경로) 없음 |
| S6 | **허용 목록**: 가짜 SQL이 `invite_code`, `favorite`, `user_id`, `created_by`, `couple_id`를 섞어 돌려줘도 응답에 그 키와 값이 없음. 응답 키 집합이 §3.5와 정확히 같음. 응답 문자열에 가짜 초대 코드·사용자 uuid가 없음 |
| S7 | 사진 한도: 사람별 하루 썸네일 한도를 넘으면 남은 만큼만 + `photos_paused: true`, **다시 열면 이미 받은 것은 다시 주고 세지 않음**, 하루 전체·월 바이트 한도도 같음. 큰 사진 사람별 20 넘으면 429 `budget: true` + 하루 문구, 월 한도면 다음 달 문구. `PUBLIC_PHOTOS=off`면 썸네일 null, 큰 사진 503 |
| S8 | 카운터 파일: 저장(0600, 임시 파일 → rename), 다시 읽기(다시 시작해도 본 썸네일은 안 셈), 날이 바뀌면 하루 수·사람 수·본 썸네일·salt 새로, 달이 바뀌면 바이트도, 깨진 파일(`seen` 모양이 틀린 것 포함)은 반만 남은 것으로 시작. 파일에 uid·경로 원문이 없음 |
| S9 | 큰 사진: 캐시한 방에서 경로를 찾아 10분 서명, 없는 장소·`i` 범위 밖 404, `place`가 uuid가 아니면 400 |
| S10 | `allowAnonymous: true`로 만든 API는 토큰 없이 목록·방을 줌(IP 제한만, 썸네일 null), 큰 사진 401. 기본값(false)은 401 |
| S11 | `/api/join`: 개인 방 200, 공개 방 버전 없이 409 `needAck` + `roomName` + `ackVersion`, 그 409는 시도 횟수에서 빠짐(5번 넘게 409를 받아도 다음 정상 요청이 됨), 버전 1이면 200. **방이 차고 방 3개인 사람 → 400 `joinFull`**(순서), `nickname_is_login_id` → 400 `nickIsId`(안 셈) |
| S12 | `/api/signup` 공개 방 코드: 버전 없이 409 `needAck`이고 **계정을 만들지 않음**(admin users POST 없음), 시도·계정 수 둘 다 돌려줌, 버전 1이면 가입 + `joined: true`. 닉네임=아이디 400 `nickIsId`(전각 `ｊｉｈｕｎ`·U+200D가 든 것도). 계정을 만든 뒤 `need_ack`(경쟁)면 계정 삭제 + 409. 보이지 않는 글자·방향 글자가 든 닉네임은 400 `MSG.displayName` |
| S13 | `verifySecretKey`: `public_rooms_version` 404 → `retry: false`, 이유에 `public.sql`. `MSG.needAck`·`MSG.nickIsId`가 index.html `friendly()` 문구와 같음(파일을 읽어 비교) |
| S15 | `/thumbs`: 그 장소의 3장, 대표는 다시 세지 않음, 같은 장소 다시 받아도 안 셈, 형식 400·없는 장소/방 404·HEAD 405·토큰 없음 401, 사진 끔이면 null + paused |
| S16 | 사진 이름: `Date.now()` 꼴(`<장소>/1729580000000-0.jpg`)·대문자·큰 사진 경로의 `t/`는 서명하지 않음(썸네일 null, 큰 사진 404), randomUUID 이름은 됨 |
| S17 | 지도 링크: `https://naver.me/abc` 그대로, `http://` → `https://`, 구글·카카오 됨, `https://evil.example/`·`naver.me.evil.example`·구글 검색·사용자 정보·포트·`javascript:`·2000자 넘음은 null |
| S18 | 토큰 없는 요청 50번·틀린 토큰 20번 뒤에도 로그인한 사람은 전체 몫(시험에서 10)을 다 씀(토큰 없음은 세기 전 401, 틀린 토큰은 전체 몫을 돌려줌) |
| S19 | 캐시 항목 수 제한(오래된 것부터 버림)과 크기 계산(키 + 128) |
| S14 | `server.cjs` 순수 함수(내보내거나 별도 모듈 `pages.cjs`로): `PUBLIC_ROOMS_ENABLED` 줄 바꾸기 네 벌, `/r/<key>` 형식 판정(`/r/ABCDEF12`·`/r/k7m2p9xa4`(9자)·`/r/k7m2p9xa4c/x`는 404), `PUBLIC_ANON=on`이면 설정 오류 |

### 6.3 화면 정적 시험 (`dev/sqltest/public-client.test.cjs`, `npm test`가 같이 돌림. C1만 PGlite로 public.sql을 실행)

| # | 확인할 것 |
|---|---|
| C1 | `const PUBLIC_ROOMS_ENABLED = false;`가 정확히 한 줄, `PUBLIC_ACK_VERSION`이 `public.sql`의 `public_ack_version()` 값과 같음, `PUBLIC_KEY_RE`가 SQL의 키 check와 같은 글자 모음 |
| C2 | `APP_VERSION`이 `^v0\.2\.3-261023-[0-9a-f]{5}$` |
| C3 | 읽기 전용 화면 함수(`viewExplore`, `visitBand` 등 `/* readOnly */` 표시 구간)와 `VISIT_ACTIONS`에 `invite_code`·`copy-code`·`regen-code`·`toggle-fav`가 없음. `VISIT_ACTIONS`가 §4.2 목록과 같음 |
| C4 | `/api/public/` 응답을 화면에 넣는 곳이 모두 `esc(`·`safeUrl(`를 거침(정규식으로 `${` 뒤 `.name|.description|.shared_note|.body|.address|.map_url|.thumb_url` 직접 삽입이 없음) |
| C5 | `addPhotos`에 `Date.now()` 경로가 없고 `/t/` 썸네일 경로가 있음, `delete-place`·`deletePhoto`가 `thumb_path`도 지움 |
| C6 | 서버와 같은 규칙: 화면 `BAD_TEXT_RE` = `signup.cjs` `BAD_TEXT_RE`(= SQL `public_text_ok`의 글자 모음), `nickKey`가 지우는 글자가 같음, 화면 `publicMapUrl`을 떼어 내 `public.cjs` `mapUrl`과 같은 답을 내는지 |

C3은 `readOnly` 구간에 `state.couple`도 없는지 보고, C4는 HTML 태그가 있는 줄에서 `${x.name}`처럼 `esc()` 없이 넣는 곳이 없는지 본다(알림 글·검색 글자·DB 값은 HTML이 아님).

### 6.4 가짜 Supabase와 화면 찍기 (`dev/mock/`)

- `serve.mjs`: `PUBLIC_ROOMS_ENABLED`도 true로 바꿈. `supabase-mock.js`: `couples`에 새 칸, 방 D "서울 라멘 지도"(공개, 미나가 방장, 키 `k7m2p9xa4c`), 남의 공개 방 E·F(미나는 멤버 아님, 하나는 장소 0곳 → 목록에 없음),
  rpc `create_room`·`public_create_status`·`set_room_description`·`regenerate_invite_code`(같은 오류 코드), `fetch('/api/public/rooms…')`(허용 목록 모양, 썸네일은 `data:` 이미지),
  `/api/join`·`/api/signup`의 `needAck` 흐름(공개 방 코드 `C0FFEE01`). 장면 옵션 `&pub=gap|owner|full`(공개 카드 회색), `&pub=paused`(사진 멈춤 띠).
- `shoot.py` 새 장면(390×844, 밝은·어두운): `30-picker-magnifier`, `31-rooms-sheet-magnifier`, `32-onboard-explore-link`, `33-explore-list`, `33b-explore-search-empty`, `33c-explore-error`,
  `34-visit-main`(다녀온 곳·평점순, 찜 탭 없음), `35-visit-detail`(같은 배치, "내 방에 담기"), `35b-visit-photo-large`, `36-copy-sheet`, `36b-copy-done-toast`, `37-create-public`(펼친 카드·체크),
  `37b-create-public-gap`, `38-join-ack-sheet`, `38b-signup-ack-sheet`, `39-settings-public-owner`(공개 방 묶음·초대 코드 다시 만들기), `39b-regen-confirm`, `39c-settings-public-member`,
  `40-visit-self`, `41-visit-gone`, `42-visit-photos-paused`, `43-dark-visit-main`, `43b-dark-explore`.
- 검토 반영으로 더한 장면: `36d-copy-no-room`(방 없는 사람의 담기 시트, M4), `36e-copy-create-onboard`(그 단추로 간 시작하기). `35-visit-detail`은 `/thumbs`가 끝난 뒤 찍는다.
- **M4 확인(자동)**: `34`·`35`·`40` 장면에서 `document.body.innerHTML`에 그 방과 미나의 모든 방 초대 코드가 없고, `[data-action=copy-code]`·`[data-action=regen-code]`·`[data-action=toggle-fav]`가 없음.
  읽기 전용에서 허용 목록 밖 `data-action`을 강제로 눌러도(`el.click()`) `window.__mock.calls`에 쓰기 호출이 생기지 않음. 가로 스크롤 없음(`scrollWidth <= innerWidth`).

### 6.5 끝내기 전 확인

`node --test "deploy/home/*.test.cjs"`, `cd dev/sqltest && npm test`, 화면 장면 찍기(M4 통과), `scripts/leak-check.sh`의 grep 패턴을 작업 파일에 직접 돌려 통과
(가짜 키는 이름에 test/fake, 실제 프로젝트 주소·사이트 주소 없음), 모든 파일 LF.

---

## 7. 범위 밖 (v0.2.0에서 하지 않음)

방장이 스스로 공개 중단(최종 결정 8, 관리자 숨기기로 대신), 신고 버튼(v0.2.x), 멤버 빼기·방장 넘기기·내보내기, 관리자 kick·rotate 스크립트, 항목별 공개 숨기기,
나간 사람 사진 자동 숨김, 기존 개인 방 사진 썸네일 채우기, 서버 검색, 최근 본 방, 로그인 없이 보기(§10), 지도, 태그, 월드컵 공개, CSP 헤더.

## 8. 열어 둔 해석 (빌더는 이대로 하고, 주인이 다르게 원하면 바꿈)

1. 내 방에 담기의 상태는 "가고 싶은 곳"이 기본이고 "다녀왔어요"도 고를 수 있다(방문 기록은 만들지 않음).
2. 같은 장소 판단은 이름 + 주소(정리 후 같음, 또는 둘 다 빈칸). 이름만 같고 주소가 다르면 다른 장소로 담는다.
3. 카테고리가 없으면 '기타' → 없으면 맨 아래 카테고리 → 하나도 없으면 '기타'를 만든다.
4. 닉네임=아이디 금지는 공개 방에만(개인 방 사용자에게 영향 없음).
5. 초대 코드 다시 만들기는 지우는 중인 방에서도 막지 않는다(그 방 코드는 어차피 15분 동안 안 받음).
6. 사진 한도 카운터 파일이 깨지면 그날은 반만 남은 것으로 시작한다(안전한 쪽).
7. 마지막 활동은 `week`(7일 안)·`month`(31일 안)·`older` 묶음으로만 보인다(검토에서 날짜 수가 방문 날을 드러낸다는 지적, 주인이 날짜 수를 원하면 되돌림).
8. 못 쓰는 글자 검사는 공개 방에만 DB가 하고, 가입 닉네임(서버)과 화면 폼은 모든 방에서 막는다(개인 방의 기존 이름은 그대로 둠).
9. 썸네일이 150KB를 넘는 사진(앱 밖에서 올린 파일)은 둘러보기에서 회색 자리로 보인다. 멤버 화면은 그대로.

---

## 9. API 계약 (요약)

### 9.1 DB 함수 (PostgREST `rpc`)

| 이름 | 부르는 쪽 | 인자 | 반환 | 오류 코드 |
|---|---|---|---|---|
| `create_room` | 앱 | `{ p_display_name: text, p_room_name: text, p_visibility: 'private'\|'public', p_description: text\|null, p_ack_version: int\|null }` | `uuid` | `not_authenticated` `too_many_rooms` `invalid_room_name` `invalid_display_name` `invalid_visibility` `invalid_description` `nickname_is_login_id` `ack_required` `public_owner_limit` `public_create_gap` `public_rooms_full` (공개 방은 못 쓰는 글자도 `invalid_*`) |
| `public_create_status` | 앱 | `{}` | `{ allowed, reason, next_at, ack_version }` | `not_authenticated` |
| `set_room_description` | 앱 | `{ p_couple: uuid, p_description: text }` | `text` | `not_authenticated` `not_member` `description_owner_only` `not_public` `invalid_description` |
| `regenerate_invite_code` | 앱 | `{ p_couple: uuid }` | `text` (새 8자리 코드) | `not_authenticated` `not_member` `invite_owner_only` |
| `public_ack_version` | 앱·서버 | `{}` | `integer` (1) | — |
| `join_room_for` | 서버 | `{ p_user: uuid, p_invite_code: text, p_display_name: text, p_ack_version: int\|null }` | `{ status: 'joined'\|'already_member'\|'need_ack', couple_id, public, room_name?, ack_version? }` | `not_authenticated` `invalid_display_name` `invalid_code` `room_full` `too_many_rooms` `nickname_is_login_id` |
| `space_code_info` | 서버 | `{ p_code: text }` | `{ open, public, room_name, ack_version }` | — |
| `public_room_list` | 서버 | `{}` | `jsonb[]` (§2.6, 9개 키, 활동은 `active`) | — |
| `public_room_view` | 서버 | `{ p_key: text }` | `jsonb \| null` (§2.6) | — |
| `public_rooms_version` | 서버 | `{}` | `integer` (1) | — |
| `admin_set_room_hidden` | 관리자 | `{ p_key: text, p_hidden: boolean }` | `boolean` | — |
| `admin_public_rooms` | 관리자 | `{}` | `table(key, name, hidden_at, members, places, created_at)` | — |
| `join_couple_for` (바뀜) | 옛 서버 | 그대로 | 그대로 | + `ack_required`(공개 방) |
| `begin_room_delete` (바뀜) | 앱 | 그대로 | 경로 + 썸네일 경로 | 그대로 |
| 트리거 | — | — | — | `visibility_immutable` `public_key_immutable` `nickname_is_login_id` `invalid_display_name` `invalid_room_name` `invalid_description` (공개 방, 못 쓰는 글자) |

제한 숫자: 소개 60자, 공개 키 `^[a-km-np-z2-9]{10}$`, 방장인 공개 방 1개, 생성 간격 7일(지운 방 포함), 전체 공개 방 30개, 동의 문구 버전 1,
둘러보기 목록 50개, 방 JSON 장소 300곳·장소당 사진 3장, 초대 코드 `^[0-9A-F]{8}$`(그대로).

### 9.2 표 읽기·쓰기 (앱, RLS 그대로)

| 무엇 | 요청 |
|---|---|
| 내 방들 | `from('couples').select('id, name, invite_code, created_at, visibility, description, public_key, public_hidden_at').order('created_at')` |
| 사진 넣기 | `from('place_photos').insert({ place_id, path, thumb_path, position, created_by })` (`thumb_path`는 null 가능) |
| 내 방에 담기 | `from('places').select('id, name, address').eq('couple_id', target)` → `from('categories').select('name, position').eq('couple_id', target).order('position')` → (필요하면 `from('categories').insert({ couple_id: target, name: '기타', position: 0 })`) → `from('places').insert({ couple_id: target, name, address, category, naver_url, status, shared_note: '‘<공개 방 이름>’에서 담음', created_by })` |
| 공개 범위·공개 키·숨김 바꾸기 | **불가**(couples update 권한 없음 + 트리거) |

### 9.3 홈 서버 HTTP

| 요청 | 본문/쿼리 | 성공 | 실패 |
|---|---|---|---|
| `GET /api/public/rooms` (`Authorization: Bearer`) | — | 200 `{ v: 1, rooms: [...] }` | 401 `{ error, login: true }`, 404(꺼짐), 429, 502, 503 |
| `GET /api/public/rooms/<key>` | — | 200 §3.5 방 JSON | 401, 404 `{ error: '이 공개 방을 찾을 수 없어요.' }`, 429, 502, 503 |
| `GET /api/public/rooms/<key>/thumbs` | `?place=<uuid>` | 200 `{ v: 1, thumbs: [url\|null], photos_paused }` | 400, 401, 404, 405(HEAD), 429, 502, 503 |
| `GET /api/public/rooms/<key>/photo` | `?place=<uuid>&i=<0-2>` | 200 `{ url }` | 400, 401, 404, 429(`budget: true`이면 사진 한도: 하루/다음 달 문구), 503(사진 꺼짐) |
| `GET /r/<key>` | — | 200 index.html | 404(형식 틀림) |
| `POST /api/join` | `{ code, displayName, ackVersion?: int }` | 200 `{ joined: true, couple_id }` | 400 `{ error }`(형식·`joinInvalid`·`joinFull`·`nickIsId`+`nickIsId: true`), 401, 409 `{ error: MSG.tooManyRooms }`, **409 `{ error: MSG.needAck, needAck: true, roomName, ackVersion }`**, 429, 502 |
| `POST /api/signup` | `{ code, username, password, displayName, ackVersion?: int }` | 200 `{ access_token, refresh_token, joined, couple_id }` | 기존 + 400 `nickIsId`, **409 `needAck`(계정 안 만듦)** |

시도 제한(가입·참여 합쳐 IP마다 1시간 5번): `needAck` 409와 `nickIsId` 400은 세지 않는다. 공개 API 횟수 제한은 §3.4 표.
공통 헤더: 모든 응답 `x-robots-tag: noindex, nofollow`.

### 9.4 화면 상수·키·시트

`PUBLIC_ROOMS_ENABLED`(서버가 바꿈), `PUBLIC_ACK_VERSION = 1`, `PUBLIC_KEY_RE`, `PUBLIC_DESC_MAX = 60`, `PENDING_KEY = 'group-place:pending-public'`(sessionStorage),
`EXPLORE_HINT_KEY = 'group-place:explore-hint'`, `NOTICE_KEY = 'group-place:notice-v020'`, `VISIT_ACTIONS`(§4.2), 상태 `state.explore`·`state.visit`,
화면 `viewExplore`, 시트 `copy`(`back: 'detail'`)·`public-ack`·`public-guide`, 뒤로 가기 층 `'explore'`·`'visit'`, 클래스 `.badge.pub`·`.visit-band`·`.photo-ph`·`.note-text`,
`data-action`: `explore` `explore-back` `explore-open` `explore-retry` `visit-close` `visit-retry` `visit-self` `share-link` `copy-open` `copy-room` `copy-status` `copy-save` `copy-create`
`ack-accept` `public-guide` `regen-code`, 폼 `room-desc-form`, 폼 칸 `visibility` `description` `ack`, 경로 `/r/<key>`, `APP_VERSION = 'v0.2.3-261023-<5자>'`.

---

## 10. 누구나 보기로 넓히려면

v0.2.0은 로그인한 사람만 본다. 링크를 가진 누구나(로그인 없이) 보게 하려면 서버 설정 `PUBLIC_ANON=on` 하나로 켤 수 있게 길을 만들어 두었지만(§3.9),
켜기 전에 아래를 **모두** 끝내야 한다. 하나라도 빠지면 켜지 않는다. v0.2.0 서버는 `PUBLIC_ANON=on`이면 시작하지 않으므로, 이 목록을 끝낸 버전에서 그 막음을 푼다.

### 10.1 동의 다시 받기 (가장 먼저)

- 지금 동의 문구는 "앱을 쓰는 누구나"다. 로그인 없이 보이게 하는 것은 **약속한 범위를 넓히는 것**이라 지금 동의로는 안 된다.
- 문구를 "링크를 가진 누구나(앱을 쓰지 않는 사람도) 볼 수 있어요. 검색 엔진에는 나오지 않아요."로 바꾸고 `public_ack_version()`과 `PUBLIC_ACK_VERSION`을 2로 올린다.
- 방마다 "로그인 없이 보기"는 **지금 멤버 전원이 버전 2에 동의한 방만** 켜진다. SQL에 `public_room_anon_ok(p_key)`(멤버 모두의 최신 `public_room_acks.version >= 2`)를 두고,
  서버는 토큰이 없는 요청에 이 조건을 더한다. 동의하지 않은 멤버가 있으면 그 방은 계속 로그인한 사람에게만 보인다.
- 기존 멤버에게는 공개 방을 열 때 한 번 "로그인 없이도 보이게 할까요?" 시트(동의 / 지금은 안 함). 새로 들어오는 사람은 버전 2 문구로 동의한다.
- 방장이 방 단위로 "로그인 없이 보기"를 끄는 스위치(`couples.anon_view`, 방장만, 기본 꺼짐)를 두면 공개/개인 고정(결정 1)과 부딪히지 않으면서 더 비공개로 돌릴 수 있다.

### 10.2 개인정보 처리방침·문의처·신고

- 개인정보 처리방침 페이지(`/privacy`)와 공개 방 안내 글을 고쳐 "로그인하지 않은 사람도 본다"를 적는다. 만 14세 확인을 가입에 더한다(plan.md "그 다음").
- 개인 메일이 아닌 전용 문의 주소를 만들고 안내 글·로그인 없는 화면 아래에 둔다. 계정이 없는 사람(사진에 나온 사람, 가게 주인)도 삭제를 요청할 수 있어야 한다.
- **신고 버튼과 처리 흐름**(아이디어 문서 7장 v0.2.x: 방·장소·후기·사진 신고, `public_reports`, `admin.sh reports`)을 먼저 낸다. 로그인 없는 사람의 신고는 IP 하루 3회, 내용은 사유 선택만.
- 법 관련 메모(아이디어 문서 7장)를 다시 보고, 넓게 열기 전에 개인정보 침해 상담(118)에 묻는다.

### 10.3 횟수 제한과 남용

- 로그인 없는 요청은 사람 단위가 없어 IP(/64) 단위만 남는다. 목록 분당 10, 방 분당 15, 전체 익명 분당 120처럼 로그인 사용자보다 낮게 둔다.
- Cloudflare 대시보드의 무료 Rate limiting 규칙 하나를 `/api/public/*`에 걸어(예: IP당 10초에 20번) 노트북까지 오기 전에 막는다. Bot Fight Mode를 켠다.
- 공개 API 응답이 커지지 않게 방 JSON 300곳·사진 3장 제한을 그대로 두고, 익명에게는 후기 글을 장소당 최근 3개로 줄이는 것도 고려한다.

### 10.4 Cloudflare 캐시와 스냅샷

- 지금 응답은 `private, max-age=60`이라 에지에 남지 않는다. 익명 응답만 `public, s-maxage=300, max-age=60`으로 두고 Cache Rule로 `/api/public/rooms*`의 쿼리·쿠키를 캐시 키에서 뺀다
  (**Authorization이 있는 요청은 캐시하지 않음**: 로그인 사용자 응답과 섞이지 않게 경로를 `/api/public/anon/rooms…`로 나누는 편이 안전).
- 그러면 노트북이 꺼져도 최대 5분은 에지가 응답한다. 더 길게 버티려면 서버가 공개 방 JSON 스냅샷을 정적 파일로 만들어 Cloudflare Pages 같은 정적 호스팅에 올리는 방법이 있다(나중).
- 관리자 숨기기 때는 서비스 재시작에 더해 Cloudflare API(전용 토큰, 그 존의 Cache Purge 권한만)로 그 방 경로를 지운다. `public.sh hide`가 같이 한다.
- 사진은 만료가 있는 서명 주소라 에지 캐시와 맞지 않는다(아이디어 문서 정할 것 7). 익명 사진은 아래 10.6.

### 10.5 `/r/<key>` 링크 미리보기와 검색 엔진

- 카톡 등 미리보기: 서버가 `/r/<key>`를 낼 때 그 방이 익명 보기 가능하면 `og:title`(방 이름), `og:description`(소개), 일반 `og:image`만 바꿔 넣는다(`esc` 필수, 사진은 넣지 않음).
  아니면 지금처럼 일반 카드. 미리보기 요청도 같은 횟수 제한과 캐시를 탄다.
- **기본은 검색 엔진에 안 나옴**: 모든 응답의 `X-Robots-Tag: noindex, nofollow`를 유지하고 `robots.txt`에 `Disallow: /r/`, `Disallow: /api/`를 둔다. 공개 방 목록(둘러보기)은 익명에게 열지 않는다(링크를 받은 방만 열림).
  검색 노출을 원하면 방장 동의를 따로 받는 별도 기능으로 한다.

### 10.6 로그인 없는 사람의 사진

- 처음에는 **사진 없이** 글만(썸네일 자리 표시 + "사진은 앱에서 볼 수 있어요"). 트래픽 걱정이 없고 사진 속 사람에 대한 부담도 작다.
- 사진을 보이게 하려면: 익명 하루 썸네일 한도를 따로(`anonThumbs`, 예: 200) 두고 월 1GB 예산 안에서 나눈다. 큰 사진은 계속 로그인한 사람만.
  더 줄이려면 공개 방 썸네일만 별도 공개 버킷(`public-thumbs`)으로 복사해 Cloudflare가 캐시하게 하되, 사진·장소를 지울 때 그 복사본도 지우는 길을 모두 고쳐야 한다(빠뜨리면 지운 사진이 남음).
- 월 예산을 넘으면 익명 사진부터 멈추고, 로그인한 사람과 멤버 사진은 영향을 받지 않게 한다.

### 10.7 그 밖

- 노트북 가동: 익명 공개는 "언제든 열리는 페이지"라는 기대를 만든다. 꺼져 있을 때를 위해 10.4 스냅샷이나 index.html 정적 호스팅을 먼저 검토한다.
- 기록: 익명 요청 로그에도 IP·키를 남기지 않는다. 하루 전송량 경고(§3.6)를 익명/로그인으로 나눠 센다.
- CSP 헤더(v0.2.x)를 먼저 넣는다. 남의 글이 로그인하지 않은 사람 화면에도 뜨므로 XSS 영향이 더 커진다.
- 켜는 순서: SQL(버전 2·`anon_ok`) → 서버(막음 해제, 익명 경로, 캐시 규칙) → 화면(새 동의 문구) → Cloudflare 규칙 → 한 방으로 시험 → `PUBLIC_ANON=on`. 끄기는 `PUBLIC_ANON=off` + 재시작 + 캐시 지우기.

---

## 11. 적용 방법 (주인이 할 일)

운영 DB에 쓰고 운영 서버를 바꾸는 일이라 **주인이 직접**, 확인한 뒤에 한다. 대상은 친구용 Supabase 프로젝트(Free, `schema.sql` → `friends-keepalive.sql` →
`friends-signup.sql` → `groups.sql` → `colors.sql`까지 실행한 곳)와 홈 서버다. 순서는 **SQL 먼저, 그다음 배포**(새 서버는 시작할 때 `public_rooms_version`을
확인하므로, 배포를 먼저 하면 가입·참여가 꺼진 채로 뜬다. 그래도 SQL을 실행하고 `sudo systemctl restart our-places` 하면 켜진다).

### 11.1 SQL (Supabase 대시보드 → SQL Editor)

1. **확인** (새 쿼리에 붙여 넣고 Run). 기대값: `colors_ok = true`, `groups_ok = true`, `already = false`, `pgcrypto = true`,
   `photos_without_size = 0`(사진 파일마다 크기 정보가 있어야 둘러보기에 사진이 보임. 0이 아니면 그 파일은 회색 자리로만 보이고 다른 것은 그대로).
   ```sql
   select
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'member_colors' and column_name = 'light') as colors_ok,
     to_regprocedure('public.join_couple_for(uuid, text, text)') is not null as groups_ok,
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'couples' and column_name = 'visibility') as already,
     to_regprocedure('extensions.gen_random_bytes(integer)') is not null as pgcrypto,
     (select count(*) from storage.objects where bucket_id = 'place-photos' and not coalesce(metadata ? 'size', false)) as photos_without_size;
   ```
   `pgcrypto = false`면 먼저 `create extension if not exists pgcrypto with schema extensions;`를 실행한다.
2. **실행**: 새 쿼리에 `supabase/public.sql` **파일 전체**를 붙여 넣고 Run을 **한 번** 누른다. 파일이 `begin … commit` 하나라 중간에 실패하면 아무것도 바뀌지 않는다
   (맨 앞 확인에서 멈추면 그 문구대로 먼저 할 일을 하고 다시 실행). 두 번 실행하면 "이미 적용된 SQL이에요"로 멈추므로 안전하다.
3. **확인**: 기대값 `version = 1`, `ack = 1`, `public_rooms = 0`, `private_rooms` = 지금 방 수, `thumb_col = true`.
   ```sql
   select public.public_rooms_version() as version, public.public_ack_version() as ack,
          (select count(*) from public.couples where visibility = 'public') as public_rooms,
          (select count(*) from public.couples where visibility = 'private') as private_rooms,
          exists (select 1 from information_schema.columns where table_name = 'place_photos' and column_name = 'thumb_path') as thumb_col;
   ```

### 11.2 배포 (주인 PC, 저장소 맨 위 폴더)

4. 새 파일까지 모두 커밋한다(`deploy.ps1`은 커밋된 내용만 묶는다): `deploy/home/public.cjs`·`pages.cjs`·`public.sh`·`public.test.cjs`·`server.test.cjs`,
   `supabase/public.sql`·`public_rollback.sql`, `dev/sqltest/public.test.cjs`·`public-client.test.cjs`, `docs/public-rooms-design.md`. 커밋 전 `bash scripts/leak-check.sh`.
5. `pwsh -File deploy/home/deploy.ps1 -Target <ssh 대상>`(처음 이 저장소로 배포하면 README의 `-SupabaseUrl`·`-SupabaseKey`·`-PublicOrigin`·`-LoginIdDomain`도).
   `install.sh`가 새 릴리스를 풀고, 서비스 파일(`StateDirectory=our-places` 포함)을 다시 깔고 `daemon-reload` → 재시작한다. 응답 확인이 실패하면 이전 릴리스로 저절로 되돌린다.
   설정 파일 `/etc/our-places/env`의 `PUBLIC_ROOMS`·`PUBLIC_PHOTOS` 줄은 그대로 옮겨진다. 처음에는 줄이 없으니 **공개 방은 꺼진 채(`off`)** 뜬다.
6. 꺼진 채로 기존 기능 확인: 로그인, 방 바꾸기, 장소·사진 추가(이제 썸네일도 올라감), 초대 코드로 참여, (방장) 초대 코드 다시 만들기.
   로그 `ssh <ssh 대상> "sudo journalctl -u our-places -n 50"`에 "public.sql을 먼저 실행해 주세요"가 없어야 한다.

### 11.3 공개 방 켜기와 점검

7. `/etc/our-places/env`에 `PUBLIC_ROOMS=on`을 넣고 `sudo systemctl restart our-places`. (둘러보기 사진만 끄려면 `PUBLIC_PHOTOS=off`)
8. 주인 계정 두 개로 점검: 공개 방 만들기(동의 체크) → 다른 계정으로 둘러보기(돋보기) → 방·상세·큰 사진 → 내 방에 담기 → 그 계정으로 초대 코드 참여(동의 시트)
   → 방장이 초대 코드 다시 만들기(예전 코드로 참여 안 됨) → 읽기 전용 화면 어디에도 초대 코드가 없는지 → 멤버 나가기·방 지우기.
   관리자 숨기기: `sudo bash /srv/our-places/current/deploy/home/public.sh list | hide <키> | show <키>`.
9. 문제가 있으면 **바로 끄기**: `PUBLIC_ROOMS=off` + 재시작. 둘러보기·공개 API·화면의 공개 방 만들기가 꺼진다(이미 만든 공개 방은 멤버에게는 그대로 쓰이고 데이터도 그대로).

### 11.4 되돌리기 (전부 v0.1.2로)

10. **서버·화면을 먼저** v0.1.2로: v0.1.2 커밋을 체크아웃한 뒤 `deploy.ps1`(또는 서버의 `/srv/our-places/releases/` 안 이전 릴리스로 `current` 링크를 바꾸고 재시작).
    v0.1.2 서버·화면은 public.sql이 있어도 돌아간다(새 칸을 읽지 않고, `join_couple_for`는 공개 방 코드만 `ack_required`로 거절).
11. 그다음 SQL Editor에서 `supabase/public_rollback.sql` 전체를 한 번 Run. 공개 방은 개인 방이 되고 공개 키·소개·숨김 시각·동의 기록은 `backup.*_v020_<시각>` 표에 남는다.
    순서를 거꾸로 하면(SQL만 먼저 되돌리면) v0.2.0 화면이 `couples.visibility`를 읽다가 깨진다.
12. 썸네일 파일은 SQL로 못 지우므로 `backup.place_photo_thumbs_v020_<시각>`의 `thumb_path` 목록으로 Storage에서 나중에 지운다(남아 있어도 앱 동작에는 영향 없음).
    되돌린 뒤 다시 적용하려면 11.1부터 그대로 하면 된다.

문서: README(배지 v0.2.0, 기능 표, 개발 명령)와 `docs/plan.md` 결정 6, `docs/groups-design.md` §7에 v0.2.0 변경(방장의 초대 코드 다시 만들기)을 적어 두었다.
