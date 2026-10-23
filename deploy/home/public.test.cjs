// deploy/home/public.cjs·pages.cjs 테스트 (가짜 Supabase로, 운영 서버·Supabase에 연결하지 않음). 실행: node --test "deploy/home/*.test.cjs"
// docs/public-rooms-design.md §6.2 S1–S10, S14
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./public.cjs');
const pagesLib = require('./pages.cjs');

const SUPA = 'https://abcdefghijklmnopqrst.supabase.co';
const PUB = 'sb_publishable_testtesttesttest';
const SECRET = 'sb_secret_testsecretsecretsecret';
const KEY = 'k7m2p9xa4c';
const KEY2 = 'h3n8q2w5zt';
const INVITE = 'C0FFEE01'; // 그 방의 초대 코드: 공개 응답 어디에도 나오면 안 됨
const ROOM_ID = 'dddddddd-0000-4000-8000-00000000000d';
const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = '22222222-3333-4444-8555-666666666666';
const OWNER_ID = '99999999-0000-4000-8000-000000000009';
const T0 = Date.UTC(2026, 9, 22, 3, 0, 0); // KST 2026-10-22 12:00
const tokenOf = (id) => `at.${id}.sig`;
const idOfBearer = (h) => (/^Bearer at\.([^.]+)\.sig$/.exec(String(h || '')) || [])[1] || '';
const placeId = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
// 사진 파일 이름: 화면 photoId()처럼 무작위 16진수 32자 (장소 번호·사진 번호를 넣어 시험에서 찾기 쉽게)
const fname = (i, j) => `${String(i).padStart(4, '0')}${String(j).padStart(4, '0')}`.padEnd(32, 'a');
const photoOf = (i, j) => `${placeId(i)}/${fname(i, j)}.jpg`;
const thumbOf = (i, j) => `${placeId(i)}/t/${fname(i, j)}.jpg`;
const UPLOADED = 'Sat, 05 Sep 2026 10:11:12 GMT'; // 가짜 Storage의 Last-Modified(업로드 시각): 공개 응답에 나오면 안 됨
// 서버가 주는 사진 주소: /api/public/img/<만료 초>.<HMAC 43자>/<경로>
const IMG_URL_RE = /^\/api\/public\/img\/(\d{10})\.([A-Za-z0-9_-]{43})\/(.+)$/;
const imgPath = (u) => (IMG_URL_RE.exec(String(u || '')) || [])[3] || null;
const imgExp = (u) => Number((IMG_URL_RE.exec(String(u || '')) || [])[1] || 0);

// 공개 방 JSON (public_room_view 모양). SQL이 실수로 넣었다고 치는 키(초대 코드·uuid·찜·이메일)를 섞어 둔다
function makeRoom({ key = KEY, places = 2, photosPer = 2, thumbs = true, leak = true } = {}) {
  const extra = (o) => (leak ? { ...o, invite_code: INVITE, couple_id: ROOM_ID, user_id: OWNER_ID, created_by: OWNER_ID, favorite: true, email: `owner@id.example.com` } : o);
  return extra({
    v: 1, key, name: '서울 라멘 지도', description: '둘이 먹어 본 서울 라멘집', member_count: 2, place_count: places, truncated: false, active: 'week',
    members: [extra({ m: 'm1', name: '민수', color: 'teal', role: 'owner' }), extra({ m: 'm2', name: '지훈', color: '#8b5e3c' })],
    categories: ['맛집', '카페', '기타'],
    places: Array.from({ length: places }, (_, i) => {
      const id = placeId(i + 1);
      return extra({
        id, name: `라멘집 ${i + 1}`, category: '맛집', address: '서울 마포구', map_url: 'https://naver.me/abc', status: i % 2 ? 'want_to_go' : 'visited',
        shared_note: '토요일 11시 오픈런', added_month: '2026-09', added_by: 'm1', updated_at: '2026-09-03T10:00:00Z',
        visits: [extra({ month: '2026-10', visited_on: '2026-10-05', reviews: [extra({ by: 'm2', rating: 4.5, body: '국물이 진함', author_id: U2 })] })],
        photo_count: photosPer + 2,
        photos: Array.from({ length: photosPer }, (_, j) => ({ path: photoOf(i + 1, j), thumb: thumbs ? thumbOf(i + 1, j) : null, created_at: '2026-09-03T10:00:00Z' })),
      });
    }),
  });
}
const listRow = (key, over = {}) => ({
  key, name: `방 ${key}`, description: '소개', member_count: 2, colors: ['teal', '#8b5e3c'], place_count: 3, visited_count: 1, review_count: 2, active: 'month',
  invite_code: INVITE, couple_id: ROOM_ID, owner: OWNER_ID, ...over,
});

// ---------- 가짜 요청·응답 ----------
function fakeReq({ url, method = 'GET', token, ip = '203.0.113.7', headers = {} }) {
  return {
    url, method,
    headers: { ...(ip ? { 'cf-connecting-ip': ip } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
}
function fakeRes() {
  return {
    status: 0, headers: {}, text: '', headersSent: false,
    writeHead(status, h) { this.status = status; Object.assign(this.headers, h); this.headersSent = true; },
    end(b) { this.text = b ? String(b) : ''; },
    get json() { return this.text ? JSON.parse(this.text) : null; },
  };
}

// ---------- 가짜 Supabase ----------
function fakeSupabase({ over = {} } = {}) {
  const db = { users: new Set([U1, U2]), rooms: new Map([[KEY, makeRoom()]]), list: [listRow(KEY)], missing: new Set() };
  const calls = [];
  const isAdmin = (h) => h.apikey === SECRET && h.authorization === `Bearer ${SECRET}`;
  const deny = { status: 401, body: { message: 'Invalid API key' } };
  const routes = {
    'GET /auth/v1/user': (c) => {
      if (c.headers.apikey !== PUB) return deny;
      const id = idOfBearer(c.headers.authorization);
      if (id === 'down') return { status: 500, body: {} };
      if (!db.users.has(id)) return { status: 403, body: { error_code: 'bad_jwt' } };
      return { status: 200, body: { id } };
    },
    'POST /rest/v1/rpc/public_room_list': (c) => (isAdmin(c.headers) ? { status: 200, body: db.list } : deny),
    'POST /rest/v1/rpc/public_room_view': (c) => (isAdmin(c.headers) ? { status: 200, body: db.rooms.get(c.body.p_key) ?? null } : deny),
    'POST /rest/v1/rpc/maintenance_photo_active': (c) => (isAdmin(c.headers) ? { status: 200, body: true } : deny),
    // 사진 바이트: Storage처럼 Last-Modified(업로드 시각)·ETag를 붙여 줌 → 서버가 버려야 함. 없는 파일은 Storage처럼 400
    'GET /storage/v1/object/authenticated/place-photos/:path': (c) => {
      if (!isAdmin(c.headers)) return deny;
      const p = decodeURIComponent(c.path.slice('/storage/v1/object/authenticated/place-photos/'.length));
      if (db.missing.has(p)) return { status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } };
      const bytes = Buffer.from(`jpeg:${p}`);
      return { status: 200, bytes, headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'last-modified': UPLOADED, etag: '"e1"', 'cache-control': 'max-age=3600' } };
    },
  };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    assert.equal(u.origin, SUPA, '프로젝트 주소로만 보냄');
    assert.equal(init.redirect, 'error');
    const method = init.method || 'GET';
    const c = { method, path: u.pathname + u.search, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    let key = `${method} ${u.pathname}`;
    if (u.pathname.startsWith('/storage/v1/object/authenticated/place-photos/')) key = `${method} /storage/v1/object/authenticated/place-photos/:path`;
    const h = over[key] || routes[key];
    if (!h) return respond({ status: 404, body: { message: 'no route' } });
    return respond(await h(c, db));
  }
  function respond(out) {
    const h = Object.fromEntries(Object.entries(out.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const bytes = out.bytes !== undefined ? Buffer.from(out.bytes) : Buffer.from(out.body === undefined ? '' : JSON.stringify(out.body));
    return {
      ok: out.status >= 200 && out.status < 300, status: out.status,
      headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
      text: async () => bytes.toString(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  const count = (prefix) => calls.filter((c) => `${c.method} ${c.path}`.startsWith(prefix)).length;
  return { db, calls, fetchImpl, count };
}

function setup({ over, opts = {}, sbOver } = {}) {
  const sb = fakeSupabase({ over: sbOver || over });
  const logs = [];
  const t = { now: T0 };
  const api = P.createPublicApi({
    supabaseUrl: SUPA, publishableKey: PUB, secretKey: SECRET, fetchImpl: sb.fetchImpl, now: () => t.now,
    log: (m) => logs.push(String(m)), saveEveryMs: 0, ...opts,
  });
  const seen = [];
  async function get(url, o = {}) {
    const res = fakeRes();
    await api.handle(fakeReq({ url, token: tokenOf(U1), ...o }), res);
    seen.push(res.text);
    return res;
  }
  return { sb, logs, t, api, get, seen };
}
const ROOM_URL = `/api/public/rooms/${KEY}`;
const keys = (o) => Object.keys(o).sort();

// ---------- S1 로그인 ----------
test('S1 로그인: 토큰 없음·틀림 401(login: true), 확인 실패 502, 토큰→사용자 60초 캐시', async () => {
  const { get, sb, t } = setup();
  let r = await get('/api/public/rooms', { token: '' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: P.PMSG.login, login: true });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(sb.count('POST /rest'), 0, '로그인 전에는 DB를 부르지 않음');
  r = await get('/api/public/rooms', { token: tokenOf('nobody') });
  assert.equal(r.status, 401);
  assert.equal(r.json.login, true);
  r = await get('/api/public/rooms', { token: tokenOf('down') });
  assert.equal(r.status, 502);
  r = await get('/api/public/rooms', { headers: { authorization: 'Bearer not-a-jwt' }, token: '' });
  assert.equal(r.status, 401);
  // 캐시: 같은 토큰 두 번째는 /auth/v1/user를 안 부름, 60초 지나면 다시
  const before = sb.count('GET /auth/v1/user');
  assert.equal((await get('/api/public/rooms')).status, 200);
  assert.equal((await get('/api/public/rooms')).status, 200);
  assert.equal(sb.count('GET /auth/v1/user'), before + 1);
  t.now += 61_000;
  assert.equal((await get('/api/public/rooms')).status, 200);
  assert.equal(sb.count('GET /auth/v1/user'), before + 2);
  // 사용자 쪽 요청에는 secret key를 안 보냄
  for (const c of sb.calls.filter((x) => x.path.startsWith('/auth/'))) assert.ok(!JSON.stringify(c.headers).includes(SECRET));
});

// ---------- S2 키 형식·없는 방 ----------
test('S2 키 형식이 틀리면 DB를 안 부르고 404, 없는 방도 404이고 그 결과도 캐시', async () => {
  const { get, sb } = setup();
  for (const bad of ['ABCDEF12', INVITE, 'k7m2p9xa4', 'k7m2p9xa4cc', 'K7M2P9XA4C', 'k7m2p9xa4l', 'k7m2p9xa40', '..%2F..']) {
    const r = await get(`/api/public/rooms/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.equal(r.json.error, P.PMSG.gone);
  }
  assert.equal((await get('/api/public/rooms/ABCDEF12/photo?place=x&i=0')).status, 404);
  assert.equal(sb.count('POST /rest'), 0);
  assert.equal(sb.count('GET /auth'), 0, '형식이 틀리면 로그인 확인도 안 함');
  let r = await get(`/api/public/rooms/${KEY2}`);
  assert.equal(r.status, 404);
  r = await get(`/api/public/rooms/${KEY2}`);
  assert.equal(r.status, 404);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 1, '없는 방(null)도 캐시');
  // 그 밖의 경로·메서드
  assert.equal((await get('/api/public/other')).status, 404);
  assert.equal((await get(`/api/public/rooms/${KEY}/x`)).status, 404);
  r = await get('/api/public/rooms', { method: 'POST' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET, HEAD');
  r = await get(`/api/public/rooms/${KEY}/photo?place=${placeId(1)}&i=0`, { method: 'HEAD' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET');
});

// ---------- S3 캐시·헤더 ----------
test('S3 방 120초·목록 60초 캐시, 지나면 다시 부름. 헤더 private, max-age=60 + noindex', async () => {
  const { get, sb, t } = setup();
  const r = await get(ROOM_URL);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'private, max-age=60');
  assert.equal(r.headers.vary, 'Authorization');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  await get('/api/public/rooms');
  t.now += 59_000;
  await get(ROOM_URL);
  await get('/api/public/rooms');
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 1);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_list'), 1);
  t.now += 2_000; // 61초: 목록만 다시
  await get(ROOM_URL);
  await get('/api/public/rooms');
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 1);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_list'), 2);
  t.now += 60_000; // 121초: 방도 다시
  await get(ROOM_URL);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 2);
  // 오류 응답은 no-store, 실패는 캐시하지 않음
  const down = setup({ over: { 'POST /rest/v1/rpc/public_room_list': () => ({ status: 500, body: {} }) } });
  const e = await down.get('/api/public/rooms');
  assert.equal(e.status, 502);
  assert.equal(e.json.error, P.PMSG.down);
  assert.equal(e.headers['cache-control'], 'no-store');
  assert.equal(e.headers['x-robots-tag'], 'noindex, nofollow');
  await down.get('/api/public/rooms');
  assert.equal(down.sb.count('POST /rest/v1/rpc/public_room_list'), 2);
  // 동시에 같은 방을 여러 번 열어도 DB는 한 번
  const c = setup();
  await Promise.all([1, 2, 3].map(() => c.get(ROOM_URL)));
  assert.equal(c.sb.count('POST /rest/v1/rpc/public_room_view'), 1);
});

test('준비 전(secret key 확인 전)은 503 + retry-after, HEAD는 본문 없이', async () => {
  let ready = false;
  const { get, sb, api } = setup({ opts: { isReady: () => ready } });
  const r = await get('/api/public/rooms');
  assert.equal(r.status, 503);
  assert.equal(r.headers['retry-after'], '60');
  assert.equal(sb.calls.length, 0);
  ready = true;
  const h = await get('/api/public/rooms', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.text, '');
  const hv = await get(ROOM_URL, { method: 'HEAD' });
  assert.equal(hv.status, 200);
  assert.equal(api.budget.snapshot().thumbs, 0, 'HEAD는 사진 주소를 주지 않음(한도 안 씀)');
});

// ---------- S4 횟수 제한 ----------
test('S4 횟수 제한: 사람마다 방 30, IP마다 30, 다른 사람·다른 IP는 됨, 429 + Retry-After', async () => {
  const { get, sb, t } = setup();
  sb.db.rooms.set(KEY, makeRoom({ photosPer: 0 }));
  for (let i = 0; i < 30; i++) assert.equal((await get(ROOM_URL, { ip: `198.51.100.${i}` })).status, 200, `${i}`);
  let r = await get(ROOM_URL, { ip: '198.51.100.200' });
  assert.equal(r.status, 429, '같은 사람은 IP가 달라도 31번째 429');
  assert.ok(Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 60);
  assert.equal(r.json.error, P.PMSG.tooMany);
  assert.equal((await get(ROOM_URL, { ip: '198.51.100.201', token: tokenOf(U2) })).status, 200, '다른 사람은 됨');
  // 목록은 따로 셈
  assert.equal((await get('/api/public/rooms', { ip: '198.51.100.202' })).status, 200);
  // 같은 IP에서 여러 사람: 합쳐 31번째 429
  t.now += 61_000;
  for (let i = 0; i < 30; i++) {
    const id = `33333333-0000-4000-8000-${String(i).padStart(12, '0')}`;
    sb.db.users.add(id);
    assert.equal((await get(ROOM_URL, { ip: '192.0.2.9', token: tokenOf(id) })).status, 200);
  }
  r = await get(ROOM_URL, { ip: '192.0.2.9', token: tokenOf(U2) });
  assert.equal(r.status, 429);
  // IPv6는 /64 단위
  t.now += 61_000;
  for (let i = 0; i < 20; i++) assert.equal((await get('/api/public/rooms', { ip: `2001:db8:1:2::${i + 1}`, token: tokenOf(i % 2 ? U1 : U2) })).status, 200);
  assert.equal((await get('/api/public/rooms', { ip: '2001:db8:1:2:ffff::1', token: tokenOf(U2) })).status, 429);
  // 1분 지나면 풀림
  t.now += 61_000;
  assert.equal((await get(ROOM_URL, { ip: '192.0.2.9' })).status, 200);
});

test('S4 전체 제한: 공개 API 합쳐 분당 300, 301번째 429', async () => {
  const { get, sb } = setup();
  for (let i = 0; i < 300; i++) {
    const id = `44444444-0000-4000-8000-${String(i).padStart(12, '0')}`;
    sb.db.users.add(id);
    const r = await get(i % 2 ? '/api/public/rooms' : `/api/public/rooms/${KEY2}`, { ip: `10.0.${Math.floor(i / 200)}.${i % 200}`, token: tokenOf(id) });
    assert.ok(r.status === 200 || r.status === 404, `${i}: ${r.status}`);
  }
  const r = await get('/api/public/rooms', { ip: '10.9.9.9', token: tokenOf(U2) });
  assert.equal(r.status, 429);
});

// ---------- S5 썸네일 주소 ----------
test('S5 썸네일: 방 응답은 장소마다 대표 하나만, 이 서버의 1시간 서명 주소(저장소에 묻지 않음), 30분 이상 남은 주소는 다시 씀, 응답에 저장소 경로 키가 없음', async () => {
  const { get, sb, t } = setup({ opts: { budget: { userThumbs: 1000, dayThumbs: 1000 } } });
  sb.db.rooms.set(KEY, makeRoom({ places: 120, photosPer: 3 })); // 대표 썸네일 120개 (2·3번째는 상세에서)
  const r = await get(ROOM_URL);
  assert.equal(r.status, 200);
  assert.equal(sb.count('POST /storage') + sb.count('GET /storage'), 0, '서명은 서버 안에서');
  const urls = r.json.places.map((p) => p.photos[0].thumb_url);
  assert.equal(urls.length, 120);
  assert.ok(urls.every((u, i) => imgPath(u) === thumbOf(i + 1, 0)), '대표(첫) 썸네일만, 이 서버 주소로');
  assert.ok(urls.every((u) => imgExp(u) === Math.floor(T0 / 1000) + 3600));
  assert.ok(!r.text.includes(SUPA) && !r.text.includes('/storage/v1/'), 'Supabase 주소는 보내지 않음');
  assert.ok(r.json.places.every((p) => p.photos.length === 3 && p.photos[1].thumb_url === null && p.photos[2].thumb_url === null));
  assert.equal(r.json.photos_paused, false);
  for (const p of r.json.places) for (const ph of p.photos) assert.deepEqual(keys(ph), ['thumb_url']);
  assert.ok(!/"(path|thumb)"/.test(r.text));
  assert.ok(!r.text.includes(photoOf(1, 0)), '큰 사진 경로는 보내지 않음');
  // 10분 뒤(방 캐시는 지남): 같은 주소(브라우저 캐시가 맞게). 31분 뒤: 남은 시간 29분이라 새 주소
  t.now += 10 * 60_000;
  const r2 = await get(ROOM_URL, { token: tokenOf(U2) });
  assert.deepEqual(r2.json.places.map((p) => p.photos[0].thumb_url), urls, '주소 다시 씀');
  t.now += 21 * 60_000;
  const r3 = await get(ROOM_URL, { token: tokenOf(U2) });
  const urls3 = r3.json.places.map((p) => p.photos[0].thumb_url);
  assert.ok(urls3.every((u, i) => u !== urls[i] && imgPath(u) === thumbOf(i + 1, 0) && imgExp(u) === Math.floor(t.now / 1000) + 3600));
});

// ---------- S5b 사진 넘기기 (/api/public/img) ----------
test('V031 공개 사진: 메모리 캐시가 있어도 휴지통으로 이동한 사진은 재요청 시 404', async () => {
  let active=true;
  const {get}=setup({over:{'POST /rest/v1/rpc/maintenance_photo_active':()=>({status:200,body:active})}});
  const room=await get(ROOM_URL), url=room.json.places[0].photos[0].thumb_url;
  assert.equal((await get(url,{token:''})).status,200);
  active=false;
  assert.equal((await get(url,{token:''})).status,404);
});
test('S5b 사진: 서명 주소로 받으면 내용 종류·길이만 붙여 넘김(Last-Modified·ETag 없음), 로그인 토큰 없이, secret key로 저장소에서 받음', async () => {
  const { get, sb, api, t } = setup();
  const room = await get(ROOM_URL);
  const thumb = room.json.places[0].photos[0].thumb_url;
  const r = await get(thumb, { token: '' }); // <img>는 Authorization을 못 보냄
  assert.equal(r.status, 200);
  assert.equal(r.text, `jpeg:${thumbOf(1, 0)}`);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.headers['content-length'], Buffer.byteLength(`jpeg:${thumbOf(1, 0)}`));
  assert.equal(r.headers['cache-control'], 'private, max-age=3600');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  for (const h of ['last-modified', 'etag', 'vary', 'date', 'age']) assert.equal(r.headers[h], undefined, `${h} 없음`);
  assert.ok(!JSON.stringify(r.headers).includes('2026'), '업로드 시각이 헤더 어디에도 없음');
  const fetched = sb.calls.filter((c) => c.path.startsWith('/storage/v1/object/authenticated/place-photos/'));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].path, `/storage/v1/object/authenticated/place-photos/${thumbOf(1, 0)}`);
  assert.equal(fetched[0].headers.apikey, SECRET);
  // 썸네일은 10분 메모리 캐시: 다시 받아도 저장소에 한 번만. 한도는 주소를 줄 때만 셈(사진 받기로는 안 셈)
  const before = api.budget.snapshot();
  await get(thumb, { token: '' });
  assert.equal(sb.calls.filter((c) => c.path.startsWith('/storage/v1/object/authenticated/')).length, 1);
  assert.deepEqual(api.budget.snapshot(), before);
  // 큰 사진: 메모리에 2분, max-age는 주소 수명 10분
  const big = await get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`);
  const b1 = await get(big.json.url, { token: '' });
  assert.equal(b1.status, 200);
  assert.equal(b1.headers['cache-control'], 'private, max-age=600');
  assert.equal(b1.headers['last-modified'], undefined);
  await get(big.json.url, { token: '' });
  const bigFetches = () => sb.calls.filter((c) => c.path === `/storage/v1/object/authenticated/place-photos/${photoOf(1, 0)}`).length;
  assert.equal(bigFetches(), 1, '2분 안에는 다시 받지 않음');
  t.now += 121_000;
  assert.equal((await get(big.json.url, { token: '' })).status, 200);
  assert.equal(bigFetches(), 2);
  // max-age는 남은 시간이 아니라 주소 수명 전체(주소가 만료된 뒤 화면을 다시 그려도 브라우저 캐시로 보이게)
  t.now += 29 * 60_000;
  assert.equal((await get(thumb, { token: '' })).headers['cache-control'], 'private, max-age=3600');
  // HEAD·POST는 405
  const h = await get(thumb, { method: 'HEAD' });
  assert.equal(h.status, 405);
  assert.equal(h.headers.allow, 'GET');
});

test('S5c 사진 주소 확인: 서명·경로를 바꾸면 404, 만료 지나면 404, 없는 파일 404, 큰 파일·이상한 종류는 안 넘김, 사진 끔 503, IP 횟수 제한', async () => {
  const { get, sb, t, logs } = setup({ opts: { rate: { img: 5 } } });
  const room = await get(ROOM_URL);
  const thumb = room.json.places[0].photos[0].thumb_url;
  const other = room.json.places[1].photos[0].thumb_url;
  const [, exp, mac] = IMG_URL_RE.exec(thumb);
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const bad = [
    `/api/public/img/${exp}.${flip(mac)}/${thumbOf(1, 0)}`, // 서명 바꿈
    `/api/public/img/${Number(exp) + 3600}.${mac}/${thumbOf(1, 0)}`, // 만료를 늘림
    `/api/public/img/${exp}.${mac}/${thumbOf(2, 0)}`, // 같은 서명으로 다른 사진
    `/api/public/img/${exp}.${mac}/${photoOf(1, 0)}`, // 썸네일 서명으로 큰 사진
    `/api/public/img/${exp}.${mac}/..%2F..%2Fetc%2Fpasswd`,
  ];
  for (const u of bad) {
    const r = await get(u, { token: '' });
    assert.equal(r.status, 404, u);
    assert.equal(r.json.error, P.PMSG.photoGone);
  }
  assert.equal(sb.count('GET /storage'), 0, '서명이 틀리면 저장소에 안 감');
  assert.ok(logs.includes('public img 404'));
  // 형식이 아예 다른 주소는 그냥 404
  assert.equal((await get('/api/public/img/123', { token: '' })).status, 404);
  // IP 횟수: 5번(위 5번)을 썼으니 같은 IP는 429, 다른 IP는 됨
  const lim = await get(thumb, { token: '' });
  assert.equal(lim.status, 429);
  assert.ok(Number(lim.headers['retry-after']) > 0);
  assert.equal((await get(thumb, { token: '', ip: '198.51.100.9' })).status, 200);
  // 만료: 1시간 지나면 404 (저장소에 안 감)
  const n = sb.count('GET /storage');
  t.now += 3601_000;
  const ex = await get(other, { token: '', ip: '198.51.100.10' });
  assert.equal(ex.status, 404);
  assert.ok(logs.includes('public img expired'));
  assert.equal(sb.count('GET /storage'), n);

  // 없는 파일 404, 저장소 오류 502, 큰 파일·이상한 종류 안 넘김
  const s2 = setup();
  const room2 = await s2.get(ROOM_URL);
  const [u1, u2] = room2.json.places.map((p) => p.photos[0].thumb_url);
  s2.sb.db.missing.add(thumbOf(1, 0));
  assert.equal((await s2.get(u1, { token: '' })).status, 404);
  const down = setup({ over: { 'GET /storage/v1/object/authenticated/place-photos/:path': () => ({ status: 500, body: {} }) } });
  const d = await down.get((await down.get(ROOM_URL)).json.places[0].photos[0].thumb_url, { token: '' });
  assert.equal(d.status, 502);
  assert.equal(d.json.error, P.PMSG.down);
  const huge = setup({ over: { 'GET /storage/v1/object/authenticated/place-photos/:path': () => ({ status: 200, bytes: Buffer.alloc(150_001), headers: { 'content-type': 'image/jpeg' } }) } });
  assert.equal((await huge.get((await huge.get(ROOM_URL)).json.places[0].photos[0].thumb_url, { token: '' })).status, 404, '썸네일 150KB 넘음');
  const svg = setup({ over: { 'GET /storage/v1/object/authenticated/place-photos/:path': () => ({ status: 200, bytes: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } }) } });
  assert.equal((await svg.get((await svg.get(ROOM_URL)).json.places[0].photos[0].thumb_url, { token: '' })).status, 502, '사진 종류만');
  assert.equal((await s2.get(u2, { token: '' })).status, 200);
  // 사진 끔이면 주소가 맞아도 503
  const off = setup({ opts: { photos: false } });
  const o = await off.get(u2, { token: '' });
  assert.equal(o.status, 503);
  assert.equal(o.json.error, P.PMSG.photosOff);
});

test('횟수 제한기: 키가 수만 개여도 요청 한 번이 빠름(모든 키를 훑지 않음), 키·전체 한도와 창, refund는 그대로', () => {
  const { createLimiter } = require('./signup.cjs');
  const t = { now: T0 };
  const lim = createLimiter({ perIp: 2, total: Infinity, windowMs: 60_000, now: () => t.now });
  for (let i = 0; i < 30_000; i++) assert.ok(lim(`k${i}`).ok);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 3000; i++) lim(`x${i}`);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1000, `3000번에 ${ms.toFixed(0)}ms (예전처럼 매번 전체를 훑으면 수 초)`);
  assert.ok(lim('k1').ok);
  const no = lim('k1');
  assert.equal(no.ok, false);
  assert.equal(no.scope, 'ip');
  assert.equal(no.retryAfter, 60);
  t.now += 30_000;
  assert.equal(lim('k1').ok, false);
  t.now += 30_000; // 창(60초)이 지남
  assert.ok(lim('k1').ok);
  // 전체 한도 + refund
  const g = createLimiter({ perIp: 10, total: 2, windowMs: 60_000, now: () => t.now });
  const a = g('a');
  assert.ok(a.ok && g('b').ok);
  assert.equal(g('c').scope, 'global');
  a.refund();
  a.refund(); // 두 번 돌려줘도 한 번만
  assert.ok(g('c').ok);
  assert.equal(g('d').ok, false);
  t.now += 60_000;
  assert.ok(g('d').ok);
});

test('S5d 사진: 위조 주소는 전체 몫을 안 씀, 같은 사진을 동시에 받으면 저장소에 한 번, 동시에 받는 수 상한·줄이 차면 503, 사이트 주소를 붙임', async () => {
  // 위조 요청이 많아도(IP마다 따로) 전체 몫(imgTotal)은 서명·만료가 맞은 요청만 셈
  const a = setup({ opts: { rate: { img: 1000, imgTotal: 3 } } });
  const good = (await a.get(ROOM_URL)).json.places[0].photos[0].thumb_url;
  const [, exp] = IMG_URL_RE.exec(good);
  for (let i = 0; i < 20; i++) {
    assert.equal((await a.get(`/api/public/img/${exp}.${'A'.repeat(43)}/${thumbOf(1, 0)}`, { token: '', ip: `10.3.0.${i}` })).status, 404);
  }
  for (let i = 0; i < 3; i++) assert.equal((await a.get(good, { token: '', ip: `10.4.0.${i}` })).status, 200, '위조 20번 뒤에도 됨');
  const full = await a.get(good, { token: '', ip: '10.4.0.9' });
  assert.equal(full.status, 429, '서명이 맞은 요청은 전체 몫을 씀');
  assert.ok(a.logs.includes('public img limited:global'));

  // 같은 큰 사진을 동시에 50번: 저장소에는 한 번(버퍼도 하나)
  let open = null;
  const gate = new Promise((r) => { open = r; });
  const slow = async () => { await gate; return { status: 200, bytes: Buffer.alloc(1000), headers: { 'content-type': 'image/jpeg' } }; };
  const b = setup({ over: { 'GET /storage/v1/object/authenticated/place-photos/:path': slow } });
  await b.get(ROOM_URL);
  const big = (await b.get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`)).json.url;
  const many = Array.from({ length: 50 }, (_, i) => b.get(big, { token: '', ip: `10.5.0.${i}` }));
  open();
  assert.ok((await Promise.all(many)).every((r) => r.status === 200));
  assert.equal(b.sb.count('GET /storage'), 1);

  // 서로 다른 사진 4장: 동시에 2장까지 받고 1장은 줄, 넷째는 바로 503(retry-after)
  let open2 = null;
  const gate2 = new Promise((r) => { open2 = r; });
  const slow2 = async () => { await gate2; return { status: 200, bytes: Buffer.alloc(1000), headers: { 'content-type': 'image/jpeg' } }; };
  const c = setup({ opts: { img: { maxFetches: 2, maxWaiting: 1 } }, over: { 'GET /storage/v1/object/authenticated/place-photos/:path': slow2 } });
  c.sb.db.rooms.set(KEY, makeRoom({ places: 4, photosPer: 1 }));
  const urls = (await c.get(ROOM_URL)).json.places.map((p) => p.photos[0].thumb_url);
  const ps = urls.map((u, i) => c.get(u, { token: '', ip: `10.6.0.${i}` }));
  const fourth = await ps[3];
  assert.equal(fourth.status, 503);
  assert.equal(fourth.headers['retry-after'], '5');
  assert.equal(c.sb.count('GET /storage'), 2, '줄 선 셋째는 아직 안 받음');
  open2();
  assert.deepEqual((await Promise.all(ps.slice(0, 3))).map((r) => r.status), [200, 200, 200]);
  assert.equal(c.sb.count('GET /storage'), 3);
  assert.ok(c.logs.includes('public img busy'));

  // 사이트 주소를 붙이면 https://<사이트>/api/public/img/…, 받는 길은 같음
  const d = setup({ opts: { publicOrigin: 'https://places.example.com/' } });
  const du = (await d.get(ROOM_URL)).json.places[0].photos[0].thumb_url;
  assert.ok(du.startsWith('https://places.example.com/api/public/img/'), du);
  assert.equal((await d.get(new URL(du).pathname, { token: '' })).status, 200);
});

// ---------- S6 허용 목록 ----------
test('S6 허용 목록: SQL이 초대 코드·찜·uuid를 섞어 돌려줘도 응답에 없음, 키 집합이 §3.5와 정확히 같음', async () => {
  const { get, seen } = setup();
  const r = await get(ROOM_URL);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.deepEqual(keys(j), ['active', 'categories', 'description', 'key', 'member_count', 'members', 'name', 'photos_paused', 'place_count', 'places', 'truncated', 'v']);
  for (const m of j.members) assert.deepEqual(keys(m), ['color', 'm', 'name']);
  for (const p of j.places) {
    assert.deepEqual(keys(p), ['added_by', 'added_month', 'address', 'category', 'id', 'map_url', 'name', 'photo_count', 'photos', 'shared_note', 'status', 'visits']);
    for (const v of p.visits) {
      assert.deepEqual(keys(v), ['month', 'reviews']);
      for (const x of v.reviews) assert.deepEqual(keys(x), ['body', 'by', 'rating']);
    }
  }
  assert.equal(j.places[0].shared_note, '토요일 11시 오픈런', '함께 쓰는 메모는 공개');
  const l = await get('/api/public/rooms');
  assert.deepEqual(keys(l.json), ['rooms', 'v']);
  for (const x of l.json.rooms) {
    assert.deepEqual(keys(x), ['active', 'colors', 'description', 'key', 'member_count', 'name', 'place_count', 'review_count', 'visited_count']);
  }
  const out = seen.join('\n');
  for (const secret of [INVITE, ROOM_ID, OWNER_ID, U2, 'favorite', 'invite_code', 'couple_id', 'user_id', 'created_by', '@', 'owner', 'role', 'updated_at', 'visited_on', '2026-10-05']) {
    assert.ok(!out.includes(secret), `응답에 ${secret}`);
  }
});

test('S6 형식이 틀린 값은 null, 다른 장소 폴더의 사진 경로는 버림, 목록에서 키가 이상한 방은 빠짐', async () => {
  const { get, sb } = setup();
  const room = makeRoom({ leak: false });
  room.members[0] = { m: 'm9', name: '<b>x</b>', color: 'red;background:url(x)' };
  room.places[0].map_url = 'javascript:alert(1)';
  room.places[0].status = 'deleted';
  room.places[0].added_month = '2026-10-05';
  room.places[0].added_by = 'owner';
  room.places[0].visits[0].month = '2026-10-05T00:00:00Z';
  room.places[0].visits[0].reviews[0].rating = 99;
  room.places[1].photos[0].thumb = thumbOf(1, 0); // 다른 장소 폴더
  room.places[1].photos[1].thumb = `${placeId(2)}/t/../../x.jpg`;
  room.active = 3; // 날짜 수(예전 모양)는 버림
  room.places.push({ id: 'not-a-uuid', name: 3, photos: [{ path: 'not-a-uuid/a.jpg', thumb: 'not-a-uuid/t/a.jpg' }] });
  room.truncated = 'yes';
  sb.db.rooms.set(KEY, room);
  const r = await get(ROOM_URL);
  const j = r.json;
  assert.deepEqual(j.members[0], { m: null, name: '<b>x</b>', color: null }); // 이름은 화면이 esc
  const p0 = j.places[0];
  assert.equal(p0.map_url, null);
  assert.equal(p0.status, null);
  assert.equal(p0.added_month, null);
  assert.equal(p0.added_by, null);
  assert.equal(p0.visits[0].month, null);
  assert.equal(p0.visits[0].reviews[0].rating, null);
  assert.deepEqual(j.places[1].photos, [{ thumb_url: null }, { thumb_url: null }]);
  assert.equal(j.places[2].id, null);
  assert.equal(j.places[2].name, '');
  assert.deepEqual(j.places[2].photos, [{ thumb_url: null }]);
  assert.equal(j.truncated, false);
  assert.equal(j.active, null);
  // 목록: 키가 형식에 안 맞는 방은 빠짐(초대 코드를 키로 잘못 넣은 경우 포함), 숫자가 이상하면 0
  sb.db.list = [listRow(KEY), listRow(INVITE), listRow('k7m2p9xa4', {}), listRow(KEY2, { place_count: -1, colors: ['teal', 'bad color', 7] })];
  const l = await get('/api/public/rooms');
  assert.deepEqual(l.json.rooms.map((x) => x.key), [KEY, KEY2]);
  assert.equal(l.json.rooms[1].place_count, 0);
  assert.deepEqual(l.json.rooms[1].colors, ['teal', null, null]);
  assert.ok(!l.text.includes(INVITE));
});

test('S6 SQL이 방 대신 이상한 모양(키가 다름)을 주면 502, 캐시하지 않음', async () => {
  const { get, sb } = setup();
  sb.db.rooms.set(KEY, makeRoom({ key: KEY2 }));
  assert.equal((await get(ROOM_URL)).status, 502);
  assert.equal((await get(ROOM_URL)).status, 502);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 2);
});

// ---------- S7 사진 한도 ----------
test('S7 사람마다 하루 썸네일 한도: 넘으면 남은 만큼만, 나머지 null + photos_paused. 같은 썸네일을 다시 받으면 세지 않음', async () => {
  const { get, sb, api, t } = setup({ opts: { budget: { userThumbs: 5, dayThumbs: 8 } } });
  sb.db.rooms.set(KEY, makeRoom({ places: 6, photosPer: 2 })); // 대표 썸네일 6개
  let r = await get(ROOM_URL);
  let urls = r.json.places.map((p) => p.photos[0].thumb_url);
  assert.deepEqual(urls.map(Boolean), [true, true, true, true, true, false], '장소 순서대로 5개');
  assert.equal(r.json.photos_paused, true);
  assert.equal(api.budget.snapshot().thumbs, 5);
  // 다시 열기(다른 앱에 다녀오기·캐시가 지난 뒤): 이미 받은 5개는 그대로 다시 주고 세지 않음, 6번째는 계속 null
  t.now += 3 * 60_000;
  r = await get(ROOM_URL);
  assert.deepEqual(r.json.places.map((p) => Boolean(p.photos[0].thumb_url)), [true, true, true, true, true, false]);
  assert.equal(r.json.photos_paused, true);
  assert.equal(api.budget.snapshot().thumbs, 5, '다시 받은 썸네일은 세지 않음');
  // 다른 사람: 하루 전체 8에서 5를 썼으니 3개
  r = await get(ROOM_URL, { token: tokenOf(U2) });
  urls = r.json.places.map((p) => p.photos[0].thumb_url);
  assert.equal(urls.filter(Boolean).length, 3);
  assert.equal(api.budget.snapshot().thumbs, 8);
  // 사진이 없는 방은 멈춤 띠를 켜지 않음
  sb.db.rooms.set(KEY2, makeRoom({ key: KEY2, photosPer: 0 }));
  r = await get(`/api/public/rooms/${KEY2}`, { token: tokenOf(U2) });
  assert.equal(r.json.photos_paused, false);
});

test('S7 월 추정 바이트 한도, 큰 사진 사람마다 한도(429 budget + Retry-After는 KST 자정까지), 사진 끔', async () => {
  const month = setup({ opts: { budget: { monthBytes: 25_000 * 3 } } });
  month.sb.db.rooms.set(KEY, makeRoom({ places: 4, photosPer: 1 }));
  const r = await month.get(ROOM_URL);
  assert.equal(r.json.places.flatMap((p) => p.photos).filter((ph) => ph.thumb_url).length, 3);
  assert.equal(r.json.photos_paused, true);

  const big = setup({ opts: { budget: { userLarge: 2 } } });
  const url = `${ROOM_URL}/photo?place=${placeId(1)}&i=0`;
  assert.equal((await big.get(url)).status, 200);
  assert.equal((await big.get(url)).status, 200);
  const no = await big.get(url);
  assert.equal(no.status, 429);
  assert.deepEqual(no.json, { error: P.PMSG.budgetDay, budget: true });
  assert.equal(no.headers['retry-after'], String(12 * 3600), 'KST 12:00 → 자정까지 12시간');
  assert.ok(big.logs.includes('public photo budget'));
  assert.equal((await big.get(url, { token: tokenOf(U2) })).status, 200, '다른 사람은 됨');
  // 월 바이트가 큰 사진 하나도 안 남으면 다음 달 1일까지
  const mb = setup({ opts: { budget: { monthBytes: 100_000 } } });
  const m = await mb.get(url);
  assert.equal(m.status, 429);
  assert.equal(m.headers['retry-after'], String(P.secondsToKstNextMonth(T0)));
  assert.deepEqual(m.json, { error: P.PMSG.budgetMonth, budget: true }, '월 한도는 \'다음 달\' 문구');

  const off = setup({ opts: { photos: false } });
  const o = await off.get(ROOM_URL);
  assert.equal(o.status, 200);
  assert.ok(o.json.places.every((p) => p.photos.every((ph) => ph.thumb_url === null)));
  assert.equal(o.json.photos_paused, true);
  const ol = await off.get(url);
  assert.equal(ol.status, 503);
  assert.equal(ol.json.error, P.PMSG.photosOff);
  assert.ok(!o.text.includes('/api/public/img/') && !ol.text.includes('/api/public/img/'));
});

test('S7 하루 큰 사진 전체 한도', async () => {
  const { get } = setup({ opts: { budget: { dayLarge: 1 } } });
  const url = `${ROOM_URL}/photo?place=${placeId(1)}&i=1`;
  assert.equal((await get(url)).status, 200);
  assert.equal((await get(url, { token: tokenOf(U2) })).status, 429);
});

// ---------- S8 카운터 파일 ----------
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gp-budget-')); }

test('S8 카운터 파일: 저장(임시 파일 → rename, 0600), 다시 시작해도 이어서 셈, 파일에 uid 원문 없음', async () => {
  const dir = tmpDir();
  try {
    const a = setup({ opts: { stateDir: dir, budget: { userThumbs: 3 } } });
    a.sb.db.rooms.set(KEY, makeRoom({ places: 2, photosPer: 1 }));
    await a.get(ROOM_URL);
    await a.get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`);
    a.api.close();
    const file = path.join(dir, P.BUDGET_FILE);
    const text = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(text);
    assert.deepEqual(keys(j), ['anon', 'bytes', 'day', 'large', 'month', 'salt', 'seen', 'thumbs', 'users', 'v']);
    assert.equal(j.seen.length, 2);
    assert.ok(j.seen.every((k) => /^[0-9a-f]{16}$/.test(k)), '본 썸네일은 해시로만');
    assert.ok(!text.includes(fname(1, 0)), '파일에 썸네일 경로 원문 없음');
    assert.equal(j.day, '2026-10-22');
    assert.equal(j.month, '2026-10');
    assert.equal(j.thumbs, 2);
    assert.equal(j.large, 1);
    assert.equal(j.bytes, 2 * 25_000 + 200_000);
    assert.deepEqual(Object.values(j.users), [[2, 1]]);
    assert.ok(Object.keys(j.users).every((k) => /^[0-9a-f]{16}$/.test(k)));
    assert.ok(!text.includes(U1) && !text.includes(tokenOf(U1)));
    assert.deepEqual(fs.readdirSync(dir), [P.BUDGET_FILE], '임시 파일이 남지 않음');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // 다시 시작: 같은 사람은 하루 3개 중 2개를 썼고 그 2개는 다시 받아도 안 셈 → 장소 4곳이면 3개(본 2 + 새 1)
    const b = setup({ opts: { stateDir: dir, budget: { userThumbs: 3 } } });
    b.sb.db.rooms.set(KEY, makeRoom({ places: 4, photosPer: 1 }));
    const r = await b.get(ROOM_URL);
    assert.deepEqual(r.json.places.map((p) => Boolean(p.photos[0].thumb_url)), [true, true, true, false]);
    assert.equal(b.api.budget.snapshot().thumbs, 3);
    b.api.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S8 날이 바뀌면 하루 수·사람·salt 새로(바이트는 그대로), 달이 바뀌면 바이트도', () => {
  const t = { now: T0 };
  const logs = [];
  const b = P.createBudget({ now: () => t.now, log: (m) => logs.push(m) });
  assert.deepEqual(logs, ['public budget memory_only']);
  b.addThumbs(U1, 4);
  b.addLarge(U1);
  // 경로로 세면 처음 보는 것만 (같은 사람이 같은 경로를 다시 받으면 0), 다른 사람은 따로
  assert.equal(b.addThumbs(U1, ['a/t/x.jpg', 'a/t/y.jpg']), 2);
  assert.equal(b.addThumbs(U1, ['a/t/x.jpg']), 0);
  assert.equal(b.isSeen(U1, 'a/t/x.jpg'), true);
  assert.equal(b.isSeen(U2, 'a/t/x.jpg'), false);
  assert.equal(b.isSeen(null, 'a/t/x.jpg'), false, '로그인 없는 사람은 늘 셈');
  assert.equal(b.addThumbs(null, ['a/t/x.jpg']), 1);
  assert.equal(b.addThumbs(null, ['a/t/x.jpg']), 1);
  const s1 = b.snapshot();
  assert.equal(s1.thumbs, 8, '숫자 4 + 경로 2 + 익명 2');
  assert.equal(s1.anon, 2);
  t.now = Date.UTC(2026, 9, 22, 14, 59, 0); // KST 23:59 같은 날
  assert.equal(b.thumbsAllowed(U1), 194);
  assert.equal(b.snapshot().seen.length, 2);
  t.now = Date.UTC(2026, 9, 22, 15, 0, 0); // KST 10/23 0:00
  assert.equal(b.thumbsAllowed(U1), 200);
  const s2 = b.snapshot();
  assert.equal(s2.day, '2026-10-23');
  assert.equal(s2.thumbs, 0);
  assert.equal(s2.large, 0);
  assert.deepEqual(s2.users, {});
  assert.deepEqual(s2.seen, [], '날이 바뀌면 본 썸네일도 비움');
  assert.equal(b.isSeen(U1, 'a/t/x.jpg'), false);
  assert.notEqual(s2.salt, s1.salt);
  assert.equal(s2.bytes, s1.bytes);
  t.now = Date.UTC(2026, 9, 31, 15, 0, 0); // KST 11/1
  b.thumbsAllowed(U1);
  assert.equal(b.snapshot().month, '2026-11');
  assert.equal(b.snapshot().bytes, 0);
});

test('S8 깨진 파일은 로그 한 줄 + 그날은 반만 남은 것으로 시작, 지난 날짜 파일은 새로 시작', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, P.BUDGET_FILE);
    const logs = [];
    const okFile = { v: 1, day: '2026-10-22', month: '2026-10', salt: 'ab'.repeat(16), thumbs: 1, large: 0, anon: 0, bytes: 0, users: {} };
    for (const broken of ['{not json', JSON.stringify({ v: 1, day: '2026-10-22' }), JSON.stringify({ v: 2 }), '',
      JSON.stringify({ ...okFile, seen: ['not-hex'] }), JSON.stringify({ ...okFile, seen: 'x' })]) {
      fs.writeFileSync(file, broken);
      logs.length = 0;
      const b = P.createBudget({ dir, now: () => T0, log: (m) => logs.push(m) });
      assert.deepEqual(logs, ['public budget file_broken'], broken);
      const s = b.snapshot();
      assert.equal(s.thumbs, 400);
      assert.equal(s.large, 30);
      assert.equal(b.thumbsAllowed(U1), 200);
      b.save();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).thumbs, 400, '안전한 값으로 다시 저장');
    }
    // 어제 파일: 하루 수는 새로, 같은 달이라 바이트는 이어서
    fs.writeFileSync(file, JSON.stringify({ v: 1, day: '2026-10-21', month: '2026-10', salt: 'ab'.repeat(16), thumbs: 700, large: 50, anon: 0, bytes: 12345, users: { '0123456789abcdef': [200, 20] } }));
    const y = P.createBudget({ dir, now: () => T0, log: () => {} });
    assert.equal(y.snapshot().thumbs, 0);
    assert.equal(y.snapshot().bytes, 12345);
    assert.deepEqual(y.snapshot().users, {});
    // 저장 실패(폴더가 없어짐)는 로그 한 번, 서버는 계속
    const gone = path.join(dir, 'nope');
    const logs2 = [];
    const g = P.createBudget({ dir: gone, now: () => T0, log: (m) => logs2.push(m) });
    g.addThumbs(U1, 1);
    g.save();
    g.addThumbs(U1, 1);
    g.save();
    assert.deepEqual(logs2, ['public budget save_fail']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- S9 큰 사진 ----------
test('S9 큰 사진: 캐시한 방에서 경로를 찾아 10분 서명 주소, 없는 장소·범위 밖 404, 형식 틀리면 400', async () => {
  const { get, sb, api } = setup();
  await get(ROOM_URL);
  const r = await get(`${ROOM_URL}/photo?place=${placeId(2)}&i=1`);
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.json), ['url']);
  assert.equal(imgPath(r.json.url), photoOf(2, 1));
  assert.equal(imgExp(r.json.url), Math.floor(T0 / 1000) + 600);
  assert.equal(sb.count('POST /rest/v1/rpc/public_room_view'), 1, '캐시한 방에서 찾음');
  assert.equal(sb.count('POST /storage') + sb.count('GET /storage'), 0, '주소를 줄 때는 저장소에 안 감');
  assert.equal(api.budget.snapshot().large, 1);
  assert.equal((await get(`${ROOM_URL}/photo?place=${placeId(9)}&i=0`)).status, 404);
  const outOfRange = await get(`${ROOM_URL}/photo?place=${placeId(1)}&i=2`);
  assert.equal(outOfRange.status, 404);
  assert.equal(outOfRange.json.error, P.PMSG.photoGone);
  for (const q of ['place=abc&i=0', `place=${placeId(1)}&i=3`, `place=${placeId(1)}&i=-1`, `place=${placeId(1)}`, `place=${placeId(1).toUpperCase()}&i=0`]) {
    assert.equal((await get(`${ROOM_URL}/photo?${q}`)).status, 400, q);
  }
  assert.equal((await get(`/api/public/rooms/${KEY2}/photo?place=${placeId(1)}&i=0`)).status, 404, '없는 방');
  assert.equal(api.budget.snapshot().large, 1, '못 준 것은 세지 않음');
});

// ---------- S10 로그인 없이 (나중을 위한 자리) ----------
test('S10 allowAnonymous: 토큰 없이 목록·방(IP 제한만, 썸네일 없음), 큰 사진 401. 기본값은 401', async () => {
  const { get, sb } = setup({ opts: { allowAnonymous: true } });
  const l = await get('/api/public/rooms', { token: '' });
  assert.equal(l.status, 200);
  const r = await get(ROOM_URL, { token: '' });
  assert.equal(r.status, 200);
  assert.ok(r.json.places.every((p) => p.photos.every((ph) => ph.thumb_url === null)));
  assert.equal(r.json.photos_paused, true);
  assert.ok(!r.text.includes('/api/public/img/'));
  assert.equal(sb.count('GET /auth'), 0);
  const p = await get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`, { token: '' });
  assert.equal(p.status, 401);
  assert.equal(p.json.login, true);
  // 틀린 토큰은 익명으로 내려가지 않고 401
  assert.equal((await get(ROOM_URL, { token: tokenOf('nobody') })).status, 401);
  // IP 제한은 그대로
  for (let i = 0; i < 29; i++) await get(ROOM_URL, { token: '' });
  assert.equal((await get(ROOM_URL, { token: '' })).status, 429);
  // 익명 썸네일 한도를 따로 주면 그만큼만
  const a = setup({ opts: { allowAnonymous: true, budget: { anonThumbs: 1 } } });
  const ar = await a.get(ROOM_URL, { token: '' });
  assert.equal(ar.json.places.flatMap((x) => x.photos).filter((ph) => ph.thumb_url).length, 1);
  const def = setup();
  assert.equal((await def.get(ROOM_URL, { token: '' })).status, 401);
});

// ---------- 로그 ----------
test('로그에는 종류와 결과만: 공개 키·사용자·토큰·IP 없음', async () => {
  const { get, logs } = setup();
  await get(ROOM_URL, { ip: '198.51.100.99' });
  await get(`/api/public/rooms/${KEY2}`);
  await get('/api/public/rooms', { token: tokenOf('nobody') });
  await get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`);
  const out = logs.join('\n');
  for (const s of [KEY, KEY2, U1, tokenOf(U1), 'nobody', '198.51.100.99', INVITE]) assert.ok(!out.includes(s), `로그에 ${s}`);
  for (const line of logs) assert.match(line, /^public (list|view|photo|thumbs|room|sign|budget|json)[ a-z0-9_:]*$/);
  assert.ok(logs.includes('public view ok') && logs.includes('public view 404') && logs.includes('public list 401') && logs.includes('public photo ok'));
});

test('예상 못 한 오류도 500으로 답함', async () => {
  const sb = fakeSupabase();
  const logs = [];
  let broken = false;
  const now = () => { if (broken) throw new Error('clock'); return T0; };
  const api = P.createPublicApi({ supabaseUrl: SUPA, publishableKey: PUB, secretKey: SECRET, fetchImpl: sb.fetchImpl, now, log: (m) => logs.push(m), saveEveryMs: 0 });
  broken = true;
  const res = fakeRes();
  await api.handle(fakeReq({ url: '/api/public/rooms', token: tokenOf(U1) }), res);
  assert.equal(res.status, 500);
  assert.ok(logs.includes('public error'));
  assert.throws(() => P.createPublicApi({ supabaseUrl: SUPA, publishableKey: PUB, secretKey: '' }));
});

// ---------- 상세의 썸네일 (/thumbs) ----------
test('썸네일 /thumbs: 상세를 열 때 그 장소의 3장, 대표는 다시 세지 않음, 형식·없는 장소·메서드·사진 끔', async () => {
  const { get, sb, api } = setup({ opts: { budget: { userThumbs: 4 } } });
  sb.db.rooms.set(KEY, makeRoom({ places: 2, photosPer: 3 }));
  const room = await get(ROOM_URL);
  assert.equal(room.json.places.filter((p) => p.photos[0].thumb_url).length, 2);
  assert.equal(api.budget.snapshot().thumbs, 2);
  const url = `${ROOM_URL}/thumbs?place=${placeId(1)}`;
  let r = await get(url);
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.json), ['photos_paused', 'thumbs', 'v']);
  assert.equal(r.json.thumbs.length, 3);
  assert.deepEqual(r.json.thumbs.map(imgPath), [0, 1, 2].map((j) => thumbOf(1, j)));
  assert.equal(r.json.photos_paused, false);
  assert.equal(r.headers['cache-control'], 'private, max-age=60');
  assert.equal(api.budget.snapshot().thumbs, 4, '대표는 이미 셌으니 2·3번째만');
  // 같은 장소 다시: 세지 않음. 다른 장소: 남은 한도 0이라 대표만(이미 본 것)
  r = await get(url);
  assert.equal(api.budget.snapshot().thumbs, 4);
  r = await get(`${ROOM_URL}/thumbs?place=${placeId(2)}`);
  assert.deepEqual(r.json.thumbs.map(Boolean), [true, false, false]);
  assert.equal(r.json.photos_paused, true);
  assert.ok(!/"(path|thumb)"/.test(r.text) && !r.text.includes(photoOf(1, 0)));
  // 형식·없는 장소·없는 방·메서드
  assert.equal((await get(`${ROOM_URL}/thumbs?place=abc`)).status, 400);
  assert.equal((await get(`${ROOM_URL}/thumbs`)).status, 400);
  assert.equal((await get(`${ROOM_URL}/thumbs?place=${placeId(9)}`)).status, 404);
  assert.equal((await get(`/api/public/rooms/${KEY2}/thumbs?place=${placeId(1)}`)).status, 404);
  const h = await get(url, { method: 'HEAD' });
  assert.equal(h.status, 405);
  assert.equal(h.headers.allow, 'GET');
  assert.equal((await get(url, { token: '' })).status, 401);
  // 사진 끔: 모두 null + photos_paused, 서명 안 함
  const off = setup({ opts: { photos: false } });
  const o = await off.get(url);
  assert.deepEqual(o.json, { v: 1, thumbs: [null, null], photos_paused: true });
});

test('사진 파일 이름이 무작위가 아니면(업로드 시각 Date.now) 서명하지 않음, 큰 사진 경로에 썸네일 폴더를 넣어도 버림', async () => {
  const { get, sb } = setup();
  const room = makeRoom({ leak: false, places: 2, photosPer: 1 });
  room.places[0].photos = [{ path: `${placeId(1)}/1729580000000-0.jpg`, thumb: `${placeId(1)}/t/1729580000000-0.jpg` }];
  room.places[1].photos = [{ path: thumbOf(2, 0), thumb: `${placeId(2)}/t/${fname(2, 0).toUpperCase()}.jpg` }];
  sb.db.rooms.set(KEY, room);
  const r = await get(ROOM_URL);
  assert.deepEqual(r.json.places.map((p) => p.photos[0].thumb_url), [null, null]);
  assert.ok(!r.text.includes('1729580000000'));
  assert.equal((await get(`${ROOM_URL}/photo?place=${placeId(1)}&i=0`)).status, 404);
  assert.equal((await get(`${ROOM_URL}/photo?place=${placeId(2)}&i=0`)).status, 404);
  assert.ok(!r.text.includes('/api/public/img/'));
  // randomUUID 모양 이름은 됨
  const uuidName = '0f8fad5b-d9cb-469f-a165-70867728950e';
  room.places[0].photos = [{ path: `${placeId(1)}/${uuidName}.jpg`, thumb: `${placeId(1)}/t/${uuidName}.jpg` }];
  const ok = setup();
  ok.sb.db.rooms.set(KEY, room);
  const o = await ok.get(ROOM_URL);
  assert.equal(imgPath(o.json.places[0].photos[0].thumb_url), `${placeId(1)}/t/${uuidName}.jpg`);
});

test('지도 링크는 아는 지도 주소만(네이버·구글·카카오), https로', async () => {
  const { get, sb } = setup();
  const room = makeRoom({ leak: false, places: 1, photosPer: 0 });
  const cases = [
    ['https://naver.me/abc', 'https://naver.me/abc'],
    ['http://naver.me/abc', 'https://naver.me/abc'],
    ['https://map.naver.com/p/entry/place/123', 'https://map.naver.com/p/entry/place/123'],
    ['https://m.place.naver.com/restaurant/123', 'https://m.place.naver.com/restaurant/123'],
    ['https://maps.app.goo.gl/xyz', 'https://maps.app.goo.gl/xyz'],
    ['https://www.google.com/maps/place/x', 'https://www.google.com/maps/place/x'],
    ['https://www.google.co.kr/maps/place/x', 'https://www.google.co.kr/maps/place/x'],
    ['https://kko.to/abc', 'https://kko.to/abc'],
    ['https://place.map.kakao.com/123', 'https://place.map.kakao.com/123'],
    ['https://evil.example/', null],
    ['https://naver.me.evil.example/abc', null],
    ['https://evil.example/?u=https://naver.me/x', null],
    ['https://www.google.com/search?q=x', null],
    ['https://user:pw@naver.me/abc', null],
    ['https://naver.me:8443/abc', null],
    ['ftp://naver.me/abc', null],
    ['javascript:alert(1)', null],
    [`https://naver.me/${'a'.repeat(2000)}`, null],
  ];
  for (const [i, [input, want]] of cases.entries()) {
    const k = `abcdefgh${'abcdefghijkmnpqrstuvwxyz23456789'[i]}2`;
    sb.db.rooms.set(k, { ...room, key: k, places: [{ ...room.places[0], map_url: input }] });
    const r = await get(`/api/public/rooms/${k}`);
    assert.equal(r.json.places[0].map_url, want, input);
  }
});

test('토큰 없는 요청은 횟수를 세기 전에 401(전체 몫을 쓰지 않음), 틀린 토큰은 전체 몫을 돌려줌', async () => {
  const { get, sb } = setup({ opts: { rate: { total: 10 } } });
  for (let i = 0; i < 50; i++) assert.equal((await get('/api/public/rooms', { token: '', ip: `10.1.0.${i}` })).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await get('/api/public/rooms', { token: tokenOf(`bad${i}`), ip: `10.2.0.${i}` })).status, 401);
  assert.equal(sb.count('GET /auth/v1/user'), 20);
  for (let i = 0; i < 10; i++) assert.equal((await get('/api/public/rooms', { ip: `10.3.0.${i}` })).status, 200, `${i}`);
  assert.equal((await get('/api/public/rooms', { ip: '10.3.0.99', token: tokenOf(U2) })).status, 429, '로그인한 사람 몫은 그대로 10');
});

test('캐시: 항목마다 크기에 키와 128을 더하고, 항목 수도 제한(없는 방 결과가 쌓여도)', () => {
  const c = P.createLru(1_000_000, 3);
  for (let i = 0; i < 5; i++) c.set(`room:${i}`, null, 140, 1e15);
  assert.equal(c.count, 3);
  assert.equal(c.get('room:0', 0), undefined, '오래된 것부터 버림');
  assert.equal(c.get('room:4', 0), null);
  const d = P.createLru(1000, 100);
  for (let i = 0; i < 20; i++) d.set(`k${i}`, null, 140, 1e15);
  assert.ok(d.size <= 1000 && d.count === 7);
});

test('KST 시간 도우미', () => {
  assert.equal(P.kstDay(Date.UTC(2026, 9, 22, 14, 59, 59)), '2026-10-22');
  assert.equal(P.kstDay(Date.UTC(2026, 9, 22, 15, 0, 0)), '2026-10-23');
  assert.equal(P.secondsToKstMidnight(Date.UTC(2026, 9, 22, 14, 59, 0)), 60);
  assert.equal(P.secondsToKstNextMonth(Date.UTC(2026, 9, 31, 14, 59, 0)), 60);
  assert.equal(P.secondsToKstNextMonth(Date.UTC(2026, 11, 31, 14, 0, 0)), 3600, '12월 → 다음 해 1월');
});

// ---------- S14 pages.cjs (server.cjs의 순수 함수) ----------
const SAMPLE = "<script>\nconst SIGNUP_ENABLED = false;\nconst PUBLIC_ROOMS_ENABLED = false; // 설명\n</script>";

test('S14 화면 네 벌: SIGNUP_ENABLED × PUBLIC_ROOMS_ENABLED', () => {
  const pages = pagesLib.buildPages(SAMPLE);
  for (const signup of [false, true]) {
    for (const pub of [false, true]) {
      const s = pages.get(signup, pub).toString('utf8');
      assert.ok(s.includes(`const SIGNUP_ENABLED = ${signup};`));
      assert.ok(s.includes(`const PUBLIC_ROOMS_ENABLED = ${pub}; // 설명`));
    }
  }
  assert.throws(() => pagesLib.buildPages('const SIGNUP_ENABLED = false;'), /PUBLIC_ROOMS_ENABLED.*0개/);
  assert.throws(() => pagesLib.buildPages(`${SAMPLE}\nconst PUBLIC_ROOMS_ENABLED = true;`), /PUBLIC_ROOMS_ENABLED.*2개/);
  assert.throws(() => pagesLib.buildPages('const PUBLIC_ROOMS_ENABLED = false;'), /SIGNUP_ENABLED/);
  assert.equal(pagesLib.replaceOnce("a = '$1'", /a = '[^']*'/, "a = '$&$1'", 'a'), "a = '$&$1'", '값 속 $를 그대로');
});

test('S14 지금 index.html로도 네 벌을 만들 수 있음(PUBLIC_ROOMS_ENABLED 한 줄)', (t) => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  if (!/const PUBLIC_ROOMS_ENABLED = /.test(html)) { t.skip('index.html에 아직 PUBLIC_ROOMS_ENABLED가 없음 (화면 작업 뒤에 다시 확인)'); return; }
  const pages = pagesLib.buildPages(html);
  assert.ok(pages.get(true, true).toString('utf8').includes('const PUBLIC_ROOMS_ENABLED = true;'));
  assert.ok(pages.get(true, false).toString('utf8').includes('const PUBLIC_ROOMS_ENABLED = false;'));
});

test('S14 /r/<key> 형식 판정', () => {
  assert.ok(pagesLib.isRoomLink(`/r/${KEY}`));
  for (const bad of ['/r/ABCDEF12', '/r/k7m2p9xa4', `/r/${KEY}/x`, `/r/${KEY}/`, '/r/k7m2p9xa4l', '/r/', `/R/${KEY}`, `/r/${KEY}c`]) {
    assert.ok(!pagesLib.isRoomLink(bad), bad);
  }
});

test('S14 설정: 기본 off/on, on|off 아니면 오류, PUBLIC_ANON=on이면 오류, STATE_DIRECTORY', () => {
  assert.deepEqual(pagesLib.publicConfig({}), { rooms: false, photos: true, stateDir: '' });
  assert.deepEqual(pagesLib.publicConfig({ PUBLIC_ROOMS: 'on', PUBLIC_PHOTOS: 'off', PUBLIC_ANON: 'off', STATE_DIRECTORY: '/var/lib/our-places:/var/lib/x' }),
    { rooms: true, photos: false, stateDir: '/var/lib/our-places' });
  assert.throws(() => pagesLib.publicConfig({ PUBLIC_ROOMS: 'yes' }), /PUBLIC_ROOMS는 on 또는 off/);
  assert.throws(() => pagesLib.publicConfig({ PUBLIC_PHOTOS: 'true' }), /PUBLIC_PHOTOS/);
  assert.throws(() => pagesLib.publicConfig({ PUBLIC_ANON: 'on' }), /PUBLIC_ANON은 아직 켤 수 없어요/);
  assert.throws(() => pagesLib.publicConfig({ PUBLIC_ANON: '1' }), /PUBLIC_ANON/);
  assert.equal(pagesLib.publicConfig({ STATE_DIRECTORY: 'relative/dir' }).stateDir, '');
});

test('하루 보낸 JSON이 한도를 넘으면 경고 한 번, 날이 바뀌면 다시 셈', async () => {
  const { get, logs, t } = setup({ opts: { jsonWarnBytes: 1000 } });
  for (let i = 0; i < 5; i++) await get(ROOM_URL);
  assert.equal(logs.filter((l) => l === 'public json over 200MB today').length, 1);
  t.now += 24 * 3600_000;
  for (let i = 0; i < 5; i++) await get(ROOM_URL, { ip: `198.51.100.${i}` });
  assert.equal(logs.filter((l) => l === 'public json over 200MB today').length, 2);
});
