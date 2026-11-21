#!/usr/bin/env python3
"""Real isolated DSH Web acceptance for bootstrap-role management.

Uses three local daemons (A client + DSH host, B DHT server, C ordinary contact),
fixed loopback ports 44741-44744, an isolated HOME/DSH_HOME and real Chromium.
It never touches ~/.raminga, the user's DSH_HOME, the desktop, or another port.
"""
from playwright.sync_api import sync_playwright
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
import urllib.request

ROOT = pathlib.Path(os.environ.get('B3_ACCEPTANCE_DIR', '.local/prototype-remediation/b3-01-bootstrap')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'bin' / 'raminga'
START_HOST = pathlib.Path(__file__).with_name('start-host.sh')
HOST_PORT = int(os.environ.get('B3_HOST_PORT', FIXTURE.get('hostPort', 44744)))
DIR_A = pathlib.Path(FIXTURE['nodeAData'])
DIR_B = pathlib.Path(FIXTURE['nodeBData'])
DIR_C = pathlib.Path(FIXTURE['nodeCData'])
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
PEER_C = FIXTURE['nodeC']
ADDR_B = FIXTURE['addrB']
ADDR_C = FIXTURE['addrC']
CONFIG_A = pathlib.Path(FIXTURE['configAPath'])
CONFIG_BASELINE = EVIDENCE / 'node-a-config.baseline.toml'
CONFIG_SHA = FIXTURE['configASha256']
DSH_HOME = FIXTURE['dshHome']

RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str((ROOT / 'fixture.json').relative_to(REPO)),
    'hostPort': HOST_PORT,
    'nodePorts': {'A': FIXTURE['portA'], 'B': FIXTURE['portB'], 'C': FIXTURE['portC']},
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
    'cases': {}, 'screenshots': [], 'hostLogs': [],
    'pageErrors': [], 'consoleErrors': [],
    'notes': [
        'Only isolated loopback daemons and a real isolated DSH Web host were used.',
        'No public node, release preset, NAT/cross-machine path, or desktop shell is claimed.',
    ],
}
RESULT_FILE = EVIDENCE / 'b3-01-bootstrap-results.json'
PAGE = None
HOST = {'process': None, 'url': '', 'log': None}
NODES = {}


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
    raise AssertionError(f'port {port} is still in use after exit')


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
    if HOST['url']:
        wait_port_free(HOST_PORT)
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    for path in (pid_path, pathlib.Path(f'{pid_path}.meta')):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def start_host():
    if not port_free(HOST_PORT):
        raise AssertionError(f'port {HOST_PORT} is already in use; refusing to touch a live host')
    log_path = EVIDENCE / 'host-b3-01.log'
    pid_path = EVIDENCE / f'dsh-{HOST_PORT}.pid'
    log = log_path.open('w')
    env = os.environ.copy()
    env.update({
        'B3_DATA_DIR': str(DIR_A),
        'B3_DSH_HOME': DSH_HOME,
        'B3_HOST_PORT': str(HOST_PORT),
        'B3_PIDFILE': str(pid_path),
        'RAMINGA_BIN': str(BIN),
    })
    process = subprocess.Popen(
        ['sh', str(START_HOST)], cwd=REPO, env=env,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.time() + 90
    url = None
    while time.time() < deadline:
        if process.poll() is not None:
            break
        text = log_path.read_text(errors='replace') if log_path.exists() else ''
        matches = re.findall(r'http://127\.0\.0\.1:%d/\S*' % HOST_PORT, text)
        if matches:
            url = matches[-1].rstrip('.,)')
            break
        time.sleep(0.25)
    if url is None:
        terminate_process(process)
        raise AssertionError(f'host did not publish a URL: {log_path.read_text(errors="replace")[-4000:]}')
    HOST.update(process=process, url=url, log=str(log_path))
    RESULTS['hostLogs'].append(str(log_path.relative_to(REPO)))
    save()
    return url


def run_cli(args, timeout=20):
    result = subprocess.run([str(BIN), *args], cwd=REPO, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise AssertionError(f'raminga {" ".join(args)} failed: {result.stderr or result.stdout}')
    return result.stdout


def run_json(args, timeout=20):
    return json.loads(run_cli(args, timeout))


def status(data_dir=DIR_A):
    return run_json(['status', '--json', '--data-dir', str(data_dir)])


def dht_state():
    payload = run_json(['dht', 'status', '--json', '--data-dir', str(DIR_A)])
    value = payload.get('dht', {})
    return {
        'bootstrapPeers': value.get('bootstrapPeers', []),
        'bootstrapConnected': int(value.get('bootstrapConnected', 0)),
        'connectedPeers': int(value.get('connectedPeers', 0)),
        'lastBootstrapUnixMs': int(value.get('lastBootstrapUnixMs', 0)),
        'lastRefreshUnixMs': int(value.get('lastRefreshUnixMs', 0)),
        'lastError': value.get('lastError', ''),
    }


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


def start_node(name, data_dir):
    if not port_free(FIXTURE[{'a': 'portA', 'b': 'portB', 'c': 'portC'}[name]]):
        raise AssertionError(f'node {name} port is already in use; refusing to reuse another process')
    log_path = EVIDENCE / f'{name}.log'
    log = log_path.open('a')
    process = subprocess.Popen([str(BIN), 'daemon', '--data-dir', str(data_dir)], cwd=REPO,
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    NODES[name] = process
    wait_for(lambda: status(data_dir), f'node {name} status', 40)
    return process


def stop_node(name, data_dir):
    subprocess.run([str(BIN), 'stop', '--data-dir', str(data_dir)], cwd=REPO,
                   capture_output=True, text=True, timeout=20)
    terminate_process(NODES.get(name))
    NODES.pop(name, None)


def restart_node(name, data_dir):
    stop_node(name, data_dir)
    start_node(name, data_dir)


def db_rows(query, args=()):
    db = sqlite3.connect(f'file:{DIR_A / "raminga.db"}?mode=ro', uri=True)
    try:
        return db.execute(query, args).fetchall()
    finally:
        db.close()


def db_state():
    roles = db_rows('SELECT peer_id, created_at_ms FROM bootstrap_peers ORDER BY peer_id')
    cache = db_rows('SELECT peer_id, addrs_json, source, expires_at_ms FROM known_peers ORDER BY peer_id')
    paused = {row[0] for row in db_rows('SELECT peer_id FROM paused_peers')}
    friends = {row[0] for row in db_rows('SELECT peer_id FROM friends')}
    return {
        'bootstrapRoles': [row[0] for row in roles],
        'knownPeers': [{'peerId': row[0], 'addrs': json.loads(row[1]), 'source': row[2], 'expiresAt': row[3]}
                       for row in cache],
        'paused': sorted(paused),
        'friends': sorted(friends),
    }


def config_state():
    current = CONFIG_A.read_bytes()
    baseline = CONFIG_BASELINE.read_bytes()
    sha = hashlib.sha256(current).hexdigest()
    return {'sha256': sha, 'baselineSha256': CONFIG_SHA,
            'unchanged': current == baseline and sha == CONFIG_SHA,
            'bytes': len(current)}


def require_config_unchanged(label):
    state = config_state()
    if not state['unchanged']:
        raise AssertionError(f'config.toml changed at {label}: {state}')
    return state


def refresh_bootstrap(page):
    button = page.locator('#statusBootstrapRefresh')
    if button.is_visible() and not button.is_disabled():
        button.click()
        page.wait_for_timeout(500)


def wait_bootstrap_status(page, needle, timeout=20000):
    def read():
        refresh_bootstrap(page)
        text = page.locator('#statusBootstrapList').inner_text()
        return text if needle in text else False
    return wait_for(read, f'bootstrap list containing {needle!r}', timeout / 1000)


def wait_text(page, selector, needle, timeout=20000):
    def read():
        node = page.locator(selector)
        if node.count() == 0 or not node.first.is_visible():
            return False
        text = node.first.inner_text()
        return text if needle in text else False
    return wait_for(read, f'visible {selector} containing {needle!r}', timeout / 1000)


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
        self.page.wait_for_timeout(250)
        if not self.wide:
            toggle = self.page.locator('[aria-label="Open sidebar"]:visible')
            if toggle.count():
                toggle.first.click()
                self.page.wait_for_timeout(500)
        self.page.get_by_role('button', name='Raminga', exact=True).first.click()
        self.page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        self.page.wait_for_timeout(700)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(400)
        self.open_panel()
        self.page.wait_for_timeout(300)

    def shot(self, name, full_page=False):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path), full_page=full_page)
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def open_status(self, bootstrap=True):
        dialog = self.page.locator('#statusDialog')
        if dialog.count() == 0 or not dialog.is_visible():
            self.open_panel()
            self.page.locator('#nodeTrigger').click()
            dialog.wait_for(state='visible', timeout=15000)
            self.page.wait_for_timeout(300)
        if bootstrap:
            details = self.page.locator('#statusBootstrap')
            if not details.evaluate('(node) => node.open'):
                self.page.locator('#statusBootstrap summary').click()
            self.page.wait_for_timeout(300)

    def close_status(self):
        self.dismiss()

    def overflow(self):
        return self.page.evaluate('document.documentElement.scrollWidth - window.innerWidth')

    def bootstrap_overflow(self):
        return self.page.locator('#statusBootstrap').evaluate('''(node) => {
          const width = window.innerWidth;
          return [...node.querySelectorAll('*')].filter((element) => {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 1 && (rect.left < -1 || rect.right > width + 1);
          }).length;
        }''')

    def open_contacts(self):
        self.close_status()
        self.open_panel()
        selector = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{selector} [data-nav="contacts"]').click()
        self.page.wait_for_timeout(600)
        self.page.locator('#addContact').wait_for(state='visible', timeout=10000)

    def add_contact(self, multiaddr):
        self.page.locator('#addContact').click()
        self.page.locator('#addContactDialog').wait_for(state='visible', timeout=10000)
        self.page.locator('#addContactInput').fill(multiaddr)
        self.page.locator('#addContactSubmit').click()
        self.page.wait_for_timeout(1200)


def add_bootstrap(page, address):
    page.locator('#statusBootstrapInput').fill(address)
    page.locator('#statusBootstrapAdd').click()
    page.wait_for_timeout(800)


def remove_bootstrap(page, peer_id):
    page.locator(f'[data-bootstrap-remove="{peer_id}"]').click()
    page.wait_for_timeout(900)


def main():
    browser = None
    page = None
    try:
        for port in (FIXTURE['portA'], FIXTURE['portB'], FIXTURE['portC']):
            if not port_free(port):
                raise AssertionError(f'node port {port} is already in use; refusing to touch it')
        start_node('b', DIR_B)
        start_node('c', DIR_C)
        start_node('a', DIR_A)
        url = start_host()
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
            page.wait_for_timeout(1600)
            ui = UI(page)
            ui.viewport(1440, 900)
            ui.open_status()
            wait_text(page, '#statusBootstrapNote', '尚未配置引导节点')

            def b3_01():
                text = page.locator('#statusBootstrapNote').inner_text()
                assert '尚未配置引导节点' in text, text
                assert page.locator('#statusBootstrapEdit').is_visible()
                assert page.locator('#statusBootstrapInput').get_attribute('aria-describedby') == 'statusBootstrapInputHelp'
                # A malformed address fails visibly before any real save.
                add_bootstrap(page, '/ip4/127.0.0.1/tcp/4001')
                wait_text(page, '#statusBootstrapFeedback', '/p2p')
                assert page.locator('#statusBootstrapFeedback').get_attribute('data-tone') == 'error'
                state = db_state()
                assert state['bootstrapRoles'] == [], state
                require_config_unchanged('B3-01')
                ui.shot('b3-01-wide-empty-and-invalid-1440')
                return {'config': require_config_unchanged('B3-01 receipt'), 'db': state}
            case('B3-01', 'new node has no default bootstrap and validates input', b3_01)

            def b3_02():
                add_bootstrap(page, ADDR_B)
                wait_text(page, '#statusBootstrapList', ADDR_B)
                wait_for(lambda: (lambda text: text if ('已保存' in text or '已连接' in text) else None)(
                    page.locator('#statusBootstrapList').inner_text()), 'saved or connected bootstrap status', 10)
                wait_bootstrap_status(page, '已连接')
                # Duplicate submit is idempotent, not a second role.
                add_bootstrap(page, ADDR_B)
                wait_text(page, '#statusBootstrapFeedback', '未重复添加')
                state = db_state()
                assert PEER_B in state['bootstrapRoles'], state
                assert PEER_B not in state['paused'], state
                config = require_config_unchanged('B3-02')
                reached = wait_for(lambda: (lambda d: d if d['bootstrapConnected'] >= 1 else None)(dht_state()),
                                   'real DHT bootstrap connection', 20)
                assert PEER_B in ' '.join(reached['bootstrapPeers']), reached
                ui.shot('b3-02-wide-saved-and-connected-1440')
                return {'config': config, 'db': state, 'dht': reached}
            case('B3-02', 'add saves one role, is idempotent, and reaches the real DHT', b3_02)

            def b3_03():
                restart_node('a', DIR_A)
                page.reload(wait_until='domcontentloaded')
                page.wait_for_timeout(1800)
                ui.viewport(1440, 900)
                ui.open_status()
                wait_text(page, '#statusBootstrapList', ADDR_B)
                wait_bootstrap_status(page, '已连接')
                state = db_state()
                assert PEER_B in state['bootstrapRoles'], state
                config = require_config_unchanged('B3-03')
                reached = wait_for(lambda: (lambda d: d if d['bootstrapConnected'] >= 1 else None)(dht_state()),
                                   'DHT bootstrap after restart', 20)
                ui.shot('b3-03-wide-persisted-after-restart-1440')
                return {'config': config, 'db': state, 'dht': reached}
            case('B3-03', 'A real restart keeps the persisted role and DHT candidate', b3_03)

            def b3_04():
                before = dht_state()
                run_cli(['disconnect', PEER_B, '--data-dir', str(DIR_A)])
                wait_for(lambda: (lambda state: state if PEER_B in state['paused'] else None)(db_state()), 'persistent pause', 10)
                time.sleep(6)
                after = dht_state()
                current = status()
                peer = next((p for p in current.get('peers', []) if p.get('peerId') == PEER_B), None)
                assert peer is None or not peer.get('online'), peer
                assert after['bootstrapConnected'] == 0, after
                assert after['lastBootstrapUnixMs'] <= before['lastBootstrapUnixMs'], (before, after)
                assert PEER_B in db_state()['paused']
                ui.open_status()
                wait_bootstrap_status(page, '已暂停', 15000)
                ui.shot('b3-04-wide-explicit-disconnect-paused-1440')
                require_config_unchanged('B3-04')
                return {'before': before, 'after': after, 'peer': peer}
            case('B3-04', 'explicit disconnect survives refresh and never silently redials', b3_04)

            def b3_05():
                ui.open_status()
                remove_bootstrap(page, PEER_B)
                wait_text(page, '#statusBootstrapNote', '尚未配置引导节点')
                state = db_state()
                assert PEER_B not in state['bootstrapRoles'], state
                assert PEER_B in state['paused'], state
                cached = next((item for item in state['knownPeers'] if item['peerId'] == PEER_B), None)
                assert cached is not None and ADDR_B in cached['addrs'], cached
                assert dht_state()['bootstrapPeers'] == [], dht_state()
                config = require_config_unchanged('B3-05')
                ui.shot('b3-05-wide-removed-role-kept-address-1440')
                return {'config': config, 'db': state}
            case('B3-05', 'remove drops only the role and keeps address/contact/pause records', b3_05)

            def b3_06():
                restart_node('a', DIR_A)
                page.reload(wait_until='domcontentloaded')
                page.wait_for_timeout(1800)
                ui.viewport(1440, 900)
                ui.open_status()
                wait_text(page, '#statusBootstrapNote', '尚未配置引导节点')
                state = db_state()
                assert state['bootstrapRoles'] == [], state
                assert PEER_B in state['paused'], state
                assert dht_state()['bootstrapPeers'] == [], dht_state()
                config = require_config_unchanged('B3-06')
                ui.shot('b3-06-wide-empty-after-restart-1440')
                return {'config': config, 'db': state}
            case('B3-06', 'restart after removal keeps the list empty', b3_06)

            def b3_07():
                ui.open_contacts()
                ui.add_contact(ADDR_C)
                page.wait_for_timeout(1500)
                # Close the add dialog if it stayed open.
                if page.locator('#addContactDialog').is_visible():
                    page.locator('#addContactDialog [data-close-dialog]').first.click()
                    page.wait_for_timeout(300)
                page.locator(f'[data-contact-row="{PEER_C}"]').wait_for(state='visible', timeout=15000)
                state = db_state()
                assert PEER_C in state['friends'], state
                assert state['bootstrapRoles'] == [], state
                config = require_config_unchanged('B3-07')
                ui.open_status()
                wait_text(page, '#statusBootstrapNote', '尚未配置引导节点')
                ui.shot('b3-07-wide-ordinary-contact-no-role-1440')
                return {'config': config, 'db': state}
            case('B3-07', 'ordinary contact add leaves config and bootstrap roles untouched', b3_07)

            def b3_08():
                ui.viewport(390, 844)
                ui.open_status()
                add_bootstrap(page, ADDR_B)
                wait_text(page, '#statusBootstrapList', ADDR_B)
                wait_text(page, '#statusBootstrapList', '已暂停')
                assert '已连接' not in page.locator('#statusBootstrapList').inner_text()
                assert ui.overflow() <= 0, ui.overflow()
                assert ui.bootstrap_overflow() == 0, ui.bootstrap_overflow()
                ui.shot('b3-08-narrow-saved-paused-390')
                remove_bootstrap(page, PEER_B)
                wait_text(page, '#statusBootstrapNote', '尚未配置引导节点')
                state = db_state()
                assert PEER_B not in state['bootstrapRoles'], state
                assert PEER_B in state['paused'], state
                assert dht_state()['bootstrapPeers'] == [], dht_state()
                require_config_unchanged('B3-08')
                ui.shot('b3-08-narrow-empty-390')
                return {'db': state, 'overflow': ui.overflow(), 'bootstrapOverflow': ui.bootstrap_overflow()}
            case('B3-08', 'narrow viewport can add/remove while pause state and layout stay honest', b3_08)

            RESULTS['final'] = {
                'config': require_config_unchanged('final receipt'),
                'db': db_state(),
                'dht': dht_state(),
                'status': status(),
            }
            save()
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:
            pass
        stop_host()
        for name in ('a', 'b', 'c'):
            data_dir = {'a': DIR_A, 'b': DIR_B, 'c': DIR_C}[name]
            try:
                stop_node(name, data_dir)
            except Exception:
                pass
        save()


if __name__ == '__main__':
    main()
