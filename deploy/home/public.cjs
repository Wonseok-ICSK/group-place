// 친구용 홈 서버: 공개 방 둘러보기 API (docs/public-rooms-design.md §3).
//   GET /api/public/rooms                               둘러보기 목록 → { v: 1, rooms: [...] }
//   GET /api/public/rooms/<공개 키>                      방 하나(읽기 전용) → { v: 1, key, name, …, places: [...] }
//   GET /api/public/rooms/<공개 키>/thumbs?place=        장소 하나의 썸네일(최대 3장) 서명 URL → { v: 1, thumbs: [url|null], photos_paused }
//   GET /api/public/rooms/<공개 키>/photo?place=&i=0-2   큰 사진 하나의 10분 서명 URL → { url }
// 지금은 로그인한 사람만 본다(Authorization: Bearer <로그인 토큰>). allowAnonymous는 나중(§10)을 위한 자리이고
// server.cjs는 늘 false로 만든다. DB는 secret key로 public_room_list·public_room_view(public.sql)만 부른다.
// 지키는 것:
//   - 응답은 허용 목록으로 키를 하나씩 옮겨 담는다(pickListItem·pickRoom). SQL이 실수로 초대 코드·찜·uuid를 넣어도 나가지 않는다.
//     지도 링크는 아는 지도 주소(네이버·구글·카카오)만, 사진은 무작위 파일 이름(업로드 시각이 없는 것)만 내보낸다.
//   - 저장소 경로는 화면에 보내지 않고 서명 URL만 보낸다(썸네일 1시간, 큰 사진 10분). 방 응답에는 장소마다 대표 썸네일 하나만,
//     나머지 썸네일은 상세를 열 때 /thumbs로.
//   - 사진 한도(하루·사람마다·월 추정 바이트)를 파일에 저장해 다시 시작해도 이어서 센다. 같은 사람이 같은 썸네일을 그날 다시 보면
//     세지 않는다. 사람과 경로는 날마다 바뀌는 salt의 해시로만 남긴다.
//   - 횟수 제한(분당): 목록 20·방 30·썸네일 60·큰 사진 20(사람마다, IP마다 따로), 공개 API 전체 300. 로그인 토큰이 없는 요청은
//     횟수를 세기 전에 401로 끝낸다(전체 몫을 쓰지 못하게).
//   - 로그에는 종류와 결과만 남긴다. 공개 키·사용자·토큰·IP는 남기지 않고, 누가 어떤 방을 봤는지도 남기지 않는다.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createLimiter, clientIp, ipKey, call, bearer, adminHeaders, MSG } = require('./signup.cjs');

const KEY_RE = /^[a-km-np-z2-9]{10}$/; // couples.public_key (초대 코드 ^[0-9A-F]{8}$와 글자 모음·길이가 다름)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MEMBER_RE = /^m[1-5]$/;
const COLOR_RE = /^(#[0-9a-f]{6}|[a-z]{1,20})$/; // 팔레트 id 또는 #rrggbb (colors.sql couple_members_color_check)
// 사진 경로: '<장소 uuid>/[t/]<randomUUID 또는 16바이트 16진수>.jpg'(화면 photoId()가 만드는 이름)만.
// v0.1.2 화면이 만들던 '<장소>/<Date.now()>-<i>.jpg'는 서명 URL에 업로드 시각이 드러나므로 내보내지 않음(회색 자리)
const PATH_RE = /^[0-9a-f-]{36}\/(t\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.jpg$/;
// 지도 링크로 받는 곳: 네이버 지도·플레이스, 구글 지도, 카카오맵. 그 밖의 주소는 null(화면은 네이버 지도 검색 링크로)
const MAP_HOST_RE = /^(naver\.me|(m\.)?map\.naver\.com|(m\.|pcmap\.)?place\.naver\.com|maps\.app\.goo\.gl|kko\.to|(place\.|m\.)?map\.kakao\.com)$/;
const GOOGLE_HOST_RE = /^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const ACTIVE = new Set(['week', 'month', 'older']); // 마지막 활동: 7일 안·31일 안·그 전 (날짜 수는 보내지 않음)
const STATUSES = new Set(['want_to_go', 'visited']);
const BUCKET = 'place-photos';
const MAX_PLACES = 300;
const MAX_PHOTOS = 3;
const BUDGET_FILE = 'public-budget.json';
const KST_MS = 9 * 3600_000;

const DEFAULTS = {
  ttl: { room: 120_000, list: 60_000, token: 60_000 },
  cacheChars: 8 * 1024 * 1024, // 캐시 합계(JSON 글자 수 + 항목마다 키 길이 + 128)
  cacheEntries: 2000, // 캐시 항목 수 (없는 방 결과가 쌓여도 이 이상은 두지 않음)
  tokenCacheMax: 500,
  rate: { list: 20, room: 30, thumbs: 60, photo: 20, total: 300, windowMs: 60_000 },
  // 월 1GB에서 거꾸로(아이디어 문서 8장): 썸네일 25KB·큰 사진 200KB로 셈. anonThumbs는 로그인 없는 사람의 하루 썸네일(기본 0 = 사진 없음)
  budget: { dayThumbs: 800, dayLarge: 60, userThumbs: 200, userLarge: 20, monthBytes: 1_000_000_000, thumbBytes: 25_000, largeBytes: 200_000, anonThumbs: 0 },
  sign: { thumbSec: 3600, largeSec: 600, reuseMs: 30 * 60_000, batch: 100, cacheMax: 5000 },
  jsonWarnBytes: 200 * 1024 * 1024,
  saveEveryMs: 60_000,
};

const PMSG = {
  login: MSG.login,
  gone: '이 공개 방을 찾을 수 없어요.',
  photoGone: '사진을 찾을 수 없어요.',
  budgetDay: '오늘은 사진 보기가 멈췄어요. 내일 다시 보여요.',
  budgetMonth: '이번 달은 사진 보기가 멈췄어요. 다음 달에 다시 보여요.',
  photosOff: '지금은 사진을 볼 수 없어요.',
  down: '지금은 공개 방을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.',
  tooMany: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  bad: '요청 형식이 올바르지 않아요',
  notFound: '찾을 수 없어요',
  method: 'GET만 받아요',
};

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// ---------- 시간 (KST) ----------
const kstIso = (t) => new Date(t + KST_MS).toISOString();
const kstDay = (t) => kstIso(t).slice(0, 10);
const kstMonth = (t) => kstIso(t).slice(0, 7);
// KST 다음 자정까지 초 / 다음 달 1일 0시까지 초
function secondsToKstMidnight(t) {
  const k = t + KST_MS;
  return Math.max(1, Math.ceil((Math.floor(k / 86_400_000) * 86_400_000 + 86_400_000 - k) / 1000));
}
function secondsToKstNextMonth(t) {
  const d = new Date(t + KST_MS);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - (t + KST_MS)) / 1000));
}

// ---------- 허용 목록 (SQL 결과를 키 하나씩 새 객체로) ----------
const str = (v) => (typeof v === 'string' ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const color = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v : null);
const member = (v) => (typeof v === 'string' && MEMBER_RE.test(v) ? v : null);
const month = (v) => (typeof v === 'string' && MONTH_RE.test(v) ? v : null);
const rating = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 5 ? v : null);
// 지도 링크: 아는 지도 주소만(공개 방에서는 남이 넣은 링크라, 낚시 주소가 '네이버 지도에서 보기'로 보이지 않게). https로 바꿔 돌려줌
function mapUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  const h = u.hostname;
  const ok = MAP_HOST_RE.test(h) || (h === 'goo.gl' && /^\/maps(\/|$)/.test(u.pathname))
    || (GOOGLE_HOST_RE.test(h) && (h.startsWith('maps.') || /^\/maps(\/|$)/.test(u.pathname)));
  if (!ok) return null;
  u.protocol = 'https:';
  return u.href.length <= 2000 ? u.href : null;
}
const active = (v) => (ACTIVE.has(v) ? v : null);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

// 둘러보기 목록 원소 (§2.6, 키 9개). 공개 키가 형식에 안 맞으면 원소째 버림(링크를 못 만듦)
function pickListItem(r) {
  if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !KEY_RE.test(r.key)) return null;
  return {
    key: r.key,
    name: str(r.name) ?? '',
    description: str(r.description) ?? '',
    member_count: count(r.member_count),
    colors: arr(r.colors, 5).map(color),
    place_count: count(r.place_count),
    visited_count: count(r.visited_count),
    review_count: count(r.review_count),
    active: active(r.active),
  };
}

// 사진 경로: 그 장소 폴더 안의 무작위 이름만(썸네일은 '<장소>/t/…', 큰 사진은 '<장소>/…'). 아니면 null
function photoPath(v, placeId, thumb) {
  if (typeof v !== 'string' || !PATH_RE.test(v)) return null;
  const inThumbs = v.startsWith(`${placeId}/t/`);
  return v.startsWith(`${placeId}/`) && inThumbs === thumb ? v : null;
}

// 방 하나 (§2.6 public_room_view) → 서버 안에서 쓰는 모양(사진 경로 포함). 모양이 틀리면 null
function pickRoom(r, wantKey) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.key !== wantKey || !KEY_RE.test(r.key)) return null;
  return {
    key: r.key,
    name: str(r.name) ?? '',
    description: str(r.description) ?? '',
    member_count: count(r.member_count),
    place_count: count(r.place_count),
    truncated: r.truncated === true,
    active: active(r.active),
    members: arr(r.members, 5).map((m) => ({ m: member(m && m.m), name: str(m && m.name) ?? '', color: color(m && m.color) })),
    categories: arr(r.categories, 100).filter((c) => typeof c === 'string'),
    places: arr(r.places, MAX_PLACES).filter((p) => p && typeof p === 'object').map((p) => {
      const id = typeof p.id === 'string' && UUID_RE.test(p.id) ? p.id : null;
      return {
        id,
        name: str(p.name) ?? '',
        category: str(p.category),
        address: str(p.address),
        map_url: mapUrl(p.map_url),
        status: STATUSES.has(p.status) ? p.status : null,
        shared_note: str(p.shared_note),
        added_month: month(p.added_month),
        added_by: member(p.added_by),
        visits: arr(p.visits, 1000).map((v) => ({
          month: month(v && v.month),
          reviews: arr(v && v.reviews, 10).map((x) => ({ by: member(x && x.by), rating: rating(x && x.rating), body: str(x && x.body) })),
        })),
        photo_count: count(p.photo_count),
        // 경로는 서버 안에서만(서명용). 장소 id가 이상하면 사진 경로를 확인할 수 없으니 자리만 남김
        photos: arr(p.photos, MAX_PHOTOS).map((ph) => ({
          path: id ? photoPath(ph && ph.path, id, false) : null,
          thumb: id ? photoPath(ph && ph.thumb, id, true) : null,
        })),
      };
    }),
  };
}

// 서버 안 모양 → 화면에 보낼 모양(§3.5). thumbUrls: 썸네일 경로 → URL(없으면 null).
// 방 응답에는 장소마다 대표(첫) 썸네일만 넣고, 2·3번째는 늘 null(상세를 열 때 /thumbs로 받음)
function publicRoom(room, thumbUrls, photosPaused) {
  return {
    v: 1,
    key: room.key,
    name: room.name,
    description: room.description,
    member_count: room.member_count,
    place_count: room.place_count,
    truncated: room.truncated,
    active: room.active,
    photos_paused: !!photosPaused,
    members: room.members.map((m) => ({ m: m.m, name: m.name, color: m.color })),
    categories: room.categories.slice(),
    places: room.places.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      address: p.address,
      map_url: p.map_url,
      status: p.status,
      shared_note: p.shared_note,
      added_month: p.added_month,
      added_by: p.added_by,
      visits: p.visits.map((v) => ({ month: v.month, reviews: v.reviews.map((x) => ({ by: x.by, rating: x.rating, body: x.body })) })),
      photo_count: p.photo_count,
      photos: p.photos.map((ph, i) => ({ thumb_url: (i === 0 && ph.thumb && thumbUrls.get(ph.thumb)) || null })),
    })),
  };
}

// ---------- 캐시 ----------
// 글자 수 합계와 항목 수로 자르는 LRU. 값은 { value, size, exp }
function createLru(maxChars, maxEntries = DEFAULTS.cacheEntries) {
  const m = new Map();
  let total = 0;
  const drop = (k) => {
    const e = m.get(k);
    if (e) { total -= e.size; m.delete(k); }
  };
  return {
    get(k, t) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp <= t) { drop(k); return undefined; }
      m.delete(k);
      m.set(k, e);
      return e.value;
    },
    set(k, value, size, exp) {
      drop(k);
      if (size > maxChars) return;
      m.set(k, { value, size, exp });
      total += size;
      for (const key of m.keys()) {
        if (total <= maxChars && m.size <= maxEntries) break;
        drop(key);
      }
    },
    clear() { m.clear(); total = 0; },
    get size() { return total; },
    get count() { return m.size; },
  };
}

// ---------- 사진 한도 (파일에 저장) ----------
// 파일: { v:1, day, month, salt, thumbs, large, anon, bytes, users: { <sha256(salt+uid) 앞 16자>: [썸네일, 큰 사진] },
//         seen: [<sha256(salt|uid|썸네일 경로) 앞 16자>, …] }
// seen = 오늘 이미 센 (사람, 썸네일) 짝. 같은 사람이 같은 썸네일을 다시 받으면 세지 않는다(다시 열기·다른 앱에 다녀오기).
// 하루 썸네일 한도만큼만 쌓이고(센 것만 들어감) 날이 바뀌면 salt와 함께 비운다. 로그인 없는 사람(uid null)은 늘 셈
const SEEN_MAX = 50_000;
function createBudget({ dir = '', now = Date.now, log = console.log, limits = DEFAULTS.budget } = {}) {
  const L = { ...DEFAULTS.budget, ...limits };
  const file = dir ? path.join(dir, BUDGET_FILE) : '';
  let st;
  let seen = new Set();
  let dirty = false;
  let saveFailed = false;
  const salt = () => crypto.randomBytes(16).toString('hex');
  function fresh(t, halfUsed = false) {
    const thumbs = halfUsed ? Math.floor(L.dayThumbs / 2) : 0;
    const large = halfUsed ? Math.floor(L.dayLarge / 2) : 0;
    return { v: 1, day: kstDay(t), month: kstMonth(t), salt: salt(), thumbs, large, anon: 0, bytes: thumbs * L.thumbBytes + large * L.largeBytes, users: {} };
  }
  const n = (v) => Number.isInteger(v) && v >= 0;
  function valid(j) {
    if (!j || typeof j !== 'object' || j.v !== 1) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.day) || !MONTH_RE.test(j.month) || !/^[0-9a-f]{16,64}$/.test(j.salt)) return false;
    if (!n(j.thumbs) || !n(j.large) || !n(j.bytes) || (j.anon !== undefined && !n(j.anon))) return false;
    if (!j.users || typeof j.users !== 'object' || Array.isArray(j.users)) return false;
    if (j.seen !== undefined && !(Array.isArray(j.seen) && j.seen.length <= SEEN_MAX && j.seen.every((k) => typeof k === 'string' && /^[0-9a-f]{16}$/.test(k)))) return false;
    return Object.entries(j.users).every(([k, v]) => /^[0-9a-f]{16}$/.test(k) && Array.isArray(v) && v.length === 2 && n(v[0]) && n(v[1]));
  }
  // 날·달이 바뀌었으면 새로: 날 → 하루 수·사람·본 썸네일·salt, 달 → 바이트도
  function roll(t) {
    const day = kstDay(t);
    if (st.day === day) return;
    const keepBytes = st.month === kstMonth(t) ? st.bytes : 0;
    st = { ...fresh(t), bytes: keepBytes };
    seen = new Set();
    dirty = true;
  }
  function load() {
    const t = now();
    st = fresh(t);
    if (!file) { log('public budget memory_only'); return; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return;
      log('public budget read_fail');
      st = fresh(t, true);
      dirty = true;
      return;
    }
    let j = null;
    try { j = JSON.parse(text); } catch { j = null; }
    if (!valid(j)) {
      // 깨진 파일: 그날 한도는 안전한 쪽으로 반만 남은 것으로 시작
      log('public budget file_broken');
      st = fresh(t, true);
      dirty = true;
      return;
    }
    st = { v: 1, day: j.day, month: j.month, salt: j.salt, thumbs: j.thumbs, large: j.large, anon: j.anon || 0, bytes: j.bytes, users: { ...j.users } };
    seen = new Set(j.seen || []);
    roll(t);
  }
  const hash = (text) => crypto.createHash('sha256').update(st.salt + text).digest('hex').slice(0, 16);
  const userKey = (uid) => hash(uid);
  const seenKey = (uid, p) => hash(`|${uid}|${p}`);
  const mine = (uid) => st.users[userKey(uid)] || [0, 0];
  const monthLeft = (each) => Math.max(0, Math.floor((L.monthBytes - st.bytes) / each));
  // 새로 셀 수 있는 썸네일 수 (uid가 null이면 로그인 없는 사람)
  function thumbsAllowed(uid) {
    roll(now());
    const who = uid === null ? L.anonThumbs - st.anon : L.userThumbs - mine(uid)[0];
    return Math.max(0, Math.min(L.dayThumbs - st.thumbs, who, monthLeft(L.thumbBytes)));
  }
  // 이 사람이 오늘 이미 센 썸네일인지 (로그인 없는 사람은 늘 false)
  function isSeen(uid, p) {
    roll(now());
    return uid !== null && seen.has(seenKey(uid, p));
  }
  // 썸네일 세기: 경로 배열이면 오늘 처음 받는 것만 세고 기억함, 숫자면 그만큼 셈
  function addThumbs(uid, what) {
    roll(now());
    let k = 0;
    if (Array.isArray(what)) {
      for (const p of what) {
        if (uid !== null) {
          const key = seenKey(uid, p);
          if (seen.has(key)) continue;
          if (seen.size < SEEN_MAX) seen.add(key);
        }
        k++;
      }
    } else k = what;
    if (!k) return 0;
    st.thumbs += k;
    st.bytes += k * L.thumbBytes;
    if (uid === null) st.anon += k;
    else { const u = mine(uid); st.users[userKey(uid)] = [u[0] + k, u[1]]; }
    dirty = true;
    return k;
  }
  // 큰 사진 하나: 되면 { wait: 0 }, 안 되면 다시 해 볼 때까지 초와 이유(월 바이트가 다 찼으면 month: true)
  function largeWait(uid) {
    const t = now();
    roll(t);
    if (monthLeft(L.largeBytes) < 1) return { wait: secondsToKstNextMonth(t), month: true };
    if (st.large >= L.dayLarge || mine(uid)[1] >= L.userLarge) return { wait: secondsToKstMidnight(t), month: false };
    return { wait: 0, month: false };
  }
  function addLarge(uid) {
    roll(now());
    st.large += 1;
    st.bytes += L.largeBytes;
    const u = mine(uid);
    st.users[userKey(uid)] = [u[0], u[1] + 1];
    dirty = true;
  }
  const state = () => ({ ...st, seen: [...seen] });
  // 임시 파일 → rename (권한 0600). 실패해도 서버는 계속(로그 한 번)
  function save() {
    if (!file || !dirty) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state()), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
      saveFailed = false;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* 없으면 그대로 */ }
      if (!saveFailed) log('public budget save_fail');
      saveFailed = true;
    }
  }
  load();
  return { thumbsAllowed, isSeen, addThumbs, largeWait, addLarge, save, snapshot: () => JSON.parse(JSON.stringify(state())), file };
}

// ---------- API ----------
function createPublicApi({
  supabaseUrl, publishableKey, secretKey, fetchImpl = fetch, now = Date.now, log = console.log,
  photos = true, allowAnonymous = false, isReady = () => true, stateDir = '',
  ttl = {}, rate = {}, budget: budgetLimits = {}, sign: signOpts = {}, cacheChars = DEFAULTS.cacheChars,
  cacheEntries = DEFAULTS.cacheEntries, jsonWarnBytes = DEFAULTS.jsonWarnBytes, saveEveryMs = DEFAULTS.saveEveryMs,
}) {
  if (!supabaseUrl || !publishableKey || !secretKey) throw new Error('createPublicApi: 설정이 비어 있어요');
  const T = { ...DEFAULTS.ttl, ...ttl };
  const R = { ...DEFAULTS.rate, ...rate };
  const S = { ...DEFAULTS.sign, ...signOpts };
  const admin = adminHeaders(secretKey);
  const rest = (p) => `${supabaseUrl}/rest/v1/${p}`;
  const budget = createBudget({ dir: stateDir, now, log, limits: budgetLimits });
  const timer = saveEveryMs > 0 ? setInterval(() => budget.save(), saveEveryMs) : null;
  if (timer && timer.unref) timer.unref();

  // 횟수 제한: 전체 하나 + 종류마다 IP·사람
  const all = createLimiter({ perIp: R.total, total: R.total, windowMs: R.windowMs, now });
  const lim = {};
  for (const kind of ['list', 'room', 'thumbs', 'photo']) {
    lim[kind] = {
      ip: createLimiter({ perIp: R[kind], total: Infinity, windowMs: R.windowMs, now }),
      user: createLimiter({ perIp: R[kind], total: Infinity, windowMs: R.windowMs, now }),
    };
  }

  const cache = createLru(cacheChars, cacheEntries);
  const inflight = new Map();
  const tokens = new Map(); // sha256(토큰) → { uid, exp }
  const thumbCache = new Map(); // 썸네일 경로 → { url, exp }
  let jsonDay = '';
  let jsonBytes = 0;
  let jsonWarned = false;

  function send(res, status, body, extra = {}, head = false) {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...HEADERS, 'cache-control': status === 200 ? 'private, max-age=60' : 'no-store', ...extra });
    res.end(head ? undefined : text);
    if (head) return;
    // 하루 보낸 JSON 바이트: 200MB를 넘으면 경고 한 번 (세다가 실패해도 응답은 이미 보냄)
    try {
      const day = kstDay(now());
      if (day !== jsonDay) { jsonDay = day; jsonBytes = 0; jsonWarned = false; }
      jsonBytes += Buffer.byteLength(text);
      if (jsonBytes > jsonWarnBytes && !jsonWarned) { jsonWarned = true; log('public json over 200MB today'); }
    } catch { /* 세기만 못 함 */ }
  }

  // 로그인 토큰 → 사용자 id. 맞지 않으면 '', 확인하지 못하면 null. 60초 캐시(토큰 원문은 두지 않음)
  async function userOf(token) {
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const t = now();
    const hit = tokens.get(h);
    if (hit && hit.exp > t) return hit.uid;
    if (hit) tokens.delete(h);
    let r;
    try {
      r = await call(fetchImpl, `${supabaseUrl}/auth/v1/user`, { headers: { apikey: publishableKey, authorization: `Bearer ${token}` } });
    } catch { return null; }
    let uid = null;
    if (r.ok && r.json && typeof r.json.id === 'string' && r.json.id) uid = r.json.id;
    else if (r.status === 401 || r.status === 403 || r.status === 404) uid = '';
    if (uid === null) return null;
    tokens.set(h, { uid, exp: t + T.token });
    while (tokens.size > DEFAULTS.tokenCacheMax) tokens.delete(tokens.keys().next().value);
    return uid;
  }

  // 같은 것을 동시에 여러 번 부르지 않게 묶음. 실패(throw)는 캐시하지 않음
  async function cached(key, ttlMs, load) {
    const hit = cache.get(key, now());
    if (hit !== undefined) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const value = await load();
      // 크기 = JSON 글자 수 + 키 + 항목마다 붙는 몫(128). 없는 방(null)도 항목 하나로 셈
      cache.set(key, value, (value === null ? 0 : JSON.stringify(value).length) + key.length + 128, now() + ttlMs);
      return value;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }
  async function rpc(fn, args) {
    const r = await call(fetchImpl, rest(`rpc/${fn}`), { method: 'POST', headers: admin, body: args });
    if (!r.ok) { const e = new Error(`rpc ${r.status}`); e.rpc = true; throw e; }
    return r.json;
  }
  const loadList = () => cached('list', T.list, async () => {
    const j = await rpc('public_room_list', {});
    if (!Array.isArray(j)) throw new Error('shape');
    return j.slice(0, 50).map(pickListItem).filter(Boolean);
  });
  const loadRoom = (key) => cached(`room:${key}`, T.room, async () => {
    const j = await rpc('public_room_view', { p_key: key });
    if (j === null) return null;
    const room = pickRoom(j, key);
    if (!room) throw new Error('shape');
    return room;
  });

  const signedUrl = (rel) => (typeof rel === 'string' && rel.startsWith('/object/sign/') ? `${supabaseUrl}/storage/v1${rel}` : null);
  // 썸네일 서명 (1시간). 30분 이상 남은 URL은 다시 씀. → Map(경로 → URL), 못 한 경로는 빠짐
  async function signThumbs(paths) {
    const out = new Map();
    const t = now();
    const need = [];
    for (const p of paths) {
      const hit = thumbCache.get(p);
      if (hit && hit.exp - t >= S.reuseMs) out.set(p, hit.url);
      else if (!need.includes(p)) need.push(p);
    }
    for (let i = 0; i < need.length; i += S.batch) {
      const part = need.slice(i, i + S.batch);
      let r;
      try {
        r = await call(fetchImpl, `${supabaseUrl}/storage/v1/object/sign/${BUCKET}`, { method: 'POST', headers: admin, body: { expiresIn: S.thumbSec, paths: part } });
      } catch { r = null; }
      if (!r || !r.ok || !Array.isArray(r.json)) { log('public sign fail'); continue; }
      for (const x of r.json) {
        if (!x || typeof x.path !== 'string' || !part.includes(x.path) || x.error) continue;
        const url = signedUrl(x.signedURL || x.signedUrl);
        if (!url) continue;
        out.set(x.path, url);
        thumbCache.set(x.path, { url, exp: t + S.thumbSec * 1000 });
      }
    }
    if (thumbCache.size > S.cacheMax) {
      for (const [k, v] of thumbCache) if (v.exp - t < S.reuseMs) thumbCache.delete(k);
      while (thumbCache.size > S.cacheMax) thumbCache.delete(thumbCache.keys().next().value);
    }
    return out;
  }
  async function signLarge(p) {
    const enc = p.split('/').map(encodeURIComponent).join('/');
    let r;
    try {
      r = await call(fetchImpl, `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${enc}`, { method: 'POST', headers: admin, body: { expiresIn: S.largeSec } });
    } catch { return null; }
    return r.ok && r.json ? signedUrl(r.json.signedURL || r.json.signedUrl) : null;
  }

  // 썸네일 서명과 세기: 이 사람이 오늘 이미 받은 썸네일은 세지 않고 다시 주고, 처음 받는 것은 남은 한도만큼만(순서대로).
  // 못 준 것이 있으면 paused. 실제로 서명된 것만 셈
  async function grantThumbs(wanted, uid) {
    const paths = [...new Set(wanted)];
    if (!paths.length) return { urls: new Map(), paused: false };
    if (!photos) return { urls: new Map(), paused: true };
    const fresh = paths.filter((p) => !budget.isSeen(uid, p));
    const take = new Set(fresh.slice(0, budget.thumbsAllowed(uid)));
    const toSign = paths.filter((p) => take.has(p) || !fresh.includes(p));
    const urls = toSign.length ? await signThumbs(toSign) : new Map();
    budget.addThumbs(uid, [...take].filter((p) => urls.has(p)));
    return { urls, paused: take.size < fresh.length };
  }
  // 방 응답의 썸네일: 장소마다 대표(첫) 썸네일만
  async function roomThumbs(room, uid, head) {
    if (head) return { urls: new Map(), paused: false };
    return grantThumbs(room.places.map((p) => p.photos[0] && p.photos[0].thumb).filter(Boolean), uid);
  }

  const ROUTE_RE = /^\/api\/public\/rooms(?:\/([^/]+)(\/photo|\/thumbs)?)?\/?$/;

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = ROUTE_RE.exec(url.pathname);
    const kind = !route ? '' : !route[1] ? 'list' : route[2] === '/photo' ? 'photo' : route[2] === '/thumbs' ? 'thumbs' : 'room';
    const head = req.method === 'HEAD';
    const getOnly = kind === 'photo' || kind === 'thumbs'; // 서명하고 한도를 쓰는 것은 GET만
    if (req.method !== 'GET' && !(head && !getOnly)) {
      return send(res, 405, { error: PMSG.method }, { allow: getOnly ? 'GET' : 'GET, HEAD' });
    }
    if (!isReady()) return send(res, 503, { error: PMSG.down }, { 'retry-after': '60' });
    if (!route) return send(res, 404, { error: PMSG.notFound });
    const key = route[1] || '';
    if (key && !KEY_RE.test(key)) { log(`public ${kind} 404`); return send(res, 404, { error: PMSG.gone }); }
    let placeId = '';
    let index = 0;
    if (kind === 'photo' || kind === 'thumbs') {
      placeId = url.searchParams.get('place') || '';
      if (!UUID_RE.test(placeId)) return send(res, 400, { error: PMSG.bad });
    }
    if (kind === 'photo') {
      const i = url.searchParams.get('i') || '';
      if (!/^[0-2]$/.test(i)) return send(res, 400, { error: PMSG.bad });
      index = Number(i);
    }
    // 로그인 토큰이 없으면 횟수를 세기 전에 401 (위로 가는 요청이 없고, 토큰 없는 요청이 전체 몫을 쓰지 못하게).
    // 지금은 늘 여기(로그인한 사람만). allowAnonymous여도 큰 사진은 로그인한 사람만
    const token = bearer(req);
    if (!token && (!allowAnonymous || kind === 'photo')) {
      log(`public ${kind} 401`);
      return send(res, 401, { error: PMSG.login, login: true });
    }
    // IP 횟수 (전체 300을 먼저, IP에서 막히면 전체 한 번은 돌려줌)
    const ip = ipKey(clientIp(req));
    const g = all('all');
    if (!g.ok) { log(`public ${kind} limited:global`); return send(res, 429, { error: PMSG.tooMany }, { 'retry-after': String(g.retryAfter) }); }
    const gi = lim[kind].ip(ip);
    if (!gi.ok) { g.refund(); log(`public ${kind} limited:ip`); return send(res, 429, { error: PMSG.tooMany }, { 'retry-after': String(gi.retryAfter) }); }
    // 로그인 확인. 틀린 토큰·확인 실패는 전체 몫을 돌려줌(IP 몫은 그대로 셈)
    let uid = null;
    if (token) {
      uid = await userOf(token);
      if (uid === null) { g.refund(); log(`public ${kind} fail:user`); return send(res, 502, { error: PMSG.down }); }
      if (!uid) { g.refund(); log(`public ${kind} 401`); return send(res, 401, { error: PMSG.login, login: true }); }
      const gu = lim[kind].user(uid);
      if (!gu.ok) { log(`public ${kind} limited:user`); return send(res, 429, { error: PMSG.tooMany }, { 'retry-after': String(gu.retryAfter) }); }
    }

    try {
      if (kind === 'list') {
        const rooms = await loadList();
        log('public list ok');
        return send(res, 200, { v: 1, rooms: rooms.map((r) => ({ ...r, colors: r.colors.slice() })) }, {}, head);
      }
      if (kind === 'room') {
        const room = await loadRoom(key);
        if (!room) { log('public view 404'); return send(res, 404, { error: PMSG.gone }); }
        const { urls, paused } = await roomThumbs(room, uid, head);
        log('public view ok');
        return send(res, 200, publicRoom(room, urls, paused), {}, head);
      }
      if (kind === 'thumbs') {
        // 상세를 열 때: 그 장소의 썸네일(최대 3장). 대표 썸네일은 방 응답에서 이미 셌으므로 다시 세지 않음
        const room = await loadRoom(key);
        if (!room) { log('public thumbs 404'); return send(res, 404, { error: PMSG.gone }); }
        const place = room.places.find((p) => p.id === placeId);
        if (!place) { log('public thumbs 404'); return send(res, 404, { error: PMSG.photoGone }); }
        const { urls, paused } = await grantThumbs(place.photos.map((ph) => ph.thumb).filter(Boolean), uid);
        log('public thumbs ok');
        return send(res, 200, { v: 1, thumbs: place.photos.map((ph) => (ph.thumb && urls.get(ph.thumb)) || null), photos_paused: paused });
      }
      // 큰 사진
      if (!photos) { log('public photo off'); return send(res, 503, { error: PMSG.photosOff }); }
      const room = await loadRoom(key);
      const place = room && room.places.find((p) => p.id === placeId);
      const ph = place && place.photos[index];
      if (!ph || !ph.path) { log('public photo 404'); return send(res, 404, { error: PMSG.photoGone }); }
      const { wait, month } = budget.largeWait(uid);
      if (wait) {
        log('public photo budget');
        return send(res, 429, { error: month ? PMSG.budgetMonth : PMSG.budgetDay, budget: true }, { 'retry-after': String(wait) });
      }
      const signed = await signLarge(ph.path);
      if (!signed) { log('public photo fail:sign'); return send(res, 502, { error: PMSG.down }); }
      budget.addLarge(uid);
      log('public photo ok');
      return send(res, 200, { url: signed });
    } catch {
      log(`public ${kind} fail:db`);
      return send(res, 502, { error: PMSG.down });
    }
  }

  // 예상 못 한 오류도 여기서 막음
  async function guarded(req, res) {
    try { await handle(req, res); } catch {
      log('public error');
      if (!res.headersSent) send(res, 500, { error: PMSG.down });
    }
  }
  return {
    handle: guarded,
    flush: () => budget.save(),
    close() { if (timer) clearInterval(timer); budget.save(); },
    budget,
    clearCache() { cache.clear(); tokens.clear(); thumbCache.clear(); },
  };
}

module.exports = {
  createPublicApi, createBudget, pickListItem, pickRoom, publicRoom, createLru, mapUrl,
  kstDay, kstMonth, secondsToKstMidnight, secondsToKstNextMonth, KEY_RE, PMSG, DEFAULTS, BUDGET_FILE,
};
