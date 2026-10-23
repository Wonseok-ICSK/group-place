'use strict';
// 실제 화면 함수·이벤트를 VM에서 실행해 지연·오류·사용자 전환을 재현. 외부 네트워크 없음.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const submit = HTML.slice(HTML.indexOf("document.addEventListener('submit',"), HTML.indexOf('// 다른 앱에 갔다 돌아오면'));

function formContext({ duplicate = false, accept = true } = {}) {
  const handlers = {}, inserted = [], messages = [], confirmations = [];
  const button = { textContent: '저장' };
  const name = { value: '시험 장소' };
  const form = { id: 'place-form', isConnected: true, dataset: {}, naver_url: { value: 'https://maps.app.goo.gl/test' }, address: { value: '' },
    category: { value: '기타' }, status: { value: 'want_to_go' }, shared_note: { value: '' }, photo: { files: [] },
    querySelector: () => button, elements: { namedItem: (n) => n === 'name' ? name : null } };
  const toastEl = { textContent: '', classList: { remove() {} } };
  const state = { roomId: 'A', sheet: { type: 'add' }, places: duplicate ? [{ name: ' 시험  장소 ', address: null }] : [] };
  const ctx = {
    document: { addEventListener: (n, f) => { handlers[n] = f; } }, state, ro: () => false, $: () => toastEl,
    busy: async (b, f) => f(), field: (f, n) => f.elements.namedItem(n), cleanUrl: (x) => x, safeUrl: (x) => x,
    isGoogleMaps: () => true, isShareText: () => false, fillEmpty: () => [], fillFromGoogle() {}, googleJob: null,
    toast: (s) => { messages.push(s); toastEl.textContent = s; }, uid: () => 'u', friendly: (e) => e.message,
    placeKey: (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(),
    confirm: (s) => { confirmations.push(s); return accept; }, refresh: async () => {}, openSheet() {}, dropAddForm() {},
    setTimeout, clearTimeout, AbortController,
    sb: { from: () => ({ insert: (r) => { inserted.push(r); return { select: () => ({ single: async () => ({ data: { id: 'p' }, error: null }) }) }; } }) },
  };
  vm.createContext(ctx);
  return { ctx, handlers, form, inserted, messages, confirmations };
}

test('V023 화면: 지도 조회가 세션 확인에 걸린 뒤 취소·방 전환해도 다른 방으로 저장하지 않음', async () => {
  const x = formContext();
  let release;
  const tokenReady = new Promise((r) => { release = r; });
  x.ctx.sb.auth = { getSession: async () => { await tokenReady; return { data: { session: { access_token: 'test' } } }; } };
  x.ctx.fetch = async (u, o) => { if (o.signal.aborted) throw new Error('aborted'); return { ok: true, json: async () => ({}) }; };
  // 실제 선언을 읽으므로 가짜 객체의 googleJob 대신 소스의 lexical 상태를 사용한다.
  delete x.ctx.googleJob;
  vm.runInContext(HTML.slice(HTML.indexOf('async function googlePlace('), HTML.indexOf('const GOOGLE_WAIT')), x.ctx);
  vm.runInContext(HTML.slice(HTML.indexOf('const GOOGLE_WAIT'), HTML.indexOf('/* ---------- 시트: 장소 상세')), x.ctx);
  vm.runInContext(submit, x.ctx);
  const work = x.handlers.submit({ preventDefault() {}, target: x.form });
  await Promise.resolve();
  x.ctx.cancelGoogle(); x.form.isConnected = false; x.ctx.state.sheet = null; x.ctx.state.roomId = 'B';
  release(); await work;
  assert.equal(x.inserted.length, 0);
  assert.ok(x.messages.includes('save_context_changed'));
});

test('V023 화면: 일반 장소 추가의 중복 확인을 취소하면 쓰지 않고, 확인하면 원래 방에 추가', async () => {
  for (const accept of [false, true]) {
    const x = formContext({ duplicate: true, accept });
    vm.runInContext(submit, x.ctx);
    await x.handlers.submit({ preventDefault() {}, target: x.form });
    assert.equal(x.confirmations.length, 1);
    assert.equal(x.inserted.length, accept ? 1 : 0);
    if (accept) assert.equal(x.inserted[0].couple_id, 'A');
  }
});

test('V023 화면: 썸네일 502 뒤 재시도 가능, 성공 응답은 캐시', async () => {
  let calls = 0;
  const p = { id: 'p', photos: [{ thumb: 'first' }, { thumb: '' }] };
  const ctx = { state: { visit: { key: 'abcdefgh23', status: 'ok', places: [p], thumbsAsked: new Map(), thumbs: new Map() } },
    THUMB_KEEP_MS: 25 * 60e3, Date, encodeURIComponent, imgUrl: (x) => x, keepThumbs() {}, $: () => null,
    getPublic: async () => (++calls === 1 ? { ok: false, status: 502 } : { ok: true, body: { thumbs: ['first', 'second'] } }) };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(HTML.indexOf('async function loadVisitThumbs('), HTML.indexOf('/* 읽기 전용 보기 열기·닫기')), ctx);
  await ctx.loadVisitThumbs('p');
  assert.equal(ctx.state.visit.thumbsAsked.has('p'), false);
  await ctx.loadVisitThumbs('p'); await ctx.loadVisitThumbs('p');
  assert.equal(calls, 2);
  assert.equal(ctx.state.visit.thumbs.get('p|1').url, 'second');
});

test('V023 화면: 후기 저장 중 다른 상세를 열어도 새로 작성 중인 별점·방문 선택을 지우지 않음', async () => {
  let click, release;
  const sent = [];
  const saved = new Promise((r) => { release = r; });
  const state = { sheet: { id: 'place-A' }, editVisit: 'new', draftRating: 4.5 };
  const ctx = { document: { addEventListener: (n, f) => { click = f; } }, state, ro: () => false,
    curPlaces: () => [{ id: 'place-A', visits: [] }], busy: async (b, f) => f(), toast() {}, friendly: (e) => e.message,
    $: (s) => ({ value: s === '#visit-date' ? '2026-10-23' : '작성한 후기' }), refresh: async () => {},
    editIdOf: () => 'new', draftKey: () => 'draft-A', readDraft: () => null,
    serverReview: () => ({ day: '', rating: 0, body: '' }), reviewMovedOn: () => false, dropDraft() {},
    sb: { rpc: async (name, body) => { sent.push({ name, body }); await saved; return { error: null }; } } };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(HTML.indexOf("document.addEventListener('click',"), HTML.indexOf('// 사진을 옆으로 밀 때 번호')), ctx);
  const work = click({ target: { closest: () => ({ dataset: { action: 'save-visit' } }) } });
  await Promise.resolve();
  state.sheet = { id: 'place-B' }; state.editVisit = 'visit-B'; state.draftRating = 1.5;
  release(); await work;
  assert.equal(sent[0].name, 'save_visit_review');
  assert.equal(sent[0].body.p_place, 'place-A');
  assert.equal(state.editVisit, 'visit-B');
  assert.equal(state.draftRating, 1.5);
});
