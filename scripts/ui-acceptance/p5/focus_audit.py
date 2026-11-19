#!/usr/bin/env python3
"""Narrow-screen focus/safe-area/keyboard-shrink audit for P5."""
from playwright.sync_api import sync_playwright
import json
import pathlib
import re
import subprocess
import time

ROOT = pathlib.Path('.local/ui-refresh-20261117/p5').resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'evidence'
RESULTS = {'checks': {}, 'focusPath': [], 'screenshots': [], 'pageErrors': []}


def save():
    (EVIDENCE / 'p5-focus-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def active(page):
    return page.evaluate("""() => {
      const panel = document.querySelector('[data-raminga-panel]');
      const root = panel && panel.shadowRoot ? panel.shadowRoot : document;
      const el = root.activeElement || document.activeElement;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {tag: el.tagName, id: el.id, aria: el.getAttribute('aria-label'), text: (el.innerText || '').slice(0, 40),
              outline: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset};
    }""")


def main():
    log = ROOT / 'dsh-4344.log'
    log.write_text('')
    out = log.open('a')
    proc = subprocess.Popen(['sh', str(REPO / 'scripts/ui-acceptance/p5/start-host.sh')], cwd=REPO, stdout=out, stderr=out)
    (ROOT / 'dsh-4344.pid').write_text(str(proc.pid))
    url = ''
    for _ in range(120):
        urls = re.findall(r'https?://\S+', log.read_text())
        if urls and 'dsh web: http' in log.read_text():
            url = urls[-1]
            break
        time.sleep(0.25)
    if not url:
        raise RuntimeError(log.read_text()[-1000:])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.on('pageerror', lambda error: RESULTS['pageErrors'].append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_timeout(2400)
        for _ in range(4):
            close = page.locator('[aria-label="Close"]:visible')
            if close.count() == 0:
                break
            close.first.click()
            page.wait_for_timeout(300)
        toggle = page.locator('[aria-label="Open sidebar"]:visible')
        if toggle.count():
            toggle.first.click()
            page.wait_for_timeout(600)
        page.get_by_role('button', name='Raminga', exact=True).first.click()
        page.locator('#settingsTrigger').wait_for(state='visible', timeout=20000)
        page.wait_for_timeout(1000)
        # Tab through the panel and record every visible focus target.
        page.locator('#mobileNav [data-nav="home"]').focus()
        for _ in range(14):
            page.keyboard.press('Tab')
            page.wait_for_timeout(90)
            item = active(page)
            if item:
                RESULTS['focusPath'].append(item)
        rings = [item for item in RESULTS['focusPath'] if item['outline'] != 'none' and item['width'] not in ('0px', '')]
        RESULTS['checks']['focusRingVisible'] = len(rings) >= 3
        RESULTS['checks']['focusPathCount'] = len(RESULTS['focusPath'])
        page.screenshot(path=str(EVIDENCE / 'p5-focus-narrow.png'))
        RESULTS['screenshots'].append('p5-focus-narrow.png')
        # Contact row must not clip its own content at 390px.
        page.locator('#mobileNav [data-nav="contacts"]').click()
        page.wait_for_timeout(900)
        row = page.locator('#contactList .rm-contact').first
        geometry = row.evaluate('(el) => ({scroll: el.scrollHeight, client: el.clientHeight, rect: el.getBoundingClientRect().height})') if row.count() else {}
        RESULTS['checks']['contactRowNotClipped'] = bool(geometry) and geometry['scroll'] <= geometry['client'] + 1
        RESULTS['checks']['contactRowGeometry'] = geometry
        # Bottom navigation safe-area padding must be present.
        padding = page.locator('#mobileNav').evaluate('(el) => getComputedStyle(el).paddingBottom')
        RESULTS['checks']['bottomSafeAreaPadding'] = padding
        # Chat composer remains reachable when the viewport shrinks to a
        # keyboard-sized height. This is a viewport proxy, not a real IME test.
        page.locator('#contactsMessages').click()
        page.wait_for_timeout(900)
        if not page.locator('#conversationView').is_visible():
            row = page.locator('#conversationList [data-conversation-peer]').first
            if row.count():
                row.click()
                page.wait_for_timeout(900)
        composer = page.locator('#messageInput')
        if composer.count() and composer.is_visible():
            composer.fill('P5 focus audit draft')
            page.set_viewport_size({'width': 390, 'height': 500})
            page.wait_for_timeout(500)
            composer.scroll_into_view_if_needed()
            box = composer.bounding_box()
            RESULTS['checks']['composerInShrunkViewport'] = bool(box) and box['y'] >= 0 and box['y'] + box['height'] <= 500
            RESULTS['checks']['composerBox'] = box
            page.screenshot(path=str(EVIDENCE / 'p5-keyboard-shrink-narrow.png'))
            RESULTS['screenshots'].append('p5-keyboard-shrink-narrow.png')
        else:
            RESULTS['checks']['composerInShrunkViewport'] = 'NOT_TESTED'
        RESULTS['checks']['horizontalOverflow'] = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        save()
        browser.close()
    try:
        import os, signal
        os.kill(proc.pid, signal.SIGTERM)
    except Exception:
        pass
    print(json.dumps(RESULTS, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
