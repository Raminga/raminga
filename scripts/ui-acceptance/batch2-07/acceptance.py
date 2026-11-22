#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 7 (chat composition).

Starts only the 4398 host and 4363 test control endpoint under
.local/prototype-remediation/b2-07-chat, operates the real Chromium Web UI at
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

ROOT = pathlib.Path(os.environ.get('B7_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-07-chat')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
SEND_FROM_B = REPO / 'scripts' / 'ui-acceptance' / 'c1' / 'send-from-b.mjs'
HOST_PORT = int(os.environ.get('B7_HOST_PORT', FIXTURE.get('hostPort', 4398)))
CONTROL_PORT = int(os.environ.get('B7_CONTROL_PORT', FIXTURE.get('controlPort', 4363)))
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
DIR_A = FIXTURE['nodeAData']
DIR_B = FIXTURE['nodeBData']
DSH_HOME = FIXTURE['dshHome']
LEGACY_ID = FIXTURE['legacyMessageId']
LONG_IDS = FIXTURE['longInboundIds']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'controlPort': CONTROL_PORT,
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-07-chat-results.json'
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
    log_path = EVIDENCE / 'host-b2-07.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B7_DATA_DIR': DIR_A,
        'B7_DSH_HOME': DSH_HOME,
        'B7_HOST_PORT': str(HOST_PORT),
        'B7_CONTROL_PORT': str(CONTROL_PORT),
        'B7_PIDFILE': str(pid_path),
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
            ui.nav('contacts')
            page.wait_for_timeout(900)

            def wide_identity_sources():
                agent_text = f'B7 Agent 工具真实消息 {int(time.time())}'
                status, tool = post_tool('raminga_chat_send', {'peer_id': PEER_B, 'text': agent_text})
                assert status == 200 and tool.get('ok') is True, tool
                message_id = tool['value'].get('messageId')
                assert message_id, tool
                persisted = message_origin(message_id)
                assert persisted['origin'] == 'agent', persisted
                ui.open_chat()
                wait_text(page, '#messageList', agent_text, 20000)
                # First enter through 查看档案 so the real remote name/avatar is
                # fetched; the header must then prefer it over the local alias.
                ui.open_profile_from_chat()
                assert page.locator('#profileName').inner_text() == '潮汐线旁的林岸'
                assert page.locator('#profileAvatar img').count() == 1
                ui.back_from_profile()
                wait_for(lambda: page.locator('#conversationName').inner_text() == '潮汐线旁的林岸',
                         'verified chat header name', 15)
                assert page.locator('#conversationAvatar img').count() == 1, 'avatar did not update after profile read'
                assert page.locator('#conversationProfile').is_visible()
                assert page.locator('#conversationProfile').inner_text() == '查看档案'
                assert page.locator('#conversationMeta').evaluate('(el) => el.open') is False
                assert page.locator('#conversationPeerId').text_content() == PEER_B
                assert PEER_B not in page.locator('.rm-conversation-head').inner_text()
                assert '入口来源：联系人列表' in page.locator('#conversationOrigin').text_content()
                local_note = page.locator('#conversationLocalNote').text_content()
                assert 'lin-an' in local_note, local_note
                labels = page.locator('#messageList .rm-message-origin').all_inner_texts()
                assert '对方' in labels and '本人' in labels and 'Agent' in labels and '来源未知' in labels, labels
                assert page.locator(f'#messageList .rm-message[data-message-id="{LEGACY_ID}"] .rm-message-origin').inner_text() == '来源未知'
                assert page.locator(f'#messageList .rm-message[data-message-id="{message_id}"] .rm-message-origin').inner_text() == 'Agent'
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#conversationView') == 0
                long_metrics = page.locator('#messageList .rm-message-bubble').evaluate_all('''els => els
                  .filter((el) => el.textContent.length > 100)
                  .map((el) => ({length: el.textContent.length, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth}))''')
                assert long_metrics and all(item['scrollWidth'] <= item['clientWidth'] + 1 for item in long_metrics), long_metrics
                metrics = ui.chat_metrics()
                assert metrics['header']['height'] <= 90, metrics['header']
                assert metrics['list']['height'] >= 300, metrics
                assert metrics['input']['height'] >= 40, metrics
                assert metrics['last']['bottom'] <= metrics['shell']['top'] + 1, metrics
                assert page.locator('#composer select').count() == 0
                assert page.locator('#composer input[type="file"]').count() == 0
                ui.shot('b7-01-wide-chat-sources-1440')
                return {
                    'agentMessageId': message_id,
                    'agentText': agent_text,
                    'sourceLabels': sorted(set(labels)),
                    'headerHeight': round(metrics['header']['height'], 1),
                    'listHeight': round(metrics['list']['height'], 1),
                    'peerIdInHeader': PEER_B in page.locator('.rm-conversation-head').inner_text(),
                }

            case('B7-01', '1440 会话顶栏优先真实名称/头像，来源标签按真实记录显示，长文本不横溢', wide_identity_sources)

            def wide_manual_send():
                text = ('B7 手动输入长消息：风从窗口底部进来，我把今天的事写在同一行里。'
                        + 'RamingaWindowBottom' * 18)
                counter = page.locator('#messageCounter')
                assert counter.is_hidden(), 'empty composer should not show a byte counter'
                page.locator('#messageInput').fill(text)
                assert counter.is_visible(), 'typed input should show its capacity'
                assert '/ 4096 字节' in counter.inner_text()
                before = page.locator('#messageList .rm-message-origin').count()
                page.locator('#messageSend').click()
                wait_for(lambda: page.locator('#messageList .rm-message-origin').count() > before, 'manual message row', 20)
                wait_text(page, '#composerStatus', '协议已接收', 20000)
                assert counter.is_hidden(), 'submitted composer returns to the quiet state'
                wait_for(lambda: any(text in row.inner_text() for row in page.locator('#messageList .rm-message').all()), 'sent text in list', 10)
                row = page.locator('#messageList .rm-message', has_text=text[:40]).last
                assert row.locator('.rm-message-origin').inner_text() == '本人'
                metrics = row.locator('.rm-message-bubble').evaluate('(el) => ({sw: el.scrollWidth, cw: el.clientWidth, h: el.clientHeight})')
                assert metrics['sw'] <= metrics['cw'] + 1, metrics
                assert metrics['h'] > 24, metrics
                persisted = wait_for(lambda: (lambda value: value if value['origin'] == 'human' else None)(
                    message_origin_by_text(text)), 'human origin persisted', 20)
                assert persisted['deliveryStatus'] in ('pending', 'acked'), persisted
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#conversationView') == 0
                ui.shot('b7-02-wide-manual-send-1440')
                return {'textLength': len(text), 'persisted': persisted}

            def message_origin_by_text(text):
                db = sqlite3.connect(f'file:{DIR_A}/raminga.db?mode=ro', uri=True)
                try:
                    row = db.execute(
                        'SELECT origin, delivery_status, direction FROM messages WHERE peer_id = ? AND text = ? ORDER BY created_at_ms DESC LIMIT 1',
                        (PEER_B, text),
                    ).fetchone()
                    return {'origin': row[0] if row else '', 'deliveryStatus': row[1] if row else '',
                            'direction': row[2] if row else ''}
                finally:
                    db.close()

            case('B7-02', '人工输入发送保留普通字符、容量提示适时出现并可理解，长文本可换行', wide_manual_send)

            def wide_history_resize_jump():
                top = ui.scroll_history(0.30)
                page.wait_for_timeout(300)
                metrics = ui.chat_metrics()
                assert top > 0 and not metrics['atBottom'], metrics
                assert metrics['jumpHidden'] is False, 'history view must expose the explicit latest action'
                before = page.locator('#messageList .rm-message', has_text='第 1 封回信').first
                assert before.count() >= 1
                ui.shot('b7-03-wide-history-1440')
                # A new real event arrives while the reader is in history. The
                # list must keep the reading position, not jump to the bottom.
                send_unread(1)
                page.wait_for_timeout(900)
                after = ui.chat_metrics()
                assert after['atBottom'] is False, after
                assert abs(after['scrollTop'] - top) <= 2, (top, after['scrollTop'])
                assert after['jumpHidden'] is False
                # Width changes must not pull the reader either.
                ui.viewport(390, 844)
                narrow = ui.chat_metrics()
                assert narrow['atBottom'] is False, narrow
                assert narrow['jumpHidden'] is False
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#conversationView') == 0
                assert narrow['input']['bottom'] <= narrow['nav']['top'] + 1, narrow
                ui.shot('b7-03-narrow-history-390')
                ui.viewport(1440, 900)
                wide = ui.chat_metrics()
                assert wide['atBottom'] is False, 'returning to wide must not restore the bottom for a history reader'
                # Return explicitly and make sure the last message sits above
                # the composer, not under it.
                ui.viewport(390, 844)
                page.locator('#messageJumpLatest').click()
                page.wait_for_timeout(500)
                latest = ui.chat_metrics()
                assert latest['atBottom'] is True, latest
                assert latest['jumpHidden'] is True
                assert ui.active_id() == 'messageInput', ui.active_id()
                assert latest['last']['bottom'] <= latest['shell']['top'] + 1, latest
                assert latest['input']['bottom'] <= latest['nav']['top'] + 1, latest
                assert ui.overflow() <= 1
                ui.shot('b7-03-narrow-latest-390')
                ui.viewport(1440, 900)
                wide_latest = ui.chat_metrics()
                assert wide_latest['atBottom'] is True
                ui.shot('b7-03-wide-latest-1440')
                return {'historyTop': round(top, 1), 'narrowTop': round(narrow['scrollTop'], 1),
                        'latestTop': round(latest['scrollTop'], 1)}

            case('B7-03', '向上读历史时新事件与宽窄变化都不拉回底部，明确的回到最新可用', wide_history_resize_jump)

            def roundtrip_profile_settings():
                top = ui.scroll_history(0.18)
                page.wait_for_timeout(250)
                page.locator('#messageInput').fill('顶栏往返草稿')
                page.locator('#messageInput').dispatch_event('input')
                back_label = page.locator('#conversationBack').inner_text()
                ui.open_profile_from_chat()
                assert page.locator('#profileName').inner_text() == '潮汐线旁的林岸'
                ui.back_from_profile()
                assert page.locator('#messageInput').input_value() == '顶栏往返草稿'
                assert abs(page.locator('#messageList').evaluate('(n) => n.scrollTop') - top) <= 2
                assert ui.active_id() == 'conversationProfile', ui.active_id()
                assert page.locator('#conversationBack').inner_text() == back_label
                page.locator('#settingsTrigger').click()
                page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(400)
                page.locator('#settingsClose').click()
                page.wait_for_timeout(600)
                assert page.locator('#conversationView').is_visible()
                assert page.locator('#messageInput').input_value() == '顶栏往返草稿'
                assert abs(page.locator('#messageList').evaluate('(n) => n.scrollTop') - top) <= 2
                assert ui.active_id() == 'messageInput', ui.active_id()
                assert ui.nav_current() == ['contacts'], ui.nav_current()
                ui.shot('b7-04-wide-settings-return-1440')
                page.locator('#conversationBack').click()
                page.wait_for_timeout(700)
                assert page.locator('#contactList').is_visible()
                assert ui.active_focus() == f'contact-chat:{PEER_B}', ui.active_focus()
                return {'chatScroll': round(top, 1), 'draft': '顶栏往返草稿'}

            case('B7-04', '聊天与档案/设置往返保留草稿、历史锚点、来源焦点和联系人分区', roundtrip_profile_settings)

            def c_sources_regression():
                # Conversation index route.
                page.locator('#contactsMessages').click()
                page.locator('#conversationView').wait_for(state='hidden', timeout=15000)
                wait_for(lambda: page.locator('#conversationList button[data-conversation-peer]').count() > 0, 'conversation rows', 15)
                page.locator('#conversationQuery').fill('lin')
                page.wait_for_timeout(400)
                page.locator('#page-messages').evaluate('(n) => { n.scrollTop = 80; }')
                page.wait_for_timeout(200)
                index_scroll = page.locator('#page-messages').evaluate('(n) => n.scrollTop')
                page.locator(f'#conversationList button[data-conversation-peer="{PEER_B}"]').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert page.locator('#conversationBack').inner_text() == '← 返回对话'
                page.locator('#conversationBack').click()
                page.wait_for_timeout(600)
                assert page.locator('#messagesIndex').is_visible()
                assert page.locator('#conversationQuery').input_value() == 'lin'
                assert abs(page.locator('#page-messages').evaluate('(n) => n.scrollTop') - index_scroll) <= 2
                assert ui.active_focus() == f'conversation:{PEER_B}', ui.active_focus()
                # Profile tabs route: posts and address return to the same tab,
                # scroll and message action.
                page.locator('#conversationIndexBack').click()
                page.wait_for_timeout(500)
                ui.row().locator('button[data-contact-peer]').click()
                page.locator('#profileView').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(800)
                message_button = page.locator('#profileMessage')
                tabs = {}
                for tab in ('posts', 'address'):
                    page.locator(f'[data-profile-tab="{tab}"]').click()
                    page.wait_for_timeout(600)
                    page.locator('#profileView').evaluate('(n) => { n.scrollTop = %d; }' % (170 if tab == 'posts' else 220))
                    page.wait_for_timeout(250)
                    wanted = page.locator('#profileView').evaluate('(n) => n.scrollTop')
                    message_button.click()
                    page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                    assert '返回联系人档案' in page.locator('#conversationBack').inner_text()
                    page.locator('#conversationBack').click()
                    page.wait_for_timeout(600)
                    assert page.locator('#profileView').is_visible()
                    assert page.locator(f'[data-profile-tab="{tab}"]').get_attribute('aria-current') == 'page'
                    assert abs(page.locator('#profileView').evaluate('(n) => n.scrollTop') - wanted) <= 2
                    assert ui.active_id() == 'profileMessage', ui.active_id()
                    tabs[tab] = {'scroll': wanted}
                page.locator('#profileBack').click()
                page.wait_for_timeout(600)
                # Journey evidence route.
                ui.nav('home')
                page.locator('#homeJourneysAll').click()
                page.locator('#page-journeys').wait_for(state='visible', timeout=15000)
                page.locator(f'#journeyList [data-journey-open="{FIXTURE["journeyId"]}"]').click()
                page.locator('#page-journey').wait_for(state='visible', timeout=15000)
                page.locator('#journeyDetail [data-journey-locate-peer]').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                assert '返回漫游' in page.locator('#conversationBack').inner_text()
                assert '入口来源：漫游证据' in page.locator('#conversationOrigin').text_content()
                page.locator(f'#messageList [data-message-id="{FIXTURE["outboundMessageId"]}"]').wait_for(state='visible', timeout=15000)
                assert ui.nav_current() == ['contacts']
                page.locator('#conversationBack').click()
                page.wait_for_timeout(700)
                assert page.locator('#page-journey').is_visible()
                expected = f'journey-evidence:{FIXTURE["journeyId"]}:{FIXTURE["journeyEvidenceSeq"]}:{FIXTURE["outboundMessageId"]}'
                assert ui.active_focus() == expected, (ui.active_focus(), expected)
                assert ui.nav_current() == ['home']
                ui.shot('b7-05-wide-journey-return-1440')
                return {'indexScroll': index_scroll, 'profileTabs': tabs, 'journeyFocus': expected}

            case('B7-05', '会话列表、档案两个分区与漫游证据进入聊天后都回到实际来源', c_sources_regression)

            def read_cursor_constraints():
                ui.nav('contacts')
                page.wait_for_timeout(700)
                # Read-only Agent history must not advance the human cursor.
                send_unread(2)
                wait_for(lambda: unread_badge(page) not in ('', '0'), 'new unread badge', 20)
                before_badge = unread_badge(page)
                before_cursor = read_cursor()
                status, tool = post_tool('raminga_chat_history', {'limit': 20})
                assert status == 200 and tool.get('ok') is True, tool
                page.wait_for_timeout(900)
                assert unread_badge(page) == before_badge, 'Agent history read changed the visible unread count'
                assert read_cursor() == before_cursor, 'Agent history read advanced the human cursor'
                # Hidden settings page: open in history first so the list is
                # loaded and the pending bottom read is cancelled, then let a
                # new event arrive while settings hides the chat.
                page.locator(f'[data-contact-row="{PEER_B}"] button[data-chat-peer]').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#messageList .rm-message').count() > 0, 'settings rows', 15)
                page.locator('#messageList').evaluate('(n) => { n.scrollTop = 120; }')
                page.wait_for_timeout(150)
                page.locator('#settingsTrigger').click()
                page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)
                hidden_before = read_cursor()
                hidden_badge = unread_badge(page)
                send_unread(1)
                page.wait_for_timeout(900)
                assert unread_badge(page) not in ('', '0'), 'new unread should remain while settings hides the chat'
                assert read_cursor() == hidden_before, 'hidden settings advanced the read cursor'
                page.locator('#settingsClose').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(500)
                assert unread_badge(page) not in ('', '0'), 'returning to an older position must not mark read'
                page.locator('#messageJumpLatest').click()
                page.wait_for_timeout(900)
                assert unread_badge(page) in ('', '0'), 'returning to visible bottom chat should mark read'
                # Reading history: a real arriving chat event must not mark read.
                send_unread(1)
                page.wait_for_timeout(500)
                page.locator('#conversationBack').click()
                page.wait_for_timeout(500)
                page.locator(f'[data-contact-row="{PEER_B}"] button[data-chat-peer]').click()
                page.locator('#conversationView').wait_for(state='visible', timeout=15000)
                wait_for(lambda: page.locator('#messageList .rm-message').count() > 0, 'history rows', 15)
                ui.scroll_history(0.15)
                page.wait_for_timeout(200)
                history_cursor = read_cursor()
                send_unread(1)
                page.wait_for_timeout(900)
                assert unread_badge(page) not in ('', '0'), 'unread should remain while reading history'
                assert read_cursor() == history_cursor, 'reading history advanced the read cursor'
                page.locator('#messageJumpLatest').click()
                page.wait_for_timeout(900)
                assert unread_badge(page) in ('', '0'), 'explicit latest should mark read'
                # A profile layered over the chat is a hidden conversation; go
                # up first so returning stays at history until an explicit jump.
                send_unread(1)
                page.wait_for_timeout(500)
                page.locator('#messageList').evaluate('(n) => { n.scrollTop = 120; }')
                page.wait_for_timeout(150)
                page.locator('#conversationProfile').click()
                page.locator('#profileView').wait_for(state='visible', timeout=15000)
                hidden_cursor = read_cursor()
                send_unread(1)
                page.wait_for_timeout(900)
                assert unread_badge(page) not in ('', '0'), 'unread should remain while the profile hides the chat'
                assert read_cursor() == hidden_cursor, 'hidden profile advanced the read cursor'
                page.locator('#profileBack').click()
                page.wait_for_timeout(500)
                assert unread_badge(page) not in ('', '0'), 'returning to history must not mark read'
                page.locator('#messageJumpLatest').click()
                page.wait_for_timeout(900)
                assert unread_badge(page) in ('', '0'), 'returning to visible bottom chat should mark read'
                # Window blur cancels the pending read while still in history;
                # focus alone cannot mark a non-bottom chat, an explicit jump can.
                send_unread(1)
                page.wait_for_timeout(500)
                page.locator('#messageList').evaluate('(n) => { n.scrollTop = 120; }')
                page.wait_for_timeout(150)
                page.evaluate('window.dispatchEvent(new Event("blur"))')
                blurred_cursor = read_cursor()
                send_unread(1)
                page.wait_for_timeout(900)
                assert unread_badge(page) not in ('', '0'), 'unread should remain while the window is blurred'
                assert read_cursor() == blurred_cursor, 'blurred window advanced the read cursor'
                page.evaluate('window.dispatchEvent(new Event("focus"))')
                page.wait_for_timeout(600)
                assert unread_badge(page) not in ('', '0'), 'focus without returning to the bottom must not mark read'
                page.locator('#messageJumpLatest').click()
                page.wait_for_timeout(900)
                assert unread_badge(page) in ('', '0'), 'focused visible bottom chat should mark read'
                visibility = page.evaluate('({visibility: document.visibilityState, hasFocus: document.hasFocus()})')
                assert visibility['visibility'] == 'visible'
                ui.shot('b7-06-wide-read-state-1440')
                return {
                    'unreadAfterAgentHistory': before_badge,
                    'cursorAfterAgentHistory': before_cursor,
                    'visibility': visibility,
                    'hiddenSettingsCursor': hidden_before,
                    'hiddenSettingsBadge': hidden_badge,
                    'historyCursor': history_cursor,
                    'hiddenProfileCursor': hidden_cursor,
                    'blurredCursor': blurred_cursor,
                }

            case('B7-06', 'Agent 读历史不清未读；隐藏面板/翻历史/失焦保持，底部可见后按语义标读', read_cursor_constraints)

            def narrow_layout_and_gear():
                ui.viewport(390, 844)
                ui.nav('contacts')
                page.wait_for_timeout(700)
                ui.open_chat()
                page.wait_for_timeout(500)
                if not page.locator('#composerJump').evaluate('(node) => node.hidden'):
                    page.locator('#messageJumpLatest').click()
                    page.wait_for_timeout(400)
                metrics = ui.chat_metrics()
                assert ui.overflow() <= 1
                assert ui.visual_overflow('#conversationView') == 0
                assert metrics['header']['height'] <= 84, metrics['header']
                assert metrics['list']['height'] >= 220, metrics
                assert metrics['input']['bottom'] <= metrics['nav']['top'] + 1, metrics
                assert metrics['last']['bottom'] <= metrics['shell']['top'] + 1, metrics
                assert len([1 for sel in ('#desktopNav', '#mobileNav') if page.locator(sel).is_visible()]) == 1
                ui.shot('b7-07-narrow-chat-390')
                page.locator('#messageInput').fill('390 窄屏未发送草稿')
                page.locator('#messageInput').dispatch_event('input')
                page.locator('#messageInput').focus()
                top = ui.scroll_history(0.25)
                page.wait_for_timeout(200)
                page.locator('#settingsTrigger').click()
                page.locator('#settingsIndex').wait_for(state='visible', timeout=15000)
                page.wait_for_timeout(500)
                page.locator('#settingsClose').click()
                page.wait_for_timeout(600)
                assert page.locator('#messageInput').input_value() == '390 窄屏未发送草稿'
                assert abs(page.locator('#messageList').evaluate('(n) => n.scrollTop') - top) <= 2
                assert ui.active_id() == 'messageInput', ui.active_id()
                nav_metrics = ui.chat_metrics()
                assert nav_metrics['input']['bottom'] <= nav_metrics['nav']['top'] + 1, nav_metrics
                ui.shot('b7-07-narrow-settings-return-390')
                return {'headerHeight': round(metrics['header']['height'], 1),
                        'listHeight': round(metrics['list']['height'], 1),
                        'overflow': ui.overflow(), 'scroll': round(top, 1)}

            case('B7-07', '390×844 首屏、长文本、底栏安全区与齿轮往返均可用', narrow_layout_and_gear)

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
