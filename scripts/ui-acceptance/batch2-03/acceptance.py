#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 3: the contact profile.

The fixture is created by prepare.mjs. This driver starts one isolated DSH Web
host (default 4376, control 4343), operates Chromium at 1440x900 and 390x844,
and records screenshots, host logs and a JSON result file. It only touches the
batch2-03 fixture ports/data and never the user's real DSH profile or ~/.raminga.
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

ROOT = pathlib.Path(os.environ.get('B3_ACCEPTANCE_DIR', '.local/prototype-remediation/b3-contact-profile')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
HOST_PORT = int(os.environ.get('B3_HOST_PORT', FIXTURE.get('hostPort', 4376)))
CONTROL_PORT = int(os.environ.get('B3_CONTROL_PORT', FIXTURE.get('controlPort', 4343)))
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
PEER_B = FIXTURE['nodeB']
PEER_C = FIXTURE['nodeC']
PEER_G = FIXTURE['nodeG']
PEER_E = FIXTURE.get('nodeE', '')
PEER_D = FIXTURE['offlinePeer']
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
RESULT_FILE = EVIDENCE / 'b3-contact-profile-results.json'


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) and not RESULTS['pageErrors'] else 'FAIL'
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
    raise AssertionError(f'port {port} is still in use after the previous host exited')


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_recorded_host():
    # Prune dead records only; never signal a recorded PID. This run's host is
    # owned by its Popen object and stopped by stop_host().
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
    log_path = EVIDENCE / 'host-b3-contact-profile.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B3_DATA_DIR': FIXTURE['nodeAData'],
        'B3_DSH_HOME': FIXTURE['dshHome'],
        'B3_HOST_PORT': str(HOST_PORT),
        'B3_CONTROL_PORT': str(CONTROL_PORT),
        'B3_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(REPO / 'bin' / 'raminga'),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 45
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
    """Signal only this run's actual child Popen process group."""
    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=12)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
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


def stop_fixture_node(name):
    data_dir = FIXTURE.get(f'{name}Data')
    if not data_dir:
        raise AssertionError(f'fixture has no {name}Data')
    result = subprocess.run(
        [str(REPO / 'bin' / 'raminga'), 'stop', '--data-dir', data_dir],
        cwd=REPO, capture_output=True, text=True, timeout=20,
    )
    if result.returncode != 0 and 'not running' not in (result.stderr + result.stdout).lower():
        raise AssertionError(f'failed to stop {name}: {result.stderr or result.stdout}')



def read_fixture_status(name):
    data_dir = FIXTURE[f'{name}Data']
    result = subprocess.run(
        [str(REPO / 'bin' / 'raminga'), 'status', '--json', '--data-dir', data_dir],
        cwd=REPO, capture_output=True, text=True, timeout=20,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def start_fixture_node(name):
    """Restart one fixture node through its normal daemon command."""
    data_dir = FIXTURE[f'{name}Data']
    log_path = EVIDENCE / f'{name}-restart.log'
    log = log_path.open('a')
    process = subprocess.Popen(
        [str(REPO / 'bin' / 'raminga'), 'daemon', '--data-dir', data_dir],
        cwd=REPO, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    try:
        status = wait_for(lambda: read_fixture_status(name), f'{name} status after restart', 30)
    except Exception:
        process.terminate()
        raise
    return process, status


def tcp_addr(status):
    for address in status.get('listenAddrs') or []:
        if '/tcp/' in address:
            return address
    raise AssertionError(f'no TCP listen address in {status}')


def connect_fixture_node(owner, target_name, target_status):
    """Dial one fixture node over its real TCP address using the CLI/API."""
    target = str(target_status.get('peerId') or '')
    if not target:
        raise AssertionError(f'{target_name} has no Peer ID after restart')
    result = subprocess.run(
        [str(REPO / 'bin' / 'raminga'), 'connect',
         f'{tcp_addr(target_status)}/p2p/{target}', '--data-dir', FIXTURE[f'{owner}Data']],
        cwd=REPO, capture_output=True, text=True, timeout=40,
    )
    if result.returncode != 0:
        raise AssertionError(f'connect {owner} to {target_name} failed: {result.stderr or result.stdout}')
    wait_for(
        lambda: target in node_snapshot()['connections'],
        f'{target_name} connected to {owner}', 20,
    )
    return target


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

    def dismiss_onboarding(self):
        # The fresh isolated DSH Web profile shows the sign-in/get-started
        # overlay once. Escape is the host's own dismiss affordance; no data is
        # entered and no sign-in is attempted.
        self.page.keyboard.press('Escape')
        self.page.wait_for_timeout(250)

    def open_panel(self):
        if self.page.locator('#settingsTrigger').count() and self.page.locator('#settingsTrigger').is_visible():
            return
        self.dismiss()
        self.dismiss_onboarding()
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
        self.page.wait_for_timeout(650)
        self.open_panel()
        self.page.wait_for_timeout(300)

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(550)

    def nav_current(self):
        out = []
        for sel in ['#desktopNav', '#mobileNav']:
            loc = self.page.locator(sel)
            if loc.count() and loc.is_visible():
                out.extend(loc.locator('[aria-current="page"]').evaluate_all(
                    'els => els.map(e => e.dataset.nav)'))
        return out

    def back_to_contacts(self):
        self.dismiss()
        for _ in range(4):
            if self.page.locator('#conversationView').count() and self.page.locator('#conversationView').is_visible():
                self.page.locator('#conversationBack').click()
                self.page.wait_for_timeout(350)
                continue
            if self.page.locator('#profileView').count() and self.page.locator('#profileView').is_visible():
                self.page.locator('#profileBack').click()
                self.page.wait_for_timeout(350)
                continue
            break
        self.open_panel()
        self.nav('contacts')
        self.page.wait_for_timeout(350)

    def contacts(self):
        self.back_to_contacts()
        self.page.locator('[data-contact-row]').first.wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(300)

    def row(self, peer):
        return self.page.locator(f'[data-contact-row="{peer}"]')

    def open_profile(self, peer, expected_name=None):
        self.contacts()
        self.row(peer).locator('button[data-contact-peer]').click()
        self.page.locator('#profileView').wait_for(state='visible', timeout=15000)
        if expected_name is not None:
            wait_for(lambda: self.page.locator('#profileName').inner_text().strip() == expected_name,
                     f'profile name {expected_name!r}', 20)
        self.page.wait_for_timeout(500)
        return self.page.locator('#profileView')

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def box(self, selector):
        loc = self.page.locator(selector)
        assert loc.count(), f'missing {selector}'
        value = loc.bounding_box()
        assert value is not None, f'no bounding box for {selector}'
        return value

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

    def active_id(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.id || '') : '';
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


def main():
    host_process = None
    browser = None
    try:
        host_process, url = start_host()
        origin = re.match(r'(https?://[^/]+)', url).group(1)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            try:
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=origin)
            except Exception:  # noqa: BLE001 - record the limitation if reported
                pass
            page = context.new_page()
            page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
            page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
                    if message.type == 'error' else None)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_timeout(1800)
            ui = UI(page)
            ui.dismiss_onboarding()
            ui.viewport(1440, 900)

            def full_card():
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                wait_for(lambda: page.locator('#profileAvatar img').count() > 0, 'verified public avatar', 20)
                assert page.locator('#profileAgentDescriptionShort').inner_text().strip() == FIXTURE['publicB']['description']
                tags = [node.strip() for node in page.locator('#profileInterests .rm-profile-tag').all_inner_texts()]
                assert tags == ['潮汐观测', '旧信与邮戳', '雨声录音', '海边植物'], tags
                style = page.locator('#profileConversationStyle').inner_text().strip()
                assert style == f"公开交流风格 · {FIXTURE['publicB']['style']}", style
                assert page.locator('#profileMessage').inner_text().strip() == '发消息'
                assert 'rm-primary' in (page.locator('#profileMessage').get_attribute('class') or '')
                assert page.locator('#profileMessage').is_visible()
                assert page.locator('#profileFilesOpen').inner_text().strip() == '公开文件'
                assert page.locator('#profileEditContact').inner_text().strip() == '编辑联系人资料'
                tabs = page.locator('[data-profile-tab]').all_inner_texts()
                assert [value.strip() for value in tabs] == ['我们的交互', '他的动态', '他的通讯录'], tabs
                assert page.locator('#profileOriginDetails').evaluate('(node) => node.open') is False
                assert page.locator('#profilePeerId').text_content().strip() == PEER_B
                assert page.locator('#profilePeerId').is_visible() is False
                assert page.locator('#profileReadDetails').is_hidden()
                interactions = page.locator('#contactProfileInteractions').inner_text()
                assert FIXTURE['publicB']['description'] not in interactions
                assert '潮汐观测' not in interactions
                assert ui.overflow() <= 1, f'document overflow: {ui.overflow()}'
                assert ui.visual_overflow('#profileView') == 0
                geometry = {
                    'viewport': {'width': 1440, 'height': 900},
                    'hero': ui.box('#profileView .rm-contact-hero'),
                    'name': ui.box('#profileName'),
                    'bio': ui.box('#profileAgentDescriptionShort'),
                    'interests': ui.box('#profileInterests'),
                    'style': ui.box('#profileConversationStyle'),
                    'message': ui.box('#profileMessage'),
                    'tabs': ui.box('#profileTabsNav'),
                    'overflow': ui.overflow(),
                }
                assert geometry['style']['y'] + geometry['style']['height'] < 760
                ui.shot('wide-profile-full-1440')
                # The list and profile use the same verified public name/avatar.
                profile_avatar_src = page.locator('#profileAvatar img').get_attribute('src')
                page.locator('#profileBack').click()
                page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                page.wait_for_timeout(500)
                row = ui.row(PEER_B)
                assert row.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['publicB']['displayName']
                row_avatar = row.locator('.rm-contact-avatar img')
                row_avatar.wait_for(state='visible', timeout=10000)
                assert row_avatar.get_attribute('src') == profile_avatar_src
                assert '本机备注' in row.locator('.rm-contact-local-note').inner_text()
                ui.shot('wide-profile-list-consistency-1440')
                return {
                    'tags': tags,
                    'style': style,
                    'geometry': geometry,
                    'avatarSrcPrefix': profile_avatar_src[:32],
                    'listName': row.locator('.rm-contact-name b').inner_text().strip(),
                }

            case('C3-01', 'Wide public card shows verified avatar, name, bio, four interests, style and primary message; list matches', full_card)

            def origin_details():
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                wait_for(lambda: page.locator('#profileAvatar img').count() > 0, 'avatar for origin details', 20)
                page.locator('#profileOriginDetails summary').click()
                page.wait_for_timeout(250)
                assert page.locator('#profilePeerId').is_visible()
                assert page.locator('#profilePeerId').text_content().strip() == PEER_B
                assert '远端声明' in page.locator('#profileSource').inner_text()
                assert re.search(r'\d{4}/\d{2}/\d{2}', page.locator('#profileOriginReadAt').inner_text())
                assert page.locator('#profileOriginCardPath').inner_text().strip() == 'profile/profile.json'
                local_note = page.locator('#profileLocalNote').inner_text()
                assert '本机备注' in local_note and FIXTURE['localB']['name'] in local_note
                assert '不修改对方档案' in local_note
                assert page.locator('#profileAgentOpen').is_visible()
                page.locator('#profileCopyPeerInline').click()
                try:
                    clipboard = page.evaluate('async () => await navigator.clipboard.readText()')
                except Exception as error:  # noqa: BLE001 - recorded limitation
                    clipboard = f'unavailable: {error}'
                assert clipboard == PEER_B, f'clipboard mismatch: {clipboard!r}'
                page.locator('#profileAgentOpen').click()
                page.locator('#agentCardDialog').wait_for(state='visible', timeout=5000)
                dialog_text = page.locator('#agentCardDialog').inner_text()
                assert '潮汐观测' in dialog_text and '不急着追问' in dialog_text
                page.locator('#agentCardDialog [data-close-dialog]').first.click()
                page.wait_for_timeout(250)
                geometry = {
                    'origin': ui.box('#profileOriginDetails'),
                    'peerId': ui.box('#profilePeerId'),
                    'copy': ui.box('#profileCopyPeerInline'),
                }
                ui.shot('wide-profile-origin-1440')
                page.locator('#profileOriginDetails summary').click()
                return {'source': page.locator('#profileSource').text_content(), 'localNote': local_note,
                        'clipboard': 'match', 'geometry': geometry, 'dialog': dialog_text[:300]}

            case('C3-02', 'Source, read time, local note and full Peer ID are usable in one secondary entry', origin_details)

            def narrow_full():
                ui.viewport(390, 844)
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                wait_for(lambda: page.locator('#profileAvatar img').count() > 0, 'narrow avatar', 20)
                nav = ui.box('#mobileNav')
                style = ui.box('#profileConversationStyle')
                interests = ui.box('#profileInterests')
                assert style['y'] + style['height'] <= nav['y'] - 4, f'style is not on the first screen: {style} nav={nav}'
                assert interests['y'] + interests['height'] <= nav['y'] - 4
                assert page.locator('#profileMessage').is_visible()
                assert page.locator('#profilePeerId').is_visible() is False
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#profileView') == 0
                geometry = {
                    'viewport': {'width': 390, 'height': 844},
                    'name': ui.box('#profileName'), 'bio': ui.box('#profileAgentDescriptionShort'),
                    'interests': interests, 'style': style, 'message': ui.box('#profileMessage'),
                    'mobileNavTop': nav['y'], 'overflow': ui.overflow(),
                }
                ui.shot('narrow-profile-full-390')
                return {'geometry': geometry, 'tagCount': page.locator('#profileInterests .rm-profile-tag').count()}

            case('C3-03', 'Narrow first screen shows the complete public interests and conversation style above the bottom nav', narrow_full)

            def narrow_long_missing_avatar():
                ui.contacts()
                ui.row(PEER_C).locator('button[data-contact-peer]').click()
                page.locator('#profileView').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#profileName').inner_text().strip() == FIXTURE['publicC']['displayName'],
                         'long public name', 20)
                page.wait_for_timeout(400)
                assert page.locator('#profileAvatar img').count() == 0
                assert page.locator('#profileAvatar').inner_text().strip() == FIXTURE['publicC']['displayName'][0]
                assert page.locator('#profileInterests .rm-profile-tag').count() == 6
                assert page.locator('#profileConversationStyle').is_hidden()
                assert '公开交流风格' in page.locator('#profileMissingNote').inner_text()
                assert page.locator('#profileMessage').is_visible()
                name_box = ui.box('#profileName')
                interest_box = ui.box('#profileInterests')
                copy_box = ui.box('#profileView .rm-contact-hero-copy')
                assert name_box['width'] <= copy_box['width'] + 1
                assert interest_box['width'] <= copy_box['width'] + 1
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#profileView') == 0
                geometry = {
                    'name': name_box, 'interests': interest_box,
                    'missingNote': ui.box('#profileMissingNote'), 'message': ui.box('#profileMessage'),
                    'overflow': ui.overflow(),
                }
                ui.shot('narrow-profile-long-no-avatar-390')
                page.locator('#profileOriginDetails summary').click()
                page.wait_for_timeout(300)
                assert page.locator('#profilePeerId').is_visible()
                assert page.locator('#profilePeerId').text_content().strip() == PEER_C
                ui.shot('narrow-profile-long-origin-390')
                return {
                    'name': FIXTURE['publicC']['displayName'], 'tagCount': 6,
                    'missingNote': page.locator('#profileMissingNote').inner_text(),
                    'geometry': geometry,
                }

            case('C3-04', 'Long name/summary/no-avatar profile wraps, keeps all six interests, and names the missing style', narrow_long_missing_avatar)

            def missing_public_profile():
                ui.viewport(1440, 900)
                ui.open_profile(PEER_G, FIXTURE['localG']['name'])
                page.wait_for_timeout(800)
                assert page.locator('#profileAvatar img').count() == 0
                assert page.locator('#profileName').inner_text().strip() == FIXTURE['localG']['name']
                assert page.locator('#profileAvatar').inner_text().strip() == FIXTURE['localG']['name'][0].upper()
                assert page.locator('#profileInterests').is_hidden()
                assert page.locator('#profileConversationStyle').is_hidden()
                note = page.locator('#profileMissingNote').inner_text()
                assert '没有公开' in note, note
                assert page.locator('#profileAgentBadge').inner_text().strip() == 'Agent 档案未公开'
                assert page.locator('#profileRetry').is_hidden()
                ui.shot('wide-profile-missing-public-1440')
                return {'name': page.locator('#profileName').inner_text(), 'missingNote': note,
                        'badge': page.locator('#profileAgentBadge').inner_text()}

            case('C3-05', 'An online peer without public profile shows an honest missing state and invents no fields', missing_public_profile)

            def failed_profile_retry():
                before = node_snapshot()
                ui.contacts()
                ui.row(PEER_D).locator('button[data-contact-peer]').click()
                page.locator('#profileView').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#profileRetry').is_visible(), 'failed profile retry', 20)
                error_selector = '#profileError' if page.locator('#profileError').is_visible() else '#profileStale'
                error_text = page.locator(error_selector).inner_text()
                assert error_text.strip() != '', 'failed profile needs a readable reason'
                assert '没有读取到' in error_text or '没有完成' in error_text or '不可达' in error_text, error_text
                assert page.locator('#profileReadDetails').evaluate('(node) => node.open') is False
                assert page.locator('#profileReadDetails').is_hidden() is False
                assert page.locator('#profileInterests').is_hidden()
                assert page.locator('#profileAgentBadge').inner_text().strip() == '公开档案暂不可用'
                assert '暂时不可用' in page.locator('#profileMissingNote').inner_text()
                assert '不代表对方没有公开档案' in error_text
                assert page.locator('#profileRetry').is_enabled()
                page.locator('#profileRetry').click()
                page.wait_for_timeout(900)
                assert page.locator('#profileRetry').is_visible()
                after = node_snapshot()
                assert PEER_D not in after['connections'], 'offline contact was dialed'
                assert PEER_D in after['friends'], 'local offline contact disappeared'
                geometry = {'retry': ui.box('#profileRetry'), 'error': ui.box(error_selector)}
                ui.shot('wide-profile-missing-retry-1440')
                return {'error': error_text, 'errorSelector': error_selector,
                        'badge': page.locator('#profileAgentBadge').inner_text(),
                        'missingNote': page.locator('#profileMissingNote').inner_text(),
                        'retry': page.locator('#profileRetry').inner_text(),
                        'technicalOpen': False, 'geometry': geometry}

            case('C3-06', 'A failed profile keeps a clear retry and technical details collapsed, without dialing the offline row', failed_profile_retry)

            def files_and_chat_returns():
                ui.viewport(1440, 900)
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                page.locator('[data-profile-tab="posts"]').click()
                page.wait_for_timeout(1200)
                assert '退潮以后留下的石阶' in page.locator('#profilePostList').inner_text()
                page.locator('#profileView').evaluate('(node) => { node.scrollTop = 150; }')
                page.wait_for_timeout(150)
                source_scroll = page.locator('#profileView').evaluate('(node) => node.scrollTop')
                page.locator('#profileFilesOpen').click()
                page.wait_for_timeout(600)
                assert page.locator('#contactProfileFiles').is_visible()
                assert page.locator('#profileTabsNav').is_hidden()
                page.locator('#profileFilesClose').click()
                page.wait_for_timeout(400)
                assert page.locator('[data-profile-tab="posts"]').get_attribute('aria-current') == 'page'
                assert abs(page.locator('#profileView').evaluate('(node) => node.scrollTop') - source_scroll) <= 1
                assert ui.active_id() == 'profileFilesOpen', ui.active_id()
                page.locator('#profileMessage').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert '返回联系人档案' in page.locator('#conversationBack').inner_text()
                page.locator('#conversationBack').click()
                page.locator('#profileView').wait_for(state='visible', timeout=10000)
                page.wait_for_timeout(450)
                assert page.locator('[data-profile-tab="posts"]').get_attribute('aria-current') == 'page'
                assert ui.active_id() == 'profileMessage', ui.active_id()
                page.locator('[data-profile-tab="address"]').click()
                page.wait_for_timeout(1600)
                assert page.locator('#profileAddressStatus').inner_text().strip() not in ('读取中', '读取失败')
                assert page.locator('#profileFriendList').is_visible()
                page.locator('#profileFilesOpen').click()
                page.wait_for_timeout(500)
                assert page.locator('#contactProfileFiles').is_visible()
                page.locator('#profileFilesClose').click()
                page.wait_for_timeout(350)
                assert page.locator('[data-profile-tab="address"]').get_attribute('aria-current') == 'page'
                page.locator('#profileView').evaluate('(node) => { node.scrollTop = 90; }')
                page.wait_for_timeout(150)
                address_scroll = page.locator('#profileView').evaluate('(node) => node.scrollTop')
                page.locator('#profileMessage').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                page.locator('#conversationBack').click()
                page.locator('#profileView').wait_for(state='visible', timeout=10000)
                page.wait_for_timeout(450)
                assert page.locator('[data-profile-tab="address"]').get_attribute('aria-current') == 'page'
                assert abs(page.locator('#profileView').evaluate('(node) => node.scrollTop') - address_scroll) <= 1
                assert ui.active_id() == 'profileMessage', ui.active_id()
                ui.shot('wide-profile-address-chat-return-1440')
                return {
                    'postTitle': '退潮以后留下的石阶',
                    'filesReturnTab': 'posts',
                    'postsScroll': source_scroll,
                    'addressStatus': page.locator('#profileAddressStatus').inner_text(),
                    'addressScroll': address_scroll,
                }

            case('C3-07', 'Public files and chat return to the posts/address section, scroll and trigger; address data stays real', files_and_chat_returns)

            def inline_chat_and_gear():
                ui.contacts()
                page.locator('#contactQuery').fill('')
                page.wait_for_timeout(250)
                page.locator('#page-contacts').evaluate('(node) => { node.scrollTop = 120; }')
                page.wait_for_timeout(200)
                list_scroll = page.locator('#page-contacts').evaluate('(node) => node.scrollTop')
                chat = ui.row(PEER_B).locator('button[data-chat-peer]')
                chat.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert ui.nav_current() == ['contacts']
                page.locator('#messageInput').fill('齿轮往返与行内聊天草稿')
                page.locator('#settingsTrigger').click()
                page.locator('#page-settings').wait_for(state='visible', timeout=15000)
                assert page.locator('#settingsIndex').is_visible()
                page.locator('#settingsClose').click()
                page.wait_for_timeout(500)
                assert page.locator('#conversationView').is_visible()
                assert page.locator('#messageInput').input_value() == '齿轮往返与行内聊天草稿'
                assert ui.nav_current() == ['contacts']
                page.locator('#conversationBack').click()
                page.wait_for_timeout(500)
                assert page.locator('#page-contacts').is_visible()
                assert abs(page.locator('#page-contacts').evaluate('(node) => node.scrollTop') - list_scroll) <= 1
                assert ui.active_focus() == f'contact-chat:{PEER_B}', ui.active_focus()
                ui.shot('wide-profile-inline-chat-gear-return-1440')
                return {'draft': page.locator('#messageInput').input_value() if page.locator('#conversationView').is_visible() else 'returned',
                        'listScroll': list_scroll, 'focus': ui.active_focus()}

            case('C3-08', 'Item-2 inline chat and the settings gear still return to the same contact row and draft', inline_chat_and_gear)

            def offline_history():
                stop_fixture_node('nodeB')
                page.reload(wait_until='domcontentloaded')
                page.wait_for_timeout(1600)
                ui.dismiss_onboarding()
                ui.viewport(1440, 900)
                ui.contacts()
                row = ui.row(PEER_B)
                assert row.locator('.rm-contact-name b').inner_text().strip() == FIXTURE['publicB']['displayName']
                row.locator('.rm-contact-avatar img').wait_for(state='visible', timeout=10000)
                assert row.locator('.rm-contact-avatar img').count() == 1
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                wait_for(lambda: page.locator('#profileAvatar img').count() > 0, 'offline projection avatar', 20)
                assert page.locator('#profileAgentDescriptionShort').inner_text().strip() == FIXTURE['publicB']['description']
                assert page.locator('#profileInterests .rm-profile-tag').count() == 4
                assert page.locator('#profileConversationStyle').inner_text().strip() == f"公开交流风格 · {FIXTURE['publicB']['style']}"
                freshness = page.locator('#profileFreshness').inner_text()
                assert '本机历史副本' in freshness or '上次成功读取' in freshness, freshness
                assert page.locator('#profileAgentBadge').inner_text().strip() == '上次公开档案'
                assert page.locator('#profileRetry').is_visible()
                assert page.locator('#profileReadDetails').evaluate('(node) => node.open') is False
                assert page.locator('#profileOriginDetails').evaluate('(node) => node.open') is False
                snapshot = node_snapshot()
                assert PEER_B not in snapshot['connections']
                ui.shot('wide-profile-offline-default-1440')
                page.locator('#profileOriginDetails summary').click()
                page.wait_for_timeout(250)
                source = page.locator('#profileSource').inner_text()
                assert any(word in source for word in ('本机', '历史', '本地')), source
                assert page.locator('#profileOriginSnapshotAt').inner_text().strip() != '—'
                assert page.locator('#profilePeerId').text_content().strip() == PEER_B
                ui.shot('wide-profile-offline-snapshot-1440')
                page.locator('#profileOriginDetails summary').click()
                page.wait_for_timeout(200)
                page.locator('[data-profile-tab="posts"]').click()
                page.wait_for_timeout(1400)
                posts_text = page.locator('#profilePostList').inner_text()
                assert '退潮以后留下的石阶' in posts_text
                posts_note = page.locator('#profilePostsNote').inner_text()
                assert '离线' in posts_note or '本机' in posts_note or '不是对方当前' in posts_note, posts_note
                ui.shot('wide-profile-offline-posts-1440')
                page.locator('#profileFilesOpen').click()
                page.wait_for_timeout(1200)
                assert page.locator('#profileFilesStatus').inner_text().startswith('本地历史')
                files_note = page.locator('#profileFilesNote').inner_text()
                assert '本机' in files_note or '历史' in files_note
                doc_card = page.locator('#profileFileList [data-file-card*="docs/tide-notes.md"]')
                doc_card.wait_for(state='attached', timeout=10000)
                assert 'tide-notes' in doc_card.inner_text()
                doc_card.locator('.rm-post-toggle').click()
                page.wait_for_timeout(1200)
                file_text = page.locator('#profileFileList').inner_text()
                assert '本次读取使用本机已核对副本' in file_text or '潮汐笔记' in file_text or '今天退潮后' in file_text, file_text[:500]
                ui.shot('wide-profile-offline-files-1440')
                page.locator('#profileFilesClose').click()
                page.wait_for_timeout(350)
                page.locator('[data-profile-tab="address"]').click()
                page.wait_for_timeout(1500)
                address_status = page.locator('#profileAddressStatus').inner_text()
                assert address_status == '读取失败', address_status
                assert page.locator('#profileAddressRetry').is_visible()
                assert '离线' in page.locator('#profileAddressNote').inner_text() or '不可达' in page.locator('#profileAddressNote').inner_text()
                page.locator('[data-profile-tab="interactions"]').click()
                page.wait_for_timeout(900)
                timeline = page.locator('#profileTimeline').inner_text()
                assert '最后一条' in timeline and '第一封信' in timeline
                page.locator('#profileRetry').click()
                page.wait_for_timeout(800)
                assert page.locator('#profileRetry').is_visible()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#profileView') == 0
                return {
                    'freshness': freshness, 'source': source, 'badge': page.locator('#profileAgentBadge').inner_text(),
                    'postsNote': posts_note, 'filesNote': files_note, 'addressStatus': address_status,
                    'timeline': timeline[:300], 'overflow': ui.overflow(),
                }

            case('C3-09', 'Offline B keeps the verified public snapshot, historical post/files, interactions and honest address/retry', offline_history)

            def final_geometry():
                # The offline page still has one primary navigation surface and
                # no clipped controls at either viewport.
                wide = {'overflow': ui.overflow(), 'visualOverflow': ui.visual_overflow('#profileView')}
                ui.viewport(390, 844)
                narrow = {'overflow': ui.overflow(), 'visualOverflow': ui.visual_overflow('#profileView')}
                assert wide['overflow'] <= 1 and narrow['overflow'] <= 1
                assert wide['visualOverflow'] == 0 and narrow['visualOverflow'] == 0
                assert page.locator('#desktopNav').is_hidden()
                assert page.locator('#mobileNav').is_visible()
                navs = [
                    'desktop' if page.locator('#desktopNav').is_visible() else '',
                    'mobile' if page.locator('#mobileNav').is_visible() else '',
                ]
                assert [value for value in navs if value] == ['mobile']
                ui.shot('narrow-profile-offline-snapshot-390')
                return {'wide': wide, 'narrow': narrow, 'nav': navs}

            case('C3-10', 'No horizontal overflow or overlapping visible navigation at 1440x900 and 390x844 after the offline path', final_geometry)

            def directory_history():
                # C3-09 left B stopped and the page reloaded while offline. Bring
                # the real source back first, then read its non-self declaration
                # through the actual DSH profile surface.
                b_process, b_status = start_fixture_node('nodeB')

                def show_address_panel():
                    page.locator('#profileView').evaluate('''(view) => {
                      const panel = view.querySelector('#contactProfileAddress');
                      if (!panel) return;
                      const viewRect = view.getBoundingClientRect();
                      const panelRect = panel.getBoundingClientRect();
                      view.scrollTop += panelRect.top - viewRect.top - 10;
                    }''')
                    page.wait_for_timeout(300)

                try:
                    connect_fixture_node('nodeA', 'nodeB', b_status)
                    ui.viewport(1440, 900)
                    ui.contacts()
                    clue = page.locator(f'[data-clue-peer="{PEER_E}"]')
                    clue.wait_for(state='visible', timeout=15000)
                    clue_text = clue.inner_text()
                    assert FIXTURE['clueDescription'] in clue_text, clue_text
                    assert '未访问' in clue_text, clue_text
                    ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                    page.locator('[data-profile-tab="address"]').click()
                    online_row = page.locator(f'#profileFriendList [data-friend-peer="{PEER_E}"]')
                    online_row.wait_for(state='visible', timeout=20000)
                    # The local history is shown immediately while the real read
                    # is in flight; wait for the online response to replace it.
                    wait_for(
                        lambda: page.locator('#profileAddressStatus').inner_text().strip() not in ('读取中', '读取失败')
                        and online_row.get_attribute('data-friend-history') is None,
                        'online directory response', 25,
                    )
                    online_text = online_row.inner_text()
                    assert FIXTURE['clueDescription'] in online_text
                    assert '本机历史' not in online_text
                    style_color = page.locator('#profileConversationStyle').evaluate(
                        '(node) => getComputedStyle(node).color')
                    assert style_color == 'rgb(75, 68, 94)', style_color
                    show_address_panel()
                    ui.shot('wide-profile-address-online-1440')

                    page.locator('#profileBack').click()
                    page.locator('#page-contacts').wait_for(state='visible', timeout=10000)
                    page.wait_for_timeout(450)
                    assert page.locator(f'[data-clue-peer="{PEER_E}"]').count() == 1
                    assert '未访问' in page.locator(f'[data-clue-peer="{PEER_E}"]').inner_text()

                    # Same panel run, source stopped: the just-read claim must
                    # remain as clearly labelled local history.
                    stop_fixture_node('nodeB')
                    wait_for(lambda: PEER_B not in node_snapshot()['connections'], 'source disconnected', 25)
                    ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                    page.locator('[data-profile-tab="address"]').click()
                    page.locator('#profileAddressRetry').wait_for(state='visible', timeout=20000)
                    history_row = page.locator(f'#profileFriendList [data-friend-peer="{PEER_E}"]')
                    history_row.wait_for(state='visible', timeout=15000)
                    assert history_row.get_attribute('data-friend-history') == 'local-history'
                    assert '本机历史' in history_row.inner_text()
                    history_note = page.locator('#profileAddressNote').inner_text()
                    assert '部分' in history_note and ('本机' in history_note or '上次' in history_note), history_note
                    assert '不可达' in history_note or '失败' in history_note, history_note
                    assert page.locator('#profileAddressStatus').inner_text().strip() == '读取失败'
                    assert page.locator('#profileAddressRetry').is_visible()
                    assert page.locator('#profileAddressEmpty').is_hidden()
                    snapshot = node_snapshot()
                    assert PEER_E not in snapshot['connections'], 'rendering history dialed the target'
                    assert PEER_E not in set(snapshot['friends']), 'rendering history added the target'
                    show_address_panel()
                    ui.shot('wide-profile-address-history-1440')

                    # A reload keeps the persisted projection available while the
                    # source is offline; it must not collapse to zero rows.
                    page.reload(wait_until='domcontentloaded')
                    page.wait_for_timeout(1800)
                    ui.dismiss_onboarding()
                    ui.viewport(1440, 900)
                    ui.contacts()
                    page.locator(f'[data-clue-peer="{PEER_E}"]').wait_for(state='visible', timeout=15000)
                    ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                    page.locator('[data-profile-tab="address"]').click()
                    page.locator('#profileAddressRetry').wait_for(state='visible', timeout=20000)
                    refreshed_row = page.locator(f'#profileFriendList [data-friend-peer="{PEER_E}"]')
                    refreshed_row.wait_for(state='visible', timeout=15000)
                    assert refreshed_row.get_attribute('data-friend-history') == 'local-history'
                    refreshed_note = page.locator('#profileAddressNote').inner_text()
                    assert '部分' in refreshed_note, refreshed_note
                    assert page.locator('#profileAddressRetry').is_visible()
                    narrow_row_count = refreshed_row.count()
                    show_address_panel()
                    ui.shot('wide-profile-address-history-refresh-1440')

                    # Narrow: scroll the address panel into the viewport and keep
                    # the directory row, the partial-history note and retry in
                    # one readable frame.
                    ui.viewport(390, 844)
                    show_address_panel()
                    page.wait_for_timeout(50)
                    narrow_note = page.locator('#profileAddressNote')
                    narrow_retry = page.locator('#profileAddressRetry')
                    assert refreshed_row.is_visible() and narrow_note.is_visible() and narrow_retry.is_visible()
                    viewport = page.viewport_size
                    nav_box = ui.box('#mobileNav')
                    for selector in [f'#profileFriendList [data-friend-peer="{PEER_E}"]', '#profileAddressNote', '#profileAddressRetry']:
                        rect = ui.box(selector)
                        assert rect['y'] >= 0 and rect['y'] + rect['height'] <= viewport['height'] + 1, (selector, rect)
                    assert ui.box('#profileAddressRetry')['y'] + ui.box('#profileAddressRetry')['height'] <= nav_box['y'] + 1
                    assert ui.overflow() <= 1
                    ui.shot('narrow-profile-address-history-390')

                    # A real successful empty response replaces all history.
                    # Remove B's claims while its daemon is stopped, then let the
                    # normal sync write an empty public/friends.json.
                    stop_fixture_node('nodeB')
                    connection = sqlite3.connect(pathlib.Path(FIXTURE['nodeBData']) / 'raminga.db')
                    try:
                        connection.execute('DELETE FROM friends')
                        connection.commit()
                    finally:
                        connection.close()
                    b_process, b_status = start_fixture_node('nodeB')
                    sync_empty = subprocess.run(
                        [str(REPO / 'bin' / 'raminga'), 'friends', 'sync', '--data-dir', FIXTURE['nodeBData']],
                        cwd=REPO, capture_output=True, text=True, timeout=20,
                    )
                    if sync_empty.returncode != 0:
                        raise AssertionError(f'empty friends sync failed: {sync_empty.stderr or sync_empty.stdout}')
                    empty_claims = json.loads(
                        (pathlib.Path(FIXTURE['nodeBData']) / 'public' / 'friends.json').read_text()
                    ).get('friends') or []
                    if empty_claims:
                        # An inbound connection may recreate the local A row; remove
                        # it through the real CLI and sync again.
                        for claim in empty_claims:
                            subprocess.run(
                                [str(REPO / 'bin' / 'raminga'), 'friends', 'remove', str(claim.get('peer_id') or ''),
                                 '--cancel-pending', '--data-dir', FIXTURE['nodeBData']],
                                cwd=REPO, capture_output=True, text=True, timeout=20,
                            )
                        subprocess.run(
                            [str(REPO / 'bin' / 'raminga'), 'friends', 'sync', '--data-dir', FIXTURE['nodeBData']],
                            cwd=REPO, capture_output=True, text=True, timeout=20,
                        )
                        empty_claims = json.loads(
                            (pathlib.Path(FIXTURE['nodeBData']) / 'public' / 'friends.json').read_text()
                        ).get('friends') or []
                    assert empty_claims == [], f'B public friends is not empty: {empty_claims}'
                    connect_fixture_node('nodeA', 'nodeB', b_status)
                    narrow_retry.click()
                    wait_for(lambda: page.locator('#profileAddressStatus').inner_text().strip() == '无记录',
                             'empty directory success', 25)
                    page.wait_for_timeout(400)
                    assert page.locator(f'#profileFriendList [data-friend-peer="{PEER_E}"]').count() == 0
                    assert page.locator('#profileFriendList').is_hidden()
                    assert page.locator('#profileAddressEmpty').is_visible()
                    assert '没有读取到公开通讯录' in page.locator('#profileAddressEmpty').inner_text()
                    assert page.locator('#profileAddressRetry').is_hidden()
                    empty_note = page.locator('#profileAddressNote').inner_text()
                    assert '本机历史' not in empty_note and '部分历史' not in empty_note, empty_note
                    snapshot = node_snapshot()
                    assert PEER_E not in snapshot['connections']
                    assert PEER_E not in set(snapshot['friends'])
                    ui.viewport(1440, 900)
                    show_address_panel()
                    ui.shot('wide-profile-address-empty-after-history-1440')
                    page.locator('#profileBack').click()
                    page.wait_for_timeout(500)
                    assert page.locator(f'[data-clue-peer="{PEER_E}"]').count() == 0
                    return {
                        'clueName': FIXTURE['clueName'],
                        'onlineRow': online_text[:200],
                        'historyNote': history_note,
                        'refreshedNote': refreshed_note,
                        'styleColor': style_color,
                        'narrowRows': narrow_row_count,
                        'emptyNote': empty_note,
                        'emptyClaims': len(empty_claims),
                    }
                finally:
                    if b_process.poll() is None:
                        b_process.terminate()
                    try:
                        b_process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        b_process.kill()

            case('C3-11', 'Failed directory reads keep labelled partial local history across the same panel and a reload, and a true empty success replaces it', directory_history)

            RESULTS['pageErrors'] = list(dict.fromkeys(RESULTS['pageErrors']))
            RESULTS['consoleErrors'] = list(dict.fromkeys(RESULTS['consoleErrors']))
            assert not RESULTS['pageErrors'], f'page errors: {RESULTS["pageErrors"]}'
            browser.close()
            browser = None
    finally:
        save()
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001 - best effort
                pass
        stop_host(host_process)
        # Stop only this fixture's nodes. The caller can rerun prepare.mjs.
        subprocess.run(
            ['node', str(pathlib.Path(__file__).with_name('cleanup.mjs'))],
            cwd=REPO, capture_output=True, text=True, timeout=30,
        )
        RESULTS['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save()


if __name__ == '__main__':
    main()
