"""화면 확인용 스크린샷 (가짜 Supabase, 바깥 네트워크 없음).

필요: Python Playwright(pip install playwright), Microsoft Edge(기본, channel="msedge") 또는 --chromium(playwright install chromium)
사용: python dev/mock/shoot.py [--out dev/screens] [--port 8099] [--chromium] [--only all|base|public]
  - 30번대 장면은 v0.2.0 공개 방(둘러보기, 읽기 전용, 내 방에 담기, 동의, 초대 코드 다시 만들기). 읽기 전용 장면은 M4 자동 확인
    (초대 코드·copy-code·regen-code·찜이 화면에 없음, 허용 목록 밖 단추를 강제로 눌러도 쓰기 없음, 가로 스크롤 없음). 실패하면 종료 코드 1
  - dev/mock/serve.mjs가 안 떠 있으면 직접 띄우고 끝나면 끔 (node 필요)
  - 휴대폰 크기 390x844, 기기 배율 2, 밝은 화면과 어두운 화면
  - 127.0.0.1 말고 다른 곳으로 가는 요청은 모두 막고 report.json에 남김
  - 확인 창(confirm)은 헤드리스 스크린샷에 안 찍혀서, 문구를 받아 같은 글로 화면 위에 다시 그려 찍음(표시해 둠)
끝나면 out/report.json: 장면마다 콘솔 오류, 가로로 넘친 요소, 잘린 글자(…), 확인 창 문구, 방 조건이 빠진 조회 경고
"""
import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

# 화면 검사: 가로로 넘친 요소(가로 스크롤 상자 안은 뺌)와 말줄임(…)으로 잘린 글자
CHECK_JS = r"""
() => {
  const W = document.documentElement.clientWidth;
  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  };
  const scrollsX = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  const overflow = [], truncated = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if ((r.right > W + 0.5 || r.left < -0.5) && !scrollsX(el) && getComputedStyle(el).position !== 'fixed') overflow.push(`${label(el)} left=${r.left.toFixed(1)} right=${r.right.toFixed(1)}`);
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) truncated.push(label(el));
  }
  const sb = document.querySelector('.sheet-body');
  return {
    docScrollWidth: document.documentElement.scrollWidth, viewport: W,
    sheetScrollsX: !!sb && sb.scrollWidth > sb.clientWidth + 1,
    overflow: overflow.slice(0, 20), truncated: [...new Set(truncated)].slice(0, 30),
    warnings: (window.__mock && window.__mock.warnings) ? [...new Set(window.__mock.warnings)] : [],
  };
}
"""
# 시트 안에서 그 요소가 위에 오게 스크롤
SCROLL_TO_JS = r"""
(el) => { const b = el.closest('.sheet-body'); if (!b) { el.scrollIntoView({ block: 'start' }); return; }
  b.scrollTop += el.getBoundingClientRect().top - b.getBoundingClientRect().top - 8; }
"""
# 확인 창을 대신 그림 (실제 브라우저 창 모양을 흉내 낸 것, 문구는 앱이 띄운 그대로)
DIALOG_JS = r"""
([msg, step]) => {
  const d = document.createElement('div');
  d.id = '__dialog';
  d.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.5 system-ui,sans-serif';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;color:#202124;border-radius:12px;padding:20px 20px 12px;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  const t = document.createElement('div'); t.textContent = `${location.host} 내용:${step ? ` (${step})` : ''}`; t.style.cssText = 'font-weight:600;margin-bottom:10px';
  const m = document.createElement('div'); m.textContent = msg; m.style.cssText = 'white-space:pre-wrap;word-break:keep-all';
  const b = document.createElement('div'); b.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
  for (const [txt, bg, fg] of [['취소', '#fff', '#1a73e8'], ['확인', '#1a73e8', '#fff']]) { const x = document.createElement('span'); x.textContent = txt; x.style.cssText = `padding:8px 16px;border-radius:18px;border:1px solid #dadce0;background:${bg};color:${fg};font-weight:600`; b.append(x); }
  const note = document.createElement('div'); note.textContent = '※ 브라우저 기본 확인 창(confirm). 헤드리스 화면에 안 찍혀서 앱이 띄운 문구 그대로 다시 그림';
  note.style.cssText = 'font-size:11px;color:#5f6368;margin-top:10px';
  box.append(t, m, b, note); d.append(box); document.body.append(d);
}
"""


# M4 (docs/public-rooms-design.md §6.4): 읽기 전용 화면에 초대 코드(가짜 DB의 모든 방)·copy-code·regen-code·찜이 없는지, 가로 스크롤이 없는지
M4_JS = r"""
() => {
  const db = window.__mock.db();
  const html = document.body.innerHTML;
  return {
    leakedCodes: db.couples.map((c) => c.invite_code).filter((c) => c && html.includes(c)),
    forbidden: ['copy-code', 'regen-code', 'toggle-fav', 'settings', 'add', 'edit', 'delete-place', 'save-note'].filter((a) => document.querySelector(`[data-action="${a}"]`)),
    favTab: !!document.querySelector('[data-action=tab][data-tab=fav]'),
    scrollX: document.documentElement.scrollWidth > window.innerWidth,
  };
}
"""
# 읽기 전용에서 허용 목록 밖 단추를 강제로 눌러도(el.click()) 쓰기 호출·시트가 생기지 않는지
FORCE_CLICK_JS = r"""
async () => {
  const calls = window.__mock.calls, before = calls.length;
  const sheetBefore = document.querySelector('#sheet-root').innerHTML;
  for (const a of ['delete-place', 'add', 'settings', 'toggle-fav', 'copy-code', 'regen-code', 'set-status', 'save-note', 'leave-room']) {
    const b = document.createElement('button');
    b.dataset.action = a;
    document.body.append(b);
    b.click();
    b.remove();
  }
  await new Promise((r) => setTimeout(r, 300));
  const writes = calls.slice(before).filter((c) => (c.kind === 'from' && c.op !== 'select') || c.kind === 'rpc' || (c.kind === 'storage' && c.op !== 'sign'));
  return { writes: writes.length, sheetChanged: document.querySelector('#sheet-root').innerHTML !== sheetBefore };
}
"""


# 읽기 전용 상세의 2·3번째 썸네일은 상세를 연 뒤 /thumbs로 받음: 그 요청이 끝날 때까지(최대 3초) 기다림
THUMBS_WAIT_JS = r"""
() => window.__mock.calls.some((c) => c.kind === 'api' && c.path.includes('/thumbs'))
"""


def wait_thumbs(p):
    try:
        p.wait_for_function(THUMBS_WAIT_JS, timeout=3000)
    except Exception:
        return  # 사진이 한 장뿐인 장소는 부르지 않음
    p.wait_for_timeout(400)


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


class Shooter:
    def __init__(self, browser, base, out):
        self.browser, self.base, self.out = browser, base, out
        self.report = {}
        self.blocked = []
        self.m4_fail = 0

    def new_page(self, scene, dark=False, path='/', width=390, height=844):
        ctx = self.browser.new_context(
            viewport={'width': width, 'height': height}, device_scale_factor=2, is_mobile=True, has_touch=True,
            locale='ko-KR', timezone_id='Asia/Seoul', color_scheme='dark' if dark else 'light', reduced_motion='reduce',
        )

        def route(r):
            if r.request.url.startswith(self.base) or r.request.url.startswith(('data:', 'blob:')):
                r.continue_()
            else:
                self.blocked.append(r.request.url)
                r.abort()
        ctx.route('**/*', route)
        page = ctx.new_page()
        page.errors, page.dialogs, page.dialog_plan, page.dialogs_seen = [], [], [], 0
        page.on('console', lambda m: m.type in ('error', 'warning') and page.errors.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: page.errors.append(f'pageerror: {e}'))

        def on_dialog(d):
            page.dialogs.append(d.message)
            (d.accept if page.dialog_plan and page.dialog_plan.pop(0) == 'accept' else d.dismiss)()
        page.on('dialog', on_dialog)
        page.goto(f'{self.base}{path}?{scene}')
        page.wait_for_function("() => !document.querySelector('#app .loading') && document.querySelector('#app').children.length > 0")
        return page

    def settle(self, page):
        page.wait_for_function("() => !document.querySelector('#app .loading')")
        # 사진(data:)까지 그려지고 알림이 내려갈 때까지
        page.wait_for_function("() => [...document.images].every((i) => i.complete)")
        page.wait_for_function("() => !document.querySelector('#toast.show')", timeout=6000)
        page.wait_for_timeout(250)

    def shot(self, page, name, full=False, keep_toast=False):
        if not keep_toast:
            self.settle(page)
        else:
            page.wait_for_timeout(300)
        page.screenshot(path=str(self.out / f'{name}.png'), full_page=full)
        info = page.evaluate(CHECK_JS)
        info['console'] = list(page.errors)
        info['dialogs'] = page.dialogs[page.dialogs_seen:]  # 이 장면에서 새로 뜬 확인 창만
        page.dialogs_seen = len(page.dialogs)
        self.report[name] = info
        print(f'  {name}.png  넘침 {len(info["overflow"])}  잘림 {len(info["truncated"])}  오류 {len(info["console"])}')

    def scroll_to(self, page, selector):
        page.evaluate(SCROLL_TO_JS, page.locator(selector).first.element_handle())
        page.wait_for_timeout(150)

    def sheet_bottom(self, page):
        page.evaluate("() => { const b = document.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; }")
        page.wait_for_timeout(150)

    def m4(self, page, name, force=False):
        r = page.evaluate(M4_JS)
        if force:
            r.update(page.evaluate(FORCE_CLICK_JS))
        ok = not r['leakedCodes'] and not r['forbidden'] and not r['favTab'] and not r['scrollX'] and not r.get('writes') and not r.get('sheetChanged')
        r['ok'] = ok
        self.report.setdefault(name, {})['m4'] = r
        self.m4_fail += 0 if ok else 1
        print(f'  {name}  M4 {"통과" if ok else "실패 " + json.dumps(r, ensure_ascii=False)}')

    def dialog_shot(self, page, name, msg, step=''):
        page.evaluate(DIALOG_JS, [msg, step])
        self.shot(page, name, keep_toast=True)
        self.report[name]['dialogs'] = [msg]
        page.evaluate("() => document.getElementById('__dialog').remove()")


def run(sh):
    # 1) 방 고르기 (방 3개: 새 방 버튼 대신 3개 안내)
    p = sh.new_page('mock=picker')
    p.wait_for_selector('text=어느 방으로 갈까요?')
    sh.shot(p, '01-room-picker')
    p.context.close()
    # 1b) 방 2개: 새 방 만들기·코드로 참여 버튼
    p = sh.new_page('mock=two')
    p.wait_for_selector('text=어느 방으로 갈까요?')
    sh.shot(p, '01b-room-picker-2rooms')
    p.context.close()

    # 2) 5명 방 메인, 다녀온 곳(별점 칩·도장), 장소 상세(후기 여러 개)
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('.top .title')
    sh.shot(p, '02-main-5members')
    sh.shot(p, '02b-main-5members-full', full=True)
    # 2b) 위쪽 방 이름 ⌄ → 방 바꾸기 시트 (방 3개라 새 방 버튼 대신 안내)
    p.click('.top [data-action=rooms]')
    p.wait_for_selector('.sheet #sheet-title:text-is("방 바꾸기")')
    sh.shot(p, '02c-header-room-menu-3rooms')
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=tab][data-tab=visited]')
    sh.shot(p, '03-main-visited-chips')
    sh.shot(p, '03b-main-visited-full', full=True)
    p.click('button.place:has-text("골목 끝 칼국수")')
    p.wait_for_selector('.sheet .detail-name')
    sh.shot(p, '04-detail-top')
    sh.scroll_to(p, '.block-head:has-text("방문 기록")')
    sh.shot(p, '05-detail-reviews')
    p.locator('[data-action=edit-visit]').first.click()
    p.wait_for_selector('#my-review')
    sh.scroll_to(p, '.visit >> nth=0')
    sh.shot(p, '05c-detail-edit-my-review')
    p.click('[data-action=cancel-visit]')
    p.click('.sheet-head [data-action=close]')

    # 3) 내 정보 (멤버, 5명 다 찬 방): 방·멤버·초대 코드 → 닉네임·색 → 방 바꾸기 → 맨 아래 나가기
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    sh.shot(p, '06-settings-top')
    sh.scroll_to(p, '#name-form')
    sh.shot(p, '07-settings-nick-color')
    # 3b) 직접 고르기: 열기 → 다른 멤버 색과 거의 같음(막힘) → 비슷함(안내만) → 저장
    p.click('[data-action=custom-color]')
    p.wait_for_selector('#custom-hex')
    sh.scroll_to(p, '#color-group')
    sh.shot(p, '07b-color-custom-open')
    p.fill('#custom-hex', '#F5B010')
    p.wait_for_selector('#custom-note.error')
    sh.shot(p, '07c-color-custom-too-close')
    p.fill('#custom-hex', 'ff5fa2')
    p.wait_for_selector('#custom-note.warn')
    sh.shot(p, '07d-color-custom-similar')
    p.fill('#custom-hex', '#FF6F61')
    p.wait_for_selector('#custom-note.ok')
    p.click('#custom-save')
    p.wait_for_selector('.custom-pick .swatch.on')
    sh.scroll_to(p, '#color-group')
    sh.shot(p, '07e-color-custom-saved', keep_toast=True)
    sh.scroll_to(p, '.settings-group:has(h3:text-is("방 바꾸기"))')
    sh.shot(p, '08-settings-room-switch')
    sh.sheet_bottom(p)
    sh.shot(p, '09-settings-bottom-leave')
    # 3c) 계정 설정 (비밀번호 변경·로그아웃은 여기로 옮김) → ‹ 로 내 정보로 돌아옴
    p.click('.nav-row[data-action=account]')
    p.wait_for_selector('#pw-form')
    sh.shot(p, '09b-account-sheet')
    p.click('.sheet-head [data-action=close]')
    p.wait_for_selector('.sheet #sheet-title:text-is("내 정보")')
    sh.sheet_bottom(p)
    # 4) 나가기 확인 (다른 멤버가 남는 방): 취소로 닫음
    p.click('[data-action=leave-room]')
    p.wait_for_timeout(600)
    if p.dialogs:
        sh.dialog_shot(p, '10-leave-confirm', p.dialogs[-1])
    # 5) 월드컵: 새 월드컵 → 역대 기록(황금 도장 없음) → 한 판 끝내기(내 색 도장)
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=cup]')
    p.wait_for_selector('[data-action=cup-start]')
    sh.shot(p, '15-cup-setup')
    p.click('[data-action=cup-tab][data-tab=records]')
    p.wait_for_selector('.rec')
    sh.shot(p, '16-cup-records')
    sh.sheet_bottom(p)
    sh.shot(p, '16b-cup-records-bottom')
    p.click('[data-action=cup-tab][data-tab=new]')
    p.click('[data-action=cup-start]')
    for _ in range(12):
        if p.locator('.cup-win').count():
            break
        p.locator('.pick').first.click()
        p.wait_for_timeout(120)
    p.wait_for_selector('.win-msg, .cup-win .error', timeout=5000)
    sh.shot(p, '17-cup-win-my-stamp', keep_toast=True)
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=tab][data-tab=visited]')
    sh.shot(p, '17b-main-visited-after-cup')
    p.click('[data-action=tab][data-tab=want_to_go]')
    sh.shot(p, '17c-main-custom-color-in-use')
    p.context.close()

    # 6) 방장 내 정보 (3명 방: 방 이름 고치기, 초대 코드)
    p = sh.new_page('mock=picker&go=B')
    p.wait_for_selector('.top .title')
    p.click('[data-action=settings]')
    p.wait_for_selector('#room-name-form')
    sh.shot(p, '11-settings-owner')
    p.context.close()

    # 7) 혼자인 방: 메인 초대 코드 띠, 마지막 멤버 나가기 확인 두 번 (첫 번째 확인, 두 번째 취소 → 아무것도 안 지움)
    p = sh.new_page('mock=picker&go=C')
    p.wait_for_selector('.invite')
    sh.shot(p, '12-main-solo-invite')
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    sh.sheet_bottom(p)
    sh.shot(p, '12b-settings-solo-bottom')
    p.dialog_plan[:] = ['accept', 'dismiss']
    p.click('[data-action=leave-room]')
    p.wait_for_timeout(800)
    for i, msg in enumerate(p.dialogs, 1):
        sh.dialog_shot(p, f'13-leave-last-confirm-{i}', msg, f'{i}/{len(p.dialogs)}')
    p.context.close()

    # 8) 새 방 만들기 시트 (방 2개라 버튼이 있음): 내 정보 → 방 바꾸기 → 새 방 만들기 / 코드로 참여
    p = sh.new_page('mock=two&go=A')
    p.wait_for_selector('.top .title')
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    sh.scroll_to(p, '.settings-group:has(h3:text-is("방 바꾸기"))')
    sh.shot(p, '08b-settings-room-switch-2rooms')
    p.click('.settings-group [data-action=room-new][data-mode=create]')
    p.wait_for_selector('#room-form[data-mode=create]')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.shot(p, '14-room-new-sheet')
    p.click('[data-action=room-mode][data-mode=join]')
    p.wait_for_selector('#room-form[data-mode=join]')
    sh.shot(p, '14b-room-join-sheet')
    p.context.close()
    # 8b) 참가자도 위쪽 방 이름으로: 방 바꾸기 시트(방 2개 → 새 방 버튼) → 코드로 참여 → 뒤로 가기로 방 바꾸기 시트에 돌아옴
    p = sh.new_page('mock=two&go=A')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.wait_for_selector('.sheet #sheet-title:text-is("방 바꾸기")')
    sh.shot(p, '14c-header-room-menu-2rooms')
    p.click('.sheet [data-action=room-new][data-mode=join]')
    p.wait_for_selector('#room-form[data-mode=join]')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.shot(p, '14d-join-from-room-menu')
    p.go_back()
    p.wait_for_selector('.sheet #sheet-title:text-is("방 바꾸기")')
    sh.shot(p, '14e-back-to-room-menu')
    p.locator('.sheet [data-action=pick-room]').first.click()
    p.wait_for_selector('.top .title:has-text("회사 점심")')
    sh.shot(p, '14f-switched-from-room-menu')
    p.context.close()

    # 9) 시작하기 (방 0개) → 다 찬 방 코드(오류) → 3명 방 코드로 참여(홈 서버 /api/join 흉내)
    p = sh.new_page('mock=onboard')
    p.wait_for_selector('#room-form')
    sh.shot(p, '23-onboard')
    p.click('[data-action=room-mode][data-mode=join]')
    p.fill('#room-form [name=code]', '7f3a-9c21')
    p.click('#room-form [type=submit]')
    p.wait_for_function("() => document.querySelector('#room-form .error').textContent")
    sh.shot(p, '24-join-full-room-error')
    p.fill('#room-form [name=code]', 'B42E08D5')
    p.click('#room-form [type=submit]')
    p.wait_for_selector('.top .title')
    sh.shot(p, '25-after-join-main', keep_toast=True)
    p.context.close()

    # 10) 흐름 확인: 방 2개에서 새 방 만들기 → 그 방으로(초대 띠) / 멤버로 나가기 → 남은 방 고르기
    p = sh.new_page('mock=two&go=A')
    p.wait_for_selector('.top .title')
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    p.click('.settings-group [data-action=room-new][data-mode=create]')
    p.fill('#room-form [name=room]', '  보드게임 카페 투어  ')
    p.click('#room-form [type=submit]')
    p.wait_for_selector('.invite')
    sh.shot(p, '26-after-create-room', keep_toast=True)
    p.click('[data-action=settings]')
    p.wait_for_selector('#room-name-form')
    sh.scroll_to(p, '.settings-group:has(h3:text-is("방 바꾸기"))')
    sh.shot(p, '26b-settings-3rooms-switch')
    p.locator('.settings-group [data-action=pick-room]:has-text("주말 맛집 탐방대")').click()
    p.wait_for_selector('.top .title:has-text("주말 맛집 탐방대")')
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    sh.sheet_bottom(p)
    p.dialog_plan[:] = ['accept']
    p.click('[data-action=leave-room]')
    p.wait_for_selector('text=어느 방으로 갈까요?')
    sh.shot(p, '27-after-leave-picker', keep_toast=True)
    p.context.close()

    # 11) 어두운 화면
    p = sh.new_page('mock=picker&go=A', dark=True)
    p.wait_for_selector('.top .title')
    sh.shot(p, '18-dark-main')
    p.click('[data-action=tab][data-tab=visited]')
    sh.shot(p, '19-dark-visited')
    p.click('button.place:has-text("골목 끝 칼국수")')
    p.wait_for_selector('.sheet .detail-name')
    sh.scroll_to(p, '.block-head:has-text("방문 기록")')
    sh.shot(p, '20-dark-detail-reviews')
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=settings]')
    p.wait_for_selector('#swatches')
    sh.scroll_to(p, '#name-form')
    sh.shot(p, '21-dark-settings-color')
    p.click('[data-action=custom-color]')
    p.fill('#custom-hex', '#9B6A45')
    p.wait_for_selector('#custom-note.warn')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.scroll_to(p, '#color-group')
    sh.shot(p, '21b-dark-color-custom')
    p.click('[data-action=account]')
    p.wait_for_selector('#pw-form')
    sh.shot(p, '21c-dark-account-sheet')
    p.click('.sheet-head [data-action=close]')
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=cup]')
    p.click('[data-action=cup-tab][data-tab=records]')
    p.wait_for_selector('.rec')
    sh.shot(p, '22-dark-cup-records')
    p.context.close()
    p = sh.new_page('mock=picker', dark=True)
    p.wait_for_selector('text=어느 방으로 갈까요?')
    sh.shot(p, '22b-dark-room-picker')
    p.click('[data-action=pick-room]:has-text("주말 맛집")')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.wait_for_selector('.sheet #sheet-title:text-is("방 바꾸기")')
    sh.shot(p, '22c-dark-header-room-menu')
    p.context.close()


def run_public(sh):
    """v0.2.0 공개 방 장면 (docs/public-rooms-design.md §6.4). M4 확인은 읽기 전용 장면마다"""
    # 30) 방 고르기의 돋보기와 첫 안내, 31) 방 바꾸기 시트 머리의 돋보기
    p = sh.new_page('mock=picker')
    p.wait_for_selector('text=어느 방으로 갈까요?')
    sh.shot(p, '30-picker-magnifier')
    p.context.close()
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.wait_for_selector('.sheet #sheet-title:text-is("방 바꾸기")')
    sh.shot(p, '31-rooms-sheet-magnifier')
    p.context.close()
    # 32) 시작하기 화면의 '공개 방 둘러보기' 링크
    p = sh.new_page('mock=onboard')
    p.wait_for_selector('#room-form')
    sh.shot(p, '32-onboard-explore-link')
    p.context.close()

    # 33) 둘러보기 목록 → 검색 결과 없음 → 남의 공개 방(읽기 전용) → 상세 → 큰 사진 → 내 방에 담기 → 담은 방으로
    p = sh.new_page('mock=picker')
    p.wait_for_selector('text=어느 방으로 갈까요?')
    p.click('[data-action=explore]')
    p.wait_for_selector('.ex-card')
    sh.shot(p, '33-explore-list')
    p.fill('#explore-q', '냉면')
    p.wait_for_selector('#explore-list .empty-state')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.shot(p, '33b-explore-search-empty')
    p.click('[data-action=explore-clear]')
    p.click('.ex-card:has-text("서울 라멘 지도")')
    p.wait_for_selector('.visit-band')
    p.wait_for_selector('button.place')
    sh.shot(p, '34-visit-main')
    sh.m4(p, '34-visit-main', force=True)
    p.click('button.place:has-text("멘야 하나")')
    p.wait_for_selector('.sheet .detail-name')
    wait_thumbs(p)
    sh.shot(p, '35-visit-detail')
    sh.m4(p, '35-visit-detail', force=True)
    sh.sheet_bottom(p)
    sh.shot(p, '35a-visit-detail-bottom')
    p.locator('.sheet [data-action=view-photo]').first.click()
    p.wait_for_selector('.viewer img')
    sh.shot(p, '35b-visit-photo-large')
    p.click('[data-action=close-viewer]')
    p.click('[data-action=copy-open]')
    p.wait_for_selector('.sheet #sheet-title:text-is("내 방에 담기")')
    sh.shot(p, '36-copy-sheet')
    sh.m4(p, '36-copy-sheet')
    p.click('[data-action=copy-room]:has-text("회사 점심")')
    p.click('[data-action=copy-save]')
    p.wait_for_selector('.copy-done')
    sh.shot(p, '36b-copy-done')
    sh.m4(p, '36b-copy-done')
    p.click('[data-action=visit-close][data-go]')
    p.wait_for_selector('.sheet .detail-name:has-text("멘야 하나")')
    sh.shot(p, '36c-copy-opened-in-room')
    p.context.close()
    # 36d) 방이 없는 사람(시작하기 → 공개 방 둘러보기)의 내 방에 담기: '새 방 만들기' 단추 → 36e) 시작하기의 방 만들기
    p = sh.new_page('mock=onboard')
    p.wait_for_selector('#room-form')
    p.click('[data-action=explore]')
    p.wait_for_selector('.ex-card')
    p.click('.ex-card:has-text("서울 라멘 지도")')
    p.wait_for_selector('button.place')
    p.click('button.place:has-text("멘야 하나")')
    p.wait_for_selector('.sheet .detail-name')
    p.click('[data-action=copy-open]')
    p.wait_for_selector('[data-action=copy-create]')
    sh.shot(p, '36d-copy-no-room')
    sh.m4(p, '36d-copy-no-room')
    p.click('[data-action=copy-create]')
    p.wait_for_selector('#room-form[data-mode=create]')
    sh.shot(p, '36e-copy-create-onboard')
    p.context.close()
    # 33c) 둘러보기 실패, 41) 없는 방(링크로), 42) 사진 멈춤
    p = sh.new_page('mock=picker&pub=error')
    p.click('[data-action=explore]')
    p.wait_for_selector('[data-action=explore-retry]')
    sh.shot(p, '33c-explore-error')
    p.context.close()
    p = sh.new_page('mock=picker', path='/r/zzzzzzzzzz')
    p.wait_for_selector('.visit-band')
    p.wait_for_selector('text=이 공개 방을 찾을 수 없어요')
    sh.shot(p, '41-visit-gone')
    p.context.close()
    p = sh.new_page('mock=picker&pub=paused', path='/r/k7m2p9xa4c')
    p.wait_for_selector('.visit-note')
    sh.shot(p, '42-visit-photos-paused')
    sh.m4(p, '42-visit-photos-paused')
    p.context.close()

    # 37) 공개 방 만들기 (방 2개라 만들 수 있음): 공개 카드 고르기·소개·이해했어요
    p = sh.new_page('mock=two&go=A')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.click('.sheet [data-action=room-new][data-mode=create]')
    p.wait_for_selector('#room-form[data-mode=create] [data-vis=public]')
    p.click('[data-vis=public]')
    p.fill('#room-form [name=room]', '서울 브런치 지도')
    p.fill('#room-form [name=description]', '주말 아침에 가 본 브런치 카페')
    p.fill('#room-form [name=name]', '브런치러버')
    p.check('#room-form [name=ack]')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.scroll_to(p, '#room-form [role=radiogroup]')
    sh.shot(p, '37-create-public')
    p.click('#room-form [data-action=public-guide]')  # 안내를 그 자리에서 펼침 (적던 값 그대로)
    p.wait_for_selector('#room-form .pub-guide:not([hidden])')
    sh.scroll_to(p, '#room-form .pub-guide')
    sh.shot(p, '37a-create-public-guide')
    p.context.close()
    p = sh.new_page('mock=two&go=A&pub=gap')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.click('.sheet [data-action=room-new][data-mode=create]')
    p.wait_for_selector('#pub-reason:not([hidden])')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.shot(p, '37b-create-public-gap')
    p.context.close()

    # 38) 코드로 참여하는데 공개 방: 동의 시트 → 동의하고 참여
    p = sh.new_page('mock=two&go=A')
    p.wait_for_selector('.top .title')
    p.click('.top [data-action=rooms]')
    p.click('.sheet [data-action=room-new][data-mode=join]')
    p.fill('#room-form [name=code]', 'C0FFEE01')
    p.fill('#room-form [name=name]', '라멘초보')
    p.click('#room-form [type=submit]')
    p.wait_for_selector('.sheet #sheet-title:text-is("공개 방이에요")')
    sh.shot(p, '38-join-ack-sheet')
    p.click('[data-action=ack-accept]')
    p.wait_for_selector('.top .title:has-text("서울 라멘 지도")')
    sh.shot(p, '38a-after-join-public', keep_toast=True)
    p.context.close()
    # 38b) 가입하는데 공개 방 코드: 계정을 만들기 전에 동의 시트
    p = sh.new_page('mock=login')
    p.click('[data-action=auth-mode][data-mode=signup]')
    p.fill('#signup-form [name=code]', 'C0FFEE01')
    p.fill('#signup-form [name=username]', 'newbie')
    p.fill('#signup-form [name=name]', '새내기')
    p.fill('#signup-form [name=password]', 'password123')
    p.fill('#signup-form [name=password2]', 'password123')
    p.click('#signup-form [type=submit]')
    p.wait_for_selector('.sheet #sheet-title:text-is("공개 방이에요")')
    sh.shot(p, '38b-signup-ack-sheet')
    p.context.close()

    # 39) 공개 방 방장의 내 정보: 공개 방 묶음, 초대 코드 다시 만들기 / 40) 방문자에게 보이는 모습 / 메인의 두 줄 초대 띠
    p = sh.new_page('mock=picker&go=C')
    p.wait_for_selector('.invite.pub')
    sh.shot(p, '40b-main-public-invite')
    # 공개 방에서 쓰는 순간의 한 줄 안내: 장소 추가 폼 맨 위, 상세의 사진·메모
    p.click('[data-action=add]')
    p.wait_for_selector('#place-form .pub-hint')
    p.evaluate("() => document.activeElement && document.activeElement.blur()")
    sh.shot(p, '40c-public-add-hint')
    p.click('.sheet-head [data-action=close]')
    p.click('button.place:has-text("오름 일출 코스")')
    p.wait_for_selector('.sheet .detail-name')
    sh.scroll_to(p, '.photo-actions')
    sh.shot(p, '40d-public-detail-hints')
    p.click('.sheet-head [data-action=close]')
    p.click('[data-action=settings]')
    p.wait_for_selector('#room-desc-form')
    sh.scroll_to(p, '.settings-group:has(#room-desc-form)')
    sh.shot(p, '39-settings-public-owner')
    p.click('[data-action=visit-self]')
    p.wait_for_selector('.visit-band:has-text("방문자에게 보이는 모습")')
    p.wait_for_selector('button.place')
    sh.shot(p, '40-visit-self')
    sh.m4(p, '40-visit-self', force=True)
    p.context.close()
    # 39b) 개인 방 방장: 초대 코드 다시 만들기 확인 창 → 확인 → 새 코드가 바로 보임
    p = sh.new_page('mock=picker&go=B')
    p.wait_for_selector('.top .title')
    p.click('[data-action=settings]')
    p.wait_for_selector('[data-action=regen-code]')
    sh.scroll_to(p, '.settings-group:has(.code-box)')
    old = p.locator('.code-box').inner_text()
    p.click('[data-action=regen-code]')  # 처음엔 취소: 코드 그대로
    p.wait_for_timeout(500)
    if p.dialogs:
        sh.dialog_shot(p, '39b-regen-confirm', p.dialogs[-1])
    assert p.locator('.code-box').inner_text() == old, '취소했는데 초대 코드가 바뀜'
    p.dialog_plan[:] = ['accept']
    p.click('[data-action=regen-code]')
    p.wait_for_function("(old) => document.querySelector('.code-box') && document.querySelector('.code-box').textContent !== old", arg=old)
    sh.scroll_to(p, '.settings-group:has(.code-box)')
    sh.shot(p, '39c-regen-done', keep_toast=True)
    new = p.locator('.code-box').inner_text()
    stale = p.evaluate("(old) => window.__mock.db().couples.some((c) => c.invite_code === old)", old)
    sh.report['39c-regen-done']['regen'] = {'old': old, 'new': new, 'oldStillWorks': stale}
    print(f'  초대 코드 {old} → {new}, 예전 코드 남음: {stale}')
    p.context.close()

    # 43) 어두운 화면: 둘러보기, 읽기 전용 메인·상세, 내 방에 담기
    p = sh.new_page('mock=picker', dark=True)
    p.wait_for_selector('text=어느 방으로 갈까요?')
    p.click('[data-action=explore]')
    p.wait_for_selector('.ex-card')
    sh.shot(p, '43b-dark-explore')
    p.click('.ex-card:has-text("서울 라멘 지도")')
    p.wait_for_selector('button.place')
    sh.shot(p, '43-dark-visit-main')
    sh.m4(p, '43-dark-visit-main')
    p.click('button.place:has-text("멘야 하나")')
    p.wait_for_selector('.sheet .detail-name')
    sh.shot(p, '43c-dark-visit-detail')
    p.click('[data-action=copy-open]')
    p.wait_for_selector('.sheet #sheet-title:text-is("내 방에 담기")')
    sh.shot(p, '43d-dark-copy-sheet')
    p.context.close()
    p = sh.new_page('mock=picker&go=C', dark=True)
    p.wait_for_selector('.invite.pub')
    p.click('[data-action=settings]')
    p.wait_for_selector('#room-desc-form')
    sh.scroll_to(p, '.settings-group:has(#room-desc-form)')
    sh.shot(p, '43e-dark-settings-public')
    p.context.close()

    # 44) 360px 폰: 읽기 전용 메인(띠 한 줄), 내 방에 담기
    p = sh.new_page('mock=picker', path='/r/k7m2p9xa4c', width=360, height=780)
    p.wait_for_selector('button.place')
    sh.shot(p, '44-visit-360')
    sh.m4(p, '44-visit-360')
    p.click('button.place:has-text("멘야 하나")')
    p.click('[data-action=copy-open]')
    p.wait_for_selector('.sheet #sheet-title:text-is("내 방에 담기")')
    sh.shot(p, '44b-copy-sheet-360')
    p.context.close()


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')  # Windows 콘솔(cp1252 등)에서도 한글 출력
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(ROOT / 'dev' / 'screens'))
    ap.add_argument('--port', type=int, default=8099)
    ap.add_argument('--chromium', action='store_true', help='Edge 대신 Playwright Chromium')
    ap.add_argument('--only', choices=['all', 'base', 'public'], default='all', help='base = v0.1.x 장면, public = 공개 방 장면(30번대)')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    server = None
    if not port_open(a.port):
        server = subprocess.Popen(['node', str(HERE / 'serve.mjs'), str(a.port)], cwd=str(ROOT))
        for _ in range(50):
            if port_open(a.port):
                break
            time.sleep(0.1)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, **({} if a.chromium else {'channel': 'msedge'}))
            sh = Shooter(browser, f'http://127.0.0.1:{a.port}', out)
            try:
                if a.only in ('all', 'base'):
                    run(sh)
                if a.only in ('all', 'public'):
                    run_public(sh)
            finally:
                sh.report['_blocked_requests'] = sh.blocked
                sh.report['_m4_failures'] = sh.m4_fail
                (out / 'report.json').write_text(json.dumps(sh.report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
                browser.close()
    finally:
        if server:
            server.terminate()
    print(f'끝: {out}  (막은 바깥 요청 {len(sh.blocked)}개, M4 실패 {sh.m4_fail}개)')
    return 1 if sh.m4_fail else 0


if __name__ == '__main__':
    sys.exit(main())
