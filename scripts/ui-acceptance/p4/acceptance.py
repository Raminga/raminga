# Real isolated DSH acceptance for P4: wide/narrow home activity, a real
# content_get observed running -> ok, panel close/reopen without a false
# terminal, and a real tool error. Requires prepare.mjs and the isolated host.
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import signal
import threading
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('.local/ui-refresh-20261117/p4-acceptance').resolve()
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(exist_ok=True)
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
CONTROL = FIXTURE['controlUrl']
B_PID = int((ROOT / 'node-b.pid').read_text().strip())
URL = re.search(r'https?://\S+', (ROOT / 'dsh-4332.log').read_text()).group(0)
RESULTS = {}
PAGE_ERRORS = []
CONSOLE_ERRORS = []
THREADS = []


def post_tool(tool, args, timeout=130):
    request = urllib.request.Request(
        CONTROL,
        data=json.dumps({'tool': tool, 'args': args}).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode('utf-8')
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode('utf-8')


def run_async(tool, args):
    box = {}

    def worker():
        started = time.time()
        try:
            box['status'], box['body'] = post_tool(tool, args)
        except Exception as error:  # noqa: BLE001 - evidence records the real failure
            box['error'] = str(error)
        box['elapsed'] = round(time.time() - started, 3)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    THREADS.append(thread)
    return thread, box


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


def raw_log():
    return (ROOT / 'node-a' / 'agent' / 'activity.jsonl').read_text()


def dismiss_host(page):
    if page.locator('[aria-label="Close"]:visible').count():
        page.locator('[aria-label="Close"]:visible').first.click()
        page.wait_for_timeout(400)


def open_raminga(page):
    page.get_by_role('button', name='Raminga', exact=True).first.click()
    page.wait_for_timeout(1200)
    page.locator('#settingsTrigger').wait_for(state='visible', timeout=15000)


def close_raminga(page):
    page.get_by_role('button', name='New Session').first.click()
    page.wait_for_timeout(800)
    assert page.locator('#settingsTrigger').count() == 0, 'Raminga panel did not unmount'


def wait_activity_text(page, selector, pattern, timeout_ms=10000):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        page.wait_for_timeout(150)
        node = page.locator(selector)
        if node.is_visible():
            text = node.inner_text()
            if re.search(pattern, text):
                return text
    raise AssertionError(f'{selector} did not match {pattern}: {page.locator(selector).inner_text() if page.locator(selector).count() else "missing"}')


def open_detail(page):
    toggle = page.locator('#homeActivityToggle')
    if toggle.count() and toggle.get_attribute('aria-expanded') != 'true':
        toggle.click()
        page.wait_for_timeout(900)


def stop_b():
    os.kill(B_PID, signal.SIGSTOP)


def cont_b():
    os.kill(B_PID, signal.SIGCONT)


def trigger_paused_download():
    stop_b()
    thread, box = run_async('raminga_content_get', {'peer_id': FIXTURE['nodeB'], 'path': FIXTURE['hugePath']})
    return thread, box


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
    page.on('console', lambda message: CONSOLE_ERRORS.append(message.text) if message.type == 'error' else None)
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_timeout(2200)
    dismiss_host(page)
    open_raminga(page)

    # 1. Journey-only state: a saved running Journey must not claim a visit.
    journey_card = wait_activity_text(page, '#homeActivityLive', r'Journey 进行中')
    assert '正在访问' not in journey_card, journey_card
    assert '不是工具访问证据' in journey_card, journey_card
    RESULTS['journey_only'] = journey_card
    page.screenshot(path=str(EVIDENCE / 'p4-wide-journey-only.png'))

    # 2. Real content_get while B is paused: observe started -> running in UI.
    thread, box = trigger_paused_download()
    live_text = wait_activity_text(page, '#homeActivityLive', r'正在访问')
    assert '进行中' in live_text, live_text
    running = [op for op in read_ops() if op.get('state') == 'running']
    assert running, 'activity file lost the real started event'
    running_op = running[-1]
    assert running_op['tool'] == 'raminga_content_get'
    assert running_op['journey_match'] == 'current_peer', running_op
    assert running_op.get('panel_session_id', '') != '', 'panel lease was not recorded'
    RESULTS['wide_live'] = {'text': live_text, 'operation_id': running_op['operation_id'], 'journey_match': running_op['journey_match']}
    page.screenshot(path=str(EVIDENCE / 'p4-wide-live.png'))

    # 3. Close the panel only: the operation must have no false terminal.
    close_raminga(page)
    time.sleep(1.5)
    during_close = [op for op in read_ops() if op['operation_id'] == running_op['operation_id']][0]
    assert during_close.get('result') is None and during_close.get('state') == 'running', during_close
    RESULTS['closed_while_running'] = {'result': during_close.get('result'), 'state': during_close.get('state'), 'no_false_terminal': True}
    page.screenshot(path=str(EVIDENCE / 'p4-wide-panel-closed.png'))

    # 4. Let the real download finish with no panel; reopen and see the truth.
    cont_b()
    thread.join(timeout=60)
    assert not thread.is_alive(), 'real download did not finish after peer resume'
    assert box.get('status') == 200, box
    tool_value = json.loads(box['body'])
    assert tool_value.get('ok') is True, tool_value
    final_sha = tool_value['value']['final']['sha256']
    assert final_sha == FIXTURE['hugeSha'], (final_sha, FIXTURE['hugeSha'])
    time.sleep(0.5)
    finished = [op for op in read_ops() if op['operation_id'] == running_op['operation_id']][0]
    assert finished['result'] == 'ok', finished
    assert not any(op.get('result') in ('interrupted', 'unknown') for op in read_ops()), 'close wrote an interrupted/unknown terminal'
    open_raminga(page)
    recent_text = wait_activity_text(page, '#homeActivityRecent', r'最近活动')
    assert '下载公开内容' in recent_text and '完成' in recent_text, recent_text
    RESULTS['wide_recent'] = {'text': recent_text, 'result': finished['result'], 'sha256': final_sha}
    page.screenshot(path=str(EVIDENCE / 'p4-wide-recent.png'))

    # 5. Detail: facts, route summary, source and Journey association.
    open_detail(page)
    detail_text = page.locator('#homeActivityDetail').inner_text()
    for label in ['本机工具调用记录', '路由与证据摘要', '来源', 'Journey 关联', FIXTURE['hugeSha']]:
        assert label in detail_text, f'{label} missing from detail'
    assert '不是传输证据' in detail_text
    RESULTS['wide_detail'] = {'text': detail_text[:1200], 'sha256': final_sha}
    page.locator('#homeActivityDetail').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=str(EVIDENCE / 'p4-wide-detail.png'))
    journey_link = page.locator('[data-activity-journey]')
    assert journey_link.count() == 1, 'Journey evidence link missing'
    journey_link.click()
    page.wait_for_timeout(900)
    assert page.locator(f'[data-session-toggle="{FIXTURE["journey"]}"]').count() == 1, 'exact Journey record was not revealed'
    RESULTS['wide_journey_jump'] = True

    # 6. Real failure: a missing manifest path is recorded as error, not success.
    status, body = post_tool('raminga_content_get', {
        'peer_id': FIXTURE['nodeB'], 'path': 'posts/does-not-exist.json',
    })
    assert status == 500, (status, body[:300])
    failed_text = wait_activity_text(page, '#homeActivityRecent', r'失败')
    failed_op = [op for op in read_ops() if op.get('tool') == 'raminga_content_get' and op.get('result') == 'error'][-1]
    assert failed_op['error_code'] == 'tool_error', failed_op
    assert failed_op['error_summary'] == '目标公开内容或清单不可用。', failed_op
    RESULTS['wide_error'] = {'text': failed_text, 'operation_id': failed_op['operation_id'], 'error_code': failed_op['error_code']}
    open_detail(page)
    assert '记录的错误信息' in page.locator('#homeActivityDetail').inner_text()
    page.screenshot(path=str(EVIDENCE / 'p4-wide-error.png'))

    # 7. Narrow viewport: close at wide (the host's narrow header has no
    # visible New Session control), then reopen at 390 and repeat the real
    # running -> ok transition.
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.wait_for_timeout(400)
    close_raminga(page)
    open_raminga(page)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(700)
    thread2, box2 = trigger_paused_download()
    narrow_live = wait_activity_text(page, '#homeActivityLive', r'正在访问')
    RESULTS['narrow_live'] = narrow_live
    page.locator('#home-activity').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=str(EVIDENCE / 'p4-narrow-live.png'))
    cont_b()
    thread2.join(timeout=60)
    assert not thread2.is_alive() and box2.get('status') == 200, box2
    narrow_recent = wait_activity_text(page, '#homeActivityRecent', r'最近活动')
    assert '完成' in narrow_recent, narrow_recent
    open_detail(page)
    narrow_detail = page.locator('#homeActivityDetail').inner_text()
    assert '本机工具调用记录' in narrow_detail and '路由与证据摘要' in narrow_detail
    RESULTS['narrow_recent'] = narrow_recent
    page.locator('#homeActivityDetail').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=str(EVIDENCE / 'p4-narrow-detail.png'))
    overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    RESULTS['narrow_overflow'] = overflow

    # 8. Log hygiene and operation uniqueness.
    ops = read_ops()
    RESULTS['operations'] = [
        {'id': op['operation_id'], 'tool': op['tool'], 'result': op.get('result'), 'state': op.get('state'), 'panel': op.get('panel_session_id', '')}
        for op in ops
    ]
    assert len({op['operation_id'] for op in ops}) == len(ops), 'operation ids are not unique'
    log = raw_log()
    assert str(ROOT) not in log, 'activity log leaked an absolute test path'
    assert 'SECRET' not in log, 'activity log leaked a body marker'
    RESULTS['log_private'] = True
    RESULTS['page_errors'] = PAGE_ERRORS
    RESULTS['console_errors'] = [item for item in CONSOLE_ERRORS if '[raminga-ui]' not in item][:20]
    RESULTS['fixture'] = FIXTURE
    (EVIDENCE / 'p4-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    print(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    browser.close()
