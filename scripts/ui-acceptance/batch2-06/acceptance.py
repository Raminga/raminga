#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 6 (settings/public profile).

It starts only the 4392 host and 4357 test control endpoint under
.local/prototype-remediation/b2-06-settings, operates the real Chromium web UI
at 1440x900 and 390x844, uses the real daemon RPCs for fixture state and B's
remote read-back, and never touches ~/.raminga, the user's DSH_HOME, the desktop
or another acceptance port.
"""
from playwright.sync_api import sync_playwright
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import time
import traceback
import urllib.request

ROOT = pathlib.Path(os.environ.get('B6_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-06-settings')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
API = pathlib.Path(__file__).with_name('api.mjs')
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
HOST_PORT = int(os.environ.get('B6_HOST_PORT', FIXTURE.get('hostPort', 4392)))
CONTROL_PORT = int(os.environ.get('B6_CONTROL_PORT', FIXTURE.get('controlPort', 4357)))
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
ADDR_A = FIXTURE['nodeAAddr']
ADDR_B = FIXTURE['nodeBAddr']
DIR_A = FIXTURE['nodeAData']
DIR_B = FIXTURE['nodeBData']
DSH_HOME = FIXTURE['dshHome']
AVATAR = FIXTURE['avatarSource']
MARKERS = FIXTURE['markers']
OLD = FIXTURE['oldProfile']
FULL = FIXTURE['fullProfile']
TMP = EVIDENCE / 'tmp'
TMP.mkdir(exist_ok=True)
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-06-settings-results.json'
PAGE = None
HOST = {'process': None, 'url': '', 'log': None, 'restarts': 0}


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


def api(*args, timeout=60):
    result = subprocess.run(
        ['node', str(API), *[str(item) for item in args]],
        cwd=REPO, capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise AssertionError(f'api {" ".join(map(str, args))} failed: {result.stderr or result.stdout}')
    value = json.loads(result.stdout)
    if not value.get('ok'):
        raise AssertionError(f'api failed: {value}')
    return value['value']


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


def stop_host(process=None):
    target = process if process is not None else HOST.get('process')
    terminate_process(target)
    if HOST.get('process') is target:
        HOST['process'] = None
    wait_port_free(HOST_PORT)
    for pid_path in EVIDENCE.glob('dsh-*.pid'):
        try:
            if int(pid_path.read_text().strip()) == getattr(target, 'pid', -1):
                pid_path.unlink(missing_ok=True)
                pid_path.with_name(pid_path.name + '.meta').unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


def start_host(log_name='host-b2-06.log'):
    if not port_free(HOST_PORT):
        raise AssertionError(f'port {HOST_PORT} is already in use; refusing to touch a live host')
    if not port_free(CONTROL_PORT):
        raise AssertionError(f'control port {CONTROL_PORT} is already in use; refusing to touch a live process')
    log_path = EVIDENCE / log_name
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B6_DATA_DIR': DIR_A,
        'B6_DSH_HOME': DSH_HOME,
        'B6_HOST_PORT': str(HOST_PORT),
        'B6_CONTROL_PORT': str(CONTROL_PORT),
        'B6_PIDFILE': str(pid_path),
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
        except Exception as error:  # noqa: BLE001 - wait for startup
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


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def local_public(rel):
    return (pathlib.Path(DIR_A) / 'public' / rel).read_bytes()


def published_files():
    return api('published', '--dir', DIR_A)['files']


def published_paths():
    return {entry['path'] for entry in published_files()}


def public_profile_bytes():
    return local_public('profile/profile.json')


def private_marker_hits(include_draft=True):
    markers = [MARKERS['persona'], MARKERS['growth'], MARKERS['memory']]
    if include_draft:
        markers.append(MARKERS['draft'])
    hits = []
    public_root = pathlib.Path(DIR_A) / 'public'
    for file in public_root.rglob('*'):
        if not file.is_file():
            continue
        data = file.read_bytes()
        for marker in markers:
            if marker.encode() in data:
                hits.append(str(file.relative_to(public_root)) + ': ' + marker)
    return hits


def remote_profile():
    return api('profile', '--dir', DIR_B, '--peer', PEER_A)


def remote_manifest():
    return api('manifest', '--dir', DIR_B, '--peer', PEER_A)


def download_and_read(remote_path, name):
    out = TMP / name
    info = api('download', '--dir', DIR_B, '--peer', PEER_A, '--path', remote_path, '--out', out)
    return info, out.read_bytes()


def connect_nodes():
    for args in (
        ('connect', '--dir', DIR_A, '--peer', PEER_B, '--addr', ADDR_B),
        ('connect', '--dir', DIR_B, '--peer', PEER_A, '--addr', ADDR_A),
    ):
        try:
            api(*args)
        except Exception:
            pass


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(6):
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
        self.page.wait_for_timeout(350)
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

    def navigate_home(self):
        self.nav('home')
        self.page.wait_for_timeout(500)

    def open_index(self):
        for _ in range(3):
            if self.page.locator('#settingsIndex').count() and self.page.locator('#settingsIndex').is_visible():
                return
            back = self.page.locator('[data-settings-back]:visible')
            if back.count():
                back.first.click()
                self.page.wait_for_timeout(450)
                continue
            self.page.locator('#settingsTrigger').click()
            self.page.wait_for_timeout(500)
        self.page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)

    def open_public(self):
        self.open_index()
        self.page.locator('#settingsIndex [data-settings-tab="public"]').click()
        self.page.locator('#settings-public').wait_for(state='visible', timeout=15000)
        self.page.wait_for_timeout(900)

    def open_files(self):
        self.open_index()
        self.page.locator('#settingsIndex [data-settings-tab="files"]').click()
        self.page.locator('#settings-files').wait_for(state='visible', timeout=15000)
        self.page.wait_for_timeout(900)

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

    def active(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? { id: node.id || '', tag: node.tagName || '', text: (node.textContent || '').slice(0, 40) } : null;
        }''')

    def home_scroll(self, value=None):
        if value is None:
            return self.page.locator('#page-home').evaluate('(el) => Math.max(0, el.scrollTop || 0)')
        return self.page.locator('#page-home').evaluate('(el, v) => { el.scrollTop = v; return el.scrollTop; }', value)

    def set_field(self, selector, value):
        self.page.locator(selector).fill(value)
        self.page.locator(selector).dispatch_event('input')


def seed_old_profile():
    payload = TMP / 'old-profile.json'
    payload.write_text(json.dumps(OLD, ensure_ascii=False), encoding='utf-8')
    return api('seed-profile', '--dir', DIR_A, '--json', payload)


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
            page.wait_for_timeout(1800)
            ui = UI(page)
            ui.viewport(1440, 900)
            connect_nodes()
            ui.navigate_home()

            def empty_and_index():
                wait_text(page, '#homeAgentName', '我的 Agent', 15000)
                max_scroll = page.locator('#page-home').evaluate('(el) => Math.max(0, el.scrollHeight - el.clientHeight)')
                target_scroll = min(120, max_scroll)
                ui.home_scroll(target_scroll)
                page.wait_for_timeout(250)
                actual_scroll = ui.home_scroll()
                edit = page.locator('#homeAgentProfileEdit')
                assert edit.count() == 1 and edit.is_visible(), 'missing home edit entry'
                edit.evaluate('(el) => { el.focus(); el.click(); }')
                page.locator('#settings-public').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(900)
                assert page.locator('#settingsIndex').is_hidden()
                assert '返回主页' in page.locator('#settings-public [data-settings-back]').inner_text()
                assert page.locator('#publicAgentName').input_value() == ''
                assert page.locator('#publicAgentDescription').input_value() == ''
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'true'
                wait_for(lambda: '尚无公开版本' in page.locator('#publicVersionName').text_content(),
                         'empty public version label', 15)
                wait_text(page, '#publicDraftStatus', '尚未创建本机草稿', 15000)
                status = page.locator('#publicDraftStatus').inner_text()
                assert page.locator('#publicRestorePublished').is_disabled()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#settings-public') == 0
                ui.shot('b6-01-wide-empty-public-1440')
                page.locator('#settings-public [data-settings-back]').click()
                page.locator('#page-home').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(400)
                assert ui.home_scroll() == actual_scroll, f'home scroll lost: {ui.home_scroll()} != {actual_scroll}'
                assert ui.active().get('id') == 'homeAgentProfileEdit', ui.active()
                ui.open_index()
                labels = [node.inner_text() for node in page.locator('#settingsIndex .rm-settings-copy b').all()]
                assert labels == ['公开资料编辑', '我的公开文件', 'Agent 私有人设与成长', '私有社交记忆', '收藏的动态', '节点与连接'], labels
                assert '只保存在本机' in page.locator('#settingsIndex .rm-settings-note').inner_text()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#settingsIndex') == 0
                ui.shot('b6-02-wide-settings-index-1440')
                ui.open_files()
                wait_text(page, '#minePostList', '岸边的公开纸条', 15000)
                assert page.locator('#settings-public').is_hidden()
                assert page.locator('#settingsFilesHeading').inner_text() == '已发布的文件'
                assert ui.overflow() <= 1
                ui.shot('b6-03-wide-public-files-1440')
                page.locator('#settings-files [data-settings-back]').click()
                page.wait_for_timeout(400)
                page.locator('#settingsIndex [data-settings-tab="private"]').click()
                page.locator('#settings-private').wait_for(state='visible', timeout=10000)
                wait_for(lambda: MARKERS['persona'] in page.locator('#settingsStableInput').input_value(),
                         'private persona loaded', 15)
                assert MARKERS['persona'] in page.locator('#settingsStableInput').input_value()
                page.locator('#settings-private [data-settings-back]').click()
                page.wait_for_timeout(400)
                page.locator('#settingsIndex [data-settings-tab="node"]').click()
                page.locator('#settings-node').wait_for(state='visible', timeout=10000)
                page.locator('#settings-node [data-settings-back]').click()
                page.wait_for_timeout(400)
                assert page.locator('#settingsIndex').is_visible()
                return {'homeScroll': actual_scroll, 'maxScroll': max_scroll, 'labels': labels}

            case('B6-01', '设置索引区分公开资料、公开文件、私有区与节点；主页直接编辑可回到原位置', empty_and_index)

            def old_values_and_restore():
                seeded = seed_old_profile()
                assert seeded['status'] in (1, '1', 'PUBLISHED', 'PUBLISHED_STATUS_PUBLISHED') or str(seeded['status']) == '1', seeded
                page.wait_for_timeout(800)
                ui.open_files()
                page.locator('#mineRefresh').click()
                page.wait_for_timeout(1600)
                page.locator('#settings-files [data-settings-back]').click()
                page.wait_for_timeout(400)
                page.locator('#settingsIndex [data-settings-tab="public"]').click()
                page.locator('#settings-public').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#publicAgentName').input_value() == OLD['agentName'],
                         'old public values in editor', 20)
                assert page.locator('#publicAgentDescription').input_value() == OLD['agentDescription']
                assert page.locator('#publicAgentInterests').input_value() == '潮汐，旧信'
                assert page.locator('#publicHumanName').input_value() == OLD['humanName']
                page.locator('#publicDraftReload').click()
                wait_text(page, '#publicDraftStatus', '已发布为公开版本', 20000)
                status_text = page.locator('#publicDraftStatus').inner_text()
                assert '已发布为公开版本' in status_text, status_text + ' / ' + page.locator('#publicDraftMeta').text_content()
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'true'
                assert OLD['agentName'] in page.locator('#publicVersionName').text_content()
                assert not page.locator('#publicVersionDetails').evaluate('(el) => el.open')
                page.locator('#page-settings').evaluate('(el) => { el.scrollTop = 0; }')
                page.wait_for_timeout(300)
                ui.shot('b6-04-wide-old-values-1440')
                page.locator('#publicVersionDetails summary').click()
                page.locator('#publicVersionDetails').scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                assert page.locator('#publicVersionDetails').evaluate('(el) => el.open')
                assert 'profile/profile.json' in page.locator('#publicVersionNote').inner_text()
                assert page.locator('#publicRestorePublished').is_enabled()
                ui.shot('b6-04b-wide-old-preview-1440')
                page.locator('#publicAgentName').fill('恢复前的临时名字')
                page.locator('#publicAgentName').dispatch_event('input')
                page.locator('#publicRestorePublished').click()
                page.wait_for_timeout(900)
                assert page.locator('#publicAgentName').input_value() == OLD['agentName']
                assert '已恢复公开版本' in page.locator('#publicDraftStatus').inner_text()
                return {'oldProfile': OLD, 'seeded': seeded}

            case('B6-02', '旧公开值、无头像空态、次级公开预览与恢复可用', old_values_and_restore)

            def edit_save_and_restart():
                for selector, value in (
                    ('#publicAgentName', FULL['agentName']),
                    ('#publicAgentDescription', FULL['agentDescription']),
                    ('#publicAgentInterests', '，'.join(FULL['agentInterests'])),
                    ('#publicAgentStyle', FULL['agentConversationStyle']),
                    ('#publicHumanName', FULL['humanName']),
                    ('#publicHumanBio', FULL['humanBioMarkdown']),
                ):
                    page.locator(selector).fill(value)
                    page.locator(selector).dispatch_event('input')
                page.locator('#publicAvatarInput').set_input_files(AVATAR)
                wait_for(lambda: (page.locator('#publicAvatarPreview img').get_attribute('src') or '').startswith('data:image/'),
                         'avatar preview loaded', 15)
                page.locator('#publicDraftSave').click()
                wait_text(page, '#publicDraftStatus', '草稿已保存', 25000)
                page.wait_for_timeout(1200)
                status = page.locator('#publicDraftStatus').inner_text()
                assert '仅本机可见' in status, status
                assert '草稿已保存' in status, status
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'false'
                assert ui.overflow() <= 1
                ui.shot('b6-05-wide-draft-with-avatar-1440')
                ui.open_index()
                ui.open_public()
                wait_for(lambda: page.locator('#publicAgentName').input_value() == FULL['agentName'],
                         'draft fields after reopen', 20)
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'false'
                # Restart the isolated host and prove the SQLite draft, not a
                # JS object, survived.
                stop_host()
                new_process, new_url = start_host('host-b2-06-restart.log')
                page.goto(new_url, wait_until='domcontentloaded')
                page.wait_for_timeout(1800)
                ui.viewport(1440, 900)
                ui.open_public()
                wait_for(lambda: page.locator('#publicAgentName').input_value() == FULL['agentName'],
                         'draft fields after host restart', 25)
                assert page.locator('#publicHumanName').input_value() == FULL['humanName']
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'false'
                assert '仅本机可见' in page.locator('#publicDraftStatus').inner_text()
                wait_for(lambda: OLD['agentName'] in page.locator('#publicVersionName').text_content(),
                         'published old version before publish', 20)
                assert OLD['agentName'] in page.locator('#publicVersionName').text_content(), 'published version still old before publish'
                ui.shot('b6-06-wide-draft-after-restart-1440')
                HOST['restarts'] += 1
                return {'agentName': FULL['agentName'], 'hostRestarts': HOST['restarts']}

            case('B6-03', '编辑完整资料与真实头像，保存草稿后重开和宿主重启仍保留', edit_save_and_restart)

            def confirm_invalidations_and_cancel():
                assert page.locator('#settings-public').is_visible()
                before = sha256_bytes(public_profile_bytes())
                page.locator('#publicPublishButton').click()
                wait_text(page, '#publicPublishReceipt', '确认后才会公开', 20000)
                assert page.locator('#publicPublishButton').inner_text() == '确认发布公开资料'
                assert page.locator('#publicPublishCancel').is_visible()
                page.locator('#publicAgentName').fill(FULL['agentName'] + '（临时修改）')
                page.locator('#publicAgentName').dispatch_event('input')
                page.wait_for_timeout(250)
                assert page.locator('#publicPublishButton').inner_text() == '检查发布内容'
                assert page.locator('#publicPublishCancel').is_hidden()
                page.locator('#publicAgentName').fill(FULL['agentName'])
                page.locator('#publicAgentName').dispatch_event('input')
                page.wait_for_timeout(700)
                page.locator('#publicPublishButton').click()
                wait_text(page, '#publicPublishReceipt', '确认后才会公开', 20000)
                page.locator('#publicPublishCancel').click()
                page.wait_for_timeout(350)
                assert page.locator('#publicPublishButton').inner_text() == '检查发布内容'
                assert page.locator('#publicPublishCancel').is_hidden()
                assert sha256_bytes(public_profile_bytes()) == before, 'cancel still wrote public profile'
                # An avatar change must also invalidate an armed confirmation.
                page.locator('#publicPublishButton').click()
                wait_text(page, '#publicPublishReceipt', '确认后才会公开', 20000)
                page.locator('#publicAvatarClear').click()
                page.wait_for_timeout(300)
                assert page.locator('#publicPublishButton').inner_text() == '检查发布内容'
                assert page.locator('#publicAvatarPreview').get_attribute('data-empty') == 'true'
                page.locator('#publicAvatarInput').set_input_files(AVATAR)
                wait_for(lambda: (page.locator('#publicAvatarPreview img').get_attribute('src') or '').startswith('data:image/'),
                         'second avatar preview', 15)
                page.locator('#publicDraftSave').click()
                wait_text(page, '#publicDraftStatus', '草稿已保存', 25000)
                page.wait_for_timeout(800)
                assert sha256_bytes(public_profile_bytes()) == before, 'cancelled/avatar draft wrote public profile'
                page.locator('#publicPublishButton').click()
                wait_text(page, '#publicPublishReceipt', '确认后才会公开', 20000)
                assert page.locator('#publicPublishButton').inner_text() == '确认发布公开资料'
                ui.shot('b6-07-wide-confirm-publish-1440')
                return {'beforeSha': before, 'receipt': page.locator('#publicPublishReceipt').inner_text()}

            case('B6-04', '文字与头像修改使旧确认失效，取消发布不改公开文件', confirm_invalidations_and_cancel)

            def real_publish_and_remote_read():
                before_sha = sha256_bytes(public_profile_bytes())
                page.locator('#publicPublishButton').click()
                try:
                    wait_text(page, '#publicPublishReceipt', '发布完成', 30000)
                except Exception:
                    PAGE.screenshot(path=str(EVIDENCE / 'b6-05-publish-failed.png'))
                    raise AssertionError(
                        'publish did not complete: receipt=' + PAGE.locator('#publicPublishReceipt').inner_text()
                        + ' | status=' + PAGE.locator('#publicPublishStatus').inner_text()
                        + ' | draft=' + PAGE.locator('#publicDraftStatus').inner_text())
                wait_text(page, '#publicPublishStatus', '已发布', 20000)
                page.wait_for_timeout(1500)
                local = json.loads(public_profile_bytes().decode('utf-8'))
                assert local['schema_version'] == 2
                assert local['agent']['name'] == FULL['agentName']
                assert local['agent']['description'] == FULL['agentDescription']
                assert local['agent']['interests'] == FULL['agentInterests']
                assert local['agent']['conversation_style'] == FULL['agentConversationStyle']
                assert local['human']['name'] == FULL['humanName']
                assert FULL['humanBioMarkdown'] in local['human']['bio_markdown']
                avatar_path = 'profile/' + local['agent']['avatar']
                assert avatar_path in published_paths()
                assert 'profile/profile.json' in published_paths()
                assert 'profile/index.md' in published_paths()
                assert before_sha != sha256_bytes(public_profile_bytes())
                assert MARKERS['draft'] not in public_profile_bytes().decode('utf-8')
                assert 'profile/profile.json' in page.locator('#publicPublishReceiptDetails').text_content()
                page.locator('#page-settings').evaluate('(el) => { el.scrollTop = 0; }')
                page.wait_for_timeout(300)
                ui.shot('b6-08-wide-published-editor-1440')
                page.locator('#publicTechDetails summary').click()
                page.locator('#publicTechDetails').scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                ui.shot('b6-08b-wide-published-receipt-1440')

                page.locator('#settings-public [data-settings-back]').click()
                page.wait_for_timeout(400)
                page.locator('#settingsClose').click()
                page.locator('#page-home').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(1600)
                assert page.locator('#homeAgentName').inner_text() == FULL['agentName']
                assert FULL['agentDescription'] in page.locator('#homeAgentBio').inner_text()
                assert FULL['agentInterests'][0] in page.locator('#homeAgentInterests').inner_text()
                assert page.locator('#homeAgentAvatar').get_attribute('data-empty') == 'false'
                assert (page.locator('#homeAgentAvatar img').get_attribute('src') or '').startswith('data:image/')
                ui.shot('b6-09-wide-home-published-1440')

                connect_nodes()
                remote = wait_for(lambda: (lambda value: value if value.get('profile') and value['profile'].get('agentName') == FULL['agentName'] else None)(remote_profile()),
                                  'B reads the new public profile', 30)
                assert remote['found'] is True, remote
                assert remote['profile']['agentDescription'] == FULL['agentDescription']
                assert remote['profile']['agentInterests'] == FULL['agentInterests']
                assert remote['profile']['agentConversationStyle'] == FULL['agentConversationStyle']
                assert remote['profile']['humanName'] == FULL['humanName']
                assert remote['profile']['avatarPath'] == avatar_path
                assert remote['profile']['avatarSha256'] == local['agent']['avatar_sha256']
                manifest = wait_for(lambda: (lambda value: value if avatar_path in {entry['path'] for entry in value['entries']} else None)(remote_manifest()),
                                    'B sees the new public manifest', 30)
                paths = {entry['path'] for entry in manifest['entries']}
                assert 'profile/profile.json' in paths
                assert 'profile/index.md' in paths
                assert avatar_path in paths
                assert MARKERS['persona'] not in json.dumps(remote, ensure_ascii=False)
                assert MARKERS['growth'] not in json.dumps(remote, ensure_ascii=False)
                assert MARKERS['memory'] not in json.dumps(remote, ensure_ascii=False)
                assert MARKERS['draft'] not in json.dumps(remote, ensure_ascii=False)
                assert not any(path.startswith('agent/') for path in paths), paths
                remote_profile_bytes = wait_for(lambda: (lambda value: value if value else None)(
                    (lambda info, data: data if sha256_bytes(data) == sha256_bytes(public_profile_bytes()) else None)(
                        *download_and_read('profile/profile.json', 'b6-remote-profile.json'))), 'B downloads the exact profile bytes', 30)
                _, remote_avatar = download_and_read(avatar_path, 'b6-remote-avatar.png')
                assert sha256_bytes(remote_avatar) == local['agent']['avatar_sha256']
                assert MARKERS['draft'] not in remote_profile_bytes.decode('utf-8')
                return {
                    'profilePath': 'profile/profile.json',
                    'avatarPath': avatar_path,
                    'publicSha': sha256_bytes(public_profile_bytes()),
                    'remoteAvatarSha': sha256_bytes(remote_avatar),
                }

            case('B6-05', '确认发布后主页、编辑状态、公开清单与 B 节点实际读取一致', real_publish_and_remote_read)

            def private_draft_and_absence():
                ui.open_public()
                page.locator('#publicAgentDescription').fill(MARKERS['draft'] + ' 只在私有草稿里。')
                page.locator('#publicAgentDescription').dispatch_event('input')
                page.locator('#publicDraftSave').click()
                wait_text(page, '#publicDraftStatus', '草稿已保存', 25000)
                page.wait_for_timeout(700)
                assert MARKERS['draft'] in page.locator('#publicAgentDescription').input_value()
                assert '仅本机可见' in page.locator('#publicDraftStatus').inner_text()
                public_snapshot = public_profile_bytes()
                assert MARKERS['draft'] not in public_snapshot.decode('utf-8')
                assert json.loads(public_snapshot)['agent']['description'] == FULL['agentDescription']
                hits = private_marker_hits()
                assert hits == [], hits
                for name in ('persona.md', 'growth.md', 'contact-notes.json'):
                    private_file = pathlib.Path(DIR_A) / 'agent' / name
                    assert private_file.exists(), private_file
                assert MARKERS['persona'] in (pathlib.Path(DIR_A) / 'agent' / 'persona.md').read_text()
                assert MARKERS['growth'] in (pathlib.Path(DIR_A) / 'agent' / 'growth.md').read_text()
                assert MARKERS['memory'] in (pathlib.Path(DIR_A) / 'agent' / 'contact-notes.json').read_text()
                remote = remote_profile()
                manifest = remote_manifest()
                for marker in MARKERS.values():
                    assert marker not in json.dumps(remote, ensure_ascii=False)
                    assert marker not in json.dumps(manifest, ensure_ascii=False)
                for entry in manifest['entries']:
                    assert not any(part in entry['path'] for part in ('agent/', 'persona', 'growth', 'contact-notes', 'draft')), entry
                assert not any(path.startswith('agent/') for path in published_paths())
                ui.shot('b6-10-wide-private-draft-1440')
                return {'markers': MARKERS, 'publicHits': hits}

            case('B6-06', '私有人设、记忆、成长与草稿标记不出现在 public、manifest 或远端读取', private_draft_and_absence)

            def narrow_screens():
                ui.viewport(390, 844)
                ui.navigate_home()
                max_scroll = page.locator('#page-home').evaluate('(el) => Math.max(0, el.scrollHeight - el.clientHeight)')
                target_scroll = min(180, max_scroll)
                ui.home_scroll(target_scroll)
                page.wait_for_timeout(200)
                actual_scroll = ui.home_scroll()
                page.locator('.rm-home-hero-edit').evaluate('(el) => el.click()')
                page.locator('#settings-public').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(500)
                page.locator('#settings-public [data-settings-back]').click()
                page.locator('#page-home').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(450)
                assert ui.home_scroll() == actual_scroll, f'narrow home scroll lost: {ui.home_scroll()} != {actual_scroll}'
                ui.open_index()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#settingsIndex') == 0
                ui.shot('b6-11-narrow-settings-index-390')
                page.locator('#settingsIndex [data-settings-tab="public"]').click()
                page.locator('#settings-public').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(1000)
                assert '返回设置' in page.locator('#settings-public [data-settings-back]').inner_text()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#settings-public') == 0
                assert page.locator('#publicDraftStatus').is_visible()
                assert page.locator('#publicAvatarPreview').is_visible()
                ui.shot('b6-12-narrow-public-editor-390')
                page.locator('#publicDraftSave').click()
                wait_text(page, '#publicDraftStatus', '草稿已保存', 25000)
                page.wait_for_timeout(600)
                assert ui.overflow() <= 1
                ui.shot('b6-13-narrow-draft-status-390')
                page.locator('#settings-public [data-settings-back]').click()
                page.wait_for_timeout(400)
                page.locator('#settingsIndex [data-settings-tab="files"]').click()
                page.locator('#settings-files').wait_for(state='visible', timeout=15000)
                wait_text(page, '#minePostList', '岸边的公开纸条', 15000)
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#settings-files') == 0
                ui.shot('b6-14-narrow-public-files-390')
                return {'overflow': ui.overflow()}

            case('B6-07', '390×844 设置目录、公开编辑、草稿状态与公开文件无横向溢出', narrow_screens)

            def chat_gear_return():
                ui.viewport(390, 844)
                ui.nav('contacts')
                page.wait_for_timeout(1400)
                row = page.locator('#contactList button[data-chat-peer]').first
                assert row.count() == 1, 'missing conversation row for the isolated fixture'
                row.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(700)
                draft = 'B2-06 齿轮往返草稿'
                page.locator('#messageInput').fill(draft)
                page.locator('#messageInput').dispatch_event('input')
                page.locator('#messageInput').focus()
                page.locator('#settingsTrigger').click()
                page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(500)
                page.locator('#settingsClose').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(500)
                assert page.locator('#messageInput').input_value() == draft
                active = ui.active()
                assert active.get('id') == 'messageInput', active
                ui.shot('b6-15-narrow-chat-gear-return-390')
                return {'draft': draft, 'active': active}

            case('B6-08', '聊天齿轮往返保留草稿、焦点与原分区（第一批 C 回归）', chat_gear_return)

    finally:
        try:
            if page is not None:
                page.close()
        except Exception:
            pass
        try:
            if browser is not None:
                browser.close()
        except Exception:
            pass
        stop_host()
        for directory in (DIR_A, DIR_B):
            subprocess.run([str(BIN), 'stop', '--data-dir', directory], cwd=REPO,
                           capture_output=True, text=True, timeout=20)
        RESULTS['fixtureNodesStopped'] = True
        save()
    print(json.dumps({'status': RESULTS['status'], 'cases': RESULTS['cases'],
                      'result': str(RESULT_FILE)}, ensure_ascii=False, indent=2))
    if RESULTS['status'] != 'PASS':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
