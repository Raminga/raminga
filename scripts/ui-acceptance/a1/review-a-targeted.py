#!/usr/bin/env python3
"""Targeted re-run of the user's review-a.py against an isolated host.

The user's original `.local/prototype-remediation/review-a.py` reads the 4354
Codex instance and takes the narrow screenshot before the host sidebar finishes
collapsing. This copy keeps the same functional steps, takes the URL from the
isolated A1 host log, and waits for the host shell to hand the whole viewport to
the panel plus for the image to decode before taking evidence screenshots.

Usage:
  A1_ACCEPTANCE_DIR=.local/prototype-remediation/a-fix-run \
  A1_HOST_PORT=4360 python3 scripts/ui-acceptance/a1/review-a-targeted.py
"""
import os
import pathlib
import re
import time

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(os.environ.get('A1_ACCEPTANCE_DIR', '.local/prototype-remediation/a-fix-run')).resolve()
PORT = os.environ.get('A1_HOST_PORT', '4360')
OUT = pathlib.Path(os.environ.get('A1_REVIEW_OUT', '.local/prototype-remediation')).resolve()
URL = re.findall(r'http://127\.0\.0\.1:%s/\S+' % re.escape(PORT), (ROOT / f'dsh-{PORT}.log').read_text())[-1]


def wait_for(fn, label, timeout=20):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            value = fn()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - report the real last error
            last = error
        time.sleep(0.2)
    raise AssertionError(f'timed out waiting for {label}: {last}')


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_timeout(3000)
    dismiss = page.locator('[aria-label="Close"]:visible, [aria-label="关闭"]:visible')
    if dismiss.count():
        dismiss.first.click()
        page.wait_for_timeout(400)
    page.get_by_role('button', name='Raminga', exact=True).first.click()
    page.wait_for_timeout(700)
    page.locator('#desktopNav [data-nav=explore]').click()
    page.wait_for_timeout(1200)
    cards = page.locator('#discoveryList .rm-post')
    expect(cards).to_have_count(3, timeout=20000)
    wait_for(lambda: page.locator('#discoveryList .rm-post-media-img').evaluate_all(
        'imgs => imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)'),
        'wide feed image decoded')
    page.screenshot(path=str(OUT / 'a-review-wide.png'))

    page.locator('[data-filter=familiar]').click()
    expect(cards).to_have_count(3, timeout=15000)
    page.locator('#exploreSearchToggle').click()
    page.locator('#exploreQuery').fill('雨停')
    expect(cards).to_have_count(1)
    cards.locator('.rm-post-open').click()
    expect(page.locator('#postDetail')).to_contain_text('雨停之后的城市植物')
    media = page.locator('#postDetail .rm-post-media')
    body = page.locator('#postDetail .rm-post-detail-body')
    assert media.bounding_box()['x'] < body.bounding_box()['x']
    # The user's instruction: wait for the host sidebar to collapse and for the
    # image to actually decode before the narrow screenshot.
    page.set_viewport_size({'width': 390, 'height': 844})
    wait_for(lambda: (lambda box: box is not None and box['x'] <= 1)(page.locator('#page-post').bounding_box()),
             'host sidebar collapsed on narrow detail')
    assert media.bounding_box()['y'] < body.bounding_box()['y']
    wait_for(lambda: page.locator('#postDetail .rm-post-media-img').evaluate_all(
        'imgs => imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)'),
        'narrow detail image decoded')
    page.screenshot(path=str(OUT / 'a-review-narrow.png'))

    page.locator('#postDetail .rm-post-media-item').first.click()
    expect(page.locator('#imagePreviewDialog')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#imagePreviewDialog')).to_be_hidden()
    page.locator('#postBack').click()
    expect(page.locator('#exploreQuery')).to_have_value('雨停')
    expect(cards.locator('.rm-post-open')).to_be_focused()

    page.set_viewport_size({'width': 1440, 'height': 900})
    page.wait_for_timeout(900)
    page.locator('#desktopNav [data-nav=contacts]').click()
    page.locator('#contactList [data-contact-peer]').first.click()
    page.locator('#profileFilesOpen').click()
    files = page.locator('#profileFileList')
    expect(files).to_contain_text('friends.json', timeout=15000)
    hello = files.locator('.rm-post', has_text='hello.txt').first
    hello.locator('.rm-post-toggle').click()
    expect(hello).to_contain_text('普通的公开文本附件')
    bad = files.locator('.rm-post', has_text='broken.txt').first
    bad.locator('.rm-post-toggle').click()
    expect(bad).to_contain_text(re.compile('哈希|SHA-256'))
    page.locator('#profileFilesClose').click()
    expect(page.locator('#profileView')).to_be_visible()
    page.locator('#profileBack').click()
    page.locator('#settingsTrigger').click()
    page.locator('#settingsIndex [data-settings-tab=public]').click()
    expect(page.locator('#minePostList')).to_contain_text('friends.json')
    print('Targeted review-a checks passed')
    print('wide:', OUT / 'a-review-wide.png')
    print('narrow:', OUT / 'a-review-narrow.png')
    browser.close()
