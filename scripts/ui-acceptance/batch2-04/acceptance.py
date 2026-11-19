#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 4.

The fixture is created by prepare.mjs. This driver starts one isolated DSH Web
host (default 4382, control 4349), operates Chromium at 1440x900 and 390x844,
restarts the host once to prove persistence, and records screenshots, host logs
and a JSON result file. It only touches the batch2-04 fixture ports/data and
never the user's real DSH profile or ~/.raminga.
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

ROOT = pathlib.Path(os.environ.get('B4_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-04-interactions')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
HOST_PORT = int(os.environ.get('B4_HOST_PORT', FIXTURE.get('hostPort', 4382)))
CONTROL_PORT = int(os.environ.get('B4_CONTROL_PORT', FIXTURE.get('controlPort', 4349)))
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
PEER_B = FIXTURE['nodeB']
PEER_C = FIXTURE['nodeC']
PEER_E = FIXTURE['nodeE']
LONG_ID = FIXTURE['longMessageId']
EVIDENCE_ID = FIXTURE['evidenceMessageId']
SESSION_ID = FIXTURE['sessionId']
MARKER = f"{FIXTURE['markerPrefix']}{int(time.time())}-{os.urandom(3).hex()}"
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'marker': MARKER,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {},
    'screenshots': [],
    'hostLogs': [],
    'pageErrors': [],
    'consoleErrors': [],
    'privacy': {},
}
RESULT_FILE = EVIDENCE / 'b2-04-interactions-results.json'


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
            'error': str(exc), 'trace': traceback.format_exc()[-7000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
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


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_recorded_host():
    # Prune dead records only; never signal a recorded PID.
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


def start_host(log_name='host-b2-04-interactions.log'):
    stop_recorded_host()
    wait_port_free(HOST_PORT)
    log_path = EVIDENCE / log_name
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B4_DATA_DIR': FIXTURE['nodeAData'],
        'B4_DSH_HOME': FIXTURE['dshHome'],
        'B4_HOST_PORT': str(HOST_PORT),
        'B4_CONTROL_PORT': str(CONTROL_PORT),
        'B4_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(BIN),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 50
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


def content_json(args, data_dir):
    result = subprocess.run(
        [str(BIN), 'content', *args, '--data-dir', str(data_dir), '--json'],
        cwd=REPO, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(f'content {" ".join(args)} failed: {result.stderr or result.stdout}')
    return result.stdout


def hash_public(dir_path):
    root = pathlib.Path(dir_path) / 'public'
    files = {}
    if not root.exists():
        return files
    for file in sorted(root.rglob('*')):
        if file.is_file():
            files[str(file.relative_to(root))] = hashlib.sha256(file.read_bytes()).hexdigest()
    return files


def read_private(dir_path):
    return json.loads((pathlib.Path(dir_path) / 'agent' / 'contact-notes.json').read_text())


def node_status():
    return post_tool('raminga_status')['value']


def node_friends():
    return post_tool('raminga_friends')['value']


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
                self.page.wait_for_timeout(550)
        self.page.get_by_role('button', name='Raminga', exact=True).first.click()
        self.page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(800)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(550)
        self.open_panel()
        self.page.wait_for_timeout(250)

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(500)

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
        for _ in range(5):
            if self.page.locator('#conversationView').count() and self.page.locator('#conversationView').is_visible():
                self.page.locator('#conversationBack').click()
                self.page.wait_for_timeout(260)
                continue
            if self.page.locator('#profileView').count() and self.page.locator('#profileView').is_visible():
                self.page.locator('#profileBack').click()
                self.page.wait_for_timeout(260)
                continue
            if self.page.locator('#page-journey').count() and self.page.locator('#page-journey').is_visible():
                self.page.locator('#journeyBack').click()
                self.page.wait_for_timeout(260)
                continue
            break
        self.open_panel()
        self.nav('contacts')
        self.page.wait_for_timeout(300)

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

    def ensure_interactions(self):
        tab = self.page.locator('[data-profile-tab="interactions"]')
        if tab.count() and tab.get_attribute('aria-current') != 'page':
            tab.click()
            self.page.wait_for_timeout(400)

    def wait_memory(self, empty=False):
        if empty:
            self.page.locator('#profileTimelineEmpty').wait_for(state='visible', timeout=20000)
        else:
            target = '#profileMemorySummary' if self.wide else '#profileMemoryQuickbar'
            self.page.locator(target).wait_for(state='visible', timeout=20000)

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

    def profile_scroll(self):
        return self.page.locator('#profileView').evaluate('(el) => Math.max(0, Number(el.scrollTop) || 0)')

    def scroll_profile(self, value):
        return self.page.locator('#profileView').evaluate('(el, v) => { el.scrollTop = v; return el.scrollTop; }', value)


def memory_groups(page):
    return page.locator('#profileTimeline details[data-memory-group]')


def group_with(page, selector):
    return memory_groups(page).filter(has=page.locator(selector))


def ensure_group_open(page, group):
    if group.get_attribute('open') is None:
        group.locator('summary').first.click()
        page.wait_for_timeout(250)


def active_memory_item(page):
    return page.evaluate('''() => {
      let node = document.activeElement;
      while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
      return node?.closest?.('[data-memory-item-id]')?.dataset?.memoryItemId || '';
    }''')


def active_focus_key(page):
    return page.evaluate('''() => {
      let node = document.activeElement;
      while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
      return node?.dataset?.focusKey || node?.getAttribute?.('data-focus-key') || '';
    }''')


def main():
    host_process = None
    browser = None
    context = None
    page = None
    try:
        host_process, url = start_host()
        origin = re.match(r'(https?://[^/]+)', url).group(1)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            try:
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=origin)
            except Exception:  # noqa: BLE001 - limitation only
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

            def wide_first_screen():
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                assert profile.is_visible()
                card = page.locator('#profileImpressionCard')
                assert card.is_visible()
                assert '仅本机可见' in card.inner_text()
                assert page.locator('#profileImpressionEdit').is_visible()
                edit_box = ui.box('#profileImpressionEdit')
                assert edit_box['y'] + edit_box['height'] < 900, f'impression edit is below the first screen: {edit_box}'
                assert page.locator('#profileMemoryOverview').is_visible()
                summary = page.locator('#profileMemorySummary').inner_text()
                assert '历史摘要' in summary and '本轮读取到' in summary
                chips = page.locator('#profileMemoryKinds').inner_text()
                for must in ['消息', '实际访问', '读取内容', '报告', '公开线索', '私有记忆', '时间未记录']:
                    assert must in chips, (must, chips)
                assert '私有观察' not in chips or '私有记忆' in chips
                assert 'Journey' in page.locator('#profileMemorySource').inner_text()
                assert page.locator('#profileTimeline .rm-memory-day').count() == 2
                assert page.locator('#profileMemoryMore').is_visible()
                assert ui.overflow() <= 1, f'document overflow: {ui.overflow()}'
                assert ui.visual_overflow('#profileView') == 0
                geometry = {
                    'overview': ui.box('#profileMemoryOverview'),
                    'impression': ui.box('#profileImpressionCard'),
                    'edit': edit_box,
                    'tabs': ui.box('#profileTabsNav'),
                    'overflow': ui.overflow(),
                }
                ui.shot('b4-wide-first-1440')
                return {'summary': summary[:300], 'chips': chips.replace('\n', ' | '), 'geometry': geometry}

            case('B4-01', 'Wide first screen shows the honest history summary/source, a reachable private impression and collapsed day groups', wide_first_screen)

            def wide_grouped_history():
                assert page.locator('#profileMemoryMore').is_visible()
                page.locator('#profileMemoryMore').click()
                page.wait_for_timeout(500)
                assert page.locator('#profileTimeline .rm-memory-day').count() == 4, 'all three dates plus the unknown-date report should be revealed'
                headers = page.locator('#profileTimeline .rm-memory-day-head h3').all_inner_texts()
                assert any('日期未知' in value for value in headers), headers
                assert any('今天' in value for value in headers), headers
                assert any('昨天' in value for value in headers), headers
                long_group = group_with(page, f'[data-memory-message="{LONG_ID}"]')
                assert long_group.count() == 1
                assert long_group.get_attribute('open') is None, 'an older multi-message group must start collapsed'
                long_group.locator('summary').first.click()
                page.wait_for_timeout(300)
                assert long_group.get_attribute('open') is not None
                long_row = page.locator('#profileTimeline .rm-memory-event').filter(
                    has=page.locator(f'[data-memory-message="{LONG_ID}"]'))
                assert long_row.count() == 1
                preview = long_row.locator('.rm-memory-summary').inner_text()
                assert FIXTURE['longMessageText'][-20:] not in preview
                assert preview.endswith('…'), preview[-50:]
                details = long_row.locator('details.rm-memory-text')
                assert details.count() == 1
                assert details.get_attribute('open') is None
                details.locator('summary').click()
                page.wait_for_timeout(300)
                assert details.get_attribute('open') is not None
                body = details.locator('.rm-memory-body').inner_text()
                assert FIXTURE['longMessageText'] in body
                clue = page.locator('#profileTimeline .rm-memory-event[data-memory-source="publicClue"]')
                assert clue.count() == 1
                clue_group = group_with(page, '[data-memory-source="publicClue"]')
                assert clue_group.count() == 1
                ensure_group_open(page, clue_group.first)
                clue_text = clue.inner_text()
                assert '公开线索' in clue_text and '未自动访问或联系' in clue_text
                assert '已建立联系' not in clue_text
                report_group = group_with(page, '[data-memory-source="journeyReport"]')
                assert report_group.count() >= 1
                ensure_group_open(page, report_group.first)
                report = page.locator('#profileTimeline .rm-memory-event[data-memory-source="journeyReport"]')
                assert report.count() >= 1
                report_text = report.first.inner_text()
                assert '报告' in report_text
                long_row.scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b4-wide-timeline-expanded-1440')
                return {
                    'dayHeaders': headers,
                    'longPreview': preview[:180],
                    'longBody': body[:180],
                    'clue': clue_text[:260],
                    'report': report.first.inner_text()[:220],
                }

            case('B4-02', 'Wide history reveals older days, keeps multi-message groups collapsed, and expands the real long message and clue/report sources', wide_grouped_history)

            def wide_evidence_return():
                evidence_selector = f'.rm-memory-event[data-memory-kind="message"] [data-memory-message="{EVIDENCE_ID}"]'
                evidence = page.locator(evidence_selector).first
                assert evidence.count() == 1
                group = group_with(page, evidence_selector)
                ensure_group_open(page, group.first)
                evidence.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                target = evidence.evaluate("(el) => el.closest('[data-memory-item-id]').dataset.memoryItemId")
                return_key = evidence.get_attribute('data-focus-key')
                scroll_before = ui.profile_scroll()
                evidence.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert page.locator(f'#messageList [data-message-id="{EVIDENCE_ID}"]').count() == 1
                draft = 'B2-04-未发送草稿-保留'
                page.locator('#messageInput').fill(draft)
                page.wait_for_timeout(200)
                page.locator('#conversationBack').click()
                page.wait_for_timeout(600)
                assert page.locator('#profileView').is_visible()
                assert page.locator('[data-profile-tab="interactions"]').get_attribute('aria-current') == 'page'
                assert group.first.get_attribute('open') is not None, 'group expansion must survive the chat round trip'
                assert ui.profile_scroll() == scroll_before, (ui.profile_scroll(), scroll_before)
                assert active_focus_key(page) == return_key, (active_focus_key(page), return_key)
                assert active_memory_item(page) == target, (active_memory_item(page), target)
                # Reopen the exact evidence and prove the unsent draft is still there.
                page.locator(evidence_selector).first.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert page.locator('#messageInput').input_value() == draft
                page.locator('#conversationBack').click()
                page.wait_for_timeout(600)
                assert page.locator('#profileView').is_visible()
                assert active_memory_item(page) == target
                evidence.scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b4-wide-evidence-return-1440')
                return {'scroll': scroll_before, 'focus': return_key, 'target': target, 'draft': draft, 'messageId': EVIDENCE_ID}

            case('B4-03', 'A message evidence click inside a collapsed group locates the exact persisted message, then restores group, scroll, focus and draft', wide_evidence_return)

            def wide_journey_return():
                group = group_with(page, f'[data-memory-journey="{SESSION_ID}"]')
                assert group.count() >= 1
                ensure_group_open(page, group.first)
                journey_link = page.locator(f'[data-memory-journey="{SESSION_ID}"]').first
                assert journey_link.count() == 1
                journey_link.click()
                page.locator('#page-journey').wait_for(state='visible', timeout=10000)
                page.wait_for_timeout(700)
                detail = page.locator('#journeyDetail').inner_text()
                assert SESSION_ID in detail or 'Journey' in detail or '报告' in detail
                ui.shot('b4-wide-journey-evidence-1440')
                page.locator('#journeyBack').click()
                page.wait_for_timeout(600)
                assert page.locator('#page-home').is_visible(), 'existing Journey evidence return is home'
                # The chat draft from B4-03 must survive the Journey round trip.
                ui.nav('contacts')
                page.locator('[data-contact-row]').first.wait_for(state='visible', timeout=10000)
                page.locator(f'[data-contact-row="{PEER_B}"] button[data-chat-peer]').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=10000)
                assert page.locator('#messageInput').input_value() == 'B2-04-未发送草稿-保留'
                page.locator('#conversationBack').click()
                page.wait_for_timeout(400)
                return {'journeyDetail': detail[:300], 'draftAfterJourney': 'B2-04-未发送草稿-保留'}

            case('B4-04', 'Journey evidence keeps the existing return path and does not damage the retained chat draft', wide_journey_return)

            def empty_contact():
                profile = ui.open_profile(PEER_C, None)
                ui.ensure_interactions()
                ui.wait_memory(empty=True)
                assert page.locator('#profileTimeline').is_hidden()
                assert page.locator('#profileTimelineEmpty').is_visible()
                assert page.locator('#profileMemoryOverview').is_hidden()
                assert '还没有记录印象' in page.locator('#profileImpressionSummary').inner_text()
                assert page.locator('#profileImpressionEdit').is_visible()
                empty_text = page.locator('#profileTimelineEmpty').inner_text()
                assert '持久消息' in empty_text and 'Journey' in empty_text
                ui.shot('b4-wide-empty-contact-1440')
                return {'empty': empty_text[:260], 'impression': page.locator('#profileImpressionSummary').inner_text()}

            case('B4-05', 'A contact with no messages, Journey or private memory shows the honest empty state instead of synthesised history', empty_contact)

            def save_private_impression():
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                notes_path = pathlib.Path(FIXTURE['nodeAData']) / 'agent' / 'contact-notes.json'
                before_hash = hashlib.sha256(notes_path.read_bytes()).hexdigest()
                page.locator('#profileImpressionEdit').click()
                page.locator('#impressionDialog').wait_for(state='visible', timeout=5000)
                ui.shot('b4-wide-impression-edit-1440')
                page.locator('#impressionSummary').fill('')
                page.locator('#impressionSave').click()
                page.wait_for_timeout(300)
                assert '不能为空' in page.locator('#impressionDialogNote').inner_text()
                unchanged_hash = hashlib.sha256(notes_path.read_bytes()).hexdigest()
                assert unchanged_hash == before_hash, 'an invalid save must not rewrite contact-notes.json'
                page.locator('#impressionSummary').fill(f'{MARKER} · 只在本机可见的验收印象。')
                page.locator('#impressionSave').click()
                page.locator('#impressionDialog').wait_for(state='hidden', timeout=10000)
                page.wait_for_timeout(500)
                status = page.locator('#profileImpressionStatus').inner_text()
                assert '已保存' in status and '仅本机可见' in status
                notes = read_private(FIXTURE['nodeAData'])
                assert MARKER in json.dumps(notes, ensure_ascii=False)
                assert notes.get('unknown_top') == 'B2-04-KEEP-TOP'
                contact = next((item for item in notes.get('contacts', []) if item.get('peer_id') == PEER_B), None)
                assert contact is not None
                assert contact.get('unknown_contact') == 'B2-04-KEEP-CONTACT'
                assert contact['impressions'][0]['unknown_impression'] == 'B2-04-KEEP-IMP'
                assert MARKER in page.locator('#profileImpressionSummary').inner_text()
                ui.shot('b4-wide-impression-saved-1440')
                return {'receipt': status, 'beforeHash': before_hash, 'afterHash': unchanged_hash}

            case('B4-06', 'Private impression rejects an empty value, saves through the real UI, preserves unknown fields and reports the local-only receipt', save_private_impression)

            def privacy_check():
                data_a = pathlib.Path(FIXTURE['nodeAData'])
                data_b = pathlib.Path(FIXTURE['nodeBData'])
                marker_bytes = MARKER.encode('utf-8')
                notes_bytes = (data_a / 'agent' / 'contact-notes.json').read_bytes()
                assert marker_bytes in notes_bytes, 'private marker is not in agent/contact-notes.json'
                public_hits = []
                for file in sorted((data_a / 'public').rglob('*')):
                    if file.is_file() and marker_bytes in file.read_bytes():
                        public_hits.append(str(file))
                assert public_hits == [], public_hits
                after = hash_public(data_a)
                assert after == FIXTURE['publicFilesBefore'], (after, FIXTURE['publicFilesBefore'])
                friends_a = json.loads((data_a / 'public' / 'friends.json').read_text())['friends']
                note = next((item for item in friends_a if item.get('peer_id') == PEER_B), None)
                assert note is not None
                assert note.get('description') == FIXTURE['publicNote']['description'], note
                friends_b_bytes = (data_b / 'public' / 'friends.json').read_bytes()
                assert marker_bytes not in friends_b_bytes
                remote = {}
                for name, args in [
                    ('profile', ['profile', FIXTURE['nodeA']]),
                    ('friends', ['friends', FIXTURE['nodeA']]),
                    ('manifest', ['manifest', FIXTURE['nodeA']]),
                ]:
                    text = content_json(args, data_b)
                    assert MARKER not in text, f'{name} leaked the private marker'
                    remote[name] = len(text)
                published = content_json(['published'], data_a)
                assert MARKER not in published
                status = node_status()
                friend_ids = {item.get('peerId') or item.get('peer_id') for item in (node_friends().get('friends') or [])}
                assert PEER_B in friend_ids and PEER_C in friend_ids
                assert PEER_E not in friend_ids, 'a public clue became a local contact'
                peers = {item.get('peerId') or item.get('peer_id') for item in (status.get('peers') or [])}
                assert PEER_E not in peers, 'a public clue peer was dialed'
                public = {
                    'publicHitCount': len(public_hits),
                    'friendsDescription': note.get('description'),
                    'publicHashUnchanged': True,
                    'remoteReads': remote,
                    'friendCount': len(friend_ids),
                    'clueNotContact': PEER_E not in friend_ids,
                }
                RESULTS['privacy'] = public
                return public

            case('B4-07', 'The saved private marker stays out of public files, friends.json, the published manifest and the remote public reads; the existing public note is untouched', privacy_check)

            def reopen_same_contact():
                page.locator('#profileBack').click()
                page.wait_for_timeout(400)
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                assert MARKER in page.locator('#profileImpressionSummary').inner_text()
                ui.shot('b4-wide-same-contact-reopen-1440')
                return {'markerVisible': True}

            case('B4-08', 'Closing and reopening the same contact reads the saved impression back from the local file', reopen_same_contact)

            def narrow_first():
                ui.viewport(390, 844)
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                assert page.locator('#mobileNav').is_visible()
                assert page.locator('#desktopNav').is_hidden()
                assert page.locator('#profileMemoryQuickbar').is_visible()
                assert '历史摘要' in page.locator('#profileMemoryQuickSummary').inner_text()
                assert '消息' in page.locator('#profileMemoryQuickSource').inner_text() and '私有' in page.locator('#profileMemoryQuickSource').inner_text()
                assert MARKER in page.locator('#profileImpressionQuickText').inner_text()
                edit = ui.box('#profileImpressionQuickEdit')
                nav = ui.box('#mobileNav')
                assert edit['y'] + edit['height'] <= nav['y'], (edit, nav)
                assert ui.overflow() <= 1, f'narrow overflow: {ui.overflow()}'
                assert ui.visual_overflow('#profileView') == 0
                ui.shot('b4-narrow-first-390')
                return {'edit': edit, 'nav': nav, 'overflow': ui.overflow(), 'quickSummary': page.locator('#profileMemoryQuickSummary').inner_text()}

            case('B4-09', '390x844 first screen keeps the summary and private edit reachable above the single bottom nav without horizontal overflow', narrow_first)

            def narrow_history_and_return():
                page.locator('#profileMemoryMore').click()
                page.wait_for_timeout(400)
                long_group = group_with(page, f'[data-memory-message="{LONG_ID}"]')
                ensure_group_open(page, long_group.first)
                long_row = page.locator('#profileTimeline .rm-memory-event').filter(
                    has=page.locator(f'[data-memory-message="{LONG_ID}"]'))
                details = long_row.locator('details.rm-memory-text')
                if details.get_attribute('open') is None:
                    details.locator('summary').click()
                    page.wait_for_timeout(250)
                assert FIXTURE['longMessageText'] in details.locator('.rm-memory-body').inner_text()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#profileView') == 0
                ui.shot('b4-narrow-timeline-expanded-390')
                evidence_selector = f'.rm-memory-event[data-memory-kind="message"] [data-memory-message="{EVIDENCE_ID}"]'
                evidence = page.locator(evidence_selector).first
                ensure_group_open(page, group_with(page, evidence_selector).first)
                evidence.scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                target = evidence.evaluate("(el) => el.closest('[data-memory-item-id]').dataset.memoryItemId")
                return_key = evidence.get_attribute('data-focus-key')
                scroll_before = ui.profile_scroll()
                evidence.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert page.locator(f'#messageList [data-message-id="{EVIDENCE_ID}"]').count() == 1
                page.locator('#conversationBack').click()
                page.wait_for_timeout(600)
                assert page.locator('#profileView').is_visible()
                assert group_with(page, evidence_selector).first.get_attribute('open') is not None
                assert ui.profile_scroll() == scroll_before, (ui.profile_scroll(), scroll_before)
                assert active_focus_key(page) == return_key, (active_focus_key(page), return_key)
                assert active_memory_item(page) == target, (active_memory_item(page), target)
                # Keyboard focus ring on the evidence button.
                evidence.focus()
                page.keyboard.press('Shift+Tab')
                page.keyboard.press('Tab')
                outline = evidence.evaluate('''(el) => {
                  const style = getComputedStyle(el);
                  return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
                }''')
                assert outline['style'] != 'none' and outline['width'] != '0px', outline
                evidence.scroll_into_view_if_needed()
                page.wait_for_timeout(250)
                ui.shot('b4-narrow-evidence-return-390')
                page.locator('#profileImpressionEdit').scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                edit = ui.box('#profileImpressionEdit')
                nav = ui.box('#mobileNav')
                assert edit['y'] + edit['height'] <= nav['y'], (edit, nav)
                return {'scroll': scroll_before, 'focus': return_key, 'target': target, 'outline': outline, 'edit': edit, 'nav': nav}

            case('B4-10', '390x844 expands the real long text, restores the exact evidence group, scroll and focus, and keeps the edit action above the bottom nav', narrow_history_and_return)

            def narrow_edit_dialog():
                page.locator('#profileImpressionQuickEdit').click()
                page.locator('#impressionDialog').wait_for(state='visible', timeout=5000)
                assert MARKER in page.locator('#impressionSummary').input_value()
                assert ui.overflow() <= 1
                ui.shot('b4-narrow-impression-edit-390')
                page.locator('#impressionDialog [data-close-dialog]').last.click()
                page.wait_for_timeout(300)
                assert page.locator('#impressionDialog').is_hidden()
                return {'dialogValue': MARKER}

            case('B4-11', '390x844 opens the private impression editor with the saved local text and no horizontal overflow', narrow_edit_dialog)

            host_process, url = stop_host_and_restart(host_process, page, context)
            # Reopen a fresh page against the restarted host.
            page.close()
            page = context.new_page()
            page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
            page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
                    if message.type == 'error' else None)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_timeout(1600)
            ui = UI(page)
            ui.dismiss_onboarding()
            ui.viewport(1440, 900)

            def after_restart_wide():
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                assert MARKER in page.locator('#profileImpressionSummary').inner_text()
                assert page.locator('#profileImpressionStatus').is_hidden()
                assert ui.overflow() <= 1
                ui.shot('b4-wide-after-restart-1440')
                # Re-run the strict public boundary after the host restart too.
                notes = read_private(FIXTURE['nodeAData'])
                assert MARKER in json.dumps(notes, ensure_ascii=False)
                for file in sorted((pathlib.Path(FIXTURE['nodeAData']) / 'public').rglob('*')):
                    if file.is_file():
                        assert MARKER.encode() not in file.read_bytes(), file
                remote_profile = content_json(['profile', FIXTURE['nodeA']], FIXTURE['nodeBData'])
                remote_friends = content_json(['friends', FIXTURE['nodeA']], FIXTURE['nodeBData'])
                remote_manifest = content_json(['manifest', FIXTURE['nodeA']], FIXTURE['nodeBData'])
                for text in (remote_profile, remote_friends, remote_manifest):
                    assert MARKER not in text
                return {'markerVisible': True, 'publicClean': True}

            case('B4-12', 'After a real DSH host restart the private impression is still read locally and remains absent from every public read', after_restart_wide)

            def narrow_after_restart():
                ui.viewport(390, 844)
                ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                ui.wait_memory()
                assert MARKER in page.locator('#profileImpressionQuickText').inner_text()
                assert page.locator('#profileImpressionQuickEdit').is_visible()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#profileView') == 0
                ui.shot('b4-narrow-after-restart-390')
                return {'markerVisible': True, 'overflow': ui.overflow()}

            case('B4-13', '390x844 after the host restart still shows the saved local impression and has no horizontal overflow', narrow_after_restart)

            def first_batch_regression():
                # Item 3 three tabs and first-batch C profile/chat round trips.
                ui.viewport(1440, 900)
                profile = ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                ui.ensure_interactions()
                results = {}
                for tab in ['posts', 'address', 'interactions']:
                    page.locator(f'[data-profile-tab="{tab}"]').click()
                    page.wait_for_timeout(700)
                    assert page.locator(f'[data-profile-tab="{tab}"]').get_attribute('aria-current') == 'page'
                    page.locator('#profileMessage').click()
                    page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                    assert page.locator('#conversationBack').inner_text().startswith('← 返回联系人档案')
                    page.locator('#conversationBack').click()
                    page.wait_for_timeout(600)
                    assert page.locator('#profileView').is_visible()
                    assert page.locator(f'[data-profile-tab="{tab}"]').get_attribute('aria-current') == 'page'
                    results[tab] = True
                page.locator('#profileBack').click()
                page.wait_for_timeout(400)
                assert page.locator('#page-contacts').is_visible()
                row_chat = page.locator(f'[data-contact-row="{PEER_B}"] button[data-chat-peer]')
                assert row_chat.count() == 1
                row_chat.click()
                page.locator('#conversationView').wait_for(state='visible', timeout=10000)
                page.locator('#conversationBack').click()
                page.wait_for_timeout(500)
                assert page.locator('#page-contacts').is_visible()
                assert ui.nav_current() == ['contacts']
                return {'tabs': results, 'contactListReturn': True, 'nav': ui.nav_current()}

            case('B4-14', 'First-batch C and item-3 regression: the three profile tabs, profile chat returns and contact-list inline chat still work', first_batch_regression)

            def duplicate_evidence_identity():
                # The real fixture cites one persisted inbound message from the
                # chat row, Journey e4 (message_received) and Journey e7
                # (visit_completed). Each evidence button must return to the row
                # it was clicked in, even though all three share a message id.
                draft = 'B2-04-重复引用草稿-保留'
                results = {}
                for width, height in ((1440, 900), (390, 844)):
                    label = 'wide' if width >= 700 else 'narrow'
                    ui.viewport(width, height)
                    ui.open_profile(PEER_B, FIXTURE['publicB']['displayName'])
                    ui.ensure_interactions()
                    ui.wait_memory()
                    for _ in range(4):
                        more = page.locator('#profileMemoryMore')
                        if not more.is_visible():
                            break
                        more.click()
                        page.wait_for_timeout(350)

                    message_selector = f'[data-memory-item-id="message:{EVIDENCE_ID}"] [data-memory-message="{EVIDENCE_ID}"]'
                    e4_selector = f'[data-memory-item-id="journey:{SESSION_ID}:4"] [data-memory-message="{EVIDENCE_ID}"]'
                    e7_selector = f'[data-memory-item-id="journey:{SESSION_ID}:7"] [data-memory-message="{EVIDENCE_ID}"]'
                    message_button = page.locator(f'#profileTimeline {message_selector}').first
                    e4_button = page.locator(f'#profileTimeline {e4_selector}').first
                    e7_button = page.locator(f'#profileTimeline {e7_selector}').first
                    assert message_button.count() == 1, 'the real message row must cite the same message'
                    assert e4_button.count() == 1, 'Journey e4 must cite the same message'
                    assert e7_button.count() == 1, 'Journey e7 must cite the same message'
                    assert e4_button.get_attribute('data-focus-key') != e7_button.get_attribute('data-focus-key')
                    assert e4_button.get_attribute('data-focus-key') != message_button.get_attribute('data-focus-key')

                    message_group = group_with(page, message_selector).first
                    if message_group.get_attribute('open') is not None:
                        message_group.locator('summary').first.click()
                        page.wait_for_timeout(250)
                    e4_group = group_with(page, e4_selector).first
                    ensure_group_open(page, e4_group)
                    e4_button.scroll_into_view_if_needed()
                    page.wait_for_timeout(250)
                    target = e4_button.evaluate("(el) => el.closest('[data-memory-item-id]').dataset.memoryItemId")
                    assert target == f'journey:{SESSION_ID}:4', target
                    return_key = e4_button.get_attribute('data-focus-key')
                    scroll_before = ui.profile_scroll()
                    ui.shot(f'b4-{label}-duplicate-evidence-before-{width}')

                    e4_button.click()
                    page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                    assert page.locator(f'#messageList [data-message-id="{EVIDENCE_ID}"]').count() == 1
                    page.locator('#messageInput').fill(draft)
                    page.wait_for_timeout(200)
                    page.locator('#conversationBack').click()
                    page.wait_for_timeout(650)
                    assert page.locator('#profileView').is_visible()
                    assert page.locator('[data-profile-tab="interactions"]').get_attribute('aria-current') == 'page'
                    assert e4_group.get_attribute('open') is not None
                    assert message_group.get_attribute('open') is None, 'a different group citing the same message must stay closed'
                    assert ui.profile_scroll() == scroll_before, (ui.profile_scroll(), scroll_before)
                    assert active_focus_key(page) == return_key, (active_focus_key(page), return_key)
                    assert active_memory_item(page) == target, (active_memory_item(page), target)
                    assert active_memory_item(page) != f'journey:{SESSION_ID}:7'
                    ui.shot(f'b4-{label}-duplicate-evidence-return-{width}')

                    # The exact evidence can be reopened and the draft survives.
                    e4_button.click()
                    page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                    assert page.locator('#messageInput').input_value() == draft
                    page.locator('#conversationBack').click()
                    page.wait_for_timeout(650)
                    assert active_memory_item(page) == target
                    results[label] = {
                        'width': width,
                        'target': target,
                        'focus': return_key,
                        'scroll': scroll_before,
                        'draft': draft,
                        'messageRowStillClosed': message_group.get_attribute('open') is None,
                    }
                return results

            case('B4-15', 'One persisted message cited by the chat row, Journey e4 and Journey e7 returns to the exact clicked citation at 1440x900 and 390x844', duplicate_evidence_identity)

            save()
    finally:
        if host_process is not None:
            stop_host(host_process)
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass
        # Stop only this fixture's nodes. A rerun starts with prepare.mjs.
        cleanup = subprocess.run(
            ['node', str(pathlib.Path(__file__).with_name('cleanup.mjs'))],
            cwd=REPO, capture_output=True, text=True, timeout=30,
        )
        RESULTS['fixtureCleanup'] = {
            'status': cleanup.returncode,
            'stdout': cleanup.stdout[-3000:],
            'stderr': cleanup.stderr[-1000:],
        }
        RESULTS['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save()
        print(f'RESULT {RESULTS["status"]} -> {RESULT_FILE}', flush=True)


def stop_host_and_restart(host_process, old_page, context):
    global FIXTURE
    stop_host(host_process)
    # The fixture daemon must survive a DSH host restart.
    status = subprocess.run([str(BIN), 'status', '--json', '--data-dir', FIXTURE['nodeAData']],
                            cwd=REPO, capture_output=True, text=True, timeout=30)
    if status.returncode != 0:
        raise AssertionError(f'fixture node A did not survive the host shutdown: {status.stderr or status.stdout}')
    process, url = start_host('host-b2-04-interactions-restart.log')
    RESULTS['restartUrl'] = url
    save()
    return process, url


if __name__ == '__main__':
    main()
