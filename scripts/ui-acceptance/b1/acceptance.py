#!/usr/bin/env python3
"""Real isolated DSH acceptance for first-batch B.

Prerequisites:
  node scripts/ui-acceptance/b1/prepare.mjs
  sh scripts/ui-acceptance/b1/start-host.sh > .local/prototype-remediation/b1/dsh-4362.log 2>&1 &
This driver only touches the B1 fixture ports/data. It pauses/resumes only the
fixture's node B and deletes only the fixture's b1-active Journey directory.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import shutil
import signal
import threading
import time
import traceback
import urllib.error
import urllib.request

ROOT = pathlib.Path(os.environ.get('B1_ACCEPTANCE_DIR', '.local/prototype-remediation/b1')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
HOST_PORT = os.environ.get('B1_HOST_PORT', str(FIXTURE.get('hostPort', 4362)))
URL = re.findall(r'https?://\S+', (ROOT / f'dsh-{HOST_PORT}.log').read_text())[-1]
B_PID = int((ROOT / 'node-b.pid').read_text().strip())
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'url': URL,
    'fixture': str(ROOT / 'fixture.json'),
    'cases': {},
    'screenshots': [],
    'pageErrors': [],
    'consoleErrors': [],
    'limits': {
        'journeyImages': 'The current Journey schema has no image field; the UI never invents a cover. No-image cards are verified; a real Journey image could not be produced.',
    },
}
RESULT_FILE = EVIDENCE / 'b1-results.json'


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
            'error': str(exc), 'trace': traceback.format_exc()[-4000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
        save()
        raise
    finally:
        save()


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


def post_tool(tool, args, timeout=130):
    request = urllib.request.Request(
        FIXTURE['controlUrl'],
        data=json.dumps({'tool': tool, 'args': args}).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode('utf-8')
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode('utf-8')


def stop_b():
    os.kill(B_PID, signal.SIGSTOP)


def cont_b():
    os.kill(B_PID, signal.SIGCONT)


def read_ops():
    log = ROOT / 'node-a' / 'agent' / 'activity.jsonl'
    if not log.exists():
        return []
    merged = {}
    for line in log.read_text().splitlines():
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


def write_active_journey():
    sdir = ROOT / 'node-a' / 'agent' / 'sessions' / 'b1-active'
    shutil.rmtree(sdir, ignore_errors=True)
    sdir.mkdir(parents=True, exist_ok=True)
    os.chmod(sdir, 0o700)
    state = {
        'schema_version': 1,
        'session_id': 'b1-active',
        'status': 'running',
        'mode': 'exploration',
        'intent': '沿着旧地图继续拜访验收 B',
        'limits': {
            'max_visits': 5, 'max_candidates_per_step': 8, 'max_chat_round_trips_per_peer': 3,
            'reply_timeout_seconds': 30, 'max_duration_seconds': 600,
        },
        'discovery_sources': ['local friends'],
        'current_peer_id': FIXTURE['nodeB'],
        'visited_peer_ids': [FIXTURE['nodeB']],
        'skipped_peer_ids': [],
        'curiosity': [],
        'started_at': '2026-11-18T10:00:00Z',
        'updated_at': '2026-11-18T10:01:00Z',
        'completed_at': None,
        'completion_reason': None,
    }
    (sdir / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2))
    events = [
        {'schema_version': 1, 'event_id': 'evt-b1-active-1', 'sequence': 1, 'timestamp': '2026-11-18T10:00:00Z', 'type': 'session_started', 'peer_id': None, 'source_peer_id': None, 'summary': '继续沿着旧地图拜访。', 'evidence_refs': {'message_ids': [], 'content_paths': [], 'event_ids': []}, 'message_evidence': None},
        {'schema_version': 1, 'event_id': 'evt-b1-active-2', 'sequence': 2, 'timestamp': '2026-11-18T10:00:05Z', 'type': 'visit_started', 'peer_id': FIXTURE['nodeB'], 'source_peer_id': None, 'summary': '开始读取验收 B 的公开内容。', 'evidence_refs': {'message_ids': [], 'content_paths': [], 'event_ids': []}, 'message_evidence': None},
        {'schema_version': 1, 'event_id': 'evt-b1-active-3', 'sequence': 3, 'timestamp': '2026-11-18T10:00:06Z', 'type': 'content_read', 'peer_id': FIXTURE['nodeB'], 'source_peer_id': None, 'summary': '读取 posts/b1-huge.bin 的公开内容。', 'evidence_refs': {'message_ids': [], 'content_paths': ['posts/b1-huge.bin'], 'event_ids': []}, 'message_evidence': None},
    ]
    (sdir / 'events.jsonl').write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in events) + '\n')
    os.chmod(sdir / 'state.json', 0o600)
    os.chmod(sdir / 'events.jsonl', 0o600)


def complete_active_journey():
    sdir = ROOT / 'node-a' / 'agent' / 'sessions' / 'b1-active'
    state_path = sdir / 'state.json'
    state = json.loads(state_path.read_text())
    state['status'] = 'completed'
    state['updated_at'] = '2026-11-18T10:03:00Z'
    state['completed_at'] = '2026-11-18T10:03:00Z'
    state['completion_reason'] = '真实工具读取完成'
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    os.chmod(state_path, 0o600)
    event = {
        'schema_version': 1, 'event_id': 'evt-b1-active-4', 'sequence': 4,
        'timestamp': '2026-11-18T10:03:00Z', 'type': 'session_completed',
        'peer_id': None, 'source_peer_id': None, 'summary': '这次公开内容读取完成。',
        'evidence_refs': {'message_ids': [], 'content_paths': [], 'event_ids': []},
        'message_evidence': None,
    }
    with (sdir / 'events.jsonl').open('a') as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + '\n')
    os.chmod(sdir / 'events.jsonl', 0o600)


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
            self.page.wait_for_timeout(260)

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

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(700)

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

    def content_text(self, selector):
        return self.page.locator(selector).evaluate('(node) => node.textContent || \'\'')

    def active_focus(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.getAttribute('data-focus-key') || node.getAttribute('id') || '') : '';
        }''')

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')

    def open_home_details(self):
        details = self.page.locator('#homeJourneyDetails')
        if details.get_attribute('open') is None:
            details.locator('summary').click()
            self.page.wait_for_timeout(200)

    def close_home_details(self):
        details = self.page.locator('#homeJourneyDetails')
        if details.get_attribute('open') is not None:
            details.locator('summary').click()
            self.page.wait_for_timeout(200)

    def refresh_journey(self):
        self.open_home_details()
        self.page.locator('#ramingaRefresh').click()
        self.page.wait_for_timeout(1400)
        self.close_home_details()

    def back_home(self):
        if self.page.locator('#page-journey').is_visible():
            self.page.locator('#journeyBack').click()
            self.page.wait_for_timeout(500)
        if self.page.locator('#page-journeys').is_visible():
            self.page.locator('#journeysBack').click()
            self.page.wait_for_timeout(500)


def visible(page, selector):
    loc = page.locator(selector)
    return loc.count() > 0 and loc.first.is_visible()


def main():
    PAGE_ERRORS = RESULTS['pageErrors']
    CONSOLE_ERRORS = RESULTS['consoleErrors']
    tool_box = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.on('console', lambda msg: CONSOLE_ERRORS.append(f'{msg.type}: {msg.text}') if msg.type == 'error' else None)
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_timeout(2600)
        ui = UI(page)
        ui.dismiss()
        ui.open_panel()

        def home_desktop():
            page.locator('#page-home').evaluate('(node) => { node.scrollTop = 0; }')
            page.wait_for_timeout(300)
            assert visible(page, '#page-home')
            assert visible(page, '#home-agent-hero')
            assert visible(page, '#home-human-strip')
            assert visible(page, '#home-activity')
            assert page.locator('#homeLiveJourney').count() == 0, 'no duplicate legacy live card in the template'
            assert page.locator('#homeActivityEmpty').is_visible()
            assert page.locator('#homeActivityLive').is_hidden()
            assert page.locator('#homeActivityRecent').is_hidden()
            empty_text = page.locator('#homeActivityEmpty').inner_text()
            assert len(empty_text) <= 110, empty_text
            assert page.locator('#homeJourneyDetails').get_attribute('open') is None
            assert page.locator('#homeActivityDisclosure').is_hidden(), 'read source note must be collapsed on success'
            assert page.locator('#ramingaRecordsStatus').is_hidden(), 'read time must be collapsed on success'
            tiles = page.locator('#ramingaSessionList .rm-journey-tile')
            assert tiles.count() >= 3
            first_box = tiles.first.bounding_box()
            assert first_box is not None and first_box['y'] < 900, f'recent start not in the 1440x900 first screen: {first_box}'
            assert page.locator('#ramingaSessionList img').count() == 0, 'no image is invented for a record without a cover'
            assert page.locator('#homeJourneysAll').is_visible()
            assert page.locator('#desktopNav').is_visible()
            assert page.locator('#mobileNav').is_hidden()
            ui.shot('b1-wide-home')
            return {'tiles': tiles.count(), 'firstTileY': round(first_box['y'], 1), 'empty': empty_text}

        case('B1-01', '1440x900 home: Agent, human strip, one short activity state, recent start in first screen', home_desktop)

        def narrow_home():
            ui.viewport(390, 844)
            ui.dismiss()
            ui.open_panel()
            page.locator('#page-home').evaluate('(node) => { node.scrollTop = 0; }')
            page.wait_for_timeout(400)
            assert ui.overflow() == 0, ui.overflow()
            assert page.locator('#mobileNav').is_visible()
            assert page.locator('#desktopNav').is_hidden()
            grid = page.locator('#ramingaSessionList')
            columns = grid.evaluate("node => getComputedStyle(node).gridTemplateColumns")
            assert columns.count(' ') == 0, columns
            page.locator('#home-journeys').scroll_into_view_if_needed()
            page.wait_for_timeout(500)
            ui.shot('b1-narrow-recent')
            activity = page.locator('#home-activity').bounding_box()
            first = page.locator('#ramingaSessionList .rm-journey-tile').first.bounding_box()
            assert activity and first
            assert first['y'] >= activity['y'] + activity['height'] - 1
            assert first['y'] - (activity['y'] + activity['height']) < 40, 'recent list is not immediately after the activity card'
            return {'columns': columns, 'gap': round(first['y'] - (activity['y'] + activity['height']), 1)}

        case('B1-02', '390x844 home: single-column recent list immediately after the activity area, no overflow', narrow_home)

        def all_records():
            ui.viewport(1440, 900)
            ui.open_panel()
            page.locator('#homeJourneysAll').click()
            page.wait_for_timeout(700)
            assert visible(page, '#page-journeys')
            assert ui.active_focus() == 'journeyQuery', ui.active_focus()
            total = page.locator('#journeyList .rm-journey-tile').count()
            assert total == 9, total
            ui.shot('b1-wide-journeys')

            page.locator('#journeyQuery').fill('旧地图')
            page.wait_for_timeout(500)
            filtered = page.locator('#journeyList .rm-journey-tile').count()
            assert 1 <= filtered < total, filtered
            assert page.locator('#journeysClear').is_visible()
            page.locator('#journeyQuery').fill('')
            page.wait_for_timeout(400)
            assert page.locator('#journeyList .rm-journey-tile').count() == total

            # Search also covers visited-object IDs and labels, not only titles.
            page.locator('#journeyQuery').fill(FIXTURE['nodeB'][-12:])
            page.wait_for_timeout(500)
            peer_filtered = page.locator('#journeyList .rm-journey-tile').count()
            assert peer_filtered == total - 1, peer_filtered  # only b1-old has no visited or current object
            assert page.locator('#journeyList [data-journey-open="b1-current"]').count() == 1, 'current-only candidate stays searchable'
            page.locator('#journeysClear').click()
            page.wait_for_timeout(500)

            page.locator('#page-journeys').evaluate('(node) => { node.scrollTop = 260; }')
            page.wait_for_timeout(250)
            page.locator('#journeyList [data-journey-open="b1-old"]').evaluate('(node) => node.click()')
            page.wait_for_timeout(800)
            assert visible(page, '#page-journey')
            assert 'b1-old' in ui.content_text('#journeyDetail .rm-journey-source')
            assert '10月1日 · 漫游' in ui.text('#journeyDetail h1')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(700)
            assert visible(page, '#page-journeys')
            assert page.locator('#journeyQuery').input_value() == ''
            scroll = page.locator('#page-journeys').evaluate('(node) => node.scrollTop')
            assert scroll >= 200, scroll
            focus = ui.active_focus()
            assert focus == 'journey-list:b1-old', focus
            return {'total': total, 'titleFilter': filtered, 'peerFilter': peer_filtered, 'restoredScroll': scroll, 'focus': focus}

        case('B1-03', 'All records: search by journey and visited object, clear, open older record and restore query/scroll/focus', all_records)

        def detail_main():
            page.locator('#journeyList [data-journey-open="b1-main"]').click()
            page.wait_for_timeout(800)
            assert visible(page, '#page-journey')
            assert page.locator('#journeyQuery').count() == 1
            summary = ui.text('#journeyDetail .rm-journey-summary')
            assert 'Agent 生成的报告内容，不是传输证据' in summary
            assert '拜访了验收 B' in summary
            body = ui.text('#journeyDetail')
            assert '实际路线' in body
            assert '关键事件' in body
            assert '消息证据' in body
            assert '来源与读取范围' in body
            assert page.locator('#journeyDetail .rm-journey-source').get_attribute('open') is None
            assert page.locator('#journeyDetail .rm-journey-report').get_attribute('open') is None
            head = ui.text('#journeyDetail .rm-journey-detail-head')
            assert '记录 b1-main' not in head, head
            assert 'state.json' not in head, head
            assert 'b1-main' in ui.content_text('#journeyDetail .rm-journey-source')
            route_text = page.locator('#journeyDetail .rm-journey-route').inner_text()
            assert 'state.json' not in route_text, route_text
            sections = page.locator('#journeyDetail').evaluate('''node => [...node.children].map(child => child.className)''')
            assert sections.index('rm-journey-summary') < sections.index('rm-journey-route')
            assert sections.index('rm-journey-route') < sections.index('rm-journey-events-section')
            assert sections.index('rm-journey-events-section') < sections.index('rm-journey-evidence-section')
            assert sections.index('rm-journey-evidence-section') < sections.index('rm-journey-source')
            ui.shot('b1-wide-detail-main')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)

            page.locator('#journeyList [data-journey-open="b1-long"]').click()
            page.wait_for_timeout(800)
            title = ui.text('#journeyDetail h1')
            assert '11月17日 · 漫游' in title, title
            assert '请先读取全部公开内容' not in title
            assert '请先读取全部公开内容' in ui.content_text('#journeyDetail .rm-journey-source')
            ui.shot('b1-wide-detail-long')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)

            page.locator('#journeyList [data-journey-open="b1-current"]').click()
            page.wait_for_timeout(800)
            route_line = page.locator('#journeyDetail .rm-journey-route-line')
            assert route_line.locator('[data-journey-route-peer]').count() == 0, 'current-only candidate must not be on the route'
            assert '记录中没有访问对象' in route_line.inner_text()
            aside = page.locator('#journeyDetail [data-journey-route-aside="current"]')
            assert aside.count() == 1, 'current-only candidate gets an independent label'
            assert '未记录为已访问' in aside.inner_text()
            assert '不计入路线' in aside.inner_text()
            assert aside.evaluate('(node) => node.closest(".rm-journey-route-line")') is None
            current_head = ui.text('#journeyDetail .rm-journey-detail-head')
            assert 'b1-current' not in current_head, current_head
            assert 'b1-current' in ui.content_text('#journeyDetail .rm-journey-source')
            ui.shot('b1-wide-detail-current')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)
            return {'sections': sections}

        case('B1-04', 'Independent detail: summary, actual route, key events, sources and evidence; long old instruction keeps a neutral title', detail_main)

        def message_roundtrip():
            page.locator('#journeyList [data-journey-open="b1-main"]').click()
            page.wait_for_timeout(800)
            page.locator('#journeyDetail [data-journey-locate-peer]').click()
            page.wait_for_timeout(1400)
            assert visible(page, '#page-messages')
            assert visible(page, '#conversationView')
            assert '返回漫游' in page.locator('#conversationBack').inner_text()
            assert page.locator(f'#messageList [data-message-id="{FIXTURE["messageId"]}"]').count() == 1
            assert '已在当前保留记录中找到' in page.locator('#messageFocusNote').inner_text()
            ui.shot('b1-wide-message-chat')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert visible(page, '#page-journey')
            assert '当前保留记录中存在这条消息' in ui.text('#journeyDetail .rm-journey-check')
            focus = ui.active_focus()
            assert focus == f'journey-evidence:b1-main:5:{FIXTURE["messageId"]}', focus
            ui.shot('b1-wide-message-return')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(500)
            return {'messageId': FIXTURE['messageId'], 'focus': focus}

        case('B1-05', 'Message evidence: locate the real retained message, open chat, return to the exact Journey evidence', message_roundtrip)

        def missing_message():
            page.locator('#journeyList [data-journey-open="b1-long"]').click()
            page.wait_for_timeout(700)
            page.locator('#journeyDetail [data-journey-locate-peer]').click()
            page.wait_for_timeout(900)
            text = ui.text('#journeyDetail')
            assert '已不在当前保留消息中' in text
            assert page.locator('#page-messages').is_hidden()
            assert page.locator('#page-journey').is_visible()
            assert '该消息引用已不在当前保留消息中' in text
            page.locator('#journeyBack').click()
            page.wait_for_timeout(500)
            return {'clearedMessage': FIXTURE['clearedMessageId']}

        case('B1-06', 'Cleared message evidence stays explicit and does not open a substitute conversation', missing_message)

        def live_to_recent():
            ui.back_home()
            write_active_journey()
            ui.refresh_journey()
            page.wait_for_timeout(500)
            # A saved running Journey is only a record until a real tool starts.
            live_record = page.locator('#homeActivityLive')
            if live_record.is_visible():
                assert 'Journey 进行中' in live_record.inner_text()
                assert '不是工具访问证据' in live_record.inner_text()
            stop_b()
            thread = threading.Thread(target=lambda: tool_box.update(dict(zip(('status', 'body'), post_tool(
                'raminga_content_get',
                {'peer_id': FIXTURE['nodeB'], 'path': FIXTURE['hugePath']},
            )))), daemon=True)
            thread.start()
            wait_for(lambda: live_record.is_visible() and '正在访问' in live_record.inner_text() and '进行中' in live_record.inner_text(),
                     'real running activity card', timeout=30)
            live_text = live_record.inner_text()
            assert page.locator('#homeActivityRecent').is_hidden()
            assert page.locator('#homeActivityEmpty').is_hidden()
            running = [op for op in read_ops() if op.get('state') == 'running']
            assert running and running[-1]['tool'] == 'raminga_content_get', running
            assert running[-1].get('journey_id') == 'b1-active', running[-1]
            page.locator('#page-home').evaluate('(node) => { node.scrollTop = 0; }')
            page.wait_for_timeout(300)
            ui.shot('b1-wide-live')
            cont_b()
            thread.join(timeout=90)
            assert not thread.is_alive(), 'real tool did not finish after node B resumed'
            assert tool_box.get('status') == 200, tool_box
            value = json.loads(tool_box.get('body') or '{}')
            assert value.get('ok') is True, value
            finished = [op for op in read_ops() if op['operation_id'] == running[-1]['operation_id']][0]
            assert finished.get('result') == 'ok', finished
            complete_active_journey()
            ui.refresh_journey()
            wait_for(lambda: page.locator('#homeActivityRecent').is_visible() and '最近活动' in page.locator('#homeActivityRecent').inner_text(),
                     'recent activity card', timeout=30)
            recent_text = page.locator('#homeActivityRecent').inner_text()
            assert '完成' in recent_text
            assert live_record.is_hidden()
            page.locator('#page-home').evaluate('(node) => { node.scrollTop = 0; }')
            page.wait_for_timeout(300)
            ui.shot('b1-wide-recent')
            return {'live': live_text, 'recent': recent_text, 'operationId': finished['operation_id'], 'sha256': FIXTURE['hugeSha']}

        case('B1-07', 'Real isolated tool: one activity card runs, then becomes one recent card without a Journey-only fake', live_to_recent)

        def activity_to_journey():
            # The same completed Journey is also a home recent-record tile.
            home_tile = page.locator('#ramingaSessionList [data-journey-open="b1-active"]')
            assert home_tile.count() == 1, 'completed activity Journey is missing from home recent records'
            home_tile.click()
            page.wait_for_timeout(900)
            head = ui.text('#journeyDetail .rm-journey-detail-head')
            assert 'b1-active' not in head, head
            assert 'b1-active' in ui.content_text('#journeyDetail .rm-journey-source')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)

            page.locator('#homeActivityRecent').click()
            page.wait_for_timeout(1200)
            assert visible(page, '#page-journey')
            detail = ui.text('#journeyDetail')
            assert 'b1-active' in ui.content_text('#journeyDetail .rm-journey-source')
            assert '已从本机工具活动定位' in detail
            highlighted = page.locator('#journeyDetail [data-journey-event="3"]')
            assert highlighted.count() == 1
            assert highlighted.get_attribute('data-highlight') == 'true'
            assert 'posts/b1-huge.bin' in detail
            ui.shot('b1-wide-activity-detail')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)

            # The same Journey is reachable from the all-records surface.
            page.locator('#homeJourneysAll').click()
            page.wait_for_timeout(700)
            page.locator('#journeyList [data-journey-open="b1-active"]').click()
            page.wait_for_timeout(900)
            assert 'b1-active' not in ui.text('#journeyDetail .rm-journey-detail-head')
            assert 'b1-active' in ui.content_text('#journeyDetail .rm-journey-source')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(500)
            page.locator('#journeysBack').click()
            page.wait_for_timeout(500)
            return {'highlight': 3}

        case('B1-08', 'Home record, all-records and activity entry reach the same Journey; the matching event is highlighted', activity_to_journey)

        def missing_journey():
            shutil.rmtree(ROOT / 'node-a' / 'agent' / 'sessions' / 'b1-active')
            ui.refresh_journey()
            page.wait_for_timeout(500)
            assert page.locator('#homeActivityRecent').is_visible()
            page.locator('#homeActivityRecent').click()
            page.wait_for_timeout(1000)
            text = ui.text('#journeyDetail')
            assert '漫游记录已不在本机' in text
            assert '关联的工具调用仍在 activity.jsonl 中' in text
            assert page.locator('#journeyDetail [data-journey-fallback-peer]').count() == 1
            assert page.locator('#journeyDetail [data-journey-fallback-chat]').count() == 1
            ui.shot('b1-wide-missing-journey')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(500)
            return {'fallback': 'peer/chat'}

        case('B1-09', 'A removed associated Journey shows the reason and keeps available peer/chat fallbacks', missing_journey)

        def narrow_detail():
            ui.viewport(390, 844)
            ui.open_panel()
            page.locator('#homeJourneysAll').click()
            page.wait_for_timeout(700)
            page.locator('#journeyList [data-journey-open="b1-main"]').click()
            page.wait_for_timeout(900)
            assert ui.overflow() == 0, ui.overflow()
            assert page.locator('#mobileNav').is_visible()
            assert visible(page, '#journeyDetail')
            ui.shot('b1-narrow-detail')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(600)
            page.locator('#journeyList [data-journey-open="b1-current"]').click()
            page.wait_for_timeout(800)
            assert ui.overflow() == 0, ui.overflow()
            assert page.locator('#journeyDetail [data-journey-route-aside="current"]').count() == 1
            ui.shot('b1-narrow-detail-current')
            return {'overflow': ui.overflow()}

        case('B1-10', '390x844 independent detail has no horizontal overflow and keeps the single mobile navigation', narrow_detail)

        RESULTS['pageErrors'] = PAGE_ERRORS
        RESULTS['consoleErrors'] = CONSOLE_ERRORS
        assert PAGE_ERRORS == [], PAGE_ERRORS
        save()
        browser.close()


if __name__ == '__main__':
    try:
        main()
    finally:
        try:
            cont_b()
        except Exception:
            pass
        save()
