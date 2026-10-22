'use strict';
// supabase/groups.sql·groups_rollback.sql 시험 (docs/groups-design.md §5.1의 1~15번).
// 실행: cd dev/sqltest && npm ci && npm test
// PGlite는 연결이 하나라 동시 실행(잠금 경쟁)은 시험하지 못한다. 잠금 순서는 코드 리뷰로 확인(설계 §2.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT, SQL, uid, newDb, addUsers, run, asUser, ANON, SERVICE, expectError,
  createRoom, codeOf, join, members, count, snapshot,
} = require('./helpers.cjs');

const CODE_RE = /^[0-9A-F]{8}$/;
const PERM = /permission denied/;

// ---------- 시험 데이터 넣기 (그 사용자로, RLS를 지나서) ----------
async function addPlace(db, n, room, name = '장소', category = '맛집') {
  const [r] = await run(db, asUser(n),
    'insert into public.places (couple_id, name, category, created_by) values ($1, $2, $3, $4) returning id',
    [room, name, category, uid(n)]);
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
async function addPhoto(db, n, place, file = 'a.jpg') {
  const p = `${place}/${file}`;
  await run(db, asUser(n), 'insert into public.place_photos (place_id, path, created_by) values ($1, $2, $3)', [place, p, uid(n)]);
  await run(db, asUser(n), "insert into storage.objects (bucket_id, name) values ('place-photos', $1)", [p]);
  return p;
}
async function addCup(db, n, room, champion, year = null) {
  const [r] = await run(db, asUser(n),
    `insert into public.cup_results (couple_id, user_id, year, category, champion_id, champion_name, runner_up_id, runner_up_name, candidates)
     values ($1, $2, $3, null, $4, '1위', null, '2위', 4) returning id`, [room, uid(n), year, champion]);
  return r.id;
}
const ownerCount = (db, room) => count(db, "select 1 from public.couple_members where couple_id = $1 and role = 'owner'", [room]);

// 설계 문서 §2.6 표에서 색 id를 순서대로 읽음
function designColorIds() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'groups-design.md'), 'utf8');
  const ids = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\| (\d+) \| ([a-z-]+) \| [^|]+ \| #[0-9A-F]{6} \| #[0-9A-F]{6} \| \| (\d+) \| ([a-z-]+) \|/);
    if (m) { ids[Number(m[1]) - 1] = m[2]; ids[Number(m[3]) - 1] = m[4]; }
  }
  return ids;
}
// index.html의 MEMBER_COLORS 목록에서 id를 순서대로 (아직 없으면 null)
function clientColorIds() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/MEMBER_COLORS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  return [...m[1].matchAll(/id:\s*['"]([a-z-]+)['"]/g)].map((x) => x[1]);
}

// ---------- 1. 적용 ----------
test('1a. 빈 DB에 적용됨, 한 사람 한 방 제약 없음', async () => {
  const db = await newDb();
  assert.equal(await count(db, "select 1 from pg_constraint where conname = 'couple_members_one_couple_per_user'"), 0);
  assert.equal(await count(db, 'select 1 from public.member_colors'), 40);
  const [v] = await run(db, asUser(1), 'select public.groups_schema_version() as v');
  assert.equal(v.v, 1);
  await db.close();
});

test('1b. 기존 데이터가 있는 DB에 적용: teal/amber 채우기, 코드 다시 만들기, 데이터 그대로', async () => {
  const db = await newDb({ groups: false });
  await addUsers(db, 1, 2, 3);
  // 예전 함수로: 방 A(방장 1 + 멤버 2, 코드 null), 방 B(방장 3만, 코드 있음)
  const [ra] = await run(db, asUser(1), "select public.create_couple('민수', null) as id");
  const a = ra.id;
  await run(db, SERVICE, 'select public.join_couple_for($1, $2, $3)', [uid(2), await codeOf(db, a), '지수']);
  const [rb] = await run(db, asUser(3), "select public.create_couple('', '') as id"); // 예전엔 빈 닉네임도 들어감
  const b = rb.id;
  assert.equal(await codeOf(db, a), null);
  const p = await addPlace(db, 1, a);
  const v = await addVisit(db, 2, p);
  await addReview(db, 1, p, v); await addReview(db, 2, p, v);
  await addPhoto(db, 2, p);
  await addCup(db, 1, a, p);

  await db.exec(SQL('groups.sql'));

  const ma = await members(db, a);
  assert.deepEqual(ma.map((m) => [m.user_id, m.role, m.color]), [[uid(1), 'owner', 'teal'], [uid(2), 'member', 'amber']]);
  const mb = await members(db, b);
  assert.deepEqual(mb.map((m) => [m.role, m.color, m.display_name]), [['owner', 'teal', '']]); // not valid 제약이라 기존 행은 그대로
  for (const room of [a, b]) assert.match(await codeOf(db, room), CODE_RE);
  assert.equal(await count(db, "select 1 from pg_constraint where conname = 'couple_members_one_couple_per_user'"), 0);
  assert.equal(await count(db, 'select 1 from public.reviews'), 2);
  assert.equal(await count(db, 'select 1 from public.place_photos'), 1);
  assert.equal(await count(db, 'select 1 from public.cup_results'), 1);
  // 예전 기본 방 이름('우리의 장소 기록')도 새 제약에 맞음
  assert.equal((await db.query('select name from public.couples where id = $1', [a])).rows[0].name, '우리의 장소 기록');
  await db.close();
});

// ---------- 2. 색 목록 ----------
test('2. member_colors 40개, 설계·화면과 id·순서 같음, 두 번 적용하면 멈춤', async (t) => {
  const db = await newDb();
  const rows = (await db.query('select id, position from public.member_colors order by position')).rows;
  assert.equal(rows.length, 40);
  assert.deepEqual(rows.map((r) => r.position), Array.from({ length: 40 }, (_, i) => i + 1));
  const design = designColorIds();
  assert.equal(design.filter(Boolean).length, 40, '설계 문서 §2.6 표에서 40개를 읽어야 함');
  assert.deepEqual(rows.map((r) => r.id), design);
  // 화면은 v0.1.2부터 colors.sql의 24색을 씀(colors.test.cjs가 비교). 예전 40색 목록일 때만 여기서 비교
  const client = clientColorIds();
  if (client && client.length === 40) assert.deepEqual(client, design, 'index.html MEMBER_COLORS가 SQL과 다름');
  else t.diagnostic('index.html MEMBER_COLORS가 groups.sql의 40색 목록이 아니라서 여기서는 비교하지 않음(colors.test.cjs가 비교)');

  await expectError(db.exec(SQL('groups.sql')), /이미 적용된 SQL이에요/);
  await db.exec('rollback').catch(() => {});
  assert.equal(await count(db, 'select 1 from public.member_colors'), 40);
  await db.close();
});

// ---------- 3. create_couple ----------
test('3. create_couple: 이름·닉네임 확인, 방장 1명, 색, 카테고리 8개, 방 3개 제한', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3);
  const me = asUser(1);
  const cc = (nick, name) => run(db, me, 'select public.create_couple($1, $2) as id', [nick, name]);
  await expectError(cc('민수', ''), 'invalid_room_name');
  await expectError(cc('민수', '   '), 'invalid_room_name');
  await expectError(cc('민수', null), 'invalid_room_name');
  await expectError(cc('민수', 'ㄱ'.repeat(31)), 'invalid_room_name');
  await expectError(cc('', '방'), 'invalid_display_name');
  await expectError(cc('  ', '방'), 'invalid_display_name');
  await expectError(cc('ㄱ'.repeat(21), '방'), 'invalid_display_name');
  await expectError(run(db, { role: 'authenticated' }, "select public.create_couple('a', 'b')"), 'not_authenticated');
  await expectError(run(db, ANON, "select public.create_couple('a', 'b')"), PERM);

  const [r] = await cc(' 민수 ', ` ${'ㄱ'.repeat(30)} `);
  const room = r.id;
  const [c] = (await db.query('select name, invite_code, created_by from public.couples where id = $1', [room])).rows;
  assert.equal(c.name, 'ㄱ'.repeat(30));
  assert.match(c.invite_code, CODE_RE);
  assert.equal(c.created_by, uid(1));
  const ms = await members(db, room);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].role, 'owner');
  assert.equal(ms[0].display_name, '민수');
  assert.equal(await count(db, 'select 1 from public.member_colors where id = $1', [ms[0].color]), 1);
  assert.deepEqual((await db.query('select name from public.categories where couple_id = $1 order by position', [room])).rows.map((x) => x.name),
    ['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타']);

  // 만든 방 2개 + 들어간 방 1개 = 3개 → 4번째는 만들기·참여 모두 막힘
  await createRoom(db, 1, '둘째');
  const other = await createRoom(db, 2, '친구 방');
  await join(db, 1, await codeOf(db, other));
  await expectError(cc('민수', '넷째'), 'too_many_rooms');
  const fourth = await createRoom(db, 3, '또 다른 방');
  await expectError(join(db, 1, await codeOf(db, fourth)), 'too_many_rooms');
  assert.equal(await count(db, 'select 1 from public.couple_members where user_id = $1', [uid(1)]), 3);
  await db.close();
});

test('3b. 방장 색은 무작위 (방 12개의 방장 색이 모두 같지 않음)', async () => {
  const db = await newDb();
  const colors = new Set();
  for (let n = 1; n <= 12; n++) {
    await addUsers(db, n);
    const room = await createRoom(db, n);
    colors.add((await members(db, room))[0].color);
  }
  assert.ok(colors.size > 1, `색이 매번 같음: ${[...colors]}`);
  await db.close();
});

// ---------- 4. join_couple_for ----------
test('4. join_couple_for: 코드 확인, 5명까지, 같은 사람 다시 = 같은 id, 색 겹침 없음, 오류 순서', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const room = await createRoom(db, 1, '맛집 탐방대');
  const code = await codeOf(db, room);

  await expectError(join(db, 2, 'FFFFFFFF'), 'invalid_code');
  await expectError(join(db, 2, null), 'invalid_code');
  await expectError(run(db, SERVICE, 'select public.join_couple_for(null, $1, $2)', [code, 'x']), 'not_authenticated');
  await expectError(join(db, 2, code, '  '), 'invalid_display_name');
  await expectError(join(db, 2, code, 'ㄱ'.repeat(21)), 'invalid_display_name');

  assert.equal(await join(db, 2, ` ${code.toLowerCase()} `, ' 지수 '), room); // 소문자·공백 허용
  for (const n of [3, 4, 5]) assert.equal(await join(db, n, code), room);
  let ms = await members(db, room);
  assert.equal(ms.length, 5);
  assert.equal(ms[1].display_name, '지수');
  assert.equal(ms[1].role, 'member');
  assert.equal(new Set(ms.map((m) => m.color)).size, 5, '방 안 색이 겹침');
  assert.equal(await codeOf(db, room), code, '다 차도 코드는 그대로');

  await expectError(join(db, 6, code), 'room_full');
  // 이미 멤버면 꽉 찬 방이어도 같은 id, 아무것도 안 바뀜(닉네임도)
  assert.equal(await join(db, 2, code, '다른이름'), room);
  ms = await members(db, room);
  assert.equal(ms.length, 5);
  assert.equal(ms[1].display_name, '지수');

  // 방 3개인 사람: 맞는 코드라도 too_many_rooms (방이 꽉 찼어도 too_many_rooms가 먼저)
  await createRoom(db, 7, 'x'); await createRoom(db, 7, 'y'); await createRoom(db, 7, 'z');
  await expectError(join(db, 7, code), 'too_many_rooms');
  const open = await createRoom(db, 8, '빈 방');
  await expectError(join(db, 7, await codeOf(db, open)), 'too_many_rooms');
  // 이미 그 방 멤버인 방 3개짜리 사람이 다시 보내면 성공(같은 id)
  const r7 = (await db.query('select couple_id from public.couple_members where user_id = $1 limit 1', [uid(7)])).rows[0].couple_id;
  assert.equal(await join(db, 7, await codeOf(db, r7)), r7);

  // join_couple(앱에서 직접)은 거둔 상태 그대로
  await expectError(run(db, asUser(9), 'select public.join_couple($1, $2)', [code, 'x']), PERM);
  await db.close();
});

// ---------- 5. 트리거 ----------
test('5. 트리거: 직접 넣어도 6번째·4번째 방이 막히고, 색 없이 넣으면 빈 색', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3, 4, 5, 6);
  const room = await createRoom(db, 1);
  const ins = (n, r, color = null) => db.query(
    "insert into public.couple_members (couple_id, user_id, role, display_name, color) values ($1, $2, 'member', $3, $4)",
    [r, uid(n), `n${n}`, color]);
  for (const n of [2, 3, 4, 5]) await ins(n, room);
  const ms = await members(db, room);
  assert.equal(new Set(ms.map((m) => m.color)).size, 5);
  await expectError(ins(6, room), 'room_full');

  const r2 = await createRoom(db, 6); const r3 = await createRoom(db, 6); const r4 = await createRoom(db, 2);
  await ins(6, r4); // 6번: r2, r3, r4 → 3개
  const r5 = await createRoom(db, 3);
  await expectError(ins(6, r5), 'too_many_rooms');
  // 색을 직접 줘도 방 안에서 겹치면 unique 제약
  const used = (await members(db, r2))[0].color;
  await expectError(ins(4, r2, used), /couple_members_couple_color_key/);
  assert.ok(r3);
  await db.close();
});

// ---------- 6. space_code_open ----------
test('6. space_code_open: 4명 true, 5명 false, 없는 코드 false, 지우는 중 false(15분 뒤 true)', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3, 4, 5, 6);
  const open = async (c) => (await run(db, SERVICE, 'select public.space_code_open($1) as ok', [c]))[0].ok;
  const room = await createRoom(db, 1);
  const code = await codeOf(db, room);
  for (const n of [2, 3, 4]) await join(db, n, code);
  assert.equal(await open(code), true);
  assert.equal(await open(code.toLowerCase()), true);
  await join(db, 5, code);
  assert.equal(await open(code), false);
  assert.equal(await open('FFFFFFFF'), false);
  assert.equal(await open(null), false);

  const solo = await createRoom(db, 6);
  const sc = await codeOf(db, solo);
  assert.equal(await open(sc), true);
  await run(db, asUser(6), 'select public.begin_room_delete($1)', [solo]);
  assert.equal(await open(sc), false);
  await db.query("update public.couples set deleting_at = now() - interval '16 minutes' where id = $1", [solo]);
  assert.equal(await open(sc), true);
  await expectError(run(db, asUser(1), 'select public.space_code_open($1)', [code]), PERM);
  await db.close();
});

// ---------- 7. rename_room ----------
test('7. rename_room: 방장만, 앞뒤 공백 제거, 1~30자', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3);
  const room = await createRoom(db, 1, '처음 이름');
  await join(db, 2, await codeOf(db, room));
  const rn = (n, name, r = room) => run(db, asUser(n), 'select public.rename_room($1, $2) as name', [r, name]);
  assert.equal((await rn(1, '  새 이름  '))[0].name, '새 이름');
  assert.equal((await db.query('select name from public.couples where id = $1', [room])).rows[0].name, '새 이름');
  await expectError(rn(2, '멤버가 바꿈'), 'not_owner');
  await expectError(rn(3, '남이 바꿈'), 'not_member');
  await expectError(rn(1, '없는 방', uid(999)), 'not_member');
  await expectError(rn(1, ''), 'invalid_room_name');
  await expectError(rn(1, '   '), 'invalid_room_name');
  await expectError(rn(1, null), 'invalid_room_name');
  await expectError(rn(1, 'ㄱ'.repeat(31)), 'invalid_room_name');
  assert.equal((await rn(1, 'ㄱ'.repeat(30)))[0].name, 'ㄱ'.repeat(30));
  await expectError(run(db, { role: 'authenticated' }, 'select public.rename_room($1, $2)', [room, 'x']), 'not_authenticated');
  await expectError(run(db, ANON, 'select public.rename_room($1, $2)', [room, 'x']), PERM);
  // 앱은 couples를 직접 고칠 수 없음
  await expectError(run(db, asUser(1), "update public.couples set name = '직접' where id = $1", [room]), PERM);
  await db.close();
});

// ---------- 8. set_member_color ----------
test('8. set_member_color: 빈 색만, 직접 update 불가, 닉네임 제약', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3);
  const room = await createRoom(db, 1);
  await join(db, 2, await codeOf(db, room));
  const [m1, m2] = await members(db, room);
  const free = (await db.query('select id from public.member_colors where id not in ($1, $2) order by position limit 1', [m1.color, m2.color])).rows[0].id;
  const sc = (n, color) => run(db, asUser(n), 'select public.set_member_color($1, $2) as color', [room, color]);

  assert.equal((await sc(1, free))[0].color, free);
  assert.equal((await members(db, room))[0].color, free);
  assert.equal((await sc(1, free))[0].color, free, '지금 색과 같으면 그대로');
  await expectError(sc(1, m2.color), 'color_taken');
  await expectError(sc(1, 'gold'), 'invalid_color');
  await expectError(sc(1, null), 'invalid_color');
  await expectError(sc(3, free), 'not_member');
  await expectError(run(db, { role: 'authenticated' }, 'select public.set_member_color($1, $2)', [room, free]), 'not_authenticated');
  // 1번이 버린 색은 2번이 바로 고를 수 있음
  assert.equal((await sc(2, m1.color))[0].color, m1.color);

  await expectError(run(db, asUser(1), "update public.couple_members set color = 'pink' where couple_id = $1 and user_id = $2", [room, uid(1)]), PERM);
  // 닉네임은 직접 update (방 조건을 붙여서), 빈 값은 제약 오류
  await run(db, asUser(1), "update public.couple_members set display_name = '새닉' where couple_id = $1 and user_id = $2", [room, uid(1)]);
  assert.equal((await members(db, room))[0].display_name, '새닉');
  await expectError(run(db, asUser(1), "update public.couple_members set display_name = '' where couple_id = $1 and user_id = $2", [room, uid(1)]),
    /couple_members_display_name_check/);
  await expectError(run(db, asUser(1), "update public.couple_members set display_name = ' 공백 ' where couple_id = $1 and user_id = $2", [room, uid(1)]),
    /couple_members_display_name_check/);
  // 남의 닉네임은 RLS로 0행
  await run(db, asUser(1), "update public.couple_members set display_name = '해킹' where couple_id = $1 and user_id = $2", [room, uid(2)]);
  assert.notEqual((await members(db, room))[1].display_name, '해킹');
  await db.close();
});

// ---------- 9. leave_room (멤버) ----------
test('9. leave_room(멤버): 그 방 내 후기·월드컵 기록·빈 방문만 지움, 다른 방·장소·사진은 남음', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3, 4);
  const a = await createRoom(db, 1, 'A');
  await join(db, 2, await codeOf(db, a)); await join(db, 3, await codeOf(db, a));
  const b = await createRoom(db, 4, 'B');
  await join(db, 2, await codeOf(db, b));

  // 방 A: 2번이 담은 장소와 사진, 방문 세 개
  const p = await addPlace(db, 2, a, '2번이 담음');
  const photo = await addPhoto(db, 2, p);
  const v1 = await addVisit(db, 2, p, '2026-10-01'); // 2번이 만들고 2번 후기만 → 지워짐
  const v2 = await addVisit(db, 2, p, '2026-10-02'); // 2번이 만들고 1번 후기도 → 남음
  const v3 = await addVisit(db, 1, p, '2026-10-03'); // 1번이 만들고 2번 후기만 → 방문은 남음(1번 것)
  await addReview(db, 2, p, v1); await addReview(db, 2, p, v2); await addReview(db, 1, p, v2); await addReview(db, 2, p, v3);
  await addCup(db, 2, a, p); await addCup(db, 1, a, p);
  // 방 B: 2번의 후기·기록
  const pb = await addPlace(db, 4, b, 'B 장소');
  const vb = await addVisit(db, 2, pb);
  await addReview(db, 2, pb, vb); await addCup(db, 2, b, pb);
  const color2 = (await members(db, a))[1].color;

  const [r] = await run(db, asUser(2), 'select public.leave_room($1) as r', [a]);
  assert.deepEqual(r.r, { room_deleted: false, new_owner: null });

  assert.deepEqual((await members(db, a)).map((m) => m.user_id), [uid(1), uid(3)]);
  assert.equal(await count(db, 'select 1 from public.reviews where author_id = $1 and place_id = $2', [uid(2), p]), 0);
  assert.equal(await count(db, 'select 1 from public.reviews where author_id = $1 and place_id = $2', [uid(1), p]), 1);
  assert.deepEqual((await db.query('select id from public.visits where place_id = $1 order by visited_on', [p])).rows.map((x) => x.id), [v2, v3]);
  assert.equal(await count(db, 'select 1 from public.places where id = $1', [p]), 1, '내가 담은 장소는 남음');
  assert.equal(await count(db, 'select 1 from public.place_photos where path = $1', [photo]), 1, '내가 올린 사진은 남음');
  assert.equal(await count(db, 'select 1 from public.cup_results where couple_id = $1 and user_id = $2', [a, uid(2)]), 0);
  assert.equal(await count(db, 'select 1 from public.cup_results where couple_id = $1 and user_id = $2', [a, uid(1)]), 1);
  // 다른 방(B)의 내 후기·기록·멤버십은 그대로
  assert.equal(await count(db, 'select 1 from public.reviews where author_id = $1 and place_id = $2', [uid(2), pb]), 1);
  assert.equal(await count(db, 'select 1 from public.cup_results where couple_id = $1 and user_id = $2', [b, uid(2)]), 1);
  assert.equal(await count(db, 'select 1 from public.couple_members where couple_id = $1 and user_id = $2', [b, uid(2)]), 1);
  // 나간 사람 색을 남은 멤버가 바로 고를 수 있음
  assert.equal((await run(db, asUser(3), 'select public.set_member_color($1, $2) as c', [a, color2]))[0].c, color2);
  // 다시 나가기 → not_member, 남이 나가기 → not_member
  await expectError(run(db, asUser(2), 'select public.leave_room($1)', [a]), 'not_member');
  await expectError(run(db, asUser(4), 'select public.leave_room($1)', [a]), 'not_member');
  await expectError(run(db, { role: 'authenticated' }, 'select public.leave_room($1)', [a]), 'not_authenticated');
  // 나간 뒤에는 방 A가 안 보임
  assert.equal((await run(db, asUser(2), 'select id from public.couples where id = $1', [a])).length, 0);
  assert.equal((await run(db, asUser(2), 'select id from public.places where couple_id = $1', [a])).length, 0);
  await db.close();
});

// ---------- 10. leave_room (방장) ----------
test('10. leave_room(방장): 가장 먼저 들어온 남은 멤버가 방장, 방장은 늘 1명', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3, 4);
  const room = await createRoom(db, 1);
  const code = await codeOf(db, room);
  await join(db, 3, code); await join(db, 2, code); await join(db, 4, code); // 들어온 순서: 3, 2, 4

  let [r] = await run(db, asUser(1), 'select public.leave_room($1) as r', [room]);
  assert.deepEqual(r.r, { room_deleted: false, new_owner: uid(3) });
  assert.equal(await ownerCount(db, room), 1);
  assert.equal((await members(db, room)).find((m) => m.role === 'owner').user_id, uid(3));
  // 새 방장은 이름을 바꿀 수 있고, 예전 방장은 이제 남
  await run(db, asUser(3), "select public.rename_room($1, '새 방장 방')", [room]);
  await expectError(run(db, asUser(1), "select public.rename_room($1, 'x')", [room]), 'not_member');

  // 방장 아닌 멤버가 나가면 new_owner null, 방장 그대로
  [r] = await run(db, asUser(4), 'select public.leave_room($1) as r', [room]);
  assert.deepEqual(r.r, { room_deleted: false, new_owner: null });
  [r] = await run(db, asUser(3), 'select public.leave_room($1) as r', [room]);
  assert.deepEqual(r.r, { room_deleted: false, new_owner: uid(2) });
  assert.equal(await ownerCount(db, room), 1);
  // created_by(만든 사람)는 그대로
  assert.equal((await db.query('select created_by from public.couples where id = $1', [room])).rows[0].created_by, uid(1));
  await db.close();
});

// ---------- 11·12. 마지막 멤버 / begin_room_delete ----------
test('11·12. begin_room_delete → leave_room(마지막): 사진 경로를 돌려주고 방과 데이터를 모두 지움', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3);
  const room = await createRoom(db, 1, '지울 방');
  const keep = await createRoom(db, 3, '남는 방');
  const pk = await addPlace(db, 3, keep);
  await addPhoto(db, 3, pk, 'keep.jpg');
  const code = await codeOf(db, room);
  await join(db, 2, code);

  const p1 = await addPlace(db, 1, room, '하나');
  const p2 = await addPlace(db, 2, room, '둘', '카페');
  const ph1 = await addPhoto(db, 1, p1, 'x.jpg');
  const ph2 = await addPhoto(db, 2, p2, 'y.jpg');
  await db.query('update public.places set photo_path = $1 where id = $2', [`${p2}/old.jpg`, p2]); // 예전 사진 칸
  const v = await addVisit(db, 1, p1);
  await addReview(db, 1, p1, v); await addReview(db, 2, p1, v);
  await addCup(db, 1, room, p1); await addCup(db, 2, room, p2);

  const brd = (n) => run(db, asUser(n), 'select public.begin_room_delete($1) as paths', [room]);
  await expectError(brd(1), 'not_last_member');
  await expectError(brd(3), 'not_member');
  await expectError(run(db, asUser(1), 'select public.begin_room_delete($1)', [uid(999)]), 'not_member');
  await run(db, asUser(2), 'select public.leave_room($1)', [room]);

  const [{ paths }] = await brd(1);
  assert.deepEqual(paths, [ph1, ph2, `${p2}/old.jpg`].sort());
  assert.ok((await db.query('select deleting_at from public.couples where id = $1', [room])).rows[0].deleting_at);
  // 지우는 중에는 코드로 못 들어옴 (코드가 없는 것처럼)
  await expectError(join(db, 2, code), 'invalid_code');

  const [r] = await run(db, asUser(1), 'select public.leave_room($1) as r', [room]);
  assert.deepEqual(r.r, { room_deleted: true, new_owner: null });
  for (const [t, col] of [['couples', 'id'], ['couple_members', 'couple_id'], ['categories', 'couple_id'], ['places', 'couple_id'], ['cup_results', 'couple_id']]) {
    assert.equal(await count(db, `select 1 from public.${t} where ${col} = $1`, [room]), 0, `${t}가 남음`);
  }
  for (const t of ['visits', 'reviews', 'place_photos']) {
    assert.equal(await count(db, `select 1 from public.${t} where place_id in ($1, $2)`, [p1, p2]), 0, `${t}가 남음`);
  }
  // 사진 파일(storage.objects)은 SQL이 건드리지 않음 (화면이 Storage API로 지움)
  assert.equal(await count(db, 'select 1 from storage.objects where name in ($1, $2)', [ph1, ph2]), 2);
  // 다른 방은 그대로
  assert.equal(await count(db, 'select 1 from public.places where couple_id = $1', [keep]), 1);
  assert.equal(await count(db, 'select 1 from public.place_photos where place_id = $1', [pk]), 1);
  await db.close();
});

test('11b. leave_room(혼자 남음)인데 begin_room_delete를 안 불렀거나 15분이 지났으면 last_member, 방은 그대로', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2);
  const room = await createRoom(db, 1, '동시에 나가기');
  await join(db, 2, await codeOf(db, room));
  const p = await addPlace(db, 1, room);
  await addPhoto(db, 1, p, 'keep.jpg');
  // 둘이 거의 동시에 나감: 2번이 먼저 나가서 1번은 혼자가 됐지만 1번 화면은 보통 나가기 확인만 받음
  await run(db, asUser(2), 'select public.leave_room($1)', [room]);
  await expectError(run(db, asUser(1), 'select public.leave_room($1)', [room]), /(^|[^_])last_member/);
  assert.equal(await count(db, 'select 1 from public.couples where id = $1', [room]), 1);
  assert.equal(await count(db, 'select 1 from public.place_photos where place_id = $1', [p]), 1);
  // begin_room_delete 뒤 15분이 지나면 다시 처음부터
  await run(db, asUser(1), 'select public.begin_room_delete($1)', [room]);
  await db.query("update public.couples set deleting_at = now() - interval '16 minutes' where id = $1", [room]);
  await expectError(run(db, asUser(1), 'select public.leave_room($1)', [room]), /(^|[^_])last_member/);
  // 다시 begin_room_delete를 부르면 지울 수 있음
  await run(db, asUser(1), 'select public.begin_room_delete($1)', [room]);
  const [r] = await run(db, asUser(1), 'select public.leave_room($1) as r', [room]);
  assert.deepEqual(r.r, { room_deleted: true, new_owner: null });
  await db.close();
});

test('12b. begin_room_delete는 그 장소 폴더 밖의 예전 사진 칸 경로를 돌려주지 않음, photo_path는 앱에서 못 고침', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2);
  // 방 R2(1, 2): 2번의 사진. 1번은 경로를 알아 둔 뒤 R2에서 나감
  const r2 = await createRoom(db, 2, 'R2');
  await join(db, 1, await codeOf(db, r2));
  const p2 = await addPlace(db, 2, r2, 'R2 장소');
  const victim = await addPhoto(db, 2, p2, 'x.jpg');
  await run(db, asUser(1), 'select public.leave_room($1)', [r2]);
  // 방 R1(2, 1): 1번이 R1 장소의 예전 사진 칸에 R2 경로를 넣으려 함 → 권한 없음
  const r1 = await createRoom(db, 2, 'R1');
  await join(db, 1, await codeOf(db, r1));
  const p1 = await addPlace(db, 1, r1, 'R1 장소');
  await expectError(run(db, asUser(1), 'update public.places set photo_path = $1 where id = $2', [victim, p1]), PERM);
  // 적용 전에 이미 들어가 있던 값(관리자로 넣음)이라도, 마지막 멤버가 지울 때 돌려받지 않음
  await db.query('update public.places set photo_path = $1 where id = $2', [victim, p1]);
  const own = await addPlace(db, 2, r1, '내 장소');
  await db.query('update public.places set photo_path = $1 where id = $2', [`${own}/old.jpg`, own]);
  await run(db, asUser(1), 'select public.leave_room($1)', [r1]);
  const [{ paths }] = await run(db, asUser(2), 'select public.begin_room_delete($1) as paths', [r1]);
  assert.deepEqual(paths, [`${own}/old.jpg`]);
  assert.ok(!paths.includes(victim));
  // 장소 정보 고치기(다른 열)는 그대로 됨
  assert.equal((await run(db, asUser(2), "update public.places set name = '새 이름' where id = $1 returning id", [own])).length, 1);
  await db.close();
});

test('9b. 나간 뒤 남은 후기(나가기와 동시에 쓴 것)는 고칠 수 없음, 멤버는 그대로 고침', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2);
  const room = await createRoom(db, 1);
  await join(db, 2, await codeOf(db, room));
  const p = await addPlace(db, 1, room);
  const v = await addVisit(db, 1, p);
  const mine = await addReview(db, 1, p, v, 4, '방장 후기');
  await run(db, asUser(2), 'select public.leave_room($1)', [room]);
  // 나가기와 경쟁해서 남은 후기 흉내(관리자로 넣음)
  const [left] = (await db.query(
    "insert into public.reviews (place_id, visit_id, author_id, rating, body) values ($1, $2, $3, 1, '남은 후기') returning id",
    [p, v, uid(2)])).rows;
  // WHERE·RETURNING이 있으면 보기 정책(멤버만)도 걸리므로, 열을 읽지 않는 update(조건 없이 내 후기 전부)로 확인
  await run(db, asUser(2), "update public.reviews set rating = 5, body = '고침'");
  assert.equal((await db.query('select body from public.reviews where id = $1', [left.id])).rows[0].body, '남은 후기', '나간 사람은 못 고침');
  const upd = (n, id) => run(db, asUser(n), "update public.reviews set rating = 5, body = '고침' where id = $1 returning id", [id]);
  assert.equal((await upd(2, left.id)).length, 0);
  assert.equal((await upd(1, mine)).length, 1, '멤버는 자기 후기를 고침');
  await db.close();
});

// ---------- 13. 권한 ----------
test('13. 권한: anon은 새 함수 모두 불가, authenticated는 정해진 것만', async () => {
  const db = await newDb();
  await addUsers(db, 1);
  const room = await createRoom(db, 1);
  const u = uid(1);
  const calls = {
    create_couple: ["select public.create_couple('a', 'b')", []],
    join_couple: ["select public.join_couple('FFFFFFFF', 'a')", []],
    join_couple_for: ["select public.join_couple_for($1, 'FFFFFFFF', 'a')", [u]],
    space_code_open: ["select public.space_code_open('FFFFFFFF')", []],
    rename_room: ['select public.rename_room($1, $2)', [room, 'x']],
    set_member_color: ["select public.set_member_color($1, 'pink')", [room]],
    begin_room_delete: ['select public.begin_room_delete($1)', [uid(999)]],
    leave_room: ['select public.leave_room($1)', [uid(999)]],
    groups_schema_version: ['select public.groups_schema_version()', []],
    pick_member_color: ['select public.pick_member_color($1)', [room]],
  };
  for (const [name, [sql, params]] of Object.entries(calls)) {
    await expectError(run(db, ANON, sql, params), PERM).catch((e) => { throw new Error(`anon ${name}: ${e.message}`); });
  }
  for (const name of ['join_couple', 'join_couple_for', 'space_code_open', 'pick_member_color']) {
    const [sql, params] = calls[name];
    await expectError(run(db, asUser(1), sql, params), PERM).catch((e) => { throw new Error(`authenticated ${name}: ${e.message}`); });
  }
  // authenticated가 부를 수 있는 것: 권한 오류가 아니라 함수 자체의 결과·오류가 나와야 함
  const allowed = { rename_room: null, set_member_color: null, begin_room_delete: 'not_member', leave_room: 'not_member', groups_schema_version: null };
  for (const [name, err] of Object.entries(allowed)) {
    const [sql, params] = calls[name];
    if (err) await expectError(run(db, asUser(1), sql, params), err);
    else await run(db, asUser(1), sql, params);
  }
  assert.equal((await run(db, SERVICE, 'select public.groups_schema_version() as v'))[0].v, 1);
  // member_colors는 앱에서 못 읽음, 트리거 함수는 직접 못 부름
  await expectError(run(db, asUser(1), 'select * from public.member_colors'), PERM);
  await expectError(run(db, ANON, 'select * from public.member_colors'), PERM);
  await expectError(run(db, ANON, 'select * from public.couples'), PERM);
  await expectError(run(db, ANON, 'select * from public.couple_members'), PERM);
  // 앱이 멤버 행을 직접 넣거나 지울 수 없음 (참여·나가기는 함수로만)
  await expectError(run(db, asUser(1), "insert into public.couple_members (couple_id, user_id, display_name) values ($1, $2, 'x')", [room, u]), PERM);
  await expectError(run(db, asUser(1), 'delete from public.couple_members where couple_id = $1', [room]), PERM);
  // security definer 함수는 모두 search_path = ''
  const bad = (await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows.map((r) => r.proname);
  assert.deepEqual(bad, []);
  await db.close();
});

// ---------- 14. RLS ----------
test('14. RLS: 방끼리 모든 표가 막힘, 두 방 멤버는 둘 다, 초대 코드는 멤버만, 닉네임은 방마다', async () => {
  const db = await newDb();
  await addUsers(db, 1, 2, 3);
  // A: 1, 2 / B: 3, 2  (2는 두 방 모두)
  const a = await createRoom(db, 1, 'A');
  const b = await createRoom(db, 3, 'B');
  await join(db, 2, await codeOf(db, a), 'A닉');
  await join(db, 2, await codeOf(db, b), 'B닉');
  const seed = async (n, room, tag) => {
    const p = await addPlace(db, n, room, tag);
    const v = await addVisit(db, n, p);
    await addReview(db, n, p, v);
    await addPhoto(db, n, p, `${tag}.jpg`);
    await addCup(db, n, room, p);
    return p;
  };
  const pa = await seed(1, a, 'a');
  const pb = await seed(3, b, 'b');

  // 표마다 "그 사용자가 보는 방" 집합
  const roomsSeen = async (n) => {
    const q = async (sql) => new Set((await run(db, asUser(n), sql)).map((r) => r.c));
    return {
      couples: await q('select id as c from public.couples'),
      couple_members: await q('select couple_id as c from public.couple_members'),
      categories: await q('select couple_id as c from public.categories'),
      places: await q('select couple_id as c from public.places'),
      visits: await q('select p.couple_id as c from public.visits v join public.places p on p.id = v.place_id'),
      reviews: await q('select p.couple_id as c from public.reviews r join public.places p on p.id = r.place_id'),
      cup_results: await q('select couple_id as c from public.cup_results'),
      place_photos: await q('select p.couple_id as c from public.place_photos ph join public.places p on p.id = ph.place_id'),
      'storage.objects': new Set((await run(db, asUser(n), 'select name from storage.objects')).map((r) => (r.name.startsWith(pa) ? a : r.name.startsWith(pb) ? b : r.name))),
    };
  };
  const expectRooms = async (n, rooms) => {
    const seen = await roomsSeen(n);
    for (const [t, s] of Object.entries(seen)) assert.deepEqual([...s].sort(), [...rooms].sort(), `사용자 ${n}, 표 ${t}`);
  };
  await expectRooms(1, [a]);
  await expectRooms(3, [b]);
  await expectRooms(2, [a, b]);

  // 다른 방에 쓰기: 넣기는 RLS 위반, 고치기·지우기는 0행
  await expectError(addPlace(db, 1, b, '침입'), /row-level security/);
  await expectError(addCup(db, 1, b, pb, 2020), /row-level security/);
  await expectError(run(db, asUser(1), "insert into public.categories (couple_id, name) values ($1, '침입')", [b]), /row-level security/);
  await run(db, asUser(1), "update public.places set name = '바뀜' where id = $1", [pb]);
  await run(db, asUser(1), 'delete from public.place_photos where place_id = $1', [pb]);
  await run(db, asUser(1), 'delete from public.places where id = $1', [pb]);
  assert.equal((await db.query('select name from public.places where id = $1', [pb])).rows[0].name, 'b');
  assert.equal(await count(db, 'select 1 from public.place_photos where place_id = $1', [pb]), 1);

  // 초대 코드: 멤버만 (남의 방 행은 아예 안 보임)
  assert.equal((await run(db, asUser(1), 'select invite_code from public.couples where id = $1', [a]))[0].invite_code, await codeOf(db, a));
  assert.equal((await run(db, asUser(1), 'select invite_code from public.couples where id = $1', [b])).length, 0);
  assert.equal((await run(db, asUser(2), 'select invite_code from public.couples where id = $1', [b]))[0].invite_code, await codeOf(db, b));

  // 닉네임: 방 조건을 붙이면 그 방만 바뀜
  await run(db, asUser(2), "update public.couple_members set display_name = 'A새닉' where couple_id = $1 and user_id = $2", [a, uid(2)]);
  const nick = async (room) => (await db.query('select display_name from public.couple_members where couple_id = $1 and user_id = $2', [room, uid(2)])).rows[0].display_name;
  assert.equal(await nick(a), 'A새닉');
  assert.equal(await nick(b), 'B닉');

  // 나간 뒤에는 그 방이 안 보임
  await run(db, asUser(1), 'select public.leave_room($1)', [a]);
  await expectRooms(1, []);
  await db.close();
});

// ---------- 15. 되돌리기 ----------
test('15. 되돌리기: 여러 방 멤버가 있으면 멈춤, 성공하면 적용 전과 같음, 다시 적용 가능', async () => {
  const db = await newDb({ groups: false });
  const before = await snapshot(db);
  await db.exec(SQL('groups.sql'));
  const afterGroups = await snapshot(db);
  // groups.sql이 바꾸는 RLS 정책은 '후기 고치기' 하나뿐
  const REVIEW_UPDATE = 'Authors can update own reviews';
  const others = (list) => list.filter((x) => !x.includes(REVIEW_UPDATE));
  assert.deepEqual(others(afterGroups.policies), others(before.policies), 'groups.sql은 후기 고치기 말고 다른 정책을 바꾸지 않음');
  assert.notDeepEqual(afterGroups.policies, before.policies, '후기 고치기 정책에 멤버 조건이 붙음');
  assert.match(afterGroups.policies.find((x) => x.includes(REVIEW_UPDATE)), /is_couple_member/);

  await addUsers(db, 1, 2, 3, 4);
  const a = await createRoom(db, 1, 'A');
  for (const n of [2, 3]) await join(db, n, await codeOf(db, a)); // A: 1, 2, 3 (3명)
  const b = await createRoom(db, 4, 'B');
  await join(db, 2, await codeOf(db, b)); // 2는 두 방
  const colorsA = (await members(db, a)).map((m) => [m.user_id, m.color]);

  await expectError(db.exec(SQL('groups_rollback.sql')), /여러 방에 들어간 사람이 1명 있어서 되돌릴 수 없어요/);
  await db.exec('rollback').catch(() => {});
  assert.equal(await count(db, 'select 1 from public.member_colors'), 40, '실패하면 아무것도 안 바뀜');

  await run(db, asUser(2), 'select public.leave_room($1)', [b]);
  await db.exec(SQL('groups_rollback.sql'));

  const after = await snapshot(db);
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `되돌린 뒤 ${k}가 적용 전과 다름`);
  assert.equal(await count(db, "select 1 from information_schema.columns where table_name = 'couple_members' and column_name = 'color'"), 0);
  const backups = (await db.query("select table_name from information_schema.tables where table_schema = 'backup' and table_name like 'couple_members_colors_%'")).rows;
  assert.equal(backups.length, 1);
  const saved = (await db.query(`select user_id, color from backup.${backups[0].table_name} where couple_id = $1 order by user_id`, [a])).rows;
  assert.deepEqual(saved.map((r) => [r.user_id, r.color]), [...colorsA].sort((x, y) => x[0].localeCompare(y[0])));
  assert.equal(await codeOf(db, a), null, '2명 이상인 방은 코드 없음');
  assert.match(await codeOf(db, b), CODE_RE, '1명인 방은 코드 그대로');
  assert.equal(await count(db, 'select 1 from public.couple_members where couple_id = $1', [a]), 3, '3명 방은 그대로 남음');
  // 예전 규칙이 돌아옴: 이미 방이 있으면 already_in_couple
  await expectError(run(db, asUser(1), "select public.create_couple('a', 'b')"), 'already_in_couple');

  // 다시 적용: 3명 방도 받아들이고 색은 teal, amber, 그다음 목록 순서
  await db.exec(SQL('groups.sql'));
  const again = await members(db, a);
  assert.deepEqual(again.map((m) => [m.user_id, m.color]), [[uid(1), 'teal'], [uid(2), 'amber'], [uid(3), 'orange']]);
  assert.match(await codeOf(db, a), CODE_RE);
  assert.deepEqual((await snapshot(db)).functions, afterGroups.functions, '다시 적용한 함수·권한이 처음 적용과 같음');
  await db.close();
});
