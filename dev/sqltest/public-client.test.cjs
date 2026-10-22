'use strict';
// 화면(index.html) 정적 시험 (docs/public-rooms-design.md §6.3의 C1~C5 + 서버와 같은 규칙인지).
// 파일을 글자로 읽어 확인한다. C1의 동의 문구 버전만 PGlite로 public.sql을 실행해 비교. 운영 DB에 연결하지 않음.
// 실행: cd dev/sqltest && npm test (이 폴더의 *.test.cjs를 모두 돌림)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb, run, SERVICE, asUser, addUsers } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SIGNUP = fs.readFileSync(path.join(ROOT, 'deploy', 'home', 'signup.cjs'), 'utf8');
const PUBLIC_SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'public.sql'), 'utf8');

// '/* readOnly */' ~ '/* /readOnly */': 둘러보는 사람에게만 그리는 화면 함수 (초대 정보·찜·고치는 단추가 없어야 하는 곳)
function readOnlySection() {
  const a = HTML.indexOf('/* readOnly */');
  const b = HTML.indexOf('/* /readOnly */');
  assert.ok(a > 0 && b > a, "'/* readOnly */' … '/* /readOnly */' 표시가 하나씩 있어야 함");
  assert.equal(HTML.split('/* readOnly */').length, 2, 'readOnly 시작 표시는 하나');
  return HTML.slice(a, b);
}
// 'function name(...) {' 부터 맨 앞 칸의 '}'까지
function fnSource(name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(HTML);
  assert.ok(m, `${name} 함수가 있어야 함`);
  const end = HTML.indexOf('\n}\n', m.index);
  return HTML.slice(m.index, end + 2);
}
const constValue = (name) => {
  const m = new RegExp(`\\nconst ${name} = ([^;\\n]+);`).exec(HTML);
  assert.ok(m, `const ${name}`);
  return m[1];
};

test('C1. PUBLIC_ROOMS_ENABLED 한 줄, PUBLIC_ACK_VERSION = public_ack_version(), PUBLIC_KEY_RE = SQL 공개 키 글자 모음', async () => {
  assert.equal(HTML.split('\nconst PUBLIC_ROOMS_ENABLED = false;').length, 2, 'PUBLIC_ROOMS_ENABLED = false; 줄이 정확히 하나 (서버가 바꿔 넣음)');
  assert.ok(!/const PUBLIC_ROOMS_ENABLED = true/.test(HTML));
  const ack = Number(constValue('PUBLIC_ACK_VERSION'));
  const db = await newDb({ public: true });
  try {
    await addUsers(db, 1);
    assert.equal((await run(db, SERVICE, 'select public.public_ack_version() as v'))[0].v, ack);
    assert.equal((await run(db, asUser(1), 'select public.public_ack_version() as v'))[0].v, ack);
  } finally { await db.close(); }
  assert.equal(constValue('PUBLIC_KEY_RE'), '/^[a-km-np-z2-9]{10}$/');
  assert.ok(PUBLIC_SQL.includes("check (public_key ~ '^[a-km-np-z2-9]{10}$')"));
});

test('C2. APP_VERSION은 v0.2.1-261022-<소문자 16진수 5자>', () => {
  assert.match(constValue('APP_VERSION'), /^'v0\.2\.1-261022-[0-9a-f]{5}'$/);
});

test('C3. 읽기 전용 구간·VISIT_ACTIONS에 초대 코드·코드 복사·코드 다시 만들기·찜 단추가 없음, VISIT_ACTIONS는 설계 §4.2 목록', () => {
  const ro = readOnlySection();
  for (const bad of ['invite_code', 'copy-code', 'regen-code', 'toggle-fav', 'state.couple']) {
    assert.ok(!ro.includes(bad), `읽기 전용 구간에 ${bad}`);
  }
  const m = /const VISIT_ACTIONS = (\[[^\]]*\]);/.exec(HTML);
  assert.ok(m);
  const actions = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepEqual(actions, ['visit-close', 'visit-retry', 'tab', 'cat', 'sort', 'clear-search', 'open', 'close', 'view-photo',
    'close-viewer', 'copy-open', 'copy-room', 'copy-status', 'copy-save', 'copy-create', 'explore-back']);
  for (const bad of ['copy-code', 'regen-code', 'toggle-fav', 'edit', 'delete-place', 'set-status', 'save-note', 'remove-photo']) {
    assert.ok(!actions.includes(bad), `VISIT_ACTIONS에 ${bad}`);
  }
  // click 위임 맨 앞에서 허용 목록 밖은 끝냄, submit·change 위임도 읽기 전용이면 끝냄
  assert.match(HTML, /if \(ro\(\) && !VISIT_ACTIONS\.includes\(a\)\) return;/);
  assert.match(HTML, /document\.addEventListener\('submit', async \(e\) => \{\n  e\.preventDefault\(\);\n  if \(ro\(\)\) return;/);
});

test('C4. 공개 API 값은 화면에 넣을 때 esc()·imgUrl()·publicMapUrl()을 거침 (직접 넣는 ${x.name} 꼴이 없음)', () => {
  // HTML을 만드는 줄(태그가 있는 줄)만 본다. 알림(toast는 textContent)·검색 글자·DB에 넣는 값은 HTML이 아님
  const direct = readOnlySection().split('\n').filter((line) => /<[a-z/]/i.test(line))
    .flatMap((line) => line.match(/\$\{\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(name|description|shared_note|body|address|map_url|thumb_url|thumb|naver_url|roomName|error|key|url)\s*\}/g) || []);
  assert.deepEqual(direct, [], `esc() 없이 HTML에 넣는 곳: ${direct}`);
  // 받은 지도 링크·사진 주소는 정해진 정리 함수로만
  const vp = fnSource('visitPlace');
  assert.match(vp, /naver_url: publicMapUrl\(x\.map_url\)/);
  assert.match(vp, /imgUrl\(ph && ph\.thumb_url\)/);
});

test('C5. 사진 경로는 무작위 이름(Date.now 없음) + /t/ 썸네일, 지우는 길마다 썸네일도 지움', () => {
  const add = fnSource('addPhotos');
  assert.ok(!add.includes('Date.now()'), 'addPhotos에 Date.now() 경로가 없음 (업로드 시각이 드러남)');
  assert.ok(add.includes('`${place.id}/t/${id}.jpg`'), '썸네일 경로');
  assert.ok(add.includes('photoId()'));
  assert.match(fnSource('deletePhoto'), /photo\.thumb_path/);
  const del = HTML.slice(HTML.indexOf("case 'delete-place'"), HTML.indexOf("case 'remove-photo'"));
  assert.match(del, /x\.thumb_path/);
});

test('서버와 같은 규칙: 못 쓰는 글자(BAD_TEXT_RE)·닉네임 비교(nickKey)·지도 주소(publicMapUrl = public.cjs mapUrl)', () => {
  const re = (src) => /const BAD_TEXT_RE = (\/\[[^\n]+\]\/);/.exec(src)[1];
  assert.equal(re(HTML), re(SIGNUP), 'index.html과 signup.cjs의 BAD_TEXT_RE가 같음');
  const strip = (src) => /\.normalize\('NFKC'\)\.replace\((\/\[[^\n]+?\]\/g)/.exec(src)[1];
  assert.equal(strip(HTML), strip(SIGNUP), 'nickKey가 지우는 글자가 같음');
  // SQL도 같은 글자 모음 (\uXXXX 표기 그대로)
  const sqlOk = /p !~ '(\[[^']+\])'/.exec(PUBLIC_SQL)[1];
  assert.equal(sqlOk.replace('\\u2028\\u2029', ''), re(SIGNUP).slice(1, -1).replace('\\u0000', '\\u0001').replace('\\u2028\\u2029', ''));

  // 화면의 publicMapUrl을 떼어 내 서버 mapUrl과 같은 답을 내는지
  const src = fnSource('publicMapUrl');
  const publicMapUrl = new Function(`${src}\nreturn publicMapUrl;`)();
  const { mapUrl } = require('../../deploy/home/public.cjs');
  for (const u of ['https://naver.me/abc', 'http://naver.me/abc', 'https://m.place.naver.com/r/1', 'https://maps.app.goo.gl/x',
    'https://www.google.co.kr/maps/place/x', 'https://goo.gl/maps/x', 'https://kko.to/a', 'https://place.map.kakao.com/1',
    'https://evil.example/', 'https://naver.me.evil.example/', 'https://www.google.com/search?q=1', 'https://a:b@naver.me/x',
    'https://naver.me:444/x', 'javascript:alert(1)', 'not a url', '', null]) {
    assert.equal(publicMapUrl(u), mapUrl(u), String(u));
  }
});

test('사진 주소(imgUrl): 서버가 넘겨주는 /api/public/img/… 만 받고, Supabase 서명 주소·다른 https는 버림 (업로드 시각이 헤더로 드러나서)', () => {
  const reLine = /\nconst PUBLIC_IMG_RE = [^\n]+;\n/.exec(HTML);
  assert.ok(reLine, 'PUBLIC_IMG_RE 한 줄');
  const SITE = 'https://places.example.com';
  const imgUrl = new Function('location', `${reLine[0]}${fnSource('imgUrl')}\nreturn imgUrl;`)({ origin: SITE });
  const P = '00000000-0000-4000-a000-000000000001';
  const U = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const mac = 'Ab_-'.repeat(10) + 'xyz';
  const thumb = `/api/public/img/1792658000.${mac}/${P}/t/${U}.jpg`;
  for (const ok of [thumb, `/api/public/img/1792658000.${mac}/${P}/${'a'.repeat(32)}.jpg`, 'http://localhost:5173/p.jpg', 'data:image/jpeg;base64,AAAA']) {
    assert.equal(imgUrl(ok), ok.startsWith('http') ? new URL(ok).href : ok, ok);
  }
  // 서버는 사이트 주소를 붙여 줌(예전 탭 호환): 같은 사이트면 경로만 씀
  assert.equal(imgUrl(`${SITE}${thumb}`), thumb);
  for (const bad of [`https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/place-photos/${P}/t/${U}.jpg?token=x`,
    'https://evil.example/p.jpg', `https://evil.example${thumb}`, `//evil.example${thumb}`, `${SITE}${thumb}?x=1`, `${SITE}${thumb}#x`,
    `https://user@places.example.com${thumb}`, `http://places.example.com${thumb}`,
    `/api/public/img/1792658000.${mac}/${P}/t/../../x.jpg`, `/api/public/img/1792658000.${mac.slice(1)}/${P}/t/${U}.jpg`,
    `${thumb}?x=1`, 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', '', null]) {
    assert.equal(imgUrl(bad), '', String(bad));
  }
});
