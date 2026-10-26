'use strict';
// 목록을 옆으로 밀어 탭 넘기기(v0.4.1, 원래 앱 v2.1.0에서 가져옴) 화면 시험. index.html을 글자로 읽어
// 실제 touchstart/touchmove/touchend 처리와 click 위임('tab' 단추)을 VM에서 가짜 화면(DOM)으로 돌린다.
// 기준 값(28px·12px·1.6배·30%), 탭 순서(내 방 3개, 읽기 전용 2개), 끝에서 안 넘어감, 민 뒤 click 버리기,
// 시트가 열려 있으면 안 함, 읽기 전용에서 쓰기 없음, 미는 도중 화면이 새로 그려져도 다음 탭이 안 묻힘,
// 확대 중에는 목록 위 가로 이동을 브라우저에 맡김. 운영 DB·네트워크 없음.
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
// 한 줄짜리 const 선언 (예: const ro = () => !!state.visit;)
function constLine(name) {
  const m = new RegExp(`\\nconst ${name} = [^\\n]*\\n`).exec(HTML);
  assert.ok(m, `const ${name} 한 줄`);
  return m[0];
}
const between = (a, b) => {
  const i = HTML.indexOf(a), j = HTML.indexOf(b, i);
  assert.ok(i > 0 && j > i, `${a} … ${b}`);
  return HTML.slice(i, j);
};
const SWIPE_SRC = between('/* ---------- 목록을 옆으로 밀어 탭 넘기기', "document.addEventListener('input',");
const CLICK_SRC = between("document.addEventListener('click',", '// 사진을 옆으로 밀 때 번호');
const VISIT_ACTIONS_SRC = /const VISIT_ACTIONS = \[[^\]]*\];/.exec(HTML)[0];

// viewMain을 그려서 탭 줄의 data-tab 순서를 읽음 (roulette-client R7과 같은 가짜 도우미)
function viewMainHtml(readOnly) {
  const h = {
    ro: () => readOnly, ui: () => ({ tab: 'want_to_go', category: '전체', query: '', sort: 'recent' }), curPlaces: () => [],
    visitStateView: () => '', catNames: () => ['맛집'], memberOrder: () => [], person: () => ({ name: '', cls: '' }),
    visitHeadHtml: (duo) => `<div class="visit-band">${duo}</div>`, roomTitleBtn: (n) => `<button data-action="rooms">${n}</button>`,
    isPublicRoom: () => false, pubBadge: '', visitNotesHtml: () => '', inviteBand: () => '', listHtml: () => '<ul class="list"></ul>',
    esc: (s) => String(s), ICON: new Proxy({}, { get: (_, k) => `<svg data-icon="${String(k)}"></svg>` }),
    state: { couple: { name: '주말 맛집 탐방대' }, visit: { status: 'ok', data: { categories: [] } } },
  };
  const viewMain = new Function('h', `const { ro, ui, curPlaces, visitStateView, catNames, memberOrder, person, visitHeadHtml, roomTitleBtn,
    isPublicRoom, pubBadge, visitNotesHtml, inviteBand, listHtml, esc, ICON, state } = h;\n${fnSource('viewMain')}\nreturn viewMain;`)(h);
  return viewMain();
}
const tabOrder = (html) => {
  const row = /<div class="tabs" role="tablist">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, '탭 줄');
  return [...row[1].matchAll(/data-action="tab" data-tab="(\w+)"/g)].map((m) => m[1]);
};

/* ---------- 가짜 화면: 목록(#list-area) 안의 카드, 위쪽 탭 단추, 힌트. closest는 '#id'·'[data-action]'·태그 이름만 ---------- */
function matches(n, sel) {
  return sel.split(',').map((s) => s.trim()).some((s) => (s[0] === '#' ? n.id === s.slice(1)
    : s === '[data-action]' ? !!(n.dataset && n.dataset.action != null)
      : s === '[contenteditable]' ? !!n.contentEditable : n.tag === s));
}
// root: 문서에 바로 붙은 요소(main·탭 줄·힌트). 나머지는 부모를 따라 올라가 root에 닿아야 문서 안(isConnected)
function el(props) {
  const set = new Set();
  return {
    tag: 'div', id: '', dataset: {}, style: {}, root: false, parentElement: null, scrollWidth: 300, clientWidth: 300, ox: 'visible',
    get isConnected() { return this.root || !!(this.parentElement && this.parentElement.isConnected); },
    classList: { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c) },
    addEventListener() {},
    closest(sel) { for (let n = this; n; n = n.parentElement) if (matches(n, sel)) return n; return null; },
    ...props,
  };
}

function harness({ readOnly = false, noViewport = false } = {}) {
  const listeners = {}, calls = [], errors = [], timers = [];
  let now = 1000000;
  const main = el({ tag: 'main', root: true });
  const env = { calls, errors, timers, main, area: null, card: null, inner: null, input: null, strip: null, stripItem: null };
  // 목록 안(카드·입력 칸·가로 스크롤 상자)을 새로 채움. 예전 것은 문서에서 빠짐
  let kids = [];
  const fill = (area) => {
    kids.forEach((k) => { k.parentElement = null; });
    const ul = el({ tag: 'ul', parentElement: area, ox: 'clip', scrollWidth: 400, clientWidth: 358 }); // .list{overflow-x:clip}: 스크롤 상자 아님
    const li = el({ tag: 'li', parentElement: ul });
    env.card = el({ tag: 'button', dataset: { action: 'open', id: 'p1' }, parentElement: li });
    env.inner = el({ tag: 'span', parentElement: env.card });
    env.input = el({ tag: 'input', parentElement: area });
    env.strip = el({ parentElement: area, ox: 'auto', scrollWidth: 900, clientWidth: 358 }); // 목록 안에 가로로 스크롤되는 상자가 생긴다면
    env.stripItem = el({ tag: 'img', parentElement: env.strip });
    kids = [ul, env.input, env.strip];
  };
  // 목록을 새로 그림 (render가 부르면 예전 목록은 화면에서 빠짐)
  const newArea = () => {
    if (env.area) env.area.parentElement = null;
    kids = [];
    env.area = el({ id: 'list-area', parentElement: main, clientWidth: 358, scrollWidth: 358 });
    fill(env.area);
  };
  newArea();
  // 목록 칸은 그대로 두고 안만 새로 그림 (검색어를 칠 때 #list-area.innerHTML = listHtml()처럼)
  env.refreshList = () => fill(env.area);
  const order = tabOrder(viewMainHtml(readOnly));
  const top = el({ id: 'top', root: true });
  env.tabs = order.map((t) => el({ tag: 'button', dataset: { action: 'tab', tab: t }, parentElement: top, click() { fire('click', { target: this }); } }));
  env.hint = el({ id: 'swipe-hint', className: 'swipe-hint', textContent: '', root: true });
  const fire = (name, ev) => {
    let stopped = false;
    const e = { ...ev, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
    // 실제 브라우저처럼: 손가락이 닿았던 요소가 그 사이 문서에서 빠지면 그 손가락의 터치 이벤트는 빠진 요소에만 가고 document까지 안 옴
    if (name.startsWith('touch') && ev.target && !ev.target.isConnected) return e;
    const ls = listeners[name] || [];
    for (const l of [...ls.filter((x) => x.capture), ...ls.filter((x) => !x.capture)]) {
      if (stopped) break;
      const r = l.f(e);
      if (r && typeof r.catch === 'function') r.catch((err) => errors.push(err));
    }
    return e;
  };
  env.fire = fire;
  env.listeners = listeners;
  const state = { sheet: null, tab: 'want_to_go', category: '카페', query: '서울', sort: 'recent', places: [], visit: null };
  if (readOnly) state.visit = { status: 'ok', tab: 'visited', category: '전체', query: '라멘', sort: 'rating', places: [], data: { categories: [] } };
  // 읽기 전용에서 쓰기 통로(sb·fetch)에 손대면 바로 기록
  const touched = [];
  const sb = new Proxy({}, { get: (_, k) => { touched.push(`sb.${String(k)}`); return () => { throw new Error('sb'); }; } });
  // 확대 배율이 바뀌면 브라우저가 visualViewport에 resize를 보냄. <html>의 class는 htmlClass에 남김
  const vvListeners = {}, htmlClass = new Set();
  env.vvListeners = vvListeners;
  env.htmlClass = htmlClass;
  const ctx = {
    state, screen: readOnly ? 'visit' : 'main', innerWidth: 390,
    visualViewport: { scale: 1, addEventListener: (n, f) => { (vvListeners[n] = vvListeners[n] || []).push(f); } },
    Date: { now: () => now }, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    getComputedStyle: (n) => ({ overflowX: n.ox || 'visible' }),
    document: {
      documentElement: { classList: { toggle: (c, on) => { if (on) htmlClass.add(c); else htmlClass.delete(c); return !!on; } } },
      addEventListener: (n, f, opt) => { (listeners[n] = listeners[n] || []).push({ f, capture: opt === true || !!(opt && opt.capture), passive: !!(opt && opt.passive) }); },
      querySelectorAll: (sel) => { assert.equal(sel, '.top .tabs [data-action=tab][data-tab]'); return env.tabs; },
    },
    $: (sel) => {
      if (sel === '#swipe-hint') return env.hint;
      if (sel === '#list-area') return env.area;
      const m = /^\.top \.tabs \[data-action=tab\]\[data-tab="(\w+)"\]$/.exec(sel);
      assert.ok(m, `모르는 선택자 ${sel}`);
      return env.tabs.find((b) => b.dataset.tab === m[1]) || null;
    },
    render: () => { calls.push(`render:${env.ui().tab}`); newArea(); },
    openSheet: (type, id) => { calls.push(`openSheet:${type}:${id}`); state.sheet = { type, id }; },
    loadVisitThumbs: (id) => calls.push(`thumbs:${id}`),
    curPlaces: () => [], toast: (s) => calls.push(`toast:${s}`), friendly: (e) => e.message, sb,
    fetch: () => { touched.push('fetch'); throw new Error('fetch'); },
  };
  if (noViewport) delete ctx.visualViewport; // visualViewport가 없는 오래된 브라우저
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${constLine('ro')}${constLine('ui')}${constLine('TAB_NAMES')}${VISIT_ACTIONS_SRC}\n${CLICK_SRC}\n${SWIPE_SRC}`, ctx);
  env.ctx = ctx;
  env.ui = vm.runInContext('ui', ctx); // const라 ctx의 속성이 아님
  env.state = state;
  env.touched = touched;
  env.advance = (ms) => { now += ms; };
  env.tab = () => env.ui().tab;
  // 손가락을 (x0,y0)에서 (x1,y1)까지 steps번에 나눠 움직이고 뗌. 떼기 직전의 힌트·목록 상태를 돌려줌
  env.drag = (x0, y0, x1, y1, { steps = 12, target, end = 'touchend', fingers = 1 } = {}) => {
    const t = target || env.area;
    const pt = (x, y) => Array.from({ length: fingers }, (_, i) => ({ clientX: x + i * 40, clientY: y }));
    fire('touchstart', { target: t, touches: pt(x0, y0) });
    for (let k = 1; k <= steps; k++) fire('touchmove', { target: t, touches: pt(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps) });
    const area = env.area;
    const seen = { text: env.hint.textContent, ready: /\bready\b/.test(env.hint.className), shown: Number(env.hint.style.opacity) > 0,
      tf: area.style.transform || '', op: area.style.opacity || '' };
    fire(end, { target: t, touches: [] });
    return seen;
  };
  return env;
}
const Y = 520;

test('S1. 기준 값과 스타일: 가장자리 28px·처음 12px·가로가 세로의 1.6배·목록 폭 30%, 세로 스크롤·확대는 브라우저에, 움직임 줄이기', () => {
  assert.match(HTML, /\nconst SWIPE = \{ edge: 28, lock: 12, ratio: 1\.6, commit: 0\.3 \};\n/);
  assert.match(HTML, /#list-area\{touch-action:pan-y pinch-zoom;min-height:55vh\}/);
  assert.match(HTML, /\.list-main\{overflow-x:clip\}/, '미는 동안 페이지가 옆으로 넓어지지 않게');
  assert.match(HTML, /#list-area\.settle\{transition:transform \.18s ease,opacity \.18s ease\}/);
  assert.match(HTML, /#list-area\.enter-next\{animation:list-in-next \.22s ease\}/);
  assert.match(HTML, /#list-area\.enter-prev\{animation:list-in-prev \.22s ease\}/);
  assert.match(HTML, /@keyframes list-in-next\{from\{transform:translateX\(48px\);opacity:0\}\}/);
  assert.match(HTML, /@keyframes list-in-prev\{from\{transform:translateX\(-48px\);opacity:0\}\}/);
  assert.match(HTML, /\.swipe-hint\{position:fixed;[^}]*opacity:0;pointer-events:none;/);
  assert.match(HTML, /\.swipe-hint\.ready\{background:var\(--ink\);color:var\(--bg\);border-color:var\(--ink\)\}/);
  assert.match(HTML, /@media \(prefers-reduced-motion:reduce\)\{#list-area\.settle\{transition:none\}#list-area\.enter-next,#list-area\.enter-prev\{animation:none\}\}/);
});

test('S2. 화면: 내 방은 가고 싶은 곳·다녀온 곳·찜, 읽기 전용은 찜 없이 둘. 둘 다 힌트 자리와 잘라 주는 main이 있음', () => {
  const mine = viewMainHtml(false), visit = viewMainHtml(true);
  assert.deepEqual(tabOrder(mine), ['want_to_go', 'visited', 'fav']);
  assert.deepEqual(tabOrder(visit), ['want_to_go', 'visited']);
  for (const html of [mine, visit]) {
    assert.ok(html.includes('<div class="swipe-hint" id="swipe-hint" aria-hidden="true"></div>'));
    assert.ok(html.includes('<main class="wrap list-main">'));
    assert.ok(html.indexOf('id="list-area"') > html.indexOf('<main class="wrap list-main">'));
  }
  // 넘길 탭은 화면의 탭 줄에서 읽음 (viewMain이 그린 것 그대로)
  assert.match(SWIPE_SRC, /const swipeTabs = \(\) => \[\.\.\.document\.querySelectorAll\('\.top \.tabs \[data-action=tab\]\[data-tab\]'\)\]\.map\(\(b\) => b\.dataset\.tab\);/);
});

test('S3. 처리기: touchstart·touchmove는 passive, touchend·touchcancel, 민 뒤 click 버리기는 capture. 다른 시험이 떼어 쓰는 구간 밖', () => {
  const env = harness();
  for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.equal(env.listeners[n].length, 1, n);
    assert.ok(env.listeners[n][0].passive, `${n} passive (스크롤을 막지 않음)`);
  }
  const clicks = env.listeners.click;
  assert.equal(clicks.length, 2, 'click 위임 + 민 뒤 click 버리기');
  assert.deepEqual(clicks.map((l) => l.capture), [false, true]);
  assert.match(SWIPE_SRC, /Date\.now\(\) - swipeAt < 250 && e\.target\.closest && e\.target\.closest\('#list-area'\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/);
  // click 위임 구간(roulette·stability 시험이 VM에서 돌림)과 읽기 전용 구간에 끼어들지 않음
  assert.ok(!/touchstart|swipe/.test(CLICK_SRC), 'click 위임 구간 안에 들어감');
  const a = HTML.indexOf('/* readOnly */'), b = HTML.indexOf('/* /readOnly */');
  assert.ok(!/touchstart|swipe/i.test(HTML.slice(a, b)), '읽기 전용 구간 안에 들어감');
  // 탭은 직접 바꾸지 않고 탭 단추를 누름 (검색어·카테고리·개수·스크롤이 탭을 누를 때와 같게)
  assert.ok(!/\.tab\s*=[^=]/.test(SWIPE_SRC), '밀기가 tab 값을 직접 바꿈');
  assert.match(SWIPE_SRC, /if \(btn\) btn\.click\(\);/);
  // VISIT_ACTIONS는 그대로이고 'tab'은 원래 있음
  assert.ok(JSON.parse(/\[[^\]]*\]/.exec(VISIT_ACTIONS_SRC)[0].replace(/'/g, '"')).includes('tab'));
  assert.ok(!/swipe/.test(VISIT_ACTIONS_SRC));
});

test('S4. 내 방: 왼쪽으로 45% → 다녀온 곳 → 찜, 찜에서 더 밀어도 안 넘어감(살짝만), 오른쪽 → 다녀온 곳. 검색어·카테고리 그대로', () => {
  const env = harness();
  const h1 = env.drag(300, Y, 140, Y); // 160px ≈ 목록 폭(358)의 45%
  assert.equal(env.tab(), 'visited');
  assert.ok(h1.shown && h1.ready && h1.text === '다녀온 곳 →', JSON.stringify(h1));
  assert.equal(h1.tf, 'translateX(-160px)');
  assert.ok(env.area.classList.contains('enter-next'), '새 목록이 오른쪽에서 들어옴');
  assert.equal(env.hint.style.opacity, '0', '손을 떼면 힌트가 사라짐');
  env.drag(300, Y, 140, Y);
  assert.equal(env.tab(), 'fav');
  const h3 = env.drag(300, Y, 140, Y); // 끝 탭에서 바깥쪽
  assert.equal(env.tab(), 'fav', '찜에서 왼쪽으로 넘어감(돌아 감)');
  assert.ok(!h3.shown && h3.text === '' && h3.tf === 'translateX(-32px)' && h3.op === '', `끝에서는 0.2배만 움직이고 힌트 없음 ${JSON.stringify(h3)}`);
  assert.equal(env.area.style.transform, '', '끝에서 놓으면 제자리');
  assert.ok(env.area.classList.contains('settle'));
  const h4 = env.drag(90, Y, 250, Y);
  assert.equal(env.tab(), 'visited');
  assert.ok(h4.ready && h4.text === '← 다녀온 곳', JSON.stringify(h4));
  assert.ok(env.area.classList.contains('enter-prev'));
  assert.equal(env.state.query, '서울');
  assert.equal(env.state.category, '카페');
  assert.deepEqual(env.calls, ['render:visited', 'render:fav', 'render:visited'], '탭 단추를 누른 것과 같은 render만');
  assert.deepEqual(env.errors, []);
});

test('S5. 덜 밀면(20%) 제자리, 비스듬히(세로에 가까움)·세로로 밀면 안 넘어가고 목록도 안 움직임, 가장자리 28px에서 시작하면 무시', () => {
  const env = harness();
  const short = env.drag(260, Y, 190, Y); // 70px ≈ 20%
  assert.equal(env.tab(), 'want_to_go');
  assert.ok(short.shown && !short.ready && short.text === '다녀온 곳 →', JSON.stringify(short));
  assert.ok(Number(short.op) > 0.65 && Number(short.op) < 1, '미는 동안 조금 흐려짐');
  assert.equal(env.area.style.transform, '');
  assert.equal(env.area.style.opacity, '');
  assert.ok(env.area.classList.contains('settle'));
  env.timers.splice(0).forEach((t) => t.f());
  assert.ok(!env.area.classList.contains('settle'), '제자리로 간 뒤 settle을 뺌');
  for (const [x0, y0, x1, y1] of [[300, 650, 160, 450], [200, 700, 205, 300], [300, Y, 230, Y - 50]]) {
    const s = env.drag(x0, y0, x1, y1);
    assert.equal(env.tab(), 'want_to_go', `${[x0, y0, x1, y1]}`);
    assert.ok(!s.shown && s.tf === '', `세로로 시작한 손가락은 끝까지 스크롤 ${JSON.stringify(s)}`);
  }
  env.drag(386, Y, 200, Y); // 오른쪽 끝에서
  env.drag(363, Y, 150, Y); // 390 - 28 = 362보다 오른쪽
  assert.equal(env.tab(), 'want_to_go');
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'visited');
  env.drag(4, Y, 200, Y); // 왼쪽 끝에서
  env.drag(27, Y, 230, Y);
  assert.equal(env.tab(), 'visited');
  env.drag(28, Y, 230, Y); // 딱 28px은 받음
  assert.equal(env.tab(), 'want_to_go');
  assert.deepEqual(env.errors, []);
});

test('S6. 카드 위에서 밀면 그 카드가 안 열림(바로 뒤 click 버림), 잠깐 뒤 그냥 누르면 열림. 탭 단추 누르기는 버리지 않음', () => {
  const env = harness();
  env.drag(300, Y, 140, Y, { target: env.inner });
  assert.equal(env.tab(), 'visited');
  // 브라우저가 손을 뗀 자리(새 목록의 카드)에 click을 보냄
  const e = env.fire('click', { target: env.inner });
  assert.ok(e.defaultPrevented, '민 직후 목록 안 click을 막음');
  assert.ok(!env.calls.some((c) => c.startsWith('openSheet')), '민 손가락이 카드를 엶');
  env.tabs[0].click(); // 목록 밖(탭 단추)은 그대로
  assert.equal(env.tab(), 'want_to_go');
  env.advance(300);
  env.fire('click', { target: env.inner });
  assert.deepEqual(env.calls, ['render:visited', 'render:want_to_go', 'openSheet:detail:p1']);
  // 덜 밀었을 때도(넘어가지 않아도) 가로로 움직였으면 click은 버림
  env.state.sheet = null;
  env.drag(260, Y, 190, Y, { target: env.inner });
  assert.ok(env.fire('click', { target: env.inner }).defaultPrevented);
  // 그냥 누르기(움직임이 12px 안)는 click을 막지 않음
  env.advance(300);
  env.drag(200, Y, 205, Y + 4, { target: env.inner });
  assert.ok(!env.fire('click', { target: env.inner }).defaultPrevented);
  assert.equal(env.calls.filter((c) => c.startsWith('openSheet')).length, 2);
  assert.deepEqual(env.errors, []);
});

test('S7. 시트가 열려 있으면 밀어도 아무 일 없음, 미는 중에 시트가 열리면 그만두고 제자리', () => {
  const env = harness();
  env.state.sheet = { type: 'detail', id: 'p1' };
  const s = env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'want_to_go');
  assert.ok(!s.shown && s.tf === '', JSON.stringify(s));
  for (const type of ['roulette', 'cup', 'settings', 'add']) {
    env.state.sheet = { type };
    env.drag(300, Y, 120, Y);
    assert.equal(env.tab(), 'want_to_go', type);
  }
  env.state.sheet = null;
  env.fire('touchstart', { target: env.area, touches: [{ clientX: 300, clientY: Y }] });
  env.fire('touchmove', { target: env.area, touches: [{ clientX: 220, clientY: Y }] });
  assert.equal(env.area.style.transform, 'translateX(-80px)');
  env.state.sheet = { type: 'detail', id: 'p1' }; // 예: 공유받은 링크로 장소 추가 시트가 뜸
  env.fire('touchmove', { target: env.area, touches: [{ clientX: 120, clientY: Y }] });
  env.fire('touchend', { target: env.area, touches: [] });
  assert.equal(env.tab(), 'want_to_go');
  assert.equal(env.area.style.transform, '');
  assert.deepEqual(env.calls, []);
  // 둘러보기·방 고르기 같은 다른 화면에서는 안 함
  env.state.sheet = null;
  env.ctx.screen = 'explore';
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'want_to_go');
  assert.deepEqual(env.errors, []);
});

test('S8. 두 손가락·확대해서 보는 중·입력 칸·목록 안의 가로 스크롤 상자·목록 밖에서는 안 함, 끊기면(touchcancel) 제자리', () => {
  const env = harness();
  env.drag(300, Y, 120, Y, { fingers: 2 });
  assert.equal(env.tab(), 'want_to_go');
  // 밀던 중에 두 번째 손가락: 목록 제자리, 넘어가지 않음
  env.fire('touchstart', { target: env.area, touches: [{ clientX: 300, clientY: Y }] });
  env.fire('touchmove', { target: env.area, touches: [{ clientX: 150, clientY: Y }] });
  env.fire('touchstart', { target: env.area, touches: [{ clientX: 150, clientY: Y }, { clientX: 200, clientY: Y + 80 }] });
  env.fire('touchmove', { target: env.area, touches: [{ clientX: 100, clientY: Y }, { clientX: 260, clientY: Y + 80 }] });
  env.fire('touchend', { target: env.area, touches: [{ clientX: 100, clientY: Y }] });
  assert.equal(env.tab(), 'want_to_go');
  assert.equal(env.area.style.transform, '');
  // 두 번째 손가락이 닿자마자(움직이기 전에) 그만둠: 한 손가락을 떼도 넘어가지 않음
  env.fire('touchstart', { target: env.area, touches: [{ clientX: 300, clientY: Y }] });
  env.fire('touchmove', { target: env.area, touches: [{ clientX: 150, clientY: Y }] });
  env.fire('touchstart', { target: env.area, touches: [{ clientX: 150, clientY: Y }, { clientX: 200, clientY: Y + 80 }] });
  assert.equal(env.area.style.transform, '');
  env.fire('touchend', { target: env.area, touches: [{ clientX: 200, clientY: Y + 80 }] });
  assert.equal(env.tab(), 'want_to_go');
  env.ctx.visualViewport.scale = 2;
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'want_to_go', '확대한 채로 넘어감');
  env.ctx.visualViewport.scale = 1;
  env.drag(300, Y, 120, Y, { target: env.input });
  env.drag(300, Y, 120, Y, { target: env.stripItem });
  assert.equal(env.tab(), 'want_to_go');
  env.drag(300, Y, 120, Y, { target: env.main }); // 목록 밖(카테고리 칩 줄·검색 칸이 있는 곳)
  env.drag(300, Y, 120, Y, { target: env.tabs[1] });
  assert.equal(env.tab(), 'want_to_go');
  const c = env.drag(300, Y, 120, Y, { end: 'touchcancel' });
  assert.ok(c.ready);
  assert.equal(env.tab(), 'want_to_go', 'touchcancel은 넘어가지 않음');
  assert.equal(env.area.style.transform, '');
  // .list(overflow-x:clip)는 스크롤 상자가 아니라 카드 위에서는 됨
  env.drag(300, Y, 120, Y, { target: env.inner });
  assert.equal(env.tab(), 'visited');
  assert.deepEqual(env.errors, []);
});

test('S9. 읽기 전용(공개 방 둘러보기): 가고 싶은 곳 ↔ 다녀온 곳만, 허용 목록의 tab만 거치고 아무것도 쓰지 않음', () => {
  const env = harness({ readOnly: true });
  assert.deepEqual(env.tabs.map((b) => b.dataset.tab), ['want_to_go', 'visited']);
  assert.equal(env.tab(), 'visited');
  const end = env.drag(300, Y, 120, Y); // 다녀온 곳이 끝: 찜으로 가지 않음
  assert.equal(env.tab(), 'visited');
  assert.ok(!end.shown && end.tf === 'translateX(-36px)', JSON.stringify(end));
  const back = env.drag(90, Y, 260, Y);
  assert.equal(env.tab(), 'want_to_go');
  assert.ok(back.ready && back.text === '← 가고 싶은 곳', JSON.stringify(back));
  env.drag(90, Y, 260, Y); // 가고 싶은 곳에서 오른쪽: 끝
  assert.equal(env.tab(), 'want_to_go');
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'visited');
  assert.equal(env.state.visit.tab, 'visited', '읽기 전용 보기의 탭만 바뀜');
  assert.equal(env.state.tab, 'want_to_go', '내 방 탭은 그대로');
  assert.equal(env.state.visit.query, '라멘');
  assert.deepEqual(env.calls, ['render:want_to_go', 'render:visited']);
  assert.deepEqual(env.touched, [], '쓰기 통로(sb·fetch)를 건드림');
  // 카드 위에서 밀어도 상세가 안 열림 (그냥 누르면 열림: 'open'은 허용 목록에 있음)
  env.drag(90, Y, 260, Y, { target: env.inner });
  env.fire('click', { target: env.inner });
  assert.ok(!env.calls.some((c) => c.startsWith('openSheet')));
  env.advance(300);
  env.fire('click', { target: env.inner });
  assert.deepEqual(env.calls.slice(-2), ['openSheet:detail:p1', 'thumbs:p1']);
  assert.deepEqual(env.touched, []);
  assert.deepEqual(env.errors, []);
});

test('S10. 미는 도중 화면이 새로 그려지면(손가락 아래 카드가 문서에서 빠져 touchmove·touchend가 안 옴) 다음에 카드를 한 번 누르면 바로 열림', () => {
  // render()가 맨 앞에서 밀기를 지움 (새 목록·힌트는 쉬는 모습으로 새로 그려짐)
  assert.match(fnSource('render'), /^\nfunction render\(\) \{\n {2}swipe = null;[^\n]*\n/);
  const env = harness();
  env.fire('touchstart', { target: env.inner, touches: [{ clientX: 300, clientY: Y }] });
  env.fire('touchmove', { target: env.inner, touches: [{ clientX: 240, clientY: Y }] });
  assert.equal(env.area.style.transform, 'translateX(-60px)');
  const old = env.inner;
  // 예: 다른 사람이 장소를 올려 화면이 새로 그려짐. 이 가짜 render는 swipe를 지우지 않아서 touchstart 쪽 정리만으로도 되는지 봄
  env.ctx.render();
  assert.ok(!old.isConnected);
  env.fire('touchmove', { target: old, touches: [{ clientX: 120, clientY: Y }] }); // document까지 안 옴
  env.fire('touchend', { target: old, touches: [] });
  // 곧바로 새 목록의 카드를 짧게(60ms) 한 번 누름
  env.advance(30);
  env.fire('touchstart', { target: env.inner, touches: [{ clientX: 200, clientY: Y }] });
  env.advance(60);
  env.fire('touchend', { target: env.inner, touches: [] });
  assert.ok(!env.fire('click', { target: env.inner }).defaultPrevented, '첫 탭의 click을 버림');
  assert.deepEqual(env.calls, ['render:want_to_go', 'openSheet:detail:p1']);
  assert.equal(env.tab(), 'want_to_go');
  assert.equal(env.hint.style.opacity, '0');
  assert.deepEqual(env.errors, []);
});

test('S11. 미는 도중 목록 안만 새로 그려지면(목록 칸은 그대로) 비켜 있던 목록을 다음 손가락이 제자리로 돌리고, 그 탭도 열리고 다시 밀 수도 있음', () => {
  const env = harness();
  env.fire('touchstart', { target: env.inner, touches: [{ clientX: 300, clientY: Y }] });
  env.fire('touchmove', { target: env.inner, touches: [{ clientX: 220, clientY: Y }] });
  const old = env.inner;
  env.refreshList();
  env.fire('touchmove', { target: old, touches: [{ clientX: 120, clientY: Y }] });
  env.fire('touchend', { target: old, touches: [] });
  // 끝을 못 받아 목록이 비켜 있고 힌트도 떠 있음 (실제 브라우저와 같음)
  assert.equal(env.area.style.transform, 'translateX(-80px)');
  assert.ok(Number(env.hint.style.opacity) > 0);
  env.advance(1000);
  env.fire('touchstart', { target: env.inner, touches: [{ clientX: 200, clientY: Y }] });
  assert.equal(env.area.style.transform, '', '다음 손가락이 닿으면 제자리');
  assert.equal(env.area.style.opacity, '');
  assert.equal(env.hint.style.opacity, '0');
  env.fire('touchend', { target: env.inner, touches: [] });
  assert.ok(!env.fire('click', { target: env.inner }).defaultPrevented, '정리하면서 그 탭의 click을 버림');
  assert.deepEqual(env.calls, ['openSheet:detail:p1']);
  env.state.sheet = null;
  env.advance(300);
  env.drag(300, Y, 140, Y, { target: env.inner });
  assert.equal(env.tab(), 'visited', '정리한 뒤에도 밀어서 넘어감');
  assert.deepEqual(env.errors, []);
});

test('S12. 확대해서 보는 동안은 <html class="zoomed">: 목록 위에서도 손가락 하나로 옆으로 옮기기를 브라우저에 맡김(touch-action:auto)', () => {
  // 평소에는 pan-y pinch-zoom, 확대 중에는 auto (뒤에 있고 더 구체적이라 이김)
  const i = HTML.indexOf('#list-area{touch-action:pan-y pinch-zoom;min-height:55vh}'), j = HTML.indexOf('.zoomed #list-area{touch-action:auto}');
  assert.ok(i > 0 && j > i, '확대 중 touch-action:auto 규칙');
  const env = harness();
  assert.equal(env.vvListeners.resize.length, 1, '배율이 바뀔 때마다 다시 봄');
  assert.ok(!env.htmlClass.has('zoomed'), '처음엔 확대 아님');
  env.ctx.visualViewport.scale = 2;
  env.vvListeners.resize.forEach((f) => f());
  assert.ok(env.htmlClass.has('zoomed'));
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'want_to_go', '확대 중에는 밀어도 탭이 안 바뀜 (화면이 옆으로 옮겨짐)');
  assert.ok(!env.area.style.transform, '목록은 안 움직임');
  env.ctx.visualViewport.scale = 1.005; // 손가락을 다 벌렸다 오므려 거의 1로 돌아옴
  env.vvListeners.resize.forEach((f) => f());
  assert.ok(!env.htmlClass.has('zoomed'));
  env.drag(300, Y, 120, Y);
  assert.equal(env.tab(), 'visited');
  // visualViewport가 없는 브라우저: class는 안 붙고 밀기는 그대로
  const old = harness({ noViewport: true });
  assert.equal(old.htmlClass.size, 0);
  old.drag(300, Y, 120, Y);
  assert.equal(old.tab(), 'visited');
  assert.deepEqual([...env.errors, ...old.errors], []);
});
