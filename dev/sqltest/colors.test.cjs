'use strict';
// supabase/colors.sql·colors_rollback.sql 시험 (docs/groups-design.md §10, v0.1.2 멤버 색).
// 실행: cd dev/sqltest && npm ci && npm test
// 색 계산(OKLab)은 SQL과 같은 식을 여기 JS로도 만들어, 기존 색 옮기기·되돌리기 결과를 따로 계산해 비교한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT, SQL, uid, newDb, addUsers, run, asUser, ANON, SERVICE, expectError,
  createRoom, codeOf, join, members, count, snapshot,
} = require('./helpers.cjs');

const PERM = /permission denied/;
const NEAR = 0.03; // set_member_color·pick_member_color가 막는 거리(OKLab ΔE, 어느 한 화면에서라도)

// 예전 40색 (groups.sql 순서, 화면 v0.1.1의 밝은 값) — colors.sql·colors_rollback.sql 안의 목록과 같아야 함
const OLD = [
  ['orange', '#d76f05'], ['tangerine', '#c97801'], ['amber', '#bd7a05'], ['mustard', '#a48904'], ['olive', '#8f900d'],
  ['lime', '#73970b'], ['green', '#459d2e'], ['emerald', '#0f9f5c'], ['jade', '#119d7c'], ['teal', '#0e8c86'],
  ['cyan', '#0a9aa1'], ['sky', '#0698b2'], ['azure', '#0296c5'], ['blue', '#0091e4'], ['cobalt', '#4b89f2'],
  ['indigo', '#7281f4'], ['violet', '#9079ef'], ['purple', '#a971e3'], ['orchid', '#be6ad1'], ['pink', '#d362b2'],
  ['orange-deep', '#8d561e'], ['tangerine-deep', '#875913'], ['amber-deep', '#7c5f08'], ['mustard-deep', '#6e640d'],
  ['olive-deep', '#5d681c'], ['lime-deep', '#4a6c2d'], ['green-deep', '#346f3e'], ['emerald-deep', '#13714e'],
  ['jade-deep', '#027060'], ['teal-deep', '#106e6c'], ['cyan-deep', '#126d78'], ['sky-deep', '#076c86'],
  ['azure-deep', '#186994'], ['blue-deep', '#36659a'], ['cobalt-deep', '#4b619d'], ['indigo-deep', '#5d5c9c'],
  ['violet-deep', '#6d5898'], ['purple-deep', '#7a5490'], ['orchid-deep', '#855084'], ['pink-deep', '#904d71'],
].map(([id, light], i) => ({ id, light, position: i + 1 }));

// ---------- OKLab (Björn Ottosson의 식, SQL member_color_lab과 같음) ----------
function lab(hex) {
  const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const delta = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const hueOf = (hex) => { const [, a, b] = lab(hex); return Math.atan2(b, a) * 180 / Math.PI; };
const hueGap = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)); return Math.min(d, 360 - d); };
const chroma = (hex) => { const [, a, b] = lab(hex); return Math.hypot(a, b); };

// 설계 문서 §10 표: | # | id | 이름 | 밝은 | 어두운 |
function designPalette() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'groups-design.md'), 'utf8');
  const start = md.search(/^## 10\. /m);
  assert.ok(start >= 0, '설계 문서에 §10이 있어야 함');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const sec = end >= 0 ? rest.slice(0, end) : rest;
  const out = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^\| (\d+) \| ([a-z]+) \| ([^|]+?) \| (#[0-9A-F]{6}) \| (#[0-9A-F]{6}) \|\s*$/);
    if (m) out[Number(m[1]) - 1] = { id: m[2], name: m[3], light: m[4].toLowerCase(), dark: m[5].toLowerCase() };
  }
  return out;
}
// 설계 문서 §10.6 표(혼자일 때 예전 색 → 새 색): | 예전 | 새 | × 4
function designForward() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'groups-design.md'), 'utf8');
  const sec = md.slice(md.search(/^### 10\.6 /m), md.search(/^### 10\.7 /m));
  const map = {};
  for (const line of sec.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 8 || !cells.every((c) => /^[a-z]+(-deep)?$/.test(c))) continue;
    for (let i = 0; i < 8; i += 2) map[cells[i]] = cells[i + 1];
  }
  return map;
}
// index.html의 MEMBER_COLORS (없으면 null): [{ id, light?, dark? }]
function clientPalette() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/MEMBER_COLORS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  return [...m[1].matchAll(/\{([^}]*)\}/g)].map((x) => {
    const get = (k) => { const v = x[1].match(new RegExp(`${k}:\\s*['"]([^'"]+)['"]`)); return v ? v[1] : undefined; };
    return { id: get('id'), light: get('light') && get('light').toLowerCase(), dark: get('dark') && get('dark').toLowerCase() };
  });
}
async function palette(db) {
  return (await db.query('select id, position, light, dark from public.member_colors order by position')).rows;
}

// 멤버를 색을 정해서 직접 넣은 방 (관리자로. 들어온 순서 = 목록 순서, 첫 사람이 방장)
async function roomWithColors(db, firstUser, colors, name = '방') {
  const ns = colors.map((_, i) => firstUser + i);
  await addUsers(db, ...ns);
  const [c] = (await db.query(
    "insert into public.couples (name, created_by, invite_code) values ($1, $2, upper(encode(extensions.gen_random_bytes(4), 'hex'))) returning id",
    [name, uid(ns[0])])).rows;
  for (let i = 0; i < colors.length; i++) {
    await db.query(
      "insert into public.couple_members (couple_id, user_id, role, display_name, color, created_at) values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))",
      [c.id, uid(ns[i]), i === 0 ? 'owner' : 'member', `n${ns[i]}`, colors[i], i]);
  }
  return c.id;
}
const colorsOf = async (db, room) => (await members(db, room)).map((m) => m.color);

// colors.sql의 옮기기 규칙을 JS로: 들어온 순서대로, 그 방에서 아직 안 받은 새 색 중 색상각 → 거리 → 순서
function expectForward(oldIds, pal) {
  const used = new Set();
  return oldIds.map((id) => {
    const hex = OLD.find((o) => o.id === id).light;
    const best = pal.filter((c) => !used.has(c.id))
      .sort((p, q) => hueGap(hex, p.light) - hueGap(hex, q.light) || delta(hex, p.light) - delta(hex, q.light) || p.position - q.position)[0];
    used.add(best.id);
    return best.id;
  });
}
// colors_rollback.sql의 규칙을 JS로: 회색에 가까우면(채도 < 0.03) 거리, 아니면 선명한 20색 먼저 → 색상각 → 거리 → 순서
function expectBack(tokens, pal) {
  const used = new Set();
  return tokens.map((t) => {
    const hex = t.startsWith('#') ? t : pal.find((c) => c.id === t).light;
    const grey = chroma(hex) < 0.03;
    const best = OLD.filter((o) => !used.has(o.id)).sort((p, q) =>
      (grey ? delta(hex, p.light) - delta(hex, q.light) : 0)
      || (p.position > 20) - (q.position > 20)
      || hueGap(hex, p.light) - hueGap(hex, q.light)
      || delta(hex, p.light) - delta(hex, q.light)
      || p.position - q.position)[0];
    used.add(best.id);
    return best.id;
  });
}

// ---------- 1. 적용 ----------
test('c1. 적용: 24색(무지개 순서), 설계·화면과 같음, 두 번 적용하면 멈춤, groups_schema_version은 1', async (t) => {
  const db = await newDb({ colors: true });
  const rows = await palette(db);
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.map((r) => r.position), Array.from({ length: 24 }, (_, i) => i + 1));
  const design = designPalette();
  assert.equal(design.filter(Boolean).length, 24, '설계 문서 §10 표에서 24개를 읽어야 함');
  assert.deepEqual(rows.map(({ id, light, dark }) => ({ id, light, dark })), design.map(({ id, light, dark }) => ({ id, light, dark })));
  // 무지개 순서: 색상각이 빨강(약 25도)에서 시작해 한 바퀴 돌며 계속 커짐(분홍·장미는 360도를 넘어감)
  const hues = rows.map((r) => { const h = hueOf(r.light); return h < 20 ? h + 360 : h; });
  for (let i = 1; i < hues.length; i++) assert.ok(hues[i] > hues[i - 1], `${rows[i - 1].id} → ${rows[i].id} 색상각이 줄어듦`);
  // 팔레트끼리는 막는 거리(0.03)보다 늘 멂: 다른 멤버 색 옆 칸도 고를 수 있음
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const d = Math.min(delta(rows[i].light, rows[j].light), delta(rows[i].dark, rows[j].dark));
      assert.ok(d >= 0.04, `${rows[i].id}/${rows[j].id} 거리 ${d.toFixed(3)}`);
    }
  }
  // 화면 MEMBER_COLORS: 새 목록이면 id·순서·값 비교, 아직 예전 40색이면 건너뜀
  const client = clientPalette();
  if (!client || client.length === 40) t.diagnostic('index.html MEMBER_COLORS가 아직 v0.1.2 목록이 아니라서 화면 비교는 건너뜀');
  else {
    assert.deepEqual(client.map((c) => c.id), rows.map((r) => r.id), 'index.html MEMBER_COLORS id·순서가 SQL과 다름');
    for (const [i, c] of client.entries()) {
      if (c.light) assert.equal(c.light, rows[i].light, `${c.id} 밝은 값`);
      if (c.dark) assert.equal(c.dark, rows[i].dark, `${c.id} 어두운 값`);
    }
  }
  // SQL의 OKLab 계산이 JS(화면과 같은 식)와 같음
  for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#808080', '#abcdef', rows[5].light]) {
    const [r] = (await db.query('select public.member_color_lab($1) as l', [hex])).rows;
    r.l.forEach((v, i) => assert.ok(Math.abs(v - lab(hex)[i]) < 1e-9, `${hex} OKLab[${i}]`));
  }
  const [{ d }] = (await db.query("select public.member_color_distance('red', '#f53c41') as d")).rows;
  assert.equal(d, 0);

  assert.equal((await run(db, asUser(1), 'select public.groups_schema_version() as v'))[0].v, 1);
  await expectError(db.exec(SQL('colors.sql')), /이미 적용된 SQL이에요/);
  await db.exec('rollback').catch(() => {});
  await expectError(db.exec(SQL('groups.sql')), /이미 적용된 SQL이에요/);
  await db.exec('rollback').catch(() => {});
  assert.equal(await count(db, 'select 1 from public.member_colors'), 24);
  await db.close();
});

test('c1b. groups.sql 없이 실행하면 멈춤, groups_rollback.sql은 colors_rollback.sql 전에는 멈춤', async () => {
  const db = await newDb({ groups: false });
  await expectError(db.exec(SQL('colors.sql')), /먼저 supabase\/groups.sql을 실행하세요/);
  await db.exec('rollback').catch(() => {});
  await expectError(db.exec(SQL('colors_rollback.sql')), /되돌릴 것이 없어요/);
  await db.exec('rollback').catch(() => {});
  await db.exec(SQL('groups.sql'));
  await db.exec(SQL('colors.sql'));
  await expectError(db.exec(SQL('groups_rollback.sql')), /먼저 supabase\/colors_rollback.sql을 실행하세요/);
  await db.exec('rollback').catch(() => {});
  assert.equal(await count(db, 'select 1 from public.member_colors'), 24);
  await db.close();
});

// ---------- 2. 기존 색 옮기기 ----------
test('c2. 기존 멤버 색을 색상각이 가장 가까운 새 색으로 (방 안에서 겹치지 않게), 적용 전 색은 backup', async () => {
  const db = await newDb();
  // 예전 40색을 모두 씀: 앞 8방은 목록 순서대로 5개씩, 뒤 8방은 섞어서(선명한 색과 짙은 색이 한 방에)
  const layouts = [];
  for (let k = 0; k < 8; k++) layouts.push(OLD.slice(k * 5, k * 5 + 5).map((o) => o.id));
  for (let k = 0; k < 8; k++) layouts.push([0, 8, 16, 24, 32].map((i) => OLD[k + i].id));
  // 예전 방장·멤버 색(teal, amber), 겹치는 경우(tangerine 방장 + amber 멤버)
  layouts.push(['teal', 'amber'], ['tangerine', 'amber'], ['orange', 'orange-deep', 'tangerine-deep']);
  const rooms = [];
  let n = 1;
  for (const l of layouts) { rooms.push(await roomWithColors(db, n, l)); n += l.length; }
  const before = (await db.query('select couple_id, user_id, color from public.couple_members order by 1, 2')).rows;

  await db.exec(SQL('colors.sql'));
  const pal = await palette(db);
  for (const [i, room] of rooms.entries()) {
    const got = await colorsOf(db, room);
    assert.deepEqual(got, expectForward(layouts[i], pal), `방 ${i}: ${layouts[i].join(',')}`);
    assert.equal(new Set(got).size, got.length, `방 ${i} 색 겹침`);
  }
  // 눈으로 확인한 몇 가지
  assert.deepEqual(await colorsOf(db, rooms[16]), ['teal', 'tangerine']); // 예전 amber(색상각 71도)는 tangerine(64도)이 가장 가까움
  assert.deepEqual(await colorsOf(db, rooms[17]), ['tangerine', 'amber']); // 방장이 tangerine을 받아서 멤버는 다음으로 가까운 amber
  assert.deepEqual(await colorsOf(db, rooms[18]), ['orange', 'tangerine', 'amber']);
  // 설계 문서 §10.6 표(혼자일 때)가 규칙과 같음
  const doc = designForward();
  assert.equal(Object.keys(doc).length, 40, '§10.6 표에서 40개를 읽어야 함');
  for (const o of OLD) assert.equal(doc[o.id], expectForward([o.id], pal)[0], `§10.6 ${o.id}`);
  // palette_color(자동 계산 칸)는 팔레트 id와 같음
  assert.equal(await count(db, 'select 1 from public.couple_members where palette_color is distinct from color'), 0);
  // 적용 전 색이 backup에 그대로
  const backups = (await db.query("select table_name from information_schema.tables where table_schema = 'backup' and table_name like 'couple_colors_v011_%'")).rows;
  assert.equal(backups.length, 1);
  const saved = (await db.query(`select couple_id, user_id, color from backup.${backups[0].table_name} order by 1, 2`)).rows;
  assert.deepEqual(saved, before);
  await db.close();
});

// ---------- 3. set_member_color: 팔레트 ----------
test('c3. set_member_color(팔레트): 대소문자·공백 정리, 겹침 color_taken, 이상한 값 invalid_color', async () => {
  const db = await newDb({ colors: true });
  await addUsers(db, 1, 2, 3);
  const room = await roomWithColors(db, 1, ['red', 'blue']);
  const sc = (n, color) => run(db, asUser(n), 'select public.set_member_color($1, $2) as color', [room, color]);
  assert.equal((await sc(1, ' Green ')).at(0).color, 'green');
  assert.deepEqual(await colorsOf(db, room), ['green', 'blue']);
  assert.equal((await sc(1, 'green'))[0].color, 'green', '지금 색과 같으면 그대로');
  await expectError(sc(1, 'blue'), 'color_taken');
  await expectError(sc(1, 'BLUE'), 'color_taken');
  // 옆 칸(가장 가까운 팔레트 색)은 고를 수 있음: 팔레트끼리는 막는 거리보다 멂
  assert.equal((await sc(1, 'azure'))[0].color, 'azure');
  assert.equal((await sc(1, 'cobalt'))[0].color, 'cobalt');
  for (const bad of ['gold', 'orange-deep', 'teal-deep', '', '   ', 'ff0000', '#fff', '#ggg000', '#ff00000', '#ff000', 'red;', 'rgb(1,2,3)']) {
    await expectError(sc(1, bad), 'invalid_color').catch((e) => { throw new Error(`${JSON.stringify(bad)}: ${e.message}`); });
  }
  await expectError(sc(1, null), 'invalid_color');
  await expectError(sc(3, 'pink'), 'not_member');
  await expectError(run(db, { role: 'authenticated' }, 'select public.set_member_color($1, $2)', [room, 'pink']), 'not_authenticated');
  await expectError(run(db, ANON, 'select public.set_member_color($1, $2)', [room, 'pink']), PERM);
  // 1번이 버린 색은 2번이 바로 고를 수 있음
  assert.equal((await sc(2, 'green'))[0].color, 'green');
  await db.close();
});

// ---------- 4. set_member_color: 직접 고른 색 ----------
test('c4. set_member_color(직접 고른 색): #rrggbb 소문자로 저장, 같은 값 color_taken, 거의 같은 색 color_too_close', async () => {
  const db = await newDb({ colors: true });
  const room = await roomWithColors(db, 1, ['red', 'teal', 'blue']);
  const sc = (n, color) => run(db, asUser(n), 'select public.set_member_color($1, $2) as color', [room, color]);
  const pal = await palette(db);
  const P = Object.fromEntries(pal.map((c) => [c.id, c]));

  assert.equal((await sc(1, ' #ABCDEF '))[0].color, '#abcdef');
  const [m1] = (await db.query('select color, palette_color from public.couple_members where couple_id = $1 and user_id = $2', [room, uid(1)])).rows;
  assert.deepEqual(m1, { color: '#abcdef', palette_color: null });
  assert.equal((await sc(1, '#AbCdEf'))[0].color, '#abcdef', '같은 색(대소문자만 다름)이면 그대로');
  // 같은 값
  await expectError(sc(2, '#abcdef'), 'color_taken');
  await expectError(sc(2, '#ABCDEF'), 'color_taken');
  // 거의 같은 값 (거리 < 0.03)
  assert.ok(delta('#abcdef', '#abcdee') < NEAR);
  await expectError(sc(2, '#abcdee'), 'color_too_close');
  // 다른 멤버의 팔레트 색과 같은 값: 밝은 화면 값, 어두운 화면 값 모두 막음 (어느 한 화면에서라도 같아 보이면)
  await expectError(sc(1, P.blue.light), 'color_too_close');
  await expectError(sc(1, P.blue.dark), 'color_too_close');
  await expectError(sc(1, P.teal.light.toUpperCase()), 'color_too_close');
  // 반대로, 다른 멤버가 직접 고른 색과 거의 같은 팔레트 색도 막음
  await sc(1, P.green.light); // 1번: 초록의 밝은 화면 값을 직접 고름
  await expectError(sc(2, 'green'), 'color_too_close');
  // 조금 다르면(거리 0.03 이상) 저장됨 — 화면은 0.08 미만이면 비슷하다고 알려 줌(§10)
  const near = '#20b050';
  const d = delta(near, P.green.light);
  assert.ok(d >= NEAR && d < 0.08, `시험 색 거리 ${d}`);
  await sc(1, '#123456');
  assert.equal((await sc(2, near))[0].color, near);
  // 아주 어둡거나 밝은 색, 회색도 받음
  for (const hex of ['#000000', '#ffffff', '#808080']) assert.equal((await sc(3, hex))[0].color, hex);
  // 앱은 color 칸을 직접 못 바꿈, 관리자라도 형식이 틀리거나 없는 팔레트 id면 제약에 걸림
  await expectError(run(db, asUser(1), "update public.couple_members set color = '#000001' where couple_id = $1 and user_id = $2", [room, uid(1)]), PERM);
  await expectError(db.query("update public.couple_members set color = '#ABCDEF' where couple_id = $1 and user_id = $2", [room, uid(1)]), /couple_members_color_check/);
  await expectError(db.query("update public.couple_members set color = 'gold' where couple_id = $1 and user_id = $2", [room, uid(1)]), /couple_members_palette_color_fkey/);
  await expectError(db.query("update public.couple_members set color = $3 where couple_id = $1 and user_id = $2", [room, uid(1), near]), /couple_members_couple_color_key/);
  await db.close();
});

// ---------- 5. 무작위 색 ----------
test('c5. 새 멤버 무작위 색: 새 24색 중 아무도 안 쓰고 다른 멤버 색과 거의 같지 않은 색', async () => {
  const db = await newDb({ colors: true });
  const pal = await palette(db);
  const P = Object.fromEntries(pal.map((c) => [c.id, c]));
  // 방: 팔레트 2개 + 직접 고른 색 2개(각각 yellow·violet의 밝은/어두운 값과 거의 같음)
  const room = await roomWithColors(db, 1, ['red', 'mint', '#f7cd04', P.violet.dark]);
  const excluded = new Set(['red', 'mint', 'yellow', 'violet']);
  for (const c of pal) {
    const near = (await colorsOf(db, room)).some((t) => {
      const f = t.startsWith('#') ? [t, t] : [P[t].light, P[t].dark];
      return Math.min(delta(f[0], c.light), delta(f[1], c.dark)) < NEAR;
    });
    assert.equal(near, excluded.has(c.id), `${c.id} 제외 여부`);
  }
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const [{ c }] = (await db.query('select public.pick_member_color($1) as c', [room])).rows;
    assert.ok(P[c], `팔레트 id가 아님: ${c}`);
    assert.ok(!excluded.has(c), `막혀야 하는 색: ${c}`);
    seen.add(c);
  }
  assert.ok(seen.size > 10, `무작위가 아님: ${[...seen]}`);
  // 함수로 들어온 멤버(트리거가 고름)도 같음
  await addUsers(db, 9);
  const code = await codeOf(db, room);
  await join(db, 9, code);
  const c9 = (await members(db, room)).find((m) => m.user_id === uid(9)).color;
  assert.ok(P[c9] && !excluded.has(c9), c9);
  // 새로 만든 방의 방장 색도 새 목록에서
  await addUsers(db, 10);
  const r10 = await createRoom(db, 10);
  assert.ok(P[(await members(db, r10))[0].color]);
  await expectError(run(db, asUser(1), 'select public.pick_member_color($1)', [room]), PERM);
  await db.close();
});

// ---------- 6. 권한·RLS ----------
test('c6. 권한·RLS: 정책·표 권한 그대로, 색 표·색 계산 함수는 앱에서 못 씀, 방끼리 색이 안 보임', async () => {
  const db = await newDb();
  const before = await snapshot(db);
  await db.exec(SQL('colors.sql'));
  const after = await snapshot(db);
  assert.deepEqual(after.policies, before.policies, 'RLS 정책이 바뀜');
  assert.deepEqual(after.tableAcl, before.tableAcl, '표 권한이 바뀜');
  assert.deepEqual(after.columnAcl, before.columnAcl, '칸 권한이 바뀜');
  assert.deepEqual(after.triggers, before.triggers, '트리거가 바뀜');
  // 바뀐 함수: set_member_color·pick_member_color 본문 + 새 색 계산 함수 5개. 권한은 그대로
  const names = (s) => s.functions.map((f) => f.split(' | ')[0]);
  assert.deepEqual(names(after).filter((x) => !names(before).includes(x)).sort(), [
    'member_color_delta(text,text)', 'member_color_distance(text,text)', 'member_color_fills(text)',
    'member_color_hue_gap(text,text)', 'member_color_lab(text)',
  ]);
  const acl = (s, name) => s.functions.find((f) => f.startsWith(name)).split(' | ').at(-1);
  for (const f of ['set_member_color(uuid,text)', 'pick_member_color(uuid)']) assert.equal(acl(after, f), acl(before, f), `${f} 권한`);

  await addUsers(db, 1, 2, 3);
  const a = await createRoom(db, 1, 'A');
  const b = await createRoom(db, 3, 'B');
  await join(db, 2, await codeOf(db, a));
  await run(db, asUser(1), "select public.set_member_color($1, '#123456')", [a]);
  for (const who of [asUser(1), ANON]) {
    await expectError(run(db, who, 'select * from public.member_colors'), PERM);
    for (const sql of ["select public.member_color_lab('#000000')", "select public.member_color_delta('#000000', '#ffffff')",
      "select public.member_color_hue_gap('#000000', '#ffffff')", "select public.member_color_fills('red')",
      "select public.member_color_distance('red', 'blue')"]) {
      await expectError(run(db, who, sql), PERM).catch((e) => { throw new Error(`${sql}: ${e.message}`); });
    }
  }
  // 멤버는 내 방들의 멤버 색(직접 고른 색 포함)만 봄
  const seen = await run(db, asUser(2), 'select couple_id, color from public.couple_members order by created_at');
  assert.deepEqual(new Set(seen.map((r) => r.couple_id)), new Set([a]));
  assert.ok(seen.some((r) => r.color === '#123456'));
  assert.equal((await run(db, asUser(1), 'select color from public.couple_members where couple_id = $1', [b])).length, 0);
  // 다른 방 멤버 색은 못 바꿈
  await expectError(run(db, asUser(1), "select public.set_member_color($1, 'pink')", [b]), 'not_member');
  // security definer 함수는 모두 search_path = '' (새 색 계산 함수도 search_path 고정)
  const bad = (await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.prosecdef or p.proname like 'member_color_%')
      and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows.map((r) => r.proname);
  assert.deepEqual(bad, []);
  await db.close();
});

// ---------- 7. 되돌리기 ----------
test('c7. 되돌리기: 직접 고른 색은 backup 후 예전 40색 중 가까운 색, 구조·함수·권한은 groups.sql 적용 뒤와 같음, 다시 적용 가능', async () => {
  const db = await newDb();
  const afterGroups = await snapshot(db);
  const colorsBefore = (await db.query('select id, position from public.member_colors order by position')).rows;
  await db.exec(SQL('colors.sql'));
  const afterColors = await snapshot(db);
  const pal = await palette(db);

  // 방 A: 팔레트 + 직접 고른 색(선명한 자홍, 회색, 청록에 가까운 색), 방 B: 겹치는 색(teal 두 번째 후보로)
  const layoutA = ['teal', '#ff00ff', '#7f7f80', '#05a8a0', 'rose'];
  const layoutB = ['#0e8c86', 'teal', 'mint'];
  const a = await roomWithColors(db, 1, layoutA, 'A');
  const b = await roomWithColors(db, 10, layoutB, 'B');
  const c = await roomWithColors(db, 20, ['red', 'coral', 'orange', 'tangerine', 'amber'], 'C');
  const now = (await db.query('select couple_id, user_id, color from public.couple_members order by 1, 2')).rows;

  await db.exec(SQL('colors_rollback.sql'));

  const after = await snapshot(db);
  for (const k of Object.keys(afterGroups)) assert.deepEqual(after[k], afterGroups[k], `되돌린 뒤 ${k}가 groups.sql 적용 뒤와 다름`);
  assert.deepEqual((await db.query('select id, position from public.member_colors order by position')).rows, colorsBefore);
  // 색 옮기기: JS로 따로 계산한 결과와 같음
  assert.deepEqual(await colorsOf(db, a), expectBack(layoutA, pal));
  assert.deepEqual(await colorsOf(db, b), expectBack(layoutB, pal));
  assert.deepEqual(await colorsOf(db, c), expectBack(['red', 'coral', 'orange', 'tangerine', 'amber'], pal));
  assert.equal((await colorsOf(db, a))[0], 'teal', '새 teal → 예전 teal');
  assert.ok(['jade', 'teal', 'cyan'].includes((await colorsOf(db, b))[1]));
  for (const room of [a, b, c]) {
    const got = await colorsOf(db, room);
    assert.equal(new Set(got).size, got.length);
    // 회색에 가까운 직접 고른 색(방 A의 셋째)만 거리로 고르므로 짙은 색일 수 있음. 나머지는 선명한 20색
    const colorful = room === a ? got.filter((_, i) => i !== 2) : got;
    assert.ok(colorful.every((x) => !x.endsWith('-deep')), `선명한 20색 먼저: ${got}`);
  }
  // 직접 고른 색을 포함한 지금 색이 backup에
  const backups = (await db.query("select table_name from information_schema.tables where table_schema = 'backup' and table_name like 'couple_colors_v012_%'")).rows;
  assert.equal(backups.length, 1);
  assert.deepEqual((await db.query(`select couple_id, user_id, color from backup.${backups[0].table_name} order by 1, 2`)).rows, now);
  // 예전 set_member_color가 돌아옴: 직접 고른 색은 invalid_color
  await expectError(run(db, asUser(1), "select public.set_member_color($1, '#abcdef')", [a]), 'invalid_color');
  assert.equal((await run(db, asUser(1), "select public.set_member_color($1, 'pink-deep') as c", [a]))[0].c, 'pink-deep');

  // 다시 적용: 처음 적용과 같은 구조·함수
  await db.exec(SQL('colors.sql'));
  const again = await snapshot(db);
  for (const k of Object.keys(afterColors)) assert.deepEqual(again[k], afterColors[k], `다시 적용한 뒤 ${k}가 처음 적용과 다름`);
  assert.equal(await count(db, 'select 1 from public.couple_members where color like $1', ['%-deep']), 0);
  await db.close();
});
