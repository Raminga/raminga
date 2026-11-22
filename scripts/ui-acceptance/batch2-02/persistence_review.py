#!/usr/bin/env python3
"""Independent real-DSH review of second-batch item 2's local projection.

This script is intentionally run after acceptance.py has prepared the fixture
and has exercised the verified profile/address-book reads. It proves that the
contact list now reuses those verified public facts after:

  * a full page reload,
  * a brand-new Chromium process,
  * a DSH Web host restart (a new application run),
  * the clue/profile source node going offline,
  * missing, corrupted and wrong-version local cache data.

It also checks that entering the list does not change node contacts or add a
connection to the offline row or the unvisited clue target. It only uses the
isolated b2-contacts fixture and its recorded host port.
"""
from playwright.sync_api import sync_playwright
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import traceback

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import acceptance as base  # noqa: E402 - reuse the isolated fixture lifecycle

ROOT = base.ROOT
REPO = base.REPO
FIXTURE = base.FIXTURE
EVIDENCE = base.EVIDENCE
PEER_B = FIXTURE['nodeB']
PEER_C = FIXTURE['nodeC']
PEER_D = FIXTURE['offlinePeer']
PEER_E = FIXTURE['cluePeer']
PROJECTION = pathlib.Path(FIXTURE['nodeAData']) / 'agent' / 'host' / 'dsh' / 'contact-list.json'
AVATAR = pathlib.Path(FIXTURE['nodeAData']) / 'downloads' / PEER_B / FIXTURE['avatar']['path']
RESULT_FILE = EVIDENCE / 'b2-contact-persistence-results.json'
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'fixture': str(ROOT / 'fixture.json'),
    'hostPort': base.HOST_PORT,
    'controlPort': base.CONTROL_PORT,
    'cases': {},
    'screenshots': [],
    'hostLogs': [],
    'pageErrors': [],
    'consoleErrors': [],
}
base.RESULTS = RESULTS
base.EVIDENCE = EVIDENCE
base.RESULT_FILE = RESULT_FILE


def save():
    RESULTS['status'] = 'PASS' if RESULTS['cases'] and all(
        item.get('status') == 'PASS' for item in RESULTS['cases'].values()
    ) else 'FAIL'
    RESULT_FILE.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


base.save = save


def case(cid, name, fn):
    started = time.time()
    try:
        data = fn() or {}
        RESULTS['cases'][cid] = {
            'id': cid, 'name': name, 'status': 'PASS',
            'seconds': round(time.time() - started, 2), **data,
        }
        print(f'PASS {cid} {name}')
    except Exception as exc:  # noqa: BLE001 - record the real failure
        RESULTS['cases'][cid] = {
            'id': cid, 'name': name, 'status': 'FAIL',
            'seconds': round(time.time() - started, 2),
            'error': str(exc), 'trace': traceback.format_exc()[-5000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
    finally:
        save()


def launch(playwright, width=1440, height=900):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': width, 'height': height})
    page = context.new_page()
    page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
    page.on('console', lambda message: RESULTS['consoleErrors'].append(message.text)
            if message.type == 'error' else None)
    return browser, context, page


def open_contacts(page, url, width=1440, height=900):
    page.goto(url, wait_until='domcontentloaded')
    page.wait_for_timeout(1400)
    ui = base.UI(page)
    ui.wide = width >= 700
    ui.contacts()
    return ui


def assert_persisted(ui, *, expect_avatar=True, expect_clue=True, expected_name=None):
    row = ui.row(PEER_B)
    name = row.locator('.rm-contact-name b').inner_text().strip()
    expected = expected_name or FIXTURE['publicB']['displayName']
    assert name == expected, f'contact name = {name!r}, expected {expected!r}'
    avatar = row.locator('.rm-contact-avatar img')
    if expect_avatar:
        base.wait_for(lambda: avatar.count() > 0, 'persisted avatar', 15)
        src = avatar.get_attribute('src')
        assert src.startswith('data:image/png;base64,'), 'persisted avatar is not a verified local data URL'
        assert avatar.evaluate('(node) => node.naturalWidth') > 0
        assert row.locator('.rm-contact-avatar').get_attribute('data-kind') == 'image'
    else:
        assert avatar.count() == 0, 'damaged avatar must not be shown'
        assert row.locator('.rm-contact-avatar').get_attribute('data-kind') == 'initial'
    if expect_clue:
        clue = ui.page.locator(f'[data-clue-peer="{PEER_E}"]')
        clue.wait_for(state='visible', timeout=15000)
        assert ui.page.locator('#contactClues').is_visible()
        assert '未访问' in clue.inner_text()
        assert FIXTURE['clueName'] in clue.inner_text()
        assert FIXTURE['publicB']['displayName'] in clue.inner_text()
        return {'name': name, 'avatar': 'ready' if expect_avatar else 'absent', 'clue': 'visible'}
    assert ui.page.locator('#contactClues').is_hidden(), 'no valid clue evidence should mean no clue section'
    return {'name': name, 'avatar': 'ready' if expect_avatar else 'absent', 'clue': 'hidden'}


def projection_metadata():
    value = json.loads(PROJECTION.read_text())
    assert value['schema_version'] == 1
    b = next(item for item in value['profiles'] if item['peer_id'] == PEER_B)
    assert b['display_name'] == FIXTURE['publicB']['displayName']
    assert b['avatar']['sha256'] == FIXTURE['avatar']['sha256']
    assert b['avatar']['size'] == FIXTURE['avatar']['bytes']
    clue = next(item for item in value['clues'] if item['peer_id'] == PEER_E)
    assert clue['source_peer_id'] == PEER_B
    raw = PROJECTION.read_text()
    assert 'data:' not in raw and 'blob:' not in raw and 'avatarUrl' not in raw and 'avatar_url' not in raw
    assert str(FIXTURE['nodeAData']) not in raw
    mode = PROJECTION.stat().st_mode & 0o777
    assert mode == 0o600, f'projection mode is {oct(mode)}, expected 0o600'
    assert not (pathlib.Path(FIXTURE['nodeAData']) / 'public' / 'contact-list.json').exists()
    digest = hashlib.sha256(AVATAR.read_bytes()).hexdigest()
    assert digest == FIXTURE['avatar']['sha256']
    return {'bytes': PROJECTION.stat().st_size, 'mode': oct(mode), 'projection': str(PROJECTION), 'avatar': str(AVATAR)}


def start_clean_host():
    host, url = base.start_host()
    return host, url


host, url = start_clean_host()
browsers = []
try:
    with sync_playwright() as playwright:
        # Setup: make the explicit profile + address-book reads that create the
        # evidence. Everything after this must be a local projection read.
        browser, context, page = launch(playwright)
        browsers.append(browser)
        ui = open_contacts(page, url, 1440, 900)
        ui.row(PEER_B).locator('button[data-contact-peer]').click()
        page.locator('#profileView').wait_for(state='visible', timeout=15000)
        base.wait_for(lambda: page.locator('#profileAvatar img').count() > 0, 'profile avatar', 15)
        page.locator('[data-profile-tab="address"]').click()
        page.locator(f'[data-clue-peer="{PEER_E}"]').wait_for(state='attached', timeout=15000)
        page.locator('#profileBack').click()
        ui.contacts()
        assert PROJECTION.exists(), f'host did not persist {PROJECTION}'
        assert AVATAR.exists(), f'profile avatar was not retained at {AVATAR}'
        RESULTS['projectionAfterSetup'] = projection_metadata()

        def persist_reload():
            nonlocal_page = page
            nonlocal_page.goto(url, wait_until='domcontentloaded')
            nonlocal_page.wait_for_timeout(1200)
            reload_ui = base.UI(nonlocal_page)
            reload_ui.wide = True
            reload_ui.contacts()
            data = assert_persisted(reload_ui)
            reload_ui.shot('review-persisted-after-full-reload-1440')
            return data

        case('PERSIST-01', 'Full page reload reuses the verified public name/avatar and the directory clue', persist_reload)

        def persist_new_browser():
            new_browser, new_context, new_page = launch(playwright, 1440, 900)
            browsers.append(new_browser)
            try:
                new_ui = open_contacts(new_page, url, 1440, 900)
                before = base.node_snapshot()
                data = assert_persisted(new_ui)
                after = base.node_snapshot()
                base.no_target_side_effects(after, before)
                assert set(before['friends']) == set(after['friends']), 'entering the contact list changed local contacts'
                new_ui.shot('review-persisted-new-browser-1440')
                return {**data, 'friendsUnchanged': True, 'connections': len(after['connections'])}
            finally:
                try:
                    new_context.close()
                finally:
                    new_browser.close()

        case('PERSIST-02', 'A brand-new browser process sees the same verified facts without node side effects', persist_new_browser)

        def persist_host_restart_narrow():
            global host
            # Close the first browser completely, then restart the DSH Web
            # process: this is the "reopen the application" path.
            for item in list(browsers):
                try:
                    item.close()
                except Exception:  # noqa: BLE001 - already closed
                    pass
                browsers.remove(item)
            base.stop_host(host)
            new_host, new_url = start_clean_host()
            host = new_host
            RESULTS['restartedHostPort'] = base.HOST_PORT
            new_browser, new_context, new_page = launch(playwright, 390, 844)
            browsers.append(new_browser)
            try:
                new_ui = open_contacts(new_page, new_url, 390, 844)
                mobile = new_page.locator('#mobileNav')
                assert mobile.is_visible(), 'narrow layout needs the bottom navigation'
                assert new_page.locator('#desktopNav').is_hidden()
                assert new_ui.overflow() <= 1
                data = assert_persisted(new_ui)
                new_ui.shot('review-persisted-host-restart-390')
                return {**data, 'hostRestarted': True, 'overflow': new_ui.overflow()}
            finally:
                try:
                    new_context.close()
                finally:
                    new_browser.close()

        restart_result = {}

        def restart_case_wrapper():
            nonlocal_result = persist_host_restart_narrow()
            restart_result.update(nonlocal_result)
            return nonlocal_result

        case('PERSIST-03', 'A restarted DSH host and a new browser still show the same facts at 390x844', restart_case_wrapper)

        def persist_source_offline():
            stop = subprocess.run(
                [str(REPO / 'bin' / 'raminga'), 'stop', '--data-dir', FIXTURE['nodeBData']],
                capture_output=True, text=True, timeout=20000,
            )
            assert stop.returncode == 0, f'could not stop source node: {stop.stderr or stop.stdout}'
            time.sleep(1.5)
            new_browser, new_context, new_page = launch(playwright, 1440, 900)
            browsers.append(new_browser)
            try:
                new_ui = open_contacts(new_page, current_url(), 1440, 900)
                data = assert_persisted(new_ui)
                new_ui.shot('review-persisted-source-offline-list-1440')
                snap_before = base.node_snapshot()
                clue = new_page.locator(f'[data-clue-peer="{PEER_E}"]')
                clue.locator('[data-view-clue]').click()
                notice = new_page.locator('#noticeDialog')
                notice.wait_for(state='visible', timeout=5000)
                assert PEER_E in notice.inner_text()
                snap_after = base.node_snapshot()
                base.no_target_side_effects(snap_after, snap_before)
                new_ui.shot('review-persisted-source-offline-1440')
                return {**data, 'sourceStopped': True, 'clueViewedWithoutDial': True}
            finally:
                try:
                    new_context.close()
                finally:
                    new_browser.close()

        def current_url():
            log = (EVIDENCE / 'host-b2-contact-list.log').read_text(errors='replace')
            import re
            matches = re.findall(r'http://127\.0\.0\.1:%d/\S+' % base.HOST_PORT, log)
            assert matches, 'host log has no URL'
            return matches[-1]

        case('PERSIST-04', 'With the source (and clue target) offline, the name/avatar/clue remain and viewing the clue dials nothing', persist_source_offline)

        def persist_damaged_avatar():
            original = AVATAR.read_bytes()
            try:
                AVATAR.write_bytes(b'not a png')
                new_browser, new_context, new_page = launch(playwright, 1440, 900)
                browsers.append(new_browser)
                try:
                    new_ui = open_contacts(new_page, current_url(), 1440, 900)
                    data = assert_persisted(new_ui, expect_avatar=False)
                    new_ui.shot('review-persisted-damaged-avatar-1440')
                    return data
                finally:
                    try:
                        new_context.close()
                    finally:
                        new_browser.close()
            finally:
                AVATAR.write_bytes(original)

        case('PERSIST-05', 'A damaged local avatar is not displayed under the saved version; the name remains usable', persist_damaged_avatar)

        def persist_bad_projection():
            original = PROJECTION.read_bytes()
            observations = {}
            try:
                for label, payload in [
                    ('invalid-json', b'{bad json'),
                    ('wrong-schema', json.dumps({'schema_version': 2, 'profiles': [], 'clues': []}).encode()),
                    ('wrong-avatar-sha', json.dumps({
                        'schema_version': 1,
                        'updated_at': int(time.time() * 1000),
                        'profiles': [{
                            'peer_id': PEER_B,
                            'display_name': FIXTURE['publicB']['displayName'],
                            'description': '',
                            'interests': [],
                            'conversation_style': '',
                            'avatar': {
                                'path': FIXTURE['avatar']['path'],
                                'sha256': '0' * 64,
                                'mime': 'image/png',
                                'size': FIXTURE['avatar']['bytes'],
                            },
                            'source': 'remote-profile',
                            'verified_at': int(time.time() * 1000),
                        }],
                        'clues': [],
                    }).encode()),
                ]:
                    PROJECTION.write_bytes(payload)
                    new_browser, new_context, new_page = launch(playwright, 1440, 900)
                    browsers.append(new_browser)
                    try:
                        new_ui = open_contacts(new_page, current_url(), 1440, 900)
                        # Corrupt/missing cache must fall back to the local
                        # friend record, never crash or invent a public image.
                        row = new_ui.row(PEER_B)
                        expected_name = (FIXTURE['publicB']['displayName']
                                         if label == 'wrong-avatar-sha' else FIXTURE['localB']['name'])
                        assert row.locator('.rm-contact-name b').inner_text().strip() == expected_name
                        assert row.locator('.rm-contact-avatar img').count() == 0
                        assert new_ui.page.locator('#contactClues').is_hidden()
                        observations[label] = 'public-name-without-avatar' if label == 'wrong-avatar-sha' else 'fallback'
                        if label == 'invalid-json':
                            new_ui.shot('review-persisted-invalid-projection-1440')
                    finally:
                        try:
                            new_context.close()
                        finally:
                            new_browser.close()
                PROJECTION.unlink()
                new_browser, new_context, new_page = launch(playwright, 1440, 900)
                browsers.append(new_browser)
                try:
                    new_ui = open_contacts(new_page, current_url(), 1440, 900)
                    assert new_ui.row(PEER_B).locator('.rm-contact-name b').inner_text().strip() == FIXTURE['localB']['name']
                    assert new_ui.page.locator('#contactClues').is_hidden()
                    observations['missing'] = 'fallback'
                    new_ui.shot('review-persisted-missing-projection-1440')
                finally:
                    try:
                        new_context.close()
                    finally:
                        new_browser.close()
            finally:
                PROJECTION.write_bytes(original)
                os.chmod(PROJECTION, 0o600)
            # Restored projection is read again (proves the fallback was not a
            # one-way destructive state).
            new_browser, new_context, new_page = launch(playwright, 1440, 900)
            browsers.append(new_browser)
            try:
                new_ui = open_contacts(new_page, current_url(), 1440, 900)
                restored = assert_persisted(new_ui)
                new_ui.shot('review-persisted-restored-projection-1440')
                return {**observations, 'restored': restored, 'notDestructive': True}
            finally:
                try:
                    new_context.close()
                finally:
                    new_browser.close()

        case('PERSIST-06', 'Invalid, wrong-schema, wrong-hash and missing projections fall back safely and do not destroy real contacts', persist_bad_projection)

        def persist_projection_files():
            data = projection_metadata()
            data['avatarsInProjection'] = 0
            data['projectionInPublic'] = False
            return data

        case('PERSIST-07', 'The projection is private, path-free, URL-free, checksum-versioned and outside public/', persist_projection_files)

        def persist_no_side_effects():
            new_browser, new_context, new_page = launch(playwright, 1440, 900)
            browsers.append(new_browser)
            try:
                new_ui = open_contacts(new_page, current_url(), 1440, 900)
                before = base.node_snapshot()
                data = assert_persisted(new_ui)
                after = base.node_snapshot()
                assert before['friends'] == after['friends'], 'list view changed local contacts'
                assert PEER_E not in after['connections']
                assert PEER_E not in after['friends']
                assert PEER_D not in after['connections']
                assert PEER_D in after['friends']
                # A full page reload is another mount; it must still be local.
                new_page.reload(wait_until='domcontentloaded')
                new_page.wait_for_timeout(1400)
                new_ui.contacts()
                again = assert_persisted(new_ui)
                final = base.node_snapshot()
                assert final['friends'] == after['friends']
                assert PEER_E not in final['connections']
                return {**data, **again, 'friendsUnchanged': True, 'clueTargetNotDialed': True}
            finally:
                try:
                    new_context.close()
                finally:
                    new_browser.close()

        case('PERSIST-08', 'Entering/reloading the contact list changes no contacts and dials neither the offline row nor the clue target', persist_no_side_effects)

        for item in list(browsers):
            try:
                item.close()
            except Exception:  # noqa: BLE001 - already closed
                pass
finally:
    for item in list(browsers):
        try:
            item.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
    base.stop_host(host)
    save()

if __name__ == '__main__':
    pass
