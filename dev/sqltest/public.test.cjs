'use strict';
// supabase/public.sql·public_rollback.sql 시험 (docs/public-rooms-design.md §6.1의 P1~P16).
// 실행: cd dev/sqltest && npm ci && npm test
// PGlite는 연결이 하나라 동시 실행(잠금 경쟁)은 시험하지 못한다. 잠금 순서는 코드 리뷰로 확인(설계 §2.1).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SQL, uid, newDb, addUsers, run, asUser, ANON, SERVICE, expectError,
  createRoom, createPublicRoom, codeOf, members, count, snapshot,
} = require('./helpers.cjs');

const CODE_RE = /^[0-9A-F]{8}$/;
const KEY_RE = /^[a-km-np-z2-9]{10}$/;
const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MONTH_RE = /^\d{4}-\d{2}$/;
const PERM = /permission denied/;
const RLS = /row-level security/;

// ---------- 시험 데이터 넣기 (그 사용자로, RLS를 지나서) ----------
async function addPlace(db, n, room, name = '장소', extra = {}) {
  const [r] = await run(db, asUser(n),
    `insert into public.places (couple_id, name, category, created_by, address, naver_url, status, favorite, shared_note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [room, name, extra.category || '맛집', uid(n), extra.address ?? null, extra.url ?? null,
      extra.status || 'want_to_go', extra.favorite ?? false, extra.note ?? '']);
  return r.id;
}
async function addVisit(db, n, place, day = '2026-10-01') {
  const [r] = await run(db, asUser(n),
    'insert into public.visits (place_id, visited_on, created_by) values ($1, $2, $3) returning id', [place, day, uid(n)]);
  return r.id;
}
async function addReview(db, n, place, visit, rating = 4.5, body = '좋아요') {
  const [r] = await run(db, asUser(n),
    'insert into public.reviews (place_id, visit_id, author_id, rating, body) values ($1, $2, $3, $4, $5) returning id',
    [place, visit, uid(n), rating, body]);
  return r.id;
}
// 사진 한 장 (thumb: true면 '<place>/t/<file>' 썸네일 경로도).
// sizes가 있으면 저장소 파일(storage.objects, metadata.size)도 넣음: { path: 바이트, thumb: 바이트 } (null이면 그 파일은 안 넣음)
async function addPhoto(db, n, place, file, position = 0, thumb = true, sizes = null) {
  const p = `${place}/${file}`;
  const t = thumb ? `${place}/t/${file}` : null;
  await run(db, asUser(n), 'insert into public.place_photos (place_id, path, thumb_path, position, created_by) values ($1, $2, $3, $4, $5)',
    [place, p, t, position, uid(n)]);
  if (sizes) {
    for (const [name, size] of [[p, sizes.path], [t, sizes.thumb]]) {
      if (name && size != null) {
        await db.query("insert into storage.objects (bucket_id, name, metadata) values ('place-photos', $1, $2)", [name, JSON.stringify({ size })]);
      }
    }
  }
  return { path: p, thumb: t };
}
const SMALL = { path: 300_000, thumb: 20_000 }; // 앱이 올리는 보통 크기 (1080px·320px JPEG)
// 새 서버의 참여 (service_role)
async function joinFor(db, n, code, nick = `별명${n}`, ack = 1) {
  const [r] = await run(db, SERVICE, 'select public.join_room_for($1, $2, $3, $4) as r', [uid(n), code, nick, ack]);
  return r.r;
}
const view = async (db, key) => (await run(db, SERVICE, 'select public.public_room_view($1) as v', [key]))[0].v;
const list = async (db) => (await run(db, SERVICE, 'select public.public_room_list() as v'))[0].v;
const status = async (db, n) => (await run(db, asUser(n), 'select public.public_create_status() as s'))[0].s;
const keyOf = async (db, room) => (await db.query('select public_key from public.couples where id = $1', [room])).rows[0].public_key;
const acks = (db, n) => db.query('select couple_id, kind, version from public.public_room_acks where user_id = $1 order by id', [uid(n)]).then((r) => r.rows);
const sorted = (o) => Object.keys(o).sort();
// 후기 고친 시각을 옮김 (reviews_touch_updated_at 트리거가 now()로 덮어쓰므로 잠깐 끔, superuser)
async function setReviewTime(db, sqlTime) {
  await db.exec('alter table public.reviews disable trigger reviews_touch_updated_at');
  await db.query(`update public.reviews set updated_at = ${sqlTime}`);
  await db.exec('alter table public.reviews enable trigger reviews_touch_updated_at');
}
const createPrivate = async (db, n, name = '개인 방', nick = `별명${n}`) =>
  (await run(db, asUser(n), "select public.create_room($1, $2, 'private', null, null) as id", [nick, name]))[0].id;

// 설계 §2.6의 키 집합
const VIEW_KEYS = ['active', 'categories', 'description', 'key', 'member_count', 'members', 'name', 'place_count', 'places', 'truncated', 'v'];
const MEMBER_KEYS = ['color', 'm', 'name'];
const PLACE_KEYS = ['added_by', 'added_month', 'address', 'category', 'id', 'map_url', 'name', 'photo_count', 'photos', 'shared_note', 'status', 'visits'];
const VISIT_KEYS = ['month', 'reviews'];
const REVIEW_KEYS = ['body', 'by', 'rating'];
const PHOTO_KEYS = ['path', 'thumb'];
const LIST_KEYS = ['active', 'colors', 'description', 'key', 'member_count', 'name', 'place_count', 'review_count', 'visited_count'];

// ---------- P1. 적용 ----------
test('P1. 빈 DB·기존 데이터 DB에 적용, 기존 방은 개인 방, 두 번 적용·colors.sql 없이 실행하면 멈춤, 버전 1', async () => {
  const db = await newDb({ public: true });
  assert.equal((await run(db, SERVICE, 'select public.public_rooms_version() as v'))[0].v, 1);
  assert.equal((await run(db, asUser(1), 'select public.public_ack_version() as v'))[0].v, 1);
  assert.equal((await run(db, SERVICE, 'select public.public_ack_version() as v'))[0].v, 1);
  await expectError(db.exec(SQL('public.sql')), /이미 적용된 SQL이에요 \(couples\.visibility 칸이 있음\)/);
  await db.exec('rollback').catch(() => {});
  await db.close();

  // 기존 데이터: 방 두 개(장소·사진 포함) 위에 적용
  const old = await newDb({ colors: true });
  await addUsers(old, 1, 2);
  const a = await createRoom(old, 1, 'A');
  const b = await createRoom(old, 2, 'B');
  const p = await addPlace(old, 1, a);
  await run(old, asUser(1), 'insert into public.place_photos (place_id, path, created_by) values ($1, $2, $3)', [p, `${p}/a.jpg`, uid(1)]);
  const codes = [await codeOf(old, a), await codeOf(old, b)];
  await old.exec(SQL('public.sql'));
  const rows = (await old.query('select visibility, description, public_key, public_hidden_at from public.couples order by created_at')).rows;
  assert.deepEqual(rows, [
    { visibility: 'private', description: '', public_key: null, public_hidden_at: null },
    { visibility: 'private', description: '', public_key: null, public_hidden_at: null },
  ]);
  assert.deepEqual([await codeOf(old, a), await codeOf(old, b)], codes, '초대 코드 그대로');
  assert.equal((await old.query('select thumb_path from public.place_photos')).rows[0].thumb_path, null);
  assert.equal(await count(old, 'select 1 from public.public_room_acks'), 0);
  await old.close();

  // colors.sql 없이(groups.sql까지만) 실행하면 멈춤
  const noColors = await newDb();
  await expectError(noColors.exec(SQL('public.sql')), /먼저 supabase\/colors\.sql을 실행하세요/);
  await noColors.exec('rollback').catch(() => {});
  assert.equal(await count(noColors, "select 1 from information_schema.columns where table_name = 'couples' and column_name = 'visibility'"), 0);
  await noColors.close();
});

// ---------- P2. create_room ----------
test('P2. create_room: 개인 방·공개 방, 오류 코드와 확인 순서', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4);

  // 개인 방: 소개 '', 키 없음, 동의 기록 없음 (null·'' 소개 모두 받음)
  const priv = await createPrivate(db, 1, '개인');
  const [pr] = (await db.query('select visibility, description, public_key from public.couples where id = $1', [priv])).rows;
  assert.deepEqual(pr, { visibility: 'private', description: '', public_key: null });
  await run(db, asUser(1), "select public.create_room('별명', '개인2', 'private', '  ', 7)");
  assert.deepEqual(await acks(db, 1), []);

  // 공개 방: 키 형식, 방장, 카테고리 8개, 소개 앞뒤 공백 제거, 동의 기록 create/1
  const pub = (await run(db, asUser(2), "select public.create_room(' 지훈 ', ' 서울 라멘 지도 ', 'public', '  둘이 먹어 본 라멘집  ', 1) as id"))[0].id;
  const [c] = (await db.query('select name, visibility, description, public_key, invite_code from public.couples where id = $1', [pub])).rows;
  assert.equal(c.name, '서울 라멘 지도');
  assert.equal(c.visibility, 'public');
  assert.equal(c.description, '둘이 먹어 본 라멘집');
  assert.match(c.public_key, KEY_RE);
  assert.match(c.invite_code, CODE_RE);
  assert.deepEqual((await members(db, pub)).map((m) => [m.user_id, m.role, m.display_name]), [[uid(2), 'owner', '지훈']]);
  assert.equal(await count(db, 'select 1 from public.categories where couple_id = $1', [pub]), 8);
  assert.deepEqual(await acks(db, 2), [{ couple_id: pub, kind: 'create', version: 1 }]);

  // 오류 (각각 하나씩)
  const cr = (n, nick, name, vis, desc, ack) =>
    run(db, asUser(n), 'select public.create_room($1, $2, $3, $4, $5)', [nick, name, vis, desc, ack]);
  await expectError(cr(3, '닉', '방', 'secret', null, null), 'invalid_visibility');
  await expectError(cr(3, '닉', '방', null, null, null), 'invalid_visibility');
  await expectError(cr(3, '닉', '방', 'private', '소개', null), 'invalid_description');
  await expectError(cr(3, '닉', '방', 'public', 'ㄱ'.repeat(61), 1), 'invalid_description');
  await run(db, asUser(3), "select public.create_room('닉', '방', 'public', $1, 1)", ['ㄱ'.repeat(60)]); // 60자는 됨
  await expectError(cr(4, '닉', '방', 'public', '', null), 'ack_required');
  await expectError(cr(4, '닉', '방', 'public', '', 2), 'ack_required');
  await expectError(run(db, ANON, "select public.create_room('닉', '방', 'public', '', 1)"), PERM);
  // 확인 순서: 이름 → 닉네임 → 공개 범위 → 소개 → 닉네임=아이디 → 동의 → 한도
  await expectError(cr(4, '닉', '', 'secret', 'x', null), 'invalid_room_name');
  await expectError(cr(4, '', '방', 'secret', 'x', null), 'invalid_display_name');
  await expectError(cr(4, '닉', '방', 'secret', 'ㄱ'.repeat(61), null), 'invalid_visibility');
  await expectError(cr(4, 'U4', '방', 'public', 'ㄱ'.repeat(61), null), 'invalid_description');
  await expectError(cr(4, 'U4', '방', 'public', '', null), 'nickname_is_login_id');
  await expectError(cr(2, '닉', '방', 'public', '', null), 'ack_required'); // 2는 이미 공개 방장이지만 동의가 먼저
  await expectError(cr(2, '닉', '방', 'public', '', 1), 'public_owner_limit');
  assert.equal(await count(db, 'select 1 from public.public_room_acks where user_id = $1', [uid(4)]), 0, '실패하면 기록 없음');

  // 4번째 방은 too_many_rooms (공개 범위·동의보다 먼저)
  await createPrivate(db, 1, '개인3');
  await expectError(cr(1, '닉', '방', 'secret', 'x', null), 'too_many_rooms');
  await db.close();
});

// ---------- P3. 한도 ----------
test('P3. 한도: 방장인 공개 방 1개, 7일 간격(지운 방 포함), public_create_status가 같은 판단', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4);
  assert.deepEqual(await status(db, 1), { allowed: true, reason: null, next_at: null, ack_version: 1 });
  await expectError(run(db, ANON, 'select public.public_create_status()'), PERM);

  const a = await createPublicRoom(db, 1, 'A', '민수');
  assert.equal((await status(db, 1)).reason, 'public_owner_limit');
  await expectError(run(db, asUser(1), "select public.create_room('민수', 'B', 'public', '', 1)"), 'public_owner_limit');
  // 개인 방은 상관없음
  await createPrivate(db, 1, '개인');

  // 남의 공개 방 멤버인 것은 안 셈
  assert.equal((await joinFor(db, 2, await codeOf(db, a), '지훈')).status, 'joined');
  assert.deepEqual(await status(db, 2), { allowed: true, reason: null, next_at: null, ack_version: 1 });
  const b = await createPublicRoom(db, 2, 'B', '지훈');
  assert.ok(b);

  // 지우는 중인 방도 방장인 공개 방으로 셈 → 방을 지운 뒤에는 7일 간격(public_create_gap)
  const c = await createPublicRoom(db, 3, 'C', '서연');
  await run(db, asUser(3), 'select public.begin_room_delete($1)', [c]);
  await expectError(run(db, asUser(3), "select public.create_room('서연', 'D', 'public', '', 1)"), 'public_owner_limit');
  await run(db, asUser(3), 'select public.leave_room($1)', [c]);
  assert.equal(await count(db, 'select 1 from public.couples where id = $1', [c]), 0, '방은 지워짐');
  assert.deepEqual(await acks(db, 3), [{ couple_id: c, kind: 'create', version: 1 }], '동의 기록은 남음');
  await expectError(run(db, asUser(3), "select public.create_room('서연', 'D', 'public', '', 1)"), 'public_create_gap');
  const st = await status(db, 3);
  assert.equal(st.allowed, false);
  assert.equal(st.reason, 'public_create_gap');
  assert.match(st.next_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  const [ackAt] = (await db.query("select acked_at from public.public_room_acks where user_id = $1 and kind = 'create'", [uid(3)])).rows;
  assert.ok(Math.abs(Date.parse(st.next_at) - (ackAt.acked_at.getTime() + 7 * 864e5)) < 1000, 'next_at = 마지막 기록 + 7일');
  // 개인 방은 간격과 상관없음
  await createPrivate(db, 3, '개인');
  // 기록을 8일 전으로 옮기면 다시 됨
  await db.query("update public.public_room_acks set acked_at = now() - interval '8 days' where user_id = $1", [uid(3)]);
  assert.equal((await status(db, 3)).allowed, true);
  await createPublicRoom(db, 3, 'D', '서연');

  // 방장이 나가 방장이 바뀌면 예전 방장은 다시 만들 수 있음(간격만 지나면)
  await run(db, asUser(1), 'select public.leave_room($1)', [a]);
  assert.equal((await members(db, a))[0].role, 'owner');
  assert.equal((await status(db, 1)).reason, 'public_create_gap');

  // 방 3개면 too_many_rooms가 먼저
  await createPrivate(db, 4, '1'); await createPrivate(db, 4, '2'); await createPrivate(db, 4, '3');
  assert.equal((await status(db, 4)).reason, 'too_many_rooms');
  await db.close();
});

test('P3b. 한도: 전체 공개 방 30개(숨김 포함)면 public_rooms_full', async () => {
  const db = await newDb({ public: true });
  const ns = Array.from({ length: 31 }, (_, i) => 101 + i);
  await addUsers(db, ...ns);
  for (const n of ns.slice(0, 29)) await createPublicRoom(db, n, `방${n}`, `별${n}`);
  assert.equal((await status(db, 131)).allowed, true, '29개면 아직 됨');
  const last = await createPublicRoom(db, 130, '방130', '별130');
  assert.equal(await count(db, "select 1 from public.couples where visibility = 'public'"), 30);
  await expectError(run(db, asUser(131), "select public.create_room('별', '방', 'public', '', 1)"), 'public_rooms_full');
  assert.equal((await status(db, 131)).reason, 'public_rooms_full');
  // 숨긴 방도 셈
  assert.equal((await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true) as ok', [await keyOf(db, last)]))[0].ok, true);
  await expectError(run(db, asUser(131), "select public.create_room('별', '방', 'public', '', 1)"), 'public_rooms_full');
  // 개인 방은 됨
  await createPrivate(db, 131);
  await db.close();
});

// ---------- P4. 바꾸기 금지 ----------
test('P4. 공개 범위·공개 키는 superuser·service_role도 못 바꿈, 이름·숨김·코드·소개는 바뀜', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2);
  const pub = await createPublicRoom(db, 1, 'A', '민수');
  const priv = await createPrivate(db, 2, 'B');
  const key = await keyOf(db, pub);

  await expectError(db.query("update public.couples set visibility = 'private', public_key = null where id = $1", [pub]), 'visibility_immutable');
  await expectError(run(db, SERVICE, "update public.couples set visibility = 'private', public_key = null where id = $1", [pub]), 'visibility_immutable');
  await expectError(run(db, SERVICE, "update public.couples set visibility = 'public', public_key = 'abcdefghij' where id = $1", [priv]), 'visibility_immutable');
  await expectError(run(db, SERVICE, "update public.couples set public_key = 'abcdefghij' where id = $1", [pub]), 'public_key_immutable');
  await expectError(run(db, asUser(1), "update public.couples set visibility = 'private' where id = $1", [pub]), PERM);
  await expectError(run(db, asUser(1), 'update public.couples set public_hidden_at = null where id = $1', [pub]), PERM);
  await expectError(run(db, asUser(1), "update public.couples set description = 'x' where id = $1", [pub]), PERM);
  assert.equal(await keyOf(db, pub), key);

  await run(db, asUser(1), "select public.rename_room($1, '새 이름')", [pub]);
  await run(db, asUser(1), "select public.set_room_description($1, '소개')", [pub]);
  await run(db, asUser(1), 'select public.regenerate_invite_code($1)', [pub]);
  assert.equal((await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true) as ok', [key]))[0].ok, true);
  const [r] = (await db.query('select name, description, visibility, public_key, public_hidden_at from public.couples where id = $1', [pub])).rows;
  assert.equal(r.name, '새 이름');
  assert.equal(r.description, '소개');
  assert.equal(r.visibility, 'public');
  assert.equal(r.public_key, key);
  assert.ok(r.public_hidden_at instanceof Date);
  // 다시 숨겨도 숨긴 시각은 그대로, 보이기는 null. 없는 키·개인 방은 false
  assert.equal((await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true) as ok', [key]))[0].ok, true);
  assert.equal((await db.query('select public_hidden_at from public.couples where id = $1', [pub])).rows[0].public_hidden_at.getTime(), r.public_hidden_at.getTime());
  assert.equal((await run(db, SERVICE, 'select public.admin_set_room_hidden($1, false) as ok', [key]))[0].ok, true);
  assert.equal((await db.query('select public_hidden_at from public.couples where id = $1', [pub])).rows[0].public_hidden_at, null);
  assert.equal((await run(db, SERVICE, "select public.admin_set_room_hidden('aaaaaaaaaa', true) as ok"))[0].ok, false);
  // 제약: 개인 방에 소개를 넣을 수 없음 (트리거보다 앞서 제약이 막는 경우도)
  await expectError(run(db, SERVICE, "update public.couples set description = 'x' where id = $1", [priv]), /couples_description_check/);
  // 관리자 목록
  const adm = await run(db, SERVICE, 'select * from public.admin_public_rooms()');
  assert.equal(adm.length, 1);
  assert.deepEqual(Object.keys(adm[0]).sort(), ['created_at', 'hidden_at', 'key', 'members', 'name', 'places']);
  assert.equal(adm[0].key, key);
  assert.equal(adm[0].members, 1);
  assert.equal(adm[0].hidden_at, null);
  assert.match(adm[0].created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await db.close();
});

// ---------- P5. join_room_for ----------
test('P5. join_room_for: 개인·공개 방, 이미 멤버, 확인 순서(방 참이 먼저), 동의 경로, 지우는 중', async () => {
  const db = await newDb({ public: true });
  const ns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  await addUsers(db, ...ns);
  const priv = await createPrivate(db, 1, '개인');
  const code = await codeOf(db, priv);

  const r1 = await joinFor(db, 2, ` ${code.toLowerCase()} `, '지훈', null);
  assert.deepEqual(r1, { status: 'joined', couple_id: priv, public: false });
  const r2 = await joinFor(db, 2, code, '다른 닉', null);
  assert.deepEqual(r2, { status: 'already_member', couple_id: priv, public: false });
  assert.equal((await members(db, priv)).length, 2);
  assert.equal((await members(db, priv))[1].display_name, '지훈', '이미 멤버면 아무것도 안 바꿈');
  assert.deepEqual(await acks(db, 2), [], '개인 방은 동의 기록 없음');
  await expectError(joinFor(db, 3, 'FFFFFFFF'), 'invalid_code');
  await expectError(joinFor(db, 3, code, '  '), 'invalid_display_name');
  await expectError(run(db, SERVICE, 'select public.join_room_for(null, $1, $2, null)', [code, '닉']), 'not_authenticated');

  // 공개 방: 동의 없음 → need_ack (아무것도 안 바뀜), 버전 2 → need_ack, 버전 1 → joined + 동의 기록 join
  const pub = await createPublicRoom(db, 1, '서울 라멘 지도', '민수');
  const pcode = await codeOf(db, pub);
  const before = await count(db, 'select 1 from public.couple_members');
  for (const ack of [null, 2]) {
    const r = await joinFor(db, 3, pcode, '서연', ack);
    assert.deepEqual(r, { status: 'need_ack', couple_id: null, public: true, room_name: '서울 라멘 지도', ack_version: 1 });
  }
  assert.equal(await count(db, 'select 1 from public.couple_members'), before);
  assert.deepEqual(await acks(db, 3), []);
  assert.deepEqual(await joinFor(db, 3, pcode, '서연', 1), { status: 'joined', couple_id: pub, public: true });
  assert.deepEqual(await acks(db, 3), [{ couple_id: pub, kind: 'join', version: 1 }]);
  // 이미 멤버면 동의 없이도 already_member (기록은 늘지 않음)
  assert.deepEqual(await joinFor(db, 3, pcode, '서연', null), { status: 'already_member', couple_id: pub, public: true });
  assert.equal((await acks(db, 3)).length, 1);
  // 나가도 동의 기록은 남음
  await run(db, asUser(3), 'select public.leave_room($1)', [pub]);
  assert.equal((await acks(db, 3)).length, 1);

  // 방이 다 찼고(5명) 들어오려는 사람도 방 3개 → room_full (방 참을 먼저 봄)
  const full = await createPrivate(db, 4, '찬 방');
  for (const n of [5, 6, 7, 8]) await joinFor(db, n, await codeOf(db, full));
  for (let i = 0; i < 3; i++) await createPrivate(db, 9, `방${i}`);
  await expectError(joinFor(db, 9, await codeOf(db, full)), 'room_full');
  // 방 3개면 too_many_rooms
  await expectError(joinFor(db, 9, code), 'too_many_rooms');
  // 공개 방이 다 찼으면 동의보다 room_full이 먼저 (need_ack가 아님)
  const pfull = await createPublicRoom(db, 10, '찬 공개 방', '별10');
  for (const n of [5, 6, 7, 8]) await joinFor(db, n, await codeOf(db, pfull));
  await expectError(joinFor(db, 11, await codeOf(db, pfull), '별11', null), 'room_full');

  // 지우는 중인 방(15분 안)은 invalid_code, 15분이 지나면 다시 받음
  const del = await createPrivate(db, 11, '지울 방');
  await run(db, asUser(11), 'select public.begin_room_delete($1)', [del]);
  await expectError(joinFor(db, 2, await codeOf(db, del)), 'invalid_code');
  await db.query("update public.couples set deleting_at = now() - interval '16 minutes' where id = $1", [del]);
  assert.equal((await joinFor(db, 2, await codeOf(db, del))).status, 'joined');
  await db.close();
});

// ---------- P6. 닉네임 = 로그인 아이디 ----------
test('P6. 공개 방에서는 닉네임이 로그인 아이디와 같으면 막음(대소문자·전각·보이지 않는 글자 무시), 글자 검사, 개인 방은 됨', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4);
  // 사용자 1: app_metadata.username 'minsu' (이메일 앞부분 u1은 아이디가 아님), 나머지는 이메일 앞부분(u2 등)
  await db.query(`update auth.users set raw_app_meta_data = '{"username": "minsu"}' where id = $1`, [uid(1)]);

  await expectError(run(db, asUser(1), "select public.create_room('MinSu', '방', 'public', '', 1)"), 'nickname_is_login_id');
  await expectError(run(db, asUser(1), "select public.create_room(' minsu ', '방', 'public', '', 1)"), 'nickname_is_login_id');
  const pub = (await run(db, asUser(1), "select public.create_room('u1', '방', 'public', '', 1) as id"))[0].id; // 이메일 앞부분은 아이디가 아님
  await expectError(joinFor(db, 2, await codeOf(db, pub), 'U2'), 'nickname_is_login_id');
  await expectError(joinFor(db, 2, await codeOf(db, pub), 'U2', null), 'nickname_is_login_id'); // 동의보다 먼저
  assert.equal((await joinFor(db, 2, await codeOf(db, pub), '지훈')).status, 'joined');

  // 공개 방에서 닉네임을 아이디로 바꾸기 (앱 update, 트리거)
  await expectError(run(db, asUser(2), "update public.couple_members set display_name = 'u2' where couple_id = $1 and user_id = $2", [pub, uid(2)]), 'nickname_is_login_id');
  await expectError(run(db, asUser(1), "update public.couple_members set display_name = 'MINSU' where couple_id = $1 and user_id = $2", [pub, uid(1)]), 'nickname_is_login_id');
  await run(db, asUser(2), "update public.couple_members set display_name = '지훈2' where couple_id = $1 and user_id = $2", [pub, uid(2)]);

  // 개인 방은 상관없음 (만들기·참여·바꾸기)
  const priv = await createPrivate(db, 3, '개인', 'u3');
  assert.equal((await joinFor(db, 4, await codeOf(db, priv), 'U4', null)).status, 'joined');
  await run(db, asUser(1), "select public.create_room('minsu', '개인', 'private', null, null)");
  await run(db, asUser(3), "update public.couple_members set display_name = 'U3' where couple_id = $1 and user_id = $2", [priv, uid(3)]);
  // 직접 넣어도(superuser) 트리거가 막음
  await expectError(db.query("insert into public.couple_members (couple_id, user_id, display_name) values ($1, $2, 'u4')", [pub, uid(4)]), 'nickname_is_login_id');

  // 아이디처럼 보이는 닉네임: 전각 글자(NFKC), 보이지 않는 글자(U+200B·U+200D·U+2060)도 아이디와 같다고 봄
  for (const nick of ['ｍｉｎｓｕ', 'MＩＮＳＵ', 'min\u200dsu']) {
    await expectError(run(db, asUser(1), 'update public.couple_members set display_name = $3 where couple_id = $1 and user_id = $2', [pub, uid(1), nick]), 'nickname_is_login_id');
  }
  await expectError(joinFor(db, 4, await codeOf(db, pub), 'Ｕ４'), 'nickname_is_login_id');
  // 공개 방 닉네임에는 보이지 않는 글자·방향 바꾸는 글자를 못 씀 (U+200D 이모지 잇기는 됨)
  for (const nick of ['min\u200bsu', 'a\u202eb', 'a\u2066b', '\ufeff별명', 'a\u0007b']) {
    await expectError(joinFor(db, 4, await codeOf(db, pub), nick), 'invalid_display_name');
    await expectError(run(db, asUser(2), 'update public.couple_members set display_name = $3 where couple_id = $1 and user_id = $2', [pub, uid(2), nick]), 'invalid_display_name');
  }
  await run(db, asUser(2), 'update public.couple_members set display_name = $3 where couple_id = $1 and user_id = $2', [pub, uid(2), '\u{1F468}\u200d\u{1F373}']);
  // 개인 방은 그대로 (글자 검사 없음)
  await run(db, asUser(3), 'update public.couple_members set display_name = $3 where couple_id = $1 and user_id = $2', [priv, uid(3), 'u\u200b3']);
  await db.close();
});

test('P6b. 공개 방 이름·소개에는 보이지 않는 글자·방향 바꾸는 글자를 못 씀 (만들기·이름 바꾸기·소개), 개인 방은 그대로', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2);
  for (const bad of ['서울\u202e도지', '\u200b라멘', '라멘\u2069', 'a\u0001b']) {
    await expectError(run(db, asUser(1), "select public.create_room('민수', $1, 'public', '', 1)", [bad]), 'invalid_room_name');
    await expectError(run(db, asUser(1), "select public.create_room('민수', '방', 'public', $1, 1)", [bad]), 'invalid_description');
  }
  await expectError(run(db, asUser(1), "select public.create_room($1, '방', 'public', '', 1)", ['민\u200f수']), 'invalid_display_name');
  const pub = await createPublicRoom(db, 1, '공개', '민수');
  await expectError(run(db, asUser(1), 'select public.rename_room($1, $2)', [pub, '공개\u202d']), 'invalid_room_name');
  await expectError(run(db, asUser(1), 'select public.set_room_description($1, $2)', [pub, '소개\u2066x']), 'invalid_description');
  // superuser가 직접 바꿔도 트리거가 막음
  await expectError(db.query('update public.couples set name = $2 where id = $1', [pub, '\u202e공개']), 'invalid_room_name');
  // 보통 글자·이모지는 됨
  await run(db, asUser(1), 'select public.rename_room($1, $2)', [pub, '서울 라멘 \u{1F35C}']);
  // 개인 방은 검사하지 않음
  const priv = await createPrivate(db, 2, '개인\u200b방');
  await run(db, asUser(2), 'select public.rename_room($1, $2)', [priv, '개인\u202e방']);
  await db.close();
});

// ---------- P7. 기존 함수 ----------
test('P7. join_couple_for는 공개 방이면 ack_required, create_couple은 늘 개인 방, space_code_open 그대로, space_code_info 모양', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4, 5, 6, 7);
  const priv = await createRoom(db, 1, '개인');
  const [p] = (await db.query('select visibility, description, public_key from public.couples where id = $1', [priv])).rows;
  assert.deepEqual(p, { visibility: 'private', description: '', public_key: null });
  const pub = await createPublicRoom(db, 2, '서울 라멘 지도', '지훈');

  assert.equal((await run(db, SERVICE, 'select public.join_couple_for($1, $2, $3) as id', [uid(3), await codeOf(db, priv), '서연']))[0].id, priv);
  await expectError(run(db, SERVICE, 'select public.join_couple_for($1, $2, $3)', [uid(3), await codeOf(db, pub), '서연']), 'ack_required');
  assert.equal((await members(db, pub)).length, 1);
  // 이미 멤버면 공개 방이어도 그 방 id (예전과 같음)
  assert.equal((await run(db, SERVICE, 'select public.join_couple_for($1, $2, $3) as id', [uid(2), await codeOf(db, pub), '지훈']))[0].id, pub);

  const open = async (c) => (await run(db, SERVICE, 'select public.space_code_open($1) as v', [c]))[0].v;
  const info = async (c) => (await run(db, SERVICE, 'select public.space_code_info($1) as v', [c]))[0].v;
  assert.equal(await open(await codeOf(db, pub)), true);
  assert.deepEqual(await info('FFFFFFFF'), { open: false, public: false, room_name: null, ack_version: 1 });
  assert.deepEqual(await info(null), { open: false, public: false, room_name: null, ack_version: 1 });
  assert.deepEqual(await info(await codeOf(db, priv)), { open: true, public: false, room_name: null, ack_version: 1 });
  assert.deepEqual(await info(` ${(await codeOf(db, pub)).toLowerCase()} `), { open: true, public: true, room_name: '서울 라멘 지도', ack_version: 1 });
  // 다 찬 공개 방은 닫힘 (공개 방인지도 알려 주지 않음)
  for (const n of [3, 4, 5, 6]) await joinFor(db, n, await codeOf(db, pub));
  assert.equal(await open(await codeOf(db, pub)), false);
  assert.deepEqual(await info(await codeOf(db, pub)), { open: false, public: false, room_name: null, ack_version: 1 });
  await db.close();
});

// ---------- P8~P11. public_room_view ----------
// 방 하나: 민수(1, 방장), 지훈(2), 서연(3). 장소 2곳(하나는 찜), 방문·후기, 사진 5장
async function richRoom(db) {
  await addUsers(db, 1, 2, 3, 9);
  const room = await createPublicRoom(db, 1, '서울 라멘 지도', '민수', '둘이 먹어 본 서울 라멘집');
  await joinFor(db, 2, await codeOf(db, room), '지훈');
  await joinFor(db, 3, await codeOf(db, room), '서연');
  const p1 = await addPlace(db, 1, room, '멘야 하나',
    { address: '서울 어딘가 1', url: 'https://naver.me/x', status: 'visited', favorite: true, note: '토요일 11시 오픈런' });
  const p2 = await addPlace(db, 2, room, '라멘 둘', { category: '카페' });
  const v1 = await addVisit(db, 2, p1, '2026-10-03');
  const v0 = await addVisit(db, 1, p1, '2026-09-12');
  await addReview(db, 3, p1, v1, 4, '진함');
  await addReview(db, 2, p1, v1, 4.5, '국물이 진함');
  await addReview(db, 1, p1, v0, null, '');
  const photos = [];
  for (let i = 0; i < 5; i++) photos.push(await addPhoto(db, 1, p1, `f${i}.jpg`, 4 - i, i !== 3, SMALL));
  return { room, p1, p2, v1, v0, photos };
}

test('P8. public_room_view 허용 목록: 키 집합이 정확히 같음, 초대 코드·uuid·이메일·찜 없음, 함께 쓰는 메모 있음', async () => {
  const db = await newDb({ public: true });
  const { room, p1, p2 } = await richRoom(db);
  const oldCode = await codeOf(db, room);
  await run(db, asUser(1), 'select public.regenerate_invite_code($1)', [room]);
  const key = await keyOf(db, room);
  const v = await view(db, key);

  assert.deepEqual(sorted(v), VIEW_KEYS);
  assert.equal(v.v, 1);
  assert.equal(v.key, key);
  assert.equal(v.name, '서울 라멘 지도');
  assert.equal(v.description, '둘이 먹어 본 서울 라멘집');
  assert.equal(v.member_count, 3);
  assert.equal(v.place_count, 2);
  assert.equal(v.truncated, false);
  assert.equal(v.active, 'week');
  assert.deepEqual(v.categories, ['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타']);
  for (const m of v.members) assert.deepEqual(sorted(m), MEMBER_KEYS);
  assert.deepEqual(v.members.map((m) => [m.m, m.name]), [['m1', '민수'], ['m2', '지훈'], ['m3', '서연']]);
  const colors = (await members(db, room)).map((m) => m.color);
  assert.deepEqual(v.members.map((m) => m.color), colors);
  assert.equal(v.places.length, 2);
  for (const p of v.places) {
    assert.deepEqual(sorted(p), PLACE_KEYS, '찜한 장소도 다른 장소와 키가 같음');
    for (const vi of p.visits) {
      assert.deepEqual(sorted(vi), VISIT_KEYS);
      for (const r of vi.reviews) assert.deepEqual(sorted(r), REVIEW_KEYS);
    }
    for (const ph of p.photos) assert.deepEqual(sorted(ph), PHOTO_KEYS);
  }
  const a = v.places.find((p) => p.id === p1);
  const b = v.places.find((p) => p.id === p2);
  assert.equal(a.shared_note, '토요일 11시 오픈런');
  assert.equal(a.address, '서울 어딘가 1');
  assert.equal(a.map_url, 'https://naver.me/x');
  assert.equal(a.status, 'visited');
  assert.equal(a.category, '맛집');
  assert.equal(a.added_by, 'm1');
  assert.equal(b.added_by, 'm2');
  assert.equal(b.address, null);
  assert.equal(b.map_url, null);
  assert.equal(b.shared_note, '');
  assert.equal(b.category, '카페');

  const s = JSON.stringify(v);
  for (const secret of [oldCode, await codeOf(db, room), room, uid(1), uid(2), uid(3)]) {
    assert.ok(!s.includes(secret), `응답에 ${secret}가 있으면 안 됨`);
  }
  assert.ok(!s.toUpperCase().includes((await codeOf(db, room)).toUpperCase()));
  for (const word of ['@', 'favorite', 'invite', 'owner', 'role', 'created_by', 'user_id', 'couple_id', 'hidden', 'updated_at', 'example.invalid']) {
    assert.ok(!s.includes(word), `응답에 '${word}'가 있으면 안 됨`);
  }
  await db.close();
});

test('P9. 날짜는 월까지(KST), 정확한 날짜·시각 모양 문자열 없음', async () => {
  const db = await newDb({ public: true });
  const { room, p1, p2 } = await richRoom(db);
  // KST 경계: UTC 15:30 = 다음 날 KST, UTC 14:59 = 같은 날
  await db.query("update public.places set created_at = '2026-09-30T15:30:00Z' where id = $1", [p1]);
  await db.query("update public.places set created_at = '2026-09-30T14:59:00Z' where id = $1", [p2]);
  const v = await view(db, await keyOf(db, room));
  const a = v.places.find((p) => p.id === p1);
  const b = v.places.find((p) => p.id === p2);
  assert.equal(a.added_month, '2026-10');
  assert.equal(b.added_month, '2026-09');
  assert.deepEqual(a.visits.map((x) => x.month), ['2026-10', '2026-09'], '방문은 최근 날짜부터');
  for (const p of v.places) {
    assert.match(p.added_month, MONTH_RE);
    for (const x of p.visits) assert.match(x.month, MONTH_RE);
  }
  const s = JSON.stringify(v);
  assert.doesNotMatch(s, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(s, /\d{2}:\d{2}/);
  assert.doesNotMatch(s, /2026-10-03|2026-09-12/);
  await db.close();
});

test('P10. 예전 멤버: 나간 사람 것은 null, 남은 사람 번호는 들어온 순서, 방장 표시 없음, 후기 순서', async () => {
  const db = await newDb({ public: true });
  const { room, p1, p2, v1 } = await richRoom(db);
  const key = await keyOf(db, room);
  let v = await view(db, key);
  // 후기: 멤버 들어온 순서 (m2 지훈 → m3 서연), 방문 v0의 별점 없는 후기는 rating null
  const a0 = v.places.find((p) => p.id === p1);
  assert.deepEqual(a0.visits[0].reviews, [{ by: 'm2', rating: 4.5, body: '국물이 진함' }, { by: 'm3', rating: 4, body: '진함' }]);
  assert.deepEqual(a0.visits[1].reviews, [{ by: 'm1', rating: null, body: '' }]);

  // 지훈(2) 나감 → 지훈이 담은 장소 added_by null, 남은 사람은 m1 민수, m2 서연
  await run(db, asUser(2), 'select public.leave_room($1)', [room]);
  // 멤버가 아닌 사람의 후기(있을 수 없지만 데이터로 넣음)는 by null로 맨 뒤
  await db.query('insert into public.reviews (place_id, visit_id, author_id, rating, body) values ($1, $2, $3, 3, $4)', [p1, v1, uid(9), '예전']);
  v = await view(db, key);
  assert.deepEqual(v.members.map((m) => [m.m, m.name]), [['m1', '민수'], ['m2', '서연']]);
  assert.equal(v.places.find((p) => p.id === p2).added_by, null);
  const a = v.places.find((p) => p.id === p1);
  assert.equal(a.added_by, 'm1');
  assert.deepEqual(a.visits.find((x) => x.month === '2026-10').reviews.map((r) => [r.by, r.body]), [['m2', '진함'], [null, '예전']]);

  // 방장(민수) 나감 → 서연이 방장이 되지만 응답에는 방장 표시 없이 m1
  await run(db, asUser(1), 'select public.leave_room($1)', [room]);
  v = await view(db, key);
  assert.deepEqual(v.members, [{ m: 'm1', name: '서연', color: v.members[0].color }]);
  assert.equal(v.member_count, 1);
  assert.equal(v.places.find((p) => p.id === p1).added_by, null);
  assert.ok(!JSON.stringify(v).includes('owner'));
  await db.close();
});

test('P11. 사진은 앞의 3장(순서대로)과 전체 장 수, 썸네일 null 가능, 300곳 넘으면 truncated', async () => {
  const db = await newDb({ public: true });
  const { room, p1, p2, photos } = await richRoom(db);
  const key = await keyOf(db, room);
  const v = await view(db, key);
  const a = v.places.find((p) => p.id === p1);
  assert.equal(a.photo_count, 5);
  // position: f0=4, f1=3, f2=2, f3=1(썸네일 없음), f4=0 → f4, f3, f2
  assert.deepEqual(a.photos, [
    { path: photos[4].path, thumb: photos[4].thumb },
    { path: photos[3].path, thumb: null },
    { path: photos[2].path, thumb: photos[2].thumb },
  ]);
  const b = v.places.find((p) => p.id === p2);
  assert.equal(b.photo_count, 0);
  assert.deepEqual(b.photos, []);
  assert.deepEqual(b.visits, []);

  // 장소 301곳 → 300곳만, truncated
  await db.query(`insert into public.places (couple_id, name, category, created_by)
                  select $1, '장소' || g, '기타', $2 from generate_series(1, 299) g`, [room, uid(1)]);
  const w = await view(db, key);
  assert.equal(w.place_count, 301);
  assert.equal(w.places.length, 300);
  assert.equal(w.truncated, true);
  // 정렬: 가장 최근 활동(방문·후기 포함) 순. p1은 방문·후기가 있어도 새로 넣은 장소보다 앞이거나 뒤일 수 있으므로 정렬만 확인
  await db.query("update public.places set created_at = now() - interval '30 days' where couple_id = $1", [room]);
  await db.query("update public.visits set created_at = now() - interval '30 days'");
  await setReviewTime(db, "now() - interval '30 days'");
  await db.query("update public.places set created_at = now() where id = $1", [p2]);
  const x = await view(db, key);
  assert.equal(x.places[0].id, p2, '가장 최근 활동이 맨 앞');
  await run(db, asUser(3), "update public.reviews set body = '고침' where place_id = $1 and author_id = $2", [p1, uid(3)]); // 트리거가 updated_at = now()
  assert.equal((await view(db, key)).places[0].id, p1, '후기를 고치면 그 장소가 맨 앞');
  await db.close();
});

test('P11b. 사진은 저장소 크기가 작은 것만: 썸네일 150,000·큰 사진 2,000,000바이트 넘거나 파일이 없으면 null', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1);
  const room = await createPublicRoom(db, 1, '사진 방', '민수');
  const p = await addPlace(db, 1, room, '장소');
  const ok = await addPhoto(db, 1, p, 'a.jpg', 0, true, { path: 2_000_000, thumb: 150_000 }); // 경계값은 됨
  const big = await addPhoto(db, 1, p, 'b.jpg', 1, true, { path: 5_000_000, thumb: 5_000_000 }); // 큰 파일을 썸네일로 넣은 경우
  const gone = await addPhoto(db, 1, p, 'c.jpg', 2, true, { path: null, thumb: null }); // 표에만 있고 파일은 없음
  const v = await view(db, await keyOf(db, room));
  assert.deepEqual(v.places[0].photos, [
    { path: ok.path, thumb: ok.thumb },
    { path: null, thumb: null },
    { path: null, thumb: null },
  ]);
  assert.equal(v.places[0].photo_count, 3);
  assert.ok(!JSON.stringify(v).includes(big.thumb) && !JSON.stringify(v).includes(gone.path));
  // 크기 칸이 숫자가 아니면(이상한 metadata) 오류 없이 null
  await db.query("update storage.objects set metadata = '{\"size\": \"x\"}' where name = $1", [ok.thumb]);
  assert.equal((await view(db, await keyOf(db, room))).places[0].photos[0].thumb, null);
  await db.close();
});

// ---------- P12. null이 되는 경우 ----------
test('P12. public_room_view가 null: 없는 키, 형식 틀린 키(초대 코드 포함), 개인 방, 숨김, 지우는 중(15분 안)', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3);
  const pub = await createPublicRoom(db, 1, '공개', '민수');
  const priv = await createPrivate(db, 2, '개인');
  const empty = await createPublicRoom(db, 3, '빈 방', '서연');
  await addPlace(db, 1, pub);
  const key = await keyOf(db, pub);

  assert.ok(await view(db, key));
  for (const bad of ['aaaaaaaaaa', 'ABCDEF12', await codeOf(db, pub), await codeOf(db, priv), key.toUpperCase(), `${key} `, ` ${key}`,
    key.slice(0, 9), `${key}a`, 'k7m2p9xal1', '', null, pub, priv]) {
    assert.equal(await view(db, bad), null, `키 ${bad}`);
  }
  // 개인 방은 키가 없어서 어떤 값으로도 안 나옴 (목록에도 없음)
  assert.equal((await db.query('select public_key from public.couples where id = $1', [priv])).rows[0].public_key, null);

  // 숨김 → null, 다시 보이기 → 보임
  await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true)', [key]);
  assert.equal(await view(db, key), null);
  await run(db, SERVICE, 'select public.admin_set_room_hidden($1, false)', [key]);
  assert.ok(await view(db, key));

  // 지우는 중(15분 안) → null, 15분이 지나면 다시 보임
  await db.query('update public.couples set deleting_at = now() where id = $1', [pub]);
  assert.equal(await view(db, key), null);
  await db.query("update public.couples set deleting_at = now() - interval '16 minutes' where id = $1", [pub]);
  assert.ok(await view(db, key));

  // 장소 0곳 방: 보기는 되고 목록에는 없음
  const ev = await view(db, await keyOf(db, empty));
  assert.equal(ev.place_count, 0);
  assert.deepEqual(ev.places, []);
  assert.deepEqual((await list(db)).map((r) => r.key), [key]);
  await db.close();
});

// ---------- P13. public_room_list ----------
test('P13. public_room_list: 키 9개, 숨김·빈 방·개인 방·지우는 중 없음, 최근 활동순, 50개까지, 초대 코드·uuid 없음', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4, 5, 6);
  const a = await createPublicRoom(db, 1, 'A', '민수', '소개 A');
  await joinFor(db, 2, await codeOf(db, a), '지훈');
  const pa1 = await addPlace(db, 1, a, '하나', { status: 'visited' });
  await addPlace(db, 2, a, '둘');
  const va = await addVisit(db, 1, pa1);
  await addReview(db, 1, pa1, va); await addReview(db, 2, pa1, va);
  const b = await createPublicRoom(db, 3, 'B', '서연');
  await addPlace(db, 3, b);
  const hidden = await createPublicRoom(db, 4, '숨김', '별4');
  await addPlace(db, 4, hidden);
  await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true)', [await keyOf(db, hidden)]);
  await createPublicRoom(db, 5, '빈 방', '별5');
  const priv = await createPrivate(db, 6, '개인');
  await addPlace(db, 6, priv);
  const deleting = await createPublicRoom(db, 6, '지우는 중', '별6');
  await addPlace(db, 6, deleting);
  await db.query('update public.couples set deleting_at = now() where id = $1', [deleting]);

  // A의 활동을 3일 전으로, B는 지금 → B, A 순서
  await db.query("update public.couples set created_at = now() - interval '3 days' where id = $1", [a]);
  await db.query("update public.places set created_at = now() - interval '3 days' where couple_id = $1", [a]);
  await db.query("update public.visits set created_at = now() - interval '3 days'");
  await setReviewTime(db, "now() - interval '3 days'");
  let l = await list(db);
  assert.deepEqual(l.map((r) => r.name), ['B', 'A']);
  for (const r of l) assert.deepEqual(sorted(r), LIST_KEYS);
  const ra = l[1];
  assert.equal(ra.key, await keyOf(db, a));
  assert.equal(ra.description, '소개 A');
  assert.equal(ra.member_count, 2);
  assert.deepEqual(ra.colors, (await members(db, a)).map((m) => m.color));
  assert.equal(ra.place_count, 2);
  assert.equal(ra.visited_count, 1);
  assert.equal(ra.review_count, 2);
  assert.equal(ra.active, 'week', '3일 전 활동은 week (날짜 수는 보내지 않음)');
  assert.equal(l[0].active, 'week');
  // 사진을 올리면 A가 다시 맨 앞
  await addPhoto(db, 2, pa1, 'new.jpg');
  l = await list(db);
  assert.deepEqual(l.map((r) => r.name), ['A', 'B']);
  assert.equal(l[0].active, 'week');
  // 7일 넘으면 month, 31일 넘으면 older (KST 날짜 차이)
  const back = async (days) => {
    for (const t of ['couples', 'places']) await db.query(`update public.${t} set created_at = now() - interval '${days} days' where ${t === 'couples' ? 'id' : 'couple_id'} = $1`, [b]);
  };
  await back(8);
  assert.equal((await list(db)).find((r) => r.name === 'B').active, 'month');
  assert.equal((await view(db, await keyOf(db, b))).active, 'month');
  await back(40);
  assert.equal((await list(db)).find((r) => r.name === 'B').active, 'older');
  assert.ok(!/active_days_ago/.test(JSON.stringify(await list(db))));

  const s = JSON.stringify(l);
  const codes = (await db.query('select id::text, invite_code from public.couples')).rows;
  for (const c of codes) {
    assert.ok(!s.includes(c.invite_code), '초대 코드 없음');
    assert.ok(!s.includes(c.id), '방 uuid 없음');
  }
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(!s.includes(uid(n)), '사용자 uuid 없음');
  for (const word of ['favorite', 'invite', 'owner', '@']) assert.ok(!s.includes(word));

  // 50개까지 (한도는 create_room에만 있으므로 superuser로 직접 넣음). 활동 시각을 모두 같게 해서 키 순서를 봄
  const keys = Array.from({ length: 55 }, (_, i) => `zzzzzzzz${KEY_ALPHABET[Math.floor(i / 32)]}${KEY_ALPHABET[i % 32]}`);
  for (const [i, k] of keys.entries()) {
    const [r] = (await db.query(`insert into public.couples (name, created_by, invite_code, visibility, public_key, created_at)
                                 values ($1, $2, $3, 'public', $4, '2026-01-01T00:00:00Z') returning id`,
    [`대량${i}`, uid(1), `B${String(i).padStart(7, '0')}`, k])).rows;
    await db.query("insert into public.categories (couple_id, name) values ($1, '기타')", [r.id]);
    await db.query("insert into public.places (couple_id, name, created_by, created_at) values ($1, 'x', $2, '2026-01-01T00:00:00Z')", [r.id, uid(1)]);
  }
  l = await list(db);
  assert.equal(l.length, 50);
  assert.deepEqual(l.slice(0, 2).map((r) => r.name), ['A', 'B'], '최근 활동 방이 먼저');
  // 활동 시각이 같으면 키 순서
  const bulk = l.slice(2).map((r) => r.key);
  assert.deepEqual(bulk, [...keys].sort().slice(0, 48));
  await db.close();
});

// ---------- P14. 초대 코드 다시 만들기·소개 ----------
test('P14. regenerate_invite_code: 방장만(모든 방), 예전 코드는 바로 invalid_code. set_room_description: 방장·공개 방만', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1, 2, 3, 4, 5);
  const pub = await createPublicRoom(db, 1, '공개', '민수');
  await joinFor(db, 2, await codeOf(db, pub), '지훈');
  const priv = await createPrivate(db, 3, '개인');
  const old = await codeOf(db, pub);

  const [r] = await run(db, asUser(1), 'select public.regenerate_invite_code($1) as c', [pub]);
  assert.match(r.c, CODE_RE);
  assert.notEqual(r.c, old);
  assert.equal(await codeOf(db, pub), r.c);
  await expectError(joinFor(db, 4, old, '서연'), 'invalid_code');
  await expectError(run(db, SERVICE, 'select public.join_couple_for($1, $2, $3)', [uid(4), old, '서연']), 'invalid_code');
  assert.equal((await run(db, SERVICE, 'select public.space_code_info($1) as v', [old]))[0].v.open, false);
  assert.equal((await joinFor(db, 4, r.c, '서연')).status, 'joined');
  assert.equal((await members(db, pub)).length, 3, '이미 들어온 멤버는 그대로');
  // 멤버(방장 아님)는 invite_owner_only, 남은 not_member, 없는 방도 not_member
  await expectError(run(db, asUser(2), 'select public.regenerate_invite_code($1)', [pub]), 'invite_owner_only');
  await expectError(run(db, asUser(5), 'select public.regenerate_invite_code($1)', [pub]), 'not_member');
  await expectError(run(db, asUser(5), 'select public.regenerate_invite_code($1)', [uid(999)]), 'not_member');
  assert.equal(await codeOf(db, pub), r.c, '실패하면 그대로');
  // 개인 방도 방장이면 됨
  const oldPriv = await codeOf(db, priv);
  const [rp] = await run(db, asUser(3), 'select public.regenerate_invite_code($1) as c', [priv]);
  assert.notEqual(rp.c, oldPriv);
  await expectError(joinFor(db, 5, oldPriv), 'invalid_code');
  // 방장이 나가 방장이 바뀌면 새 방장이 다시 만들 수 있음
  await run(db, asUser(1), 'select public.leave_room($1)', [pub]);
  await expectError(run(db, asUser(1), 'select public.regenerate_invite_code($1)', [pub]), 'not_member');
  await run(db, asUser(2), 'select public.regenerate_invite_code($1)', [pub]);

  // 소개
  const [d] = await run(db, asUser(2), "select public.set_room_description($1, '  새 소개  ') as d", [pub]);
  assert.equal(d.d, '새 소개');
  assert.equal((await db.query('select description from public.couples where id = $1', [pub])).rows[0].description, '새 소개');
  await expectError(run(db, asUser(4), "select public.set_room_description($1, 'x')", [pub]), 'description_owner_only');
  await expectError(run(db, asUser(5), "select public.set_room_description($1, 'x')", [pub]), 'not_member');
  await expectError(run(db, asUser(3), "select public.set_room_description($1, 'x')", [priv]), 'not_public');
  await expectError(run(db, asUser(2), 'select public.set_room_description($1, $2)', [pub, 'ㄱ'.repeat(61)]), 'invalid_description');
  assert.equal((await run(db, asUser(2), 'select public.set_room_description($1, $2) as d', [pub, 'ㄱ'.repeat(60)]))[0].d.length, 60);
  assert.equal((await run(db, asUser(2), 'select public.set_room_description($1, null) as d', [pub]))[0].d, '');
  await db.close();
});

// ---------- P15. 권한·RLS·저장소 ----------
test('P15. 권한: anon은 새 함수 모두 불가, authenticated는 서버 전용 불가, 동의 기록 표 못 읽음', async () => {
  const db = await newDb({ public: true });
  await addUsers(db, 1);
  const room = await createPrivate(db, 1);
  const u = uid(1);
  const calls = {
    create_room: ["select public.create_room('a', 'b', 'private', null, null)", []],
    public_create_status: ['select public.public_create_status()', []],
    set_room_description: ["select public.set_room_description($1, 'x')", [uid(999)]],
    regenerate_invite_code: ['select public.regenerate_invite_code($1)', [uid(999)]],
    public_ack_version: ['select public.public_ack_version()', []],
    join_room_for: ["select public.join_room_for($1, 'FFFFFFFF', 'a', 1)", [u]],
    space_code_info: ["select public.space_code_info('FFFFFFFF')", []],
    public_room_list: ['select public.public_room_list()', []],
    public_room_view: ["select public.public_room_view('aaaaaaaaaa')", []],
    public_rooms_version: ['select public.public_rooms_version()', []],
    admin_set_room_hidden: ["select public.admin_set_room_hidden('aaaaaaaaaa', true)", []],
    admin_public_rooms: ['select * from public.admin_public_rooms()', []],
    public_login_id: ['select public.public_login_id($1)', [u]],
    public_room_activity: ['select public.public_room_activity($1)', [room]],
    public_text_ok: ["select public.public_text_ok('a')", []],
    public_nick_key: ["select public.public_nick_key('a')", []],
    couples_public_text: ['select public.couples_public_text()', []],
    couples_freeze_visibility: ['select public.couples_freeze_visibility()', []],
    enforce_public_nickname: ['select public.enforce_public_nickname()', []],
  };
  for (const [name, [sql, params]] of Object.entries(calls)) {
    await expectError(run(db, ANON, sql, params), PERM).catch((e) => { throw new Error(`anon ${name}: ${e.message}`); });
  }
  const serverOnly = ['join_room_for', 'space_code_info', 'public_room_list', 'public_room_view', 'public_rooms_version',
    'admin_set_room_hidden', 'admin_public_rooms', 'public_login_id', 'public_room_activity', 'public_text_ok', 'public_nick_key',
    'couples_freeze_visibility', 'couples_public_text', 'enforce_public_nickname'];
  for (const name of serverOnly) {
    const [sql, params] = calls[name];
    await expectError(run(db, asUser(1), sql, params), PERM).catch((e) => { throw new Error(`authenticated ${name}: ${e.message}`); });
  }
  // authenticated가 부를 수 있는 것: 권한 오류가 아니라 함수 결과·오류
  const allowed = { create_room: null, public_create_status: null, set_room_description: 'not_member', regenerate_invite_code: 'not_member', public_ack_version: null };
  for (const [name, err] of Object.entries(allowed)) {
    const [sql, params] = calls[name];
    if (err) await expectError(run(db, asUser(1), sql, params), err);
    else await run(db, asUser(1), sql, params);
  }
  // 서버(service_role)는 서버 전용 함수를 부름. 내부 함수는 서버도 직접 부를 일이 없음(권한은 Supabase 기본값)
  for (const name of ['join_room_for', 'space_code_info', 'public_room_list', 'public_room_view', 'public_rooms_version', 'admin_set_room_hidden', 'admin_public_rooms']) {
    const [sql, params] = calls[name];
    if (name === 'join_room_for') await expectError(run(db, SERVICE, sql, params), 'invalid_code');
    else await run(db, SERVICE, sql, params);
  }
  // 동의 기록 표: 앱에서 못 읽고 못 씀
  for (const who of [asUser(1), ANON]) {
    await expectError(run(db, who, 'select * from public.public_room_acks'), PERM);
    await expectError(run(db, who, "insert into public.public_room_acks (couple_id, user_id, kind, version) values ($1, $2, 'create', 1)", [room, u]), PERM);
  }
  // security definer 함수는 모두 search_path = ''
  const bad = (await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows.map((r) => r.proname);
  assert.deepEqual(bad, []);
  await db.close();
});

test('P15b. RLS·표 권한은 넓히지 않음(공개 방도 멤버만), 저장소 정책은 멤버만, begin_room_delete가 썸네일 경로도 돌려줌', async () => {
  const db = await newDb({ colors: true });
  const before = await snapshot(db);
  await db.exec(SQL('public.sql'));
  const after = await snapshot(db);
  const STORAGE = /^storage \| objects \| place photos /;
  assert.deepEqual(after.policies.filter((x) => !STORAGE.test(x)), before.policies.filter((x) => !STORAGE.test(x)), 'public 표의 RLS 정책이 바뀜');
  const storage = after.policies.filter((x) => STORAGE.test(x));
  assert.equal(storage.length, 3);
  for (const x of storage) assert.match(x, /is_couple_member/);
  assert.deepEqual(after.tableAcl.filter((x) => !x.startsWith('public_room_acks')), before.tableAcl, '표 권한이 바뀜');
  assert.deepEqual(after.columnAcl, before.columnAcl, '칸 권한이 바뀜');
  assert.equal(await count(db, "select 1 from pg_policies where tablename = 'public_room_acks'"), 0, '동의 기록 표는 정책 없음');

  await addUsers(db, 1, 2, 3);
  const pub = await createPublicRoom(db, 1, '공개', '민수');
  const p = await addPlace(db, 1, pub, '장소', { favorite: true, note: '메모' });
  await addPhoto(db, 1, p, 'a.jpg');
  await run(db, asUser(1), "insert into storage.objects (bucket_id, name) values ('place-photos', $1), ('place-photos', $2)", [`${p}/a.jpg`, `${p}/t/a.jpg`]);

  // 멤버 아닌 로그인 사용자(2)는 공개 방이라도 표에서 아무것도 못 봄
  for (const sql of ['select id from public.couples', 'select couple_id from public.couple_members', 'select id from public.places',
    'select id from public.categories', 'select id from public.place_photos', 'select name from storage.objects']) {
    assert.equal((await run(db, asUser(2), sql)).length, 0, sql);
  }
  // 저장소: 남의 장소 폴더에 올리기·지우기 못 함 (썸네일 경로도 같은 판정)
  for (const name of [`${p}/x.jpg`, `${p}/t/x.jpg`]) {
    await expectError(run(db, asUser(2), "insert into storage.objects (bucket_id, name) values ('place-photos', $1)", [name]), RLS);
  }
  await run(db, asUser(2), "delete from storage.objects where bucket_id = 'place-photos'");
  assert.equal(await count(db, 'select 1 from storage.objects'), 2, '남은 못 지움');
  // 멤버는 썸네일 경로에 올림
  await run(db, asUser(1), "insert into storage.objects (bucket_id, name) values ('place-photos', $1)", [`${p}/t/b.jpg`]);
  // 사진 표: 다른 장소 폴더의 썸네일 경로는 제약이 막고, 썸네일 경로는 고칠 수 없음
  await expectError(run(db, asUser(1), 'insert into public.place_photos (place_id, path, thumb_path, created_by) values ($1, $2, $3, $4)',
    [p, `${p}/c.jpg`, `${uid(9)}/t/c.jpg`, uid(1)]), /place_photos_thumb_path_check/);
  await expectError(run(db, asUser(1), 'insert into public.place_photos (place_id, path, thumb_path, created_by) values ($1, $2, $3, $4)',
    [p, `${p}/c.jpg`, `${p}/c.jpg`, uid(1)]), /place_photos_thumb_path_check/);
  await expectError(run(db, asUser(1), "update public.place_photos set thumb_path = null where place_id = $1", [p]), PERM);
  // 앱은 couples를 바꾸거나 넣을 수 없음 (공개 범위·키·숨김)
  await expectError(run(db, asUser(1), "insert into public.couples (name, created_by, visibility, public_key) values ('x', $1, 'public', 'abcdefghij')", [uid(1)]), PERM);
  // 멤버는 새 칸을 읽음 (내 정보의 공개 방 묶음)
  const [mine] = await run(db, asUser(1), 'select visibility, description, public_key, public_hidden_at from public.couples where id = $1', [pub]);
  assert.equal(mine.visibility, 'public');
  assert.match(mine.public_key, KEY_RE);

  // begin_room_delete: 원본 + 썸네일 경로 (썸네일 없는 사진은 원본만)
  await addPhoto(db, 1, p, 'b.jpg', 1, false);
  const [r] = await run(db, asUser(1), 'select public.begin_room_delete($1) as paths', [pub]);
  assert.deepEqual(r.paths, [`${p}/a.jpg`, `${p}/b.jpg`, `${p}/t/a.jpg`]);
  await db.close();
});

// ---------- P16. 되돌리기 ----------
test('P16. 되돌리기: backup 표 세 개, 구조·함수·정책·권한이 적용 전과 같음, 공개 방은 개인 방으로, 다시 적용 가능', async () => {
  const db = await newDb({ colors: true });
  const before = await snapshot(db);
  await expectError(db.exec(SQL('public_rollback.sql')), /public\.sql이 적용되지 않았어요/);
  await db.exec('rollback').catch(() => {});

  await db.exec(SQL('public.sql'));
  const afterPublic = await snapshot(db);
  await addUsers(db, 1, 2, 3);
  const pub = await createPublicRoom(db, 1, '공개', '민수', '소개');
  await joinFor(db, 2, await codeOf(db, pub), '지훈');
  const priv = await createPrivate(db, 3, '개인');
  const p = await addPlace(db, 1, pub);
  await addPhoto(db, 1, p, 'a.jpg');
  await addPhoto(db, 1, p, 'b.jpg', 1, false);
  const key = await keyOf(db, pub);
  await run(db, SERVICE, 'select public.admin_set_room_hidden($1, true)', [key]);
  const code = await codeOf(db, pub);

  await db.exec(SQL('public_rollback.sql'));

  const after = await snapshot(db);
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `되돌린 뒤 ${k}가 적용 전과 다름`);
  assert.equal(await count(db, "select 1 from pg_trigger where tgname in ('couples_freeze_visibility', 'couple_members_public_nickname')"), 0);
  assert.equal(await count(db, "select 1 from information_schema.tables where table_schema = 'public' and table_name = 'public_room_acks'"), 0);
  // 데이터는 그대로, 공개 방은 개인 방(구분 칸이 없음)
  assert.equal((await members(db, pub)).length, 2);
  assert.equal(await codeOf(db, pub), code);
  assert.equal(await count(db, 'select 1 from public.place_photos'), 2);
  assert.ok(priv);

  // backup 표 세 개
  const tables = (await db.query("select table_name from information_schema.tables where table_schema = 'backup' order by 1")).rows.map((r) => r.table_name);
  const find = (prefix) => {
    const t = tables.filter((x) => x.startsWith(prefix));
    assert.equal(t.length, 1, `${prefix} 표 하나`);
    return t[0];
  };
  const rooms = (await db.query(`select id, name, public_key, description, public_hidden_at from backup.${find('public_rooms_v020_')}`)).rows;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].id, pub);
  assert.equal(rooms[0].public_key, key);
  assert.equal(rooms[0].description, '소개');
  assert.ok(rooms[0].public_hidden_at instanceof Date);
  const savedAcks = (await db.query(`select couple_id, user_id, kind, version from backup.${find('public_room_acks_v020_')} order by id`)).rows;
  assert.deepEqual(savedAcks.map((r) => [r.user_id, r.kind, r.version]), [[uid(1), 'create', 1], [uid(2), 'join', 1]]);
  const thumbs = (await db.query(`select place_id, thumb_path from backup.${find('place_photo_thumbs_v020_')}`)).rows;
  assert.deepEqual(thumbs, [{ place_id: p, thumb_path: `${p}/t/a.jpg` }]);

  // 예전 함수가 돌아옴: join_couple_for로 (예전) 공개 방에도 들어감, begin_room_delete는 원본 경로만
  assert.equal((await run(db, SERVICE, 'select public.join_couple_for($1, $2, $3) as id', [uid(3), code, '서연']))[0].id, pub);
  await expectError(run(db, asUser(1), "select public.create_room('a', 'b', 'private', null, null)"), /does not exist/);

  // 다시 적용: 처음 적용과 같은 구조·함수·정책·권한, 모든 방은 개인 방
  await db.exec(SQL('public.sql'));
  const again = await snapshot(db);
  for (const k of Object.keys(afterPublic)) assert.deepEqual(again[k], afterPublic[k], `다시 적용한 뒤 ${k}가 처음 적용과 다름`);
  assert.equal(await count(db, "select 1 from public.couples where visibility = 'public'"), 0);
  // 동의 기록이 없어졌으므로 다시 공개 방을 만들 수 있음 (backup에만 남음)
  await run(db, asUser(3), 'select public.leave_room($1)', [pub]);
  assert.ok(await createPublicRoom(db, 2, '다시', '지훈'));
  await db.close();
});
