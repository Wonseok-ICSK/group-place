// deploy/home/server.cjs를 실제로 띄워 보는 시험 (임시 폴더에 릴리스처럼 복사, 127.0.0.1의 빈 포트).
// 네트워크에 나가지 않는다: 띄울 때 --require로 fetch를 가짜 Supabase로 바꿔 끼우고, 그 밖의 주소는 오류로 막는다.
// 실행: node --test "deploy/home/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SUPA = 'https://abcdefghijklmnopqrst.supabase.co';
const PUB = 'sb_publishable_testtesttesttest';
const SECRET = 'sb_secret_testsecretsecretsecret';
const KEY = 'k7m2p9xa4c';
const INVITE = 'C0FFEE01';
const U1 = '11111111-2222-4333-8444-555555555555';

// 가짜 Supabase (자식 프로세스 안에서 globalThis.fetch를 바꿈). 공개 방 응답에는 초대 코드를 일부러 섞는다
const FAKE_FETCH = `
'use strict';
const SUPA = ${JSON.stringify(SUPA)};
const SECRET = ${JSON.stringify(SECRET)};
const U1 = ${JSON.stringify(U1)};
const PLACE = '00000000-0000-4000-a000-000000000001';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin !== SUPA) throw new Error('blocked: ' + u.origin);
  const h = init.headers || {};
  const admin = h.apikey === SECRET;
  const route = (init.method || 'GET') + ' ' + u.pathname;
  if (process.env.FAKE_NO_PUBLIC_SQL && route === 'POST /rest/v1/rpc/public_rooms_version') return json(404, { code: 'PGRST202' });
  switch (route) {
    case 'GET /auth/v1/admin/users': return admin ? json(200, { users: [] }) : json(401, {});
    case 'POST /rest/v1/rpc/space_code_open': return json(200, false);
    case 'POST /rest/v1/rpc/join_couple_for': return json(400, { message: 'not_authenticated' });
    case 'POST /rest/v1/rpc/groups_schema_version': return json(200, 1);
    case 'POST /rest/v1/rpc/public_rooms_version': return json(200, 1);
    case 'GET /auth/v1/user': return h.authorization === 'Bearer at.' + U1 + '.sig' ? json(200, { id: U1 }) : json(403, {});
    case 'POST /rest/v1/rpc/public_room_list':
      return json(200, [{ key: ${JSON.stringify(KEY)}, name: '서울 라멘 지도', description: '', member_count: 1, colors: ['teal'], place_count: 1,
        visited_count: 0, review_count: 0, active: 'week', invite_code: ${JSON.stringify(INVITE)} }]);
    case 'POST /rest/v1/rpc/public_room_view': {
      const body = JSON.parse(init.body);
      if (body.p_key !== ${JSON.stringify(KEY)}) return json(200, null);
      return json(200, { v: 1, key: body.p_key, name: '서울 라멘 지도', description: '', member_count: 1, place_count: 1, truncated: false,
        active: 'week', invite_code: ${JSON.stringify(INVITE)}, members: [{ m: 'm1', name: '민수', color: 'teal' }], categories: ['맛집'],
        places: [{ id: PLACE, name: '멘야', category: '맛집', address: null, map_url: null, status: 'visited', shared_note: null, added_month: '2026-09',
          added_by: 'm1', favorite: true, visits: [], photo_count: 1, photos: [{ path: PLACE + '/0f8fad5b-d9cb-469f-a165-70867728950e.jpg', thumb: PLACE + '/t/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' }] }] });
    }
    case 'POST /storage/v1/object/sign/place-photos':
      return json(200, JSON.parse(init.body).paths.map((p) => ({ path: p, signedURL: '/object/sign/place-photos/' + p + '?token=x', error: null })));
    default: return json(404, { message: 'no route ' + route });
  }
};
`;

// 릴리스처럼 필요한 파일만 임시 폴더에 복사. editHtml로 index.html을 바꿔 볼 수 있음
function makeRelease(editHtml = (s) => s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-server-'));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  };
  for (const rel of ['manifest.json', 'og.png', 'api/place.js', 'deploy/home/server.cjs', 'deploy/home/signup.cjs', 'deploy/home/public.cjs', 'deploy/home/pages.cjs']) copy(rel);
  for (const name of fs.readdirSync(path.join(REPO, 'icons'))) copy(`icons/${name}`);
  fs.writeFileSync(path.join(dir, 'index.html'), editHtml(fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')));
  fs.writeFileSync(path.join(dir, 'fake-fetch.cjs'), FAKE_FETCH);
  fs.mkdirSync(path.join(dir, 'state'));
  return dir;
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
// 서버를 띄우고 untilLog가 나올 때까지(또는 끝날 때까지) 기다림
async function start(dir, env = {}, untilLog = /공개 방: |초대 코드로 가입: /) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', path.join(dir, 'fake-fetch.cjs'), path.join(dir, 'deploy', 'home', 'server.cjs')], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      SUPABASE_URL: SUPA, SUPABASE_KEY: PUB, PUBLIC_ORIGIN: 'https://places.example.com', LOGIN_ID_DOMAIN: 'id.example.com',
      PORT: String(port), STATE_DIRECTORY: path.join(dir, 'state'), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((resolve) => {
    const onData = (b) => { out += b; if (untilLog.test(out)) resolve(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then(resolve);
    setTimeout(resolve, 8000).unref();
  });
  return { port, child, exited, log: () => out };
}
function req(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('server: PUBLIC_ANON=on·잘못된 PUBLIC_ROOMS·PUBLIC_ROOMS_ENABLED 줄 없음은 설정 오류(78)로 시작하지 않음', async () => {
  const dir = makeRelease();
  try {
    let s = await start(dir, { PUBLIC_ANON: 'on' });
    assert.equal(await s.exited, 78);
    assert.match(s.log(), /PUBLIC_ANON은 아직 켤 수 없어요/);
    s = await start(dir, { PUBLIC_ROOMS: 'yes' });
    assert.equal(await s.exited, 78);
    assert.match(s.log(), /PUBLIC_ROOMS는 on 또는 off/);
  } finally { cleanup(dir); }
  const noLine = makeRelease((h) => h.replace(/const PUBLIC_ROOMS_ENABLED = (true|false);/, ''));
  try {
    const s = await start(noLine);
    assert.equal(await s.exited, 78);
    assert.match(s.log(), /PUBLIC_ROOMS_ENABLED/);
  } finally { cleanup(noLine); }
});

test('server: secret key 없음 → 공개 방 꺼짐(/api/public 404), /r/<key>는 화면, 모든 응답 noindex', async () => {
  const dir = makeRelease();
  const s = await start(dir, { PUBLIC_ROOMS: 'on' }, /공개 방: /);
  try {
    assert.match(s.log(), /공개 방: 꺼 둠 \(secret key 없음\)/);
    const home = await req(s.port, '/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('const PUBLIC_ROOMS_ENABLED = false;'));
    assert.ok(home.body.includes('const SIGNUP_ENABLED = false;'));
    const link = await req(s.port, `/r/${KEY}`);
    assert.equal(link.status, 200);
    assert.equal(link.body, home.body);
    assert.equal(link.headers['cache-control'], 'no-cache');
    assert.equal(link.headers['content-type'], 'text/html; charset=utf-8');
    const head = await req(s.port, `/r/${KEY}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    for (const bad of ['/r/ABCDEF12', '/r/k7m2p9xa4', `/r/${KEY}/x`, '/r/']) assert.equal((await req(s.port, bad)).status, 404, bad);
    const api = await req(s.port, '/api/public/rooms');
    assert.equal(api.status, 404);
    assert.equal(api.headers['content-type'], 'application/json; charset=utf-8');
    for (const p of ['/', `/r/${KEY}`, '/healthz', '/manifest.json', '/api/public/rooms', '/nope', '/api/join']) {
      assert.equal((await req(s.port, p)).headers['x-robots-tag'], 'noindex, nofollow', p);
    }
  } finally { s.child.kill(); await s.exited; cleanup(dir); }
});

test('server: secret key 확인 뒤 PUBLIC_ROOMS=on이면 화면 상수 true + 공개 API(로그인 필요, 초대 코드 없음)', async () => {
  const dir = makeRelease();
  const s = await start(dir, { PUBLIC_ROOMS: 'on', SUPABASE_SECRET_KEY: SECRET }, /공개 방: 켬/);
  try {
    assert.match(s.log(), /초대 코드로 가입: 켬/);
    assert.match(s.log(), /공개 방: 켬 \(사진 켬\)/);
    const home = await req(s.port, '/');
    assert.ok(home.body.includes('const PUBLIC_ROOMS_ENABLED = true;'));
    assert.ok(home.body.includes('const SIGNUP_ENABLED = true;'));
    assert.ok((await req(s.port, `/r/${KEY}`)).body.includes('const PUBLIC_ROOMS_ENABLED = true;'));
    const anon = await req(s.port, '/api/public/rooms');
    assert.equal(anon.status, 401);
    assert.equal(JSON.parse(anon.body).login, true);
    const auth = { authorization: `Bearer at.${U1}.sig` };
    const list = await req(s.port, '/api/public/rooms', { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.headers['cache-control'], 'private, max-age=60');
    assert.equal(JSON.parse(list.body).rooms[0].key, KEY);
    const room = await req(s.port, `/api/public/rooms/${KEY}`, { headers: auth });
    assert.equal(room.status, 200);
    const j = JSON.parse(room.body);
    assert.ok(j.places[0].photos[0].thumb_url.startsWith(`${SUPA}/storage/v1/object/sign/place-photos/`));
    for (const r of [list, room]) {
      assert.ok(!r.body.includes(INVITE), '초대 코드 없음');
      assert.ok(!r.body.includes('invite_code') && !r.body.includes('favorite'));
    }
    assert.equal((await req(s.port, '/api/public/rooms/h3n8q2w5zt', { headers: auth })).status, 404);
    assert.equal((await req(s.port, '/api/public/rooms', { method: 'POST', headers: auth })).status, 405);
  } finally { s.child.kill(); await s.exited; cleanup(dir); }
});

test('server: PUBLIC_ROOMS 기본(off)·public.sql 없음이면 화면 상수 false, /api/public 404 또는 503', async () => {
  const dir = makeRelease();
  let s = await start(dir, { SUPABASE_SECRET_KEY: SECRET }, /초대 코드로 가입: 켬/);
  try {
    assert.match(s.log(), /공개 방: 꺼 둠 \(PUBLIC_ROOMS=off\)/);
    assert.ok((await req(s.port, '/')).body.includes('const PUBLIC_ROOMS_ENABLED = false;'));
    assert.equal((await req(s.port, '/api/public/rooms')).status, 404);
  } finally { s.child.kill(); await s.exited; }
  s = await start(dir, { SUPABASE_SECRET_KEY: SECRET, PUBLIC_ROOMS: 'on', FAKE_NO_PUBLIC_SQL: '1' }, /초대 코드로 가입: 꺼 둠/);
  try {
    assert.match(s.log(), /public\.sql을 먼저 실행해 주세요/);
    const home = await req(s.port, '/');
    assert.ok(home.body.includes('const PUBLIC_ROOMS_ENABLED = false;'));
    assert.ok(home.body.includes('const SIGNUP_ENABLED = false;'));
    const api = await req(s.port, '/api/public/rooms', { headers: { authorization: `Bearer at.${U1}.sig` } });
    assert.equal(api.status, 503);
    assert.equal(api.headers['retry-after'], '60');
    assert.equal((await req(s.port, '/api/join', { method: 'POST' })).status, 503);
  } finally { s.child.kill(); await s.exited; cleanup(dir); }
});
