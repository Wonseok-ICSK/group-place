'use strict';
// 룰렛(v0.4.0, docs/roulette-design.md) 화면 시험. index.html을 글자로 읽어 DOM 없는 함수를 떼어 내 Node에서 확인한다.
// 후보 거르기, 고른 분포·거절 표본·경계, 원판 각도, 공유 글·지도 링크 규칙, 읽기 전용 허용 목록, 머리 단추,
// 모자랄 때 도움말, 원판 이름 글자 크기, 두 번 누르기, 결과를 지금 값으로, 초점, 정보 수정 뒤 돌아갈 곳. 운영 DB·네트워크 없음.
// 실행: cd dev/sqltest && npm test (이 폴더의 *.test.cjs를 모두 돌림)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 'function name(...) {' 부터 맨 앞 칸의 '}'까지 (public-client.test.cjs와 같은 방식)
function fnSource(name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(HTML);
  assert.ok(m, `${name} 함수가 있어야 함`);
  const end = HTML.indexOf('\n}\n', m.index);
  return HTML.slice(m.index, end + 2);
}
const load = (names, ret) => new Function(`${names.map(fnSource).join('\n')}\nreturn ${ret};`)();
const { rouletteCandidates, fairIndex, wheelTarget, rouletteShareText, rouletteMapUrl } = load(
  ['rouletteCandidates', 'fairIndex', 'wheelTarget', 'publicMapUrl', 'rouletteMapUrl', 'rouletteShareText'],
  '{ rouletteCandidates, fairIndex, wheelTarget, rouletteShareText, rouletteMapUrl }',
);

test('R0. 네 함수는 화면(DOM)을 쓰지 않는 맨 바깥 함수', () => {
  for (const name of ['rouletteCandidates', 'fairIndex', 'wheelTarget', 'rouletteShareText', 'rouletteMapUrl']) {
    const src = fnSource(name);
    for (const bad of ['document', 'window', '$(', 'state.', 'innerHTML', 'navigator', 'location']) {
      assert.ok(!src.includes(bad), `${name}에 ${bad}`);
    }
  }
});

test('R1. 후보: 기본은 가고 싶은 곳만, 켜면 다녀온 곳도, 카테고리로 거르기(\'\'·null = 전체), 담은 순서(최신 먼저), 받은 배열은 그대로', () => {
  const P = (id, status, category, created_at) => ({ id, status, category, created_at });
  const places = [
    P('a', 'want_to_go', '카페', '2026-10-01T10:00:00+00:00'),
    P('b', 'visited', '카페', '2026-10-05T10:00:00+00:00'),
    P('c', 'want_to_go', '맛집', '2026-10-09T10:00:00+00:00'),
    P('d', 'visited', '맛집', '2026-09-01T10:00:00+00:00'),
    P('e', 'want_to_go', '카페', '2026-10-20T10:00:00+00:00'),
    P('f', 'archived', '카페', '2026-10-21T10:00:00+00:00'), // 모르는 상태는 빠짐
  ];
  const before = JSON.stringify(places);
  const ids = (list) => list.map((p) => p.id);
  assert.deepEqual(ids(rouletteCandidates(places, {})), ['e', 'c', 'a']);
  assert.deepEqual(ids(rouletteCandidates(places)), ['e', 'c', 'a']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: '', withVisited: false })), ['e', 'c', 'a']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: null, withVisited: true })), ['e', 'c', 'b', 'a', 'd']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: '카페' })), ['e', 'a']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: '카페', withVisited: true })), ['e', 'b', 'a']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: '맛집', withVisited: true })), ['c', 'd']);
  assert.deepEqual(ids(rouletteCandidates(places, { cat: '술집', withVisited: true })), []);
  assert.deepEqual(rouletteCandidates([], { withVisited: true }), []);
  assert.deepEqual(rouletteCandidates(null), []);
  assert.equal(JSON.stringify(places), before, '받은 배열을 바꾸지 않음');
});

// 결정적인 32비트 생성기 (xorshift32)
const xorshift = (seed) => { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; };
const queue = (values) => { const a = [...values]; let calls = 0; const f = () => { calls++; assert.ok(a.length, '준비한 값보다 많이 부름'); return a.shift(); }; f.calls = () => calls; return f; };

test('R2. fairIndex: 고른 분포(결정적 생성기), 0..n-1 순서대로 넣으면 정확히 같은 수, 범위 밖 n은 거절', () => {
  for (const [n, seed] of [[2, 7], [3, 11], [6, 2026], [7, 99], [12, 4242]]) {
    const counts = new Array(n).fill(0), rand = xorshift(seed), draws = 12000 * n;
    for (let i = 0; i < draws; i++) counts[fairIndex(n, rand)]++;
    const expected = draws / n;
    for (const c of counts) assert.ok(Math.abs(c - expected) / expected < 0.04, `n=${n} 칸 하나가 ${c} (기대 ${expected})`);
  }
  // 0,1,2,… 를 차례로 넣으면 나머지가 한 바퀴씩 돌아 모든 칸이 정확히 같은 횟수
  let k = 0;
  const counter = () => k++;
  const counts = new Array(5).fill(0);
  for (let i = 0; i < 5000; i++) counts[fairIndex(5, counter)]++;
  assert.deepEqual(counts, [1000, 1000, 1000, 1000, 1000]);
  // 기본 생성기(crypto.getRandomValues)
  for (let i = 0; i < 200; i++) { const v = fairIndex(9); assert.ok(Number.isInteger(v) && v >= 0 && v < 9); }
  for (const bad of [0, -1, 1.5, NaN, 2 ** 32 + 1, '3']) assert.throws(() => fairIndex(bad, counter), RangeError, String(bad));
});

test('R2b. fairIndex 거절 표본: 2^32 아래 n의 배수 구간 밖이면 다시 뽑음, n=1·n=2 경계', () => {
  // n=3: 구간 = floor(2^32/3)*3 = 4294967295 → 2^32-1만 밖
  let r = queue([4294967295, 7]);
  assert.equal(fairIndex(3, r), 1);
  assert.equal(r.calls(), 2, '밖의 값은 버리고 한 번 더 뽑음');
  r = queue([4294967294]);
  assert.equal(fairIndex(3, r), 4294967294 % 3);
  assert.equal(r.calls(), 1, '구간 안 마지막 값은 그대로');
  // n=6: 2^32 % 6 = 4 → 위쪽 4개 값(4294967292~4294967295)은 거절
  r = queue([4294967292, 4294967295, 4294967293, 4294967291]);
  assert.equal(fairIndex(6, r), 4294967291 % 6);
  assert.equal(r.calls(), 4);
  // n=10: 2^32 % 10 = 6
  r = queue([4294967290, 4294967289]);
  assert.equal(fairIndex(10, r), 9);
  assert.equal(r.calls(), 2);
  // n=1: 무엇이 와도 0, 한 번만 부름 (2^32-1도 거절하지 않음)
  for (const v of [0, 1, 123456789, 4294967295]) { r = queue([v]); assert.equal(fairIndex(1, r), 0); assert.equal(r.calls(), 1); }
  // n=2: 2^32는 2의 배수라 거절이 없음, 짝수 0 / 홀수 1
  for (const v of [0, 1, 2, 4294967294, 4294967295]) { r = queue([v]); assert.equal(fairIndex(2, r), v % 2); assert.equal(r.calls(), 1); }
  // n=2를 고르게: 생성기가 주는 값의 절반씩
  const rand = xorshift(5);
  let ones = 0;
  for (let i = 0; i < 20000; i++) ones += fairIndex(2, rand);
  assert.ok(Math.abs(ones - 10000) < 400, `n=2 한쪽이 ${ones}`);
});

test('R3. wheelTarget: 뽑힌 칸 가운데가 위쪽 바늘 아래, 늘 앞으로 turns바퀴 이상(turns+1바퀴 미만) 돎', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-7;
  const mod = (a) => ((a % 360) + 360) % 360;
  for (let n = 2; n <= 12; n++) {
    const seg = 360 / n;
    for (let i = 0; i < n; i++) {
      for (const turns of [1, 3, 6]) {
        for (const current of [0, 17.5, 123.4, 359.99, 765, 2500, -30]) {
          const t = wheelTarget(i, n, turns, current);
          assert.ok(t - current >= turns * 360 - 1e-9, `n=${n} i=${i} 덜 돎`);
          assert.ok(t - current < (turns + 1) * 360, `n=${n} i=${i} 한 바퀴 넘게 더 돎`);
          // 원판이 t만큼 돌면 칸 i의 가운데((i+0.5)·seg)가 0°(위)에 옴
          const c = mod(t + (i + 0.5) * seg);
          assert.ok(near(c, 0) || near(c, 360), `n=${n} i=${i} 가운데가 바늘에 안 옴 (${c})`);
          // 바늘 아래(원판 좌표로 -t)는 칸 i 안
          assert.equal(Math.floor((mod(-t) + 1e-9) / seg) % n, i, `n=${n} i=${i} 바늘 아래 칸`);
        }
      }
    }
  }
  assert.equal(wheelTarget(0, 4, 2), 720 + 315, 'current를 빼면 0에서 시작');
  // 다시 돌릴 때(지금 각도에서 이어서)도 앞으로만
  let angle = 0;
  for (const i of [3, 0, 7, 7, 1]) { const t = wheelTarget(i, 8, 6, angle); assert.ok(t > angle); angle = t; }
});

test('R4. 공유 글: 세 줄(제목·카테고리 · 주소·지도 링크), 주소 없으면 카테고리만, 사이트 주소 없음', () => {
  const p = { name: '골목 끝 칼국수', category: '맛집', address: '서울 마포구 망원동 41-7', naver_url: 'https://naver.me/abc123' };
  assert.equal(rouletteShareText(p), '🎯 룰렛으로 정했어요: 골목 끝 칼국수\n맛집 · 서울 마포구 망원동 41-7\nhttps://naver.me/abc123');
  const noAddr = rouletteShareText({ name: '한강 노을 산책길', category: '놀거리', address: null, naver_url: null });
  assert.deepEqual(noAddr.split('\n'), ['🎯 룰렛으로 정했어요: 한강 노을 산책길', '놀거리', `https://map.naver.com/p/search/${encodeURIComponent('한강 노을 산책길')}`]);
  // 특수 문자: 글자 그대로 (HTML 바꾸기 없음), 링크에서는 인코딩
  const odd = { name: '<b>&"빵\' 집', category: '디저트', address: '부산 #1', naver_url: '' };
  const lines = rouletteShareText(odd).split('\n');
  assert.equal(lines[0], '🎯 룰렛으로 정했어요: <b>&"빵\' 집');
  assert.equal(lines[2], `https://map.naver.com/p/search/${encodeURIComponent('<b>&"빵\' 집 부산 #1')}`);
  assert.ok(!/[\s<>"]/.test(lines[2]), '링크에 공백·꺾쇠·따옴표가 없음');
  for (const text of [rouletteShareText(p), noAddr, rouletteShareText(odd)]) {
    assert.equal(text.split('\n').length, 3);
    assert.ok(!/YOUR-SITE|localhost|127\.0\.0\.1|\/r\//.test(text), '사이트 주소를 넣지 않음');
    assert.ok(!/&(amp|lt|gt|quot);/.test(text));
  }
});

test('R5. 지도 링크 규칙: 아는 지도 주소(publicMapUrl)는 그대로, 그 밖은 네이버 지도 검색(이름 + 주소, 인코딩)', () => {
  const base = { name: '바람정원 카페', address: '경기 파주시 탄현면 정원길 12' };
  const search = `https://map.naver.com/p/search/${encodeURIComponent('바람정원 카페 경기 파주시 탄현면 정원길 12')}`;
  for (const [u, want] of [
    ['https://naver.me/xRamen01', 'https://naver.me/xRamen01'],
    ['http://naver.me/abc', 'https://naver.me/abc'], // 아는 주소는 https로
    ['https://map.naver.com/p/entry/place/123', 'https://map.naver.com/p/entry/place/123'],
    ['https://m.place.naver.com/restaurant/1', 'https://m.place.naver.com/restaurant/1'],
    ['https://maps.app.goo.gl/AbCd', 'https://maps.app.goo.gl/AbCd'],
    ['https://www.google.co.kr/maps/place/x', 'https://www.google.co.kr/maps/place/x'],
    ['https://goo.gl/maps/x', 'https://goo.gl/maps/x'],
    ['https://kko.to/a1', 'https://kko.to/a1'],
    ['https://place.map.kakao.com/123', 'https://place.map.kakao.com/123'],
  ]) {
    assert.equal(rouletteMapUrl({ ...base, naver_url: u }), want, u);
    assert.equal(rouletteShareText({ ...base, category: '카페', naver_url: u }).split('\n')[2], want, u);
  }
  for (const u of ['https://evil.example/', 'https://naver.me.evil.example/x', 'https://www.instagram.com/p/x', 'https://www.google.com/search?q=1',
    'https://a:b@naver.me/x', 'https://naver.me:444/x', 'javascript:alert(1)', 'naver.me/abc', 'not a url', '', null, undefined]) {
    assert.equal(rouletteMapUrl({ ...base, naver_url: u }), search, String(u));
  }
  assert.equal(rouletteMapUrl({ name: '돈가스 골목 2호점', address: '', naver_url: null }), `https://map.naver.com/p/search/${encodeURIComponent('돈가스 골목 2호점')}`);
  // 같은 규칙: 공유 글도 publicMapUrl을 거침
  assert.match(fnSource('rouletteMapUrl'), /publicMapUrl\(/);
  assert.match(fnSource('rouletteShareText'), /rouletteMapUrl\(/);
});

test('R6. 읽기 전용: VISIT_ACTIONS·읽기 전용 구간에 룰렛이 없고, 눌러도(click 위임) 아무 일도 하지 않음', async () => {
  const m = /const VISIT_ACTIONS = (\[[^\]]*\]);/.exec(HTML);
  assert.ok(m);
  const actions = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(!actions.some((a) => /roulette/.test(a)), 'VISIT_ACTIONS에 룰렛');
  const a = HTML.indexOf('/* readOnly */'), b = HTML.indexOf('/* /readOnly */');
  assert.ok(a > 0 && b > a);
  assert.ok(!/roulette|룰렛/.test(HTML.slice(a, b)), '읽기 전용 구간에 룰렛');

  // 실제 click 위임을 VM에서: 읽기 전용이면 openRoulette·openSheet가 불리지 않음, 내 방이면 열림
  for (const readOnly of [true, false]) {
    let click;
    const calls = [];
    const ctx = {
      document: { addEventListener: (n, f) => { if (n === 'click') click = f; } }, ro: () => readOnly,
      state: { sheet: null, couple: { id: 'A' }, roulette: null }, curPlaces: () => [],
      openRoulette: () => calls.push('openRoulette'), openSheet: () => calls.push('openSheet'), spinRoulette: () => calls.push('spin'),
      rouletteAt: () => null, rouletteReady: (r) => !!r, busy: async (b, f) => f(), shareRoulette: async () => calls.push('share'),
      toast: (s) => calls.push(`toast:${s}`), friendly: (e) => e.message,
    };
    vm.createContext(ctx);
    vm.runInContext(m[0], ctx);
    vm.runInContext(HTML.slice(HTML.indexOf("document.addEventListener('click',"), HTML.indexOf('// 사진을 옆으로 밀 때 번호')), ctx);
    for (const action of ['roulette', 'roulette-spin', 'roulette-again', 'roulette-share', 'roulette-open']) {
      await click({ target: { closest: () => ({ dataset: { action, id: 'p' } }) } });
    }
    assert.deepEqual(calls, readOnly ? [] : ['openRoulette'], readOnly ? '읽기 전용에서 룰렛 단추가 동작함' : '내 방에서 룰렛이 안 열림');
  }
});

test('R7. 머리의 룰렛 단추: 내 방 메인에만 그리고 읽기 전용(ro())에서는 그리지 않음', () => {
  assert.equal(HTML.split('data-action="roulette"').length, 2, '룰렛 머리 단추는 한 곳(viewMain)에만');
  let readOnly = false;
  const h = {
    ro: () => readOnly, ui: () => ({ tab: 'want_to_go', category: '전체', query: '', sort: 'recent' }), curPlaces: () => [],
    visitStateView: () => '', catNames: () => ['맛집'], memberOrder: () => [], person: () => ({ name: '', cls: '' }),
    visitHeadHtml: (duo) => `<div class="visit-band">${duo}</div>`, roomTitleBtn: (n) => `<button data-action="rooms">${n}</button>`,
    isPublicRoom: () => false, pubBadge: '', visitNotesHtml: () => '', inviteBand: () => '', listHtml: () => '',
    esc: (s) => String(s), ICON: new Proxy({}, { get: (_, k) => `<svg data-icon="${String(k)}"></svg>` }),
    state: { couple: { name: '주말 맛집 탐방대' }, visit: { status: 'ok', data: { categories: [] } } },
  };
  const viewMain = new Function('h', `const { ro, ui, curPlaces, visitStateView, catNames, memberOrder, person, visitHeadHtml, roomTitleBtn,
    isPublicRoom, pubBadge, visitNotesHtml, inviteBand, listHtml, esc, ICON, state } = h;\n${fnSource('viewMain')}\nreturn viewMain;`)(h);
  const mine = viewMain();
  assert.match(mine, /<button class="icon-btn" data-action="roulette" aria-label="룰렛"><svg data-icon="roulette"><\/svg><\/button>/);
  assert.ok(mine.indexOf('data-action="roulette"') < mine.indexOf('data-action="cup"'), '트로피 옆(앞)에');
  readOnly = true;
  const visit = viewMain();
  assert.ok(visit.includes('visit-band'), '읽기 전용 머리로 그려짐');
  assert.ok(!visit.includes('roulette'), '읽기 전용에 룰렛 단추');
});

test('R8. 시트를 닫거나 방을 바꾸면 타이머·애니메이션을 멈추고, 돌던 룰렛은 결과 없이 고르기로', () => {
  assert.match(fnSource('closeSheet'), /stopRoulette\(\)/);
  assert.match(fnSource('openSheet'), /stopRoulette\(\)/);
  const reset = fnSource('resetRoomView');
  assert.match(reset, /roulette: null/);
  assert.match(reset, /stopRoulette\(\)/);
  assert.match(HTML.slice(HTML.indexOf("if (event === 'SIGNED_OUT')"), HTML.indexOf('} else if (session)')), /roulette: null[\s\S]*stopRoulette\(\)/);
  // stopRoulette를 VM에서 실행
  const decl = /\nlet rouletteTimers = \[\], rouletteAnim = null;[^\n]*\n/.exec(HTML);
  assert.ok(decl, 'let rouletteTimers 한 줄');
  const cleared = [];
  let cancelled = 0;
  const ctx = { state: { roulette: { step: 'spin', from: 40, angle: 40 } }, clearTimeout: (t) => cleared.push(t) };
  vm.createContext(ctx);
  vm.runInContext(`${decl[0]}${fnSource('stopRoulette')}`, ctx);
  ctx.cancel = () => { cancelled++; };
  vm.runInContext('rouletteTimers = [11, 12, 13]; rouletteAnim = { cancel }; stopRoulette();', ctx);
  assert.deepEqual(cleared, [11, 12, 13]);
  assert.equal(cancelled, 1);
  assert.equal(vm.runInContext('rouletteTimers.length + (rouletteAnim === null ? 0 : 100)', ctx), 0);
  assert.equal(ctx.state.roulette.step, 'setup');
  ctx.state.roulette = { step: 'result', angle: 700 };
  vm.runInContext('stopRoulette()', ctx);
  assert.equal(ctx.state.roulette.step, 'result', '결과 화면은 그대로');
  ctx.state.roulette = null;
  vm.runInContext('stopRoulette()', ctx); // 룰렛이 없어도 오류 없음
});

test('R9. 원판은 12곳까지, 그 위는 이름 넘기기. 움직임 줄이기면 돌리지 않고 바로 결과, 원판 이름은 esc()를 거침', () => {
  assert.match(HTML, /\nconst RL_WHEEL_MAX = 12;/);
  const spin = fnSource('spinRoulette');
  assert.match(spin, /r\.mode = n <= RL_WHEEL_MAX \? 'wheel' : 'ticker';/);
  assert.match(spin, /if \(reducedMotion\(\)\) \{ finishRoulette\(r\); return; \}/);
  assert.match(spin, /fairIndex\(n\)/);
  assert.match(HTML, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  const wheel = fnSource('rouletteWheel');
  assert.match(wheel, /\$\{esc\(rouletteLabel\(r\.names\[id\], [^)]+\)\)\}/);
  // 룰렛 화면 함수들의 HTML 줄에서 장소 값은 esc()를 거침
  const src = ['rouletteSetupHtml', 'rouletteWheel', 'rouletteTicker', 'rouletteResultHtml'].map(fnSource).join('\n');
  const direct = src.split('\n').filter((line) => /<[a-z/]/i.test(line))
    .flatMap((line) => line.match(/\$\{\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(name|category|address|naver_url|id|shareText)\s*\}/g) || []);
  assert.deepEqual(direct, [], `esc() 없이 HTML에 넣는 곳: ${direct}`);
});

// 한 줄짜리 const 선언 떼어 내기 (예: const rouletteAt = ...;)
function constLine(name) {
  const m = new RegExp(`\\nconst ${name} = [^\\n]*\\n`).exec(HTML);
  assert.ok(m, `const ${name} 한 줄`);
  return m[0];
}

test('R10. 후보가 모자랄 때 도움말: 전체에서는 다른 카테고리를 권하지 않고, 다녀온 곳 켜기는 켜면 후보가 늘 때만', () => {
  const h = { state: { places: [] }, catNames: () => ['카페', '맛집'], esc: (s) => String(s ?? '') };
  const setupHtml = new Function('h', `const { state, catNames, esc } = h;\n${fnSource('rouletteCandidates')}\n${fnSource('rouletteSetupHtml')}\nreturn rouletteSetupHtml;`)(h);
  const P = (id, status, category) => ({ id, status, category, name: `장소${id}`, created_at: `2026-10-0${id}` });
  const box = (places, cat, withVisited) => {
    h.state.places = places;
    const m = /<div class="rl-empty">([\s\S]*?)<\/div>/.exec(setupHtml({ cat, withVisited, skip: [] }));
    return m ? m[1].replace(/<strong>[\s\S]*<\/strong>/, (s) => `${s.replace(/<[^>]+>/g, '')}|`) : null;
  };
  const tipOf = (t) => t.split('|')[1];
  const visitTip = '다녀온 곳도 넣기';
  // 전체: 어떤 경우에도 '다른 카테고리'는 없음
  const sets = [[], [P(1, 'want_to_go', '카페')], [P(1, 'visited', '카페')], [P(1, 'visited', '카페'), P(2, 'visited', '맛집')],
    [P(1, 'want_to_go', '카페'), P(2, 'visited', '맛집')], [P(1, 'want_to_go', '카페'), P(2, 'visited', '맛집'), P(3, 'visited', '카페')]];
  let seen = 0;
  for (const places of sets) {
    for (const withVisited of [false, true]) {
      const t = box(places, '', withVisited);
      if (t === null) continue; // 후보가 2곳 이상이면 안내 상자 없음
      seen++;
      assert.ok(!t.includes('다른 카테고리'), `전체에서 다른 카테고리 권함: ${t}`);
      const visitedN = places.filter((p) => p.status === 'visited').length;
      assert.equal(t.includes(visitTip), !withVisited && visitedN > 0, `다녀온 곳 켜기 권함이 맞지 않음 (켬 ${withVisited}, 다녀온 곳 ${visitedN}): ${t}`);
    }
  }
  assert.ok(seen >= 6, `안내 상자를 본 경우 ${seen}`);
  assert.equal(box([], '', false), '가고 싶은 곳이 없어요|가고 싶은 곳을 먼저 담아 주세요.');
  assert.equal(box([P(1, 'want_to_go', '카페')], '', false), '후보가 1곳뿐이에요|가고 싶은 곳을 더 담아 주세요.');
  assert.equal(tipOf(box([P(1, 'visited', '맛집')], '', false)), '‘다녀온 곳도 넣기’를 켜 보세요.');
  assert.equal(box([P(1, 'visited', '맛집')], '', true), '후보가 1곳뿐이에요|가고 싶은 곳을 더 담아 주세요.');
  // 카테고리를 고른 때: 그 카테고리에 다녀온 곳이 있고 꺼져 있을 때만 켜기를 함께 권함
  assert.equal(box([P(1, 'visited', '맛집')], '카페', false), '이 카테고리에는 가고 싶은 곳이 없어요|다른 카테고리를 골라 보세요.');
  assert.equal(tipOf(box([P(1, 'visited', '카페')], '카페', false)), '다른 카테고리를 고르거나 ‘다녀온 곳도 넣기’를 켜 보세요.');
  assert.equal(box([P(1, 'visited', '카페')], '카페', true), '후보가 1곳뿐이에요|다른 카테고리를 골라 보세요.');
});

test('R11. 원판 이름: 글자 크기는 이름마다 (들어가면 칸 수의 크기, 길면 11까지 줄인 뒤에야 …), 칸이 적을수록 이름이 짧아지지 않음', () => {
  const ctx = { esc: (s) => String(s ?? '') };
  const { rouletteWheel, rouletteEm, rouletteLabel } = new Function('h', `const { esc } = h;\n${constLine('rouletteTone')}${fnSource('rouletteEm')}\n${fnSource('rouletteLabel')}\n${fnSource('rouletteWheel')}\nreturn { rouletteWheel, rouletteEm, rouletteLabel };`)(ctx);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(rouletteEm('스타벅스 강남점'), 7.3));
  assert.ok(near(rouletteEm('을지로 평양냉면'), 7.3));
  assert.ok(near(rouletteEm('Cafe 1'), 0.6 * 5 + 0.3));
  assert.equal(rouletteLabel('  스타벅스 강남점  ', 7.3), '스타벅스 강남점', '앞뒤 띄어쓰기는 빼고 잼');
  const labels = (names) => {
    const r = { pool: names.map((_, i) => `p${i}`), names: Object.fromEntries(names.map((nm, i) => [`p${i}`, nm])), step: 'spin', winner: null, angle: 0 };
    return [...rouletteWheel(r).matchAll(/<text [^>]*font-size="([\d.]+)">([^<]*)<\/text>/g)].map((m) => ({ fs: Number(m[1]), text: m[2] }));
  };
  const names = ['카페', '스타벅스 강남점', '을지로 평양냉면 본점 이층 창가 자리', 'Blue Bottle Coffee Seongsu', '🍜 라멘'];
  let prev = null;
  for (let n = 12; n >= 2; n--) {
    const pool = Array.from({ length: n }, (_, i) => names[i % names.length]);
    const got = labels(pool);
    assert.equal(got.length, n);
    for (const [i, { fs, text }] of got.entries()) {
      const full = pool[i];
      assert.ok(fs >= 11, `n=${n} ${full} 글자 ${fs}`);
      assert.ok(fs <= (n <= 4 ? 16 : n <= 8 ? 14 : 12.5), `n=${n} ${full} 칸 수보다 큰 글자 ${fs}`);
      assert.ok(rouletteEm(text) * fs <= 92 + 1e-9, `n=${n} ${full} 칸을 넘침 (${rouletteEm(text)}em × ${fs})`);
      if (rouletteEm(full) <= 92 / 11) assert.equal(text, full, `n=${n} 11px로는 들어가는 이름을 자름: ${full} → ${text}`);
      else assert.ok(text.endsWith('…') && fs === 11, `n=${n} 긴 이름은 11px까지 줄인 뒤 자름: ${text} ${fs}`);
    }
    if (prev) {
      for (let i = 0; i < Math.min(prev.length, got.length); i++) {
        assert.ok([...got[i].text].length >= [...prev[i].text].length, `칸이 줄었는데 이름이 짧아짐: ${prev[i].text} → ${got[i].text}`);
        assert.ok(got[i].fs >= prev[i].fs, `칸이 줄었는데 글자가 작아짐: ${prev[i].fs} → ${got[i].fs}`);
      }
    }
    prev = got;
  }
  // 7.3em 이름은 2곳·12곳 모두 그대로
  for (const n of [2, 12]) {
    const got = labels(Array.from({ length: n }, () => '스타벅스 강남점'));
    assert.ok(got.every((x) => x.text === '스타벅스 강남점'), `n=${n}에서 잘림`);
  }
});

test('R12. 두 번 누르기: 단계가 막 바뀐 뒤 잠깐은 돌리기·다시 돌리기·후보 다시 고르기·이 장소 열기·공유하기를 무시', async () => {
  const settle = Number(/\nconst RL_SETTLE_MS = (\d+);/.exec(HTML)[1]);
  assert.ok(settle >= 300 && settle <= 600, `잠깐 = ${settle}ms`);
  let now = 1000, click;
  const calls = [];
  const ctx = {
    document: { addEventListener: (n, f) => { if (n === 'click') click = f; } }, ro: () => false, curPlaces: () => [], performance: { now: () => now },
    state: { sheet: { type: 'roulette' }, couple: { id: 'A' }, places: [{ id: 'w' }], roulette: { step: 'setup', readyAt: 0, shareText: null, snap: { id: 'w' } } },
    // 돌리기: 움직임 줄이기처럼 바로 결과 (finishRoulette와 같이 readyAt을 정함)
    spinRoulette: (again) => { calls.push(again ? 'again' : 'spin'); Object.assign(ctx.state.roulette, { step: 'result', readyAt: now + settle }); },
    openSheet: (t) => calls.push(`open:${t}`), redrawRoulette: () => calls.push('redraw'), busy: async (b, f) => f(), shareRoulette: async () => calls.push('share'),
    toast: (s) => calls.push(`toast:${s}`), friendly: (e) => e.message,
  };
  vm.createContext(ctx);
  vm.runInContext(/const VISIT_ACTIONS = \[[^\]]*\];/.exec(HTML)[0], ctx);
  vm.runInContext(`${constLine('rouletteAt')}${constLine('RL_SETTLE_MS')}${constLine('rouletteReady')}`, ctx);
  vm.runInContext(HTML.slice(HTML.indexOf("document.addEventListener('click',"), HTML.indexOf('// 사진을 옆으로 밀 때 번호')), ctx);
  const press = (action) => click({ target: { closest: () => ({ dataset: { action, id: 'w' } }) } });
  await press('roulette-spin');
  assert.deepEqual(calls.splice(0), ['spin']);
  // 결과가 막 나온 직후(두 번째 누름): 결과 화면의 단추는 모두 무시
  now += 120;
  for (const a of ['roulette-spin', 'roulette-again', 'roulette-setup', 'roulette-open', 'roulette-share']) await press(a);
  assert.deepEqual(calls.splice(0), []);
  assert.equal(ctx.state.roulette.step, 'result');
  // 잠깐 뒤에는 그대로 동작. 후보 다시 고르기 → 고르기로 바뀐 직후의 두 번째 누름(같은 자리의 돌리기)은 무시
  now += settle;
  await press('roulette-setup');
  assert.deepEqual(calls.splice(0), ['redraw']);
  assert.equal(ctx.state.roulette.step, 'setup');
  now += 120;
  await press('roulette-spin');
  assert.deepEqual(calls.splice(0), []);
  now += settle;
  await press('roulette-spin');
  assert.deepEqual(calls.splice(0), ['spin']);
  now += settle;
  for (const a of ['roulette-open', 'roulette-share', 'roulette-again']) await press(a);
  assert.deepEqual(calls.splice(0), ['open:detail', 'share', 'again']);
  // 결과가 나오면 초점은 '다시 돌리기'가 아니라 결과 카드로 (누르고 있던 Enter로 다시 돌지 않게)
  const finish = fnSource('finishRoulette');
  assert.match(finish, /r\.step = 'result';\s*\n\s*r\.readyAt = performance\.now\(\) \+ RL_SETTLE_MS;/);
  assert.ok(finish.indexOf('r.readyAt') < finish.indexOf('renderSheet();\n  r.fresh = false'), 'readyAt은 그리기 전에');
  assert.ok(!/rl-again|again\.focus/.test(finish), '다시 돌리기에 초점');
  assert.match(finish, /card\.focus\(\{ preventScroll: true \}\)/);
  assert.match(fnSource('rouletteResultHtml'), /<section class="rl-result\$\{[^}]+\}" id="rl-result" tabindex="-1">/);
  assert.match(HTML, /readyAt: 0,\n  \};\n  openSheet\('roulette'\);/);
});

test('R13. 결과 카드·공유 글은 지금 장소 값으로 (결과를 보는 사이 고치면 고친 값, 지워졌으면 담아 둔 값)', () => {
  const h = { state: { places: [] }, esc: (s) => String(s ?? ''), ICON: { pin: '' } };
  const { rouletteResultHtml, rouletteLive, rouletteShareText } = new Function('h', `const { state, esc, ICON } = h;\n${constLine('rouletteSnap')}${['publicMapUrl', 'rouletteMapUrl', 'rouletteShareText', 'roParticle', 'rouletteLive', 'rouletteResultHtml'].map(fnSource).join('\n')}\nreturn { rouletteResultHtml, rouletteLive, rouletteShareText };`)(h);
  const old = { id: 'w', name: '옛 이름 칼국수', category: '맛집', address: '서울 마포구', status: 'want_to_go', naver_url: '', visits: [] };
  const r = { pool: ['w', 'x'], winner: 'w', names: { w: old.name, x: '다른 곳' }, cats: { w: '맛집', x: '카페' }, shareText: null, fresh: false, snap: null };
  h.state.places = [old];
  assert.equal(rouletteLive(r), old);
  assert.equal(r.snap.name, '옛 이름 칼국수');
  // 상세에서 이름·상태를 바꾼 뒤 결과로 돌아옴 (공유 창이 없어 글을 보여 주던 중)
  r.shareText = rouletteShareText(r.snap);
  h.state.places = [{ ...old, name: '새 이름 칼국수', status: 'visited', visits: [{ id: 'v1' }] }];
  let html = rouletteResultHtml(r);
  assert.ok(html.includes('<b>새 이름 칼국수</b>') && !html.includes('옛 이름'), '결과 카드가 옛 이름');
  assert.match(html, /다녀온 곳 · 방문 1번/);
  assert.match(html, /data-action="roulette-open"/);
  assert.equal(r.names.w, '새 이름 칼국수', '원판 칸·넘기던 이름도 같게');
  assert.ok(r.shareText.startsWith('🎯 룰렛으로 정했어요: 새 이름 칼국수'), '보여 주던 공유 글이 옛 값');
  // 지워짐: 담아 둔 값 그대로 + 안내, 이 장소 열기 없음
  h.state.places = [];
  html = rouletteResultHtml(r);
  assert.ok(html.includes('<b>새 이름 칼국수</b>'));
  assert.match(html, /그사이 지워진 장소예요/);
  assert.ok(!html.includes('roulette-open'));
  // 공유하기도 지금 값으로
  assert.match(fnSource('shareRoulette'), /^\nasync function shareRoulette\(r\) \{\n  rouletteLive\(r\);[^\n]*\n  const s = r\.snap, text = rouletteShareText\(s\);/);
  // 원판·이름 넘기기보다 결과(rouletteLive)를 먼저 만들어 같은 이름으로 그림
  const view = fnSource('rouletteView');
  assert.ok(view.indexOf('rouletteResultHtml(r)') < view.indexOf('rouletteWheel(r)'), '결과보다 원판을 먼저 그림');
});

test('R14. 초점: 시트 안의 ✕·‹ 단추로(뒤 배경 말고), 같은 단계를 다시 그려도 초점 그대로', () => {
  assert.ok(!HTML.includes("$('#sheet-root [data-action=close]')"), '뒤 배경(.sheet-backdrop)을 먼저 찾는 선택자');
  assert.match(fnSource('openSheet'), /\$\('#sheet-root \.sheet \[data-action=close\]'\); c && c\.focus\(\);/);
  assert.match(fnSource('spinRoulette'), /\$\('#sheet-root \.sheet \[data-action=close\]'\)/);
  // Esc는 그대로 (뒤 배경을 눌러도 닫히므로)
  assert.match(HTML, /\$\('\[data-action=close\]', \$\('#sheet-root'\)\)\.click\(\)/);
  // drawSheet의 룰렛: 같은 단계면 초점을 기억했다가 되돌림
  const draw = fnSource('drawSheet');
  const branch = draw.slice(draw.indexOf("s.type === 'roulette'"), draw.indexOf("s.type === 'public-ack'"));
  assert.match(branch, /root\.contains\(document\.activeElement\)/);
  assert.ok(branch.indexOf('document.activeElement') < branch.indexOf('mountSheet(') && branch.indexOf('mountSheet(') < branch.indexOf('focusRoulette('));
  assert.match(fnSource('rouletteResultHtml'), /id="rl-map"/);
  // focusRoulette: data-action(+data-cat/data-id)로 찾고 없으면 id로, 시트 안에서만
  const els = [];
  const mk = (attrs) => { const e = { id: '', dataset: {}, ...attrs, focused: 0, focus() { this.focused++; } }; els.push(e); return e; };
  const chipAll = mk({ dataset: { action: 'roulette-cat', cat: '' } });
  const chipCafe = mk({ dataset: { action: 'roulette-cat', cat: '카페' } });
  const share = mk({ id: 'rl-share-text' });
  const doc = {
    querySelectorAll: (sel) => { assert.match(sel, /^#sheet-root \.sheet \[data-action="[\w-]+"\]$/); const a = /data-action="([\w-]+)"/.exec(sel)[1]; return els.filter((e) => e.dataset.action === a); },
    getElementById: (id) => els.find((e) => e.id === id) || null,
  };
  const focusRoulette = new Function('document', `${fnSource('focusRoulette')}\nreturn focusRoulette;`)(doc);
  focusRoulette('roulette-cat', '');
  focusRoulette('roulette-cat', '카페');
  focusRoulette(undefined, undefined, 'rl-share-text');
  focusRoulette('roulette-cat', '없는 칩', '');
  assert.deepEqual([chipAll.focused, chipCafe.focused, share.focused], [1, 1, 1]);
  // 지워진 결과로 고르기에 돌아갈 때도 초점이 시트 안에
  assert.match(fnSource('finishRoulette'), /if \(!p\) \{[\s\S]*\$\('#sheet-root \.sheet \[data-action=close\]'\)[\s\S]*close\.focus/);
});

test('R15. 룰렛 결과 → 상세 → 정보 수정 → 상세: 돌아갈 곳(back)을 이어 받아 ‹가 결과로', async () => {
  let click;
  const calls = [];
  const ctx = {
    document: { addEventListener: (n, f) => { if (n === 'click') click = f; } }, ro: () => false, curPlaces: () => [],
    state: { sheet: null, couple: { id: 'A' } },
    openSheet: (...args) => calls.push(args), goBackSheet: () => { calls.push('goBack'); return true; }, closeSheet: () => calls.push('closeSheet'),
    dropAddForm: () => {}, toast: (s) => calls.push(`toast:${s}`), friendly: (e) => e.message,
  };
  vm.createContext(ctx);
  vm.runInContext(/const VISIT_ACTIONS = \[[^\]]*\];/.exec(HTML)[0], ctx);
  vm.runInContext(HTML.slice(HTML.indexOf("document.addEventListener('click',"), HTML.indexOf('// 사진을 옆으로 밀 때 번호')), ctx);
  const press = (action) => click({ target: { closest: () => ({ dataset: { action } }) } });
  ctx.state.sheet = { type: 'detail', id: 'p1', back: 'roulette' };
  await press('edit');
  ctx.state.sheet = { type: 'edit', id: 'p1', back: 'roulette' };
  await press('close');
  // 보통의 상세(돌아갈 곳 없음)는 그대로
  ctx.state.sheet = { type: 'detail', id: 'p2' };
  await press('edit');
  ctx.state.sheet = { type: 'edit', id: 'p2' };
  await press('close');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['edit', 'p1', { back: 'roulette' }], ['detail', 'p1', { back: 'roulette' }], ['edit', 'p2', {}], ['detail', 'p2', {}]]);
  // 뒤로 가기(popstate)로 정보 수정을 닫을 때와 저장한 뒤에도
  assert.match(HTML, /else if \(kind === 'edit'\) \{ if \(state\.sheet && state\.sheet\.type === 'edit'\) openSheet\('detail', state\.sheet\.id, state\.sheet\.back \? \{ back: state\.sheet\.back \} : \{\}\); \}/);
  assert.match(HTML, /if \(stillOpen\(\)\) openSheet\('detail', sheet\.id, sheet\.back \? \{ back: sheet\.back \} : \{\}\);\n\s*toast\('변경 내용을 저장했어요\.'\);/);
  // 정보 수정 층은 'sub'가 아니라 'edit'로 쌓임 (back이 있어도)
  assert.match(fnSource('wantedLayers'), /if \(state\.sheet\.type === 'edit'\) want\.push\('edit'\);\n\s*else if \(state\.sheet\.back\) want\.push\('sub'\);/);
});
