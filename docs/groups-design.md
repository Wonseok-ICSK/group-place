# 그룹 기능 설계와 API 계약 (MVP 1단계)

작성 2026-10-22. 대상: `docs/plan.md`의 결정 1–11(방 인원, 여러 방, 방 선택, 나가기, 색, 초대 코드 표시, 황금 도장 제거, 시도 제한).
공개 방(12–14)과 앱 이름·배포 이름 정리는 이번 범위가 아니다. 버전은 `APP_VERSION = 'v0.1.0: 261022'`.

이 문서는 병렬로 일하는 빌더(SQL·서버·화면·테스트)가 같이 지키는 **계약**이다. 마지막의 [API 계약](#9-api-계약-요약)이 기준이고,
본문은 그 이유와 세부 동작을 적는다. 계약을 바꿔야 하면 이 문서부터 고친다.

용어: SQL의 `couples`/`couple_members`/`couple_id`는 이름을 그대로 둔다(표 이름 바꾸기는 범위 밖). 화면 문구는 **방 / 멤버 / 방장 / 닉네임**.
"방장" = `couple_members.role = 'owner'`인 멤버 한 명(`couples.created_by`가 아님).

---

## 1. 지금 상태 (확인한 사실)

| 항목 | 지금 | 근거 |
|---|---|---|
| 방 이름 칸 | `couples.name text not null default '우리의 장소 기록'` **있음** | schema.sql |
| `create_couple` | `create_couple(p_display_name text, p_couple_name text default null) returns uuid`. 이미 이름 인자가 있다. 한 사람 한 방(`already_in_couple`) | schema.sql |
| 한 사람 한 방 | `couple_members_one_couple_per_user unique (user_id)` | schema.sql |
| 2명 제한 | `join_couple`, `join_couple_for`, `space_code_open` 세 곳. 2명이 차면 `invite_code = null` | schema.sql, friends-signup.sql |
| `join_couple` | friends-signup.sql이 `authenticated`에서 실행 권한을 거둠. 앱은 `/api/join` → `join_couple_for`(service_role 전용) | friends-signup.sql |
| 가입 시각 | `couple_members.created_at` 있음 → 들어온 순서로 쓴다(새 칸 없음) | schema.sql |
| 초대 코드 읽기 | `couples` select 정책 "Members can view their couples"가 멤버에게 행 전체(초대 코드 포함)를 보여 줌 → **정책 변경 불필요** | schema.sql |
| 닉네임 바꾸기 | `grant update (display_name)` + 정책 "Members can update own name"(`user_id = auth.uid()`). 방 조건이 없어서 **화면이 `couple_id`로 좁혀야** 한 방만 바뀐다 | schema.sql |
| 화면 | `loadAll`이 `couples ... .limit(1)`, 나머지 조회에 방 조건 없음. 색은 `role`로 `v1`(owner)/`v2` 두 가지 | index.html 576–599, 556–561 |
| 황금 도장 | `honorsOf`가 같은 월드컵에서 같은 곳을 고른 기록을 `gold`로 합침, CSS `.stamp.gold`, `.tag.gold`, `.gold-badge`, `.rec.both`, `#stamp-gold` | index.html |
| 시도 제한 | `createLimiter`에 `refund()`가 이미 있음. 지금은 아이디·비밀번호 실패와 `already_in_couple`만 돌려줌 | signup.cjs |
| `isMember` | `couple_members?user_id=eq.X` 아무 행이나 있으면 true → 여러 방에서는 "참여 성공" 판단이 틀림 | signup.cjs |

---

## 2. DB 변경: `supabase/groups.sql`

### 2.1 적용 조건과 형태

- 실행 순서: `schema.sql` → `friends-keepalive.sql` → `friends-signup.sql` → **`groups.sql`**. SQL Editor에서 한 번 실행.
- 파일 전체를 `begin; … commit;`로 감싼다(중간 실패 시 전부 취소). 맨 위 주석은 기존 SQL 파일 말투(무엇을, 언제, 되돌리기 파일 이름).
- 맨 앞 `do $$ … $$` 사전 확인(실패하면 한국어 메시지로 `raise exception`):
  1. `to_regclass('public.signup_invites') is not null` — 아니면 "먼저 supabase/friends-signup.sql을 실행하세요."
  2. `to_regclass('public.member_colors') is null` — 아니면 "이미 적용된 SQL이에요 (member_colors 표가 있음)."
  3. 방마다 멤버가 5명 이하인지. 지금 규칙상 2명 이하지만, `groups_rollback.sql`로 되돌렸다가 다시 적용하면 3~5명 방이 남아 있을 수 있어서
     새 규칙의 한도로 확인한다(채우기는 teal, amber, 그다음은 목록 순서에서 teal·amber를 뺀 색). 아니면 "예상하지 못한 데이터: 멤버가 6명 이상인 방이 N개 있어요."
  4. 방마다 owner가 1명 이하인지. 사람마다 방이 3개 이하인지.
- 테스트 행이 몇 개 있어도 되게 만든다(아래 채우기 단계).

### 2.2 표·칸 변경

```sql
-- 멤버 색 목록 (화면 index.html의 MEMBER_COLORS와 id·순서가 같아야 함. 테스트가 확인)
create table public.member_colors (
  id text not null,
  position smallint not null,
  constraint member_colors_pkey primary key (id),
  constraint member_colors_position_key unique (position),
  constraint member_colors_id_check check (id ~ '^[a-z]+(-deep)?$')
);
alter table public.member_colors enable row level security;          -- 정책 없음
revoke all on public.member_colors from public, anon, authenticated;  -- 앱은 index.html의 목록을 씀
insert into public.member_colors (id, position) values ('orange', 1), … , ('pink-deep', 40);  -- §2.6 순서 그대로

-- couple_members
alter table public.couple_members drop constraint couple_members_one_couple_per_user;
create index couple_members_user_idx on public.couple_members (user_id);          -- 사람마다 방 수 세기용
alter table public.couple_members add column color text references public.member_colors (id);
-- 채우기: 방마다 owner(없으면 먼저 들어온 사람) → 'teal', 다음 사람 → 'amber' (예전 v1/v2 색과 같게)
update public.couple_members m set color = case r.rn when 1 then 'teal' else 'amber' end
from (select couple_id, user_id,
             row_number() over (partition by couple_id order by (role = 'owner') desc, created_at, user_id) as rn
      from public.couple_members) r
where m.couple_id = r.couple_id and m.user_id = r.user_id;
alter table public.couple_members alter column color set not null;
alter table public.couple_members add constraint couple_members_couple_color_key unique (couple_id, color);
create unique index couple_members_one_owner on public.couple_members (couple_id) where role = 'owner';
-- 닉네임: 앞뒤 공백 없이 1~20자. 기존 행은 검사하지 않고(not valid) 새로 쓰는 값만 검사
alter table public.couple_members add constraint couple_members_display_name_check
  check (display_name = btrim(display_name) and char_length(display_name) between 1 and 20) not valid;

-- couples
alter table public.couples add column deleting_at timestamptz;   -- 마지막 멤버가 방을 지우는 중(사진 지우는 동안 새 참여를 막음)
alter table public.couples add constraint couples_name_check
  check (name = btrim(name) and char_length(name) between 1 and 30) not valid;
-- 2명이 차서 지워졌던 초대 코드를 다시 만듦: 이제 코드는 방이 있는 동안 계속 씀(결정 5)
-- (do 블록 안에서 방마다 8자리 대문자 16진수, unique_violation이면 다시 뽑음)
```

`couple_members.created_at`이 "들어온 시각"이다. 새 칸(`joined_at`)은 만들지 않는다. 순서가 같으면 `user_id`로 정한다.

### 2.3 잠금 규칙 (교착 방지)

모든 함수와 트리거는 이 순서로만 잠근다.

1. **사람 잠금**: `perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || <user_id>::text, 0));`
   (사람마다 방 3개 제한을 동시에 넘지 않게. 트랜잭션이 끝나면 풀림. 같은 트랜잭션에서 다시 잡아도 됨)
2. **방 잠금**: `select … from public.couples where id = … for update` (방마다 5명 제한, 색 겹침, 방장 넘기기)

`leave_room`·`begin_room_delete`·`set_member_color`·`rename_room`은 2번만 잡는다(사람 수를 늘리지 않으므로). 1번 없이 2번 → 1번 순서로 잡는 곳은 없다.

### 2.4 트리거 (함수 밖에서 넣어도 제한이 지켜지게)

```sql
create or replace function public.enforce_member_caps()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('group-place:member:' || new.user_id::text, 0));
  perform 1 from public.couples where id = new.couple_id for update;
  if (select count(*) from public.couple_members where couple_id = new.couple_id) >= 5 then
    raise exception 'room_full';
  end if;
  if (select count(*) from public.couple_members where user_id = new.user_id) >= 3 then
    raise exception 'too_many_rooms';
  end if;
  if new.color is null then
    new.color := public.pick_member_color(new.couple_id);
  end if;
  return new;
end; $$;
create trigger couple_members_enforce_caps before insert on public.couple_members
  for each row execute function public.enforce_member_caps();
```

`pick_member_color(p_couple uuid) returns text`(security definer, 내부 전용): `member_colors` 중 그 방에서 안 쓰는 색 하나를
`order by random() limit 1`. 없으면 `raise exception 'no_free_color'`(5명·40색이라 실제로는 안 남).

### 2.5 함수 (정확한 이름·인자·반환·오류)

공통: `language plpgsql`, `security definer`, `set search_path = ''`, 모든 이름은 `public.`/`auth.`를 붙여 씀.
오류는 `raise exception '<코드>'`(PostgREST가 HTTP 400, `message = '<코드>'`, `code = 'P0001'`로 돌려줌). 이름 정리는 `btrim`.

| 함수 | 반환 | 하는 일 | 오류 코드 |
|---|---|---|---|
| `create_couple(p_display_name text, p_couple_name text default null)` **(이름·인자 그대로, 본문만 교체)** | `uuid` 새 방 id | 사람 잠금 → 방 3개 확인 → 방 이름·닉네임 확인 → `couples` 행(초대 코드 8자리, 겹치면 다시) → 멤버 `role='owner'`(색은 트리거가 무작위) → 기본 카테고리 8개(지금과 같음) | `not_authenticated`, `invalid_display_name`, `invalid_room_name`, `too_many_rooms` |
| `join_couple_for(p_user uuid, p_invite_code text, p_display_name text)` **(그대로, 본문 교체)** | `uuid` 방 id | §2.5.1 | `not_authenticated`, `invalid_display_name`, `invalid_code`, `too_many_rooms`, `room_full` |
| `join_couple(p_invite_code text, p_display_name text)` **(그대로, 본문 교체)** | `uuid` | `return public.join_couple_for((select auth.uid()), p_invite_code, p_display_name);` 실행 권한은 friends-signup.sql대로 거둔 상태 유지 | 위와 같음 |
| `space_code_open(p_code text)` **(그대로, 본문 교체)** | `boolean` | 코드가 있고, 멤버 5명 미만이고, 지우는 중(`deleting_at > now() - interval '15 minutes'`)이 아니면 true | 없음 |
| `rename_room(p_couple uuid, p_name text)` **새로** | `text` 저장된 이름 | 방 잠금 → 멤버인지 → 방장인지 → 이름 1~30자 → `update couples set name` | `not_authenticated`, `not_member`, `not_owner`, `invalid_room_name` |
| `set_member_color(p_couple uuid, p_color text)` **새로** | `text` 저장된 색 id | 방 잠금 → 멤버인지 → 색이 `member_colors`에 있는지 → 지금 색과 같으면 그대로 반환 → 다른 멤버가 쓰면 거절 → update (`unique_violation`도 `color_taken`으로 바꿔 올림) | `not_authenticated`, `not_member`, `invalid_color`, `color_taken` |
| `begin_room_delete(p_couple uuid)` **새로** | `text[]` 그 방의 사진 파일 경로 전부 | 방 잠금 → 멤버인지 → **혼자 남은 멤버인지** → `couples.deleting_at = now()` → `place_photos.path` 전부 + 예전 칸 `places.photo_path` 중 **그 장소 폴더 안의 것만**(`split_part(photo_path, '/', 1) = places.id::text`) | `not_authenticated`, `not_member`, `not_last_member` |
| `leave_room(p_couple uuid)` **새로** | `jsonb` `{"room_deleted": bool, "new_owner": uuid 또는 null}` | §2.5.2 | `not_authenticated`, `not_member`, `last_member` |
| `groups_schema_version()` **새로** | `integer` (지금 `1`) | `language sql stable security invoker`, `select 1`. 서버 시작 확인·화면 오류 안내용 | 없음 |
| `pick_member_color(p_couple uuid)` 내부 | `text` | §2.4 | `no_free_color` |
| `enforce_member_caps()` 트리거 | `trigger` | §2.4 | `room_full`, `too_many_rooms` |

닉네임 확인(`invalid_display_name`): `btrim(p_display_name)`이 null이거나 1~20자가 아니면. 방 이름(`invalid_room_name`): `btrim(p_couple_name)` 1~30자가 아니면
(인자 기본값 `default null`은 `create or replace`로 지울 수 없어서 남기고, 비어 있으면 이 오류).

#### 2.5.1 `join_couple_for` 순서

```text
1. p_user is null                         → not_authenticated
2. 닉네임 확인                             → invalid_display_name   (서버가 미리 걸러서 실제로는 안 옴)
3. 사람 잠금
4. select id from couples where invite_code = upper(btrim(p_invite_code))
     and (deleting_at is null or deleting_at <= now() - interval '15 minutes') for update
   없으면                                  → invalid_code
5. 이미 그 방 멤버면 그 방 id를 그대로 반환 (아무것도 안 바꿈, 닉네임도 그대로) — 같은 요청을 다시 보내도 안전
6. 그 사람의 방이 3개 이상                 → too_many_rooms
7. 그 방 멤버가 5명 이상                   → room_full
8. insert couple_members (role 'member', display_name, color는 트리거가 빈 색 무작위)
9. 초대 코드는 그대로 둠 (지우지 않음)
10. return 방 id
```

코드를 먼저 확인하므로 6·7번 오류도 "코드가 맞았다"는 뜻이 된다 → 서버는 이 오류들도 시도로 센다(§3).

#### 2.5.2 `leave_room` 규칙

```text
1. uid 없음 → not_authenticated
2. select … from couples where id = p_couple for update  (없으면 not_member)
3. 내가 멤버가 아니면 → not_member
4. 멤버가 나 혼자면:
     begin_room_delete를 15분 안에 부르지 않았으면(couples.deleting_at > now() - 15분이 아니면) → last_member
       (둘이 거의 동시에 나가서 혼자 남은 경우 등. 화면이 사진을 지우고 추가 확인을 받은 뒤에만 방이 지워지게)
     delete from couples where id = p_couple   -- categories, places(→ visits, reviews, place_photos), cup_results, couple_members가 같이 지워짐
     return {"room_deleted": true, "new_owner": null}
   (사진 파일은 SQL로 못 지움. 화면이 begin_room_delete → Storage API로 먼저 지운다. §4.9)
5. 아니면:
     delete couple_members where couple_id = p_couple and user_id = uid           -- 먼저: 이 뒤로 시작하는 내 후기 쓰기는 RLS에서 막힘, 색이 비워짐
     delete reviews     where author_id = uid and place_id in (그 방 장소)          -- 다른 방 후기는 그대로
     delete visits      where created_by = uid and place_id in (그 방 장소)
                          and not exists (그 방문에 남은 후기)                      -- 내가 만든 빈 방문만
     delete cup_results where couple_id = p_couple and user_id = uid
     내가 owner였으면: 남은 멤버 중 created_at(같으면 user_id)이 가장 이른 사람을 role = 'owner'로
     return {"room_deleted": false, "new_owner": 새 방장 id 또는 null}
```

- 내가 담은 장소(`places.created_by`), 올린 사진(`place_photos.created_by`), 다른 사람 후기가 달린 방문은 **남는다**.
  화면은 멤버 목록에 없는 id를 "나간 멤버"로 보여 준다.
- "내가 만든 빈 방문 지우기"는 결정 7을 풀어 쓴 것(후기를 지우면 날짜만 남은 빈 방문이 생겨서). 원치 않으면 이 한 줄만 빼면 된다.
- `couples.created_by`는 바꾸지 않는다(NOT NULL·FK. 계정 삭제 작업 때 정리, plan.md 구현 메모와 같음).
- 나가기와 동시에 보낸 후기 쓰기가 아주 드물게 남을 수 있다(이미 시작한 문장은 나가기 전 멤버십을 봄). 그런 후기는 "나간 멤버"로 보이고,
  후기 고치기 정책에 멤버 조건이 붙어 있어서(§2.7) 나간 사람이 더는 고칠 수 없다.

### 2.6 색 40가지 (id 순서 = `member_colors.position` = 화면 순서)

밝은 화면 값은 흰 바탕(#FFFFFF)과 배경(#F6F7F4)에서 3:1 이상(그래픽·굵은 글씨 기준), 어두운 화면 값은 카드(#1A212B)에서
선명한 줄 7:1, 짙은 줄 4.6:1 이상으로 맞췄다(OKLCH로 색상만 바꾸고 밝기를 대비에 맞춤). 하트·위험 빨강(#E5484D, #C2362F,
#FF6B70, #FF7A72) 근처 색상(OKLCH 색상각 5°–40°)은 뺐다. `teal`·`amber`는 예전 두 사람 색(채우기에 씀). `amber` 밝은 값만 대비 때문에
#C98208 → #BD7A05로 조금 진하게 했다.

| # | id | 이름(aria) | 밝은 | 어두운 | | # | id | 이름 | 밝은 | 어두운 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | orange | 주황 | #D76F05 | #F59246 | | 21 | orange-deep | 짙은 주황 | #8D561E | #B17E4E |
| 2 | tangerine | 귤 | #C97801 | #ED9733 | | 22 | tangerine-deep | 짙은 귤 | #875913 | #AB8149 |
| 3 | amber | 호박 | #BD7A05 | #F0B23E | | 23 | amber-deep | 짙은 호박 | #7C5F08 | #A08645 |
| 4 | mustard | 겨자 | #A48904 | #C9A80C | | 24 | mustard-deep | 짙은 겨자 | #6E640D | #938A46 |
| 5 | olive | 올리브 | #8F900D | #B0B025 | | 25 | olive-deep | 짙은 올리브 | #5D681C | #838F4D |
| 6 | lime | 라임 | #73970B | #92B842 | | 26 | lime-deep | 짙은 라임 | #4A6C2D | #729258 |
| 7 | green | 초록 | #459D2E | #70BD5E | | 27 | green-deep | 짙은 초록 | #346F3E | #5F9566 |
| 8 | emerald | 에메랄드 | #0F9F5C | #44C17B | | 28 | emerald-deep | 짙은 에메랄드 | #13714E | #4D9775 |
| 9 | jade | 비취 | #119D7C | #14C197 | | 29 | jade-deep | 짙은 비취 | #027060 | #3D9785 |
| 10 | teal | 청록 | #0E8C86 | #3CC2B9 | | 30 | teal-deep | 짙은 청록 | #106E6C | #339794 |
| 11 | cyan | 시안 | #0A9AA1 | #19BDC4 | | 31 | cyan-deep | 짙은 시안 | #126D78 | #3495A2 |
| 12 | sky | 하늘 | #0698B2 | #1ABBD8 | | 32 | sky-deep | 짙은 하늘 | #076C86 | #3E93AE |
| 13 | azure | 물빛 | #0296C5 | #06B8F1 | | 33 | azure-deep | 짙은 물빛 | #186994 | #4E90B7 |
| 14 | blue | 파랑 | #0091E4 | #4EB2FE | | 34 | blue-deep | 짙은 파랑 | #36659A | #608CBE |
| 15 | cobalt | 코발트 | #4B89F2 | #7AACFD | | 35 | cobalt-deep | 짙은 코발트 | #4B619D | #7188C0 |
| 16 | indigo | 남색 | #7281F4 | #95A5FE | | 36 | indigo-deep | 짙은 남색 | #5D5C9C | #8284C0 |
| 17 | violet | 보라 | #9079EF | #AD9EFD | | 37 | violet-deep | 짙은 보라 | #6D5898 | #9180BB |
| 18 | purple | 자주 | #A971E3 | #C695FB | | 38 | purple-deep | 짙은 자주 | #7A5490 | #9E7CB3 |
| 19 | orchid | 난초 | #BE6AD1 | #D98FEB | | 39 | orchid-deep | 짙은 난초 | #855084 | #AA79A8 |
| 20 | pink | 분홍 | #D362B2 | #EF88CE | | 40 | pink-deep | 짙은 분홍 | #904D71 | #B57696 |

"짙은" 줄끼리(특히 1–2번 근처)는 비슷해 보일 수 있다. 한 방은 5명이라 문제는 작고, 색은 본인이 바꿀 수 있다.

### 2.7 권한

```sql
revoke all on function public.create_couple(text, text) from public, anon;            grant execute … to authenticated;  -- 그대로
revoke all on function public.join_couple(text, text) from public, anon, authenticated;                                      -- 그대로 거둠
revoke all on function public.join_couple_for(uuid, text, text) from public, anon, authenticated; grant execute … to service_role;
revoke all on function public.space_code_open(text) from public, anon, authenticated;            grant execute … to service_role;
revoke all on function public.rename_room(uuid, text) from public, anon;          grant execute … to authenticated;
revoke all on function public.set_member_color(uuid, text) from public, anon;     grant execute … to authenticated;
revoke all on function public.begin_room_delete(uuid) from public, anon;          grant execute … to authenticated;
revoke all on function public.leave_room(uuid) from public, anon;                 grant execute … to authenticated;
revoke all on function public.groups_schema_version() from public, anon;          grant execute … to authenticated, service_role;
revoke all on function public.pick_member_color(uuid) from public, anon, authenticated;
revoke all on function public.enforce_member_caps() from public, anon, authenticated;
```

- `couple_members.color`에는 **update 권한을 주지 않는다**(색 바꾸기는 `set_member_color`만). `display_name` update 권한·정책은 그대로.
- RLS 정책은 **하나만** 바꾼다: `reviews`의 "Authors can update own reviews"에 "지금 그 장소의 방 멤버"(`is_couple_member`) 조건을
  `using`·`with check` 둘 다 붙인다(예전에는 `author_id = auth.uid()`만 봐서 나간 뒤 남은 후기를 계속 고칠 수 있었음).
  나머지는 이미 방 단위이고 초대 코드도 멤버가 읽을 수 있다. 방 이름 바꾸기·나가기는 함수로만.
- `revoke update (photo_path) on public.places from authenticated;` 예전 사진 칸은 v1.5부터 안 쓰는데, 아무 글이나 넣을 수 있어서
  다른 방 사진 경로를 넣어 두고 마지막 멤버가 방을 지울 때 그 파일을 지우게 만들 수 있었다(begin_room_delete도 폴더를 확인함, §2.5).
- `member_colors`는 RLS만 켜고 정책·권한 없음.

### 2.8 되돌리기: `supabase/groups_rollback.sql`

- `begin; … commit;`. 사전 확인: `member_colors`가 있어야 함. **두 개 이상의 방에 든 사람이 있으면 멈춤**
  ("여러 방에 들어간 사람이 N명 있어서 되돌릴 수 없어요. 한 방만 남기고 나간 뒤 다시 실행하세요."). 같은 이유로 owner가 없는 방은 없다(넘기기 규칙).
- `backup.couple_members_colors_<YYYYMMDD_HH24MISS>`에 `(couple_id, user_id, color)` 복사(friends-signup_rollback.sql과 같은 방식).
- 트리거 → 새 함수들(`rename_room`, `set_member_color`, `begin_room_delete`, `leave_room`, `groups_schema_version`, `pick_member_color`,
  `enforce_member_caps`) → 제약(`couple_members_couple_color_key`, `couple_members_one_owner`, `couple_members_display_name_check`,
  `couples_name_check`) → 칸(`couple_members.color`, `couples.deleting_at`) → `member_colors` → `couple_members_user_idx` 순으로 지움.
- `couple_members_one_couple_per_user unique (user_id)` 다시 추가.
- `create_couple`, `join_couple`, `join_couple_for`, `space_code_open` 본문을 schema.sql·friends-signup.sql의 지금 내용과 **글자 그대로** 되돌림.
  권한은 friends-signup.sql 적용 뒤 상태(join_couple은 거둔 채).
- 후기 고치기 정책을 schema.sql 그대로(`author_id = auth.uid()`만) 되돌리고 `grant update (photo_path) on public.places to authenticated`.
- 예전 규칙에 맞게 멤버 2명 이상인 방의 `invite_code = null`.
- 남는 것: 3~5명이 된 방은 그대로 남는다(예전 함수는 새로 못 넣을 뿐). 맨 위 주석에 적는다.

---

## 3. 서버: `deploy/home/signup.cjs` (+ `server.cjs` 시작 확인)

### 3.1 바뀌는 동작

| 항목 | 바뀐 뒤 |
|---|---|
| 공간 코드로 가입(`viaSpace`) | 지금 흐름 그대로(미리 확인 → 계정 → 로그인 → `join_couple_for`). 성공 응답에 `couple_id` |
| 가입 코드로 가입(`viaInvite`) | 그대로. 응답 `couple_id: null` |
| 앱 안 참여(`/api/join`) | 방이 이미 1–2개 있는 사람도 그대로 받는다. 성공 응답 `{ joined: true, couple_id }` |
| 참여 결과 해석(`joinSpace`) | 오류 정규식 `/invalid_code|room_full|too_many_rooms|invalid_display_name/`. 성공이면 `r.json`(문자열 uuid)을 `coupleId`로 |
| `isMember(id)` → **`memberOfCode(userId, code)`** | 응답을 놓쳤을 때 "그 코드의 방"에 들어갔는지만 본다(다른 방 멤버십은 성공으로 치지 않음). 반환 `{ coupleId } | false | null(확인 못 함)` |
| 시도 제한 | **성공(200)은 돌려준다(refund)**. 아이디·비밀번호 실패는 지금처럼 돌려줌. 코드가 틀림·방 참·방 3개 초과는 센다 |
| 계정 만들기 제한 (새로) | `/api/signup`만. 실제로 계정이 남은 가입(200, 들어갔는지 모르는 채 둔 계정)과 아이디 중복(409)을 IP(/64)마다 **하루 3개**, 전체 **하루 20개**까지. 성공을 안 세는 위 제한만 있으면 열린 방 코드 하나로 가입 → `leave_room`을 되풀이해 계정을 끝없이 만들 수 있고, 중복 답(409)으로 아이디가 있는지 끝없이 알아볼 수 있어서 |
| 시작 확인(`verifySecretKey`) | 마지막에 `rpc/groups_schema_version` 확인 추가 |

`memberOfCode` 요청(정확히 이 모양, 테스트 가짜 서버도 이 경로를 흉내 냄):

```
GET {SUPABASE_URL}/rest/v1/couple_members?select=couple_id,couples!inner(invite_code)&user_id=eq.<uuid>&couples.invite_code=eq.<CODE>
headers: apikey/authorization = secret key
→ 200 [] (아님) | 200 [{ couple_id, couples: { invite_code } }] (멤버) | 그 밖/예외 → null
```

`verifySecretKey` 추가 단계: `POST rpc/groups_schema_version {}` → 200이고 `json >= 1`이면 통과. 404면
`{ ok: false, retry: false, reason: '친구용 프로젝트에 supabase/groups.sql을 먼저 실행해 주세요' }`, 401/403이면 권한 문구(retry false), 그 밖은 retry true.

### 3.2 응답과 시도 세기 (계약)

| 요청 | 결과 | HTTP | 본문 | 시도 (계정 수) |
|---|---|---|---|---|
| `/api/signup` 가입 코드 성공 | | 200 | `{ access_token, refresh_token, joined: false, couple_id: null }` | 돌려줌 (셈) |
| `/api/signup` 방 코드 성공 | | 200 | `{ access_token, refresh_token, joined: true, couple_id: "<uuid>" }` | 돌려줌 (셈) |
| `/api/signup` 코드 틀림·방 참·경쟁에서 짐 | | 400 | `{ error: MSG.badCode }` | 셈 (돌려줌) |
| `/api/signup` 아이디 중복 | | 409 | 지금 문구 | 돌려줌 (셈) |
| `/api/signup` 약한 비번 / 쓸 수 없는 아이디 / 닉네임 거절 | | 400 | 지금 문구 | 돌려줌 (돌려줌) |
| `/api/signup` 들어갔는지 확인 못 함(계정은 둠) | | 502 | `{ error: MSG.joinUnknown }` | 셈 (셈) |
| `/api/signup` 계정 만들기 제한에 걸림 | | 429 | `{ error }` + `Retry-After` | 돌려줌 (—) |
| `/api/join` 성공(새로 들어감 또는 이미 그 방 멤버) | | 200 | `{ joined: true, couple_id: "<uuid>" }` | 돌려줌 |
| `/api/join` `invalid_code` | | 400 | `{ error: MSG.joinInvalid }` | 셈 |
| `/api/join` `room_full` | | 400 | `{ error: MSG.joinFull }` | 셈 |
| `/api/join` `too_many_rooms` | | 409 | `{ error: MSG.tooManyRooms }` | 셈 (코드 확인 뒤에 나는 오류라서) |
| `/api/join` 응답 놓침 → `memberOfCode`가 방 id | | 200 | `{ joined: true, couple_id }` | 돌려줌 |
| `/api/join` 응답 놓침 → 아님/확인 못 함 | | 502 | `{ error: MSG.joinFailed }` | 셈 |

구현: `handleSignup`/`handleJoin`에서 `if (result.refund || result.status === 200) gate.refund();`.
가입은 코드 시도 제한을 지난 뒤 `created`(계정 만들기 제한, `ACCOUNT_LIMITS = { perIp: 3, total: 20, windowMs: 24시간 }`)도 지나야 하고,
걸리면 코드 시도는 돌려주고 429(로그 `signup <종류> limited:account_ip|account_global`). 끝난 뒤
`if (result.status !== 200 && result.outcome !== 'fail:join_unknown' && result.outcome !== 'duplicate') acct.refund();`. 로그 outcome은
`ok`, `bad_code`, `full`, `too_many_rooms`, `fail:join` 등(아이디·토큰·코드 값은 남기지 않음, 지금 규칙 그대로).

### 3.3 문구 (`MSG`, 화면 `friendly()`와 글자까지 같게)

```js
codeFormat:   '초대 코드를 다시 확인해 주세요. (W로 시작하는 가입 코드나 8자리 방 코드)',
joinUnknown:  '가입은 됐지만 방에 들어갔는지 확인하지 못했어요. 잠시 후 아이디와 비밀번호로 로그인해 보세요.',
spaceCode:    '8자리 방 초대 코드를 다시 확인해 주세요.',
joinInvalid:  '초대 코드를 다시 확인해 주세요.',
joinFull:     '이 방은 이미 5명이 모두 찼어요.',
tooManyRooms: '방은 3개까지 들어갈 수 있어요. 다른 방에서 나간 뒤 다시 시도해 주세요.',
// joinAlready는 지움 (already_in_couple은 더 이상 안 나옴)
```

`server.cjs`는 머리 주석의 "공간" 표현만 "방"으로(동작 변경 없음). 서비스·경로 이름(`our-places`) 정리는 3단계.

---

## 4. 화면: `index.html`

### 4.1 상태

```js
const state = {
  user: null,
  rooms: [],        // [{ id, name, invite_code, created_at }]  내가 든 방 전부 (couples select, RLS가 내 방만 줌)
  allMembers: [],   // [{ couple_id, user_id, display_name, role, color, created_at }]  내 방들의 멤버 전부
  roomId: null,     // 지금 방 id
  couple: null,     // = rooms.find(id === roomId)  (기존 코드 호환용 이름 유지)
  members: [],      // 지금 방 멤버, created_at → user_id 순 (들어온 순서)
  roomLoading: false,
  places: [], categories: [], cupResults: [],
  … (tab, category, query, sort, sheet, editVisit, photoIdx, draftRating, cupSetup, cup, cupTab 그대로)
};
const MAX_MEMBERS = 5, MAX_ROOMS = 3;
const ROOM_KEY = 'group-place:last-room';   // 값 `${userId}:${roomId}` (다른 계정으로 로그인하면 무시)
```

`localStorage` 읽기·쓰기는 모두 `try/catch`(지금 `SEEN_KEY`와 같은 방식). `SEEN_KEY`는 `'group-place:seen-stamps'`로 바꾼다.

### 4.2 불러오기와 늦게 끝난 새로고침 막기

```js
let loadGen = 0;
// 끝까지 반영했으면 true, 그사이 더 새 불러오기나 방 바꾸기가 있었으면 false (아무것도 안 바꿈)
async function loadAll() {
  const gen = ++loadGen;
  const [c, m] = await Promise.all([
    sb.from('couples').select('id, name, invite_code, created_at').order('created_at'),
    sb.from('couple_members').select('couple_id, user_id, display_name, role, color, created_at').order('created_at'),
  ]);
  if (gen !== loadGen) return false;
  if (c.error) throw c.error; if (m.error) throw m.error;
  state.rooms = c.data; state.allMembers = m.data;
  state.roomId = chooseRoom();             // §4.3
  applyRoom();                             // couple, members 채움 (방이 없으면 places 등 비움)
  if (!state.roomId) return true;
  const room = state.roomId;
  const [p, k, w] = await Promise.all([
    sb.from('places').select('*, reviews(*), visits!visits_place_id_fkey(*), place_photos(*)').eq('couple_id', room).order('created_at', { ascending: false }),
    sb.from('categories').select('id, name, position').eq('couple_id', room).order('position').order('created_at'),
    sb.from('cup_results').select('*').eq('couple_id', room).order('played_at', { ascending: false }),
  ]);
  if (gen !== loadGen || state.roomId !== room) return false;
  … 지금처럼 반영 … ; await signPhotos();
  return gen === loadGen;
}
async function refresh({ keepSheet = true } = {}) {
  if ((await loadAll()) === false) return;   // 더 새 불러오기가 그릴 것
  render();
  if (keepSheet && state.sheet && state.sheet.type === 'detail') renderSheet();
}
```

**방 조건(`couple_id`)이 꼭 붙어야 하는 곳** (빠지면 다른 방 데이터가 섞임):
`places`·`categories`·`cup_results` 불러오기, `saveCup` 뒤 `cup_results` 다시 받기(`.eq('couple_id', c.roomId)`),
닉네임 저장 `update({ display_name }).eq('couple_id', state.roomId).eq('user_id', uid())`, 장소·카테고리·월드컵 insert의 `couple_id`.
`visits`·`reviews`·`place_photos`는 장소 id로 묶이므로 그대로. `saveCup`은 시작할 때의 방을 `state.cup.roomId`에 기억해서 쓴다.

### 4.3 방 고르기 규칙

`chooseRoom()` (위에서 아래로 처음 맞는 것):
1. `state.roomId`가 아직 내 방이면 그대로.
2. 주소의 `?room=<uuid>`가 내 방이면 그 방(쓴 뒤 `history.replaceState(history.state, '', location.pathname)`로 주소에서 뺌). 선택 기능.
3. 방이 1개면 그 방.
4. `forcePicker`(방금 로그인 폼·가입으로 들어옴)이 아니고, `ROOM_KEY`가 이 계정의 내 방이면 그 방.
5. 그 밖(방 0개 또는 2개 이상) → `null`.

`render()`: 설정 없음 → 로그인 → `rooms.length === 0` → 시작하기(만들기/참여) → `roomId === null` → **방 선택 화면** →
`roomLoading` → 불러오는 중 → 메인. 결정 3의 "로그인 후 2개 이상이면 방 선택 화면"은 로그인 폼·가입 직후에 적용하고(`forcePicker = true`),
앱을 다시 열 때는 마지막 방으로 바로 들어간다(방 선택 화면에서 마지막 방에 "최근" 표시).

`switchRoom(id)`: `state.roomId = id`, `ROOM_KEY` 저장, 방마다 다른 화면 상태 비우기(`sheet`·`cup`·`cupSetup`·`editVisit`·`query`·`category='전체'`·
`places`·`categories`·`cupResults`), 열린 시트 닫기(`closeSheet()`라서 뒤로 가기 기록도 맞춰짐), `roomLoading = true; render()`,
`await refresh({ keepSheet: false })`, `roomLoading = false`. 여러 번 눌러도 `loadGen` 덕에 마지막 방만 그려진다.

`visibilitychange`는 `state.roomId`가 있을 때만 `refresh()`.

### 4.4 화면 목록

| 화면 | 언제 | 내용 |
|---|---|---|
| 시작하기 `viewOnboard` (기존 고침) | 방 0개 | 제목 "방을 만들거나 참여해요", 설명 "방을 만들고 초대 코드를 보내면 친구가 들어올 수 있어요. 한 방은 5명까지예요." 전환 버튼 "새 방 만들기 / 코드로 참여". 만들기: **방 이름**(1~30자, placeholder "예: 맛집 탐방대") + **이 방에서 쓸 닉네임**(1~20자, 가입 때 이름을 미리 채움). 참여: 초대 코드 + 닉네임 |
| 방 선택 `viewRooms` (새로) | 방 2개 이상인데 지금 방 없음 | 제목 "어느 방으로 갈까요?". 방 카드: 방 이름, 멤버 점(색) 최대 5개, "N/5명", 내 닉네임, 내가 방장이면 "방장", 마지막 방이면 "최근". 누르면 `switchRoom`. 아래: 방이 3개 미만이면 "새 방 만들기"·"코드로 참여"(시트 `room-new`), 3개면 안내 "방은 3개까지 들어갈 수 있어요." 맨 아래 "다른 계정으로 로그인" |
| 방 만들기·참여 시트 `room-new` (새로) | 방 선택 화면·내 정보에서 | 시작하기의 패널과 같은 폼(`id="room-form"`, `data-mode="create|join"`). 닉네임은 지금 방의 내 닉네임으로 미리 채움 |
| 메인 `viewMain` (고침) | 방 있음 | §4.5 |
| 내 정보 시트 `settings` (고침, 제목 "내 정보") | 톱니 버튼 | §4.6 |

방 만들기: `sb.rpc('create_couple', { p_display_name, p_couple_name })` → 반환 uuid로 `switchRoom`. 토스트 "방을 만들었어요. 초대 코드를 보내 주세요."
참여: `SIGNUP_ENABLED ? joinViaServer(code, name) : sb.rpc('join_couple', …)` → 서버 응답 `couple_id`(rpc면 `data`)로 `switchRoom`. 토스트 "방에 들어왔어요."
`joinViaServer`는 `{ error, coupleId }`를 돌려주게 고친다.
가입(`signup-form`) 성공: `j.couple_id`가 있으면 그 방을 `ROOM_KEY`에 먼저 저장하고 `refresh`. 토스트 "가입했어요. 방에 들어왔어요." / "가입했어요. 이제 방을 만들거나 참여해요."

### 4.5 메인 화면

- 제목: 방 이름. 그 아래 `.duo`: 지금 방 멤버를 들어온 순서로 점(색)+닉네임, 최대 5명이라 `flex-wrap:wrap; gap:4px 12px`. 방장 표시는 내 정보에서만.
- 초대 코드 띠(`.invite`): **`state.couple.invite_code`가 있고 `state.members.length === 1`일 때만**. 문구 "친구에게 초대 코드를 보내 주세요", 복사 버튼 그대로.
- 목록 카드의 별점 칩(`pairTags`): 그 장소에 최근 별점을 남긴 멤버만, 들어온 순서로. 방 멤버가 2명 이하면 지금처럼 별 5개,
  3명 이상이면 줄어든 칩(`점 + 닉네임 + ★ + 숫자`, 예: "민수 ★4.5"). 아무도 안 남겼으면 칩 없음(평균도 없음). "후기 전" 빈 칩은 없앤다.
- "누가 담음"(`added`) 줄과 상세의 "담음" 줄: 멤버 색 + 닉네임, 나간 사람은 "나간 멤버".

### 4.6 내 정보 시트 (위에서 아래 순서)

1. "아이디 X로 로그인했어요." (그대로)
2. **방** 묶음: 방 이름 — 방장이면 입력칸(1~30자) + "이름 저장"(`rename_room`), 아니면 글자 + 안내 "방 이름은 방장만 바꿀 수 있어요."
   멤버 목록: 들어온 순서, 점(색)+닉네임, "방장"·"나" 배지, "N/5명".
3. **초대 코드**(멤버 모두, 코드가 있으면 항상): `code-box` + "코드 복사". 안내: 5명 미만이면 "이 코드로 5명까지 들어올 수 있어요.", 5명이면 "5명이 모두 찼어요. 누가 나가면 다시 들어올 수 있어요."
4. **이 방에서 쓰는 닉네임**: 지금 `name-form`(방 조건 붙임). 안내 "방마다 따로 정해요."
5. **내 색**: 색 동그라미 격자(지름 32px, 한 줄 8개 → 5줄). **다른 멤버가 쓰는 색은 보여 주지 않고**, 내 색은 `aria-pressed="true"` + 테두리.
   누르면 `set_member_color` → `refresh`. 버튼 `aria-label` = 색 이름(§2.6).
6. **방 바꾸기**: 내 다른 방 목록(누르면 `switchRoom` 후 시트 닫힘). 방이 3개 미만이면 "새 방 만들기"·"코드로 참여"(시트 `room-new`,
   `back: 'settings'`). 여기서 연 `room-new`는 ✕·Esc·뒤로 가기로 닫으면 내 정보로 돌아간다(방문 기록 층 `'sub'`).
7. 카테고리 (그대로, 안내 문구만 "멤버 모두에게 똑같이 보여요.")
8. 비밀번호 변경 (그대로)
9. 로그아웃 (그대로)
10. 버전 `APP_VERSION`
11. **맨 아래 따로**: `.danger-zone` 안에 "이 방에서 나가기" (`.text-btn.danger`, `data-action="leave-room"`). §4.9
    `.danger-zone`은 `gap:12px`, 그 안 버튼은 `flex:none; white-space:nowrap`(360px 폭에서도 버튼 글자가 줄바꿈되지 않게).

내 정보는 보러 여는 시트라 열 때 입력칸에 커서를 두지 않는다(✕ 버튼에 초점, 휴대폰 키보드가 바로 올라오지 않게). 어두운 화면에서는
시트 뒤를 `rgba(0,0,0,.62)`로 더 어둡게 하고 시트 위에 `--line-strong` 테두리를 그린다(시트 바탕이 화면 바탕과 같은 색이라).

### 4.7 멤버 색 그리기

- `MEMBER_COLORS = [{ id, name, light, dark }, …]` 40개(§2.6과 같은 순서·값). 시작할 때 `<style>`을 하나 만들어
  `.mc-<id>{--c:<light>}`와 `@media (prefers-color-scheme: dark){ .mc-<id>{--c:<dark>} }`를 넣는다.
- 공통 CSS: `.mc{--c-soft:var(--sunken);--c-soft:color-mix(in srgb,var(--c) 16%,var(--surface))}`, 어두운 화면은 24%.
  `.mc .dot,.dot.mc{background:var(--c)}`. `.mc-none{--c:var(--line-strong)}`(나간 멤버).
- `person(id)` → `{ name, cls: 'mc mc-<color>' 또는 'mc mc-none', me, owner }`. 이름 없으면 내 줄은 "나", 나간 사람은 "나간 멤버".
- 지우는 것: `.v1`/`.v2` 규칙, `.stamp.v1`/`.stamp.v2`, `--p1-ink`/`--p2-ink`(도장 글씨는 `var(--c)`), `ownerFirst()`(→ `memberOrder()`, 들어온 순서).
  `--p1`/`--p2`는 앱 강조색(버튼·링크·로고)으로 남는다.

### 4.8 후기 줄(방문 카드)

- 보기 상태: **후기를 쓴 멤버만** 들어온 순서로 줄(왼쪽 색 띠 = 그 멤버 색, 점 + 닉네임 + "나" 배지 + 별점 + 글).
  아무도 안 썼으면 한 줄 "아직 후기가 없어요."(빈 줄을 멤버마다 만들지 않음).
- 편집 상태: 내 줄만 입력칸(지금과 같음) + 다른 멤버 후기 줄은 보기 상태처럼.
- "방문 삭제"는 **다른 멤버 후기가 없을 때만**(`othersWrote`), 있으면 "내 후기 삭제"(DB 정책과 같음). 토스트 "다른 멤버의 후기가 있는 방문은 지울 수 없어요."

### 4.9 나가기

```text
멤버가 2명 이상:
  confirm(`‘${방 이름}’에서 나갈까요? 내가 남긴 후기와 월드컵 기록은 지워지고, 내가 담은 장소와 사진은 방에 남아요.`
          + (내가 방장 ? ' 방장은 가장 먼저 들어온 멤버에게 넘어가요.' : ''))
  → sb.rpc('leave_room', { p_couple }) → 토스트 '방에서 나왔어요.'
혼자 남음:
  confirm(`‘${방 이름}’에서 나가면 방이 없어져요. 장소·사진·후기·월드컵 기록이 모두 지워지고 되돌릴 수 없어요.`)
  → confirm(`정말 ‘${방 이름}’ 방을 지울까요?`)             (결정 7의 추가 확인)
  → paths = sb.rpc('begin_room_delete', { p_couple })          (이때부터 15분 동안 이 방 코드로 참여 불가)
  → 지금 방 장소 id 폴더('<장소 id>/…') 안의 경로만 남김(DB도 그렇게 돌려주지만 한 번 더)
  → 100개씩 sb.storage.from(BUCKET).remove(chunk), 하나라도 error면 멈추고 토스트
       '사진을 다 지우지 못했어요. 다시 시도해 주세요.' (방은 남음, 15분 뒤 다시 참여 가능)
  → sb.rpc('leave_room', { p_couple }) → room_deleted true → 토스트 '방을 지웠어요.'
뒤처리: ROOM_KEY에서 그 방 지움, 그 방을 rooms에서 뺌, resetRoomView(), state.roomId = chooseRoom(), applyRoom(), render(),
        refresh({ keepSheet: false })
        → 남은 방 1개면 바로 그 방(불러오는 중 화면, 방 고르기를 한 번도 보이지 않음), 2개 이상이면 방 선택 화면, 0개면 시작하기 (§4.3 그대로)
```

`not_last_member`(사진 지우기 전 다른 사람이 들어옴)면 토스트 "그사이 다른 멤버가 들어왔어요. 다시 확인해 주세요." 후 `refresh`.
`leave_room`이 `last_member`(멤버가 여럿인 줄 알고 나가기를 눌렀는데 그사이 다른 멤버가 모두 나감, 또는 처음 `refresh`가 실패해 멤버 수가 낡음)면
방은 지워지지 않고, 토스트 "그사이 다른 멤버가 모두 나갔어요. 다시 확인해 주세요." 후 `refresh`. 다시 누르면 혼자 남은 방의 두 번 확인 흐름이 된다.

### 4.10 황금 도장 빼기 (결정 10)

- `honorsOf`: 합치기 없이 **기록 하나 = 도장(또는 준우승 태그) 하나**, 그 기록을 한 멤버 색. 같은 곳을 여러 명이 골랐으면 도장이 여러 개(카드에는 첫 도장 + "+n").
  키는 `${list}:${r.id}:${r.played_at}`. `honorOrder`에서 `gold` 기준 삭제.
- `stampSvg`의 `h.gold` 갈래, `stampHtml`/`secondTag`의 "둘 다", 상세 `honors`의 "둘 다 1위", `cupView`의 "둘 다 1위! 황금 도장" 문구
  (→ 언제나 "`${honorTitle}` 1위 도장을 찍었어요."), `cupView`의 도장 찾기는 `x.user_id === uid()` 조건 추가.
- `recCard`: `both`·`gold-badge` 삭제. 줄은 **기록이 있는 멤버만** + 내가 안 했으면 내 줄("나도 하기"). 안내 "각자 고른 1위엔 그 사람 색 도장이 찍혀요."
- CSS·SVG 삭제: `--gold-ink`, `.stamp.gold`, `.tag.gold`, `.gold-badge`, `.rec.both`, `.win-msg b`(두 군데), `<linearGradient id="stamp-gold">`.
  `stamp-ink` 필터는 남긴다. 월드컵의 나머지(예선, 시드, 기록, 다시 하기, 역대 기록)는 그대로.

### 4.11 문구 (둘·상대·공간 → 멤버·방)

| 위치 | 지금 | 바꾼 뒤 |
|---|---|---|
| `person()` 이름 없음 | '상대' | '멤버' (나간 사람 '나간 멤버') |
| `viewOnboard` | '둘만의 공간을 연결해요', '한 사람이 공간을 만들고…', '새로 만들기', '공간 만들기' | §4.4 문구, '새 방 만들기', '방 만들기' |
| 메인 초대 띠 | '상대에게 초대 코드를 보내 주세요' | '친구에게 초대 코드를 보내 주세요' |
| 상세 메모 placeholder | '둘 다 고칠 수 있는 메모예요' | '멤버 모두 고칠 수 있는 메모예요' |
| 장소 삭제 확인 | '…두 사람의 후기도 함께 지워져요.' | '…멤버들의 후기도 함께 지워져요.' |
| 방문 삭제 토스트 | '상대 후기가 있는 방문은…' | '다른 멤버의 후기가 있는 방문은…' |
| 카테고리 안내 | '두 사람 모두에게 똑같이 보여요.' | '멤버 모두에게 똑같이 보여요.' |
| 설정 초대 코드 안내 | '상대가 참여하면 코드는 자동으로 사라져요.' | §4.6-3 |
| 가입 화면 안내·placeholder·오류 | '…공간을 만들어요', '8자리 공간 초대 코드', '8자리 공간 코드' | '…방을 만들어요', '8자리 방 초대 코드', '8자리 방 코드' |
| `joinViaServer` 문구 | '…코드로 참여할 수 없어요' 등 | 그대로(공간이라는 말 없음) |
| 토스트(가입·만들기·참여) | '공간에 들어왔어요', '둘만의 공간을 만들어요', '공간을 만들었어요', '공간에 참여했어요' | '방에 들어왔어요', '방을 만들거나 참여해요', '방을 만들었어요. 초대 코드를 보내 주세요.', '방에 들어왔어요.' |
| 설정 시트 제목 / 톱니 aria-label | '설정' | '내 정보' |
| 코드 주석 | '두 사람', '상대' | '멤버' (주석도 같이) |

`friendly()`에 추가·교체 (서버 `MSG`와 같은 글자):

```js
if (/invalid_code/.test(m)) return '초대 코드를 다시 확인해 주세요.';
if (/room_full/.test(m)) return '이 방은 이미 5명이 모두 찼어요.';
if (/too_many_rooms/.test(m)) return '방은 3개까지 들어갈 수 있어요. 다른 방에서 나간 뒤 다시 시도해 주세요.';
if (/not_owner/.test(m)) return '방 이름은 방장만 바꿀 수 있어요.';
if (/not_member/.test(m)) return '이 방의 멤버가 아니에요. 새로고침해 주세요.';
if (/not_last_member/.test(m)) return '그사이 다른 멤버가 들어왔어요. 다시 확인해 주세요.';
if (/color_taken/.test(m)) return '그 색은 다른 멤버가 쓰고 있어요. 다른 색을 골라 주세요.';
if (/invalid_color/.test(m)) return '없는 색이에요. 새로고침한 뒤 다시 골라 주세요.';
if (/invalid_room_name|couples_name_check/.test(m)) return '방 이름을 1~30자로 입력해 주세요.';
if (/invalid_display_name|couple_members_display_name_check/.test(m)) return '닉네임을 1~20자로 입력해 주세요.';
if (/couple_members\.color|rename_room|leave_room|set_member_color|begin_room_delete/.test(m) && /does not exist|schema cache|Could not find/i.test(m))
  return '그룹 기능용 SQL(supabase/groups.sql)을 먼저 실행해 주세요.';
// couple_full, already_in_couple 줄은 지움
```

이번 범위에서 **바꾸지 않는 것**: `<title>`, `og:*`, `meta description`("커플용" 포함), 로고(두 원), `apple-mobile-web-app-title` — 앱 이름 정리(plan.md 순서 3).
기본 카테고리 목록(`create_couple`)도 그대로.

### 4.12 버전

`const APP_VERSION = 'v0.1.0: 261022';` (주석의 형식 설명 그대로. README 업데이트 노트는 문서 담당이 같이)

---

## 5. 테스트 계획

### 5.1 SQL: PGlite (`dev/sqltest/`)

배포에 안 들어간다(server.cjs는 정해진 파일만 보냄). 운영·시험 Supabase 프로젝트에 연결하지 않는다.

```
dev/sqltest/package.json      { "private": true, "scripts": { "test": "node --test" },
                                "devDependencies": { "@electric-sql/pglite": "<설치 때 정확한 버전 고정>" } }   (package-lock.json 커밋, node_modules는 .gitignore)
dev/sqltest/stubs.sql         Supabase 흉내: 역할·auth·storage·extensions
dev/sqltest/helpers.cjs       새 DB 만들기, 파일 실행, asUser(uid, fn), asRole(role, fn), expectError(code, fn)
dev/sqltest/groups.test.cjs   아래 경우들
실행: cd dev/sqltest && npm ci && npm test
```

`stubs.sql`:
- `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`
- `create schema auth; create table auth.users (id uuid primary key, email text, raw_app_meta_data jsonb not null default '{}', raw_user_meta_data jsonb not null default '{}');`
- `create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`
- `create schema storage;` `storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[])`,
  `storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text)` + RLS 켬,
  `storage.foldername(name text) returns text[]` (마지막 조각을 뺀 `/` 나눔).
- `create schema extensions;` 그리고 PGlite contrib `pgcrypto`를 `create extension pgcrypto with schema extensions`로(안 되면 `extensions.gen_random_bytes(int)`를 `random()`으로 흉내 — 테스트 전용).
- `asUser`: 트랜잭션 안에서 `select set_config('request.jwt.claim.sub', $1, true); set local role authenticated;`.
  PGlite에서 `set role`이 안 되면 권한·RLS 경우만 건너뛰고(이유를 출력) 함수 경우는 superuser로 실행한다.

적용 순서: stubs → schema.sql → friends-keepalive.sql → friends-signup.sql → (기존 데이터 넣기) → groups.sql.
`groups.sql` 적용 전 `pg_get_functiondef`/제약 목록을 저장해 두고 되돌리기 뒤 비교한다.

| # | 확인할 것 |
|---|---|
| 1 | 빈 DB와 **기존 데이터 있는 DB**(방 A: owner+member, 코드 null / 방 B: owner만, 코드 있음 / 장소·방문·후기·사진·월드컵 기록) 둘 다 적용됨. A는 teal/amber, B owner는 teal. 모든 방에 `^[0-9A-F]{8}$` 코드. `one_couple_per_user` 없음 |
| 2 | `member_colors` 40행, id·순서가 index.html `MEMBER_COLORS`와 같음(테스트가 index.html을 읽어 비교). 두 번 적용하면 사전 확인에서 멈춤 |
| 3 | `create_couple`: 이름·닉네임 필수(빈칸·31자·21자 → 각 오류), owner 1명, 색은 목록 안, 카테고리 8개, 4번째 방 → `too_many_rooms`(만든 방 + 들어간 방 합쳐서) |
| 4 | `join_couple_for`: 틀린 코드 `invalid_code`, 5명까지 들어감, 6번째 `room_full`, 다 차도 코드 그대로, 같은 사람이 다시 → 같은 id·행 수 그대로, 4번째 방 `too_many_rooms`, 멤버 색 모두 다름, `p_user` null → `not_authenticated` |
| 5 | 트리거: superuser로 `couple_members`에 직접 넣어도 6번째·4번째 방이 막힘, `color` 없이 넣으면 빈 색이 들어감 |
| 6 | `space_code_open`: 4명 true, 5명 false, 없는 코드 false, `begin_room_delete` 뒤 false(15분 지난 것처럼 `deleting_at`을 과거로 바꾸면 다시 true) |
| 7 | `rename_room`: 방장 성공(앞뒤 공백 제거), 멤버 `not_owner`, 남 `not_member`, 빈칸·31자 `invalid_room_name` |
| 8 | `set_member_color`: 빈 색 성공, 남이 쓰는 색 `color_taken`, 없는 id `invalid_color`, 남 `not_member`, authenticated로 `update couple_members set color` → 권한 없음 |
| 9 | `leave_room`(멤버): 그 방 내 후기·월드컵 기록 삭제, **다른 방의 내 후기는 남음**, 장소·사진 행 남음, 내가 만든 빈 방문만 삭제, 다른 사람 후기 달린 방문 남음, 내 색을 다른 멤버가 바로 고를 수 있음 |
| 9b | 나간 뒤 남은 후기(나가기와 경쟁해 남은 것 흉내)는 나간 사람이 고칠 수 없음. 보기 정책이 안 걸리는 조건 없는 `update reviews set …`로 확인(예전 정책이면 고쳐짐). 멤버는 자기 후기를 그대로 고침 |
| 10 | `leave_room`(방장): 가장 먼저 들어온 남은 멤버가 owner, owner는 정확히 1명, `new_owner` 반환 |
| 11 | `leave_room`(마지막): 방과 카테고리·장소·방문·후기·사진 행·월드컵 기록·멤버가 모두 지워짐(`room_deleted: true`). `storage.objects`는 SQL이 건드리지 않음 |
| 11b | 혼자 남은 멤버가 `begin_room_delete` 없이(또는 15분 지나서) `leave_room` → `last_member`, 방·사진 행 그대로. 다시 `begin_room_delete` 뒤에는 지워짐 |
| 12 | `begin_room_delete`: 혼자일 때만(아니면 `not_last_member`), 경로 = `place_photos.path` 전부 + 그 장소 폴더 안의 `places.photo_path`, 그 뒤 `join_couple_for` → `invalid_code` |
| 12b | 나간 멤버가 알아 둔 다른 방 사진 경로: authenticated로 `places.photo_path` 고치기 → 권한 없음. 관리자로 넣어 둔 값이라도 `begin_room_delete`가 돌려주지 않음(그 장소 폴더 경로만) |
| 13 | 권한: anon은 새 함수 모두 실행 불가. authenticated는 `join_couple_for`·`space_code_open`·`join_couple`·`pick_member_color` 불가, `rename_room`·`set_member_color`·`begin_room_delete`·`leave_room`·`create_couple`·`groups_schema_version` 가능. 닉네임 `''`로 update → 제약 오류 |
| 14 | RLS: 방 A 멤버는 방 B의 couples·members·places·reviews·cup_results를 못 봄. 나간 뒤엔 방 A도 못 봄. 두 방 멤버는 두 방 다 봄. 방 조건 붙인 닉네임 update는 그 방만 바뀜 |
| 15 | groups.sql이 바꾸는 정책은 후기 고치기 하나뿐. 되돌리기: 두 방에 든 사람이 있으면 멈춤 → 한 방에서 나간 뒤 성공. 함수 본문·권한·제약·정책·열 권한이 적용 전 저장본과 같음, `color` 칸 없음, `backup.couple_members_colors_*` 있음, 2명 이상 방의 코드 null. 그 뒤 `groups.sql` 다시 적용 성공 |

PGlite는 연결이 하나라 동시 실행(잠금 경쟁)은 시험하지 못한다. 잠금 순서(§2.3)는 코드 리뷰로 확인하고, 나중에 로컬 Supabase(Docker)에서 두 연결로 한 번 확인한다.

### 5.2 서버: `node --test "deploy/home/*.test.cjs"`

`signup.test.cjs`의 가짜 Supabase를 고친다: `spaces`는 코드 → `{ id, n, deleting }`, `members`는 사용자 → `Set<방 id>`,
`join_couple_for`는 §2.5.1 순서(5명·3방·같은 방 다시 = 성공), `GET /rest/v1/couple_members`는 §3.1 경로(`couples.invite_code=eq.`)를 해석,
`POST /rest/v1/rpc/groups_schema_version`은 `1`.

추가·변경할 경우:
- 방 코드 가입 성공 → `joined: true`, `couple_id`. 가입 코드 성공 → `couple_id: null`.
- **성공은 코드 시도에 세지 않음**: 같은 IP에서 성공 3번 200, 4번째는 계정 만들기 제한으로 429(Supabase까지 안 감), 그래도 코드 시도(참여와 나눠 씀)는 5번 그대로.
- **계정 만들기 제한**: 방 코드 가입 → 나가기를 되풀이해도 같은 IP 4번째 429, 다른 IP는 됨. IP가 달라도 전체 하루 20개. 계정이 안 남는 실패(틀린 코드·약한 비번)는 안 셈.
  아이디 중복(409)은 코드 시도에는 안 세고 계정 수에는 셈(하루 3번 뒤 429).
- 실패는 그대로 셈(기존 경우 유지), 아이디 중복 등은 돌려줌(기존).
- `/api/join`: 이미 방 1–2개 있는 사람 성공 + `couple_id`, 같은 방 다시 200, `room_full` 400 + 5명 문구, `too_many_rooms` 409 + 3개 문구(셈), 성공은 안 셈.
- 응답 놓침: 그 코드 방에 들어갔으면 200 + `couple_id`, **다른 방에만 들어가 있으면 502**(예전 `isMember` 오류 재현 방지), 확인 못 하면 502.
- `verifySecretKey`: `groups_schema_version` 404 → `retry: false`, 이유에 `groups.sql`.
- `MSG` 값에 '두 사람'·'공간'이 없음, `MSG.joinFull`·`MSG.tooManyRooms`가 index.html `friendly()` 문구와 같음(파일을 읽어 비교).

### 5.3 화면: 가짜 Supabase로 찍어 보기 (`dev/mock/`)

- `dev/mock/serve.cjs`: `127.0.0.1:8099`에서 index.html을 보내되, supabase-js `<script …integrity…>` 줄을 `<script src="/dev/mock/supabase-mock.js">`로,
  `YOUR-PROJECT`/`YOUR_KEY`를 `https://mock.invalid`/`mock-key`로, `SIGNUP_ENABLED`를 true로 바꾼다. `/api/join`도 가짜로 받는다.
  (leak-check 규칙에 걸리는 모양의 값은 쓰지 않는다)
- `supabase-mock.js`: `window.supabase.createClient`가 메모리 데이터로 동작 — `auth`(getSession, onAuthStateChange, signInWithPassword, signOut, setSession, updateUser),
  `from(t).select/eq/order/limit/insert/update/delete/upsert/single`, `rpc`(§9의 함수들, 같은 오류 코드), `storage.from().createSignedUrls/upload/remove`(사진은 `data:` 이미지).
- 장면(`?mock=`): `onboard`(방 0개), `picker`(방 3개), `main5`(5명 방, 후기·도장 여러 색), `solo`(혼자, 초대 띠 보임), `settings-owner`, `settings-member`, `full`(5명, 코드 안내).
- 찍기: Edge(또는 Chromium) 헤드리스, 390×844, 밝은·어두운 화면 각각. 확인: 5명 이름이 줄바꿈되어도 겹치지 않음, 색 격자에 남이 쓰는 색 없음,
  초대 띠는 혼자일 때만, 도장 색이 고른 사람 색, 황금 도장·"둘 다" 문구 없음, 가로 스크롤 없음.
- 정적 확인(`dev/client-static.test.cjs`, `node --test`): `sb.from('places'|'categories'|'cup_results')` 조회마다 `.eq('couple_id'`가 있음, `.limit(1)` 없음,
  `MEMBER_COLORS` 40개·id 중복 없음·SQL과 같음, `gold`/`couple_full`/`already_in_couple`/`ownerFirst` 없음, `APP_VERSION === 'v0.1.0: 261022'`.

### 5.4 끝내기 전 확인

`node --test "deploy/home/*.test.cjs"`, `cd dev/sqltest && npm test`, `node --test dev/client-static.test.cjs`, 화면 장면 찍기,
leak-check 패턴(`scripts/leak-check.sh`의 grep들)을 작업 파일에 직접 돌려 통과. 줄 끝 LF.

---

## 6. 적용 방법 (주인이 할 일)

Supabase 대시보드 → SQL Editor에서 파일 내용을 통째로 붙여 넣고 Run. 파일마다 `begin; … commit;`이라 중간에 실패하면 아무것도 안 바뀐다.

**지금 친구용 프로젝트**(이미 `schema.sql` → `friends-keepalive.sql` → `friends-signup.sql`을 실행한 곳):

1. `supabase/groups.sql` **하나만** 실행. 맨 앞 확인에서 멈추면 메시지대로 먼저 처리한다(friends-signup.sql 미실행, 이미 적용됨 등).
2. 그다음 새 `index.html`·`deploy/home/signup.cjs`·`server.cjs`를 배포. 서버는 시작할 때 `groups_schema_version`을 확인하므로,
   SQL보다 먼저 배포하면 가입·참여가 꺼진 채로 뜬다(로그에 'groups.sql을 먼저 실행해 주세요'). SQL을 실행한 뒤 서버를 다시 시작하면 켜진다.

**새 프로젝트**: `schema.sql` → `friends-keepalive.sql` → `friends-signup.sql` → `groups.sql` 순서로 하나씩 실행
(pgcrypto가 없다는 메시지가 나오면 `create extension if not exists pgcrypto with schema extensions;`를 먼저 실행).

**되돌리기**: ① 홈 서버를 이전 릴리스(그룹 기능 전 index.html·signup.cjs)로 먼저 되돌림 → ② SQL Editor에서 `supabase/groups_rollback.sql` 실행.
두 개 이상의 방에 든 사람이 있으면 멈추므로, 그런 사람은 한 방만 남기고 나간 뒤 다시 실행한다. 멤버 색은 `backup.couple_members_colors_<시각>`에 남는다.
3~5명이 된 방은 그대로 남는다(예전 규칙으로는 새로 못 들어올 뿐). 다시 적용하려면 `groups.sql`을 그대로 실행하면 된다.

---

## 7. 범위 밖 (다음 단계)

공개 방(12–14), 앱·서비스 이름 정리, 계정 삭제(`created_by` NOT NULL 정리), 사진 썸네일, 방장 넘기기·내보내기·코드 다시 만들기(결정 6으로 안 함),
실시간 반영(Realtime), 기본 카테고리 목록 바꾸기.

---

## 8. 열어 둔 해석 (빌더는 이대로 하고, 주인이 다르게 원하면 바꿈)

1. 나간 멤버가 만든 **빈 방문**도 지운다(§2.5.2).
2. 로그인 직후에는 방 선택 화면, 앱을 다시 열면 마지막 방으로 바로(§4.3).
3. 별점 칩은 3명 이상인 방에서 줄인 모양(§4.5).
4. 마지막 멤버의 방 지우기 중 15분 동안 참여를 막는다(`deleting_at`, §4.9).
5. 계정 만들기 제한 숫자: IP마다 하루 3개, 전체 하루 20개(§3.1). 친구 여럿이 같은 와이파이에서 한꺼번에 가입하면 4번째부터 하루 동안 막히니,
   주인이 숫자를 정해 주면 `signup.cjs`의 `ACCOUNT_LIMITS`만 바꾸면 된다.

---

## 9. API 계약 (요약)

### 9.1 DB 함수 (PostgREST `rpc`)

오류는 HTTP 400 + `{ code: 'P0001', message: '<코드>' }`. 화면은 `friendly()`로 바꿔 보여 준다.

| 이름 | 부르는 쪽 | 인자 | 반환 | 오류 코드 |
|---|---|---|---|---|
| `create_couple` | 앱 (authenticated) | `{ p_display_name: text, p_couple_name: text }` | `uuid` | `not_authenticated` `invalid_display_name` `invalid_room_name` `too_many_rooms` |
| `join_couple_for` | 홈 서버 (service_role) | `{ p_user: uuid, p_invite_code: text, p_display_name: text }` | `uuid` (이미 그 방이면 같은 id) | `not_authenticated` `invalid_display_name` `invalid_code` `too_many_rooms` `room_full` |
| `join_couple` | (거둠. 본문은 `join_couple_for(auth.uid(), …)`) | `{ p_invite_code, p_display_name }` | `uuid` | 위와 같음 |
| `space_code_open` | 홈 서버 | `{ p_code: text }` | `boolean` | — |
| `rename_room` | 앱 | `{ p_couple: uuid, p_name: text }` | `text` | `not_authenticated` `not_member` `not_owner` `invalid_room_name` |
| `set_member_color` | 앱 | `{ p_couple: uuid, p_color: text }` | `text` | `not_authenticated` `not_member` `invalid_color` `color_taken` |
| `begin_room_delete` | 앱 | `{ p_couple: uuid }` | `text[]` 사진 경로(그 방 장소 폴더 안의 것만) | `not_authenticated` `not_member` `not_last_member` |
| `leave_room` | 앱 | `{ p_couple: uuid }` | `{ room_deleted: boolean, new_owner: uuid \| null }` | `not_authenticated` `not_member` `last_member`(혼자인데 15분 안에 `begin_room_delete`를 안 부름) |
| `groups_schema_version` | 앱·홈 서버 | `{}` | `integer` (1) | — |

제한 숫자: 방 5명, 사람 3방, 방 이름 1~30자, 닉네임 1~20자, 색 40개(`member_colors`), 초대 코드 `^[0-9A-F]{8}$`, 지우는 중 참여 막기 15분.

### 9.2 표 읽기·쓰기 (앱, RLS 그대로)

| 무엇 | 요청 |
|---|---|
| 내 방들 | `from('couples').select('id, name, invite_code, created_at').order('created_at')` |
| 내 방들의 멤버 | `from('couple_members').select('couple_id, user_id, display_name, role, color, created_at').order('created_at')` |
| 지금 방 장소 | `from('places').select('*, reviews(*), visits!visits_place_id_fkey(*), place_photos(*)').eq('couple_id', roomId).order('created_at', { ascending: false })` |
| 지금 방 카테고리 | `from('categories').select('id, name, position').eq('couple_id', roomId).order('position').order('created_at')` |
| 지금 방 월드컵 기록 | `from('cup_results').select('*').eq('couple_id', roomId).order('played_at', { ascending: false })` |
| 닉네임 바꾸기 | `from('couple_members').update({ display_name }).eq('couple_id', roomId).eq('user_id', uid())` |
| 색 칸 직접 쓰기 | **불가**(권한 없음) → `set_member_color` |
| `places.photo_path` 고치기 | **불가**(권한 거둠, v1.5부터 안 쓰는 칸) |
| 후기 고치기 | 내가 쓴 후기 + 지금 그 방 멤버일 때만 |

### 9.3 홈 서버 HTTP

| 요청 | 본문 | 성공 | 실패 |
|---|---|---|---|
| `POST /api/signup` | `{ code, username, password, displayName }` | 200 `{ access_token, refresh_token, joined: boolean, couple_id: string \| null }` | 400 `{ error }`(형식·코드·비번), 409 `{ error }`(아이디 중복), 429 `{ error }` + `Retry-After`, 502 `{ error }` |
| `POST /api/join` (`Authorization: Bearer <access_token>`) | `{ code, displayName }` | 200 `{ joined: true, couple_id: string }` | 400 `{ error: MSG.joinInvalid \| MSG.joinFull \| 형식 }`, 401 `{ error: MSG.login }`, 409 `{ error: MSG.tooManyRooms }`, 429, 502 `{ error: MSG.joinFailed }` |

시도 제한: 가입·참여를 합쳐 IP(/64)마다 1시간 5번, 전체 30번. **200 응답은 세지 않는다.** 아이디·비밀번호 때문에 실패한 가입도 세지 않는다.
나머지 실패(코드 틀림, 방 참, 방 3개 초과, 확인 실패)는 센다.
계정 만들기 제한(가입만): 계정이 남은 가입과 아이디 중복을 IP(/64)마다 하루 3번, 전체 하루 20번. 넘으면 429 + `Retry-After`.

### 9.4 화면 상수·키

`MAX_MEMBERS = 5`, `MAX_ROOMS = 3`, `MEMBER_COLORS`(§2.6), `ROOM_KEY = 'group-place:last-room'`(값 `userId:roomId`),
`SEEN_KEY = 'group-place:seen-stamps'`, 색 클래스 `mc mc-<id>` / `mc mc-none`, CSS 변수 `--c`·`--c-soft`, 주소 `?room=<uuid>`(선택),
시트 종류 `settings`(내 정보)·`room-new`(`mode: 'create' | 'join'`), `APP_VERSION = 'v0.1.0: 261022'`.
