#!/usr/bin/env python3
"""Real isolated DSH acceptance for first-batch A.

Prerequisite: `node scripts/ui-acceptance/a1/prepare.mjs` and
`sh scripts/ui-acceptance/a1/start-host.sh > .local/ui-refresh-20261117/a1/dsh-4354.log 2>&1 &`.
This driver touches only the A1 fixture ports/data and stops the fixture's own
node B for the historical-copy phase.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import signal
import subprocess
import time
import traceback

ROOT = pathlib.Path(os.environ.get('A1_ACCEPTANCE_DIR', '.local/ui-refresh-20261117/a1')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
HOST_PORT = os.environ.get('A1_HOST_PORT', '4354')
URL = re.findall(r'https?://\S+', (ROOT / f'dsh-{HOST_PORT}.log').read_text())[-1]
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'url': URL,
    'fixture': str(ROOT / 'fixture.json'),
    'cases': {},
    'screenshots': [],
    'pageErrors': [],
    'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'a1-results.json'


def save():
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
            'error': str(exc), 'trace': traceback.format_exc()[-3000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
        save()
        raise
    finally:
        save()


def cli(args, timeout=45):
    return subprocess.run([str(BIN), *args], cwd=REPO, text=True, capture_output=True, timeout=timeout)


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


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(6):
            close = self.page.locator('[aria-label="Close"]:visible')
            if close.count() == 0:
                break
            close.first.click()
            self.page.wait_for_timeout(280)

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

    def remount(self):
        self.dismiss()
        button = self.page.get_by_role('button', name='New Session', exact=False)
        button.first.click()
        self.page.wait_for_timeout(800)
        self.open_panel()

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(600)

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(900)

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def text(self, selector, timeout=12000):
        loc = self.page.locator(selector)
        loc.wait_for(state='visible', timeout=timeout)
        return loc.inner_text()

    def active_focus(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.getAttribute('data-focus-key') || node.getAttribute('id') || node.getAttribute('aria-label') || '') : '';
        }''')

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')


def feed_cards(page):
    return page.locator('#discoveryList .rm-post')


def wait_feed(page):
    page.locator('#discoveryList .rm-post').first.wait_for(state='visible', timeout=20000)
    page.wait_for_timeout(500)


def wait_collapsed(page, selector):
    """Wait until the host shell has actually given the viewport to the panel."""
    wait_for(lambda: (lambda box: box is not None and box['x'] <= 1)(page.locator(selector).bounding_box()),
             f'{selector} at the left edge after host sidebar collapse', timeout=15)


def wait_images(page, selector):
    wait_for(lambda: page.locator(selector).evaluate_all(
        'imgs => imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)'),
        f'{selector} decoded', timeout=20)


def card_texts(page):
    return [item.inner_text() for item in feed_cards(page).all()]


def main():
    PAGE_ERRORS = RESULTS['pageErrors']
    CONSOLE_ERRORS = RESULTS['consoleErrors']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.on('console', lambda msg: CONSOLE_ERRORS.append(f'{msg.type}: {msg.text}') if msg.type == 'error' else None)
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_timeout(2600)
        ui = UI(page)
        ui.dismiss()
        ui.open_panel()
        ui.nav('explore')
        page.locator('[data-filter="all"]').click()
        page.wait_for_timeout(700)
        if page.locator('#exploreSearch').is_visible():
            page.locator('#exploreQuery').fill('')
        wait_feed(page)

        def t1():
            cards = feed_cards(page)
            assert cards.count() == 3, cards.count()
            text = '\n'.join(card_texts(page))
            for wanted in ['对方的旧格式动态', '雨停之后的城市植物', '一张旧唱片的反面']:
                assert wanted in text, wanted
            for forbidden in ['hello.txt', 'broken.txt', 'friends.json', 'profile/index.md', '批量非帖子']:
                assert forbidden not in text, forbidden
            # The normal first screen has no yellow non-post diagnostic. The
            # scan boundary and ignored-file explanation live in the collapsed
            # secondary disclosure below the posts.
            assert not page.locator('#discoveryMeta').is_visible(), ui.text('#discoveryMeta')
            scope = page.locator('#discoveryScope')
            assert scope.count() == 1 and scope.is_visible()
            assert not scope.evaluate('(node) => node.open')
            scope_text = page.locator('#discoveryScopeBody').text_content() or ''
            assert '帖子候选' in scope_text and '普通文件' in scope_text, scope_text
            # Opening a title is the single reading entry; the old duplicate
            # main-area buttons are gone and locating lives in source details.
            card = cards.first
            assert card.locator('.rm-post-toggle').count() == 0
            assert card.locator('.rm-post-actions .rm-file-reveal').count() == 0
            ui.shot('a1-t01-feed-only-posts-wide')
            card.locator('.rm-source-summary').click()
            page.wait_for_timeout(250)
            assert card.locator('.rm-source-details .rm-file-reveal').count() == 1
            card.locator('.rm-source-summary').click()
            page.wait_for_timeout(150)
            return {'cards': cards.count(), 'scope': scope_text[:240], 'duplicateActions': 0}

        case('A1-T1', '发现页只出现帖子，非帖子页之后仍找到后续帖子', t1)

        def t2():
            page.locator('[data-filter="familiar"]').click()
            page.wait_for_timeout(900)
            wait_feed(page)
            assert feed_cards(page).count() == 3, 'familiar should contain the three real posts'
            page.locator('[data-filter="mine"]').click()
            page.wait_for_timeout(1100)
            page.locator('#mineFeedList .rm-post').first.wait_for(state='visible', timeout=15000)
            mine = page.locator('#mineFeedList .rm-post')
            assert mine.count() == 4, mine.count()
            badges = [b.inner_text() for b in page.locator('#mineFeedList .rm-post-author-badge').all()]
            assert badges.count('本人') == 2, badges
            assert badges.count('Agent') == 1, badges
            assert badges.count('来源未注明') == 1, badges
            ui.shot('a1-t02-mine-identities-wide')
            return {'familiarCards': 3, 'mineCards': mine.count(), 'badges': badges}

        case('A1-T2', '三项筛选按帖子计数，我的动态区分本人/Agent/来源未注明', t2)

        def t3():
            page.locator('[data-filter="all"]').click()
            page.wait_for_timeout(900)
            if not page.locator('#exploreSearch').is_visible():
                page.locator('#exploreSearchToggle').click()
                page.wait_for_timeout(250)
            page.locator('#exploreQuery').fill('唱片')
            page.wait_for_timeout(900)
            assert feed_cards(page).count() == 1
            assert '一张旧唱片的反面' in ui.text('#discoveryList')
            assert 'hello.txt' not in ui.text('#discoveryList')
            page.locator('#exploreQuery').fill('hello')
            page.wait_for_timeout(900)
            assert feed_cards(page).count() == 0
            assert '没有找到匹配的公开内容' in ui.text('#exploreState')
            assert 'hello.txt' not in ui.text('#exploreState')
            ui.shot('a1-t03-search-empty-wide')
            page.locator('#exploreQuery').fill('')
            page.wait_for_timeout(900)
            assert feed_cards(page).count() == 3
            return {'recordPostMatches': 1, 'fileSearchEmpty': True}

        case('A1-T3', '搜索只匹配帖子，文件搜索得到明确空态', t3)

        def t4():
            # Search + filter + focus survive the detail round trip.
            page.locator('[data-filter="familiar"]').click()
            page.wait_for_timeout(900)
            if not page.locator('#exploreSearch').is_visible():
                page.locator('#exploreSearchToggle').click()
                page.wait_for_timeout(250)
            page.locator('#exploreQuery').fill('唱片')
            page.wait_for_timeout(900)
            assert feed_cards(page).count() == 1
            open_button = page.locator('#discoveryList .rm-post-open').first
            open_button.focus()
            open_button.click()
            page.wait_for_timeout(1400)
            assert page.locator('#page-post').is_visible()
            detail = ui.text('#postDetail')
            assert '一张旧唱片的反面' in detail
            assert '发布于' in detail
            if not page.locator('#postDetail .rm-source-details').evaluate('(node) => node.open'):
                page.locator('#postDetail .rm-source-details > summary').click()
                page.wait_for_timeout(300)
            source = ui.text('#postDetail .rm-source-details')
            assert '获取时间' in source
            assert '内容版本' in source
            assert '文件类型' in source
            page.locator('#postBack').click()
            page.wait_for_timeout(1100)
            assert page.locator('#page-explore').is_visible()
            assert page.locator('[data-filter="familiar"]').get_attribute('aria-pressed') == 'true'
            assert page.locator('#exploreQuery').input_value() == '唱片'
            focus = ui.active_focus()
            assert focus.startswith('post:'), focus

            # A real list scroll is restored after the same round trip.
            page.locator('#exploreQuery').fill('')
            page.wait_for_timeout(900)
            page.locator('#page-explore').evaluate('(el) => { el.scrollTop = 220; }')
            page.wait_for_timeout(300)
            page.locator('#discoveryList .rm-post-open').first.focus()
            page.locator('#discoveryList .rm-post-open').first.click()
            page.wait_for_timeout(1200)
            page.locator('#postBack').click()
            page.wait_for_timeout(1100)
            scroll = page.locator('#page-explore').evaluate('(el) => el.scrollTop')
            assert abs(scroll - 220) <= 2, scroll
            return {'focus': focus, 'scrollTop': scroll, 'filter': 'familiar', 'query': '唱片'}

        case('A1-T4', '独立详情展示发表/获取时间与来源，返回恢复滚动和焦点', t4)

        def t5():
            # Open the image post by its title, check wide split, preview image,
            # favorite it and close the lightbox back onto the same detail.
            page.locator('#discoveryList .rm-post-open').nth(1).click()
            page.wait_for_timeout(1600)
            assert page.locator('#page-post').is_visible()
            assert '雨停之后的城市植物' in ui.text('#postDetail')
            media = page.locator('#postDetail .rm-post-media').bounding_box()
            body = page.locator('#postDetail .rm-post-detail-body').bounding_box()
            assert media and body and media['x'] < body['x'], (media, body)
            tile = page.locator('#postDetail .rm-post-media-item').first
            tile.wait_for(state='visible', timeout=15000)
            page.wait_for_timeout(900)
            tile.click()
            page.wait_for_timeout(500)
            assert page.locator('#imagePreviewDialog').is_visible()
            ui.shot('a1-t05-image-preview-wide')
            page.locator('#imagePreviewDialog [data-close-dialog]').first.click()
            page.wait_for_timeout(400)
            assert not page.locator('#imagePreviewDialog').is_visible()
            star = page.locator('#postDetail .rm-post-favorite')
            if star.get_attribute('aria-pressed') != 'true':
                star.click()
                page.wait_for_timeout(700)
            if star.get_attribute('aria-pressed') != 'true':
                # A previous run may have left the opposite state; exercise the
                # real toggle once more rather than assuming a clean database.
                star.click()
                page.wait_for_timeout(700)
                star.click()
                page.wait_for_timeout(700)
            assert star.get_attribute('aria-pressed') == 'true'
            assert '已收藏' in ui.text('#postDetail .rm-post-favorite')
            ui.shot('a1-t05-post-detail-wide')
            page.locator('#postBack').click()
            page.wait_for_timeout(900)
            return {'mediaLeftOfBody': True, 'imagePreview': True, 'favorite': True}

        case('A1-T5', '宽屏图文并排，配图独立预览，收藏保留', t5)

        def t6():
            page.locator('[data-filter="mine"]').click()
            page.wait_for_timeout(1200)
            page.locator('#mineFeedList .rm-post').first.wait_for(state='visible', timeout=15000)
            # Edit the legacy v1 text post here: the daemon's import path
            # re-encodes images, while the fixture's current image post is
            # intentionally a raw public copy used for read-only image checks.
            legacy = page.locator('#mineFeedList .rm-post', has_text='旧版本人动态').first
            legacy.locator('.rm-post-open').click()
            page.wait_for_timeout(1500)
            assert page.locator('#page-post').is_visible()
            assert '旧版本人动态' in ui.text('#postDetail')
            edit = page.locator('#postDetail .rm-post-edit')
            assert edit.count() == 1
            edit.click()
            page.wait_for_timeout(1200)
            assert page.locator('#postEditorPanel').is_visible()
            assert page.locator('#postTitleInput').input_value() == '旧版本人动态'
            page.locator('#postEditorClose').click()
            page.wait_for_timeout(500)
            assert page.locator('#postEditorPanel').is_hidden()
            return {'mineDetail': True, 'editEntry': True, 'editorTitle': '旧版本人动态'}

        case('A1-T6', '我的动态详情保留编辑入口并打开原帖编辑器', t6)

        def t7():
            page.locator('[data-filter="all"]').click()
            page.wait_for_timeout(800)
            ui.nav('contacts')
            page.locator('#contactList [data-contact-peer]').first.wait_for(state='visible', timeout=15000)
            page.locator('#contactList [data-contact-peer]').first.click()
            page.wait_for_timeout(1500)
            assert page.locator('#profileView').is_visible()
            page.locator('#profileFilesOpen').click()
            page.wait_for_timeout(1300)
            file_list = page.locator('#profileFileList')
            file_list.wait_for(state='visible', timeout=15000)
            files_text = file_list.inner_text()
            for wanted in ['friends.json', 'hello.txt', 'broken', 'download-me', 'profile/index.md']:
                assert wanted in files_text, (wanted, files_text[:800])
            assert 'posts/' not in files_text, 'posts stay under 他的动态'
            # Valid text file preview.
            hello = file_list.locator('.rm-post', has_text='hello.txt').first
            hello.locator('.rm-post-toggle').click()
            page.wait_for_timeout(900)
            assert '普通的公开文本附件' in hello.inner_text()
            # Broken version has a short state and technical source detail.
            broken = file_list.locator('.rm-post', has_text='broken.txt').first
            assert 'SHA-256' in broken.inner_text() or '哈希' in broken.inner_text(), broken.inner_text()
            broken.locator('.rm-post-toggle').click()
            page.wait_for_timeout(900)
            assert '大小或哈希不符' in broken.inner_text() or 'SHA-256' in broken.inner_text(), broken.inner_text()[:900]
            broken.locator('.rm-source-summary').click()
            page.wait_for_timeout(250)
            assert '本地副本' in broken.locator('.rm-source-details').inner_text()
            # A missing local copy is fetched only through the controlled
            # preview path and reports its real acquisition.
            download_me = file_list.locator('.rm-post', has_text='download-me').first
            download_me.locator('.rm-post-toggle').click()
            page.wait_for_timeout(2500)
            assert '只应在阅读时从远端受控获取' in download_me.inner_text(), download_me.inner_text()[:900]
            assert '手动获取' in download_me.inner_text(), download_me.inner_text()[:900]
            ui.shot('a1-t07-public-files-wide')
            page.locator('#profileFilesClose').click()
            page.wait_for_timeout(500)
            assert page.locator('#profileView').is_visible()
            assert page.locator('#contactProfileFiles').is_hidden()
            page.locator('#profileBack').click()
            page.wait_for_timeout(700)
            assert page.locator('#page-contacts').is_visible()
            return {'validFileReadable': True, 'brokenFileExplained': True, 'filesReturn': True}

        case('A1-T7', '远端公开文件入口保留通讯录、资料、普通附件与校验失败提示', t7)

        def t8():
            page.locator('#settingsTrigger').click()
            page.wait_for_timeout(700)
            page.locator('#settingsIndex .rm-settings-item[data-settings-tab="public"]').click()
            page.wait_for_timeout(1000)
            files_text = ui.text('#minePostList')
            for wanted in ['friends.json', '岸边的公开纸条', '本机的图文记录', '旧版本人动态', '旧版 Agent 动态', '来源未注明的旧动态']:
                assert wanted in files_text, (wanted, files_text[:1000])
            assert '来源未注明' in files_text and 'Agent' in files_text
            # Ordinary markdown keeps its real filename in source details even
            # when the card title uses the first heading.
            hello = page.locator('#minePostList .rm-post', has_text='岸边的公开纸条').first
            hello.locator('.rm-source-summary').click()
            page.wait_for_timeout(250)
            source = hello.locator('.rm-source-details').inner_text()
            assert 'hello.md' in source, source
            assert 'profile/index.md' in page.locator('#minePostList').inner_text() or '岸灯' in files_text
            ui.shot('a1-t08-my-public-files-wide')
            page.locator('#settingsTrigger').click()
            page.wait_for_timeout(600)
            assert page.locator('#page-settings').is_hidden()
            ui.nav('explore')
            page.wait_for_timeout(800)
            return {'localFiles': ['friends.json', 'hello.md', 'profile/index.md'], 'localPosts': 4}

        case('A1-T8', '本机设置内的我的公开文件保留资料、附件与全部署名', t8)

        def start_offline_host():
            """Start a second, fresh DSH web host for the offline phase.

            The first host keeps its in-memory peer-profile cache across panel
            remounts; a real app restart is the honest way to exercise the
            restart-safe local-history fallback. The second host shares the
            isolated DSH_HOME and node A data only.
            """
            port = int(HOST_PORT) + 1
            log_path = ROOT / f'dsh-{port}.log'
            log_path.write_text('')
            env = os.environ.copy()
            env.update({
                'A1_HOST_PORT': str(port),
                'A1_DSH_HOME': str(ROOT / 'dsh-home'),
                'A1_DATA_DIR': str(ROOT / 'node-a'),
                'A1_ACCEPTANCE_DIR': str(ROOT),
            })
            out = open(log_path, 'ab')
            proc = subprocess.Popen(
                ['sh', str(REPO / 'scripts/ui-acceptance/a1/start-host.sh')],
                cwd=REPO, env=env, stdout=out, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            RESULTS['offlineHostPort'] = port
            RESULTS['offlineHostPid'] = proc.pid
            save()

            def url_ready():
                match = re.findall(r'https?://127\.0\.0\.1:%d/\S+' % port, log_path.read_text())
                return match[-1] if match else None

            url = wait_for(url_ready, f'fresh host on {port}', timeout=30)
            return url

        def t9():
            nonlocal page, ui
            # Node B was stopped by this test only after its files were read
            # online. A fresh host process rules out the previous panel's
            # in-memory profile cache, so the removed old-note must be rebuilt
            # from verified local history.
            pid_file = ROOT / 'node-b.pid'
            pid = int(pid_file.read_text())
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 20
            while time.time() < deadline:
                status = cli(['status', '--data-dir', str(ROOT / 'node-b'), '--json'])
                if status.returncode != 0:
                    break
                time.sleep(0.4)
            assert status.returncode != 0, 'fixture node B did not stop'
            offline_url = start_offline_host()
            page.close()
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
            page.on('console', lambda msg: CONSOLE_ERRORS.append(f'{msg.type}: {msg.text}') if msg.type == 'error' else None)
            page.goto(offline_url, wait_until='domcontentloaded')
            page.wait_for_timeout(2600)
            ui = UI(page)
            ui.dismiss()
            ui.open_panel()
            ui.nav('contacts')
            page.locator('#contactList [data-contact-peer]').first.wait_for(state='visible', timeout=20000)
            page.locator('#contactList [data-contact-peer]').first.click()
            page.wait_for_timeout(1500)
            page.locator('#profileFilesOpen').click()
            page.wait_for_timeout(1200)
            # The remote manifest read may take its bounded timeout; poll.
            wait_for(lambda: '历史' in ui.text('#profileFilesStatus', timeout=2000), 'offline local history', timeout=30)
            note = ui.text('#profileFilesNote')
            assert '对方当前不可达' in note, note
            files_text = ui.text('#profileFileList')
            assert 'old-note.md' in files_text, files_text[:1200]
            assert '本地历史' in ui.text('#profileFilesStatus')
            ui.shot('a1-t09-local-history-offline-wide')
            page.locator('#profileFilesClose').click()
            page.wait_for_timeout(400)
            RESULTS['offlineUrl'] = offline_url
            save()
            return {'historicalCopy': True, 'note': note, 'freshHost': offline_url, 'hostPid': RESULTS['offlineHostPid']}

        case('A1-T9', '远端离线时公开文件入口列出历史下载副本', t9)

        def t10():
            ui.viewport(390, 844)
            ui.nav('explore')
            page.locator('[data-filter="all"]').click()
            page.wait_for_timeout(900)
            # T9 remounted after the peer went offline; force one Feed read so
            # the newly observed cards re-arm their local image loads.
            page.locator('#exploreRefresh').click()
            page.wait_for_timeout(900)
            wait_feed(page)
            wait_collapsed(page, '#page-explore')
            wait_images(page, '#discoveryList .rm-post-media-img')
            assert page.locator('#mobileNav').is_visible()
            assert not page.locator('#desktopNav').is_visible()
            assert ui.overflow() <= 0, ui.overflow()
            ui.shot('a1-t10-feed-narrow')
            page.locator('#discoveryList .rm-post-open').nth(1).click()
            page.wait_for_timeout(1500)
            assert page.locator('#page-post').is_visible()
            wait_collapsed(page, '#page-post')
            wait_images(page, '#postDetail .rm-post-media-img')
            media = page.locator('#postDetail .rm-post-media').bounding_box()
            body = page.locator('#postDetail .rm-post-detail-body').bounding_box()
            assert media and body and media['y'] < body['y'], (media, body)
            assert ui.overflow() <= 0, ui.overflow()
            ui.shot('a1-t10-detail-narrow')
            page.locator('#postBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#page-explore').is_visible()
            assert ui.active_focus().startswith('post:')
            ui.shot('a1-t10-feed-return-narrow')
            return {'narrowImageBeforeBody': True, 'overflow': ui.overflow(), 'oneNav': True}

        case('A1-T10', '390×844 图片在正文前、无横向溢出、返回焦点恢复', t10)

        assert not PAGE_ERRORS, PAGE_ERRORS
        frame = page.evaluate('''() => ({
          width: innerWidth,
          visibleNav: document.querySelector('#desktopNav') && getComputedStyle(document.querySelector('#desktopNav')).display !== 'none' ? 'desktop' : 'mobile',
        })''')
        RESULTS['checks'] = {
            'feedCards': 3,
            'pageErrors': 0,
            'wide': '1440x900',
            'narrow': '390x844',
            'finalViewport': frame,
        }
        save()
        # The offline phase starts its own fresh host. Stop only that process;
        # the main 435x/436x host is owned by the caller.
        offline_pid = RESULTS.get('offlineHostPid')
        if isinstance(offline_pid, int) and offline_pid > 0:
            try:
                os.killpg(os.getpgid(offline_pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        browser.close()
    print(json.dumps({'result': str(RESULT_FILE), 'cases': {k: v['status'] for k, v in RESULTS['cases'].items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
