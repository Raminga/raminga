#!/usr/bin/env python3
"""P5 T15 UI: boot the isolated DSH host on the migrated schema-9 directory and
walk the old profile/posts/contacts/messages/discovery through the real UI."""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import signal
import subprocess
import time
import traceback

ROOT = pathlib.Path(os.environ.get('P5_ACCEPTANCE_DIR', '.local/ui-refresh-20261117/p5')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'evidence'
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
LIVE = ROOT / 'upgrade-live'
DSH_HOME = ROOT / 'dsh-home'
PORT = 4345
LOG = ROOT / 'dsh-4345.log'
PID = ROOT / 'dsh-4345.pid'
RESULT = EVIDENCE / 'p5-t15-ui-results.json'
RESULTS = {'cases': {}, 'screenshots': [], 'pageErrors': []}
PAGE_ERRORS = RESULTS['pageErrors']


def save():
    RESULT.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def stop_host():
    if not PID.exists():
        return
    try:
        os.kill(int(PID.read_text()), signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(1.2)
    try:
        os.kill(int(PID.read_text()), signal.SIGKILL)
    except ProcessLookupError:
        pass


def start_host():
    LOG.write_text('')
    env = {**os.environ, 'P5_DATA_DIR': str(LIVE), 'P5_HOST_PORT': str(PORT), 'P5_DSH_HOME': str(DSH_HOME)}
    env.pop('DSH_PROFILE', None)
    out = LOG.open('a')
    proc = subprocess.Popen(['sh', str(REPO / 'scripts/ui-acceptance/p5/start-host.sh')], cwd=REPO, env=env, stdout=out, stderr=out)
    PID.write_text(str(proc.pid))
    deadline = time.time() + 35
    while time.time() < deadline:
        text = LOG.read_text()
        urls = re.findall(r'https?://\S+', text)
        if urls and 'dsh web: http' in text:
            return urls[-1]
        if proc.poll() is not None:
            raise RuntimeError(text[-1500:])
        time.sleep(0.2)
    raise RuntimeError('T15 host did not start')


def dismiss(page):
    for _ in range(4):
        close = page.locator('[aria-label="Close"]:visible')
        if close.count() == 0:
            break
        close.first.click()
        page.wait_for_timeout(300)


def open_panel(page, wide=True):
    dismiss(page)
    if not wide:
        toggle = page.locator('[aria-label="Open sidebar"]:visible')
        if toggle.count():
            toggle.first.click()
            page.wait_for_timeout(600)
    page.get_by_role('button', name='Raminga', exact=True).first.click()
    page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
    page.wait_for_timeout(1000)


def nav(page, item, wide=True):
    selector = '#desktopNav' if wide else '#mobileNav'
    page.locator(f'{selector} [data-nav="{item}"]').click()
    page.wait_for_timeout(900)


def shot(page, name):
    path = EVIDENCE / f'{name}.png'
    page.screenshot(path=str(path))
    RESULTS['screenshots'].append(name)
    save()


def main():
    stop_host()
    url = start_host()
    RESULTS['url'] = url
    RESULTS['liveDir'] = str(LIVE)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_timeout(2400)
        open_panel(page, True)
        started = time.time()
        checks = {}
        try:
            checks['homeAgent'] = page.locator('#homeAgentName').inner_text()
            assert checks['homeAgent'] == '旧岸灯', checks
            human = page.locator('#home-human-strip').inner_text()
            assert '旧版林岸' in human, human
            empty = page.locator('#homeActivityEmpty').inner_text()
            assert '没有' in empty or '记录' in empty, empty
            checks['empty'] = empty
            checks['journeyCount'] = page.locator('#ramingaSessionList .rm-journey').count() if page.locator('#ramingaSessionList').count() else 0
            assert checks['journeyCount'] == 0, checks['journeyCount']
            shot(page, 'p5-t15-home-wide')
            nav(page, 'contacts', True)
            contacts = page.locator('#contactList').inner_text()
            assert '旧联系人·澄野' in contacts or 'chengye' in contacts, contacts
            checks['contacts'] = contacts[:500]
            shot(page, 'p5-t15-contacts-wide')
            page.locator('#contactsMessages').click()
            page.wait_for_timeout(1200)
            page.locator(f'#conversationList [data-conversation-peer="{FIXTURE["nodeB"]}"]').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            page.wait_for_timeout(1500)
            messages = page.locator('#messageList').inner_text()
            assert '升级前的第一条消息' in messages or '旧消息' in messages, messages[:1200]
            checks['messages'] = messages[:500]
            shot(page, 'p5-t15-conversation-wide')
            nav(page, 'explore', True)
            page.locator('[data-filter="all"]').click()
            page.wait_for_timeout(1200)
            discovery = page.locator('#discoveryList').inner_text()
            assert '一张旧唱片的反面' in discovery or 'posts/p5-b2/post.json' in discovery, discovery[:1000]
            checks['discovery'] = discovery[:500]
            shot(page, 'p5-t15-explore-wide')
            page.locator('#settingsTrigger').click()
            page.wait_for_timeout(700)
            page.locator('#settingsIndex .rm-settings-item[data-settings-tab="public"]').click()
            page.wait_for_timeout(1200)
            public = page.locator('#settings-public').inner_text()
            agent_name = page.locator('#publicAgentName').input_value()
            human_name = page.locator('#publicHumanName').input_value()
            assert agent_name == '旧岸灯', agent_name
            assert human_name == '旧版林岸', human_name
            assert '我的公开文件' in public and 'legacy-user' in public, public[:1200]
            checks['settingsPublic'] = {'agentName': agent_name, 'humanName': human_name, 'text': public[:500]}
            shot(page, 'p5-t15-settings-public-wide')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(900)
            assert page.evaluate('document.documentElement.scrollWidth - window.innerWidth') == 0
            shot(page, 'p5-t15-settings-public-narrow')
            # Narrow home is a fresh small-screen walk of the same old data.
            page.locator('#settingsTrigger').click()
            page.wait_for_timeout(500)
            nav(page, 'home', False)
            shot(page, 'p5-t15-home-narrow')
            nav(page, 'contacts', False)
            shot(page, 'p5-t15-contacts-narrow')
            RESULTS['cases']['T15UI'] = {'status': 'PASS', 'seconds': round(time.time() - started, 2), **checks}
            print('PASS T15UI', checks)
        except Exception as exc:  # noqa: BLE001
            RESULTS['cases']['T15UI'] = {'status': 'FAIL', 'error': str(exc), 'trace': traceback.format_exc()[-2000:]}
            print('FAIL T15UI', exc)
            page.screenshot(path=str(EVIDENCE / 'p5-t15-fail.png'))
            raise
        finally:
            RESULTS['pageErrors'] = PAGE_ERRORS
            save()
            browser.close()
    stop_host()
    subprocess.run([str(REPO / 'bin' / 'raminga'), 'stop', '--data-dir', str(LIVE)], capture_output=True, timeout=20)


if __name__ == '__main__':
    main()
