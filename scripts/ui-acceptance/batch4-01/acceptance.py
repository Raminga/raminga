#!/usr/bin/env python3
"""Isolated real DSH/UI acceptance for feed avatars and explicit refresh."""
from playwright.sync_api import sync_playwright
import base64
import hashlib
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
from urllib.parse import urlsplit, urlunsplit

ROOT = pathlib.Path(os.environ.get(
    'B4_ACCEPTANCE_DIR', '.local/prototype-remediation/batch4-01')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
START_HOST = REPO / 'scripts' / 'ui-acceptance' / 'batch2-09' / 'start-host.sh'
HOST_PORT = int(os.environ.get('B4_HOST_PORT', FIXTURE.get('hostPort', 4406)))
PEER_B = FIXTURE['nodeB']
DIR_A = pathlib.Path(FIXTURE['nodeAData'])
DIR_B = pathlib.Path(FIXTURE['nodeBData'])
HUMAN_SHA = FIXTURE['bHumanAvatarSha256']
AGENT_SHA = FIXTURE['bAgentAvatarSha256']
NEW_PATH = 'posts/b4-refresh/post.json'
NEW_TITLE = '仅点击刷新后出现'

RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT.relative_to(REPO)),
    'hostPort': HOST_PORT,
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [], 'consoleMessages': [],
}
RESULT_FILE = EVIDENCE / 'b4-feed-refresh-results.json'
PAGE = None
HOST = {'process': None, 'url': '', 'log': None}
B_PROCESS = None


def public_url(value):
    """Drop the one-time host token before recording a URL in evidence."""
    parts = urlsplit(str(value))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))


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
    except Exception as exc:  # noqa: BLE001
        if PAGE is not None:
            try:
                PAGE.screenshot(path=str(EVIDENCE / f'{cid.lower()}-failed.png'))
            except Exception:
                pass
        RESULTS['cases'][cid] = {'id': cid, 'name': name, 'status': 'FAIL',
                                 'seconds': round(time.time() - started, 2),
                                 'error': str(exc), 'trace': traceback.format_exc()[-6000:]}
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
    raise AssertionError(f'port {port} still in use')


def terminate(process):
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


def start_host():
    if not port_free(HOST_PORT):
        raise AssertionError(f'port {HOST_PORT} already in use')
    log_path = EVIDENCE / 'host-b4.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B9_ACCEPTANCE_DIR': str(ROOT),
        'B9_DATA_DIR': str(DIR_A),
        'B9_DSH_HOME': str(ROOT / 'dsh-home'),
        'B9_HOME': str(ROOT / 'home'),
        'B9_HOST_PORT': str(HOST_PORT),
        'B9_CONTROL_PORT': '4371',
        'B9_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(BIN),
    })
    process = subprocess.Popen(['sh', str(START_HOST)], cwd=REPO, env=env,
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.time() + 90
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
        terminate(process)
        raise AssertionError(f'host did not publish URL: {log_path.read_text(errors="replace")[-5000:]}')
    HOST.update(process=process, url=url, log=str(log_path))
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    return process, url


def wait_for(predicate, label, timeout=30):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:  # noqa: BLE001
            last = error
        time.sleep(0.2)
    raise AssertionError(f'timed out waiting for {label}: {last}')


def wait_text(page, selector, needle, timeout=20000):
    def read():
        node = page.locator(selector)
        if node.count() == 0 or not node.first.is_visible():
            return False
        text = node.first.inner_text()
        return text if needle in text else False
    return wait_for(read, f'{selector} contains {needle!r}', timeout / 1000)


def discovery_count(path=NEW_PATH):
    db = sqlite3.connect(f'file:{DIR_A / "raminga.db"}?mode=ro', uri=True)
    try:
        return db.execute('SELECT COUNT(*) FROM public_discoveries WHERE peer_id=? AND path=?',
                          (PEER_B, path)).fetchone()[0]
    finally:
        db.close()


def published_rows(path=NEW_PATH):
    db = sqlite3.connect(f'file:{DIR_A / "raminga.db"}?mode=ro', uri=True)
    try:
        return db.execute('SELECT source, sha256, size_bytes FROM public_discoveries WHERE peer_id=? AND path=? ORDER BY fetched_at_ms DESC, id DESC',
                          (PEER_B, path)).fetchall()
    finally:
        db.close()


def write_new_post(title=NEW_TITLE):
    post = {
        'schema_version': 2,
        'id': 'b4-refresh',
        'title': title,
        'format': 'markdown',
        'author': {'peer_id': PEER_B, 'kind': 'agent', 'display_name': '小澜'},
        'published_at': '2026-11-22T08:00:00Z',
        'updated_at': '2026-11-22T08:00:00Z',
        'tags': ['刷新'],
        'summary': '这条动态只应由本端的明确刷新动作取回。',
        'body': f'# {title}\n\n仅通过本端动态页刷新出现，没有访问对方动态页。',
        'images': [],
        'revision': 1,
    }
    target = DIR_B / 'public' / NEW_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(post, ensure_ascii=False, indent=2) + '\n')
    result = subprocess.run([str(BIN), 'content', 'published', '--data-dir', str(DIR_B), '--json'],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr or result.stdout


def avatar_sha(src):
    assert src and src.startswith('data:image/png;base64,'), src
    raw = base64.b64decode(src.split(',', 1)[1])
    return hashlib.sha256(raw).hexdigest()


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def open_panel(self):
        if self.page.locator('#settingsTrigger').count() and self.page.locator('#settingsTrigger').is_visible():
            return
        close = self.page.get_by_role('button', name='Close', exact=True)
        if close.count() and close.first.is_visible():
            close.first.click()
        if not self.wide:
            toggle = self.page.locator('[aria-label="Open sidebar"]:visible')
            if toggle.count():
                toggle.first.click()
                self.page.wait_for_timeout(500)
        self.page.get_by_role('button', name='Raminga', exact=True).first.click()
        self.page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(800)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(600)
        self.open_panel()

    def nav(self, item):
        selector = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{selector} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(700)

    def card(self, title):
        return self.page.locator('#discoveryList .rm-post', has_text=title).first

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path), full_page=True)
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path




def ensure_b():
    global B_PROCESS
    status = subprocess.run([str(BIN), 'status', '--data-dir', str(DIR_B), '--json'],
                            capture_output=True, text=True, timeout=15)
    if status.returncode != 0:
        log = (EVIDENCE / 'node-b.log').open('a')
        B_PROCESS = subprocess.Popen([str(BIN), 'daemon', '--data-dir', str(DIR_B)],
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + 25
        while time.time() < deadline:
            status = subprocess.run([str(BIN), 'status', '--data-dir', str(DIR_B), '--json'],
                                    capture_output=True, text=True, timeout=15)
            if status.returncode == 0:
                break
            time.sleep(0.25)
        assert status.returncode == 0, status.stderr or status.stdout
    payload = json.loads(status.stdout)
    addr = next(item for item in payload['listenAddrs'] if '/tcp/' in item)
    connect = subprocess.run([str(BIN), 'connect', f"{addr}/p2p/{payload['peerId']}",
                              '--data-dir', str(DIR_A), '--json'],
                             capture_output=True, text=True, timeout=30)
    assert connect.returncode == 0, connect.stderr or connect.stdout

def main():
    global PAGE, B_PROCESS
    try:
        if discovery_count() != 0:
            raise AssertionError('A already has the new post before the UI run')
        ensure_b()
        process, url = start_host()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            PAGE = page
            page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
            def console_message(message):
                RESULTS['consoleMessages'].append({'type': message.type, 'text': message.text})
                if message.type == 'error':
                    RESULTS['consoleErrors'].append(message.text)
            page.on('console', console_message)
            page.goto(url, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(1500)
            ui = UI(page)
            case('B4-00', 'open isolated DSH Web and Raminga feed', lambda: (
                ui.open_panel(), ui.nav('explore'),
                wait_for(lambda: page.locator('#discoveryList .rm-post').count() >= 6, 'six existing posts'),
                ui.shot('b4-00-wide-feed-before'),
                {'cards': page.locator('#discoveryList .rm-post').count(), 'url': public_url(url)},
            )[4])

            def before():
                ui.nav('explore')
                wait_for(lambda: page.locator('#discoveryList .rm-post').count() >= 6, 'existing feed')
                assert discovery_count() == 0
                names = page.locator('#discoveryList .rm-post-name').all_inner_texts()
                assert '小澜' in names, names
                first = page.locator('#discoveryList .rm-post').first
                sha = avatar_sha(first.locator('.rm-post-avatar img').get_attribute('src'))
                assert sha == AGENT_SHA, (sha, AGENT_SHA)
                assert sha != HUMAN_SHA
                return {'existingCards': page.locator('#discoveryList .rm-post').count(),
                        'feedNames': names, 'avatarSha': sha}
            case('B4-01', 'existing feed uses the publishing Agent avatar and has no new post row', before)

            def after_publish_before_click():
                write_new_post()
                assert discovery_count() == 0, 'publishing on B must not auto-index on A'
                page.wait_for_timeout(1200)
                assert ui.card(NEW_TITLE).count() == 0, 'new post must not appear before explicit refresh'
                ui.shot('b4-02-wide-published-not-refreshed')
                return {'newRowsBeforeClick': 0,
                        'cardsBeforeClick': page.locator('#discoveryList .rm-post').count()}
            case('B4-02', 'a new remote post is not fetched by page reads or waiting', after_publish_before_click)

            def click_refresh():
                page.locator('#exploreRefresh').click()
                for attempt in range(30):
                    page.wait_for_timeout(500)
                    if ui.card(NEW_TITLE).count() > 0:
                        break
                    if attempt % 4 == 3:
                        print('refresh meta:', page.locator('#discoveryMeta').inner_text(), flush=True)
                assert ui.card(NEW_TITLE).count() > 0, (
                    'new post after explicit refresh; meta=' + page.locator('#discoveryMeta').inner_text()
                )
                wait_text(page, '#discoveryMeta', '本次检查了 1 个节点')
                card = ui.card(NEW_TITLE)
                name = card.locator('.rm-post-name').inner_text()
                sha = avatar_sha(card.locator('.rm-post-avatar img').get_attribute('src'))
                rows = published_rows()
                assert name == '小澜', name
                assert sha == AGENT_SHA, (sha, AGENT_SHA)
                assert sha != HUMAN_SHA, 'human avatar must stay out of the Agent header'
                assert len(rows) == 1, rows
                assert rows[0][0] == 'raminga_ui_refresh', rows
                ui.shot('b4-03-wide-new-post-refreshed')
                return {'name': name, 'avatarSha': sha, 'rows': [list(row) for row in rows],
                        'meta': page.locator('#discoveryMeta').inner_text()}
            case('B4-03', 'only the explicit feed refresh imports the new post and paints the Agent avatar', click_refresh)

            def detail():
                card = ui.card(NEW_TITLE)
                card.locator('.rm-post-open').click()
                page.locator('#postDetail .rm-post-detail').wait_for(state='visible', timeout=15000)
                avatar = page.locator('#postDetail .rm-post-avatar img').first
                sha = avatar_sha(avatar.get_attribute('src'))
                assert sha == AGENT_SHA and sha != HUMAN_SHA
                assert page.locator('#postDetail .rm-post-name').inner_text() == '小澜'
                source = page.locator('#postDetail .rm-source-details')
                source.locator('summary').click()
                assert '小澜' in source.inner_text()
                assert '阿岸' in source.inner_text()
                assert '发布 Agent' in page.locator('#postDetail .rm-post-head').inner_text()
                assert 'Agent署名' in source.inner_text()
                ui.shot('b4-04-wide-detail-avatar-signature')
                page.locator('#postBack').click()
                page.wait_for_timeout(600)
                return {'detailAvatarSha': sha, 'header': '小澜', 'authorDeclaration': 'Agent署名 · 小澜'}
            case('B4-04', 'detail keeps the same Agent avatar and the original Agent declaration', detail)

            def repeat():
                page.locator('#exploreRefresh').click()
                wait_text(page, '#discoveryMeta', '本次检查了 1 个节点', 30000)
                page.wait_for_timeout(800)
                cards = page.locator('#discoveryList .rm-post', has_text=NEW_TITLE).count()
                rows = published_rows()
                assert cards == 1, cards
                assert len(rows) == 1, rows
                assert discovery_count() == 1
                ui.shot('b4-05-wide-repeated-refresh')
                return {'cards': cards, 'rows': len(rows), 'meta': page.locator('#discoveryMeta').inner_text()}
            case('B4-05', 'repeated refresh does not duplicate the card or evidence row', repeat)

            def offline():
                old = page.locator('#discoveryList .rm-post').count()
                subprocess.run([str(BIN), 'stop', '--data-dir', str(DIR_B)], capture_output=True, text=True, timeout=20)
                page.wait_for_timeout(800)
                if not page.locator('#exploreRefresh').is_visible():
                    ui.open_panel()
                    ui.nav('explore')
                page.locator('#exploreRefresh').click()
                wait_text(page, '#discoveryMeta', '个节点失败', 45000)
                page.locator('#discoveryRefreshReport > summary').click()
                wait_text(page, '#discoveryRefreshReport [data-status="failed"]', '失败')
                page.wait_for_timeout(800)
                current = page.locator('#discoveryList .rm-post').count()
                assert current == old, (current, old)
                assert ui.card(NEW_TITLE).count() == 1
                assert discovery_count() == 1
                ui.shot('b4-06-wide-offline-keeps-posts')
                return {'cardsBefore': old, 'cardsAfter': current,
                        'meta': page.locator('#discoveryMeta').inner_text()}
            case('B4-06', 'offline peer keeps old cards and reports the failed check', offline)
            stop_b = True

            def narrow():
                ui.viewport(390, 844)
                ui.nav('explore')
                wait_for(lambda: page.locator('#discoveryList .rm-post').count() >= 6, 'narrow feed')
                overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
                assert overflow <= 1, overflow
                ui.shot('b4-07-narrow-feed')
                return {'overflow': overflow, 'cards': page.locator('#discoveryList .rm-post').count()}
            case('B4-07', 'narrow view keeps the same feed without horizontal overflow', narrow)
            browser.close()
        terminate(process)
        HOST['process'] = None
        save()
    finally:
        terminate(HOST.get('process'))
        HOST['process'] = None
        terminate(B_PROCESS)
        B_PROCESS = None
        if PAGE is not None:
            try:
                PAGE.context.browser.close()
            except Exception:
                pass
        subprocess.run([str(BIN), 'stop', '--data-dir', str(DIR_B)], capture_output=True, text=True, timeout=20)


if __name__ == '__main__':
    main()
