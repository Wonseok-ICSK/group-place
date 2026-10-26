"""화면 확인용 스크린샷 (가짜 Supabase, 바깥 네트워크 없음).

필요: Python Playwright(pip install playwright), Microsoft Edge(기본, channel="msedge") 또는 --chromium(playwright install chromium)
사용: python dev/mock/shoot.py [--out dev/screens] [--port 8099] [--chromium] [--only all|base|public|roulette|swipe]
  - 30번대 장면은 v0.2.0 공개 방(둘러보기, 읽기 전용, 내 방에 담기, 동의, 초대 코드 다시 만들기). 읽기 전용 장면은 M4 자동 확인
    (초대 코드·copy-code·regen-code·찜이 화면에 없음, 허용 목록 밖 단추를 강제로 눌러도 쓰기 없음, 가로 스크롤 없음). 실패하면 종료 코드 1
  - dev/mock/serve.mjs가 안 떠 있으면 직접 띄우고 끝나면 끔 (node 필요)
  - 50번대 장면은 v0.4.0 룰렛(고르기, 원판 도는 중·결과, 이름 넘기기, 후보 부족, 공유, 1280x800). 원판은 움직임을 켜고 찍고,
    바늘 아래 칸이 뽑힌 칸인지·움직임 줄이기면 바로 결과인지·닫으면 타이머가 멈추는지도 확인(실패하면 종료 코드 1)
  - 70번대 장면은 v0.4.1 목록을 옆으로 밀어 탭 넘기기. 손가락은 CDP 터치로 움직이고(원래 앱 W1~W12와 같은 경우),
    읽기 전용은 두 탭만·쓰기 없음, 칩 줄·사진 줄은 그쪽만 움직이는지, 미는 도중 화면이 새로 그려져도 다음 탭에 카드가 열리는지,
    확대해서 보는 중에는 목록 위에서도 화면이 옆으로 옮겨지는지도 확인(실패하면 종료 코드 1)
  - 휴대폰 크기 390x844, 기기 배율 2, 밝은 화면과 어두운 화면
  - 127.0.0.1 말고 다른 곳으로 가는 요청은 모두 막고 report.json에 남김
  - 확인 창(confirm)은 헤드리스 스크린샷에 안 찍혀서, 문구를 받아 같은 글로 화면 위에 다시 그려 찍음(표시해 둠)
끝나면 out/report.json: 장면마다 콘솔 오류, 가로로 넘친 요소, 잘린 글자(…), 확인 창 문구, 방 조건이 빠진 조회 경고
"""
import argparse
import base64
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
        self.checks_fail = 0

    def check(self, name, what, ok, detail=None):
        self.report.setdefault(name, {}).setdefault('checks', {})[what] = {'ok': bool(ok), 'detail': detail}
        self.checks_fail += 0 if ok else 1
        print(f'  {name}  {what}: {"통과" if ok else "실패 " + json.dumps(detail, ensure_ascii=False)}')

    # motion=True: 움직임 줄이기를 끔 (룰렛이 실제로 도는 모습). mobile=False: PC 화면(마우스, 터치 없음)
    def new_page(self, scene, dark=False, path='/', width=390, height=844, motion=False, mobile=True):
        ctx = self.browser.new_context(
            viewport={'width': width, 'height': height}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile,
            locale='ko-KR', timezone_id='Asia/Seoul', color_scheme='dark' if dark else 'light',
            reduced_motion='no-preference' if motion else 'reduce',
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


# 룰렛: 바늘 끝 바로 아래(원판 위쪽 테두리 안)의 칸이 뽑힌 칸(.win)인지. 결과 카드 이름과 같은 칸인지도.
# 도는 원판(svg)의 상자는 기울면 커지므로 잘라 두는 둥근 틀(.rl-face, 돌지 않음) 기준으로 잼
POINTER_JS = r"""
() => {
  const disc = document.querySelector('.rl-disc'), face = document.querySelector('.rl-face');
  if (!disc || !face) return { ok: false, why: 'no wheel' };
  const b = face.getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height * (25 / 300);
  const el = document.elementFromPoint(x, y);
  const g = el && el.closest('g');
  const name = document.querySelector('.rl-result h3 b');
  return { ok: !!g && g.classList.contains('win'), slice: g ? g.getAttribute('class') : null,
    label: g && g.querySelector('text') ? g.querySelector('text').textContent : null, winner: name ? name.textContent : null,
    transform: disc.style.transform, hit: el ? `${el.tagName}.${el.getAttribute('class') || ''}` : null, at: [Math.round(x), Math.round(y)] };
}
"""
# 도는 동안 시트가 옆으로 밀리는지(가로 스크롤이 생기는지) 50ms마다 재 둠
OVERFLOW_WATCH_JS = r"""
() => { window.__rlOver = 0; clearInterval(window.__rlWatch);
  window.__rlWatch = setInterval(() => { const b = document.querySelector('.sheet-body');
    if (b) window.__rlOver = Math.max(window.__rlOver, b.scrollWidth - b.clientWidth, document.documentElement.scrollWidth - innerWidth); }, 50); }
"""
# 공유: 공유 창(그림+글)을 흉내 내 받은 파일을 돌려줌 → 결과 그림을 파일로 저장해 눈으로 확인
SHARE_FILES_JS = r"""
() => new Promise((resolve) => {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!(d && d.files && d.files.length) });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
    const f = d.files && d.files[0];
    const url = f ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) : null;
    resolve({ title: d.title, text: d.text, type: f && f.type, name: f && f.name, size: f && f.size, url });
  } });
  document.querySelector('[data-action=roulette-share]').click();
})
"""
# 공유 창이 없는 PC: 클립보드 복사 (ok=false면 복사도 실패 → 고를 수 있는 글)
SHARE_COPY_JS = r"""
(ok) => {
  for (const k of ['share', 'canShare']) Object.defineProperty(navigator, k, { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { if (!ok) throw new Error('denied'); window.__copied = t; } } });
  document.querySelector('[data-action=roulette-share]').click();
}
"""


def open_roulette(p):
    p.click('.top [data-action=roulette]')
    p.wait_for_selector('.sheet #sheet-title:text-is("룰렛")')


# 단추 가운데를 마우스로 두 번 누름. 첫 누름으로 화면이 바뀐 뒤 그 자리에 무엇이 있는지(두 번째 누름이 간 곳)도 돌려줌
def dblclick_center(p, selector):
    loc = p.locator(selector).first
    loc.scroll_into_view_if_needed()
    b = loc.bounding_box()
    x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    p.mouse.dblclick(x, y)
    under = p.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); const a = e && e.closest('[data-action]');"
                       " return a ? a.dataset.action : (e ? e.tagName : null); }", [x, y])
    return {'at': [round(x), round(y)], 'nowUnder': under}


def run_roulette(sh):
    """v0.4.0 룰렛 장면 (docs/roulette-design.md). 원판은 후보 12곳 이하, 이름 넘기기는 13곳 이상(&many=1의 B 방)"""
    for dark in (False, True):
        n = 6 if dark else 5  # 어두운 화면은 60번대
        d = 'dark-' if dark else ''
        # 50) 고르기: 처음엔 가고 싶은 곳만 → 다녀온 곳도 넣기 + 한 곳 빼기
        p = sh.new_page('mock=picker&go=A', dark=dark, motion=True)
        p.wait_for_selector('.top .title')
        open_roulette(p)
        sh.shot(p, f'{n}0-{d}roulette-setup')
        p.click('#rl-visited')
        p.wait_for_selector('#rl-visited:checked')
        p.click('[data-action=roulette-skip] >> nth=3')
        p.wait_for_selector('.rl-cand.off')
        sh.shot(p, f'{n}0b-{d}roulette-setup-visited')
        # 51) 원판이 도는 중 → 52) 결과 (바늘 아래 칸 = 뽑힌 칸)
        p.evaluate(OVERFLOW_WATCH_JS)
        p.click('[data-action=roulette-spin]')
        p.wait_for_selector('.rl-disc')
        p.wait_for_timeout(1100)
        sh.shot(p, f'{n}1-{d}roulette-wheel-spinning', keep_toast=True)
        p.wait_for_selector('#rl-result', timeout=6000)
        sh.shot(p, f'{n}2-{d}roulette-wheel-result')
        over = p.evaluate('() => { clearInterval(window.__rlWatch); return window.__rlOver; }')
        sh.check(f'{n}1-{d}roulette-wheel-spinning', 'no-sideways-scroll', over <= 1, {'maxOverflowPx': over})
        r = p.evaluate(POINTER_JS)
        sh.check(f'{n}2-{d}roulette-wheel-result', 'pointer', r['ok'] and r['label'] and r['winner'] and (r['label'].rstrip('…') in r['winner']), r)
        if not dark:
            # 다시 돌리기: 같은 후보(9곳)로 한 번 더, 끝나면 다시 바늘 확인
            p.wait_for_timeout(500)  # 결과가 막 나온 뒤 잠깐(RL_SETTLE_MS)은 결과 단추를 무시
            p.click('#rl-again')
            p.wait_for_selector('#rl-result', state='detached')
            p.wait_for_selector('#rl-result', timeout=6000)
            r = p.evaluate(POINTER_JS)
            sh.check('52-roulette-wheel-result', 'pointer-again', r['ok'], r)
            # 이 장소 열기 → 상세(‹) → 뒤로 오면 결과 그대로
            p.wait_for_timeout(500)
            p.click('[data-action=roulette-open]')
            p.wait_for_selector('.sheet .detail-name')
            back = p.get_attribute('.sheet-head [data-action=close]', 'aria-label')
            p.click('.sheet-head [data-action=close]')
            p.wait_for_selector('#rl-result')
            sh.check('52-roulette-wheel-result', 'open-and-back', back == '뒤로', {'closeLabel': back})
            # 결과 카드는 지금 장소 값으로: 상세에서 상태를 바꾸고(다녀왔어요 ↔ 가고 싶은 곳) 돌아오면 카드도 바뀜
            was_visited = '다녀온 곳' in p.inner_text('.rl-result .rl-sub')
            p.click('[data-action=roulette-open]')
            p.wait_for_selector('.sheet .detail-name')
            p.click(f'[data-action=set-status][data-status={"want_to_go" if was_visited else "visited"}]')
            p.wait_for_selector(f'[data-action=set-status][data-status={"want_to_go" if was_visited else "visited"}][aria-pressed=true]')
            p.click('.sheet-head [data-action=close]')
            p.wait_for_selector('#rl-result')
            sub = p.inner_text('.rl-result .rl-sub')
            sh.check('52-roulette-wheel-result', 'live-after-edit', ('가고 싶은 곳' if was_visited else '다녀온 곳') in sub, {'wasVisited': was_visited, 'sub': sub})
            # 이 장소 열기 → 정보 수정 → ✕ → 상세는 여전히 ‹(뒤로) → ‹ 누르면 결과
            p.click('[data-action=roulette-open]')
            p.wait_for_selector('.sheet .detail-name')
            p.click('.sheet [data-action=edit]')
            p.wait_for_selector('.sheet #place-form')
            p.click('.sheet-head [data-action=close]')
            p.wait_for_selector('.sheet .detail-name')
            back = p.get_attribute('.sheet-head [data-action=close]', 'aria-label')
            sheet_back = p.evaluate('() => state.sheet && state.sheet.back')
            p.click('.sheet-head [data-action=close]')
            p.wait_for_selector('#rl-result')
            step = p.evaluate('() => state.roulette && state.roulette.step')
            sh.check('52-roulette-wheel-result', 'edit-and-back', back == '뒤로' and sheet_back == 'roulette' and step == 'result',
                     {'closeLabel': back, 'sheetBack': sheet_back, 'step': step})
            # 57) 공유: 그림+글 → 글 복사 → 복사도 안 되면 고를 수 있는 글
            got = p.evaluate(SHARE_FILES_JS)
            if got.get('url'):
                (sh.out / '57-roulette-share-card.png').write_bytes(base64.b64decode(got['url'].split(',', 1)[1]))
            lines = (got.get('text') or '').split('\n')
            sh.check('57-roulette-share-card', 'share-files', got.get('type') == 'image/png' and (got.get('size') or 0) > 10000
                     and got.get('title') == '룰렛 결과' and lines[0].startswith('🎯 룰렛으로 정했어요: ') and lines[-1].startswith('https://'),
                     {k: v for k, v in got.items() if k != 'url'})
            p.wait_for_timeout(300)
            p.evaluate(SHARE_COPY_JS, True)
            p.wait_for_selector('#toast.show')
            sh.shot(p, '57b-roulette-share-copied', keep_toast=True)
            copied = p.evaluate('() => window.__copied || ""')
            sh.check('57b-roulette-share-copied', 'clipboard', copied == got.get('text'), {'copied': copied})
            p.evaluate(SHARE_COPY_JS, False)
            p.wait_for_selector('#rl-share-text')
            p.evaluate("() => document.activeElement && document.activeElement.blur()")
            sh.scroll_to(p, '.rl-actions')
            sh.shot(p, '57c-roulette-share-text')
        p.context.close()

        # 53) 이름 넘기기 (후보 14곳) → 54) 결과
        p = sh.new_page('mock=picker&go=B&many=1', dark=dark, motion=True)
        p.wait_for_selector('.top .title')
        open_roulette(p)
        if not dark:
            sh.shot(p, '50c-roulette-setup-many')
        p.click('[data-action=roulette-spin]')
        p.wait_for_selector('.rl-ticker')
        p.wait_for_timeout(1300)
        sh.shot(p, f'{n}3-{d}roulette-ticker-spinning', keep_toast=True)
        p.wait_for_selector('#rl-result', timeout=7000)
        sh.shot(p, f'{n}4-{d}roulette-ticker-result')
        same = p.evaluate("() => document.querySelector('#rl-tick-name').textContent === document.querySelector('.rl-result h3 b').textContent")
        sh.check(f'{n}4-{d}roulette-ticker-result', 'ticker-stops-on-winner', same)
        p.context.close()

        # 55) 후보 부족: 목록에서 '카페'를 고른 채로 열면 룰렛도 카페(가고 싶은 곳 1곳) → 돌리기 꺼짐
        p = sh.new_page('mock=picker&go=A', dark=dark)
        p.wait_for_selector('.top .title')
        p.click('.chips [data-action=cat][data-cat="카페"]')
        open_roulette(p)
        sh.shot(p, f'{n}5-{d}roulette-not-enough')
        sh.check(f'{n}5-{d}roulette-not-enough', 'spin-disabled', p.is_disabled('[data-action=roulette-spin]')
                 and p.get_attribute('[data-action=roulette-cat][aria-pressed=true]', 'data-cat') == '카페')
        p.context.close()

    # 움직임 줄이기: 돌리지 않고 바로 결과 / 돌아가는 중에 닫으면 타이머가 멈춰 결과가 다시 뜨지 않음
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('.top .title')
    open_roulette(p)
    p.click('[data-action=roulette-spin]')
    try:
        p.wait_for_selector('#rl-result', timeout=400)
        quick = True
    except Exception:
        quick = False
    sh.check('58-roulette-reduced-motion', 'instant-result', quick and not p.locator('.rl-ticker, .sheet-body button:text-is("돌리는 중…")').count())
    p.context.close()
    # 두 번 누르기(390x844 휴대폰): 바로 결과가 나와도 두 번째 누름이 같은 자리에 새로 그려진 단추를 누르지 않음
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('.top .title')
    open_roulette(p)
    dbl_spin = dblclick_center(p, '[data-action=roulette-spin]')
    p.wait_for_timeout(300)
    dbl_spin['step'] = p.evaluate('() => state.roulette.step')
    dbl_spin['card'] = p.locator('#rl-result').count()
    sh.check('58-roulette-reduced-motion', 'double-click-spin', dbl_spin['step'] == 'result' and dbl_spin['card'] == 1, dbl_spin)
    p.wait_for_timeout(600)
    dbl_setup = dblclick_center(p, '[data-action=roulette-setup]')
    p.wait_for_timeout(300)
    dbl_setup['step'] = p.evaluate('() => state.roulette.step')
    sh.check('58-roulette-reduced-motion', 'double-click-setup', dbl_setup['step'] == 'setup', dbl_setup)
    p.context.close()
    # 같은 확인을 실제로 도는 화면에서: 후보 다시 고르기를 두 번 눌러도 다시 돌지 않음('spin'이 아니라 'setup')
    p = sh.new_page('mock=picker&go=A', motion=True)
    p.wait_for_selector('.top .title')
    open_roulette(p)
    p.click('[data-action=roulette-spin]')
    p.wait_for_selector('#rl-result', timeout=7000)
    p.wait_for_timeout(600)
    dbl_setup = dblclick_center(p, '[data-action=roulette-setup]')
    p.wait_for_timeout(300)
    dbl_setup['step'] = p.evaluate('() => state.roulette.step')
    sh.check('58-roulette-reduced-motion', 'double-click-setup-motion', dbl_setup['step'] == 'setup', dbl_setup)
    p.context.close()
    p = sh.new_page('mock=picker&go=A', motion=True)
    p.wait_for_selector('.top .title')
    open_roulette(p)
    p.click('[data-action=roulette-spin]')
    p.wait_for_selector('.rl-disc')
    p.wait_for_timeout(500)
    p.keyboard.press('Escape')
    p.wait_for_timeout(4300)
    reopened = p.evaluate("() => document.querySelector('#sheet-root').innerHTML.length")
    sh.check('58-roulette-reduced-motion', 'close-stops-timers', reopened == 0 and not p.errors, {'sheetHtml': reopened, 'console': p.errors})
    p.context.close()

    # 59) PC 1280x800 결과
    p = sh.new_page('mock=picker&go=A', width=1280, height=800, mobile=False)
    p.wait_for_selector('.top .title')
    open_roulette(p)
    p.click('#rl-visited')
    p.click('[data-action=roulette-spin]')
    p.wait_for_selector('#rl-result')
    sh.shot(p, '59-desktop-roulette-result')
    p.context.close()


# v0.4.1 목록을 옆으로 밀어 탭 넘기기. Playwright에는 손가락을 끌고 다니는 API가 없어서(tap만 있음)
# CDP Input.dispatchTouchEvent로 손가락을 직접 움직임 (has_touch·is_mobile 화면, 브라우저가 실제로 세로 스크롤·가로 스크롤을 함)
class Finger:
    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)

    def send(self, kind, pts):
        self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})

    # (x0,y0)에서 (x1,y1)까지 steps번에 나눠 움직이고 뗌. hold: 떼기 직전에 부를 함수(힌트 읽기·스크린샷)
    def drag(self, x0, y0, x1, y1, steps=12, hold=None):
        self.send('touchStart', [(x0, y0)])
        for k in range(1, steps + 1):
            self.send('touchMove', [(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)])
            self.page.wait_for_timeout(12)
        got = hold() if hold else None
        self.send('touchEnd', [])
        self.page.wait_for_timeout(350)
        return got


SW_TAB_JS = "() => { const b = document.querySelector('.top .tabs [role=tab][aria-selected=true]'); return b ? b.dataset.tab : null; }"
# 손가락을 대고 있는 동안의 힌트·목록·페이지 폭
SW_HOLD_JS = r"""
() => { const h = document.querySelector('#swipe-hint'), a = document.querySelector('#list-area');
  return { text: h ? h.textContent : null, ready: !!h && h.classList.contains('ready'), shown: !!h && Number(h.style.opacity) > 0,
    tf: a ? a.style.transform : null, docScrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }; }
"""
SW_AREA_JS = "() => { const a = document.querySelector('#list-area'); return { tf: a.style.transform, op: a.style.opacity }; }"
# 목록 안이면서 화면에 보이는 높이 (내 방·읽기 전용 모두 목록 위에 띠·검색 칸이 있어서 위치가 다름)
SW_LIST_Y_JS = "() => { const r = document.querySelector('#list-area').getBoundingClientRect(); return Math.round(Math.max(r.top + 40, Math.min(520, r.bottom - 40, innerHeight - 120))); }"
# 새 목록이 미끄러져 들어올 때의 애니메이션 이름 모으기 (움직임 줄이기면 하나도 없어야 함)
SW_ANIM_JS = "() => { window.__swAnims = []; document.addEventListener('animationstart', (e) => window.__swAnims.push(e.animationName), true); }"
# 공개 방 읽기 전용에서 쓰기 호출 수 (M4의 FORCE_CLICK_JS와 같은 기준)
SW_WRITES_JS = r"""
(before) => window.__mock.calls.slice(before).filter((c) => (c.kind === 'from' && c.op !== 'select') || c.kind === 'rpc' || (c.kind === 'storage' && c.op !== 'sign')).length
"""


def sw_center(p, selector):
    b = p.locator(selector).first.bounding_box()
    return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2


def run_swipe(sh):
    """v0.4.1 목록 밀어 탭 넘기기 (원래 앱 tests/ui/swipe.mjs의 W1~W12와 같은 경우 + 읽기 전용·칩 줄·사진 줄·미는 도중 다시 그려짐·확대 중). 390x844 터치 화면"""
    tab = lambda p: p.evaluate(SW_TAB_JS)  # noqa: E731
    hold = lambda p: (lambda: p.evaluate(SW_HOLD_JS))  # noqa: E731

    # 70) 내 방: 덜 밀기(20%) → 제자리, 45% → 다녀온 곳(힌트 진해짐) → 찜 → 끝에서 안 넘어감 → 오른쪽으로 다녀온 곳
    name = '70-swipe-hint-short'
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('button.place')
    p.evaluate(SW_ANIM_JS)
    f = Finger(p)
    y = p.evaluate(SW_LIST_Y_JS)
    h = f.drag(260, y, 190, y, hold=lambda: (sh.shot(p, name, keep_toast=True), p.evaluate(SW_HOLD_JS))[1])
    a = p.evaluate(SW_AREA_JS)
    sh.check(name, 'W4 short-stays', tab(p) == 'want_to_go' and h['shown'] and not h['ready'] and not a['tf'] and not a['op'], {'tab': tab(p), 'hint': h, 'area': a})
    name = '70b-swipe-hint-ready'
    h = f.drag(300, y, 140, y, hold=lambda: (sh.shot(p, name, keep_toast=True), p.evaluate(SW_HOLD_JS))[1])
    sh.check(name, 'W1 switch-visited', tab(p) == 'visited' and h['shown'] and h['ready'] and h['text'] == '다녀온 곳 →', {'tab': tab(p), 'hint': h})
    sh.shot(p, '71-swipe-switched-visited')
    f.drag(300, y, 140, y)
    sh.check(name, 'W2 switch-fav', tab(p) == 'fav', {'tab': tab(p)})
    h = f.drag(300, y, 140, y, hold=hold(p))
    sh.check(name, 'W7 no-wrap-at-fav', tab(p) == 'fav' and not h['shown'] and h['tf'] == 'translateX(-32px)', {'tab': tab(p), 'hint': h})
    name = '70c-swipe-hint-right'
    h = f.drag(90, y, 250, y, hold=lambda: (sh.shot(p, name, keep_toast=True), p.evaluate(SW_HOLD_JS))[1])
    sh.check(name, 'W3 back-to-visited', tab(p) == 'visited' and h['ready'] and h['text'] == '← 다녀온 곳', {'tab': tab(p), 'hint': h})
    sh.check(name, 'no-sideways-page-while-dragging', h['docScrollWidth'] <= h['viewport'], h)
    anims = p.evaluate('() => window.__swAnims')
    sh.check(name, 'reduced-motion-no-slide', not [x for x in anims if x.startswith('list-in')], {'anims': anims})
    # W12 세로 스크롤은 그대로 (다녀온 곳 목록), W5 비스듬히(세로에 가까움)는 안 넘어감
    before = p.evaluate('() => scrollY')
    f.drag(200, 700, 205, 300, steps=16)
    after = p.evaluate('() => scrollY')
    sh.check(name, 'W12 vertical-scroll', after > before and tab(p) == 'visited', {'before': before, 'after': after, 'tab': tab(p)})
    p.evaluate('() => scrollTo(0, 0)')
    p.wait_for_timeout(200)
    f.drag(300, 650, 160, 450)
    sh.check(name, 'W5 diagonal-stays', tab(p) == 'visited', {'tab': tab(p)})
    # W6 화면 가장자리(28px 안)에서 시작한 건 무시
    f.drag(386, y, 200, y)
    f.drag(4, y, 200, y)
    sh.check(name, 'W6 edge-start-ignored', tab(p) == 'visited', {'tab': tab(p)})
    # W7 가고 싶은 곳에서 오른쪽으로도 안 넘어감
    p.click('[data-action=tab][data-tab=want_to_go]')
    p.wait_for_timeout(200)
    f.drag(90, y, 300, y)
    sh.check(name, 'W7 no-wrap-at-want', tab(p) == 'want_to_go', {'tab': tab(p)})
    # 카테고리 칩 줄을 옆으로 밀면 칩만 움직이고 탭은 그대로 (위 W5의 비스듬한 끌기가 페이지를 내렸으니 맨 위로 올리고)
    p.evaluate('() => scrollTo(0, 0)')
    p.wait_for_timeout(200)
    cx, cy = sw_center(p, '.chips')
    room = p.evaluate("() => { const c = document.querySelector('.chips'); return c.scrollWidth - c.clientWidth; }")
    f.drag(330, cy, 60, cy)
    left = p.evaluate("() => document.querySelector('.chips').scrollLeft")
    sh.check(name, 'chips-scroll-not-tabs', tab(p) == 'want_to_go' and (left > 0 if room > 0 else True), {'tab': tab(p), 'chipsScrollLeft': left, 'chipsRoom': room})
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
    p.context.close()

    # 72) 카드 위에서 밀기(W8·W9), 검색어·카테고리 그대로(W10), 상세가 열려 있으면 안 함(W11), 사진 줄은 사진만 넘어감
    name = '72-swipe-card-search-sheet'
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('button.place')
    f = Finger(p)
    p.click('[data-action=tab][data-tab=visited]')
    p.wait_for_timeout(200)
    x, cy = sw_center(p, '#list-area .place')
    f.drag(x + 80, cy, x - 90, cy)
    s = p.evaluate("() => ({ sheet: !!document.querySelector('.detail-name') })")
    sh.check(name, 'W8 card-not-opened', not s['sheet'] and tab(p) == 'fav', {'sheet': s['sheet'], 'tab': tab(p)})
    p.wait_for_timeout(300)
    x, cy = sw_center(p, '#list-area .place')
    p.touchscreen.tap(x, cy)
    p.wait_for_timeout(400)
    opened = p.locator('.sheet .detail-name').count() == 1
    sh.check(name, 'W9 tap-opens', opened, {'opened': opened})
    p.click('.sheet-head [data-action=close]')
    p.wait_for_timeout(200)
    p.click('[data-action=tab][data-tab=want_to_go]')
    p.click('.chips [data-action=cat][data-cat="전체"]')
    p.evaluate("() => { const q = document.querySelector('#q'); q.value = '서울'; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); }")
    p.wait_for_timeout(150)
    y = p.evaluate(SW_LIST_Y_JS)
    f.drag(300, y, 140, y)
    w10 = p.evaluate("() => ({ q: document.querySelector('#q').value, cat: document.querySelector('.chips [aria-pressed=true]').dataset.cat })")
    sh.check(name, 'W10 search-stays', tab(p) == 'visited' and w10['q'] == '서울' and w10['cat'] == '전체', {'tab': tab(p), **w10})
    sh.shot(p, '72a-swipe-search-kept')  # 확인 이름(name)과 다르게: shot은 그 이름의 report를 새로 씀
    p.click('button.place:has-text("골목 끝 칼국수")')
    p.wait_for_selector('.sheet .detail-name')
    p.wait_for_timeout(300)
    gx, gy = sw_center(p, '#gallery')
    f.drag(gx + 120, gy, gx - 120, gy)
    p.wait_for_timeout(500)
    g = p.evaluate("() => ({ left: document.querySelector('#gallery').scrollLeft, sheet: !!document.querySelector('.sheet .detail-name') })")
    sh.check(name, 'photo-strip-scrolls-not-tabs', g['left'] > 0 and g['sheet'] and tab(p) == 'visited', {**g, 'tab': tab(p)})
    sh.shot(p, '72b-swipe-photo-strip-in-sheet')
    f.drag(300, 700, 120, 700)
    s = p.evaluate("() => !!document.querySelector('.sheet .detail-name')")
    sh.check(name, 'W11 sheet-open-no-switch', s and tab(p) == 'visited', {'sheet': s, 'tab': tab(p)})
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
    p.context.close()

    # 73) 어두운 화면 + 움직임 켬: 넘어갈 만큼 민 모습, 새 목록이 미끄러져 들어옴
    name = '73-dark-swipe-hint-ready'
    p = sh.new_page('mock=picker&go=A', dark=True, motion=True)
    p.wait_for_selector('button.place')
    p.evaluate(SW_ANIM_JS)
    f = Finger(p)
    y = p.evaluate(SW_LIST_Y_JS)
    h = f.drag(300, y, 140, y, hold=lambda: (sh.shot(p, name, keep_toast=True), p.evaluate(SW_HOLD_JS))[1])
    anims = p.evaluate('() => window.__swAnims')
    sh.check(name, 'slide-in', tab(p) == 'visited' and h['ready'] and 'list-in-next' in anims, {'tab': tab(p), 'hint': h, 'anims': anims})
    f.drag(90, y, 250, y)
    anims = p.evaluate('() => window.__swAnims')
    sh.check(name, 'slide-in-prev', tab(p) == 'want_to_go' and 'list-in-prev' in anims, {'tab': tab(p), 'anims': anims})
    sh.shot(p, '73b-dark-swipe-back')
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
    p.context.close()

    # 74) 공개 방 읽기 전용: 가고 싶은 곳 ↔ 다녀온 곳만(찜 없음), 쓰기 없음, 카드 안 열림
    name = '74-visit-swipe'
    p = sh.new_page('mock=picker', path='/r/k7m2p9xa4c')
    p.wait_for_selector('.visit-band')
    p.wait_for_selector('button.place')
    f = Finger(p)
    before = p.evaluate('() => window.__mock.calls.length')
    y = p.evaluate(SW_LIST_Y_JS)
    start = tab(p)
    h = f.drag(300, y, 120, y, hold=hold(p))
    sh.check(name, 'end-tab-visited-no-fav', start == 'visited' and tab(p) == 'visited' and not h['shown'] and h['tf'] == 'translateX(-36px)', {'start': start, 'tab': tab(p), 'hint': h})
    h = f.drag(90, y, 260, y, hold=lambda: (sh.shot(p, '74a-visit-swipe-hint', keep_toast=True), p.evaluate(SW_HOLD_JS))[1])
    sh.check(name, 'switch-want', tab(p) == 'want_to_go' and h['ready'] and h['text'] == '← 가고 싶은 곳', {'tab': tab(p), 'hint': h})
    sh.check(name, 'no-sideways-page-while-dragging', h['docScrollWidth'] <= h['viewport'], h)
    sh.shot(p, '74b-visit-swiped-want')
    f.drag(90, y, 260, y)
    sh.check(name, 'end-tab-want', tab(p) == 'want_to_go', {'tab': tab(p)})
    x, cy = sw_center(p, '#list-area .place')
    f.drag(x + 80, cy, x - 90, cy)
    opened = p.locator('.sheet .detail-name').count()
    sh.check(name, 'card-not-opened-switch-visited', tab(p) == 'visited' and not opened, {'tab': tab(p), 'opened': opened})
    writes = p.evaluate(SW_WRITES_JS, before)
    sh.check(name, 'no-writes', writes == 0, {'writes': writes})
    sh.m4(p, name)
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
    p.context.close()

    # 75) 미는 도중 화면이 새로 그려짐: 손가락 아래 카드가 문서에서 빠져 그 손가락의 touchmove·touchend가 document까지 안 옴.
    #     손을 떼고 1초 뒤 카드를 짧게(60ms) 한 번 누르면 바로 열려야 함 (끝을 못 받은 밀기가 다음 탭의 click을 버리면 안 됨)
    name = '75-swipe-redraw-then-tap'
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('button.place')
    f = Finger(p)

    def cut_swipe(redraw_js):
        x, cy = sw_center(p, '#list-area .place')
        f.send('touchStart', [(x + 80, cy)])
        for k in range(1, 13):
            if k == 6:
                p.evaluate(redraw_js)  # 60px 민 때
            f.send('touchMove', [(x + 80 - 12 * k, cy)])
            p.wait_for_timeout(12)
        f.send('touchEnd', [])
        p.wait_for_timeout(1000)
        left = p.evaluate(SW_AREA_JS)
        x, cy = sw_center(p, '#list-area .place')
        f.send('touchStart', [(x, cy)])
        p.wait_for_timeout(60)
        f.send('touchEnd', [])
        p.wait_for_timeout(400)
        return {'leftover': left, 'after': p.evaluate(SW_AREA_JS), 'opened': p.locator('.sheet .detail-name').count() == 1, 'tab': tab(p)}

    r = cut_swipe('() => render()')
    sh.check(name, 'redraw-mid-swipe-first-tap-opens', r['opened'] and r['tab'] == 'want_to_go' and not r['after']['tf'], r)
    sh.shot(p, '75a-swipe-redraw-tap-opened')
    if r['opened']:
        p.click('.sheet-head [data-action=close]')
        p.wait_for_timeout(300)
    # 목록 안만 새로 그려짐(검색어를 칠 때처럼 #list-area는 그대로): 비켜 있던 목록은 다음 손가락이 닿을 때 제자리로
    r = cut_swipe("() => { document.querySelector('#list-area').innerHTML = listHtml(); }")
    sh.check(name, 'list-refresh-mid-swipe-tap-resets-and-opens', r['opened'] and r['tab'] == 'want_to_go' and not r['after']['tf'] and not r['after']['op'], r)
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
    p.context.close()

    # 76) 확대해서 보는 중(배율 2): 목록 위에서 손가락 하나로 옆으로 밀면 화면이 옆으로 옮겨지고 탭은 그대로.
    #     배율을 1로 돌리면 다시 밀어서 넘어감
    name = '76-swipe-zoomed-pan'
    p = sh.new_page('mock=picker&go=A')
    p.wait_for_selector('button.place')
    f = Finger(p)
    vv_js = "() => ({ scale: visualViewport.scale, left: visualViewport.offsetLeft, zoomed: document.documentElement.classList.contains('zoomed') })"
    f.cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor': 2})
    p.wait_for_timeout(400)
    z0 = p.evaluate(vv_js)
    # 확대된 화면 안에서 목록이 보이는 높이 (손가락 좌표는 확대된 화면 기준)
    zy = p.evaluate("() => { const r = document.querySelector('#list-area').getBoundingClientRect(), v = visualViewport;"
                    " return Math.round((Math.min(r.top + 60, v.offsetTop + v.height - 20) - v.offsetTop) * v.scale); }")
    f.drag(300, zy, 100, zy)
    z1 = p.evaluate(vv_js)
    opened = p.locator('.sheet').count()
    sh.check(name, 'zoomed-one-finger-pans-page', z0['zoomed'] and z1['left'] > 0 and tab(p) == 'want_to_go' and not opened,
             {'before': z0, 'after': z1, 'tab': tab(p), 'sheet': opened, 'y': zy})
    sh.shot(p, '76a-swipe-zoomed-panned', keep_toast=True)
    f.cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor': 1})
    p.wait_for_timeout(400)
    z2 = p.evaluate(vv_js)
    y = p.evaluate(SW_LIST_Y_JS)
    f.drag(300, y, 140, y)
    sh.check(name, 'unzoomed-swipe-switches', not z2['zoomed'] and tab(p) == 'visited', {'viewport': z2, 'tab': tab(p)})
    sh.check(name, 'no-console-errors', not p.errors, p.errors)
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
    ap.add_argument('--only', choices=['all', 'base', 'public', 'roulette', 'swipe'], default='all',
                    help='base = v0.1.x 장면, public = 공개 방 장면(30번대), roulette = 룰렛 장면(50번대), swipe = 목록 밀어 탭 넘기기(70번대)')
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
                if a.only in ('all', 'roulette'):
                    run_roulette(sh)
                if a.only in ('all', 'swipe'):
                    run_swipe(sh)
            finally:
                sh.report['_blocked_requests'] = sh.blocked
                sh.report['_m4_failures'] = sh.m4_fail
                sh.report['_check_failures'] = sh.checks_fail
                (out / 'report.json').write_text(json.dumps(sh.report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
                browser.close()
    finally:
        if server:
            server.terminate()
    print(f'끝: {out}  (막은 바깥 요청 {len(sh.blocked)}개, M4 실패 {sh.m4_fail}개, 확인 실패 {sh.checks_fail}개)')
    return 1 if sh.m4_fail or sh.checks_fail else 0


if __name__ == '__main__':
    sys.exit(main())
