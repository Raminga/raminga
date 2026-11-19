#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 8 (global navigation/visual).

Starts only the 4404 host and 4369 test control endpoint under
.local/prototype-remediation/b2-08-nav, operates the real Chromium Web UI at
1440x900 and 390x844, and inspects computed navigation visibility/selection,
status labels, focus order, overflow, and chat/nav geometry. It never touches
~/.raminga, the user's DSH_HOME, the desktop, or another acceptance port.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import signal
import socket
import sqlite3
import subprocess
import time
import traceback
import urllib.request

ROOT = pathlib.Path(os.environ.get('B8_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-08-nav')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
HOST_PORT = int(os.environ.get('B8_HOST_PORT', FIXTURE.get('hostPort', 4404)))
CONTROL_PORT = int(os.environ.get('B8_CONTROL_PORT', FIXTURE.get('controlPort', 4369)))
PEER_B = FIXTURE['nodeB']
DIR_A = FIXTURE['nodeAData']
DIR_B = FIXTURE['nodeBData']
DSH_HOME = FIXTURE['dshHome']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-08-nav-results.json'
PAGE = None
HOST = {'process': None, 'url': '', 'log': None}


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) and not RESULTS['pageErrors'] else 'FAIL'
    RESULT_FILE.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def case(cid, name, fn):
    started = time.time()
    try:
        data = fn() or {}
        RESULTS['cases'][cid] = {'id': cid, 'name': name, 'status': 'PASS',
                                 'seconds': round(time.time() - started, 2), **data}
        print(f'PASS {cid} {name}', flush=True)
    except Exception as exc:  # noqa: BLE001 - record the real failure
        if PAGE is not None:
            try:
                PAGE.screenshot(path=str(EVIDENCE / f'{cid.lower()}-failed.png'))
                RESULTS['screenshots'].append(str((EVIDENCE / f'{cid.lower()}-failed.png').relative_to(REPO)))
            except Exception:
                pass
        RESULTS['cases'][cid] = {
            'id': cid, 'name': name, 'status': 'FAIL',
            'seconds': round(time.time() - started, 2),
            'error': str(exc), 'trace': traceback.format_exc()[-8000:],
        }
        print(f'FAIL {cid} {name}: {exc}', flush=True)
    finally:
        save()


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) != 0


def wait_port_free(port, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_free(port):
            return
        time.sleep(0.2)
    raise AssertionError(f'port {port} is still in use after the host exited')


def terminate_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def stop_host():
    target = HOST.get('process')
    terminate_process(target)
    HOST['process'] = None
    wait_port_free(HOST_PORT)
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    try:
        pid_path.unlink(missing_ok=True)
        pid_path.with_name(pid_path.name + '.meta').unlink(missing_ok=True)
    except OSError:
        pass


def start_host():
    if not port_free(HOST_PORT):
        raise AssertionError(f'port {HOST_PORT} is already in use; refusing to touch a live host')
    if not port_free(CONTROL_PORT):
        raise AssertionError(f'control port {CONTROL_PORT} is already in use; refusing to touch a live process')
    log_path = EVIDENCE / 'host-b2-08.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B8_DATA_DIR': DIR_A,
        'B8_DSH_HOME': DSH_HOME,
        'B8_HOST_PORT': str(HOST_PORT),
        'B8_CONTROL_PORT': str(CONTROL_PORT),
        'B8_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(BIN),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 75
    url = None
    while time.time() < deadline:
        if process.poll() is not None:
            break
        text = log_path.read_text(errors='replace') if log_path.exists() else ''
        matches = re.findall(r'http://127\.0\.0\.1:%d/\S+' % HOST_PORT, text)
        if matches:
            url = matches[-1]
            break
        time.sleep(0.25)
    if url is None:
        terminate_process(process)
        raise AssertionError(f'host did not publish a URL: {log_path.read_text(errors="replace")[-4000:]}')
    HOST.update(process=process, url=url, log=str(log_path))
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    save()
    return process, url


def wait_control():
    deadline = time.time() + 30
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{CONTROL_PORT}/health', timeout=2) as response:
                value = json.loads(response.read().decode('utf-8'))
                if value.get('ok') is True:
                    return value
        except Exception as error:  # noqa: BLE001
            last = error
        time.sleep(0.2)
    raise AssertionError(f'control endpoint did not become healthy: {last}')


def wait_for(predicate, label, timeout=30):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - diagnostics
            last = error
        time.sleep(0.2)
    raise AssertionError(f'timed out waiting for {label}: {last}')


def read_unread():
    db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
    try:
        cursor = db.execute(
            'SELECT last_read_message_id, last_read_at_ms FROM conversation_read_state WHERE peer_id = ?',
            (PEER_B,),
        ).fetchone()
        last_id, last_at = (cursor[0], cursor[1]) if cursor else ('', 0)
        rows = db.execute(
            'SELECT COUNT(*) FROM messages WHERE peer_id = ? AND direction = ?',
            (PEER_B, 'in'),
        ).fetchone()[0]
        after = db.execute(
            'SELECT COUNT(*) FROM messages WHERE peer_id = ? AND direction = ? AND created_at_ms > ?',
            (PEER_B, 'in', int(last_at or 0)),
        ).fetchone()[0]
        return {'inbound': rows, 'readMessageId': last_id, 'readAt': last_at, 'afterCursor': after}
    finally:
        db.close()


def pseudo_after(locator):
    return locator.evaluate('''(node) => {
      const style = getComputedStyle(node, '::after');
      return {
        content: style.content,
        display: style.display,
        background: style.backgroundColor,
        height: style.height,
        top: style.top,
        left: style.left,
        right: style.right,
      };
    }''')


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(8):
            close = self.page.locator('[aria-label="Close"]:visible, [aria-label="关闭"]:visible')
            if close.count():
                close.first.click()
                self.page.wait_for_timeout(220)
                continue
            if self.page.locator('dialog[open]').count() == 0:
                return
            inner = self.page.locator('dialog[open] [data-close-dialog]:visible')
            if inner.count():
                inner.first.click()
            else:
                self.page.keyboard.press('Escape')
            self.page.wait_for_timeout(220)

    def open_panel(self):
        if self.page.locator('#settingsTrigger').count() and self.page.locator('#settingsTrigger').is_visible():
            return
        self.dismiss()
        self.page.keyboard.press('Escape')
        self.page.wait_for_timeout(300)
        if not self.wide:
            toggle = self.page.locator('[aria-label="Open sidebar"]:visible')
            if toggle.count():
                toggle.first.click()
                self.page.wait_for_timeout(550)
        self.page.get_by_role('button', name='Raminga', exact=True).first.click()
        self.page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(900)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(650)
        self.open_panel()
        self.page.wait_for_timeout(350)

    def nav(self, item):
        selector = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{selector} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(750)

    def current(self):
        selector = '#desktopNav' if self.wide else '#mobileNav'
        return self.page.locator(f'{selector} [aria-current="page"]').evaluate_all(
            'els => els.map(e => e.dataset.nav)')

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def focus_info(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          if (!node) return {id: '', nav: '', focusVisible: false, outlineWidth: '0px'};
          const style = getComputedStyle(node);
          return {
            id: node.id || '', nav: node.dataset ? (node.dataset.nav || '') : '',
            tag: node.tagName, focusVisible: node.matches(':focus-visible'),
            outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle,
            outlineColor: style.outlineColor,
          };
        }''')

    def horizontal_overflow(self):
        return self.page.evaluate('''() => {
          const root = document.documentElement;
          const body = document.body;
          return Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth;
        }''')


def main():
    browser = None
    page = None
    nodes_running = True
    try:
        host_process, url = start_host()
        RESULTS['control'] = wait_control()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            global PAGE
            PAGE = page
            page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
            page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
                    if message.type == 'error' else None)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_timeout(1800)
            ui = UI(page)
            ui.viewport(1440, 900)
            ui.nav('home')
            page.wait_for_timeout(900)

            def wide_nav_header():
                assert page.locator('#desktopNav').is_visible(), 'desktop nav is not visible at 1440'
                assert not page.locator('#mobileNav').is_visible(), 'mobile nav is visible at 1440'
                buttons = page.locator('#desktopNav button[data-nav]')
                assert buttons.count() == 3, buttons.count()
                assert buttons.evaluate_all('els => els.map(e => e.dataset.nav)') == ['explore', 'home', 'contacts']
                assert ui.current() == ['home']
                home = page.locator('#desktopNav [data-nav="home"]')
                assert home.get_attribute('aria-label') == '主页'
                assert home.locator('img').count() == 1
                assert home.locator('img').get_attribute('src').startswith('data:image/svg+xml')
                assert home.locator('.rm-sr-only').inner_text() == '主页'
                assert page.locator('.rm-brand').get_attribute('aria-current') is None
                context_computed = home.evaluate('(e) => getComputedStyle(e, "::after").content')
                assert context_computed not in ('none', ''), 'active home has no underline'
                actions = page.locator('.rm-topbar-actions > *').evaluate_all('els => els.map(e => e.id)')
                assert actions == ['nodeTrigger', 'settingsTrigger'], actions
                label = page.locator('#nodeLabel')
                assert label.inner_text() == '节点在线', label.inner_text()
                sizes = label.evaluate('(e) => ({scroll: e.scrollWidth, client: e.clientWidth})')
                assert sizes['scroll'] <= sizes['client'] + 1, sizes
                assert page.locator('#settingsTrigger').get_attribute('aria-label') == '设置'
                badge = page.locator('#desktopNav [data-nav-badge="contacts"]')
                assert badge.is_visible()
                unread = badge.inner_text().strip()
                assert unread.isdigit() and int(unread) > 0, unread
                return {'nav': ['explore', 'home', 'contacts'], 'current': ['home'],
                        'nodeLabel': label.inner_text(), 'labelWidth': sizes,
                        'topbarOrder': actions, 'unreadBadge': unread,
                        'unreadDb': read_unread()}

            case('N8-01', '1440 页头/主导航/品牌主页/节点标签/齿轮顺序与键盘顺序', wide_nav_header)

            def wide_status_and_keyboard():
                ui.shot('n8-01-wide-home-1440')
                page.locator('#nodeTrigger').click()
                page.wait_for_timeout(650)
                assert page.locator('#statusDialog').is_visible()
                connections = page.locator('#statusConnections').inner_text()
                assert '条连接' in connections, connections
                assert '条连接' not in page.locator('#nodeLabel').inner_text()
                ui.shot('n8-01-wide-status-1440')
                page.locator('#statusDialog [data-close-dialog]').first.click()
                page.wait_for_timeout(400)
                assert not page.locator('#statusDialog').is_visible()
                assert ui.focus_info()['id'] == 'nodeTrigger', ui.focus_info()

                # Keyboard order: home -> contacts -> node -> gear, plus focus ring.
                home = page.locator('#desktopNav [data-nav="home"]')
                home.focus()
                page.keyboard.press('Tab')
                contacts_focus = ui.focus_info()
                assert contacts_focus['nav'] == 'contacts', contacts_focus
                assert contacts_focus['focusVisible'] is True, contacts_focus
                assert int(float(contacts_focus['outlineWidth'].replace('px', ''))) >= 2, contacts_focus
                page.keyboard.press('Tab')
                assert ui.focus_info()['id'] == 'nodeTrigger', ui.focus_info()
                page.keyboard.press('Tab')
                assert ui.focus_info()['id'] == 'settingsTrigger', ui.focus_info()

                # Enter on the centre home mark must actually navigate home.
                ui.nav('explore')
                page.locator('#desktopNav [data-nav="home"]').focus()
                page.keyboard.press('Enter')
                page.wait_for_timeout(700)
                assert page.locator('#page-home').is_visible()
                assert ui.current() == ['home']
                return {'statusConnections': connections, 'focus': contacts_focus,
                        'order': ['contacts', 'nodeTrigger', 'settingsTrigger']}

            case('N8-02', '状态详情含连接数；键盘 Tab/Enter 与焦点环', wide_status_and_keyboard)

            def wide_explore_regression():
                ui.nav('explore')
                page.wait_for_timeout(1200)
                filters = page.locator('#page-explore .rm-filter')
                assert filters.count() == 3
                filters_data = {}
                for key in ('all', 'familiar', 'mine'):
                    button = page.locator(f'#page-explore .rm-filter[data-filter="{key}"]')
                    assert button.count() == 1
                    if key != 'all':
                        button.click()
                        page.wait_for_timeout(650)
                    assert button.get_attribute('aria-pressed') == 'true'
                    style = button.evaluate('(e) => ({bg: getComputedStyle(e).backgroundImage, color: getComputedStyle(e).color})')
                    assert 'linear-gradient' in style['bg'], (key, style)
                    assert style['color'] == 'rgb(255, 255, 255)', (key, style)
                    list_selector = '#mineFeedList' if key == 'mine' else '#discoveryList'
                    posts = page.locator(f'{list_selector} .rm-post')
                    files = page.locator('#page-explore [data-content-kind="file"], #page-explore .rm-file-row')
                    filters_data[key] = {'posts': posts.count(), 'files': files.count()}
                    assert files.count() == 0, (key, files.count())
                assert filters_data['all']['posts'] >= 3, filters_data
                page.locator('#page-explore .rm-filter[data-filter="all"]').click()
                page.wait_for_timeout(650)
                first = page.locator('#discoveryList .rm-post-open').first
                assert first.count() == 1
                first.click()
                page.wait_for_timeout(700)
                assert page.locator('#page-post').is_visible()
                ui.shot('n8-02-wide-post-detail-1440')
                page.locator('#postBack').click()
                page.wait_for_timeout(650)
                assert page.locator('#page-explore').is_visible()
                assert page.locator('#page-explore .rm-filter[data-filter="all"]').get_attribute('aria-pressed') == 'true'
                ui.shot('n8-02-wide-explore-1440')
                # Public files remain an independent settings entry.
                page.locator('#settingsTrigger').click()
                page.wait_for_timeout(550)
                entry = page.locator('#settingsFilesEntry')
                assert entry.is_visible()
                assert '公开文件' in entry.inner_text()
                page.locator('#settingsClose').click()
                page.wait_for_timeout(550)
                assert ui.horizontal_overflow() <= 1, ui.horizontal_overflow()
                return {'filters': filters_data, 'overflow': ui.horizontal_overflow(),
                        'publicFilesEntry': entry.inner_text()[:40]}

            case('N8-03', '1440 三种动态筛选仍是帖子；公开文件另入口可用', wide_explore_regression)

            def wide_journeys_regression():
                ui.nav('home')
                page.wait_for_timeout(700)
                page.locator('#homeJourneysAll').click()
                page.wait_for_timeout(800)
                assert page.locator('#page-journeys').is_visible()
                query = page.locator('#journeyQuery')
                query.fill('散步')
                page.wait_for_timeout(550)
                rows = page.locator('#journeyList [data-journey-open]')
                assert rows.count() >= 6, rows.count()
                page.locator('#page-journeys').evaluate('(e) => { e.scrollTop = 260; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                page.wait_for_timeout(250)
                saved_scroll = page.locator('#page-journeys').evaluate('(e) => e.scrollTop')
                assert saved_scroll > 0, saved_scroll
                rows.first.click()
                page.wait_for_timeout(700)
                assert page.locator('#page-journey').is_visible()
                ui.shot('n8-03-wide-journey-detail-1440')
                page.locator('#journeyBack').click()
                page.wait_for_timeout(700)
                assert page.locator('#page-journeys').is_visible()
                assert query.input_value() == '散步'
                assert page.locator('#page-journeys').evaluate('(e) => e.scrollTop') == saved_scroll
                ui.shot('n8-03-wide-journeys-1440')
                page.locator('#journeysBack').click()
                page.wait_for_timeout(650)
                assert page.locator('#page-home').is_visible()
                return {'journeyRows': rows.count(), 'search': query.input_value(), 'scroll': saved_scroll,
                        'overflow': ui.horizontal_overflow()}

            case('N8-04', '主页→全部记录→搜索/滚动→漫游详情→返回主页', wide_journeys_regression)

            def wide_contacts_chat_settings():
                ui.nav('contacts')
                page.wait_for_timeout(1000)
                row = page.locator(f'[data-contact-row="{PEER_B}"]')
                assert row.count() == 1
                unread_before = page.locator('#desktopNav [data-nav-badge="contacts"]').inner_text().strip()
                ui.shot('n8-04-wide-contacts-1440')
                row.locator('button[data-profile-peer]').first.click()
                page.wait_for_timeout(1000)
                assert page.locator('#profileView').is_visible()
                assert page.locator('#profileView [data-profile-tab]').count() == 3
                ui.shot('n8-04-wide-profile-1440')
                page.locator('#profileView [data-profile-tab="posts"]').click()
                page.wait_for_timeout(600)
                assert page.locator('#profileView [data-profile-tab="posts"]').get_attribute('aria-current') == 'page'
                page.locator('#profileView [data-profile-tab="address"]').click()
                page.wait_for_timeout(600)
                assert page.locator('#profileView [data-profile-tab="address"]').get_attribute('aria-current') == 'page'
                page.locator('#profileView [data-profile-tab="interactions"]').click()
                page.wait_for_timeout(600)
                page.locator('#profileMessage').click()
                page.wait_for_timeout(1200)
                assert page.locator('#conversationView').is_visible()
                assert ui.current() == ['contacts']
                ui.shot('n8-04-wide-chat-1440')
                page.locator('#messageInput').fill('第 8 项聊天齿轮往返草稿')
                page.locator('#settingsTrigger').click()
                page.wait_for_timeout(800)
                assert page.locator('#page-settings').is_visible()
                assert page.locator('#settingsTrigger').get_attribute('aria-current') == 'page'
                back = page.locator('#settingsClose').inner_text()
                ui.shot('n8-04-wide-settings-1440')
                page.locator('#settingsClose').click()
                page.wait_for_timeout(900)
                assert page.locator('#conversationView').is_visible()
                assert page.locator('#messageInput').input_value() == '第 8 项聊天齿轮往返草稿'
                draft_after_return = page.locator('#messageInput').input_value()
                page.locator('#conversationBack').click()
                page.wait_for_timeout(900)
                assert page.locator('#profileView').is_visible()
                assert page.locator('#profileView [data-profile-tab="interactions"]').get_attribute('aria-current') == 'page'
                assert ui.current() == ['contacts']
                page.locator('#profileBack').click()
                page.wait_for_timeout(900)
                assert page.locator('#page-contacts').is_visible()
                assert ui.current() == ['contacts']
                unread_after = page.locator('#desktopNav [data-nav-badge="contacts"]').inner_text().strip() if page.locator('#desktopNav [data-nav-badge="contacts"]').is_visible() else '0'
                return {'unreadBefore': unread_before, 'unreadAfter': unread_after,
                        'readCursor': read_unread(), 'settingsBack': back,
                        'draft': draft_after_return, 'overflow': ui.horizontal_overflow()}

            case('N8-05', '联系人分区↔聊天、齿轮往返、返回落点与未读', wide_contacts_chat_settings)

            def narrow_home():
                ui.viewport(390, 844)
                ui.nav('home')
                page.wait_for_timeout(900)
                assert not page.locator('#desktopNav').is_visible(), 'desktop nav visible at 390'
                assert page.locator('#mobileNav').is_visible(), 'mobile nav missing at 390'
                assert page.locator('#mobileNav button[data-nav]').count() == 3
                assert ui.current() == ['home']
                nav_rect = page.locator('#mobileNav').bounding_box()
                assert abs((nav_rect['y'] + nav_rect['height']) - 844) <= 1, nav_rect
                assert nav_rect['height'] >= 65, nav_rect
                label = page.locator('#nodeLabel')
                assert label.inner_text() == '节点在线'
                widths = label.evaluate('(e) => ({scroll: e.scrollWidth, client: e.clientWidth})')
                assert widths['scroll'] <= widths['client'] + 1, widths
                actions = page.locator('.rm-topbar-actions > *').evaluate_all('els => els.map(e => e.id)')
                assert actions == ['nodeTrigger', 'settingsTrigger'], actions
                active = page.locator('#mobileNav [data-nav="home"]')
                after = pseudo_after(active)
                assert after['content'] not in ('none', ''), after
                assert after['height'] == '3px', after
                assert after['background'] == 'rgb(122, 92, 255)', after
                assert ui.horizontal_overflow() <= 1, ui.horizontal_overflow()
                assert page.locator('#page-home').evaluate('(e) => e.scrollWidth - e.clientWidth') <= 1
                safe_rule = page.locator('style[data-raminga-styles]').evaluate(
                    '(e) => e.textContent.includes("env(safe-area-inset-bottom)")')
                assert safe_rule, 'bottom navigation lost its safe-area rule'
                page.locator('#page-home').evaluate('(e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                page.wait_for_timeout(300)
                last_tile = page.locator('#ramingaSessionList .rm-journey-tile').last.bounding_box()
                assert last_tile['y'] + last_tile['height'] <= nav_rect['y'] + 1, (last_tile, nav_rect)
                page.locator('#page-home').evaluate('(e) => { e.scrollTop = 0; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                ui.shot('n8-06-narrow-home-390')
                return {'navRect': nav_rect, 'nodeLabel': label.inner_text(), 'labelWidth': widths,
                        'activeUnderline': after, 'overflow': ui.horizontal_overflow(),
                        'desktopVisible': page.locator('#desktopNav').is_visible(),
                        'safeAreaRule': safe_rule, 'lastHomeTile': last_tile}

            case('N8-06', '390 只有一套主导航、品牌主页选中线、节点标签完整', narrow_home)

            def narrow_explore():
                ui.nav('explore')
                page.wait_for_timeout(1100)
                selected = page.locator('#page-explore .rm-filter[data-filter="all"]')
                style = selected.evaluate('(e) => ({bg: getComputedStyle(e).backgroundImage, color: getComputedStyle(e).color})')
                assert 'linear-gradient' in style['bg']
                assert style['color'] == 'rgb(255, 255, 255)'
                assert page.locator('#page-explore').evaluate('(e) => e.scrollWidth - e.clientWidth') <= 1
                nav_rect = page.locator('#mobileNav').bounding_box()
                page.locator('#page-explore').evaluate('(e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                page.wait_for_timeout(300)
                last_post = page.locator('#discoveryList .rm-post').last.bounding_box()
                assert last_post['y'] + last_post['height'] <= nav_rect['y'] + 1, (last_post, nav_rect)
                page.locator('#page-explore').evaluate('(e) => { e.scrollTop = 0; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                ui.shot('n8-07-narrow-explore-390')
                return {'filter': style, 'posts': page.locator('#discoveryList .rm-post').count(),
                        'overflow': ui.horizontal_overflow(), 'lastPost': last_post, 'nav': nav_rect}

            case('N8-07', '390 动态筛选实紫、无横向溢出', narrow_explore)

            def narrow_chat():
                ui.nav('contacts')
                page.wait_for_timeout(900)
                nav_rect = page.locator('#mobileNav').bounding_box()
                page.locator('#page-contacts').evaluate('(e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                page.wait_for_timeout(250)
                last_row = page.locator('#contactList [data-contact-row]').last.bounding_box()
                assert last_row['y'] + last_row['height'] <= nav_rect['y'] + 1, (last_row, nav_rect)
                page.locator('#page-contacts').evaluate('(e) => { e.scrollTop = 0; e.dispatchEvent(new Event("scroll", {bubbles:true})); }')
                ui.shot('n8-08-narrow-contacts-390')
                page.locator(f'[data-contact-row="{PEER_B}"] button[data-profile-peer]').first.click()
                page.wait_for_timeout(900)
                assert page.locator('#profileView').is_visible()
                ui.shot('n8-08-narrow-profile-390')
                page.locator('#profileMessage').click()
                page.wait_for_timeout(1000)
                assert page.locator('#conversationView').is_visible()
                ui.shot('n8-08-narrow-chat-390')
                composer = page.locator('#composer').bounding_box()
                nav_rect = page.locator('#mobileNav').bounding_box()
                list_rect = page.locator('#messageList').bounding_box()
                assert composer['y'] + composer['height'] <= nav_rect['y'] + 1, (composer, nav_rect)
                assert list_rect['y'] + list_rect['height'] <= composer['y'] + 1, (list_rect, composer)
                page.locator('#messageInput').fill('窄屏齿轮草稿')
                page.locator('#settingsTrigger').click()
                page.wait_for_timeout(700)
                assert page.locator('#page-settings').is_visible()
                assert page.locator('#settingsTrigger').get_attribute('aria-current') == 'page'
                ui.shot('n8-08-narrow-settings-390')
                page.locator('#settingsClose').click()
                page.wait_for_timeout(850)
                assert page.locator('#conversationView').is_visible()
                assert page.locator('#messageInput').input_value() == '窄屏齿轮草稿'
                # Keyboard focus ring on the narrow home mark.
                explore = page.locator('#mobileNav [data-nav="explore"]')
                explore.focus()
                page.keyboard.press('Tab')
                focus = ui.focus_info()
                assert focus['nav'] == 'home', focus
                assert focus['focusVisible'] is True, focus
                assert int(float(focus['outlineWidth'].replace('px', ''))) >= 2, focus
                page.keyboard.press('Enter')
                page.wait_for_timeout(700)
                assert page.locator('#page-home').is_visible()
                assert ui.current() == ['home']
                ui.shot('n8-08-narrow-home-focus-390')
                return {'composer': composer, 'nav': nav_rect, 'list': list_rect,
                        'focus': focus, 'overflow': ui.horizontal_overflow()}

            case('N8-08', '390 聊天/设置往返、底栏不遮输入、键盘回车回主页', narrow_chat)

            def narrow_status():
                page.locator('#nodeTrigger').click()
                page.wait_for_timeout(650)
                assert page.locator('#statusDialog').is_visible()
                ui.shot('n8-09-narrow-status-390')
                page.locator('#statusDialog [data-close-dialog]').first.click()
                page.wait_for_timeout(350)
                assert ui.focus_info()['id'] == 'nodeTrigger', ui.focus_info()
                return {'connections': page.locator('#statusConnections').inner_text()}

            case('N8-09', '390 状态详情与关闭焦点', narrow_status)

            def node_offline():
                ui.viewport(1440, 900)
                ui.nav('home')
                page.wait_for_timeout(600)
                subprocess.run([str(BIN), 'stop', '--data-dir', str(DIR_A)],
                               capture_output=True, text=True, timeout=25)
                wait_for(lambda: page.locator('#nodeLabel').inner_text() != '节点在线',
                         'node status leaves online', 25)
                label = page.locator('#nodeLabel').inner_text()
                assert label in ('更新中断', '暂不可用', '已断开'), label
                ui.shot('n8-10-wide-node-offline-1440')
                page.locator('#nodeTrigger').click()
                page.wait_for_timeout(600)
                summary = page.locator('#statusSummary').inner_text()
                phase = page.locator('#statusPhase').inner_text()
                ui.shot('n8-10-wide-node-offline-status-1440')
                page.locator('#statusDialog [data-close-dialog]').first.click()
                return {'label': label, 'phase': phase, 'summary': summary}

            case('N8-10', '真实节点停止后短状态变化与详情可用', node_offline)

        RESULTS['passed'] = True
    except Exception as exc:  # noqa: BLE001 - preserve overall failure evidence
        RESULTS['topLevelError'] = str(exc)
        RESULTS['trace'] = traceback.format_exc()[-12000:]
        print(f'FAIL top-level: {exc}', flush=True)
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass
        stop_host()
        if nodes_running:
            for name in ('node-a', 'node-b'):
                subprocess.run([str(BIN), 'stop', '--data-dir', str(ROOT / name)],
                               capture_output=True, text=True, timeout=20)
        RESULTS['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save()
        print(f'results: {RESULT_FILE}', flush=True)


if __name__ == '__main__':
    main()
