#!/usr/bin/env python3
"""Real isolated DSH acceptance for second-batch item 1: the home public profile.

The fixture is prepared by prepare.mjs. This driver starts one isolated DSH Web
host at a time (default 4370) for each small Node data directory, checks both
1440x900 and 390x844, clicks the real edit entries, and records screenshots,
host logs and a JSON result file. It stops only the fixture's own hosts.
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

ROOT = pathlib.Path(os.environ.get('BATCH2_ACCEPTANCE_DIR', '.local/prototype-remediation/b2-home')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
HOST_PORT = int(os.environ.get('BATCH2_HOST_PORT', FIXTURE.get('hostPort', 4370)))
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
VARIANTS = ['avatar-short', 'avatar-long', 'no-avatar', 'missing']
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': HOST_PORT,
    'cases': {},
    'screenshots': [],
    'hostLogs': [],
    'pageErrors': [],
    'consoleErrors': [],
}
RESULT_FILE = EVIDENCE / 'b2-home-results.json'


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) else 'FAIL'
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
            'error': str(exc), 'trace': traceback.format_exc()[-5000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
    finally:
        save()


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) != 0


def wait_port_free(port, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_free(port):
            return
        time.sleep(0.2)
    raise AssertionError(f'port {port} is still in use after the previous host exited')


def start_host(variant):
    wait_port_free(HOST_PORT)
    log_path = EVIDENCE / f'host-{variant}.log'
    pid_path = EVIDENCE / f'dsh-{variant}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'BATCH2_DATA_DIR': FIXTURE['variants'][variant]['dataDir'],
        'BATCH2_DSH_HOME': FIXTURE['dshHome'],
        'BATCH2_HOST_PORT': str(HOST_PORT),
        'BATCH2_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(REPO / 'bin' / 'raminga'),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 30
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
        process.terminate()
        raise AssertionError(f'host for {variant} did not publish a URL: {log_path.read_text(errors="replace")[-2000:]}')
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    return process, url


def stop_host(process):
    if process is None:
        return
    if process.poll() is None:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    wait_port_free(HOST_PORT)


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(6):
            close = self.page.locator('[aria-label="Close"]:visible, [aria-label="关闭"]:visible')
            if close.count() == 0:
                return
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
        self.page.wait_for_timeout(1000)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(800)
        self.open_panel()
        self.page.wait_for_timeout(500)

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def text(self, selector):
        return self.page.locator(selector).text_content() or ''

    def inner(self, selector):
        return self.page.locator(selector).inner_text()

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')

    def home_top(self):
        self.page.locator('#page-home').evaluate('(node) => { node.scrollTop = 0; }')
        self.page.wait_for_timeout(250)


def assert_visible(page, selector, label=None):
    loc = page.locator(selector)
    assert loc.count() > 0, f'{label or selector} is missing'
    assert loc.first.is_visible(), f'{label or selector} is not visible'


def assert_hidden(page, selector):
    loc = page.locator(selector)
    if loc.count() == 0:
        return
    assert not loc.first.is_visible(), f'{selector} should be hidden'


def assert_no_raw_paths(ui):
    text = ui.inner('#page-home')
    for marker in ('agent-card.json', 'profile/profile.json', 'public/profile/', '.raminga', '/Users/'):
        assert marker not in text, f'first screen leaked {marker!r}: {text[-400:]}'


def avatar_metrics(ui):
    container = ui.page.locator('#homeAgentAvatar')
    image = container.locator('img')
    assert image.is_visible(), 'avatar image is not visible'
    assert image.get_attribute('src').startswith('data:image/png;base64,'), 'avatar was not read through the controlled image preview'
    assert image.evaluate('(node) => node.naturalWidth') > 0, 'avatar image did not decode'
    box = container.bounding_box()
    image_box = image.bounding_box()
    assert box and image_box, 'avatar boxes are missing'
    for key in ('width', 'height'):
        assert abs(box[key] - image_box[key]) <= 1.5, f'avatar does not fill its container: {box} vs {image_box}'
    style = image.evaluate('''(node) => {
      const value = getComputedStyle(node);
      return { objectFit: value.objectFit, display: value.display, radius: value.borderRadius };
    }''')
    assert style['objectFit'] == 'cover', style
    assert style['display'] != 'none', style
    padding = container.evaluate('''(node) => {
      const value = getComputedStyle(node);
      return [value.paddingTop, value.paddingRight, value.paddingBottom, value.paddingLeft, value.borderTopWidth];
    }''')
    assert all(float(item.replace('px', '')) == 0 for item in padding), f'avatar container has a nested frame/padding: {padding}'
    assert container.get_attribute('data-empty') == 'false'
    return {'container': box, 'image': image_box, 'objectFit': style['objectFit'], 'padding': padding}


def initial_placeholder(ui, expected='N'):
    image = ui.page.locator('#homeAgentAvatar img')
    assert not image.is_visible(), 'the avatar image must not show when no public avatar exists'
    initial = ui.page.locator('#homeAgentInitial')
    assert initial.is_visible(), 'the unified initial placeholder is missing'
    assert initial.inner_text().strip() == expected, initial.inner_text()
    container = ui.page.locator('#homeAgentAvatar').bounding_box()
    box = initial.bounding_box()
    assert container and box
    for key in ('width', 'height'):
        assert abs(container[key] - box[key]) <= 1.5, f'placeholder does not fill its container: {container} vs {box}'
    assert ui.page.locator('#homeAgentAvatar').get_attribute('data-empty') == 'true'
    return {'initial': initial.inner_text().strip(), 'container': container, 'box': box}


def assert_tags_and_style(ui):
    tags = ui.page.locator('#homeAgentInterests .rm-home-tag')
    assert tags.count() == 3, tags.count()
    values = []
    for index in range(tags.count()):
        tag = tags.nth(index)
        assert tag.locator('svg.rm-home-tag-icon').count() == 1
        values.append(tag.inner_text().strip())
    assert values == FIXTURE['agent']['interests'], values
    style = ui.inner('#homeAgentStyle')
    assert '公开交流风格' in style and FIXTURE['agent']['style'] in style, style
    return values


def assert_activity_and_recent(ui, round_trip=False, narrow=False):
    page = ui.page
    cards = [
        ('live', page.locator('#homeActivityLive')),
        ('recent', page.locator('#homeActivityRecent')),
        ('empty', page.locator('#homeActivityEmpty')),
    ]
    visible = [name for name, loc in cards if loc.is_visible()]
    assert visible == ['live'], f'expected exactly one activity card, got {visible}'
    assert_visible(page, '#homeAgentStatusText')
    tiles = page.locator('#ramingaSessionList .rm-journey-tile')
    assert tiles.count() >= 3, tiles.count()
    if narrow:
        columns = page.locator('#ramingaSessionList').evaluate('(node) => getComputedStyle(node).gridTemplateColumns')
        assert ' ' not in columns, f'narrow recent records must be one column: {columns}'
    if round_trip:
        first = tiles.first
        first.click()
        page.locator('#page-journey').wait_for(state='visible', timeout=15000)
        assert_visible(page, '#journeyDetail')
        page.locator('#journeyBack').click()
        page.locator('#page-home').wait_for(state='visible', timeout=15000)
        assert_visible(page, '#ramingaSessionList .rm-journey-tile')
        page.locator('#homeActivityLive').click()
        page.locator('#page-journey').wait_for(state='visible', timeout=15000)
        page.locator('#journeyBack').click()
        page.locator('#page-home').wait_for(state='visible', timeout=15000)
    return {'activity': visible[0], 'tiles': tiles.count()}


def open_edit_from_full(ui):
    page = ui.page
    page.locator('#home-agent-hero [aria-label="编辑公开资料"]').click()
    page.locator('#settings-public').wait_for(state='visible', timeout=15000)
    assert page.locator('#publicAgentName').input_value() == 'Nova'
    assert page.locator('#publicAgentDescription').input_value() == FIXTURE['variants']['avatar-short']['expected']['description']
    interest_values = [item.strip() for item in re.split(r'[,，]', page.locator('#publicAgentInterests').input_value()) if item.strip()]
    assert interest_values == FIXTURE['agent']['interests'], interest_values
    ui.shot('wide-edit-full-1440')
    page.locator('#settings-public [data-settings-back]').click()
    page.locator('#settingsIndex').wait_for(state='visible', timeout=10000)
    page.locator('#settingsClose').click()
    page.locator('#page-home').wait_for(state='visible', timeout=10000)
    assert_visible(page, '#home-agent-hero')


def open_edit_from_missing(ui):
    page = ui.page
    page.locator('#homeAgentProfileEdit').click()
    page.locator('#settings-public').wait_for(state='visible', timeout=15000)
    ui.shot('wide-edit-missing-1440')
    page.locator('#settings-public [data-settings-back]').click()
    page.locator('#settingsIndex').wait_for(state='visible', timeout=10000)
    page.locator('#settingsClose').click()
    page.locator('#page-home').wait_for(state='visible', timeout=10000)
    assert_visible(page, '#homeAgentProfileNote')


def run_variant(page, ui, variant):
    expected = FIXTURE['variants'][variant]['expected']
    assert_visible(page, '#page-home')
    assert_visible(page, '#home-agent-hero')
    assert_visible(page, '#home-human-strip')
    ui.home_top()
    assert_no_raw_paths(ui)

    if variant == 'missing':
        assert ui.inner('#homeAgentName') == '我的 Agent'
        assert_hidden(page, '#homeAgentBio')
        assert_hidden(page, '#homeAgentStyle')
        assert_hidden(page, '#homeAgentInterests')
        assert_visible(page, '#homeAgentProfileNote')
        note = ui.inner('#homeAgentProfileNote')
        assert '还没有公开档案' in note and '编辑公开资料' in note, note
        placeholder = initial_placeholder(ui, '我')
        assert_visible(page, '#homeAgentProfileEdit')
        assert_visible(page, '#home-agent-hero [aria-label="编辑公开资料"]')
        activity = assert_activity_and_recent(ui)
        return {'profile': 'missing', 'note': note, 'placeholder': placeholder, 'activity': activity}

    assert ui.inner('#homeAgentName') == 'Nova'
    description = ui.text('#homeAgentBio')
    assert description == expected['description'], f'bio was truncated or changed: {len(description)} chars'
    assert_visible(page, '#homeAgentBio')
    assert_hidden(page, '#homeAgentProfileNote')
    tags = assert_tags_and_style(ui)
    if expected['hasAvatar']:
        avatar = avatar_metrics(ui)
    else:
        avatar = {'placeholder': initial_placeholder(ui)}
    activity = assert_activity_and_recent(ui, round_trip=(variant == 'avatar-short' and ui.wide), narrow=not ui.wide)
    return {
        'profile': variant,
        'bioChars': len(description),
        'tags': tags,
        'avatar': avatar,
        'activity': activity,
    }


def narrow_check(page, ui, variant, wide_metrics):
    assert ui.overflow() <= 1, f'horizontal overflow at 390x844: {ui.overflow()}'
    assert_visible(page, '#mobileNav')
    assert_hidden(page, '#desktopNav')
    assert page.locator('#mobileNav [aria-current="page"]').count() == 1
    assert page.locator('#mobileNav [aria-current="page"]').get_attribute('data-nav') == 'home'
    hero = page.locator('#home-agent-hero').bounding_box()
    human = page.locator('#home-human-strip').bounding_box()
    assert hero and human
    assert human['y'] >= hero['y'] + hero['height'] - 1, 'human strip must stay after the Agent hero'
    description_box = page.locator('#homeAgentBio').bounding_box()
    copy_box = page.locator('.rm-home-hero-copy').bounding_box()
    if description_box and copy_box:
        assert description_box['width'] <= copy_box['width'] + 1, f'bio overflows the hero copy: {description_box} vs {copy_box}'
    return {'overflow': ui.overflow(), 'hero': hero, 'human': human}


def run_hosted_variant(browser, variant):
    process = None
    context = None
    try:
        process, url = start_host(variant)
        RESULTS.setdefault('urls', {})[variant] = url
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page = context.new_page()
        page.on('pageerror', lambda error: RESULTS['pageErrors'].append({'variant': variant, 'error': str(error)}))
        page.on('console', lambda msg: RESULTS['consoleErrors'].append({'variant': variant, 'type': msg.type, 'text': msg.text}) if msg.type == 'error' else None)
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_timeout(2800)
        ui = UI(page)
        ui.wide = True
        ui.dismiss()
        ui.open_panel()
        ui.home_top()
        wide = run_variant(page, ui, variant)
        ui.shot(f'wide-{variant}-1440')
        if variant == 'avatar-short':
            open_edit_from_full(ui)
            ui.home_top()
        elif variant == 'missing':
            open_edit_from_missing(ui)
            ui.home_top()

        ui.viewport(390, 844)
        ui.home_top()
        narrow = run_variant(page, ui, variant)
        narrow_metrics = narrow_check(page, ui, variant, wide)
        ui.shot(f'narrow-{variant}-390')
        return {'url': url, 'wide': wide, 'narrow': narrow, 'narrowLayout': narrow_metrics}
    finally:
        if context is not None:
            context.close()
        stop_host(process)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            for index, variant in enumerate(VARIANTS, 1):
                case(f'B2H-{index:02d}', f'{variant} at 1440x900 and 390x844', lambda variant=variant: run_hosted_variant(browser, variant))
        finally:
            browser.close()
    save()
    print(json.dumps({'status': RESULTS['status'], 'cases': {key: value['status'] for key, value in RESULTS['cases'].items()}}, ensure_ascii=False))
    raise SystemExit(0 if RESULTS['status'] == 'PASS' else 1)


if __name__ == '__main__':
    main()
