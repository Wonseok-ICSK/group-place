/* =====================================================================
   화면 확인용 가짜 Supabase (개발 전용). 네트워크에 나가지 않는다.
   index.html이 쓰는 supabase-js 부분만 메모리 데이터로 흉내 낸다:
     auth: getSession, onAuthStateChange, signInWithPassword, signOut, setSession, updateUser
     from(표): select(끼워 넣기 'reviews(*)' 포함) / insert / update / delete / upsert + eq / order / limit / single
     rpc: docs/groups-design.md §9·docs/public-rooms-design.md §9.1의 앱 함수(같은 오류 코드), storage.from(): createSignedUrls / upload / remove
     홈 서버 API: fetch('/api/join'), fetch('/api/signup'), fetch('/api/place'), fetch('/api/public/...')도 여기서 받는다(같은 문구·모양).
   RLS도 대강 흉내 낸다: 내가 든 방 데이터만 보이고, 후기·월드컵 기록은 자기 것만 고치고, 멤버 색은 직접 못 고친다.
   dev/mock/serve.mjs가 CDN의 supabase-js 대신 이 파일을 넣는다. 데이터는 모두 지어낸 것. 새로고침하면 처음 상태로.

   공개 방 (v0.2.0): C '제주 여행 준비'는 미나가 방장인 공개 방(키 c9jeju2xyz). 남의 공개 방 E '서울 라멘 지도'(키 k7m2p9xa4c, 초대 코드 C0FFEE01),
   F '부산 빵지순례'(키 p8bread3kz), G(장소 0곳이라 둘러보기 목록에 없음, 키 g2empty9qx). 공개 API는 서버 허용 목록과 같은 키만 준다(초대 코드·uuid·찜 없음).

   주소 옵션
     ?mock=picker   (기본) 미나로 로그인, 방 3개 → 방 고르기
     ?mock=login    로그아웃 상태. 아이디 mina(또는 아래 사람들), 비밀번호는 8자 이상 아무거나
     ?mock=two      미나가 방 2개(A·B)만 → 방 고르기에 '새 방 만들기'·'코드로 참여' (공개 방을 만들 수 있음)
     ?mock=onboard  방이 없는 새봄으로 로그인 → 시작하기
     &go=A|B|C      그 방을 '마지막 방'으로 기억해 둠 (A 주말 맛집 5명, B 회사 점심 3명·내가 방장, C 제주 혼자·공개 방)
     &pub=gap|owner|full   public_create_status가 그 이유로 '못 만듦' (공개 카드 회색). owner는 미나가 공개 방을 가진 picker에서 저절로도 됨
     &pub=paused    방 하나 응답이 photos_paused·truncated (사진 멈춤 띠)
     &pub=error|empty|gone  공개 API 502 / 빈 목록 / 방 404
     &notice=1      '새 기능: 공개 방' 한 번 알림을 보이게 (기본은 본 것으로 해 둠: 장면마다 5초 알림이 가리지 않게)
     &delay=40      응답 지연(ms)
   개발자 도구에서 window.__mock: db(데이터), calls(부른 기록), warnings(방 조건 빠진 조회 등)
   ===================================================================== */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const SCENE = params.get('mock') || 'picker';
  const PUB = params.get('pub') || '';
  const DELAY = Math.max(0, Number(params.get('delay') ?? 40) || 0);
  const DOMAIN = 'mock.invalid'; // serve.mjs가 index.html의 LOGIN_ID_DOMAIN도 이 값으로 바꿈
  const BUCKET = 'place-photos';

  /* ---------- 작은 도우미 ---------- */
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const uuid = () => crypto.randomUUID();
  const nowIso = () => new Date().toISOString().replace('Z', '+00:00');
  const at = (s) => `${s.replace(' ', 'T')}:00+00:00`; // '2026-03-02 10:00' → timestamptz 모양
  const todayDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const wait = () => new Promise((r) => setTimeout(r, DELAY));
  const pgErr = (code, message) => ({ code, message, details: null, hint: null });
  const raise = (m) => pgErr('P0001', m); // DB 함수의 raise exception
  const rls = (t) => pgErr('42501', `new row violates row-level security policy for table "${t}"`);
  const denied = (t) => pgErr('42501', `permission denied for table ${t}`);
  const hash = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

  /* ---------- 색: 무지개 24색 + 직접 고른 '#rrggbb' (supabase/colors.sql의 member_colors와 같은 id·값, §10) ---------- */
  const PALETTE = {
    red: ['#f53c41', '#ff726b'], coral: ['#f66336', '#ff8d6c'], orange: ['#f87805', '#fe9b5d'], tangerine: ['#fa960b', '#feac59'],
    amber: ['#f7ae05', '#febe4d'], yellow: ['#f7cd03', '#ffd83d'], chartreuse: ['#cbd20d', '#dce307'], lime: ['#84c903', '#99e51c'],
    green: ['#04bb3d', '#45dc5f'], emerald: ['#0cb477', '#23d891'], mint: ['#0cd2a9', '#3ceabf'], teal: ['#02afa6', '#25d2c7'],
    cyan: ['#09c0d3', '#07ddf2'], sky: ['#04aee0', '#41cbff'], azure: ['#049aed', '#5fb9fe'], blue: ['#0182f3', '#5ea7ff'],
    cobalt: ['#3461ef', '#6892fe'], indigo: ['#5e4dee', '#8384ff'], violet: ['#885af5', '#a890fe'], purple: ['#ac55f4', '#c68bff'],
    orchid: ['#cf63e7', '#ea8dff'], magenta: ['#db3cc6', '#ff6ae8'], pink: ['#ef64b3', '#ff91cb'], rose: ['#ec4179', '#ff799b'],
  };
  const MEMBER_COLORS = Object.keys(PALETTE);
  const HEX = /^#[0-9a-f]{6}$/;
  const NEAR = 0.03; // set_member_color·pick_member_color가 막는 거리 (OKLab, 어느 한 화면에서라도)
  // OKLab (Björn Ottosson의 식, colors.sql member_color_lab과 같음)
  function lab(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  const labDelta = (x, y) => { const p = lab(x), q = lab(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const fills = (c) => (HEX.test(c) ? [c, c] : (Object.hasOwn(PALETTE, c) ? PALETTE[c] : null)); // [밝은, 어두운]
  const colorDistance = (x, y) => { const f = fills(x), g = fills(y); return f && g ? Math.min(labDelta(f[0], g[0]), labDelta(f[1], g[1])) : null; };

  /* ---------- 지어낸 사람·방 ---------- */
  const U = {
    mina: '10000000-0000-4000-8000-000000000001',
    junho: '10000000-0000-4000-8000-000000000002',
    seoyeon: '10000000-0000-4000-8000-000000000003',
    doyun: '10000000-0000-4000-8000-000000000004',
    harin: '10000000-0000-4000-8000-000000000005',
    jiwoo: '10000000-0000-4000-8000-000000000006',
    taeo: '10000000-0000-4000-8000-000000000007',
    saebom: '10000000-0000-4000-8000-000000000008',
    gone: '10000000-0000-4000-8000-000000000009', // 예전에 방에서 나간 사람 (장소만 남음)
  };
  const ROOM = {
    A: '20000000-0000-4000-8000-00000000000a',
    B: '20000000-0000-4000-8000-00000000000b',
    C: '20000000-0000-4000-8000-00000000000c',
    E: '20000000-0000-4000-8000-00000000000e', // 남의 공개 방 (미나는 멤버 아님)
    F: '20000000-0000-4000-8000-00000000000f',
    G: '20000000-0000-4000-8000-000000000010',
  };
  const users = [
    ['mina', '미나'], ['junho', '준호'], ['seoyeon', '서연'], ['doyun', '도윤'], ['harin', '하린'],
    ['jiwoo', '지우'], ['taeo', '태오'], ['saebom', '새봄'], ['gone', '예전 멤버'],
  ].map(([login, name]) => ({ id: U[login], email: `${login}@${DOMAIN}`, user_metadata: { display_name: name } }));

  function seed() {
    const db = { couples: [], couple_members: [], categories: [], places: [], visits: [], reviews: [], cup_results: [], place_photos: [] };
    const CATS = ['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타'];
    // pub: { key, desc } 공개 방 (public.sql의 새 칸 visibility·description·public_key·public_hidden_at)
    const room = (key, name, code, created, pub = null) => {
      db.couples.push({
        id: ROOM[key], name, created_by: null, created_at: at(created), invite_code: code, deleting_at: null,
        visibility: pub ? 'public' : 'private', description: pub ? pub.desc : '', public_key: pub ? pub.key : null, public_hidden_at: null,
      });
      CATS.forEach((c, i) => db.categories.push({ id: uuid(), couple_id: ROOM[key], name: c, position: i + 1, created_at: at(created) }));
    };
    const member = (key, user, role, color, display, joined) => {
      db.couple_members.push({ couple_id: ROOM[key], user_id: U[user], role, color, display_name: display, created_at: at(joined) });
      if (role === 'owner') db.couples.find((c) => c.id === ROOM[key]).created_by = U[user];
    };
    const P = {};
    let pn = 0;
    const place = (key, roomKey, f) => {
      const id = `30000000-0000-4000-8000-${String(++pn).padStart(12, '0')}`;
      P[key] = id;
      db.places.push({
        id, couple_id: ROOM[roomKey], name: f.name, address: f.address || null, category: f.category, naver_url: f.url || null,
        status: f.status || 'want_to_go', favorite: !!f.fav, shared_note: f.note || '', created_by: U[f.by], created_at: at(f.created), photo_path: null,
      });
      // 썸네일 '<장소>/t/…' (f.noThumb에 든 번호는 썸네일 없음 → 둘러보기에서 회색 자리)
      for (let i = 0; i < (f.photos || 0); i++) {
        db.place_photos.push({
          id: uuid(), place_id: id, path: `${id}/seed-${i + 1}.jpg`, thumb_path: (f.noThumb || []).includes(i) ? null : `${id}/t/seed-${i + 1}.jpg`,
          position: i, created_by: U[f.by], created_at: at(f.created),
        });
      }
      for (const v of f.visits || []) {
        const vid = uuid();
        db.visits.push({ id: vid, place_id: id, visited_on: v.day, created_by: U[v.by], created_at: at(`${v.day} 21:00`) });
        for (const [who, rating, body] of v.reviews || []) {
          db.reviews.push({ id: uuid(), place_id: id, visit_id: vid, author_id: U[who], rating, body: body || '', created_at: at(`${v.day} 22:00`), updated_at: at(`${v.day} 22:00`) });
        }
      }
    };
    const cup = (roomKey, user, year, category, champ, runner, candidates, played) => {
      const name = (k) => db.places.find((p) => p.id === P[k]).name;
      db.cup_results.push({
        id: uuid(), couple_id: ROOM[roomKey], user_id: U[user], year, category,
        champion_id: P[champ], champion_name: name(champ), runner_up_id: P[runner], runner_up_name: name(runner), candidates, played_at: at(played),
      });
    };

    // A: 5명이 꽉 찬 방. 미나는 멤버(방장은 준호)
    room('A', '주말 맛집 탐방대', '7F3A9C21', '2026-03-02 10:00');
    member('A', 'junho', 'owner', 'amber', '준호', '2026-03-02 10:00');
    member('A', 'mina', 'member', 'teal', '미나', '2026-03-02 11:00');
    member('A', 'seoyeon', 'member', 'violet', '서연', '2026-03-05 09:30');
    member('A', 'doyun', 'member', '#8b5e3c', '도윤 (주말만 가능)', '2026-03-10 20:00'); // 직접 고른 색 (팔레트에 없는 갈색)
    member('A', 'harin', 'member', 'pink', '디저트 담당 하린', '2026-04-01 13:00');
    place('kal', 'A', {
      name: '골목 끝 칼국수', category: '맛집', status: 'visited', fav: true, by: 'junho', created: '2026-03-03 12:10', photos: 3,
      address: '서울 마포구 망원동 41-7', note: '평일 11시 반 전에 가면 웨이팅 없어요. 들깨칼국수 + 보쌈 반 접시 추천',
      visits: [
        { day: '2026-09-14', by: 'mina', reviews: [
          ['junho', 4.5, '면이 진짜 쫄깃해요. 김치가 맛있어서 두 번 리필함'],
          ['mina', 5, '국물이 진하고 안 짜요. 다음엔 수제비도 먹어 볼래요'],
          ['seoyeon', 4, ''],
          ['doyun', 3.5, '줄이 길었는데 회전은 빨라요'],
          ['harin', 4.5, '보쌈 강추!! 들깨 향이 진해요'],
        ] },
        { day: '2026-04-20', by: 'junho', reviews: [['junho', 4, '처음 와 봤는데 괜찮네'], ['mina', 4.5, '']] },
      ],
    });
    place('cafe', 'A', {
      name: '바람정원 카페', category: '카페', status: 'visited', by: 'seoyeon', created: '2026-06-01 09:00', photos: 1,
      address: '경기 파주시 탄현면 정원길 12', note: '루프탑 자리는 2시 이후엔 해가 너무 세요',
      visits: [{ day: '2026-08-02', by: 'seoyeon', reviews: [['mina', 4.5, '정원이 넓어서 산책하기 좋아요'], ['seoyeon', 5, '인생 카페 등극'], ['harin', 4, '케이크는 평범']] }],
    });
    place('salt', 'A', {
      name: '소금빵 연구소', category: '디저트', status: 'visited', by: 'harin', created: '2026-06-20 15:00', address: '서울 성동구 성수동2가 300-1',
      visits: [{ day: '2026-07-11', by: 'harin', reviews: [['harin', 4.5, '오픈런 성공. 버터 소금빵 최고'], ['doyun', 3.5, '']] }],
    });
    place('bbq', 'A', {
      name: '을지로 숯불구이', category: '맛집', status: 'visited', by: 'doyun', created: '2025-11-30 18:00', photos: 1, address: '서울 중구 을지로3가 7-2',
      visits: [{ day: '2025-12-20', by: 'doyun', reviews: [['doyun', 5, ''], ['junho', 4, '고기 질이 좋아요'], ['seoyeon', 4.5, ''], ['mina', 4, '연기가 좀 많음']] }],
    });
    place('beer', 'A', {
      name: '망원 수제맥주집', category: '술집', status: 'visited', by: 'junho', created: '2026-09-30 20:00', address: '서울 마포구 망원동 400-12',
      visits: [{ day: '2026-10-03', by: 'junho', reviews: [] }],
    });
    place('river', 'A', { name: '한강 노을 산책길', category: '놀거리', by: 'mina', created: '2026-10-10 19:00', note: '해 지기 30분 전에 출발하기' });
    place('tea', 'A', { name: '북촌 한옥 찻집', category: '카페', fav: true, by: 'harin', created: '2026-10-05 14:00', photos: 1, address: '서울 종로구 계동 88' });
    place('gelato', 'A', { name: '성수 젤라또 가게', category: '디저트', by: 'seoyeon', created: '2026-10-12 13:00', address: '서울 성동구 성수동1가 15-4' });
    place('namsan', 'A', { name: '남산 야경 포인트', category: '놀거리', by: 'gone', created: '2026-05-02 21:00' });
    place('jeju', 'A', { name: '제주 동쪽 해안도로 따라가다 나오는 흑돼지 골목 끝집', category: '여행', by: 'doyun', created: '2026-10-15 10:00', address: '제주 제주시 구좌읍 해안로 300' });
    // 같은 월드컵(2026 종합)에서 미나와 준호가 둘 다 칼국수를 1위로: 도장 두 개(각자 색), 합치지 않음
    cup('A', 'mina', 2026, null, 'kal', 'cafe', 5, '2026-09-20 21:00');
    cup('A', 'junho', 2026, null, 'kal', 'salt', 5, '2026-09-21 22:30');
    cup('A', 'seoyeon', null, null, 'bbq', 'kal', 6, '2026-09-25 20:00');
    cup('A', 'doyun', null, '맛집', 'bbq', 'kal', 2, '2026-10-01 12:00');

    // B: 3명, 미나가 방장
    room('B', '회사 점심 모임', 'B42E08D5', '2026-05-10 12:00');
    member('B', 'mina', 'owner', 'cobalt', '미나 대리', '2026-05-10 12:00');
    member('B', 'jiwoo', 'member', 'orange', '지우', '2026-05-10 12:30');
    member('B', 'taeo', 'member', 'emerald', '태오', '2026-05-11 09:00');
    place('naeng', 'B', {
      name: '을지로 평양냉면', category: '맛집', status: 'visited', by: 'jiwoo', created: '2026-05-12 12:00',
      visits: [{ day: '2026-07-03', by: 'jiwoo', reviews: [['jiwoo', 4, '육수가 슴슴해요'], ['taeo', 4.5, ''], ['mina', 5, '여름엔 무조건 여기']] }],
    });
    place('pho', 'B', {
      name: '역 앞 쌀국수', category: '맛집', status: 'visited', by: 'mina', created: '2026-09-01 12:00',
      visits: [{ day: '2026-09-09', by: 'mina', reviews: [['mina', 3.5, '양은 많은데 국물이 아쉬움']] }],
    });
    place('salad', 'B', { name: '빌딩 뒤 샐러드 바', category: '맛집', by: 'taeo', created: '2026-10-02 12:00' });
    place('donkatsu', 'B', { name: '돈가스 골목 2호점', category: '맛집', fav: true, by: 'jiwoo', created: '2026-10-08 12:00' });

    // C: 미나 혼자인 공개 방 (메인에 둘러보기 링크·초대 코드 두 줄 띠, 내 정보에 '공개 방' 묶음)
    room('C', '제주 여행 준비', 'C9D1E6F0', '2026-10-01 22:00', { key: 'c9jeju2xyz', desc: '제주에서 가 보고 싶은 바다·오름 모음' });
    member('C', 'mina', 'owner', 'orchid', '미나', '2026-10-01 22:00');
    place('beach', 'C', { name: '협재 해변', category: '여행', by: 'mina', created: '2026-10-01 22:10', note: '스노클링 장비 챙기기' });
    place('oreum', 'C', { name: '오름 일출 코스', category: '놀거리', by: 'mina', created: '2026-10-02 07:00', photos: 1 });

    // E: 남의 공개 방 (준호가 방장, 서연). 미나는 멤버가 아님. 나간 사람(gone)이 담은 장소·후기는 '예전 멤버'
    room('E', '서울 라멘 지도', 'C0FFEE01', '2026-08-01 12:00', { key: 'k7m2p9xa4c', desc: '둘이 먹어 본 서울 라멘집 모음. 줄 서는 시간도 적어 둬요' });
    member('E', 'junho', 'owner', 'teal', '라멘왕', '2026-08-01 12:00');
    member('E', 'seoyeon', 'member', '#8b5e3c', '면치기 서연', '2026-08-02 12:00');
    place('ramen1', 'E', {
      name: '멘야 하나', category: '맛집', status: 'visited', fav: true, by: 'junho', created: '2026-09-01 12:00', photos: 5, noThumb: [1],
      address: '서울 마포구 연남동 239-12', url: 'https://naver.me/xRamen01', note: '토요일 11시 오픈런\n줄 서면 30분, 혼밥 자리 많아요',
      visits: [
        { day: '2026-10-03', by: 'junho', reviews: [['junho', 4.5, '국물이 진하고 차슈가 두꺼워요'], ['seoyeon', 4, ''], ['gone', 3, '면이 좀 퍼졌어요']] },
        { day: '2026-09-02', by: 'seoyeon', reviews: [['seoyeon', 5, '<script>alert(1)</script> 이런 글자도 그냥 글자로 보여야 함']] },
      ],
    });
    place('ramen2', 'E', { name: '돈코츠 골목', category: '맛집', by: 'gone', created: '2026-09-15 12:00', address: '서울 용산구 한강대로 40길 5' });
    place('ramen3', 'E', {
      name: '츠케멘 연구소', category: '맛집', status: 'visited', by: 'seoyeon', created: '2026-10-01 12:00', photos: 1, address: '서울 성동구 성수동2가 280-3',
      visits: [{ day: '2026-10-10', by: 'seoyeon', reviews: [['seoyeon', 3.5, '면이 탱탱하고 국물이 진해요'], ['junho', 4, '']] }],
    });
    place('ramen4', 'E', { name: '시오라멘 작은집', category: '맛집', by: 'junho', created: '2026-10-18 19:00', address: '서울 종로구 익선동 166', note: '평일 저녁만 열어요' });
    place('ramen5', 'E', {
      name: '라멘 뒤 디저트 카페', category: '카페', status: 'visited', by: 'seoyeon', created: '2026-09-20 15:00', photos: 2,
      visits: [{ day: '2026-09-21', by: 'seoyeon', reviews: [['seoyeon', 4.5, '말차 푸딩 강추']] }],
    });
    // F: 남의 공개 방 (하린·도윤)
    room('F', '부산 빵지순례', 'F00DCAFE', '2026-06-01 10:00', { key: 'p8bread3kz', desc: '부산 가면 들르는 빵집만' });
    member('F', 'harin', 'owner', 'pink', '빵순이', '2026-06-01 10:00');
    member('F', 'doyun', 'member', 'sky', '도윤', '2026-06-03 10:00');
    member('F', 'jiwoo', 'member', 'lime', '지우', '2026-06-04 10:00');
    place('bread1', 'F', {
      name: '해운대 소금빵', category: '디저트', status: 'visited', by: 'harin', created: '2026-06-02 10:00', photos: 1, address: '부산 해운대구 중동 1394-65',
      visits: [{ day: '2026-07-20', by: 'harin', reviews: [['harin', 5, '바삭 짭짤'], ['doyun', 4.5, '']] }],
    });
    place('bread2', 'F', { name: '전포 카페거리 베이글', category: '카페', by: 'doyun', created: '2026-08-11 10:00' });
    // G: 장소가 없는 공개 방 → 둘러보기 목록에 안 나옴 (키로 열면 빈 방)
    room('G', '이제 막 만든 공개 방', 'BEEF0001', '2026-10-20 10:00', { key: 'g2empty9qx', desc: '' });
    member('G', 'taeo', 'owner', 'violet', '태오', '2026-10-20 10:00');

    if (SCENE === 'two') { // 미나가 방 2개만: C를 통째로 뺌
      const drop = (t) => { db[t] = db[t].filter((r) => r.couple_id !== ROOM.C && r.id !== ROOM.C); };
      const gonePlaces = new Set(db.places.filter((p) => p.couple_id === ROOM.C).map((p) => p.id));
      ['couples', 'couple_members', 'categories', 'places', 'cup_results'].forEach(drop);
      for (const t of ['visits', 'reviews', 'place_photos']) db[t] = db[t].filter((r) => !gonePlaces.has(r.place_id));
    }
    return db;
  }
  const db = seed();

  /* ---------- 사진: 지어낸 풍경 그림(data:) / 올린 사진은 blob: ---------- */
  function fakePhoto(seedText) {
    const h = hash(seedText) % 360;
    const sx = 520 + (hash(`${seedText}x`) % 200);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">`
      + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},65%,80%)"/><stop offset="1" stop-color="hsl(${(h + 35) % 360},55%,58%)"/></linearGradient></defs>`
      + `<rect width="800" height="500" fill="url(#g)"/><circle cx="${sx}" cy="140" r="54" fill="hsl(${(h + 180) % 360},85%,94%)" opacity=".85"/>`
      + `<path d="M0 370 Q200 290 400 350 T800 330 V500 H0z" fill="hsl(${(h + 80) % 360},35%,38%)" opacity=".8"/>`
      + `<path d="M0 430 Q240 380 480 420 T800 405 V500 H0z" fill="hsl(${(h + 110) % 360},30%,24%)" opacity=".85"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  const files = new Map(db.place_photos.flatMap((ph) => [[ph.path, fakePhoto(ph.path)], ...(ph.thumb_path ? [[ph.thumb_path, fakePhoto(ph.path)]] : [])]));
  // 공개 API가 주는 사진: 화면(imgUrl)은 data:image/png|jpeg;base64만 받으므로 같은 풍경을 캔버스로 그려 JPEG로 (한 번 그리면 기억)
  const rasterCache = new Map();
  function rasterPhoto(seedText, w, h) {
    const k = `${seedText}|${w}`;
    if (rasterCache.has(k)) return rasterCache.get(k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'), hue = hash(seedText) % 360, sx = (520 + (hash(`${seedText}x`) % 200)) * (w / 800), y = (v) => v * (h / 500), x = (v) => v * (w / 800);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `hsl(${hue},65%,80%)`); grad.addColorStop(1, `hsl(${(hue + 35) % 360},55%,58%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.85; g.fillStyle = `hsl(${(hue + 180) % 360},85%,94%)`; g.beginPath(); g.arc(sx, y(140), x(54), 0, Math.PI * 2); g.fill();
    const hill = (y0, ya, color, alpha) => {
      g.globalAlpha = alpha; g.fillStyle = color; g.beginPath(); g.moveTo(0, y(y0));
      g.quadraticCurveTo(x(220), y(ya), x(420), y(y0 - 10)); g.quadraticCurveTo(x(620), y(y0 + 20), w, y(y0 - 30)); g.lineTo(w, h); g.lineTo(0, h); g.fill();
    };
    hill(370, 290, `hsl(${(hue + 80) % 360},35%,38%)`, 0.8);
    hill(430, 380, `hsl(${(hue + 110) % 360},30%,24%)`, 0.85);
    const url = c.toDataURL('image/jpeg', 0.82);
    rasterCache.set(k, url);
    return url;
  }

  /* ---------- 로그인 ---------- */
  const sessions = new Map(); // access_token → session (가입 API가 만든 것도)
  function makeSession(userId) {
    const user = users.find((u) => u.id === userId);
    const s = { access_token: `mock-access-${uuid()}`, refresh_token: `mock-refresh-${uuid()}`, token_type: 'bearer', expires_in: 3600, user: clone(user) };
    sessions.set(s.access_token, s);
    return s;
  }
  let session = SCENE === 'login' ? null : makeSession(SCENE === 'onboard' ? U.saebom : U.mina);
  const uid = () => (session ? session.user.id : null);
  const listeners = new Set();
  const emit = (event) => { const s = clone(session); listeners.forEach((cb) => setTimeout(() => cb(event, s), 0)); };
  // &go=A|B|C: 그 방을 마지막 방으로 기억 (index.html의 ROOM_KEY와 같은 꼴 'userId:roomId')
  const go = ROOM[String(params.get('go') || '').toUpperCase()];
  if (go) {
    try { localStorage.setItem('group-place:last-room', `${SCENE === 'onboard' ? U.saebom : U.mina}:${go}`); } catch { /* 없으면 방 고르기 */ }
  }
  // '새 기능: 공개 방' 한 번 알림(index.html NOTICE_KEY)은 &notice=1일 때만 보이게
  try { if (params.get('notice') !== '1') localStorage.setItem('group-place:notice-v020', '1'); } catch { /* 알림이 한 번 뜰 뿐 */ }

  /* ---------- RLS 흉내 ---------- */
  const isMember = (roomId, who = uid()) => !!who && db.couple_members.some((m) => m.couple_id === roomId && m.user_id === who);
  const placeById = (id) => db.places.find((p) => p.id === id);
  function roomOf(table, row) {
    if (table === 'couples') return row.id;
    if (row.couple_id !== undefined) return row.couple_id;
    const p = placeById(row.place_id);
    return p ? p.couple_id : null;
  }
  const canSee = (table, row) => isMember(roomOf(table, row));

  /* ---------- 제약 조건 흉내 (이름은 schema.sql·groups.sql과 같게) ---------- */
  const unique = (name) => pgErr('23505', `duplicate key value violates unique constraint "${name}"`);
  const check = (table, name) => pgErr('23514', `new row for relation "${table}" violates check constraint "${name}"`);
  const fkey = (table, name) => pgErr('23503', `insert or update on table "${table}" violates foreign key constraint "${name}"`);
  const sameNull = (a, b) => (a ?? null) === (b ?? null);
  function checkRow(table, row, old) {
    const others = db[table].filter((r) => r !== old);
    if (table === 'categories') {
      const n = String(row.name ?? '');
      if (n !== n.trim() || [...n].length < 1 || [...n].length > 20 || n === '전체') return check(table, 'categories_name_check');
      if (others.some((r) => r.couple_id === row.couple_id && r.name === n)) return unique('categories_couple_name_key');
    }
    if (table === 'places') {
      if (!['want_to_go', 'visited'].includes(row.status)) return check(table, 'places_status_check');
      if (!db.categories.some((c) => c.couple_id === row.couple_id && c.name === row.category)) return fkey(table, 'places_category_fkey');
    }
    if (table === 'visits' && others.some((r) => r.place_id === row.place_id && r.visited_on === row.visited_on)) return unique('visits_place_day_key');
    if (table === 'reviews') {
      const r = row.rating;
      if (r != null && (r < 0.5 || r > 5 || r * 2 !== Math.trunc(r * 2))) return check(table, 'reviews_rating_check');
      if (!db.visits.some((v) => v.id === row.visit_id && v.place_id === row.place_id)) return fkey(table, 'reviews_visit_fkey');
      if (others.some((x) => x.visit_id === row.visit_id && x.author_id === row.author_id)) return unique('reviews_visit_author_key');
    }
    if (table === 'cup_results') {
      if (row.category != null && !db.categories.some((c) => c.couple_id === row.couple_id && c.name === row.category)) return fkey(table, 'cup_results_category_fkey');
      if (others.some((x) => x.couple_id === row.couple_id && x.user_id === row.user_id && sameNull(x.year, row.year) && sameNull(x.category, row.category))) return unique('cup_results_one_per_cup');
      if (row.champion_id && row.champion_id === row.runner_up_id) return check(table, 'cup_results_places_check');
    }
    if (table === 'place_photos' && others.some((x) => x.path === row.path)) return unique('place_photos_path_key');
    if (table === 'place_photos' && !old && others.filter((x) => x.place_id === row.place_id).length >= 10) return raise('photo_limit');
    if (table === 'couple_members') {
      const n = String(row.display_name ?? '').trim();
      if ([...n].length < 1 || [...n].length > 20) return check(table, 'couple_members_display_name_check');
      // 공개 방에서는 닉네임이 로그인 아이디와 같으면 안 됨 (public.sql enforce_public_nickname 트리거)
      if (nickIsLoginId(row.couple_id, row.user_id, n)) return raise('nickname_is_login_id');
    }
    return null;
  }
  const DEFAULTS = {
    categories: () => ({ id: uuid(), position: 0, created_at: nowIso() }),
    places: () => ({ id: uuid(), address: null, category: '기타', naver_url: null, status: 'want_to_go', favorite: false, shared_note: '', created_at: nowIso(), photo_path: null }),
    visits: () => ({ id: uuid(), visited_on: todayDay(), created_at: nowIso() }),
    reviews: () => ({ id: uuid(), rating: null, body: '', created_at: nowIso(), updated_at: nowIso() }),
    cup_results: () => ({ id: uuid(), year: null, category: null, champion_id: null, runner_up_id: null, played_at: nowIso() }),
    place_photos: () => ({ id: uuid(), thumb_path: null, position: 0, created_at: nowIso() }),
  };
  // 로그인 아이디 = 이메일 @ 앞 (소문자). 공개 방 닉네임 확인용
  const loginIdOf = (who) => { const u = users.find((x) => x.id === who); return u ? u.email.split('@')[0].toLowerCase() : ''; };
  const isPublic = (roomId) => { const r = db.couples.find((c) => c.id === roomId); return !!r && r.visibility === 'public'; };
  const nickIsLoginId = (roomId, who, name) => isPublic(roomId) && !!loginIdOf(who) && String(name ?? '').trim().toLowerCase() === loginIdOf(who);
  // 넣기 정책: 그 방 멤버여야 하고, 작성자 칸은 나여야 함 (couples·couple_members는 DB 함수로만)
  function insertAllowed(table, row) {
    if (!DEFAULTS[table]) return false;
    if (!isMember(roomOf(table, row))) return false;
    const owner = { places: 'created_by', visits: 'created_by', reviews: 'author_id', cup_results: 'user_id', place_photos: 'created_by' }[table];
    if (owner && row[owner] !== uid()) return false;
    if (table === 'cup_results') {
      for (const k of ['champion_id', 'runner_up_id']) if (row[k] && (placeById(row[k]) || {}).couple_id !== row.couple_id) return false;
    }
    return true;
  }
  // 고치기·지우기 정책 (USING): 안 맞는 줄은 조용히 빠짐 (Postgres와 같음)
  function writeAllowed(table, op, row) {
    if (!canSee(table, row)) return false;
    if (table === 'couple_members') return op === 'update' && row.user_id === uid();
    if (table === 'reviews' || table === 'cup_results') return (row.author_id ?? row.user_id) === uid();
    if (table === 'visits' && op === 'delete') return !db.reviews.some((r) => r.visit_id === row.id && r.author_id !== uid());
    return table !== 'couples';
  }
  // 지울 때 같이 지워지는 것 (on delete cascade / set null)
  function cascadeDelete(table, row) {
    const del = (t, pred) => { db[t].filter(pred).forEach((r) => cascadeDelete(t, r)); db[t] = db[t].filter((r) => !pred(r)); };
    if (table === 'couples') {
      del('couple_members', (r) => r.couple_id === row.id);
      del('cup_results', (r) => r.couple_id === row.id);
      del('places', (r) => r.couple_id === row.id);
      del('categories', (r) => r.couple_id === row.id);
    } else if (table === 'places') {
      del('visits', (r) => r.place_id === row.id);
      del('reviews', (r) => r.place_id === row.id);
      del('place_photos', (r) => r.place_id === row.id);
      for (const r of db.cup_results) {
        if (r.champion_id === row.id) r.champion_id = null;
        if (r.runner_up_id === row.id) r.runner_up_id = null;
      }
    } else if (table === 'visits') del('reviews', (r) => r.visit_id === row.id);
    else if (table === 'categories') del('cup_results', (r) => r.couple_id === row.couple_id && r.category === row.name);
  }

  /* ---------- 조회: select 문자열 (끼워 넣기 포함) ---------- */
  const NESTED = { places: { reviews: 'place_id', visits: 'place_id', place_photos: 'place_id' } };
  function splitTop(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function project(table, row, cols) {
    const out = {};
    for (const part of splitTop(cols || '*')) {
      const m = part.match(/^([a-z_]+)(?:![a-z_]+)?\((.*)\)$/);
      if (m) {
        const fk = NESTED[table] && NESTED[table][m[1]];
        if (!fk) throw pgErr('PGRST200', `Could not find a relationship between '${table}' and '${m[1]}' in the schema cache`);
        out[m[1]] = db[m[1]].filter((c) => c[fk] === row.id).map((c) => project(m[1], c, m[2]));
      } else if (part === '*') Object.assign(out, clone(row));
      else if (part in row) out[part] = clone(row[part]);
      else throw pgErr('42703', `column ${table}.${part} does not exist`);
    }
    return out;
  }
  function cmp(a, b) {
    if (a === b) return 0;
    if (a == null) return 1; // 오름차순에서 null은 뒤 (PostgREST 기본)
    if (b == null) return -1;
    return a < b ? -1 : 1;
  }

  /* ---------- from(표) ---------- */
  const calls = [];
  const warnings = [];
  const ROOM_TABLES = ['places', 'categories', 'cup_results'];
  class Query {
    constructor(table) {
      if (!db[table]) throw new Error(`mock: 모르는 표 ${table}`);
      Object.assign(this, { table, op: 'select', cols: '*', returning: false, filters: [], orders: [], lim: null, one: false, payload: null, conflict: null });
    }
    select(cols = '*') { if (this.op === 'select') this.cols = cols; else { this.returning = true; this.cols = cols; } return this; }
    insert(v) { this.op = 'insert'; this.payload = v; return this; }
    update(v) { this.op = 'update'; this.payload = v; return this; }
    upsert(v, opts = {}) { this.op = 'upsert'; this.payload = v; this.conflict = opts.onConflict || null; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(col, v) { this.filters.push([col, v]); return this; }
    order(col, opts = {}) { this.orders.push([col, opts.ascending !== false]); return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.one = true; return this; }
    then(ok, bad) { return this.run().then(ok, bad); }
    async run() {
      await wait();
      const t = this.table;
      calls.push({ kind: 'from', table: t, op: this.op, filters: this.filters.map(([c, v]) => `${c}=${v}`), cols: this.cols });
      if (!uid()) return { data: null, error: pgErr('42501', `permission denied for table ${t}`), status: 401 };
      // 방 조건이 빠진 조회는 여러 방 데이터가 섞여 옴 (설계 §4.2). 화면에는 그대로 주되 기록만 남김
      if (ROOM_TABLES.includes(t) && this.op === 'select' && !this.filters.some(([c]) => c === 'couple_id')) {
        warnings.push(`${t} select without .eq('couple_id')`);
        console.warn(`[mock] ${t} 조회에 couple_id 조건이 없어요`);
      }
      const match = (r) => this.filters.every(([c, v]) => r[c] === v);
      try {
        let rows;
        if (this.op === 'select') rows = db[t].filter((r) => canSee(t, r) && match(r));
        else if (this.op === 'insert' || this.op === 'upsert') rows = this.write();
        else if (this.op === 'update') rows = this.change();
        else rows = this.remove();
        if (this.op === 'select' || this.returning) {
          rows = [...rows];
          if (this.orders.length) rows.sort((a, b) => { for (const [c, asc] of this.orders) { const k = cmp(a[c], b[c]); if (k) return asc ? k : -k; } return 0; });
          if (this.lim != null) rows = rows.slice(0, this.lim);
          const data = rows.map((r) => project(t, r, this.cols));
          if (this.one) {
            if (data.length !== 1) return { data: null, error: { ...pgErr('PGRST116', 'JSON object requested, multiple (or no) rows returned'), details: `The result contains ${data.length} rows` }, status: 406 };
            return { data: data[0], error: null, status: 200 };
          }
          return { data, error: null, status: 200 };
        }
        return { data: null, error: null, status: 204 };
      } catch (err) {
        if (err && err.code) return { data: null, error: err, status: 400 };
        throw err;
      }
    }
    write() {
      const t = this.table;
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = [];
      for (const v of list) {
        if (this.op === 'upsert' && this.conflict) {
          const keys = this.conflict.split(',').map((s) => s.trim());
          const old = db[t].find((r) => keys.every((k) => sameNull(r[k], v[k])));
          if (old) {
            if (!writeAllowed(t, 'update', old)) throw rls(t);
            const next = { ...old, ...v };
            const e = checkRow(t, next, old) || (insertAllowed(t, next) ? null : rls(t));
            if (e) throw e;
            Object.assign(old, v);
            out.push(old);
            continue;
          }
        }
        const row = { ...DEFAULTS[t] && DEFAULTS[t](), ...v };
        if (!insertAllowed(t, row)) throw rls(t);
        const e = checkRow(t, row, null);
        if (e) throw e;
        db[t].push(row);
        out.push(row);
      }
      return out;
    }
    change() {
      const t = this.table;
      if (t === 'couples') throw denied(t); // 방 이름은 rename_room으로만
      // 멤버 줄은 닉네임만 고칠 수 있음 (색은 set_member_color로만, groups.sql §2.7)
      if (t === 'couple_members' && Object.keys(this.payload).some((k) => k !== 'display_name')) throw denied(t);
      const rows = db[t].filter((r) => this.filters.every(([c, v]) => r[c] === v) && writeAllowed(t, 'update', r));
      for (const r of rows) {
        const next = { ...r, ...this.payload };
        if (t === 'reviews') next.updated_at = nowIso();
        const e = checkRow(t, next, r);
        if (e) throw e;
      }
      for (const r of rows) {
        const before = { ...r };
        Object.assign(r, this.payload);
        if (t === 'reviews') r.updated_at = nowIso();
        // 카테고리 이름을 바꾸면 그 이름을 쓰던 장소·월드컵 기록도 같이 (on update cascade)
        if (t === 'categories' && before.name !== r.name) {
          db.places.forEach((p) => { if (p.couple_id === r.couple_id && p.category === before.name) p.category = r.name; });
          db.cup_results.forEach((c) => { if (c.couple_id === r.couple_id && c.category === before.name) c.category = r.name; });
        }
      }
      return rows;
    }
    remove() {
      const t = this.table;
      if (t === 'couples' || t === 'couple_members') throw denied(t);
      const rows = db[t].filter((r) => this.filters.every(([c, v]) => r[c] === v) && writeAllowed(t, 'delete', r));
      if (t === 'categories') {
        for (const r of rows) {
          if (db.places.some((p) => p.couple_id === r.couple_id && p.category === r.name)) {
            throw pgErr('23503', 'update or delete on table "categories" violates foreign key constraint "places_category_fkey" on table "places"');
          }
        }
      }
      for (const r of rows) cascadeDelete(t, r);
      db[t] = db[t].filter((r) => !rows.includes(r));
      return rows;
    }
  }

  /* ---------- rpc: DB 함수 (groups.sql과 같은 규칙·오류 코드) ---------- */
  const MAX_MEMBERS = 5, MAX_ROOMS = 3;
  const roomCount = (who) => db.couple_members.filter((m) => m.user_id === who).length;
  const membersOf = (roomId) => db.couple_members.filter((m) => m.couple_id === roomId);
  const textLen = (s) => [...String(s ?? '').trim()].length;
  // 새 멤버의 무작위 색: 24색 중 그 방에서 아무도 안 쓰고, 다른 멤버 색과 거의 같지 않은 색 (colors.sql pick_member_color)
  function freeColor(roomId) {
    const ms = membersOf(roomId);
    const free = MEMBER_COLORS.filter((c) => !ms.some((m) => m.color === c || (colorDistance(m.color, c) ?? 1) < NEAR));
    if (!free.length) throw raise('no_free_color');
    return free[Math.floor(Math.random() * free.length)];
  }
  const newCode = () => {
    let c;
    do c = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    while (db.couples.some((r) => r.invite_code === c));
    return c;
  };
  const DELETE_BLOCK_MS = 15 * 60 * 1000;
  const PUBLIC_ACK_VERSION = 1; // public.sql public_ack_version()
  const codeRoom = (code) => db.couples.find((r) => r.invite_code === String(code || '').trim().toUpperCase()
    && (!r.deleting_at || Date.now() - Date.parse(r.deleting_at) >= DELETE_BLOCK_MS));
  // public.sql join_room_for와 같은 순서: 코드 → 이미 멤버 → 방 참 → 내 방 3개 → (공개만) 닉네임=아이디 → (공개만, 동의 없음) need_ack 반환
  function joinRoom(who, code, display, ackVersion) {
    if (!who) throw raise('not_authenticated');
    if (textLen(display) < 1 || textLen(display) > 20) throw raise('invalid_display_name');
    const room = codeRoom(code);
    if (!room) throw raise('invalid_code');
    const pub = room.visibility === 'public';
    if (isMember(room.id, who)) return { status: 'already_member', couple_id: room.id, public: pub };
    if (membersOf(room.id).length >= MAX_MEMBERS) throw raise('room_full');
    if (roomCount(who) >= MAX_ROOMS) throw raise('too_many_rooms');
    if (pub && nickIsLoginId(room.id, who, display)) throw raise('nickname_is_login_id');
    if (pub && ackVersion !== PUBLIC_ACK_VERSION) return { status: 'need_ack', couple_id: null, public: true, room_name: room.name, ack_version: PUBLIC_ACK_VERSION };
    db.couple_members.push({ couple_id: room.id, user_id: who, role: 'member', color: freeColor(room.id), display_name: String(display).trim(), created_at: nowIso() });
    return { status: 'joined', couple_id: room.id, public: pub };
  }
  // 옛 길(groups.sql join_couple_for): 공개 방이면 동의를 받을 수 없으니 ack_required로 거절
  function joinFor(who, code, display) {
    if (!who) throw raise('not_authenticated');
    if (textLen(display) < 1 || textLen(display) > 20) throw raise('invalid_display_name');
    const room = codeRoom(code);
    if (!room) throw raise('invalid_code');
    if (isMember(room.id, who)) return room.id;
    if (roomCount(who) >= MAX_ROOMS) throw raise('too_many_rooms');
    if (membersOf(room.id).length >= MAX_MEMBERS) throw raise('room_full');
    if (room.visibility === 'public') throw raise('ack_required');
    db.couple_members.push({ couple_id: room.id, user_id: who, role: 'member', color: freeColor(room.id), display_name: String(display).trim(), created_at: nowIso() });
    return room.id;
  }
  // 공개 키 10자 (public.sql couples_public_key_check와 같은 글자 모음: l·o·0·1 없음)
  const KEY_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  const newKey = () => {
    let k;
    do k = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => KEY_CHARS[b % 32]).join('');
    while (db.couples.some((r) => r.public_key === k));
    return k;
  };
  // 공개 방을 지금 만들 수 있는지 (§2.6). &pub=gap|owner|full이면 그 이유로 못 만듦
  function createStatus() {
    const base = { allowed: true, reason: null, next_at: null, ack_version: PUBLIC_ACK_VERSION };
    if (roomCount(uid()) >= MAX_ROOMS) return { ...base, allowed: false, reason: 'too_many_rooms' };
    const owns = db.couples.some((r) => r.visibility === 'public' && db.couple_members.some((m) => m.couple_id === r.id && m.user_id === uid() && m.role === 'owner'));
    if (owns || PUB === 'owner') return { ...base, allowed: false, reason: 'public_owner_limit' };
    if (PUB === 'gap') return { ...base, allowed: false, reason: 'public_create_gap', next_at: new Date(Date.now() + 4.2 * 86400e3).toISOString().replace('Z', '+00:00') };
    if (PUB === 'full' || db.couples.filter((r) => r.visibility === 'public').length >= 30) return { ...base, allowed: false, reason: 'public_rooms_full' };
    return base;
  }
  function lockMember(roomId) {
    if (!uid()) throw raise('not_authenticated');
    if (!db.couples.some((r) => r.id === roomId)) throw raise('not_member');
    const me = db.couple_members.find((m) => m.couple_id === roomId && m.user_id === uid());
    if (!me) throw raise('not_member');
    return me;
  }
  const RPC = {
    groups_schema_version: () => 1,
    save_visit_review({ p_place, p_day, p_visit, p_rating, p_body }) {
      const place = db.places.find((p) => p.id === p_place);
      if (!uid()) throw raise('not_authenticated');
      if (!place || !isMember(place.couple_id)) throw raise('not_member');
      const body = String(p_body || '').trim();
      if (!p_day || [...body].length > 3000) throw raise('invalid_review');
      if (p_rating != null && (p_rating < 0.5 || p_rating > 5 || p_rating * 2 !== Math.trunc(p_rating * 2))) throw check('reviews', 'reviews_rating_check');
      let visit = p_visit ? db.visits.find((v) => v.id === p_visit && v.place_id === p_place)
        : db.visits.find((v) => v.place_id === p_place && v.visited_on === p_day);
      if (p_visit && !visit) throw raise('visit_gone');
      if (visit && db.visits.some((v) => v !== visit && v.place_id === p_place && v.visited_on === p_day)) throw unique('visits_place_day_key');
      if (!visit) { visit = { ...DEFAULTS.visits(), place_id: p_place, visited_on: p_day, created_by: uid() }; db.visits.push(visit); }
      visit.visited_on = p_day;
      const mine = db.reviews.find((r) => r.visit_id === visit.id && r.author_id === uid());
      if (p_rating == null && !body) db.reviews = db.reviews.filter((r) => r !== mine);
      else if (mine) Object.assign(mine, { rating: p_rating, body, updated_at: nowIso() });
      else db.reviews.push({ ...DEFAULTS.reviews(), place_id: p_place, visit_id: visit.id, author_id: uid(), rating: p_rating, body });
      return visit.id;
    },
    create_couple({ p_display_name, p_couple_name }) {
      if (!uid()) throw raise('not_authenticated');
      if (roomCount(uid()) >= MAX_ROOMS) throw raise('too_many_rooms');
      if (textLen(p_couple_name) < 1 || textLen(p_couple_name) > 30) throw raise('invalid_room_name');
      if (textLen(p_display_name) < 1 || textLen(p_display_name) > 20) throw raise('invalid_display_name');
      const id = uuid(), t = nowIso();
      db.couples.push({ id, name: String(p_couple_name).trim(), created_by: uid(), created_at: t, invite_code: newCode(), deleting_at: null, visibility: 'private', description: '', public_key: null, public_hidden_at: null });
      db.couple_members.push({ couple_id: id, user_id: uid(), role: 'owner', color: freeColor(id), display_name: String(p_display_name).trim(), created_at: t });
      ['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타'].forEach((name, i) => db.categories.push({ id: uuid(), couple_id: id, name, position: i + 1, created_at: t }));
      return id;
    },
    join_couple: ({ p_invite_code, p_display_name }) => joinFor(uid(), p_invite_code, p_display_name),
    /* 공개 방 (public.sql §2.5, 같은 오류 코드·확인 순서) */
    public_ack_version: () => PUBLIC_ACK_VERSION,
    public_create_status() {
      if (!uid()) throw raise('not_authenticated');
      return createStatus();
    },
    create_room({ p_display_name, p_room_name, p_visibility, p_description, p_ack_version }) {
      if (!uid()) throw raise('not_authenticated');
      if (roomCount(uid()) >= MAX_ROOMS) throw raise('too_many_rooms');
      if (textLen(p_room_name) < 1 || textLen(p_room_name) > 30) throw raise('invalid_room_name');
      if (textLen(p_display_name) < 1 || textLen(p_display_name) > 20) throw raise('invalid_display_name');
      if (!['private', 'public'].includes(p_visibility)) throw raise('invalid_visibility');
      const pub = p_visibility === 'public', desc = String(p_description ?? '').trim();
      if ((pub && [...desc].length > 60) || (!pub && desc)) throw raise('invalid_description');
      if (pub && String(p_display_name).trim().toLowerCase() === loginIdOf(uid())) throw raise('nickname_is_login_id');
      if (pub && p_ack_version !== PUBLIC_ACK_VERSION) throw raise('ack_required');
      if (pub) { const s = createStatus(); if (!s.allowed) throw raise(s.reason); }
      const id = uuid(), t = nowIso();
      db.couples.push({
        id, name: String(p_room_name).trim(), created_by: uid(), created_at: t, invite_code: newCode(), deleting_at: null,
        visibility: p_visibility, description: pub ? desc : '', public_key: pub ? newKey() : null, public_hidden_at: null,
      });
      db.couple_members.push({ couple_id: id, user_id: uid(), role: 'owner', color: freeColor(id), display_name: String(p_display_name).trim(), created_at: t });
      ['맛집', '카페', '술집', '디저트', '놀거리', '여행', '성당', '기타'].forEach((name, i) => db.categories.push({ id: uuid(), couple_id: id, name, position: i + 1, created_at: t }));
      return id;
    },
    set_room_description({ p_couple, p_description }) {
      const me = lockMember(p_couple);
      if (me.role !== 'owner') throw raise('description_owner_only');
      const room = db.couples.find((r) => r.id === p_couple);
      if (room.visibility !== 'public') throw raise('not_public');
      const d = String(p_description ?? '').trim();
      if ([...d].length > 60) throw raise('invalid_description');
      room.description = d;
      return d;
    },
    // 방장만, 모든 방. 예전 코드는 바로 invalid_code
    regenerate_invite_code({ p_couple }) {
      const me = lockMember(p_couple);
      if (me.role !== 'owner') throw raise('invite_owner_only');
      const room = db.couples.find((r) => r.id === p_couple);
      room.invite_code = newCode();
      return room.invite_code;
    },
    rename_room({ p_couple, p_name }) {
      const me = lockMember(p_couple);
      if (me.role !== 'owner') throw raise('not_owner');
      if (textLen(p_name) < 1 || textLen(p_name) > 30) throw raise('invalid_room_name');
      db.couples.find((r) => r.id === p_couple).name = String(p_name).trim();
      return String(p_name).trim();
    },
    // 팔레트 id 또는 '#rrggbb' (대소문자·앞뒤 공백 정리). 같은 값 color_taken, 거리 < 0.03 color_too_close (colors.sql §10.5)
    set_member_color({ p_couple, p_color }) {
      const me = lockMember(p_couple);
      const c = String(p_color ?? '').trim().toLowerCase();
      if (!Object.hasOwn(PALETTE, c) && !HEX.test(c)) throw raise('invalid_color');
      if (me.color === c) return c;
      const others = membersOf(p_couple).filter((m) => m.user_id !== uid());
      if (others.some((m) => m.color === c)) throw raise('color_taken');
      if (others.some((m) => (colorDistance(m.color, c) ?? 1) < NEAR)) throw raise('color_too_close');
      me.color = c;
      return c;
    },
    begin_room_delete({ p_couple }) {
      lockMember(p_couple);
      if (membersOf(p_couple).some((m) => m.user_id !== uid())) throw raise('not_last_member');
      db.couples.find((r) => r.id === p_couple).deleting_at = nowIso();
      const placeIds = new Set(db.places.filter((p) => p.couple_id === p_couple).map((p) => p.id));
      return db.place_photos.filter((ph) => placeIds.has(ph.place_id)).flatMap((ph) => [ph.path, ph.thumb_path]).filter(Boolean).sort(); // 썸네일도 (public.sql)
    },
    leave_room({ p_couple }) {
      const me = lockMember(p_couple);
      const room = db.couples.find((r) => r.id === p_couple);
      if (!membersOf(p_couple).some((m) => m.user_id !== uid())) {
        // groups.sql과 같게: begin_room_delete를 15분 안에 불렀을 때만 방을 지움
        if (!room.deleting_at || Date.now() - Date.parse(room.deleting_at) >= DELETE_BLOCK_MS) throw raise('last_member');
        cascadeDelete('couples', room);
        db.couples = db.couples.filter((r) => r !== room);
        return { room_deleted: true, new_owner: null };
      }
      db.couple_members = db.couple_members.filter((m) => m !== me); // groups.sql과 같게 멤버 줄을 먼저 지움
      const placeIds = new Set(db.places.filter((p) => p.couple_id === p_couple).map((p) => p.id));
      db.reviews = db.reviews.filter((r) => !(placeIds.has(r.place_id) && r.author_id === uid()));
      db.visits = db.visits.filter((v) => !(placeIds.has(v.place_id) && v.created_by === uid() && !db.reviews.some((r) => r.visit_id === v.id)));
      db.cup_results = db.cup_results.filter((c) => !(c.couple_id === p_couple && c.user_id === uid()));
      let newOwner = null;
      if (me.role === 'owner') {
        const next = membersOf(p_couple).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.user_id.localeCompare(b.user_id))[0];
        next.role = 'owner';
        newOwner = next.user_id;
      }
      return { room_deleted: false, new_owner: newOwner };
    },
  };
  async function rpc(name, args = {}) {
    await wait();
    calls.push({ kind: 'rpc', name, args: clone(args) });
    const fn = RPC[name];
    if (!fn) return { data: null, error: pgErr('PGRST202', `Could not find the function public.${name} in the schema cache`), status: 404 };
    try { return { data: clone(fn(args)), error: null, status: 200 }; }
    catch (err) { if (err && err.code) return { data: null, error: err, status: 400 }; throw err; }
  }

  /* ---------- storage ---------- */
  const photoRoomOk = (path) => { const p = placeById(String(path).split('/')[0]); return !!p && isMember(p.couple_id); };
  const storage = {
    from(bucket) {
      if (bucket !== BUCKET) throw new Error(`mock: 모르는 버킷 ${bucket}`);
      return {
        async createSignedUrls(paths) {
          await wait();
          calls.push({ kind: 'storage', op: 'sign', n: paths.length });
          return { data: paths.map((p) => (files.has(p) && photoRoomOk(p) ? { path: p, signedUrl: files.get(p), error: null } : { path: p, signedUrl: null, error: 'Object not found' })), error: null };
        },
        async upload(path, blob) {
          await wait();
          calls.push({ kind: 'storage', op: 'upload', path });
          if (!photoRoomOk(path)) return { data: null, error: { message: 'new row violates row-level security policy for table "objects"', statusCode: '403' } };
          if (files.has(path)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
          files.set(path, URL.createObjectURL(blob));
          return { data: { path }, error: null };
        },
        async remove(paths) {
          await wait();
          calls.push({ kind: 'storage', op: 'remove', paths: [...paths] });
          const gone = paths.filter((p) => files.has(p));
          gone.forEach((p) => files.delete(p));
          return { data: gone.map((name) => ({ name })), error: null };
        },
      };
    },
  };

  /* ---------- auth ---------- */
  const authErr = (message, status, code) => ({ name: 'AuthApiError', message, status, code });
  const auth = {
    async getSession() { await wait(); return { data: { session: clone(session) }, error: null }; },
    onAuthStateChange(cb) {
      listeners.add(cb);
      setTimeout(() => cb('INITIAL_SESSION', clone(session)), 0);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    async signInWithPassword({ email, password }) {
      await wait();
      const user = users.find((u) => u.email === String(email || '').trim().toLowerCase());
      if (!user || String(password || '').length < 8) return { data: { user: null, session: null }, error: authErr('Invalid login credentials', 400, 'invalid_credentials') };
      session = makeSession(user.id);
      emit('SIGNED_IN');
      return { data: { user: clone(session.user), session: clone(session) }, error: null };
    },
    async signOut() { await wait(); session = null; emit('SIGNED_OUT'); return { error: null }; },
    async setSession({ access_token }) {
      await wait();
      const s = sessions.get(access_token);
      if (!s) return { data: { user: null, session: null }, error: authErr('Invalid Refresh Token', 400, 'refresh_token_not_found') };
      session = s;
      emit('SIGNED_IN');
      return { data: { user: clone(s.user), session: clone(s) }, error: null };
    },
    async updateUser({ password }) {
      await wait();
      if (!session) return { data: { user: null }, error: authErr('Auth session missing!', 400, 'session_not_found') };
      if (String(password || '').length < 8) return { data: { user: null }, error: authErr('Password should be at least 8 characters.', 422, 'weak_password') };
      return { data: { user: clone(session.user) }, error: null };
    },
  };

  /* ---------- 홈 서버 API (deploy/home/signup.cjs와 같은 응답·문구) ---------- */
  const MSG = {
    badCode: '이 초대 코드로는 가입할 수 없어요. 코드를 다시 확인하거나 새 코드를 받아 주세요.',
    codeFormat: '초대 코드를 다시 확인해 주세요. (W로 시작하는 가입 코드나 8자리 방 코드)',
    username: '아이디는 영문 소문자·숫자와 . _ - 로 3~20자예요. (맨 앞은 영문이나 숫자)',
    password: '비밀번호는 8~72자로 입력해 주세요.',
    displayName: '앱에서 보일 이름을 1~20자로 입력해 주세요.',
    duplicate: '이미 쓰는 아이디예요. 다른 아이디를 골라 주세요.',
    spaceCode: '8자리 방 초대 코드를 다시 확인해 주세요.',
    joinInvalid: '초대 코드를 다시 확인해 주세요.',
    joinFull: '이 방은 이미 5명이 모두 찼어요.',
    tooManyRooms: '방은 3개까지 들어갈 수 있어요. 다른 방에서 나간 뒤 다시 시도해 주세요.',
    login: '로그인이 끝났어요. 다시 로그인해 주세요.',
    needAck: '공개 방이에요. 안내를 읽고 동의하면 들어갈 수 있어요.',
    nickIsId: '공개 방에서는 아이디와 같은 닉네임을 쓸 수 없어요. 별명을 정해 주세요.',
  };
  const SIGNUP_CODE_RE = /^W[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
  const SPACE_CODE_RE = /^[0-9A-F]{8}$/;
  const normCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  /* 공개 방 API (deploy/home/public.cjs, docs/public-rooms-design.md §3.5와 같은 모양). 로그인 필요.
     서버처럼 키를 하나씩 골라 새 객체로 담는다: 초대 코드·방/사용자 uuid·방장 표시·찜·정확한 날짜는 넣지 않음. 날짜는 'YYYY-MM' */
  const KEY_RE = /^[a-km-np-z2-9]{10}$/;
  const PUB_MSG = { gone: '이 공개 방을 찾을 수 없어요.', down: '지금은 공개 방을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.' };
  const kstDay = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
  const month = (iso) => kstDay(iso).slice(0, 7);
  const latest = (list) => list.filter(Boolean).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), list.find(Boolean));
  const listedRoom = (r) => r.visibility === 'public' && !r.public_hidden_at && (!r.deleting_at || Date.now() - Date.parse(r.deleting_at) >= DELETE_BLOCK_MS);
  const joinOrder = (roomId) => membersOf(roomId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.user_id.localeCompare(b.user_id));
  function roomActivity(r) {
    const ps = db.places.filter((p) => p.couple_id === r.id), ids = new Set(ps.map((p) => p.id));
    return latest([r.created_at, ...ps.map((p) => p.created_at), ...db.visits.filter((v) => ids.has(v.place_id)).map((v) => v.created_at),
      ...db.reviews.filter((x) => ids.has(x.place_id)).map((x) => x.updated_at), ...db.place_photos.filter((x) => ids.has(x.place_id)).map((x) => x.created_at)]);
  }
  const daysAgo = (iso) => Math.max(0, Math.round((Date.parse(kstDay(nowIso())) - Date.parse(kstDay(iso))) / 86400e3));
  // 마지막 활동은 날짜 수 대신 묶음만 (public.sql과 같음): 7일 안 week, 31일 안 month, 그 전 older
  const activeOf = (iso) => { const d = daysAgo(iso); return d < 7 ? 'week' : d < 31 ? 'month' : 'older'; };
  // 지도 링크는 아는 지도 주소만 (public.cjs mapUrl과 같은 규칙)
  function mapUrl(v) {
    let u;
    try { u = new URL(String(v || '')); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
    const h = u.hostname;
    const ok = /^(naver\.me|(m\.)?map\.naver\.com|(m\.|pcmap\.)?place\.naver\.com|maps\.app\.goo\.gl|kko\.to|(place\.|m\.)?map\.kakao\.com)$/.test(h)
      || (h === 'goo.gl' && /^\/maps(\/|$)/.test(u.pathname))
      || (/^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h) && (h.startsWith('maps.') || /^\/maps(\/|$)/.test(u.pathname)));
    if (!ok) return null;
    u.protocol = 'https:';
    return u.href;
  }
  const placePhotos = (placeId) => db.place_photos.filter((x) => x.place_id === placeId)
    .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  function publicListItem(r) {
    const ps = db.places.filter((p) => p.couple_id === r.id), ids = new Set(ps.map((p) => p.id));
    return {
      key: r.public_key, name: r.name, description: r.description || '', member_count: joinOrder(r.id).length, colors: joinOrder(r.id).map((m) => m.color),
      place_count: ps.length, visited_count: ps.filter((p) => p.status === 'visited').length,
      review_count: db.reviews.filter((x) => ids.has(x.place_id)).length, active: activeOf(roomActivity(r)),
    };
  }
  function publicView(r) {
    const ms = joinOrder(r.id);
    const no = (who) => { const i = ms.findIndex((m) => m.user_id === who); return i < 0 ? null : `m${i + 1}`; };
    const paused = PUB === 'paused';
    const placeAct = (p) => latest([p.created_at, ...db.visits.filter((v) => v.place_id === p.id).map((v) => v.created_at), ...db.reviews.filter((x) => x.place_id === p.id).map((x) => x.updated_at)]);
    const all = db.places.filter((p) => p.couple_id === r.id).sort((a, b) => Date.parse(placeAct(b)) - Date.parse(placeAct(a)) || a.id.localeCompare(b.id));
    return {
      v: 1, key: r.public_key, name: r.name, description: r.description || '', member_count: ms.length, place_count: all.length,
      truncated: paused || all.length > 300, active: activeOf(roomActivity(r)), photos_paused: paused,
      members: ms.map((m, i) => ({ m: `m${i + 1}`, name: m.display_name, color: m.color })),
      categories: db.categories.filter((c) => c.couple_id === r.id).sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at))).map((c) => c.name),
      places: all.slice(0, 300).map((p) => {
        const phs = placePhotos(p.id);
        return {
          id: p.id, name: p.name, category: p.category, address: p.address ?? null, map_url: mapUrl(p.naver_url), status: p.status,
          shared_note: p.shared_note || '', added_month: month(p.created_at), added_by: no(p.created_by),
          visits: db.visits.filter((v) => v.place_id === p.id).sort((a, b) => b.visited_on.localeCompare(a.visited_on) || b.created_at.localeCompare(a.created_at)).map((v) => ({
            month: v.visited_on.slice(0, 7),
            reviews: db.reviews.filter((x) => x.visit_id === v.id)
              .sort((a, b) => ((no(a.author_id) ? Number(no(a.author_id).slice(1)) : 9) - (no(b.author_id) ? Number(no(b.author_id).slice(1)) : 9)))
              .map((x) => ({ by: no(x.author_id), rating: x.rating == null ? null : Number(x.rating), body: x.body || '' })),
          })),
          photo_count: phs.length,
          // 서버처럼 장소마다 대표(첫) 썸네일만. 2·3번째는 상세를 열 때 /thumbs로
          photos: phs.slice(0, 3).map((x, i) => ({ thumb_url: i === 0 && x.thumb_path && !paused ? rasterPhoto(x.path, 320, 200) : null })),
        };
      }),
    };
  }
  function publicApi(url, init) {
    const token = String((init.headers || {}).authorization || '').replace(/^Bearer\s+/i, '');
    if (!sessions.get(token) || !session) return reply(401, { error: MSG.login, login: true });
    if (String(init.method || 'GET').toUpperCase() !== 'GET') return reply(405, { error: 'GET만 받아요.' });
    if (PUB === 'error') return reply(502, { error: PUB_MSG.down });
    const path = url.pathname;
    if (path === '/api/public/rooms') {
      if (PUB === 'empty') return reply(200, { v: 1, rooms: [] });
      const rooms = db.couples.filter((r) => listedRoom(r) && db.places.some((p) => p.couple_id === r.id))
        .sort((a, b) => Date.parse(roomActivity(b)) - Date.parse(roomActivity(a)) || a.public_key.localeCompare(b.public_key)).slice(0, 50);
      return reply(200, { v: 1, rooms: rooms.map(publicListItem) });
    }
    const m = /^\/api\/public\/rooms\/([^/]+)(\/photo|\/thumbs)?$/.exec(path);
    if (!m) return reply(404, { error: '없는 주소예요.' });
    const r = KEY_RE.test(m[1]) && PUB !== 'gone' ? db.couples.find((x) => x.public_key === m[1] && listedRoom(x)) : null;
    if (!r) return reply(404, { error: PUB_MSG.gone });
    if (!m[2]) return reply(200, publicView(r));
    if (m[2] === '/thumbs') {
      // 상세의 썸네일 (최대 3장)
      const id = url.searchParams.get('place');
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) return reply(400, { error: '요청 형식이 올바르지 않아요' });
      const tp = db.places.find((x) => x.id === id && x.couple_id === r.id);
      if (!tp) return reply(404, { error: '사진을 찾을 수 없어요.' });
      const paused = PUB === 'paused';
      return reply(200, { v: 1, thumbs: placePhotos(tp.id).slice(0, 3).map((x) => (x.thumb_path && !paused ? rasterPhoto(x.path, 320, 200) : null)), photos_paused: paused });
    }
    // 큰 사진 하나 (10분 서명 URL 대신 그린 그림)
    const place = url.searchParams.get('place'), i = Number(url.searchParams.get('i'));
    if (!/^[0-9a-f-]{36}$/i.test(place || '') || !Number.isInteger(i) || i < 0 || i > 2) return reply(400, { error: '요청 형식이 올바르지 않아요' });
    if (PUB === 'paused') return reply(429, { error: '오늘은 사진 보기가 멈췄어요. 내일 다시 보여요.', budget: true }); // = PMSG.budgetDay
    const p = db.places.find((x) => x.id === place && x.couple_id === r.id);
    const ph = p && placePhotos(p.id)[i];
    if (!ph) return reply(404, { error: '사진을 찾을 수 없어요.' });
    return reply(200, { url: rasterPhoto(ph.path, 1080, 675) });
  }
  async function fakeApi(path, init, url) {
    await wait();
    if (path.startsWith('/api/public/')) { calls.push({ kind: 'api', path }); return publicApi(url, init); }
    let body = {};
    try { body = JSON.parse(init.body || '{}'); } catch { return reply(400, { error: '요청 형식이 올바르지 않아요' }); }
    calls.push({ kind: 'api', path });
    if (path === '/api/join') {
      const token = String((init.headers || {}).authorization || '').replace(/^Bearer\s+/i, '');
      const s = sessions.get(token);
      if (!s) return reply(401, { error: MSG.login });
      const code = normCode(body.code);
      if (!SPACE_CODE_RE.test(code)) return reply(400, { error: MSG.spaceCode });
      if (textLen(body.displayName) < 1 || textLen(body.displayName) > 20) return reply(400, { error: MSG.displayName });
      try {
        const j = joinRoom(s.user.id, code, body.displayName, Number.isInteger(body.ackVersion) ? body.ackVersion : null);
        if (j.status === 'need_ack') return reply(409, { error: MSG.needAck, needAck: true, roomName: j.room_name, ackVersion: j.ack_version });
        return reply(200, { joined: true, couple_id: j.couple_id });
      } catch (err) {
        const m = err && err.message;
        if (m === 'invalid_code') return reply(400, { error: MSG.joinInvalid });
        if (m === 'room_full') return reply(400, { error: MSG.joinFull });
        if (m === 'too_many_rooms') return reply(409, { error: MSG.tooManyRooms });
        if (m === 'nickname_is_login_id') return reply(400, { error: MSG.nickIsId, nickIsId: true });
        return reply(502, { error: '참여하지 못했어요. 잠시 후 다시 시도해 주세요.' });
      }
    }
    if (path === '/api/signup') {
      const code = normCode(body.code), username = String(body.username || '').trim().toLowerCase();
      const kind = SIGNUP_CODE_RE.test(code) ? 'invite' : SPACE_CODE_RE.test(code) ? 'space' : '';
      if (!kind) return reply(400, { error: MSG.codeFormat });
      if (!/^[a-z0-9][a-z0-9._-]{2,19}$/.test(username)) return reply(400, { error: MSG.username });
      if (String(body.password || '').length < 8) return reply(400, { error: MSG.password });
      if (textLen(body.displayName) < 1 || textLen(body.displayName) > 20) return reply(400, { error: MSG.displayName });
      if (kind === 'space' && !db.couples.some((r) => r.invite_code === code)) return reply(400, { error: MSG.badCode });
      if (users.some((u) => u.email === `${username}@${DOMAIN}`)) return reply(409, { error: MSG.duplicate });
      // 공개 방 코드: 계정을 만들기 전에 닉네임=아이디·동의를 확인 (signup.cjs §3.8, space_code_info)
      const room = kind === 'space' ? codeRoom(code) : null;
      if (room && room.visibility === 'public') {
        if (String(body.displayName).trim().toLowerCase() === username) return reply(400, { error: MSG.nickIsId, nickIsId: true });
        if (body.ackVersion !== PUBLIC_ACK_VERSION) return reply(409, { error: MSG.needAck, needAck: true, roomName: room.name, ackVersion: PUBLIC_ACK_VERSION });
      }
      const user = { id: uuid(), email: `${username}@${DOMAIN}`, user_metadata: { display_name: String(body.displayName).trim() } };
      users.push(user);
      let coupleId = null;
      if (kind === 'space') {
        try {
          const j = joinRoom(user.id, code, body.displayName, Number.isInteger(body.ackVersion) ? body.ackVersion : null);
          if (j.status === 'need_ack') return reply(409, { error: MSG.needAck, needAck: true, roomName: j.room_name, ackVersion: j.ack_version });
          coupleId = j.couple_id;
        } catch (err) { return reply(400, { error: err.message === 'room_full' ? MSG.joinFull : MSG.badCode }); }
      }
      const s = makeSession(user.id);
      return reply(200, { access_token: s.access_token, refresh_token: s.refresh_token, joined: !!coupleId, couple_id: coupleId });
    }
    return reply(404, { error: 'mock: 이 API는 없어요' }); // /api/place(구글 지도) 등: 앱이 '직접 적어 주세요'로 처리
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) return fakeApi(url.pathname, init, url);
    return realFetch(input, init);
  };

  /* ---------- supabase-js 모양 ---------- */
  window.supabase = {
    createClient(url, key) {
      calls.push({ kind: 'createClient', url, key });
      return { auth, from: (table) => new Query(table), rpc, storage };
    },
  };
  window.__mock = { scene: SCENE, db: () => db, calls, warnings, files, U, ROOM };
})();
