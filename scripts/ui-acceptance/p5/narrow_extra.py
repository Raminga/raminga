#!/usr/bin/env python3
"""Extra 390x844 mutations for T4/T5/T7/T8/T10/T11/T13/T14.

The main acceptance driver already exercises these paths at 1440x900 and takes
narrow screenshots. This addendum performs real narrow-screen mutations so the
matrix has actual 390px publish/read/favorite/remount evidence, not only a
viewport resize of the wide run.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import time

import acceptance as acc

ROOT = acc.ROOT
EVIDENCE = acc.EVIDENCE
RESULTS = {'checks': {}, 'screenshots': [], 'pageErrors': []}
PAGE_ERRORS = RESULTS['pageErrors']


def save():
    (EVIDENCE / 'p5-narrow-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))


def shot(page, name):
    page.screenshot(path=str(EVIDENCE / f'{name}.png'))
    RESULTS['screenshots'].append(name)
    save()


def main():
    url = re.findall(r'https?://\S+', (ROOT / 'dsh-4344.log').read_text())[-1]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.on('pageerror', lambda error: PAGE_ERRORS.append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_timeout(2400)
        ui = acc.UI(page)
        ui.wide = False
        ui.dismiss()
        ui.open_panel()
        assert page.evaluate('document.documentElement.scrollWidth - window.innerWidth') == 0

        # T4 narrow: change the public human intro and publish a new profile version.
        ui.settings('public')
        marker = 'P5 narrow publication 390'
        page.locator('#publicHumanBio').fill(marker + '；旧 index.md 继续保留。')
        page.locator('#publicPublishButton').click()
        acc.wait_for(lambda: '确认发布' in page.locator('#publicPublishButton').inner_text(), 'narrow profile confirm step', timeout=20)
        page.locator('#publicPublishButton').click()
        acc.wait_for(lambda: '发布完成' in page.locator('#publicPublishReceipt').inner_text(), 'narrow profile publish', timeout=30)
        profile = json.loads((acc.A_DIR / 'public' / 'profile' / 'profile.json').read_text())
        assert marker in profile['human']['bio_markdown'], profile
        RESULTS['checks']['T4'] = {'published': True, 'humanBio': profile['human']['bio_markdown'][:80]}
        shot(page, 'p5-t04-narrow-published')
        ui.settings_home()

        # T5 narrow: publish one real Agent post from the narrow editor.
        ui.nav('explore')
        page.locator('[data-filter="mine"]').click()
        page.wait_for_timeout(700)
        page.locator('#composePost').click()
        page.wait_for_timeout(700)
        if page.locator('#postAuthorKind').is_disabled():
            page.locator('#postDraftSelect').select_option('')
            page.wait_for_timeout(500)
        title = 'P5 窄屏 Agent 动态'
        page.locator('#postTitleInput').fill(title)
        page.locator('#postBodyInput').fill('# P5 窄屏 Agent 动态\n\n390px 实测发布的 Agent 署名动态。')
        page.locator('#postTagsInput').fill('P5,窄屏')
        page.locator('#postAuthorKind').select_option('agent')
        page.wait_for_timeout(600)
        page.locator('#postPublishButton').click()
        acc.wait_for(lambda: '确认发布' in page.locator('#postPublishButton').inner_text(), 'narrow post confirm step', timeout=20)
        page.locator('#postPublishButton').click()
        acc.wait_for(lambda: '发布完成' in page.locator('#postPublishReceipt').inner_text(), 'narrow post publish', timeout=30)
        page.locator('#postEditorClose').click()
        page.wait_for_timeout(700)
        page.locator('[data-filter="mine"]').click()
        page.wait_for_timeout(1000)
        assert title in page.locator('#mineFeedList').inner_text()
        RESULTS['checks']['T5'] = {'title': title, 'badges': page.locator('#mineFeedList .rm-post-author-badge').all_inner_texts()}
        shot(page, 'p5-t05-narrow-published')

        # T7 narrow: one real message, unread row and contact profile tabs.
        # The A daemon was restarted during T8, so refresh B's address cache
        # before injecting the narrow unread message.
        status_a = acc.api('status', dataDir=str(acc.A_DIR))
        addr_a = [row for row in status_a['listenAddrs'] if '/tcp/' in row][0]
        conn = acc.cli(['connect', f'{addr_a}/p2p/{acc.PEER_A}', '--data-dir', str(acc.B_DIR)], timeout=60)
        assert conn.returncode == 0, conn.stderr or conn.stdout
        before = acc.friends_unread()
        proc = acc.cli(['chat', 'send', '--to', acc.PEER_A, '--text', 'P5 窄屏未读：这条消息在 390px 下应显示为未读。', '--data-dir', str(acc.B_DIR)], timeout=60)
        assert proc.returncode == 0 and 'acked: true' in proc.stdout, proc.stderr or proc.stdout
        acc.wait_for(lambda: acc.friends_unread() > before, 'narrow unread', timeout=20)
        unread = acc.friends_unread()
        ui.nav('contacts')
        page.wait_for_timeout(1200)
        assert page.locator('#contactUnreadCount').inner_text() == '1'
        row = page.locator(f'#contactList [data-contact-row="{acc.PEER_B}"]')
        assert 'P5 窄屏未读' in row.inner_text()
        page.wait_for_timeout(1200)
        row_unread = row.locator('.rm-contact-unread').inner_text()
        assert row_unread.isdigit() and int(row_unread) > 0, row_unread
        row.locator('[data-profile-peer]').first.click()
        page.locator('#profileView').wait_for(state='visible', timeout=12000)
        acc.UI(page).wait_text('#profileName', r'澄野', timeout=20000)
        for tab in ['我们的交互', '他的动态', '他的通讯录']:
            assert page.locator(f'[data-profile-tab]', has_text=tab).count() == 1
        RESULTS['checks']['T7'] = {'unread': unread, 'rowUnread': row_unread, 'tabs': page.locator('[data-profile-tab]').all_inner_texts()}
        shot(page, 'p5-t07-narrow-profile')
        page.locator('#profileBack').click()
        page.wait_for_timeout(500)

        # T8 narrow: open the conversation, scroll, draft, remount.
        page.locator('#contactsMessages').click()
        page.wait_for_timeout(900)
        if not page.locator('#conversationView').is_visible():
            page.locator(f'#conversationList [data-conversation-peer="{acc.PEER_B}"]').click()
            page.wait_for_timeout(800)
        page.locator('#messageList').evaluate('(el) => el.scrollTop = 1800')
        page.wait_for_timeout(400)
        page.locator('#messageInput').fill('P5 窄屏草稿：重挂后保留。')
        page.wait_for_timeout(700)
        ui.remount()
        page.wait_for_timeout(1200)
        if not page.locator('#conversationView').is_visible():
            ui.nav('contacts')
            page.locator('#contactsMessages').click()
            page.wait_for_timeout(700)
            if not page.locator('#conversationView').is_visible():
                page.locator(f'#conversationList [data-conversation-peer="{acc.PEER_B}"]').click()
                page.wait_for_timeout(800)
        assert page.locator('#messageInput').input_value() == 'P5 窄屏草稿：重挂后保留。'
        RESULTS['checks']['T8'] = {'draft': page.locator('#messageInput').input_value(), 'scroll': page.locator('#messageList').evaluate('(el)=>el.scrollTop')}
        shot(page, 'p5-t08-narrow-remount')

        # T10 narrow: favorite the remaining B2 discovery.
        res = acc.control('raminga_content_get', {'peer_id': acc.PEER_B, 'path': acc.FIXTURE['bAgentPostPath']})
        assert res.get('ok') is True
        ui.nav('explore')
        page.locator('[data-filter="all"]').click()
        page.wait_for_timeout(1000)
        card = page.locator('#discoveryList .rm-post', has_text='一张旧唱片的反面').first
        card.wait_for(state='visible', timeout=15000)
        card.locator('.rm-post-favorite').click()
        page.wait_for_timeout(1200)
        favorites = acc.api('favorites', dataDir=str(acc.A_DIR)).get('favorites', [])
        assert any(item['path'] == acc.FIXTURE['bAgentPostPath'] for item in favorites), favorites
        ui.settings('favorites')
        page.wait_for_timeout(900)
        assert '一张旧唱片的反面' in page.locator('#settings-favorites').inner_text()
        RESULTS['checks']['T10'] = {'favoritePaths': [item['path'] for item in favorites]}
        shot(page, 'p5-t10-narrow-favorites')
        ui.settings_home()

        # T11 narrow: private memory list and contact timeline.
        ui.settings('memory')
        page.wait_for_timeout(900)
        assert 'chengye' in page.locator('#settings-memory').inner_text()
        ui.settings_home()
        ui.nav('contacts')
        page.locator(f'#contactList [data-profile-peer="{acc.PEER_B}"]').first.click()
        page.locator('#profileView').wait_for(state='visible', timeout=12000)
        acc.UI(page).wait_text('#profileImpressionSummary', r'只在私下记住', timeout=20000)
        RESULTS['checks']['T11'] = {'impression': page.locator('#profileImpressionSummary').inner_text()[:120]}
        shot(page, 'p5-t11-narrow-timeline')

        # T13 narrow: completed Journey means the Peer fallback action is present.
        ui.nav('home')
        page.wait_for_timeout(1200)
        page.locator('#homeActivityToggle').click()
        page.wait_for_timeout(1000)
        peer = page.locator('[data-activity-peer]').first
        assert peer.count() == 1, 'narrow activity fallback missing'
        peer.click()
        page.wait_for_timeout(1000)
        assert '澄野' in page.locator('#profileName').inner_text()
        RESULTS['checks']['T13'] = {'peerFallback': True}
        shot(page, 'p5-t13-narrow-fallback')

        # T14 narrow state after the reinstall: no stale running card.
        ui.nav('home')
        page.wait_for_timeout(1000)
        assert not page.locator('#homeActivityLive').is_visible()
        RESULTS['checks']['T14'] = {'liveAfterReinstallAt390': False}
        RESULTS['checks']['horizontalOverflow'] = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        save()
        browser.close()


if __name__ == '__main__':
    main()
