#!/usr/bin/env python3
"""P5 real-DSH wide/narrow acceptance for T1-T13.

Run prepare.mjs and start-host.sh first. This driver uses a real isolated DSH
Web host and the real registered raminga_* tools through the test-only control
plugin. It never touches ports 4321/4332, ~/.raminga or the user's DSH_HOME.
"""
from playwright.sync_api import sync_playwright
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

ROOT = pathlib.Path(os.environ.get('P5_ACCEPTANCE_DIR', '.local/ui-refresh-20261117/p5')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
API = REPO / 'scripts' / 'ui-acceptance' / 'p5' / 'api.mjs'
BIN = REPO / 'bin' / 'raminga'
URL = re.findall(r'https?://\S+', (ROOT / 'dsh-4344.log').read_text())[-1]
CONTROL = FIXTURE['controlUrl']
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
A_DIR = ROOT / 'node-a'
B_DIR = ROOT / 'node-b'
JOURNEY = FIXTURE['journey']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'url': URL,
    'fixture': str(ROOT / 'fixture.json'),
    'cases': {},
    'screenshots': [],
    'pageErrors': [],
    'consoleErrors': [],
}
PAGE_ERRORS = RESULTS['pageErrors']
CONSOLE_ERRORS = RESULTS['consoleErrors']
RESULT_FILE = EVIDENCE / 'p5-results.json'
PRIVATE_MARKER = 'P5_PRIVATE_MARKER_7f3c9a'


def save_results():
    RESULT_FILE.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def case(tid, name, facade):
    started = time.time()
    try:
        data = facade() or {}
        RESULTS['cases'][tid] = {'id': tid, 'name': name, 'status': 'PASS', 'seconds': round(time.time() - started, 2), **data}
        print(f'PASS {tid} {name}')
    except Exception as exc:  # noqa: BLE001 - evidence must record the real failure
        RESULTS['cases'][tid] = {
            'id': tid, 'name': name, 'status': 'FAIL',
            'seconds': round(time.time() - started, 2),
            'error': str(exc), 'trace': traceback.format_exc()[-3000:],
        }
        print(f'FAIL {tid} {name}: {exc}')
        save_results()
        raise
    finally:
        save_results()


def sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def api(command, **options):
    proc = subprocess.run(
        ['node', str(API), command, json.dumps(options, ensure_ascii=False)],
        cwd=REPO, text=True, capture_output=True, timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'api {command} failed: {proc.stderr or proc.stdout}')
    return json.loads(proc.stdout)


def cli(args, timeout=60):
    proc = subprocess.run([str(BIN), *args], cwd=REPO, text=True, capture_output=True, timeout=timeout)
    return proc


def cli_json(args, timeout=60):
    proc = cli([*args, '--json'], timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f'raminga {args} failed: {proc.stderr or proc.stdout}')
    return json.loads(proc.stdout)


def control(tool, args, timeout=140):
    request = urllib.request.Request(
        CONTROL,
        data=json.dumps({'tool': tool, 'args': args}, ensure_ascii=False).encode('utf-8'),
        headers={'content-type': 'application/json'}, method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        body = error.read().decode('utf-8')
        raise RuntimeError(f'control {tool} HTTP {error.code}: {body[:500]}')


def activity_ops():
    path = A_DIR / 'agent' / 'activity.jsonl'
    if not path.exists():
        return []
    merged = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        op = merged.setdefault(event['operation_id'], dict(event))
        if event['event'] == 'finished':
            op.update(event)
            op['state'] = 'finished'
        else:
            op['state'] = 'running'
    return sorted(merged.values(), key=lambda item: (item.get('started_at', ''), item['operation_id']))


def friends_unread(data_dir=A_DIR):
    rows = api('friends', dataDir=str(data_dir)).get('friends', [])
    for row in rows:
        if row.get('peerId') == PEER_B:
            return int(row.get('unreadCount', 0))
    return 0


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(5):
            close = self.page.locator('[aria-label="Close"]:visible')
            if close.count() == 0:
                break
            close.first.click()
            self.page.wait_for_timeout(350)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(500)

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

    def close_panel(self):
        if not self.page.locator('#settingsTrigger').count():
            return
        button = self.page.get_by_role('button', name='New Session', exact=False)
        if button.count() and button.first.is_visible():
            button.first.click()
        else:
            toggle = self.page.locator('[aria-label="Open sidebar"]:visible')
            if toggle.count():
                toggle.first.click()
                self.page.wait_for_timeout(500)
            button.first.click()
        self.page.wait_for_timeout(700)
        if self.page.locator('#settingsTrigger').count():
            raise AssertionError('Raminga panel did not unmount')

    def remount(self):
        self.close_panel()
        self.open_panel()

    def nav(self, item):
        nav = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{nav} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(800)

    def visible_nav(self):
        return '#desktopNav' if self.page.locator('#desktopNav').is_visible() else '#mobileNav'

    def nav_items(self):
        return self.page.locator(f'{self.visible_nav()} [data-nav]').all_inner_texts()

    def current_nav(self):
        return self.page.locator(f'{self.visible_nav()} [data-nav][aria-current="page"]').all_inner_texts()

    def text(self, selector, timeout=10000):
        loc = self.page.locator(selector)
        loc.wait_for(state='visible', timeout=timeout)
        return loc.inner_text()

    def wait_text(self, selector, pattern, timeout=15000):
        deadline = time.time() + timeout / 1000
        last = ''
        while time.time() < deadline:
            loc = self.page.locator(selector)
            if loc.count() and loc.first.is_visible():
                last = loc.first.inner_text()
                if re.search(pattern, last):
                    return last
            self.page.wait_for_timeout(180)
        raise AssertionError(f'{selector} did not match {pattern!r}; last={last!r}')

    def shot(self, name, full=False):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path), full_page=full)
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save_results()
        return path

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')

    def settings(self, tab=None):
        if not self.page.locator('#page-settings').is_visible():
            self.page.locator('#settingsTrigger').click()
            self.page.wait_for_timeout(700)
        if tab:
            if self.page.locator('#settingsIndex').is_visible():
                self.page.locator(f'#settingsIndex .rm-settings-item[data-settings-tab="{tab}"]').click()
            else:
                back = self.page.locator('[data-settings-back]:visible')
                if back.count():
                    back.first.click()
                    self.page.wait_for_timeout(500)
                self.page.locator(f'#settingsIndex .rm-settings-item[data-settings-tab="{tab}"]').click()
            self.page.wait_for_timeout(850)

    def settings_home(self):
        self.page.locator('#settingsTrigger').click()
        self.page.wait_for_timeout(500)


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


def large_file():
    path = B_DIR / 'public' / 'posts' / 'p5-large.bin'
    if not path.exists():
        with path.open('wb') as handle:
            for _ in range(12):
                handle.write(b'P5-LARGE-FIXTURE-' + os.urandom(1024 * 1024 - 17))
    return path


def pause_b():
    os.kill(int((ROOT / 'node-b.pid').read_text()), signal.SIGSTOP)


def resume_b():
    os.kill(int((ROOT / 'node-b.pid').read_text()), signal.SIGCONT)


def async_control(tool, args):
    box = {}

    def worker():
        started = time.time()
        try:
            box['value'] = control(tool, args)
        except Exception as error:  # noqa: BLE001
            box['error'] = str(error)
        box['elapsed'] = round(time.time() - started, 2)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread, box


def stop_node(ui, page):
    if ui.page.locator('#conversationView').is_visible():
        ui.page.locator('#conversationBack').click()
        ui.page.wait_for_timeout(500)


def t1(ui):
    assert ui.page.locator('#page-home').is_visible(), 'default page is not home'
    items = ui.nav_items()
    assert items == ['动态', '主页', '联系人'], items
    assert ui.current_nav() == ['主页'], ui.current_nav()
    assert 'Agent' not in ''.join(items), 'home/nav exposes an Agent tab'
    assert ui.page.locator('#page-home [role="tab"]').count() == 0
    wide_overflow = ui.overflow()
    assert wide_overflow == 0, wide_overflow
    ui.shot('p5-t01-home-wide')
    ui.viewport(390, 844)
    assert ui.page.locator('#mobileNav').is_visible()
    assert ui.nav_items() == ['动态', '主页', '联系人']
    assert ui.current_nav() == ['主页']
    narrow_overflow = ui.overflow()
    assert narrow_overflow == 0, narrow_overflow
    ui.shot('p5-t01-home-narrow')
    ui.viewport(1440, 900)
    return {'nav': items, 'wideOverflow': wide_overflow, 'narrowOverflow': narrow_overflow}


def t2(ui):
    if ui.page.locator('#page-home').count() == 0 or not ui.page.locator('#page-home').is_visible():
        ui.nav('home')
    result = control('raminga_status', {})
    assert result.get('ok') is True and result.get('value', {}).get('peerId') == PEER_A
    ui.wait_text('#homeActivityRecent', r'最近活动', timeout=12000)
    ui.wait_text('#homeJourneyList', r'session-p5-01', timeout=12000)
    hero = ui.page.locator('#home-agent-hero').bounding_box()
    human = ui.page.locator('#home-human-strip').bounding_box()
    journeys = ui.page.locator('#home-journeys').bounding_box()
    activity = ui.page.locator('#home-activity').bounding_box()
    assert hero and human and journeys and activity
    assert hero['y'] < human['y'] < journeys['y'], (hero, human, journeys)
    assert activity['y'] >= journeys['y'], (activity, journeys)
    assert ui.page.locator('#homeAgentName').inner_text() == '岸灯'
    assert '海岸' in ui.page.locator('#homeAgentInterests').inner_text()
    assert ui.page.locator('#homeActivityRecent').is_visible()
    assert ui.page.locator('#homeJourneyList').is_visible()
    ui.shot('p5-t02-home-activity-wide')
    ui.viewport(390, 844)
    ui.shot('p5-t02-home-activity-narrow')
    ui.viewport(1440, 900)
    return {'operation': result['value'].get('peerId'), 'order': {'hero': hero['y'], 'human': human['y'], 'journey': journeys['y']}}


def t3(ui):
    ui.settings('private')
    persona = ui.page.locator('#settingsStableInput').input_value()
    growth = ui.page.locator('#settingsGrowthInput').input_value()
    assert persona.strip() and growth.strip()
    new_persona = persona + f'\n\n<!-- {PRIVATE_MARKER}:persona -->\n'
    new_growth = growth + f'\n\n<!-- {PRIVATE_MARKER}:growth -->\n'
    ui.page.locator('#settingsStableInput').fill(new_persona)
    ui.page.locator('#settingsGrowthInput').fill(new_growth)
    ui.page.locator('#settingsStableSave').click()
    ui.wait_text('#settingsPrivateNote', r'已保存 persona\.md', timeout=12000)
    ui.page.locator('#settingsGrowthSave').click()
    ui.wait_text('#settingsPrivateNote', r'已保存 growth\.md', timeout=12000)
    persona_path = A_DIR / 'agent' / 'persona.md'
    growth_path = A_DIR / 'agent' / 'growth.md'
    assert PRIVATE_MARKER in persona_path.read_text()
    assert PRIVATE_MARKER in growth_path.read_text()
    public_hits = [str(path.relative_to(A_DIR)) for path in (A_DIR / 'public').rglob('*')
                   if path.is_file() and PRIVATE_MARKER in path.read_text(errors='ignore')]
    assert not public_hits, public_hits
    hashes = {'persona': sha256_file(persona_path), 'growth': sha256_file(growth_path)}
    ui.shot('p5-t03-settings-private-wide')
    ui.remount()
    ui.settings('private')
    assert PRIVATE_MARKER in ui.page.locator('#settingsStableInput').input_value()
    assert PRIVATE_MARKER in ui.page.locator('#settingsGrowthInput').input_value()
    assert hashes['persona'] == sha256_file(persona_path)
    assert hashes['growth'] == sha256_file(growth_path)
    ui.viewport(390, 844)
    ui.shot('p5-t03-settings-private-narrow')
    ui.viewport(1440, 900)
    return {'hashes': hashes, 'publicHits': public_hits}


def t4(ui):
    before = api('remote-profile', dataDir=str(B_DIR), peerId=PEER_A)
    assert before.get('found') is True
    assert before.get('profile', {}).get('legacyFallback') is True, before.get('profile')
    assert before.get('profile', {}).get('sourcePath') == 'profile/index.md' or before.get('profile', {}).get('sourcePath') == 'profile/agent-card.json', before.get('profile')
    ui.settings('public')
    values = {
        '#publicAgentName': '岸灯 P5',
        '#publicAgentDescription': 'P5 验收公开的 Agent 简介；profile.json v2 是读取优先级最高的事实来源。',
        '#publicAgentInterests': '海岸，旧地图，独立游戏，潮汐',
        '#publicAgentStyle': '先听对方说完，再用短句描述事实与猜测。',
        '#publicHumanName': '林岸 P5',
        '#publicHumanBio': 'P5 验收公开的人类介绍；旧 index.md 继续为旧客户端保留。',
    }
    for selector, value in values.items():
        ui.page.locator(selector).fill(value)
    ui.page.locator('#publicAvatarInput').set_input_files(str(REPO / 'tests/fixtures/ui-refresh/avatar.png'))
    ui.page.wait_for_timeout(1200)
    ui.page.locator('#publicPublishButton').click()
    ui.page.wait_for_timeout(900)
    receipt = ui.page.locator('#publicPublishReceipt').inner_text()
    assert '发布' in receipt
    ui.page.locator('#publicPublishButton').click()
    ui.wait_text('#publicPublishReceipt', r'发布完成', timeout=30000)
    receipt = ui.page.locator('#publicPublishReceipt').inner_text()
    profile_path = A_DIR / 'public' / 'profile' / 'profile.json'
    assert profile_path.exists()
    profile = json.loads(profile_path.read_text())
    assert profile['schema_version'] == 2
    assert profile['agent']['name'] == '岸灯 P5'
    assert profile['human']['name'] == '林岸 P5'
    index_text = (A_DIR / 'public' / 'profile' / 'index.md').read_text()
    assert '林岸 P5' in index_text
    agent_card = json.loads((A_DIR / 'public' / 'profile' / 'agent-card.json').read_text())
    assert agent_card['display_name'] == '岸灯 P5'
    old_posts = [path for path in (A_DIR / 'public' / 'posts').glob('p5-a-legacy-*.json')]
    assert len(old_posts) == 2, old_posts
    remote = api('remote-profile', dataDir=str(B_DIR), peerId=PEER_A)
    assert remote['profile']['legacyFallback'] is False, remote['profile']
    assert remote['profile']['sourcePath'] == 'profile/profile.json', remote['profile']
    assert remote['profile']['agentName'] == '岸灯 P5'
    assert remote['profile']['humanName'] == '林岸 P5'
    fetched = cli_json(['content', 'get', PEER_A, 'profile/profile.json', '--data-dir', str(B_DIR)])
    remote_sha = fetched.get('sha256') or fetched.get('final', {}).get('sha256')
    assert remote_sha == sha256_file(profile_path), (remote_sha, sha256_file(profile_path))
    ui.shot('p5-t04-profile-published-wide')
    ui.remount()
    ui.nav('home')
    avatar_src = ui.page.locator('#homeAgentAvatar img').get_attribute('src')
    assert avatar_src and avatar_src.startswith('data:image/png'), avatar_src[:40]
    ui.shot('p5-t04-home-avatar-wide')
    return {'receipt': receipt[:500], 'profileSha256': sha256_file(profile_path), 'remoteSha256': remote_sha,
            'beforeSource': before['profile']['sourcePath'], 'afterSource': remote['profile']['sourcePath']}


def post_editor_open(ui):
    ui.page.locator('#composePost').click()
    ui.page.wait_for_timeout(700)
    if ui.page.locator('#postAuthorKind').is_disabled():
        ui.page.locator('#postDraftSelect').select_option('')
        ui.page.wait_for_timeout(500)


def publish_post(ui, title, body, tags, kind, image=None):
    post_editor_open(ui)
    ui.page.locator('#postTitleInput').fill(title)
    ui.page.locator('#postBodyInput').fill(body)
    ui.page.locator('#postTagsInput').fill(tags)
    ui.page.locator('#postAuthorKind').select_option(kind)
    if image:
        ui.page.locator('#postImageInput').set_input_files(str(image))
        ui.page.wait_for_timeout(1000)
    ui.page.locator('#postPublishButton').click()
    ui.page.wait_for_timeout(1000)
    ui.page.locator('#postPublishButton').click()
    ui.wait_text('#postPublishReceipt', r'发布完成', timeout=30000)
    receipt = ui.page.locator('#postPublishReceipt').inner_text()
    ui.page.locator('#postEditorClose').click()
    ui.page.wait_for_timeout(500)
    return receipt


def t5(ui):
    if not ui.page.locator('#page-explore').is_visible():
        ui.nav('explore')
    user_title = 'P5 本人动态：岸边的风'
    agent_title = 'P5 Agent 动态：潮汐笔记'
    receipt_user = publish_post(ui, user_title, '# P5 本人动态：岸边的风\n\nP5 验收中由本人署名发布的动态，带一张公开图片。', 'P5,岸边', 'user', REPO / 'tests/fixtures/ui-refresh/post.png')
    receipt_agent = publish_post(ui, agent_title, '# P5 Agent 动态：潮汐笔记\n\nP5 验收中由 Agent 署名发布的动态。', 'P5,Agent', 'agent')
    ui.page.locator('[data-filter="mine"]').click()
    ui.page.wait_for_timeout(1400)
    feed = ui.text('#mineFeedList')
    for must in ['潮汐表之外的散步', '把海风折成一张小地图', user_title, agent_title]:
        assert must in feed, (must, feed[:1000])
    badges = ui.page.locator('#mineFeedList .rm-post-author-badge').all_inner_texts()
    assert '本人' in badges and 'Agent' in badges, badges
    card = ui.page.locator('#mineFeedList .rm-post', has_text=user_title).first
    tile = card.locator('.rm-post-media-item').first
    assert tile.count() == 1
    tile.click()
    ui.page.wait_for_timeout(2200)
    images = card.locator('img[src^="blob:"]:visible')
    assert images.count() >= 1, 'published image was not rendered from a blob URL'
    ui.shot('p5-t05-mine-feed-wide')
    ui.viewport(390, 844)
    ui.shot('p5-t05-mine-feed-narrow')
    ui.viewport(1440, 900)
    return {'titles': [user_title, agent_title], 'badges': badges, 'images': images.count(), 'receipts': [receipt_user[:200], receipt_agent[:200]]}


def publish_status(value):
    return str(value or '').lower().replace('public_publish_status_', '')


def t6(ui):
    before = api('manifest-map', dataDir=str(A_DIR))
    draft = api('save-post', dataDir=str(A_DIR), title='P5 失败注入与并发', body='# P5 失败注入与并发\n\n这条动态用于验证发布失败不会改变清单。', tags=['P5', 'failure'], authorKind='user')
    os.chmod(A_DIR / 'public' / 'posts', 0o500)
    failed = None
    try:
        failed = api('publish', dataDir=str(A_DIR), draftId=draft['draftId'], expectedRevision=draft['revision'])
    except Exception as error:  # noqa: BLE001 - the injected failure is the evidence
        failed = {'error': str(error)}
    finally:
        os.chmod(A_DIR / 'public' / 'posts', 0o755)
    if isinstance(failed, dict) and publish_status(failed.get('status')) in ('published', 'already_published'):
        raise AssertionError(f'injected publish unexpectedly succeeded: {failed}')
    after_fail = api('manifest-map', dataDir=str(A_DIR))
    assert before == after_fail, 'failed publish changed the public manifest'
    assert (A_DIR / 'publication' / 'staging').exists() is False or not any((A_DIR / 'publication' / 'staging').iterdir())
    retry = api('publish', dataDir=str(A_DIR), draftId=draft['draftId'], expectedRevision=draft['revision'])
    assert publish_status(retry.get('status')) == 'published', retry
    digest = retry.get('manifestSha256')
    assert digest
    draft2 = api('save-post', dataDir=str(A_DIR), title='P5 并发重试', body='# P5 并发重试\n\n两个并发发布只能得到同一份清单。', tags=['P5', 'concurrency'], authorKind='user')
    command = ['node', str(API), 'publish', json.dumps({'dataDir': str(A_DIR), 'draftId': draft2['draftId'], 'expectedRevision': draft2['revision']})]
    p1 = subprocess.Popen(command, cwd=REPO, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p2 = subprocess.Popen(command, cwd=REPO, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out1, err1 = p1.communicate(timeout=120)
    out2, err2 = p2.communicate(timeout=120)
    if p1.returncode != 0 or p2.returncode != 0:
        raise AssertionError(f'concurrent publish failed: {(err1 or out1)[:300]} / {(err2 or out2)[:300]}')
    a = json.loads(out1)
    b = json.loads(out2)
    assert publish_status(a.get('status')) in ('published', 'already_published'), a
    assert publish_status(b.get('status')) in ('published', 'already_published'), b
    assert a.get('manifestSha256') == b.get('manifestSha256'), (a.get('manifestSha256'), b.get('manifestSha256'))
    assert sorted(a.get('files') or []) == sorted(b.get('files') or [])
    assert digest
    return {'manifestBefore': before['count'], 'failed': failed, 'retry': publish_status(retry.get('status')), 'digest': digest,
            'concurrent': [publish_status(a.get('status')), publish_status(b.get('status')), a.get('manifestSha256')]}



def t7(ui):
    if ui.page.locator('#profileView').is_visible():
        ui.page.locator('#profileBack').click()
        ui.page.wait_for_timeout(500)
    ui.nav('contacts')
    for text in ['P5 未读一：雨后的巷口有一株新长的蕨。', 'P5 未读二：Agent 读取后这两条未读仍应保留。']:
        proc = cli(['chat', 'send', '--to', PEER_A, '--text', text, '--data-dir', str(B_DIR)], timeout=60)
        assert proc.returncode == 0, proc.stderr or proc.stdout
    wait_for(lambda: friends_unread() == 2, 'two unread messages', timeout=20)
    ui.wait_text('#contactUnreadCount', r'1', timeout=15000)
    badge = ui.page.locator('#desktopNav [data-nav-badge="contacts"]')
    assert badge.is_visible() and badge.inner_text() == '2'
    row = ui.page.locator(f'#contactList [data-contact-row="{PEER_B}"]')
    row.wait_for(state='visible', timeout=15000)
    assert 'P5 未读二' in row.inner_text(), row.inner_text()
    assert row.locator('.rm-contact-unread').inner_text() == '2'
    ui.shot('p5-t07-contacts-unread-wide')
    row.locator('[data-profile-peer]').first.click()
    ui.page.locator('#profileView').wait_for(state='visible', timeout=15000)
    ui.wait_text('#profileName', r'澄野', timeout=20000)
    ui.wait_text('#profileHumanName', r'阿澄', timeout=20000)
    profile_text = ui.page.locator('#profileView').inner_text()
    for must in ['澄野', '阿澄', '我们的交互', '他的动态', '他的通讯录']:
        assert must in profile_text, (must, profile_text[:800])
    assert 'Agent 公开卡片' in profile_text
    ui.shot('p5-t07-contact-profile-wide')
    ui.page.locator('[data-profile-tab="posts"]').click()
    ui.page.wait_for_timeout(800)
    ui.page.locator('#profilePostList').scroll_into_view_if_needed()
    ui.wait_text('#profilePostList', r'雨停之后的城市植物', timeout=15000)
    ui.wait_text('#profilePostList', r'一张旧唱片的反面', timeout=15000)
    post_card = ui.page.locator('#profilePostList .rm-post', has_text='雨停之后的城市植物').first
    tile = post_card.locator('.rm-post-media-item').first
    if tile.count():
        tile.click()
        ui.page.wait_for_timeout(2200)
        assert post_card.locator('img[src^="blob:"]:visible').count() >= 1, 'peer post image did not load'
    ui.page.screenshot(path=str(EVIDENCE / 'p5-t07-contact-profile-posts-wide.png'))
    RESULTS['screenshots'].append(str((EVIDENCE / 'p5-t07-contact-profile-posts-wide.png').relative_to(REPO)))
    ui.page.locator('[data-profile-tab="address"]').click()
    ui.page.wait_for_timeout(1200)
    address = ui.page.locator('#contactProfileAddress').inner_text()
    assert '他的通讯录' in address and ('公开线索' in address or '没有公开通讯录' in address), address
    ui.shot('p5-t07-contact-profile-address-wide')
    ui.viewport(390, 844)
    ui.shot('p5-t07-contact-profile-narrow')
    ui.viewport(1440, 900)
    ui.page.locator('#profileBack').click()
    ui.page.wait_for_timeout(500)
    return {'unread': friends_unread(), 'profile': profile_text[:500], 'address': address[:500]}


def t9(ui):
    assert friends_unread() == 2, friends_unread()
    result = control('raminga_chat_history', {'limit': 10})
    assert result.get('ok') is True, result
    messages = result['value'].get('messages', [])
    assert len(messages) >= 2 and messages[0].get('text', '').startswith('P5 未读二'), messages[:2]
    assert friends_unread() == 2, 'Agent chat_history cleared the human unread cursor'
    ui.nav('contacts')
    ui.wait_text('#contactUnreadCount', r'1', timeout=10000)
    ops = activity_ops()
    assert ops[-1]['tool'] == 'raminga_chat_history' and ops[-1].get('result') == 'ok', ops[-1]
    ui.page.locator('#contactsMessages').click()
    ui.page.locator('#conversationList').wait_for(state='visible', timeout=15000)
    ui.page.locator(f'#conversationList [data-conversation-peer="{PEER_B}"]').click()
    ui.page.locator('#conversationView').wait_for(state='visible', timeout=15000)
    ui.wait_text('#conversationName', r'chengye', timeout=10000)
    wait_for(lambda: friends_unread() == 0, 'human read cursor cleared', timeout=20)
    ui.page.wait_for_timeout(1200)
    ui.nav('contacts')
    ui.wait_text('#contactUnreadCount', r'0', timeout=10000)
    ui.shot('p5-t09-after-human-read-wide')
    ui.page.locator('#contactsMessages').click()
    ui.page.wait_for_timeout(900)
    if not ui.page.locator('#conversationView').is_visible():
        ui.page.locator(f'#conversationList [data-conversation-peer="{PEER_B}"]').click()
        ui.page.wait_for_timeout(700)
    ui.page.locator('#conversationView').wait_for(state='visible', timeout=15000)
    return {'unreadAfterTool': 2, 'unreadAfterHuman': 0, 'messages': len(messages)}


def t8(ui):
    assert ui.page.locator('#conversationView').is_visible()
    count = ui.page.locator('#messageList .rm-message').count()
    total = len(api('messages', dataDir=str(A_DIR), limit=200)['messages'])
    assert count == 100, count
    assert total > 100, total
    assert ui.page.locator('#loadOlder').is_visible()
    ui.page.locator('#loadOlder').click()
    wait_for(lambda: ui.page.locator('#messageList .rm-message').count() == total, 'older message page', timeout=20)
    assert not ui.page.locator('#loadOlder').is_visible()
    ui.page.locator('#messageList').evaluate('(el) => el.scrollTop = 1200')
    ui.page.wait_for_timeout(400)
    ui.page.locator('#conversationAvatar').click()
    ui.page.locator('#profileView').wait_for(state='visible', timeout=12000)
    ui.page.locator('#profileBack').click()
    ui.page.wait_for_timeout(900)
    scroll = ui.page.locator('#messageList').evaluate('(el) => el.scrollTop')
    assert 1000 <= scroll <= 1500, scroll
    ui.page.locator('#messageInput').fill('P5 会话草稿：重挂后必须保留。')
    ui.page.wait_for_timeout(900)
    ui.remount()
    ui.page.wait_for_timeout(1200)
    if not ui.page.locator('#conversationView').is_visible():
        ui.nav('contacts')
        ui.page.locator('#contactsMessages').click()
        ui.page.locator(f'#conversationList [data-conversation-peer="{PEER_B}"]').click()
        ui.page.wait_for_timeout(800)
    assert ui.page.locator('#conversationName').inner_text() == 'chengye'
    assert ui.page.locator('#messageInput').input_value() == 'P5 会话草稿：重挂后必须保留。'
    ui.shot('p5-t08-chat-remount-wide')
    # Controlled retry: stop and restart the local daemon while the conversation
    # is open. The node is restarted explicitly; the plugin does not auto-spawn.
    stop = cli(['stop', '--data-dir', str(A_DIR)], timeout=20)
    assert stop.returncode == 0, stop.stderr or stop.stdout
    ui.page.wait_for_timeout(2200)
    retry_visible = ui.page.locator('#messageRetry').is_visible() or ui.page.locator('#messageStateRetry').is_visible()
    log = open(A_DIR / 'daemon.log', 'a')
    child = subprocess.Popen([str(BIN), 'daemon', '--data-dir', str(A_DIR)], cwd=REPO, stdout=log, stderr=log, start_new_session=True)
    log.close()
    wait_for(lambda: cli(['status', '--data-dir', str(A_DIR)]).returncode == 0, 'daemon restart', timeout=25)
    ui.page.wait_for_timeout(1000)
    if retry_visible:
        button = ui.page.locator('#messageRetry:visible')
        if button.count() == 0:
            button = ui.page.locator('#messageStateRetry:visible')
        if button.count():
            button.first.click()
    wait_for(lambda: ui.page.locator('#messageList .rm-message').count() >= 100, 'messages after retry', timeout=25)
    ui.viewport(390, 844)
    ui.shot('p5-t08-chat-narrow')
    ui.viewport(1440, 900)
    return {'initial': 100, 'older': total, 'restoredScroll': scroll, 'draft': 'P5 会话草稿：重挂后必须保留。', 'retryVisible': bool(retry_visible)}


def t10(ui):
    result = control('raminga_content_get', {'peer_id': PEER_B, 'path': FIXTURE['bProfilePath']})
    assert result.get('ok') is True, result
    ui.nav('explore')
    ui.page.locator('[data-filter="all"]').click()
    ui.page.wait_for_timeout(1200)
    card = ui.page.locator('#discoveryList .rm-post', has_text='雨停之后的城市植物').first
    card.wait_for(state='visible', timeout=15000)
    star = card.locator('.rm-post-favorite').first
    assert star.count() == 1
    star.click()
    ui.page.wait_for_timeout(1400)
    assert '已收藏' in star.inner_text()
    favorites = api('favorites', dataDir=str(A_DIR)).get('favorites', [])
    assert len(favorites) == 1 and favorites[0]['path'] == FIXTURE['bProfilePath'], favorites
    assert ui.page.locator('#messageList .rm-post-favorite').count() == 0
    assert ui.page.locator('#profileView .rm-post-favorite').count() == 0
    ui.settings('favorites')
    ui.wait_text('#settingsFavoritesList', r'雨停之后的城市植物', timeout=12000)
    ui.shot('p5-t10-favorites-wide')
    ui.remount()
    ui.settings('favorites')
    ui.wait_text('#settingsFavoritesList', r'雨停之后的城市植物', timeout=12000)
    # Invalidate the exact version: remove the local copy and the remote post.
    shutil.rmtree(A_DIR / 'downloads' / PEER_B / 'posts' / 'p5-b1', ignore_errors=True)
    (B_DIR / 'public' / 'posts' / 'p5-b1' / 'post.json').unlink()
    ui.settings('favorites')
    ui.page.wait_for_timeout(1800)
    text = ui.page.locator('#settings-favorites').inner_text()
    ui.shot('p5-t10-favorite-missing-wide')
    return {'favorite': favorites[0], 'missingText': text[-800:]}


def t11(ui):
    contacts_before = sha256_file(A_DIR / 'agent' / 'contact-notes.json')
    ui.settings('memory')
    ui.wait_text('#settingsMemoryList', r'chengye', timeout=12000)
    memory = ui.page.locator('#settings-memory').inner_text()
    assert '打开私有印象与时间线' in memory, memory[:1000]
    ui.shot('p5-t11-settings-memory-wide')
    ui.settings_home()
    ui.nav('contacts')
    ui.page.locator(f'#contactList [data-profile-peer="{PEER_B}"]').first.click()
    ui.page.locator('#profileView').wait_for(state='visible', timeout=12000)
    ui.wait_text('#profileName', r'澄野', timeout=20000)
    ui.wait_text('#profileImpressionSummary', r'只在私下记住', timeout=20000)
    ui.wait_text('#contactProfileInteractions', r'私有观察', timeout=20000)
    timeline = ui.page.locator('#contactProfileInteractions').inner_text()
    for must in ['私有印象', '只在私下记住', '我们的交互', '私有观察']:
        assert must in timeline, (must, timeline[:1200])
    ui.shot('p5-t11-contact-timeline-wide')
    public_hits = []
    for path in (A_DIR / 'public').rglob('*'):
        if path.is_file():
            text = path.read_text(errors='ignore')
            if '只在私下记住' in text or PRIVATE_MARKER in text or 'P5 未读二' in text:
                public_hits.append(str(path.relative_to(A_DIR)))
    for path in (B_DIR / 'public').rglob('*'):
        if path.is_file():
            text = path.read_text(errors='ignore')
            if '只在私下记住' in text or PRIVATE_MARKER in text:
                public_hits.append(str(path.relative_to(B_DIR)))
    assert not public_hits, public_hits
    published_a = api('published', dataDir=str(A_DIR))['files']
    published_b = api('published', dataDir=str(B_DIR))['files']
    assert not any('contact-notes' in row['path'] or 'agent/' in row['path'] for row in published_a + published_b)
    assert contacts_before == sha256_file(A_DIR / 'agent' / 'contact-notes.json')
    return {'memory': memory[:600], 'timeline': timeline[:600], 'publicHits': public_hits}


def t12(ui):
    journey_dir = A_DIR / 'agent' / 'sessions' / JOURNEY
    hold_journey = ROOT / 'journey-hold'
    hold_activity = ROOT / 'activity-hold'
    shutil.rmtree(hold_journey, ignore_errors=True)
    shutil.move(str(journey_dir), str(hold_journey))
    hold_activity.mkdir(exist_ok=True)
    for name in ['activity.jsonl', 'activity.1.jsonl']:
        src = A_DIR / 'agent' / name
        if src.exists():
            shutil.move(str(src), str(hold_activity / name))
    ui.nav('home')
    ui.page.locator('#ramingaRefresh').click()
    ui.page.wait_for_timeout(2500)
    empty = ui.text('#homeActivityEmpty')
    assert '没有' in empty or '记录' in empty, empty
    ui.shot('p5-t12-activity-empty-wide')
    shutil.move(str(hold_journey), str(journey_dir))
    ui.page.locator('#ramingaRefresh').click()
    ui.page.wait_for_timeout(1200)
    large = large_file()
    wait_for(lambda: any(entry['path'] == 'posts/p5-large.bin' for entry in api('manifest', dataDir=str(A_DIR), peerId=PEER_B, limit=100).get('entries', [])), 'large fixture in B manifest', timeout=30)
    pause_b()
    thread, box = async_control('raminga_content_get', {'peer_id': PEER_B, 'path': 'posts/p5-large.bin'})
    live = ui.wait_text('#homeActivityLive', r'正在访问|进行中', timeout=20000)
    op = [item for item in activity_ops() if item.get('result') is None][-1]
    ui.shot('p5-t12-live-wide')
    ui.close_panel()
    time.sleep(1.4)
    closed = [item for item in activity_ops() if item['operation_id'] == op['operation_id']][0]
    assert closed.get('result') is None, closed
    resume_b()
    thread.join(timeout=90)
    assert not thread.is_alive(), 'large content_get did not finish'
    finished = [item for item in activity_ops() if item['operation_id'] == op['operation_id']][0]
    assert finished.get('result') == 'ok', finished
    ui.open_panel()
    ui.page.wait_for_timeout(1200)
    recent = ui.wait_text('#homeActivityRecent', r'最近活动', timeout=15000)
    ui.shot('p5-t12-recent-wide')
    ui.viewport(390, 844)
    pause_b()
    thread2, box2 = async_control('raminga_content_get', {'peer_id': PEER_B, 'path': 'posts/p5-large.bin'})
    narrow_live = ui.wait_text('#homeActivityLive', r'正在访问|进行中', timeout=20000)
    ui.shot('p5-t12-live-narrow')
    ui.close_panel()
    time.sleep(1.2)
    resume_b()
    thread2.join(timeout=90)
    assert not thread2.is_alive()
    ui.open_panel()
    ui.page.wait_for_timeout(1000)
    ui.wait_text('#homeActivityRecent', r'最近活动', timeout=15000)
    ui.shot('p5-t12-recent-narrow')
    ui.viewport(1440, 900)
    return {'empty': empty[:300], 'live': live[:300], 'recent': recent[:300], 'narrowLive': narrow_live[:300], 'closedResult': closed.get('result'), 'finalResult': finished.get('result')}


def t13(ui):
    journey_dir = A_DIR / 'agent' / 'sessions' / JOURNEY
    ui.nav('home')
    ui.page.wait_for_timeout(800)
    result = control('raminga_content_get', {'peer_id': PEER_B, 'path': FIXTURE['bAgentPostPath']})
    assert result.get('ok') is True
    ui.page.wait_for_timeout(1600)
    ui.page.locator('#homeActivityToggle').click()
    ui.page.wait_for_timeout(1200)
    detail = ui.page.locator('#homeActivityDetail').inner_text()
    assert 'Journey 关联' in detail and JOURNEY in detail, detail[:1200]
    link = ui.page.locator('[data-activity-journey]').first
    assert link.count() == 1
    link.click()
    ui.page.wait_for_timeout(1400)
    assert ui.page.locator(f'[data-session-toggle="{JOURNEY}"]').count() >= 1
    ui.shot('p5-t13-journey-linked-wide')
    ui.nav('home')
    ui.page.wait_for_timeout(900)
    hold = ROOT / 'journey-hold-t13'
    shutil.rmtree(hold, ignore_errors=True)
    shutil.move(str(journey_dir), str(hold))
    ui.remount()
    ui.nav('home')
    ui.page.wait_for_timeout(1400)
    ui.page.locator('#homeActivityToggle').click()
    ui.page.wait_for_timeout(2000)
    missing = ui.page.locator('#homeActivityDetail').inner_text()
    assert '已不在本机' in missing, missing[:1200]
    ui.shot('p5-t13-journey-missing-wide')
    shutil.move(str(hold), str(journey_dir))
    state_path = journey_dir / 'state.json'
    state = json.loads(state_path.read_text())
    state['status'] = 'completed'
    state['completed_at'] = '2026-11-18T08:30:00Z'
    state['completion_reason'] = 'P5 验收：无关联回退联系人。'
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    result = control('raminga_peer_profile', {'peer_id': PEER_B})
    assert result.get('ok') is True
    ui.page.wait_for_timeout(1800)
    ui.remount()
    ui.nav('home')
    ui.page.wait_for_timeout(1400)
    ui.page.locator('#homeActivityToggle').click()
    ui.page.wait_for_timeout(1800)
    detail = ui.page.locator('#homeActivityDetail').inner_text()
    assert 'Journey 关联' not in detail or 'none' in detail, detail[:1200]
    peer = ui.page.locator('[data-activity-peer]').first
    assert peer.count() == 1
    peer.click()
    ui.page.wait_for_timeout(1200)
    assert ui.page.locator('#profileView').is_visible()
    assert '澄野' in ui.page.locator('#profileName').inner_text()
    ui.shot('p5-t13-fallback-contact-wide')
    return {'linked': True, 'missing': missing[:500], 'fallback': ui.page.locator('#profileName').inner_text()}



def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = context.new_page()
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.on('console', lambda message: CONSOLE_ERRORS.append(message.text) if message.type == 'error' else None)
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_timeout(2400)
        ui = UI(page)
        page.set_viewport_size({'width': 1440, 'height': 900})
        ui.wide = True
        ui.dismiss()
        ui.open_panel()

        steps = [
            ('T1', '三项导航、默认主页、唯一选中、无横向溢出、无 Agent tab', lambda: t1(ui)),
            ('T2', 'Agent 主视觉、人类条次之、真实活动与 Journey 同页', lambda: t2(ui)),
            ('T3', '私有人设/成长编辑、重挂保留、不写 public', lambda: t3(ui)),
            ('T4', '公开资料五字段+人类介绍、旧格式回退、B 读取 A', lambda: t4(ui)),
            ('T5', '本人/Agent 动态来源、旧 v1 帖子、图文', lambda: t5(ui)),
            ('T6', '发布失败、并发重试、清单摘要一致', lambda: t6(ui)),
            ('T7', '联系人最近消息/未读、联系人主页三 tab', lambda: t7(ui)),
            ('T9', 'Agent 读消息不清人类未读、人读归零', lambda: t9(ui)),
            ('T8', '会话草稿/分页/返回位置/重试', lambda: t8(ui)),
            ('T10', '仅动态收藏、无消息/联系人入口、重挂、版本失效', lambda: t10(ui)),
            ('T11', '私有印象/时间线、不进 friends.json', lambda: t11(ui)),
            ('T12', '真实活动运行中/最近/无记录、面板关闭不误判', lambda: t12(ui)),
            ('T13', '活动优先 Journey、缺失提示、无关联回联系人', lambda: t13(ui)),
        ]
        only = {item.strip() for item in os.environ.get('P5_ONLY', '').split(',') if item.strip()}
        for tid, name, facade in steps:
            if only and tid not in only:
                continue
            case(tid, name, facade)

        RESULTS['pageErrors'] = PAGE_ERRORS
        RESULTS['consoleErrors'] = [item for item in CONSOLE_ERRORS if '[raminga-ui]' not in item][:40]
        RESULTS['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save_results()
        browser.close()


if __name__ == '__main__':
    main()
