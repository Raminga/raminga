#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 2: the contact list.

The fixture is prepared by prepare.mjs. This driver starts one isolated DSH Web
host (default 4372), operates Chromium at 1440x900 and 390x844, and records
screenshots, host logs and a JSON result file. It only touches the batch2-02
fixture ports/data and never the user's real DSH profile or ~/.raminga.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import socket
import subprocess
import time
import traceback
import urllib.request

ROOT = pathlib.Path(os.environ.get('B2_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-contacts')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
HOST_PORT = int(os.environ.get('B2_HOST_PORT', FIXTURE.get('hostPort', 4372)))
CONTROL_PORT = int(os.environ.get('B2_CONTROL_PORT', FIXTURE.get('controlPort', 4339)))
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
PEER_B = FIXTURE['nodeB']
PEER_C = FIXTURE['nodeC']
PEER_D = FIXTURE['offlinePeer']
PEER_E = FIXTURE['cluePeer']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {},
    'screenshots': [],
    'hostLogs': [],
    'pageErrors': [],
    'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-contact-list-results.json'


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) else 'FAIL'
    RESULT_FILE.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def case(cid, name, fn):
    started = time.time()
    try:
        data = fn() or {}
        RESULTS['cases'][cid] = {'id': cid, 'name': name, 'status': 'PASS', 'seconds': round(time.time() - started, 2), **data}
        print(f'PASS {cid} {name}')
    except Exception as exc:  # noqa: BLE001 - record the real failure
        RESULTS['cases'][cid] = {
            'id': cid, 'name': name, 'status': 'FAIL', 'seconds': round(time.time() - started, 2),
            'error': str(exc), 'trace': traceback.format_exc()[-5000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
    finally:
        save()


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) != 0


def wait_port_free(port, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_free(port):
            return
        time.sleep(0.2)
    raise AssertionError(f'port {port} is in use; refusing to signal an unverified PID')


def post_tool(tool, args=None, timeout=30):
    request = urllib.request.Request(
        f'http://127.0.0.1:{CONTROL_PORT}/run',
        data=json.dumps({'tool': tool, 'args': args or {}}).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def node_snapshot():
    status = post_tool('raminga_status')['value']
    friends = post_tool('raminga_friends')['value']
    connections = {item.get('peerId') or item.get('peer_id') for item in status.get('connections') or []}
    peers = {item.get('peerId') or item.get('peer_id') for item in status.get('peers') or []}
    friend_ids = {item.get('peerId') or item.get('peer_id') for item in friends.get('friends') or []}
    return {
        'connections': sorted(value for value in connections if value),
        'peers': sorted(value for value in peers if value),
        'friends': sorted(value for value in friend_ids if value),
        'statusAt': time.time(),
    }


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_recorded_host():
    """Prune dead records only; never signal a recorded PID.

    A PID number may be reused after the recorded host exits, so an old
    pid/meta pair is not proof that the current process belongs to this
    fixture. This run's host is owned by its Popen object and is stopped by
    stop_host(). A live stale record is reported and left alone; the caller
    then refuses to start on an occupied port instead of guessing.
    """
    for pid_path in sorted(EVIDENCE.glob('dsh-*.pid')):
        match = re.search(r'dsh-(\d+)\.pid$', pid_path.name)
        if not match:
            continue
        try:
            pid = int(pid_path.read_text().strip())
        except (OSError, ValueError):
            pid = 0
        if pid <= 1 or not pid_alive(pid):
            pid_path.unlink(missing_ok=True)
            pid_path.with_name(pid_path.name + '.meta').unlink(missing_ok=True)
            continue
        print(f'refusing to signal recorded host pid={pid} port={match.group(1)}; '
              'the PID may have been reused and its Popen owner is gone', flush=True)


def start_host():
    stop_recorded_host()
    wait_port_free(HOST_PORT)
    log_path = EVIDENCE / 'host-b2-contact-list.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B2_DATA_DIR': FIXTURE['nodeAData'],
        'B2_DSH_HOME': FIXTURE['dshHome'],
        'B2_HOST_PORT': str(HOST_PORT),
        'B2_CONTROL_PORT': str(CONTROL_PORT),
        'B2_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(REPO / 'bin' / 'raminga'),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 40
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
        raise AssertionError(f'host did not publish a URL: {log_path.read_text(errors="replace")[-3000:]}')
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    return process, url


def terminate_process(process):
    """Signal only this run's actual child Popen object."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def stop_host(process):
    if process is None:
        return
    terminate_process(process)
    wait_port_free(HOST_PORT)
    for pid_path in EVIDENCE.glob('dsh-*.pid'):
        try:
            if int(pid_path.read_text().strip()) == process.pid:
                pid_path.unlink(missing_ok=True)
                pid_path.with_name(pid_path.name + '.meta').unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(8):
            overlay = self.page.locator('dialog[open]')
            close = self.page.locator('[aria-label="Close"]:visible, [aria-label="关闭"]:visible')
            if close.count():
                close.first.click()
                self.page.wait_for_timeout(260)
                continue
            if overlay.count() == 0:
                return
            inner = overlay.first.locator('[data-close-dialog]:visible')
            if inner.count():
                inner.first.click()
            else:
                self.page.keyboard.press('Escape')
            self.page.wait_for_timeout(220)

    def open_panel(self):
        if self.page.locator('#settingsTrigger').count() and self.page.locator('#settingsTrigger').is_visible():
            return
        self.dismiss()
        if not self.wide:
            toggle = self.page.locator('[aria-label="Open sidebar"]:visible')
            if toggle.count():
                toggle.first.click()
                self.page.wait_for_timeout(650)
        self.page.get_by_role('button', name='Raminga', exact=True).first.click()
        self.page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(900)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(700)
        self.open_panel()
        self.page.wait_for_timeout(350)

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(650)

    def nav_current(self):
        out = []
        for sel in ['#desktopNav', '#mobileNav']:
            loc = self.page.locator(sel)
            if loc.count() and loc.is_visible():
                out.extend(loc.locator('[aria-current="page"]').evaluate_all(
                    'els => els.map(e => e.dataset.nav)'))
        return out

    def contacts(self):
        self.dismiss()
        if self.page.locator('#profileBack').count() and self.page.locator('#profileBack').is_visible():
            self.page.locator('#profileBack').click()
            self.page.wait_for_timeout(400)
        if self.page.locator('#conversationView').count() and self.page.locator('#conversationView').is_visible():
            self.page.locator('#conversationBack').click()
            self.page.wait_for_timeout(400)
        self.open_panel()
        self.nav('contacts')
        self.page.locator('[data-contact-row]').first.wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(350)

    def row(self, peer):
        return self.page.locator(f'[data-contact-row="{peer}"]')

    def rows(self):
        return self.page.locator('[data-contact-row]')

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')

    def visual_overflow(self, selector):
        return self.page.locator(selector).evaluate('''(node) => {
          const width = window.innerWidth;
          return [...node.querySelectorAll('*')].filter((element) => {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 1 && (rect.left < -1 || rect.right > width + 1);
          }).length;
        }''')

    def active_focus(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.getAttribute('data-focus-key') || node.getAttribute('id') || '') : '';
        }''')


def wait_for(predicate, label, timeout=25):
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


def box(locator):
    value = locator.bounding_box()
    assert value is not None, 'bounding box is missing'
    return value


def no_target_side_effects(snapshot, before):
    assert PEER_D not in snapshot['connections'], f'offline local row was dialed: {snapshot["connections"]}'
    assert PEER_E not in snapshot['connections'], f'clue target was dialed: {snapshot["connections"]}'
    assert PEER_E not in set(snapshot['friends']), 'clue target was auto-added to contacts'
    assert PEER_D in set(snapshot['friends']), 'the local offline row disappeared'
    assert set(before['friends']).issubset(set(snapshot['friends'])), 'a contact disappeared unexpectedly'


def reset_fixture_projection():
    """Make every acceptance run independent of the previous run's cache.

    The projection is a real feature, so it is exercised inside this run by
    B2C-02/B2C-05 and read back by B2C-08. Resetting only this isolated
    fixture's file keeps a rerun from starting with yesterday's clue/avatar.
    """
    projection = pathlib.Path(FIXTURE['nodeAData']) / 'agent' / 'host' / 'dsh' / 'contact-list.json'
    try:
        projection.unlink()
        print(f'reset fixture projection: {projection}', flush=True)
    except FileNotFoundError:
        pass


def main():
    reset_fixture_projection()
    host_process, url = start_host()
    origin = re.match(r'(https?://[^/]+)', url).group(1)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            try:
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=origin)
            except Exception:  # noqa: BLE001 - record the limitation below if it matters
                pass
            page = context.new_page()
            page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
            page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
                    if message.type == 'error' else None)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_timeout(1200)
            ui = UI(page)
            try:
                def fresh_unread():
                    env = os.environ.copy()
                    env['B2_ACCEPTANCE_DIR'] = str(ROOT)
                    env['B2_UNREAD_COUNT'] = '3'
                    env['B2_UNREAD_TAG'] = str(int(time.time() * 1000))
                    result = subprocess.run(
                        ['node', str(REPO / 'scripts' / 'ui-acceptance' / 'batch2-02' / 'send-unread.mjs')],
                        cwd=REPO, env=env, capture_output=True, text=True, timeout=60,
                    )
                    if result.returncode != 0:
                        raise AssertionError(f'send-unread failed: {result.stderr or result.stdout}')
                    return json.loads(result.stdout.strip().splitlines()[-1])

                ui.viewport(1440, 900)
                ui.contacts()
                send_result = fresh_unread()
                ui.contacts()

                def b2c01():
                    before = node_snapshot()
                    assert len(ui.rows().all()) >= 11, f'expected the scrollable fixture, got {len(ui.rows().all())}'
                    assert ui.page.locator('#contactClues').is_hidden(), 'no directory read yet must mean no clue section'
                    b = ui.row(PEER_B)
                    c = ui.row(PEER_C)
                    d = ui.row(PEER_D)
                    wait_for(lambda: b.locator('.rm-contact-unread').count() > 0, 'fresh unread badge', 12)

                    def unread_converged():
                        nav = ui.page.locator('[data-nav-badge="contacts"]:visible')
                        if not nav.count():
                            return False
                        row_text = b.locator('.rm-contact-unread').inner_text().strip()
                        return row_text.isdigit() and row_text == nav.first.inner_text().strip()
                    wait_for(unread_converged, 'row and navigation unread counts converge', 12)
                    unread_text = b.locator('.rm-contact-unread').inner_text().strip()
                    nav_unread = ui.page.locator('[data-nav-badge="contacts"]:visible').first.inner_text().strip()
                    assert unread_text.isdigit() and int(unread_text) >= 1, f'unread badge = {unread_text!r}'
                    assert unread_text == nav_unread, f'row unread {unread_text} != navigation unread {nav_unread}'
                    assert '最后一条未读' in b.locator('.rm-contact-recent').inner_text()
                    assert b.locator('.rm-contact-time').is_visible()
                    assert b.locator('.rm-contact-time').inner_text().strip() != ''
                    assert b.locator('button[data-chat-peer]').is_visible()
                    assert b.locator('.rm-contact-state').inner_text().strip() == '已连接'
                    assert b.locator('.rm-contact-avatar img').count() == 0, 'initial list must not read a profile for an avatar'

                    assert c.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['localC']['name']
                    assert c.locator('.rm-contact-avatar img').count() == 0
                    assert c.locator('.rm-contact-recent').inner_text().strip() == '还没有消息'
                    assert c.locator('.rm-contact-unread').count() == 0
                    assert c.locator('.rm-contact-time').is_visible() is False

                    assert d.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['offlineName']
                    assert d.locator('.rm-contact-avatar img').count() == 0
                    assert d.locator('.rm-contact-avatar').inner_text().strip() == 'O'
                    assert '本机备注' in d.locator('.rm-contact-local-note').inner_text()
                    assert d.locator('.rm-contact-state').inner_text().strip() == '未连接'
                    assert d.locator('.rm-contact-state').get_attribute('title').find('不等于对方永久离线') >= 0

                    chat_box = box(b.locator('button[data-chat-peer]'))
                    assert chat_box['width'] >= 38 and chat_box['height'] >= 38
                    assert ui.overflow() <= 1, f'document overflows horizontally: {ui.overflow()}'
                    assert ui.visual_overflow('#page-contacts') == 0
                    snapshot = node_snapshot()
                    no_target_side_effects(snapshot, before)
                    assert PEER_E not in snapshot['connections']
                    no_target_side_effects(node_snapshot(), before)
                    ui.shot('wide-contact-list-initial-1440')
                    return {
                        'rows': len(ui.rows().all()),
                        'bUnread': unread_text,
                        'navUnread': nav_unread,
                        'freshUnreadMessages': send_result['count'],
                        'bRecent': b.locator('.rm-contact-recent').inner_text(),
                        'bChat': chat_box,
                        'cRecent': c.locator('.rm-contact-recent').inner_text(),
                        'dState': d.locator('.rm-contact-state').inner_text(),
                        'initialAvatarImages': 0,
                    }

                case('B2C-01', 'Wide list: unread/chat/time/recent first; missing avatar, long name and offline fallbacks; no auto reads', b2c01)

                def b2c02():
                    ui.contacts()
                    before = node_snapshot()
                    b = ui.row(PEER_B)
                    avatar_initial = b.locator('.rm-contact-avatar img').count()
                    b.locator('button[data-contact-peer]').click()
                    ui.page.locator('#profileView').wait_for(state='visible', timeout=15000)
                    wait_for(lambda: ui.page.locator('#profileName').inner_text().strip() == FIXTURE['publicB']['displayName'],
                             'B public Agent name')
                    name = ui.page.locator('#profileName').inner_text().strip()
                    avatar = ui.page.locator('#profileAvatar img')
                    avatar.wait_for(state='visible', timeout=15000)
                    profile_src = avatar.get_attribute('src')
                    assert profile_src.startswith('data:image/png;base64,'), 'profile avatar was not read through the controlled preview'
                    assert avatar.evaluate('(node) => node.naturalWidth') > 0, 'profile avatar did not decode'
                    ui.shot('wide-b-profile-avatar-1440')
                    ui.page.locator('#profileBack').click()
                    ui.page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                    ui.page.wait_for_timeout(500)
                    b = ui.row(PEER_B)
                    assert b.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['publicB']['displayName']
                    local_note = b.locator('.rm-contact-local-note').inner_text()
                    assert '本机备注' in local_note
                    assert FIXTURE['localB']['name'] in local_note
                    assert FIXTURE['localB']['description'] in local_note
                    list_avatar = b.locator('.rm-contact-avatar img')
                    list_avatar.wait_for(state='visible', timeout=10000)
                    assert list_avatar.get_attribute('src') == profile_src, 'list avatar differs from the profile cache'
                    assert list_avatar.evaluate('(node) => node.naturalWidth') > 0
                    assert b.locator('.rm-contact-avatar').get_attribute('data-kind') == 'image'
                    assert ui.row(PEER_C).locator('.rm-contact-avatar img').count() == 0, 'opening B must not fetch C'
                    assert ui.row(PEER_C).locator('.rm-contact-name b').inner_text().strip() == FIXTURE['localC']['name']
                    snapshot = node_snapshot()
                    no_target_side_effects(snapshot, before)
                    ui.shot('wide-contact-list-verified-b-1440')
                    return {
                        'profileName': name,
                        'avatarDataUrlPrefix': profile_src[:32],
                        'listAvatarMatchesProfile': True,
                        'localNote': b.locator('.rm-contact-local-note').inner_text(),
                        'initialAvatarImages': avatar_initial,
                    }

                case('B2C-02', 'Verified public Agent name and avatar are reused from the profile; local name/note stay distinct', b2c02)

                def b2c03():
                    ui.contacts()
                    c = ui.row(PEER_C)
                    c.locator('button[data-contact-peer]').click()
                    ui.page.locator('#profileView').wait_for(state='visible', timeout=15000)
                    wait_for(lambda: ui.page.locator('#profileName').inner_text().strip() == FIXTURE['publicC']['displayName'],
                             'C long public Agent name')
                    name = ui.page.locator('#profileName').inner_text().strip()
                    assert ui.page.locator('#profileAvatar img').count() == 0, 'a profile without avatar must keep the fallback'
                    assert ui.page.locator('#profileAvatar').inner_text().strip() == '潮'
                    ui.shot('wide-c-profile-long-no-avatar-1440')
                    ui.page.locator('#profileBack').click()
                    ui.page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                    ui.page.wait_for_timeout(400)
                    c = ui.row(PEER_C)
                    assert c.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['publicC']['displayName']
                    assert FIXTURE['localC']['name'] in c.locator('.rm-contact-local-note').inner_text()
                    assert c.locator('.rm-contact-avatar img').count() == 0
                    assert c.locator('.rm-contact-avatar').inner_text().strip() == '潮'
                    assert c.locator('.rm-contact-recent').inner_text().strip() == '还没有消息'
                    assert c.locator('.rm-contact-time').is_visible() is False
                    metrics = c.evaluate('''(row) => {
                      const copy = row.querySelector('.rm-contact-copy');
                      const name = row.querySelector('.rm-contact-name b');
                      return {
                        copyWidth: copy.getBoundingClientRect().width,
                        nameWidth: name.getBoundingClientRect().width,
                        rowScroll: row.scrollWidth - row.clientWidth,
                        pageScroll: document.documentElement.scrollWidth - window.innerWidth,
                        wrap: getComputedStyle(name).overflowWrap,
                      };
                    }''')
                    assert metrics['rowScroll'] <= 1, f'long name overflows its row: {metrics}'
                    assert metrics['pageScroll'] <= 1, f'long name overflows the page: {metrics}'
                    assert metrics['nameWidth'] <= metrics['copyWidth'] + 1
                    ui.shot('wide-contact-list-long-no-avatar-1440')
                    return {'publicName': name, 'avatarFallback': '潮', **metrics}

                case('B2C-03', 'Long public name without avatar wraps; both profile and list keep the initial fallback', b2c03)

                def b2c04():
                    ui.contacts()
                    b = ui.row(PEER_B)
                    query = ui.page.locator('#contactQuery')
                    query.fill(PEER_B[-12:])
                    ui.page.wait_for_timeout(450)
                    assert ui.rows().count() == 1, f'Peer ID search should isolate one row, got {ui.rows().count()}'
                    assert ui.row(PEER_B).count() == 1
                    query.fill('')
                    ui.page.wait_for_timeout(350)
                    b = ui.row(PEER_B)
                    toggle = b.locator('[data-toggle-peer]')
                    toggle.click()
                    full = b.locator('.rm-peer-id-full')
                    assert full.is_visible(), 'expanding must reveal the complete Peer ID'
                    assert full.inner_text().strip() == PEER_B
                    assert b.locator('.rm-peer-id-short').is_hidden()
                    assert toggle.get_attribute('aria-expanded') == 'true'
                    geometry = b.evaluate('''(row) => {
                      const main = row.querySelector('.rm-contact-main').getBoundingClientRect();
                      const ident = row.querySelector('.rm-contact-ident').getBoundingClientRect();
                      const full = row.querySelector('.rm-peer-id-full').getBoundingClientRect();
                      return { mainBottom: main.bottom, identTop: ident.top, fullRight: full.right, width: window.innerWidth };
                    }''')
                    assert geometry['identTop'] >= geometry['mainBottom'] - 1, f'identifier overlaps body: {geometry}'
                    assert geometry['fullRight'] <= geometry['width'] + 1, f'full identifier overflows: {geometry}'
                    ui.shot('wide-contact-full-peer-id-1440')
                    copy = b.locator('[data-copy-peer]')
                    copy.click()
                    wait_for(lambda: copy.inner_text().strip() == '已复制', 'copy acknowledgement')
                    clipboard = None
                    try:
                        clipboard = ui.page.evaluate('async () => await navigator.clipboard.readText()')
                    except Exception as error:  # noqa: BLE001 - recorded, not hidden
                        clipboard = f'unavailable: {error}'
                    assert clipboard == PEER_B, f'clipboard did not contain the full Peer ID: {clipboard!r}'
                    toggle.click()
                    assert b.locator('.rm-peer-id-short').is_visible()
                    assert b.locator('.rm-peer-id-full').is_hidden()
                    return {
                        'searchSuffix': PEER_B[-12:],
                        'fullIdVisible': True,
                        'geometry': geometry,
                        'clipboard': 'match',
                    }

                case('B2C-04', 'Peer ID search, expand, layout and clipboard use the complete identifier without squeezing the body', b2c04)

                def b2c05():
                    ui.contacts()
                    before = node_snapshot()
                    ui.row(PEER_B).locator('button[data-contact-peer]').click()
                    ui.page.locator('#profileView').wait_for(state='visible', timeout=15000)
                    ui.page.locator('[data-profile-tab="address"]').click()
                    ui.page.wait_for_timeout(1500)
                    clues = ui.page.locator('#contactClueList .rm-clue-row')
                    clues.first.wait_for(state='attached', timeout=15000)
                    wait_for(lambda: not ui.page.locator('#contactClues').evaluate('(node) => node.hidden'), 'clue section')
                    assert clues.count() == 1, f'expected exactly one non-local clue, got {clues.count()}'
                    clue = clues.first
                    assert clue.get_attribute('data-clue-peer') == PEER_E
                    assert '未访问' in clue.inner_text()
                    assert FIXTURE['clueName'] in clue.inner_text()
                    assert '潮汐线旁的林岸' in clue.inner_text()
                    ui.shot('wide-b-address-clue-1440')
                    ui.page.locator('#profileBack').click()
                    ui.page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                    ui.page.wait_for_timeout(450)
                    assert ui.page.locator('#contactClues').is_visible()
                    clue = ui.page.locator(f'[data-clue-peer="{PEER_E}"]')
                    assert clue.is_visible()
                    clue.scroll_into_view_if_needed()
                    ui.page.wait_for_timeout(300)
                    ui.shot('wide-contact-clue-section-1440')
                    view = clue.locator('[data-view-clue]')
                    view.click()
                    notice = ui.page.locator('#noticeDialog')
                    notice.wait_for(state='visible', timeout=5000)
                    text = notice.inner_text()
                    assert PEER_E in text
                    assert '不会建立连接' in text
                    assert '不会自动添加联系人' in text
                    assert '不会读取该节点的公开档案' in text
                    after = node_snapshot()
                    no_target_side_effects(after, before)
                    assert PEER_E not in after['connections']
                    assert PEER_E not in after['friends']
                    ui.shot('wide-contact-clue-view-1440')
                    notice.locator('[data-close-dialog]').first.click()
                    ui.page.wait_for_timeout(350)
                    assert notice.is_hidden()
                    focused_text = ui.page.evaluate('''() => {
                      let node = document.activeElement;
                      while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
                      return node ? node.textContent : '';
                    }''')
                    assert focused_text.strip() == '查看线索', f'clue close lost focus: {focused_text!r}'
                    return {
                        'cluePeer': PEER_E,
                        'clueName': FIXTURE['clueName'],
                        'connectionsAfter': after['connections'],
                        'friendsContainsClue': PEER_E in after['friends'],
                        'noticeText': text[:500],
                    }

                case('B2C-05', 'A real public directory claim appears as unvisited evidence; viewing it dials/reads/adds nothing', b2c05)

                def b2c06():
                    ui.contacts()
                    query = ui.page.locator('#contactQuery')
                    query.fill(FIXTURE['localB']['name'])
                    ui.page.wait_for_timeout(400)
                    ui.page.locator('#page-contacts').evaluate('(node) => { node.scrollTop = 160; }')
                    ui.page.wait_for_timeout(250)
                    b = ui.row(PEER_B)
                    before_scroll = ui.page.locator('#page-contacts').evaluate('(node) => node.scrollTop')
                    chat = b.locator('button[data-chat-peer]')
                    chat.click()
                    ui.page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                    assert ui.nav_current() == ['contacts']
                    back = ui.page.locator('#conversationBack')
                    assert '返回联系人' in back.inner_text()
                    back.click()
                    ui.page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                    ui.page.wait_for_timeout(500)
                    assert query.input_value() == FIXTURE['localB']['name'], 'search was not restored'
                    after_scroll = ui.page.locator('#page-contacts').evaluate('(node) => node.scrollTop')
                    assert after_scroll == before_scroll, f'scroll changed: {before_scroll} -> {after_scroll}'
                    assert '最后一条未读' in ui.row(PEER_B).locator('.rm-contact-recent').inner_text()
                    assert ui.active_focus() == f'contact-chat:{PEER_B}', 'inline chat did not regain its exact trigger'
                    ui.shot('wide-inline-chat-return-1440')
                    query.fill('')
                    ui.page.wait_for_timeout(300)
                    return {
                        'search': FIXTURE['localB']['name'],
                        'scroll': after_scroll,
                        'focus': ui.active_focus(),
                        'nav': ui.nav_current(),
                    }

                case('B2C-06', 'First-batch-C inline chat still returns the row anchor, search, scroll and chat-button focus', b2c06)

                def b2c07():
                    ui.viewport(390, 844)
                    ui.contacts()
                    mobile = ui.page.locator('#mobileNav')
                    desktop = ui.page.locator('#desktopNav')
                    assert mobile.is_visible(), 'narrow layout needs the bottom navigation'
                    assert desktop.is_hidden(), 'narrow layout must hide the desktop navigation'
                    assert ui.overflow() <= 1, f'narrow document overflows: {ui.overflow()}'
                    assert ui.visual_overflow('#page-contacts') == 0
                    ui.page.locator('#page-contacts').evaluate('(node) => { node.scrollTop = 0; }')
                    chat_box = box(ui.row(PEER_B).locator('button[data-chat-peer]'))
                    assert chat_box['width'] >= 42 and chat_box['height'] >= 42, f'narrow chat target = {chat_box}'
                    assert ui.row(PEER_B).locator('.rm-contact-time').is_visible()
                    assert ui.row(PEER_B).locator('.rm-contact-avatar img').is_visible()
                    ui.shot('narrow-contact-list-top-390')
                    long = ui.row(PEER_D)
                    long.scroll_into_view_if_needed()
                    ui.page.wait_for_timeout(250)
                    assert long.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['offlineName']
                    long_metrics = long.evaluate('''(row) => ({
                      rowScroll: row.scrollWidth - row.clientWidth,
                      pageScroll: document.documentElement.scrollWidth - window.innerWidth,
                    })''')
                    assert long_metrics['rowScroll'] <= 1 and long_metrics['pageScroll'] <= 1
                    ui.shot('narrow-contact-list-offline-390')
                    clue = ui.page.locator(f'[data-clue-peer="{PEER_E}"]')
                    clue.scroll_into_view_if_needed()
                    ui.page.wait_for_timeout(250)
                    assert clue.is_visible()
                    assert ui.visual_overflow('#contactClues') == 0
                    ui.shot('narrow-contact-clue-390')
                    return {
                        'chatTarget': chat_box,
                        'navCurrent': ui.nav_current(),
                        'desktopHidden': True,
                        'mobileVisible': True,
                        'longMetrics': long_metrics,
                        'overflow': ui.overflow(),
                    }

                case('B2C-07', '390x844 keeps one navigation, visible time/chat/avatar, wrapped long name and no horizontal overflow', b2c07)

                def b2c08():
                    # The returned defect: a full reload lost the already
                    # verified public name/avatar and the real directory clue.
                    ui.viewport(1440, 900)
                    ui.contacts()
                    before = node_snapshot()
                    page.reload(wait_until='domcontentloaded')
                    page.wait_for_timeout(1600)
                    ui.contacts()
                    b = ui.row(PEER_B)
                    wait_for(lambda: b.locator('.rm-contact-name b').inner_text().strip()
                             == FIXTURE['publicB']['displayName'], 'persisted public name after reload')
                    avatar = b.locator('.rm-contact-avatar img')
                    avatar.wait_for(state='visible', timeout=15000)
                    assert avatar.get_attribute('src').startswith('data:image/png;base64,'), 'persisted avatar is not a verified local image'
                    assert avatar.evaluate('(node) => node.naturalWidth') > 0
                    clue = page.locator(f'[data-clue-peer="{PEER_E}"]')
                    clue.wait_for(state='visible', timeout=15000)
                    assert '未访问' in clue.inner_text()
                    assert FIXTURE['clueName'] in clue.inner_text()
                    assert ui.page.locator('#contactClues').is_visible()
                    assert ui.row(PEER_C).locator('.rm-contact-avatar img').count() == 0
                    assert b.locator('.rm-contact-avatar').get_attribute('data-kind') == 'image'
                    after = node_snapshot()
                    no_target_side_effects(after, before)
                    assert set(before['friends']) == set(after['friends'])
                    ui.shot('wide-contact-list-after-reload-1440')
                    return {
                        'publicName': b.locator('.rm-contact-name b').inner_text().strip(),
                        'avatarState': 'ready',
                        'cluePeer': PEER_E,
                        'clueText': clue.inner_text()[:160],
                        'friendsUnchanged': True,
                    }

                case('B2C-08', 'Full page reload keeps the verified public name/avatar and the real unvisited directory clue', b2c08)

            finally:
                ui.dismiss()
                context.close()
            browser.close()
    finally:
        stop_host(host_process)
        save()


if __name__ == '__main__':
    main()
