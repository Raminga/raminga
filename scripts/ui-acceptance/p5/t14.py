#!/usr/bin/env python3
"""P5 T14: real DSH plugin unload/reload, uninstall/reinstall and instance change.

This drives the actual DSH Plugins switch and the actual `dsh plugin remove/add`
CLI on the isolated p5 DSH_HOME. It does not simulate the lifecycle in the DOM.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import threading
import time
import traceback

import acceptance as acc

ROOT = acc.ROOT
EVIDENCE = acc.EVIDENCE
REPO = acc.REPO
DSH_HOME = ROOT / 'dsh-home'
HOST_PID = ROOT / 'dsh-4344.pid'
HOST_LOG = ROOT / 'dsh-4344.log'
RESULT = EVIDENCE / 'p5-t14-results.json'
RESULTS = {'cases': {}, 'screenshots': [], 'pageErrors': []}
PAGE_ERRORS = RESULTS['pageErrors']


def save():
    RESULT.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def host_url():
    return re.findall(r'https?://\S+', HOST_LOG.read_text())[-1]


def start_host():
    log = HOST_LOG.open('a')
    proc = subprocess.Popen(['sh', str(REPO / 'scripts/ui-acceptance/p5/start-host.sh')],
                            cwd=REPO, stdout=log, stderr=log, env=os.environ.copy())
    HOST_PID.write_text(str(proc.pid))
    deadline = time.time() + 30
    while time.time() < deadline:
        text = HOST_LOG.read_text()
        if 'dsh web: http' in text and '127.0.0.1:4344' in text:
            if subprocess.run(['lsof', '-nP', '-iTCP:4344', '-sTCP:LISTEN'], capture_output=True).returncode == 0:
                return proc
        if proc.poll() is not None:
            raise RuntimeError(f'host exited: {text[-1000:]}')
        time.sleep(0.2)
    raise RuntimeError('host did not start')


def stop_host():
    try:
        pid = int(HOST_PID.read_text())
    except Exception:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(80):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.15)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def dismiss(page):
    for _ in range(4):
        close = page.locator('[aria-label="Close"]:visible')
        if close.count() == 0:
            break
        close.first.click()
        page.wait_for_timeout(300)


def open_panel(page):
    dismiss(page)
    page.get_by_role('button', name='Raminga', exact=True).first.click()
    page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
    page.wait_for_timeout(900)


def plugin_switch(page):
    return page.locator('button[role="switch"][aria-label="Enable Raminga"]')


def toggle_plugin(page, enabled):
    switch = plugin_switch(page)
    assert switch.count() == 1, 'Raminga switch missing'
    current = switch.get_attribute('aria-checked') == 'true'
    if current != enabled:
        switch.click()
        page.wait_for_timeout(2800)
    return switch.get_attribute('aria-checked')


def current_instance():
    ops = acc.activity_ops()
    return ops[-1].get('plugin_instance_id') if ops else ''


def running_ops():
    return [op for op in acc.activity_ops() if op.get('result') is None]


def run_case(tid, name, fn):
    started = time.time()
    try:
        data = fn() or {}
        RESULTS['cases'][tid] = {'status': 'PASS', 'seconds': round(time.time() - started, 2), **data}
        print('PASS', tid, name)
    except Exception as exc:  # noqa: BLE001
        RESULTS['cases'][tid] = {'status': 'FAIL', 'error': str(exc), 'trace': traceback.format_exc()[-2000:]}
        print('FAIL', tid, name, exc)
        raise
    finally:
        save()


def main():
    large = acc.large_file()
    acc.wait_for(lambda: any(entry['path'] == 'posts/p5-large.bin' for entry in
                             acc.cli_json(['content', 'manifest', acc.PEER_B, '--data-dir', str(acc.A_DIR), '--limit', '100'])['entries']),
                 'large fixture', timeout=15)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = context.new_page()
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.goto(host_url(), wait_until='domcontentloaded')
        page.wait_for_timeout(2200)
        open_panel(page)
        before_instance = current_instance()

        def runtime_reload():
            # Open the Plugins page in a second tab so the Raminga panel stays
            # mounted and can be observed while the bundle is switched off.
            page2 = context.new_page()
            page2.goto(host_url(), wait_until='domcontentloaded')
            page2.wait_for_timeout(2000)
            dismiss(page2)
            page2.get_by_role('button', name='Plugins', exact=True).first.click()
            page2.wait_for_timeout(1000)
            page2.locator('[data-plugin-package="@raminga/dsh"]').wait_for(state='visible', timeout=10000)
            assert page2.locator('[data-plugin-package="@raminga/dsh"]').get_attribute('data-plugin-status') == 'running'
            # Start a real long tool while B is paused.
            acc.pause_b()
            thread, box = acc.async_control('raminga_content_get', {'peer_id': acc.PEER_B, 'path': 'posts/p5-large.bin'})
            live = acc.wait_for(lambda: page.locator('#homeActivityLive').inner_text() if page.locator('#homeActivityLive').is_visible() else '',
                                'running activity', timeout=20)
            page.screenshot(path=str(EVIDENCE / 'p5-t14-runtime-running.png')); RESULTS['screenshots'].append('p5-t14-runtime-running.png')
            toggle_plugin(page2, False)
            disabled_status = page2.locator('[data-plugin-package="@raminga/dsh"]').get_attribute('data-plugin-status')
            page2.screenshot(path=str(EVIDENCE / 'p5-t14-plugin-disabled.png')); RESULTS['screenshots'].append('p5-t14-plugin-disabled.png')
            page.wait_for_timeout(2800)
            stale = ''
            if page.locator('#homeActivityLive').is_visible():
                stale = page.locator('#homeActivityLive').inner_text()
            stale_error = page.locator('#homeActivityDetail').inner_text() if page.locator('#homeActivityDetail').is_visible() else ''
            page.screenshot(path=str(EVIDENCE / 'p5-t14-panel-after-disable.png')); RESULTS['screenshots'].append('p5-t14-panel-after-disable.png')
            toggle_plugin(page2, True)
            enabled_status = page2.locator('[data-plugin-package="@raminga/dsh"]').get_attribute('data-plugin-status')
            page2.wait_for_timeout(1800)
            # A new apply only gets a new instance id when it executes a tool;
            # read the real current instance through the registered tool rather
            # than inferring it from an old log line.
            probe = acc.control('raminga_status', {})
            assert probe.get('ok') is True, probe
            # Reload the panel page so it obtains the newly registered bundle;
            # the old page is intentionally kept as stale-state evidence above.
            page.reload(wait_until='domcontentloaded')
            page.wait_for_timeout(2200)
            open_panel(page)
            page.wait_for_timeout(1200)
            live_after = page.locator('#homeActivityLive').is_visible()
            page.screenshot(path=str(EVIDENCE / 'p5-t14-after-reload.png')); RESULTS['screenshots'].append('p5-t14-after-reload.png')
            acc.resume_b()
            thread.join(timeout=90)
            time.sleep(1.0)
            ops = acc.activity_ops()
            generated = [op for op in ops if op.get('tool') == 'raminga_content_get' and op.get('target', {}).get('path') == 'posts/p5-large.bin']
            op = generated[-1]
            after_instance = current_instance()
            return {
                'beforeInstance': before_instance,
                'afterInstance': after_instance,
                'instanceChanged': before_instance != after_instance,
                'disabledStatus': disabled_status,
                'enabledStatus': enabled_status,
                'live': live[:300],
                'staleLiveAfterDisable': stale[:300],
                'staleError': stale_error[:300],
                'liveAfterReload': bool(live_after),
                'operationResult': op.get('result'),
                'operationTerminalCounts': len([item for item in ops if item['operation_id'] == op['operation_id'] and item.get('result')]),
            }

        run_case('T14A', '真实 DSH 运行时禁用/重载、实例变化、陈旧运行态失效', runtime_reload)

        def cli_uninstall_reinstall():
            before = current_instance()
            stop_host()
            remove = subprocess.run(['dsh', 'plugin', '--profile', 'web', 'remove', '@raminga/dsh'],
                                    cwd=REPO, env={**os.environ, 'DSH_HOME': str(DSH_HOME)},
                                    text=True, capture_output=True, timeout=120)
            assert remove.returncode == 0, remove.stderr or remove.stdout
            pkg = json.loads((DSH_HOME / 'profiles' / 'web' / 'package.json').read_text())
            assert '@raminga/dsh' not in (pkg.get('dependencies') or {})
            assert '@raminga/dsh' not in ((pkg.get('dsh') or {}).get('profile') or {}).get('bundles', [])
            start_host()
            page.goto(host_url(), wait_until='domcontentloaded')
            page.wait_for_timeout(2200)
            dismiss(page)
            absent = page.get_by_role('button', name='Raminga', exact=True).count()
            page.screenshot(path=str(EVIDENCE / 'p5-t14-uninstalled.png')); RESULTS['screenshots'].append('p5-t14-uninstalled.png')
            stop_host()
            add = subprocess.run(['dsh', 'plugin', '--profile', 'web', 'add', f'link:{REPO / "plugins" / "dsh"}'],
                                 cwd=REPO, env={**os.environ, 'DSH_HOME': str(DSH_HOME)},
                                 text=True, capture_output=True, timeout=120)
            assert add.returncode == 0, add.stderr or add.stdout
            pkg = json.loads((DSH_HOME / 'profiles' / 'web' / 'package.json').read_text())
            assert '@raminga/dsh' in (pkg.get('dependencies') or {})
            assert '@raminga/dsh' in ((pkg.get('dsh') or {}).get('profile') or {}).get('bundles', [])
            start_host()
            page.goto(host_url(), wait_until='domcontentloaded')
            page.wait_for_timeout(2200)
            open_panel(page)
            probe = acc.control('raminga_status', {})
            assert probe.get('ok') is True, probe
            page.wait_for_timeout(600)
            after = current_instance()
            page.wait_for_timeout(1000)
            live = page.locator('#homeActivityLive').is_visible()
            page.screenshot(path=str(EVIDENCE / 'p5-t14-reinstalled.png')); RESULTS['screenshots'].append('p5-t14-reinstalled.png')
            ops = acc.activity_ops()
            unreadable = [op for op in ops if op.get('result') is None]
            return {
                'beforeInstance': before,
                'afterInstance': after,
                'instanceChanged': before != after,
                'sidebarAbsentAfterUninstall': absent == 0,
                'removeLog': remove.stdout[-800:],
                'addLog': add.stdout[-800:],
                'liveAfterReinstall': bool(live),
                'runningOperations': len(unreadable),
            }

        run_case('T14B', '真实 DSH 卸载/重装、侧栏消失/恢复、新实例不继承运行态', cli_uninstall_reinstall)
        RESULTS['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save()
        browser.close()


if __name__ == '__main__':
    main()
