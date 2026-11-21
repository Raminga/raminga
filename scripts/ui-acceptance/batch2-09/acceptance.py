#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch human-avatar integration and acceptance fixes.

Starts only the 4406 host and 4371 test control endpoint under
.local/prototype-remediation/b2-09-human-avatar, operates the real Chromium Web UI at
1440x900 and 390x844, and uses the real daemon and control tool for message
sources/read-cursor checks. It never touches ~/.raminga, the user's DSH_HOME,
the desktop, or another acceptance port.
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

ROOT = pathlib.Path(os.environ.get('B9_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-09-human-avatar')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
SEND_FROM_B = REPO / 'scripts' / 'ui-acceptance' / 'c1' / 'send-from-b.mjs'
HOST_PORT = int(os.environ.get('B9_HOST_PORT', FIXTURE.get('hostPort', 4406)))
CONTROL_PORT = int(os.environ.get('B9_CONTROL_PORT', FIXTURE.get('controlPort', 4371)))
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
DIR_A = FIXTURE['nodeAData']
DIR_B = FIXTURE['nodeBData']
AGENT_PNG = pathlib.Path(FIXTURE['agentPng'])
HUMAN_PNG = pathlib.Path(FIXTURE['humanPng'])
HUMAN2_PNG = pathlib.Path(FIXTURE['human2Png'])
PUBLIC_PROFILE_DIR = pathlib.Path(DIR_A) / 'public' / 'profile'
PROFILE_JSON = PUBLIC_PROFILE_DIR / 'profile.json'
DSH_HOME = FIXTURE['dshHome']
LEGACY_ID = FIXTURE['legacyMessageId']
LONG_IDS = FIXTURE['longInboundIds']
def _fixture_label():
    try:
        return str((ROOT / 'fixture.json').relative_to(REPO))
    except ValueError:
        return 'fixture.json'


RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': _fixture_label(),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-09-human-avatar-results.json'
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
    log_path = EVIDENCE / 'host-b2-09.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B9_DATA_DIR': DIR_A,
        'B9_DSH_HOME': DSH_HOME,
        'B9_HOST_PORT': str(HOST_PORT),
        'B9_CONTROL_PORT': str(CONTROL_PORT),
        'B9_PIDFILE': str(pid_path),
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


def wait_text(page, selector, needle, timeout=15000):
    def read():
        node = page.locator(selector)
        if node.count() == 0 or not node.first.is_visible():
            return False
        text = node.first.inner_text()
        return text if needle in text else False
    return wait_for(read, f'visible {selector} containing {needle!r}', timeout / 1000)


def post_tool(tool, args, timeout=130):
    request = urllib.request.Request(
        f'http://127.0.0.1:{CONTROL_PORT}/run',
        data=json.dumps({'tool': tool, 'args': args}).encode('utf-8'),
        headers={'content-type': 'application/json'}, method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode('utf-8'))


def send_unread(count=1):
    tag = str(int(time.time() * 1000))
    env = dict(os.environ)
    env['C1_ACCEPTANCE_DIR'] = str(ROOT)
    env['C1_UNREAD_COUNT'] = str(count)
    env['C1_UNREAD_TAG'] = tag
    result = subprocess.run(
        ['node', str(SEND_FROM_B)], cwd=REPO, env=env,
        capture_output=True, text=True, timeout=90,
    )
    if result.returncode != 0:
        raise AssertionError(f'send-from-b failed: {result.stderr or result.stdout}')
    return json.loads(result.stdout.strip().splitlines()[-1])


def read_cursor():
    db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
    try:
        row = db.execute(
            'SELECT last_read_message_id, last_read_at_ms, updated_at_ms FROM conversation_read_state WHERE peer_id = ?',
            (PEER_B,),
        ).fetchone()
        return {'messageId': row[0] if row else '', 'lastReadAt': row[1] if row else 0,
                'updatedAt': row[2] if row else 0}
    finally:
        db.close()


def message_origin(message_id):
    db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
    try:
        row = db.execute(
            'SELECT origin, delivery_status, direction FROM messages WHERE message_id = ?', (message_id,)
        ).fetchone()
        return {'origin': row[0] if row else '', 'deliveryStatus': row[1] if row else '',
                'direction': row[2] if row else ''}
    finally:
        db.close()


def unread_badge(page):
    values = []
    for selector in ('#desktopNav [data-nav-badge="contacts"]', '#mobileNav [data-nav-badge="contacts"]'):
        loc = page.locator(selector)
        if loc.count() and loc.first.is_visible():
            text = loc.first.inner_text().strip()
            values.append(text)
    if not values:
        return '0'
    return values[0] if values[0] != '' else '0'


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
        self.page.wait_for_timeout(700)

    def nav_current(self):
        out = []
        for selector in ('#desktopNav', '#mobileNav'):
            loc = self.page.locator(selector)
            if loc.count() and loc.is_visible():
                out.extend(loc.locator('[aria-current="page"]').evaluate_all(
                    'els => els.map(e => e.dataset.nav)'))
        return out

    def shot(self, name, full_page=False):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path), full_page=full_page)
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

    def active_id(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.id || node.tagName || '') : '';
        }''')

    def active_focus(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.getAttribute('data-focus-key') || node.getAttribute('id') || '') : '';
        }''')

    def row(self):
        return self.page.locator(f'[data-contact-row="{PEER_B}"]')

    def open_chat(self, wait_rows=True):
        self.row().locator('button[data-chat-peer]').click()
        self.page.locator('#conversationView').wait_for(state='visible', timeout=15000)
        if wait_rows:
            wait_for(lambda: self.page.locator('#messageList .rm-message').count() > 0, 'chat messages', 20)

    def open_profile_from_chat(self):
        self.page.locator('#conversationProfile').click()
        self.page.locator('#profileView').wait_for(state='visible', timeout=15000)
        self.page.wait_for_timeout(700)

    def back_from_profile(self):
        self.page.locator('#profileBack').click()
        self.page.wait_for_timeout(650)

    def chat_metrics(self):
        return self.page.evaluate('''() => {
          const find = (selector) => {
            const walk = (root) => {
              const direct = root.querySelector(selector);
              if (direct) return direct;
              for (const node of root.querySelectorAll('*')) {
                if (!node.shadowRoot) continue;
                const nested = walk(node.shadowRoot);
                if (nested) return nested;
              }
              return null;
            };
            return walk(document);
          };
          const list = find('#messageList');
          const input = find('#messageInput');
          const composer = find('#composer');
          const desktop = find('#desktopNav');
          const mobile = find('#mobileNav');
          const nav = desktop && desktop.getClientRects().length ? desktop : mobile;
          const rows = [...find('#messageList').querySelectorAll('.rm-message')];
          const last = rows.at(-1);
          const rect = (node) => node ? node.getBoundingClientRect() : null;
          return {
            scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
            atBottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 48,
            list: rect(list), input: rect(input), composer: rect(composer), shell: rect(find('.rm-composer-shell')), nav: rect(nav),
            last: rect(last), messages: rows.length,
            jumpHidden: find('#composerJump').hidden,
            header: rect(find('.rm-conversation-head')),
          };
        }''')

    def scroll_history(self, fraction=0.35):
        return self.page.locator('#messageList').evaluate('''(node, fraction) => {
          node.scrollTop = Math.max(1, Math.min(node.scrollHeight - node.clientHeight - 20, Math.round(node.scrollHeight * fraction)));
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
          return node.scrollTop;
        }''', fraction)



def sha256_file(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_public_profile():
    if not PROFILE_JSON.exists():
        raise AssertionError(f'public profile is missing: {PROFILE_JSON}')
    return json.loads(PROFILE_JSON.read_text(encoding='utf-8'))


def public_avatar_files():
    return sorted(item.name for item in PUBLIC_PROFILE_DIR.iterdir()
                  if item.is_file() and re.match(r'^(?:human-)?avatar-[a-f0-9]{8}\.(?:png|jpg)$', item.name))


def db_draft_images():
    db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
    try:
        row = db.execute('SELECT avatar_asset_id, human_avatar_asset_id FROM public_drafts WHERE draft_id = ?',
                         ('profile',)).fetchone()
        assets = db.execute("SELECT role, COUNT(*) FROM public_draft_assets WHERE draft_id = ? GROUP BY role",
                            ('profile',)).fetchall()
        return {'avatarAssetId': row[0] if row else '', 'humanAvatarAssetId': row[1] if row else '',
                'assets': {role: count for role, count in assets}}
    finally:
        db.close()


def message_origin(message_id):
    db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
    try:
        row = db.execute('SELECT origin, delivery_status, direction FROM messages WHERE message_id = ?',
                         (message_id,)).fetchone()
        return {'origin': row[0] if row else '', 'deliveryStatus': row[1] if row else '',
                'direction': row[2] if row else ''}
    finally:
        db.close()


def image_state(page, selector):
    return page.locator(selector).evaluate('''(node) => {
      const image = node.tagName === 'IMG' ? node : node.querySelector('img');
      return {
        empty: node.dataset.empty || '',
        loading: node.dataset.loading || '',
        hasImage: Boolean(image && !image.hidden && image.getAttribute('src')),
        src: image ? (image.getAttribute('src') || '') : '',
      };
    }''')


def wait_image(page, selector, timeout=20000):
    def read():
        try:
            value = image_state(page, selector)
        except Exception:
            return False
        return value if value['hasImage'] and value['src'] else False
    return wait_for(read, f'image in {selector}', timeout / 1000)


def open_settings_public(ui):
    page = ui.page
    ui.open_panel()
    if page.locator('#settingsIndex').is_visible():
        page.locator('#settingsIndex [data-settings-tab="public"]').click()
    elif not page.locator('#settings-public').is_visible():
        page.locator('#settingsTrigger').click()
        page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)
        page.locator('#settingsIndex [data-settings-tab="public"]').click()
    page.locator('#settings-public').wait_for(state='visible', timeout=15000)
    page.wait_for_timeout(900)


def save_draft(page):
    page.locator('#publicDraftSave').click()
    wait_for(lambda: page.locator('#publicDraftSave').inner_text() == '保存草稿',
             'draft save to finish', 25)
    page.wait_for_timeout(500)


def publish_from_settings(page):
    page.locator('#publicPublishButton').click()
    wait_for(lambda: page.locator('#publicPublishButton').inner_text() == '确认发布公开资料',
             'publish confirmation', 30)
    receipt = page.locator('#publicPublishReceipt').inner_text()
    assert '确认后才会公开' in receipt, receipt
    page.locator('#publicPublishButton').click()
    wait_for(lambda: '发布完成' in page.locator('#publicPublishReceipt').inner_text()
             or '已是最新' in page.locator('#publicPublishReceipt').inner_text(),
             'real publish receipt', 40)
    page.wait_for_timeout(1500)


def leave_settings(ui):
    page = ui.page
    # A settings subpage uses its own "back to settings" control; the index
    # page then uses #settingsClose to return to the workspace.
    if page.locator('#settings-public').is_visible():
        page.locator('#settings-public [data-settings-back]').click()
        page.wait_for_timeout(450)
    if page.locator('#settingsIndex').is_visible():
        page.locator('#settingsClose').click()
        page.wait_for_timeout(450)


def go_home(ui):
    page = ui.page
    leave_settings(ui)
    if page.locator('#profileView').is_visible():
        page.locator('#profileBack').click()
        page.wait_for_timeout(400)
    ui.nav('home')
    page.wait_for_timeout(900)


def go_contacts(ui):
    page = ui.page
    leave_settings(ui)
    if page.locator('#profileView').is_visible():
        page.locator('#profileBack').click()
        page.wait_for_timeout(400)
    ui.nav('contacts')
    page.wait_for_timeout(800)


def home_avatar_state(page):
    page.locator('#homeAgentAvatar').wait_for(state='visible', timeout=15000)
    return {
        'agent': image_state(page, '#homeAgentAvatar'),
        'human': image_state(page, '#homeHumanAvatar'),
    }


def upload(page, selector, path):
    page.locator(selector).set_input_files(str(path))
    page.wait_for_timeout(700)


def main():
    browser = None
    page = None
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
            page.wait_for_timeout(2000)
            ui = UI(page)
            ui.viewport(1440, 900)
            page.locator('#homeHumanAvatar').wait_for(state='attached', timeout=20000)

            state = {}

            def draft_dual_preview_and_cancel():
                open_settings_public(ui)
                wait_for(lambda: page.locator('#publicAgentName').input_value() == '小舟'
                         or page.locator('#publicAgentName').input_value() == '',
                         'draft form loaded', 25)
                page.locator('#publicHumanName').fill('小舟')
                upload(page, '#publicAvatarInput', AGENT_PNG)
                upload(page, '#publicHumanAvatarInput', HUMAN_PNG)
                agent = wait_image(page, '#publicAvatarPreview')
                human = wait_image(page, '#publicHumanAvatarPreview')
                assert agent['src'].startswith('data:image/'), agent
                assert human['src'].startswith('data:image/'), human
                assert agent['src'] != human['src'], 'dual previews must be independent'
                assert not PROFILE_JSON.exists(), 'selecting draft images must not publish'
                assert public_avatar_files() == [], public_avatar_files()
                save_draft(page)
                draft = db_draft_images()
                assert draft['avatarAssetId'] and draft['humanAvatarAssetId'], draft
                assert draft['avatarAssetId'] != draft['humanAvatarAssetId'], draft
                assert draft['assets'].get('avatar') == 1 and draft['assets'].get('human_avatar') == 1, draft
                assert not PROFILE_JSON.exists(), 'saving a private draft must not publish'
                ui.shot('b9-01-wide-dual-draft-preview-1440', full_page=True)
                page.locator('#publicHumanAvatarPreview').scroll_into_view_if_needed()
                page.wait_for_timeout(400)
                ui.shot('b9-01b-wide-human-avatar-draft-1440')
                # Check then cancel: the confirmation must not publish.
                page.locator('#publicPublishButton').click()
                wait_for(lambda: page.locator('#publicPublishButton').inner_text() == '确认发布公开资料',
                         'draft publish confirmation', 30)
                assert page.locator('#publicPublishCancel').is_visible()
                page.locator('#publicPublishCancel').click()
                page.wait_for_timeout(500)
                assert not PROFILE_JSON.exists(), 'cancelled confirmation published unexpectedly'
                return {'agentPreview': agent['src'][:32], 'humanPreview': human['src'][:32],
                        'draft': draft, 'publicBeforeConfirm': public_avatar_files()}

            case('B9-01', '双头像独立草稿预览；保存/取消发布不写入公开目录', draft_dual_preview_and_cancel)

            def publish_both_and_home():
                publish_from_settings(page)
                profile = read_public_profile()
                agent = profile['agent']
                human = profile['human']
                assert agent.get('avatar', '').startswith('avatar-'), agent
                assert human.get('avatar', '').startswith('human-avatar-'), human
                agent_file = PUBLIC_PROFILE_DIR / agent['avatar']
                human_file = PUBLIC_PROFILE_DIR / human['avatar']
                assert agent_file.exists() and human_file.exists()
                assert sha256_file(agent_file) == agent['avatar_sha256']
                assert sha256_file(human_file) == human['avatar_sha256']
                state['firstAgentPath'] = f"profile/{agent['avatar']}"
                state['firstAgentSha'] = agent['avatar_sha256']
                state['firstHumanPath'] = f"profile/{human['avatar']}"
                state['firstHumanSha'] = human['avatar_sha256']
                # Unmanaged same-prefix files must survive every cleanup.
                for name in ('avatar-deadbeef.png', 'human-avatar-deadbeef.png'):
                    (PUBLIC_PROFILE_DIR / name).write_bytes(b'not-managed-by-avatar-feature')
                go_home(ui)
                home = wait_for(lambda: (lambda value: value if value['agent']['hasImage'] and value['human']['hasImage'] else None)(home_avatar_state(page)), 'home dual avatars', 25)
                assert home['agent']['hasImage'], home
                assert home['human']['hasImage'], home
                assert home['agent']['src'] != home['human']['src'], home
                state['homeAgentSrc'] = home['agent']['src']
                state['homeHumanSrc'] = home['human']['src']
                ui.shot('b9-02-wide-home-both-avatars-1440')
                return {'agentPath': state['firstAgentPath'], 'humanPath': state['firstHumanPath'],
                        'files': public_avatar_files(), 'home': {'agent': home['agent']['src'][:32],
                                                                  'human': home['human']['src'][:32]}}

            case('B9-02', '确认发布后首页同时显示 Agent 与关联人类公开头像', publish_both_and_home)

            def remote_profile_and_peer_ui():
                # Real remote read: node B's daemon reads node A's published v2.
                env = dict(os.environ)
                env['B9_NODE_B_DATA'] = str(DIR_B)
                env['B9_PEER_A'] = PEER_A
                result = subprocess.run(
                    ['node', str(pathlib.Path(__file__).with_name('read-a-profile.mjs'))],
                    cwd=REPO, env=env, capture_output=True, text=True, timeout=60,
                )
                lines = [line for line in result.stdout.splitlines() if line.strip()]
                assert result.returncode == 0 and lines, (
                    f'remote profile read failed: rc={result.returncode} '
                    f'stdout={result.stdout[-1000:]!r} stderr={result.stderr[-2000:]!r}')
                remote = json.loads(result.stdout[result.stdout.find('{'):])
                assert remote['found'] is True, remote
                assert remote['sourcePath'] == 'profile/profile.json', remote
                assert remote['humanName'] == '小舟', remote
                assert remote['humanAvatarPath'] == state['firstHumanPath'], remote
                assert remote['humanAvatarSha256'] == state['firstHumanSha'], remote
                assert remote['humanAvatarMime'] == 'image/png', remote
                assert remote['avatarPath'] == state['firstAgentPath'], remote
                # Real peer profile UI: B's stored profile also has two images.
                go_contacts(ui)
                ui.row().locator('button[data-profile-peer]').click()
                page.locator('#profileView').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#profileHumanAvatar').count() > 0, 'peer human avatar element', 10)
                agent = wait_image(page, '#profileAvatar')
                human = wait_image(page, '#profileHumanAvatar')
                assert agent['src'] != human['src'], (agent, human)
                assert human['src'].startswith('data:image/'), human
                overflow = ui.overflow()
                assert overflow <= 1, overflow
                ui.shot('b9-03-wide-peer-human-avatar-1440')
                page.locator('#profileBack').click()
                page.wait_for_timeout(600)
                return {'remote': remote, 'peerAgent': agent['src'][:32], 'peerHuman': human['src'][:32]}

            case('B9-03', '另一节点实读 A 的 v2 人类头像；A 的对端档案展示独立人类头像', remote_profile_and_peer_ui)

            def chat_identity_isolation():
                go_contacts(ui)
                ui.open_chat()
                wait_for(lambda: page.locator('#messageList .rm-message').count() > 0, 'chat rows', 20)
                # Real Agent-origin send through the registered tool on A.
                agent_text = f'B9 Agent 身份真实消息 {int(time.time())}'
                status, tool = post_tool('raminga_chat_send', {'peer_id': PEER_B, 'text': agent_text})
                assert status == 200 and tool.get('ok') is True, tool
                agent_id = tool['value'].get('messageId')
                assert agent_id, tool
                assert message_origin(agent_id)['origin'] == 'agent', message_origin(agent_id)
                wait_text(page, '#messageList', agent_text, 25000)
                # Real human-origin send from the visible composer.
                human_text = f'B9 本人身份真实消息 {int(time.time())}'
                page.locator('#messageInput').fill(human_text)
                page.locator('#messageSend').click()
                wait_text(page, '#messageList', human_text, 25000)
                wait_for(lambda: page.locator('#composerStatus').inner_text().find('协议已接收') >= 0,
                         'human send ack', 20)
                human_row = page.locator('#messageList .rm-message', has_text=human_text).last
                agent_row = page.locator('#messageList .rm-message', has_text=agent_text).last
                assert human_row.locator('.rm-message-origin').inner_text() == '本人'
                assert agent_row.locator('.rm-message-origin').inner_text() == 'Agent'
                human_src = human_row.locator('.rm-message-identity img').get_attribute('src')
                agent_src = agent_row.locator('.rm-message-identity img').get_attribute('src')
                assert human_src and human_src.startswith('data:image/'), human_src
                assert agent_src and agent_src.startswith('data:image/'), agent_src
                assert human_src != agent_src, 'human and Agent bubbles must not share an avatar'
                assert human_src == state['homeHumanSrc'], 'human bubble must use the human public avatar'
                assert agent_src == state['homeAgentSrc'], 'Agent bubble must use the Agent public avatar'
                inbound = page.locator('#messageList .rm-message[data-direction="in"]')
                assert inbound.count() > 0
                assert inbound.locator('.rm-message-identity').count() == 0, 'inbound author must stay neutral'
                assert page.locator('#messageList .rm-message[data-direction="in"] .rm-message-origin').first.inner_text() == '对方'
                assert ui.overflow() <= 1
                ui.shot('b9-04-wide-chat-identities-1440')
                return {'humanMessageId': message_origin_by_text(human_text), 'agentMessageId': agent_id,
                        'humanAvatar': human_src[:32], 'agentAvatar': agent_src[:32],
                        'inboundIdentityNodes': inbound.locator('.rm-message-identity').count()}

            def message_origin_by_text(text):
                db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
                try:
                    row = db.execute('SELECT message_id, origin FROM messages WHERE peer_id = ? AND text = ? '
                                     'ORDER BY created_at_ms DESC LIMIT 1', (PEER_B, text)).fetchone()
                    return {'messageId': row[0] if row else '', 'origin': row[1] if row else ''}
                finally:
                    db.close()

            case('B9-04', '出站人工/Agent 气泡各用对应公开头像；入站保持中性', chat_identity_isolation)

            def narrow_home_and_chat():
                page.set_viewport_size({'width': 390, 'height': 844})
                ui.wide = False
                page.wait_for_timeout(900)
                ui.open_panel()
                go_home(ui)
                page.locator('#homeHumanAvatar').wait_for(state='visible', timeout=15000)
                home = home_avatar_state(page)
                assert home['agent']['hasImage'] and home['human']['hasImage'], home
                assert ui.overflow() <= 1, ui.overflow()
                assert ui.visual_overflow('#page-home') == 0
                ui.shot('b9-05-narrow-home-both-avatars-390')
                go_contacts(ui)
                ui.open_chat()
                wait_for(lambda: page.locator('#messageList .rm-message').count() > 0, 'narrow chat rows', 20)
                assert ui.overflow() <= 1, ui.overflow()
                assert ui.visual_overflow('#conversationView') == 0
                identity_widths = page.locator('#messageList .rm-message-identity').evaluate_all(
                    'els => els.map(e => e.getBoundingClientRect().width)')
                assert identity_widths and all(width <= 26 for width in identity_widths), identity_widths
                page.locator('#messageList').evaluate('(node) => { node.scrollTop = node.scrollHeight; }')
                page.wait_for_timeout(500)
                ui.shot('b9-06-narrow-chat-identities-390')
                return {'overflow': ui.overflow(), 'identityWidths': identity_widths}

            case('B9-05', '390×844 首页与聊天气泡头像不挤压、不横溢', narrow_home_and_chat)

            # Return to wide for the replacement/removal sequence.
            page.set_viewport_size({'width': 1440, 'height': 900})
            ui.wide = True
            page.wait_for_timeout(700)
            open_settings_public(ui)

            def replace_human_only():
                before = read_public_profile()
                before_files = public_avatar_files()
                upload(page, '#publicHumanAvatarInput', HUMAN2_PNG)
                wait_image(page, '#publicHumanAvatarPreview')
                save_draft(page)
                publish_from_settings(page)
                profile = read_public_profile()
                assert profile['agent']['avatar'] == before['agent']['avatar'], profile['agent']
                assert profile['human']['avatar'] != before['human']['avatar'], profile['human']
                assert (PUBLIC_PROFILE_DIR / before['human']['avatar']).exists() is False
                assert (PUBLIC_PROFILE_DIR / profile['human']['avatar']).exists() is True
                assert (PUBLIC_PROFILE_DIR / before['agent']['avatar']).exists() is True
                assert (PUBLIC_PROFILE_DIR / 'avatar-deadbeef.png').exists()
                assert (PUBLIC_PROFILE_DIR / 'human-avatar-deadbeef.png').exists()
                state['secondHumanPath'] = f"profile/{profile['human']['avatar']}"
                state['secondHumanSha'] = profile['human']['avatar_sha256']
                state['agentPathAfterReplace'] = f"profile/{profile['agent']['avatar']}"
                assert state['agentPathAfterReplace'] == state['firstAgentPath']
                return {'before': before_files, 'after': public_avatar_files(),
                        'agentUnchanged': state['firstAgentPath'],
                        'humanChanged': [state['firstHumanPath'], state['secondHumanPath']]}

            case('B9-06', '只替换人类头像：Agent 头像与未受管文件不变，旧人类文件清理', replace_human_only)

            def remove_agent_only():
                before = read_public_profile()
                assert before['agent']['avatar'] and before['human']['avatar']
                page.locator('#publicAvatarClear').click()
                page.wait_for_timeout(700)
                save_draft(page)
                publish_from_settings(page)
                profile = read_public_profile()
                assert profile['agent'].get('avatar', '') == '', profile['agent']
                assert profile['human']['avatar'] == before['human']['avatar'], profile['human']
                assert (PUBLIC_PROFILE_DIR / before['agent']['avatar']).exists() is False
                assert (PUBLIC_PROFILE_DIR / profile['human']['avatar']).exists() is True
                assert (PUBLIC_PROFILE_DIR / 'avatar-deadbeef.png').exists()
                return {'removed': state['agentPathAfterReplace'],
                        'humanKept': state['secondHumanPath'], 'files': public_avatar_files()}

            case('B9-07', '只移除 Agent 头像：关联人类头像保持不变', remove_agent_only)

            def remove_human_only():
                before = read_public_profile()
                assert before['human']['avatar'] and not before['agent'].get('avatar')
                page.locator('#publicHumanAvatarClear').click()
                page.wait_for_timeout(700)
                save_draft(page)
                publish_from_settings(page)
                profile = read_public_profile()
                assert profile['human'].get('avatar', '') == '', profile['human']
                assert not (PUBLIC_PROFILE_DIR / before['human']['avatar']).exists()
                assert (PUBLIC_PROFILE_DIR / 'avatar-deadbeef.png').exists()
                assert (PUBLIC_PROFILE_DIR / 'human-avatar-deadbeef.png').exists()
                go_home(ui)
                page.wait_for_timeout(800)
                home = home_avatar_state(page)
                assert not home['agent']['hasImage'] and not home['human']['hasImage'], home
                ui.shot('b9-08-wide-home-defaults-1440')
                return {'files': public_avatar_files(),
                        'unmanaged': ['avatar-deadbeef.png', 'human-avatar-deadbeef.png']}

            case('B9-08', '只移除人类头像：Agent 默认形象与未受管文件保持', remove_human_only)

            RESULTS['fixturePublic'] = {
                'profilePath': str(PROFILE_JSON.relative_to(REPO)),
                'files': public_avatar_files(),
            }
            RESULTS['pageErrors'] = [value for value in RESULTS['pageErrors'] if value]
            RESULTS['consoleErrors'] = [value for value in RESULTS['consoleErrors'] if value]
    finally:
        try:
            if page is not None:
                save()
        finally:
            try:
                if host_process is not None:
                    terminate_process(host_process)
            except Exception:  # noqa: BLE001
                pass
            if browser is not None:
                try:
                    browser.close()
                except Exception:  # Playwright may already be stopped by the context manager.
                    pass
        stop_host()
        for name in ('node-a', 'node-b'):
            subprocess.run([str(BIN), 'stop', '--data-dir', str(ROOT / name)],
                           capture_output=True, text=True, timeout=20)
        save()
        print(json.dumps({'status': RESULTS.get('status'), 'result': str(RESULT_FILE),
                          'pageErrors': RESULTS['pageErrors'],
                          'consoleErrors': RESULTS['consoleErrors']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
