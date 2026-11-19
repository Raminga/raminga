#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 5 (Feed search/editor).

The fixture is the accepted first-batch A data (four owned posts, a remote peer
with posts and ordinary files, 600 non-post discovery rows) plus one real
private draft. This driver starts only the isolated 4386 host, operates the
real Chromium Web client at 1440x900 and 390x844, uses the real daemon RPCs for
publishing/reading/conflict setup, and records screenshots plus a JSON result.
It never touches the user's DSH_HOME, ~/.raminga, the desktop, or other ports.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import time
import traceback

ROOT = pathlib.Path(os.environ.get('B5_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-05-feed-editor')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
API_MJS = pathlib.Path(__file__).with_name('api.mjs')
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
HOST_PORT = int(os.environ.get('B5_HOST_PORT', FIXTURE.get('hostPort', 4386)))
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
ADDR_A = FIXTURE['nodeAAddr']
ADDR_B = FIXTURE['nodeBAddr']
DIR_A = FIXTURE['nodeAData']
DIR_B = FIXTURE['nodeBData']
IMAGE_DIR = pathlib.Path(DIR_A) / 'public' / 'posts' / 'a-image' / 'images'
IMAGE_SOURCE = sorted(IMAGE_DIR.glob('*.png'))[0]
SHARED = {}
DRAFT = FIXTURE['draft']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-05-feed-editor-results.json'
TMP = EVIDENCE / 'tmp'
TMP.mkdir(exist_ok=True)
PAGE = None


def reset_ui_overlays():
    """Close a dialog left open by a failing assertion so one failure does not
    cascade through every later case. This is test cleanup, not app behavior."""
    if PAGE is None:
        return
    try:
        panel = PAGE.locator('#postEditorPanel')
        if panel.count() and panel.evaluate('(el) => el.open === true'):
            PAGE.locator('#postEditorDismiss').click()
            PAGE.wait_for_timeout(350)
    except Exception:
        pass
    try:
        preview = PAGE.locator('#imagePreviewDialog')
        if preview.count() and preview.evaluate('(el) => el.open === true'):
            PAGE.locator('#imagePreviewDialog [data-close-dialog]').first.click()
            PAGE.wait_for_timeout(250)
    except Exception:
        pass


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) and not RESULTS['pageErrors'] else 'FAIL'
    RESULT_FILE.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def case(cid, name, fn):
    started = time.time()
    reset_ui_overlays()
    try:
        data = fn() or {}
        RESULTS['cases'][cid] = {'id': cid, 'name': name, 'status': 'PASS',
                                 'seconds': round(time.time() - started, 2), **data}
        print(f'PASS {cid} {name}', flush=True)
    except Exception as exc:  # noqa: BLE001 - record the real failure
        RESULTS['cases'][cid] = {
            'id': cid, 'name': name, 'status': 'FAIL',
            'seconds': round(time.time() - started, 2),
            'error': str(exc), 'trace': traceback.format_exc()[-8000:],
        }
        print(f'FAIL {cid} {name}: {exc}', flush=True)
    finally:
        reset_ui_overlays()
        save()


def api(*args, timeout=60):
    result = subprocess.run(
        ['node', str(API_MJS), *[str(item) for item in args]],
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


def stop_fixture_nodes():
    stopped = []
    for directory in (DIR_A, DIR_B):
        result = subprocess.run(
            [str(BIN), 'stop', '--data-dir', directory],
            cwd=REPO, capture_output=True, text=True, timeout=20,
        )
        stopped.append({'dir': directory, 'status': result.returncode})
    RESULTS['fixtureNodesStopped'] = stopped
    save()
    return stopped


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


def start_host(log_name='host-b2-05-feed-editor.log'):
    if not port_free(HOST_PORT):
        raise AssertionError(f'port {HOST_PORT} is already in use; refusing to touch a live host')
    log_path = EVIDENCE / log_name
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B5_DATA_DIR': DIR_A,
        'B5_DSH_HOME': FIXTURE['dshHome'],
        'B5_HOST_PORT': str(HOST_PORT),
        'B5_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(BIN),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 60
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
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    save()
    return process, url


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


def published_paths():
    return {entry['path'] for entry in api('published', '--dir', DIR_A)['files']}


def publish_paths_same(post_path):
    return post_path in published_paths()


def drafts():
    return api('drafts', '--dir', DIR_A)['drafts']


def post_json_paths():
    return {path for path in published_paths()
            if path.endswith('/post.json') or re.fullmatch(r'posts/[^/]+\.json', path)}


def download_and_read(remote_path, name):
    out = TMP / name
    info = api('download', '--dir', DIR_B, '--peer', PEER_A, '--path', remote_path, '--out', out)
    return info, out.read_bytes()


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(6):
            overlay = self.page.locator('dialog[open]')
            close = self.page.locator('[aria-label="Close"]:visible, [aria-label="关闭"]:visible')
            if close.count():
                close.first.click()
                self.page.wait_for_timeout(220)
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
        self.page.keyboard.press('Escape')
        self.page.wait_for_timeout(350)

    def open_panel(self):
        if self.page.locator('#settingsTrigger').count() and self.page.locator('#settingsTrigger').is_visible():
            return
        self.dismiss()
        self.dismiss_onboarding()
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

    def explore(self):
        self.open_panel()
        self.nav('explore')
        self.page.locator('#exploreQuery').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(450)

    def filter(self, name):
        self.page.locator(f'[data-filter="{name}"]').click()
        self.page.wait_for_timeout(800)

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

    def active(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? { id: node.id || '', key: node.dataset?.focusKey || '',
            tag: node.tagName || '', text: (node.textContent || '').slice(0, 40) } : null;
        }''')

    def active_key(self):
        active = self.active() or {}
        return active.get('key') or active.get('id') or ''

    def scroll_explore(self, value=None):
        if value is None:
            return self.page.locator('#page-explore').evaluate('(el) => Math.max(0, el.scrollTop || 0)')
        return self.page.locator('#page-explore').evaluate('(el, v) => { el.scrollTop = v; return el.scrollTop; }', value)

    def dialog_open(self):
        return self.page.locator('#postEditorPanel').evaluate('(el) => el.open === true')

    def close_editor(self):
        if self.dialog_open():
            self.page.locator('#postEditorClose').click()
            self.page.wait_for_timeout(450)
            assert not self.dialog_open()


def main():
    host_process = None
    browser = None
    page = None
    try:
        host_process, url = start_host()
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
            ui.dismiss_onboarding()
            ui.viewport(1440, 900)
            ui.explore()

            # Connect the two isolated nodes both ways so B can read A's new
            # public post and image after the UI publishes it.
            try:
                api('connect', '--dir', DIR_A, '--peer', PEER_B, '--addr', ADDR_B)
            except Exception:
                pass
            try:
                api('connect', '--dir', DIR_B, '--peer', PEER_A, '--addr', ADDR_A)
            except Exception:
                pass

            def wide_toolbar():
                assert page.locator('#exploreQuery').is_visible()
                assert page.locator('#exploreSearch').is_visible()
                tools = page.locator('.rm-explore-tools')
                assert tools.locator('#exploreSearch').count() == 1
                assert tools.locator('#exploreRefresh').count() == 1
                assert tools.locator('#composePost').count() == 1
                search = ui.box('#exploreSearch')
                refresh = ui.box('#exploreRefresh')
                compose = ui.box('#composePost')
                assert search['height'] == refresh['height'] == compose['height'] == 38, (search, refresh, compose)
                assert search['x'] + search['width'] <= refresh['x'] + 1
                assert refresh['x'] + refresh['width'] <= compose['x'] + 1
                assert compose['x'] + compose['width'] <= 1440
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#page-explore') == 0
                page.locator('#exploreRefresh').click()
                page.wait_for_timeout(450)
                assert page.locator('#exploreRefresh').get_attribute('aria-busy') in ('true', 'false')
                ui.shot('b5-01-wide-toolbar-1440')
                return {'search': search, 'refresh': refresh, 'compose': compose}

            case('B5-01', '1440×900 搜索、刷新、发布同组且搜索默认可见、无横向溢出', wide_toolbar)

            def wide_feed_semantics():
                assert page.locator('#discoveryList .rm-post').count() == 3, 'three remote posts only'
                assert page.locator('#discoveryList').inner_text().find('hello.txt') == -1
                page.locator('#exploreQuery').fill('hello')
                page.wait_for_timeout(700)
                assert page.locator('#discoveryList .rm-post').count() == 0
                assert '没有找到匹配的公开内容' in page.locator('#exploreStateTitle').inner_text()
                page.locator('#exploreClear').click()
                page.wait_for_timeout(600)
                assert page.locator('#discoveryList .rm-post').count() == 3
                ui.filter('mine')
                assert page.locator('#mineFeedList .rm-post').count() == 4, 'four owned posts only'
                assert 'hello.md' not in page.locator('#mineFeedList').inner_text()
                assert page.locator('#exploreQuery').is_visible()
                ui.shot('b5-02-wide-mine-1440')
                return {'remotePosts': 3, 'ownedPosts': 4}

            case('B5-02', '发现与我的动态只混合实际帖子，普通文件不进入列表或搜索', wide_feed_semantics)

            def wide_query_editor_focus():
                ui.filter('mine')
                page.locator('#exploreQuery').fill('动')
                page.wait_for_timeout(600)
                cards = page.locator('#mineFeedList .rm-post')
                assert cards.count() == 4, ('query should match all four owned posts', cards.count())
                edit = cards.last.locator('.rm-post-edit')
                edit.scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                scrolled = ui.scroll_explore()
                assert scrolled > 20, f'mine feed did not scroll: {scrolled}'
                edit.focus()
                edit.click()
                page.locator('#postEditorPanel').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(700)
                assert ui.dialog_open()
                assert ui.active_key() in ('postTitleInput', 'postEditorDismiss'), ui.active()
                assert page.locator('#exploreQuery').input_value() == '动'
                assert ui.scroll_explore() == scrolled
                page.keyboard.press('Escape')
                page.wait_for_timeout(600)
                assert not ui.dialog_open()
                assert page.locator('#exploreQuery').input_value() == '动'
                assert page.locator('[data-filter="mine"]').get_attribute('aria-pressed') == 'true'
                assert ui.scroll_explore() == scrolled, (ui.scroll_explore(), scrolled)
                active = ui.active_key()
                assert ':edit' in active, active
                ui.shot('b5-03-wide-return-1440')
                page.locator('#exploreClear').click()
                page.wait_for_timeout(500)
                ui.scroll_explore(0)
                return {'scroll': scrolled, 'focus': active}

            case('B5-03', '带查询打开编辑器后 Escape 恢复筛选、查询、滚动和触发焦点', wide_query_editor_focus)

            def existing_and_unsaved_draft():
                ui.filter('mine')
                page.locator('#composePost').click()
                page.wait_for_timeout(700)
                assert ui.dialog_open()
                select = page.locator('#postDraftSelect')
                options = select.locator('option').all_inner_texts()
                assert any('已有草稿 · 潮声笔记' in value for value in options), options
                select.select_option(value=DRAFT['draftId'])
                page.wait_for_timeout(700)
                assert page.locator('#postTitleInput').input_value() == DRAFT['title']
                assert '潮声笔记' in page.locator('#postBodyInput').input_value()
                # Switch to a new empty draft and type content that never reaches
                # the daemon before closing.
                select.select_option(value='')
                page.wait_for_timeout(300)
                assert page.locator('#postTitleInput').input_value() == ''
                page.locator('#postTitleInput').fill('未保存的 B2-05 输入')
                page.locator('#postBodyInput').fill('关闭、切页后应仍然保留。')
                page.locator('#postEditorClose').click()
                page.wait_for_timeout(400)
                assert not ui.dialog_open()
                assert ui.active_key() == 'composePost'
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                assert page.locator('#postTitleInput').input_value() == '未保存的 B2-05 输入'
                assert page.locator('#postBodyInput').input_value() == '关闭、切页后应仍然保留。'
                page.keyboard.press('Escape')
                page.wait_for_timeout(400)
                ui.nav('contacts')
                ui.nav('explore')
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                assert page.locator('#postTitleInput').input_value() == '未保存的 B2-05 输入'
                ui.shot('b5-04-wide-draft-1440')
                page.keyboard.press('Escape')
                page.wait_for_timeout(400)
                return {'draftOptions': len(options)}

            case('B5-04', '已有草稿可选择，未保存的新输入在关闭和切页后保留', existing_and_unsaved_draft)

            def preview_cancel():
                before = published_paths()
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                # A corrupt PNG with an image MIME must fail the real browser
                # decode path without dropping the text already in the form.
                page.locator('#postImageInput').set_input_files({
                    'name': 'broken-b2-05.png',
                    'mimeType': 'image/png',
                    'buffer': b'not a decodable png',
                })
                wait_text(page, '#postEditorNote', '无法解码', 10000)
                assert page.locator('#postImageList .rm-post-editor-image').count() == 0
                assert page.locator('#postTitleInput').input_value() == '未保存的 B2-05 输入'
                page.locator('#postTitleInput').fill('B2-05 预览取消')
                page.locator('#postBodyInput').fill('这条内容只应出现在私有草稿与确认预览里。')
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开')
                assert page.locator('#postPublishButton').inner_text() == '确认发布这条动态'
                assert ui.active_key() == 'postPublishButton'
                assert ui.dialog_open()
                assert published_paths() == before, 'checking content must not publish'
                page.locator('#postPublishCancel').click()
                page.wait_for_timeout(350)
                assert page.locator('#postPublishReceipt').is_hidden()
                assert page.locator('#postTitleInput').input_value() == 'B2-05 预览取消'
                assert page.locator('#postPublishButton').inner_text() == '检查发布内容'
                assert ui.active_key() == 'postPublishButton'
                assert published_paths() == before, 'cancel must not publish'
                ui.shot('b5-05-wide-preview-cancel-1440')
                ui.close_editor()
                return {'publicPaths': len(before)}

            case('B5-05', '发布前必须确认；检查与取消不公开且保留可修改内容', preview_cancel)

            def image_publish_and_remote_read():
                before = published_paths()
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                page.locator('#postTitleInput').fill('B2-05 图文明信片')
                page.locator('#postBodyInput').fill('# 图文明信片\n\n这张图从本机隔离节点发布，随后由另一个节点真实读取。')
                page.locator('#postTagsInput').fill('图文明信片，隔离验收')
                page.locator('#postImageInput').set_input_files({
                    'name': 'b2-05-post.png',
                    'mimeType': 'image/png',
                    'buffer': IMAGE_SOURCE.read_bytes(),
                })
                wait_for(lambda: page.locator('#postImageList .rm-post-editor-image').count() >= 1,
                         'draft image card', 10)
                page.locator('#postDraftSave').click()
                wait_text(page, '#postEditorNote', '草稿已保存')
                page.wait_for_timeout(600)
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开')
                # Two click events in one task: the in-flight guard must send
                # exactly one publish request.
                page.locator('#postPublishButton').evaluate('(el) => { el.click(); el.click(); }')
                wait_text(page, '#postPublishReceipt', '发布完成', 20000)
                page.wait_for_timeout(1200)
                receipt = page.locator('#postPublishReceipt').inner_text()
                match = re.search(r'动态：(posts/[^\s；]+/post\.json)', receipt)
                assert match, receipt
                post_path = match.group(1)
                SHARED['publishedPath'] = post_path
                wait_for(lambda: post_path in published_paths(), 'new post in published manifest', 20)
                new_paths = sorted(published_paths() - before)
                assert len([item for item in new_paths if item.endswith('/post.json')]) == 1, new_paths
                # B reads the exact new public post and its image from A.
                _, post_bytes = download_and_read(post_path, 'b5-published-post.json')
                post = json.loads(post_bytes)
                assert post['title'] == 'B2-05 图文明信片'
                assert '另一个节点真实读取' in post['body']
                assert post['images'] and len(post['images']) == 1, post
                image_rel = post['images'][0]['path']
                image_remote = str(pathlib.PurePosixPath(post_path).parent / image_rel)
                info, image_bytes = download_and_read(image_remote, 'b5-published-image.png')
                assert info['sha256'] == post['images'][0]['sha256']
                assert image_bytes[:8] == b'\x89PNG\r\n\x1a\n'
                public_image = pathlib.Path(DIR_A) / 'public' / image_remote
                assert image_bytes == public_image.read_bytes(), 'B must read the exact bytes A published'
                assert page.locator('#postWriteAnother').is_visible()
                ui.shot('b5-06-wide-published-1440')
                page.locator('#postWriteAnother').click()
                page.wait_for_timeout(500)
                assert page.locator('#postTitleInput').input_value() == ''
                assert page.locator('#postBodyInput').input_value() == ''
                assert page.locator('#postTagsInput').input_value() == ''
                assert page.locator('#postDraftSelect').input_value() == ''
                assert page.locator('#postImageList .rm-post-editor-image').count() == 0
                assert ui.dialog_open()
                page.keyboard.press('Escape')
                page.wait_for_timeout(400)
                assert page.locator('#composePost').is_visible()
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                assert page.locator('#postTitleInput').input_value() == ''
                assert page.locator('#postImageList .rm-post-editor-image').count() == 0
                ui.close_editor()
                return {'postPath': post_path, 'newPublicFiles': sorted(published_paths() - before),
                        'imageSha': post['images'][0]['sha256']}

            case('B5-06', '真实图片草稿发布成功，另一节点读取原帖与图片，再写得到空白新帖', image_publish_and_remote_read)

            def edit_card_in_place():
                post_path = SHARED.get('publishedPath')
                assert post_path, 'the image post from B5-06 must exist'
                before_paths = published_paths()
                before_public = json.loads((pathlib.Path(DIR_A) / 'public' / post_path).read_text())
                before_published_at = before_public.get('published_at')
                ui.filter('mine')
                page.locator('#exploreQuery').fill('B2-05 图文明信片')
                page.wait_for_timeout(700)
                card = page.locator('#mineFeedList .rm-post', has_text='B2-05 图文明信片').first
                assert card.count() == 1
                before_count = page.locator('#mineFeedList .rm-post').count()
                card.locator('.rm-post-edit').click()
                page.locator('#postEditorPanel').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#postTitleInput').input_value() == 'B2-05 图文明信片', 'imported title', 15)
                assert page.locator('#postEditorHeading').inner_text() == '编辑公开动态'
                assert page.locator('#postAuthorKind').is_disabled()
                assert '发布会更新原帖' in page.locator('#postAuthorNote').inner_text()
                assert page.locator('#postImageList .rm-post-editor-image').count() == 1
                page.locator('#postTitleInput').fill('B2-05 编辑后的图文记录')
                page.locator('#postBodyInput').fill('# 编辑后的正文\n\n原帖路径、署名和发表时间应保留，版本更新。')
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开')
                assert post_path in page.locator('#postPublishReceipt').inner_text(), 'edited post confirms its real path'
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '发布完成', 20000)
                page.wait_for_timeout(1200)
                assert publish_paths_same(post_path), (post_path, published_paths())
                page.keyboard.press('Escape')
                page.wait_for_timeout(800)
                assert not ui.dialog_open()
                page.locator('#exploreClear').click()
                page.wait_for_timeout(500)
                page.locator('#exploreQuery').fill('编辑后的图文记录')
                page.wait_for_timeout(700)
                cards = page.locator('#mineFeedList .rm-post')
                assert cards.count() == 1, ('edited query should show one card', cards.count())
                text = cards.first.inner_text()
                assert 'B2-05 编辑后的图文记录' in text
                after_count = page.locator('#mineFeedList .rm-post').count()
                assert after_count == before_count, (after_count, before_count)
                _, post_bytes = download_and_read(post_path, 'b5-edited-post.json')
                post = json.loads(post_bytes)
                assert post['title'] == 'B2-05 编辑后的图文记录'
                assert '编辑后的正文' in post['body']
                assert post.get('published_at') == before_published_at, (post.get('published_at'), before_published_at)
                assert int(post.get('revision', 0)) > int(before_public.get('revision', 0)), (post.get('revision'), before_public.get('revision'))
                assert post.get('updated_at') and post.get('updated_at') != before_public.get('updated_at'), (post.get('updated_at'), before_public.get('updated_at'))
                assert post['images'] and len(post['images']) == 1
                assert len(published_paths()) == len(before_paths), 'editing must not add a second public post'
                assert ui.active_key().endswith(':edit') or ui.active_key() == 'exploreQuery', ui.active()
                ui.shot('b5-07-wide-edited-1440')
                return {'beforeCount': before_count, 'afterCount': after_count,
                        'publishedAt': before_published_at, 'postPath': post_path,
                        'publicFilesBefore': len(before_paths), 'focus': ui.active_key()}

            case('B5-07', '从卡片编辑保留身份与发表时间，更新原帖且不新增重复发布', edit_card_in_place)

            def real_conflict_recovers():
                ui.filter('mine')
                page.locator('#exploreQuery').fill('旧版本人动态')
                page.wait_for_timeout(700)
                card = page.locator('#mineFeedList .rm-post', has_text='旧版本人动态').first
                assert card.count() == 1
                card.locator('.rm-post-edit').click()
                page.locator('#postEditorPanel').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#postTitleInput').input_value() == '旧版本人动态', 'legacy import', 15)
                # Let the editor finish its initial import/debounce before the
                # external writer moves the draft revision forward.
                page.wait_for_timeout(900)
                # Compete through the real API: import returns the same draft,
                # save a newer private revision, then publish it. The UI still
                # holds the older revision.
                imported = api('import', '--dir', DIR_A, '--path', 'posts/old-user.json')['draft']
                assert imported['draftId']
                update = {
                    'draftId': imported['draftId'],
                    'expectedRevision': int(imported['revision']),
                    'title': '外部更新的旧帖',
                    'bodyMarkdown': '外部进程写入并发布的版本。',
                    'tags': imported['tags'],
                    'authorKind': imported['authorKind'],
                    'imageAssetIds': [image['assetId'] for image in imported['images']],
                }
                update_file = TMP / 'conflict-draft.json'
                update_file.write_text(json.dumps(update, ensure_ascii=False))
                saved = api('save-draft', '--dir', DIR_A, '--json', update_file)['draft']
                published = api('publish', '--dir', DIR_A, '--id', saved['draftId'],
                                '--revision', saved['revision'], '--sha', saved['publishedSha256'])
                assert published['status'] in ('published', 'already_published'), published
                # Type after the external publish and click within the debounce
                # window so the explicit save is the operation that conflicts.
                page.locator('#postTitleInput').fill('B2-05 冲突恢复草稿')
                page.locator('#postBodyInput').fill('本地修改应保留；外部已更新时不能静默覆盖。')
                page.locator('#postPublishButton').click()
                wait_text(page, '#postEditorNote', '草稿已在别处更新', 20000)
                assert page.locator('#postTitleInput').input_value() == 'B2-05 冲突恢复草稿'
                assert '本地修改应保留' in page.locator('#postBodyInput').input_value()
                assert page.locator('#postSaveAsNew').is_visible()
                assert ui.dialog_open()
                ui.shot('b5-08-wide-conflict-1440')
                page.locator('#postSaveAsNew').click()
                wait_text(page, '#postEditorNote', '已另存为新草稿', 20000)
                assert page.locator('#postTitleInput').input_value() == 'B2-05 冲突恢复草稿'
                assert '本地修改应保留' in page.locator('#postBodyInput').input_value()
                # Close and reopen the recovered private draft from the real list.
                page.locator('#postEditorClose').click()
                page.wait_for_timeout(500)
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                option = page.locator('#postDraftSelect option', has_text='B2-05 冲突恢复草稿')
                assert option.count() >= 1, page.locator('#postDraftSelect').inner_text()
                page.locator('#postDraftSelect').select_option(value=option.first.get_attribute('value'))
                page.wait_for_timeout(700)
                assert page.locator('#postTitleInput').input_value() == 'B2-05 冲突恢复草稿'
                assert '本地修改应保留' in page.locator('#postBodyInput').input_value()
                ui.shot('b5-08-wide-recovered-1440')
                ui.close_editor()
                return {'conflictPublished': published['status'], 'draftId': saved['draftId']}

            case('B5-08', '真实写入冲突保留本地内容，可另存并从真实草稿列表恢复', real_conflict_recovers)

            def public_files_entry():
                page.locator('#settingsTrigger').click()
                page.wait_for_timeout(700)
                page.locator('#settingsIndex .rm-settings-item[data-settings-tab="public"]').click()
                page.wait_for_timeout(1200)
                page.locator('#settingsFilesHeading').scroll_into_view_if_needed()
                page.wait_for_timeout(400)
                text = page.locator('#minePostList').inner_text()
                assert '岸边的公开纸条' in text, text[:500]
                hello_card = page.locator('#minePostList [data-file-card*=":hello.md:"]')
                assert hello_card.count() == 1, page.locator('#minePostList').inner_text()[:500]
                assert '岸边的公开纸条' in hello_card.inner_text()
                assert page.locator('#settingsFilesHeading').inner_text() == '我的公开文件'
                ui.shot('b5-09-wide-public-files-1440')
                hello_card.scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                ui.shot('b5-09-wide-public-files-hello-1440')
                page.locator('#settings-public [data-settings-back]').click()
                page.wait_for_timeout(500)
                page.locator('#settingsClose').click()
                page.wait_for_timeout(700)
                return {'hasHello': True}

            case('B5-09', '普通文件仍从独立公开文件入口可读（第一批 A 回归）', public_files_entry)

            def narrow_toolbar_and_editor():
                before = published_paths()
                ui.viewport(390, 844)
                ui.explore()
                if page.locator('#exploreQuery').input_value():
                    page.locator('#exploreClear').click()
                    page.wait_for_timeout(500)
                ui.filter('all')
                assert page.locator('#exploreQuery').is_visible()
                page.locator('#exploreRefresh').click()
                page.wait_for_timeout(900)
                assert page.locator('#discoveryList .rm-post').count() >= 1
                search = ui.box('#exploreSearch')
                refresh = ui.box('#exploreRefresh')
                compose = ui.box('#composePost')
                assert search['height'] == refresh['height'] == compose['height'] == 40, (search, refresh, compose)
                assert search['x'] + search['width'] <= refresh['x'] + 1
                assert refresh['x'] + refresh['width'] <= compose['x'] + 1
                assert search['width'] >= 180, search
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#page-explore') == 0
                ui.shot('b5-10-narrow-toolbar-390')
                # Search, clear, and filters remain reachable and do not move
                # the three actions off screen.
                page.locator('#exploreQuery').fill('雨')
                page.wait_for_timeout(500)
                clear = ui.box('#exploreClear')
                assert clear['x'] + clear['width'] <= search['x'] + search['width'] + 1
                assert page.locator('#discoveryList .rm-post').count() >= 1
                page.locator('#exploreClear').click()
                page.wait_for_timeout(500)
                ui.filter('mine')
                page.locator('#exploreQuery').fill('动')
                page.wait_for_timeout(600)
                cards = page.locator('#mineFeedList .rm-post')
                assert cards.count() == 4, ('narrow query should match all four owned posts', cards.count())
                edit = cards.last.locator('.rm-post-edit')
                edit.scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                scrolled = ui.scroll_explore()
                assert scrolled > 20, f'narrow mine feed did not scroll: {scrolled}'
                edit.focus()
                edit.click()
                page.locator('#postEditorPanel').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(800)
                assert ui.dialog_open()
                dialog = ui.box('#postEditorPanel')
                assert abs(dialog['x']) <= 1 and abs(dialog['width'] - 390) <= 1, dialog
                body = page.locator('.rm-post-editor-body').evaluate(
                    '(el) => ({client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY})')
                assert body['scroll'] > body['client'], body
                assert body['overflow'] in ('auto', 'scroll'), body
                footer = ui.box('.rm-post-editor-actions')
                assert footer['y'] + footer['height'] <= 844.5, footer
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#postEditorPanel') == 0
                ui.shot('b5-11-narrow-editor-390')
                page.keyboard.press('Escape')
                page.wait_for_timeout(700)
                assert not ui.dialog_open()
                assert page.locator('#exploreQuery').input_value() == '动'
                assert page.locator('[data-filter="mine"]').get_attribute('aria-pressed') == 'true'
                assert ui.scroll_explore() == scrolled, (ui.scroll_explore(), scrolled)
                assert ':edit' in ui.active_key(), ui.active()
                ui.shot('b5-12-narrow-return-390')
                assert published_paths() == before
                page.locator('#exploreClear').click()
                page.wait_for_timeout(400)
                return {'search': search, 'refresh': refresh, 'compose': compose,
                        'dialog': dialog, 'body': body, 'footer': footer,
                        'scroll': scrolled, 'focus': ui.active_key()}

            case('B5-10', '390×844 搜索/刷新/发布紧凑不挤压，编辑面板内滚且返回恢复', narrow_toolbar_and_editor)

            def narrow_keyboard():
                ui.filter('all')
                page.locator('#exploreQuery').focus()
                page.keyboard.press('Tab')
                first = ui.active_key()
                assert first in ('exploreRefresh', 'exploreClear'), first
                page.keyboard.press('Tab')
                second = ui.active_key()
                assert second in ('exploreRefresh', 'composePost'), (first, second)
                assert second == 'composePost', (first, second)
                page.locator('#composePost').focus()
                page.keyboard.press('Enter')
                page.wait_for_timeout(600)
                assert ui.dialog_open()
                assert ui.active_key() == 'postTitleInput'
                page.keyboard.type('键盘打开的新动态')
                assert page.locator('#postTitleInput').input_value() == '键盘打开的新动态'
                page.keyboard.press('Escape')
                page.wait_for_timeout(500)
                assert not ui.dialog_open()
                assert ui.active_key() == 'composePost'
                page.locator('#composePost').click()
                page.wait_for_timeout(400)
                assert page.locator('#postTitleInput').input_value() == '键盘打开的新动态'
                page.keyboard.press('Escape')
                page.wait_for_timeout(400)
                ui.shot('b5-13-narrow-focus-390')
                return {'tabOrder': [first, second]}

            case('B5-11', '窄屏键盘焦点顺序、Enter 打开与 Escape 恢复，输入不丢', narrow_keyboard)

            # Persist one real private draft before a host restart.
            def prepare_persistence():
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                page.locator('#postTitleInput').fill('B2-05 持久草稿')
                page.locator('#postBodyInput').fill('宿主重开以后，这条私有草稿仍应从本机数据库恢复。')
                page.locator('#postDraftSave').click()
                wait_text(page, '#postEditorNote', '草稿已保存')
                page.wait_for_timeout(700)
                ui.close_editor()
                matches = [d for d in drafts() if d['title'] == 'B2-05 持久草稿']
                assert matches, drafts()
                return {'draftId': matches[0]['draftId'], 'revision': matches[0]['revision']}

            persisted = case('B5-12', '真实保存私有草稿为宿主重启验证做准备', prepare_persistence)

            def host_restart_persistence():
                nonlocal host_process, page
                global PAGE
                stop_host(host_process)
                host_process, new_url = start_host('host-b2-05-feed-editor-restart.log')
                page.close()
                page = context.new_page()
                PAGE = page
                page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
                page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
                        if message.type == 'error' else None)
                page.goto(new_url, wait_until='domcontentloaded')
                page.wait_for_timeout(1800)
                ui.page = page
                ui.dismiss_onboarding()
                ui.viewport(390, 844)
                ui.explore()
                page.locator('#composePost').click()
                page.wait_for_timeout(600)
                select = page.locator('#postDraftSelect')
                option = select.locator('option', has_text='B2-05 持久草稿')
                assert option.count() >= 1, select.inner_text()
                select.select_option(value=option.first.get_attribute('value'))
                page.wait_for_timeout(800)
                assert page.locator('#postTitleInput').input_value() == 'B2-05 持久草稿'
                assert '宿主重开以后' in page.locator('#postBodyInput').input_value()
                ui.shot('b5-14-narrow-after-restart-390')
                ui.close_editor()
                return {'restartedUrl': new_url.split('?')[0]}

            case('B5-13', '隔离宿主重启后真实私有草稿仍可读取', host_restart_persistence)

            def final_narrow_wide_switch():
                ui.viewport(1440, 900)
                ui.explore()
                ui.filter('all')
                assert page.locator('#exploreQuery').is_visible()
                assert ui.overflow() <= 1
                assert page.locator('#discoveryList .rm-post').count() == 3
                assert ui.nav_current() == ['explore']
                ui.shot('b5-14-wide-final-1440')
                return {'nav': ui.nav_current()}

            case('B5-14', '宽窄切换后主导航与动态页仍稳定，无横向溢出', final_narrow_wide_switch)

            def restore_incomplete_new_post():
                marker = '只写了标题的待保留动态'
                ui.viewport(1440, 900)
                ui.explore()
                ui.filter('mine')
                page.locator('#exploreQuery').fill('旧版 Agent 动态')
                page.wait_for_timeout(700)
                card = page.locator('#mineFeedList .rm-post', has_text='旧版 Agent 动态').first
                assert card.count() == 1, page.locator('#mineFeedList').inner_text()[:500]
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                # B5-13 leaves a real saved draft selected; start this scenario
                # from an actual blank new post so the title-only input cannot
                # be auto-saved as a complete private draft.
                if page.locator('#postDraftSelect').input_value():
                    page.locator('#postDraftSelect').select_option(value='')
                    page.wait_for_timeout(500)
                assert page.locator('#postBodyInput').input_value() == ''
                page.locator('#postTitleInput').fill(marker)
                page.locator('#postTagsInput').fill('待保留标签，署名')
                page.locator('#postAuthorKind').select_option('agent')
                page.wait_for_timeout(250)
                assert page.locator('#postPublishReceipt').is_hidden()
                ui.close_editor()

                # The old edit must stay reachable while the incomplete new
                # post is set aside, not destroyed.
                card.locator('.rm-post-edit').click()
                wait_for(lambda: page.locator('#postTitleInput').input_value() == '旧版 Agent 动态',
                         'legacy post edit', 15)
                assert ui.dialog_open()
                assert '发布会更新原帖' in page.locator('#postAuthorNote').inner_text()
                ui.shot('b5-15-wide-old-post-edit-1440')
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开', 15000)
                legacy_confirmation = page.locator('#postPublishReceipt').inner_text()
                assert 'posts/old-agent.json' in legacy_confirmation, legacy_confirmation
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                ui.shot('b5-15-wide-legacy-confirm-path-1440')
                page.locator('#postPublishCancel').click()
                ui.close_editor()

                page.locator('#composePost').click()
                wait_for(lambda: page.locator('#postTitleInput').input_value() == marker,
                         'restored incomplete title', 10)
                assert page.locator('#postTagsInput').input_value() == '待保留标签，署名'
                assert page.locator('#postAuthorKind').input_value() == 'agent'
                note = page.locator('#postEditorNote').inner_text()
                assert '恢复' in note or '保留' in note, note
                ui.shot('b5-15-wide-restored-title-1440')

                ui.close_editor()
                ui.viewport(390, 844)
                ui.explore()
                page.locator('#composePost').click()
                wait_for(lambda: page.locator('#postTitleInput').input_value() == marker,
                         'restored title on narrow viewport', 10)
                assert page.locator('#postTagsInput').input_value() == '待保留标签，署名'
                assert ui.overflow() <= 1
                ui.shot('b5-15-narrow-restored-title-390')
                ui.close_editor()

                ui.viewport(1440, 900)
                ui.explore()
                page.locator('#composePost').click()
                page.wait_for_timeout(350)
                page.locator('#postTitleInput').fill('')
                page.locator('#postBodyInput').fill('')
                page.locator('#postTagsInput').fill('')
                page.locator('#postAuthorKind').select_option('user')
                page.wait_for_timeout(150)
                ui.close_editor()
                page.locator('#exploreClear').click()
                page.wait_for_timeout(400)
                return {'title': marker, 'note': note}

            case('B5-15', '只有标题的新动态在打开旧帖后可保留并在写动态时找回', restore_incomplete_new_post)

            def image_revokes_previous_confirmation():
                ui.viewport(1440, 900)
                ui.explore()
                ui.filter('all')
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                page.locator('#postTitleInput').fill('B2-05 检查后新增配图')
                page.locator('#postBodyInput').fill(
                    '# 检查后新增配图\n\n这张图必须在复查后随同一草稿公开，并由远端真实读取一张。')
                page.locator('#postTagsInput').fill('图文确认，复查')
                before = published_paths()
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开', 15000)
                assert page.locator('#postPublishButton').inner_text() == '确认发布这条动态'
                assert 'posts/post-' in page.locator('#postPublishReceipt').inner_text()
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b5-16-wide-checked-before-image-1440')

                page.locator('#postImageInput').set_input_files({
                    'name': 'b2-05-checked-later.png',
                    'mimeType': 'image/png',
                    'buffer': IMAGE_SOURCE.read_bytes(),
                })
                wait_for(lambda: page.locator('#postImageList .rm-post-editor-image').count() == 1,
                         'new image card', 15)
                wait_for(lambda: page.locator('#postPublishButton').inner_text() == '检查发布内容',
                         'old confirmation revoked', 10)
                receipt = page.locator('#postPublishReceipt').inner_text()
                assert '确认后才会公开' not in receipt, receipt
                page.wait_for_timeout(350)
                assert published_paths() == before, 'image selection must not publish before recheck'
                assert post_json_paths() == {path for path in before if path.endswith('/post.json')
                                             or re.fullmatch(r'posts/[^/]+\.json', path)}
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                assert page.locator('#postPublishReceipt').is_visible()
                ui.shot('b5-16-wide-image-revoked-confirm-1440')

                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开', 15000)
                checked = page.locator('#postPublishReceipt').inner_text()
                assert '1 张图片' in checked, checked
                assert page.locator('#postPublishButton').inner_text() == '确认发布这条动态'
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b5-16-wide-rechecked-with-image-1440')

                # One confirmed click (plus a duplicate in the same task) must
                # create exactly one public post with one image.
                page.locator('#postPublishButton').evaluate('(el) => { el.click(); el.click(); }')
                wait_text(page, '#postPublishReceipt', '发布完成', 25000)
                page.wait_for_timeout(1200)
                receipt = page.locator('#postPublishReceipt').inner_text()
                match = re.search(r'动态：(posts/[^\s；]+/post\.json)', receipt)
                assert match, receipt
                post_path = match.group(1)
                new_paths = sorted(published_paths() - before)
                assert len([item for item in new_paths if item.endswith('/post.json')]) == 1, new_paths
                assert post_path in new_paths
                assert page.locator('#postWriteAnother').is_visible()
                ui.shot('b5-16-wide-published-one-image-1440')

                _, post_bytes = download_and_read(post_path, 'b5-16-post.json')
                post = json.loads(post_bytes)
                assert len(post.get('images', [])) == 1, post
                image_rel = post['images'][0]['path']
                image_remote = str(pathlib.PurePosixPath(post_path).parent / image_rel)
                info, image_bytes = download_and_read(image_remote, 'b5-16-image.png')
                assert info['sha256'] == post['images'][0]['sha256']
                assert image_bytes[:8] == b'\x89PNG\r\n\x1a\n'
                assert image_bytes == (pathlib.Path(DIR_A) / 'public' / image_remote).read_bytes()
                ui.close_editor()
                return {'postPath': post_path, 'newPublicFiles': new_paths,
                        'imageSha': post['images'][0]['sha256']}

            case('B5-16', '检查后新增有效图撤销旧确认；复查后发布并远端真实读取 1 张', image_revokes_previous_confirmation)

            def switched_draft_confirmation():
                draft_b = next((item for item in drafts() if item['title'] == 'B2-05 冲突恢复草稿'), None)
                assert draft_b, [item['title'] for item in drafts()]
                expected_a = f"posts/{DRAFT['draftId'].replace('draft-', 'post-')}/post.json"
                expected_b = f"posts/{draft_b['draftId'].replace('draft-', 'post-')}/post.json"
                before = published_paths()
                ui.viewport(1440, 900)
                ui.explore()
                page.locator('#composePost').click()
                page.wait_for_timeout(500)
                option = page.locator('#postDraftSelect option', has_text='已有草稿 · 潮声笔记')
                assert option.count() >= 1, page.locator('#postDraftSelect').inner_text()
                page.locator('#postDraftSelect').select_option(value=option.first.get_attribute('value'))
                wait_for(lambda: page.locator('#postTitleInput').input_value() == DRAFT['title'],
                         'prepared draft loaded', 15)
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开', 15000)
                first_confirmation = page.locator('#postPublishReceipt').inner_text()
                assert expected_a in first_confirmation, first_confirmation
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b5-17-wide-confirm-prepared-draft-1440')

                # Switching to the recovered real draft must clear the old
                # confirmation before another check; only the selected draft
                # may be submitted afterwards.
                option_b = page.locator('#postDraftSelect option', has_text='B2-05 冲突恢复草稿')
                assert option_b.count() >= 1, page.locator('#postDraftSelect').inner_text()
                page.locator('#postDraftSelect').select_option(value=option_b.first.get_attribute('value'))
                wait_for(lambda: page.locator('#postTitleInput').input_value() == 'B2-05 冲突恢复草稿',
                         'switched draft loaded', 15)
                assert page.locator('#postPublishButton').inner_text() == '检查发布内容'
                assert page.locator('#postPublishReceipt').is_hidden() or '确认后才会公开' not in page.locator('#postPublishReceipt').inner_text()
                assert '本地修改应保留' in page.locator('#postBodyInput').input_value()
                ui.shot('b5-17-wide-switched-draft-cleared-1440')

                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '确认后才会公开', 15000)
                second_confirmation = page.locator('#postPublishReceipt').inner_text()
                assert expected_b in second_confirmation, second_confirmation
                assert expected_a not in second_confirmation
                page.locator('#postPublishReceipt').scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b5-17-wide-confirm-selected-draft-1440')
                page.locator('#postPublishButton').click()
                wait_text(page, '#postPublishReceipt', '发布完成', 25000)
                page.wait_for_timeout(1000)
                receipt = page.locator('#postPublishReceipt').inner_text()
                match = re.search(r'动态：(posts/[^\s；]+/post\.json)', receipt)
                assert match, receipt
                assert match.group(1) == expected_b, (match.group(1), expected_b)
                new_paths = published_paths() - before
                assert new_paths == {expected_b}, new_paths
                assert expected_a not in published_paths()
                _, post_bytes = download_and_read(expected_b, 'b5-17-post.json')
                post = json.loads(post_bytes)
                assert post['title'] == 'B2-05 冲突恢复草稿', post
                assert '本地修改应保留' in post['body']
                ui.shot('b5-17-wide-published-selected-draft-1440')
                ui.close_editor()
                return {'checked': expected_b, 'published': match.group(1)}

            case('B5-17', '换草稿后旧确认清理，提交所选真实草稿版本', switched_draft_confirmation)

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
        stop_host(host_process)
        stop_fixture_nodes()
        save()
    print(json.dumps({'status': RESULTS['status'], 'cases': RESULTS['cases'],
                      'result': str(RESULT_FILE)}, ensure_ascii=False, indent=2))
    if RESULTS['status'] != 'PASS':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
