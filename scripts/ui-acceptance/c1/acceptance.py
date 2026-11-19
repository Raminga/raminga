#!/usr/bin/env python3
"""Real isolated DSH acceptance for first-batch C.

Prerequisites:
  node scripts/ui-acceptance/c1/prepare.mjs
  sh scripts/ui-acceptance/c1/start-host.sh > .local/prototype-remediation/c1/dsh-4366.log 2>&1 &
This driver only touches the C1 fixture ports/data. It uses Chromium at
1440x900 and 390x844 and records screenshots plus a JSON result file.
"""
from playwright.sync_api import sync_playwright
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

ROOT = pathlib.Path(os.environ.get('C1_ACCEPTANCE_DIR', '.local/prototype-remediation/c1')).resolve()
REPO = pathlib.Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'fixture.json').read_text())
PEER_A = FIXTURE['nodeA']
PEER_B = FIXTURE['nodeB']
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(parents=True, exist_ok=True)
HOST_PORT = os.environ.get('C1_HOST_PORT', str(FIXTURE.get('hostPort', 4366)))
URL = re.findall(r'https?://\S+', (ROOT / f'dsh-{HOST_PORT}.log').read_text())[-1]
RESULTS = {
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'url': URL,
    'fixture': str(ROOT / 'fixture.json'),
    'cases': {},
    'screenshots': [],
    'pageErrors': [],
    'consoleErrors': [],
    'viewports': {'wide': '1440x900', 'narrow': '390x844'},
}
RESULT_FILE = EVIDENCE / 'c1-results.json'


def save():
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
            'error': str(exc), 'trace': traceback.format_exc()[-4000:],
        }
        print(f'FAIL {cid} {name}: {exc}')
        save()
        raise
    finally:
        save()


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


def post_tool(tool, args, timeout=130):
    request = urllib.request.Request(
        f"http://127.0.0.1:{FIXTURE.get('controlPort', 4337)}/run",
        data=json.dumps({'tool': tool, 'args': args}).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read().decode('utf-8')


def send_unread(count=3):
    env = dict(os.environ)
    env['C1_ACCEPTANCE_DIR'] = str(ROOT)
    env['C1_UNREAD_COUNT'] = str(count)
    env['C1_UNREAD_TAG'] = str(int(time.time() * 1000))
    result = subprocess.run(
        ['node', str(REPO / 'scripts' / 'ui-acceptance' / 'c1' / 'send-from-b.mjs')],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=90,
    )
    if result.returncode != 0:
        raise AssertionError(f'send-from-b failed: {result.stderr or result.stdout}')
    return json.loads(result.stdout.strip().splitlines()[-1])


class UI:
    def __init__(self, page):
        self.page = page
        self.wide = True

    def dismiss(self):
        for _ in range(6):
            close = self.page.locator('[aria-label="Close"]:visible')
            if close.count() == 0:
                break
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
        self.page.wait_for_timeout(900)

    def viewport(self, width, height):
        self.page.set_viewport_size({'width': width, 'height': height})
        self.wide = width >= 700
        self.page.wait_for_timeout(700)

    def nav(self, item):
        sel = '#desktopNav' if self.wide else '#mobileNav'
        self.page.locator(f'{sel} [data-nav="{item}"]').click()
        self.page.wait_for_timeout(700)

    def nav_current(self):
        out = []
        for sel in ['#desktopNav', '#mobileNav']:
            loc = self.page.locator(sel)
            if loc.count() and loc.is_visible():
                out.extend(loc.locator('[aria-current="page"]').evaluate_all(
                    "els => els.map(e => e.dataset.nav)"))
        return out

    def shot(self, name):
        path = EVIDENCE / f'{name}.png'
        self.page.screenshot(path=str(path))
        RESULTS['screenshots'].append(str(path.relative_to(REPO)))
        save()
        return path

    def text(self, selector, timeout=15000):
        loc = self.page.locator(selector)
        loc.wait_for(state='visible', timeout=timeout)
        return loc.inner_text()

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

    def active_focus(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.getAttribute('data-focus-key') || node.getAttribute('id') || '') : '';
        }''')

    def active_id(self):
        return self.page.evaluate('''() => {
          let node = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
          return node ? (node.id || '') : '';
        }''')

    def row(self, peer=PEER_B):
        return self.page.locator(f'[data-contact-row="{peer}"]')

    def open_profile(self, peer=PEER_B):
        self.row(peer).locator('button[data-contact-peer]').click()
        self.page.locator('#profileView').wait_for(state='visible', timeout=15000)
        self.page.wait_for_timeout(900)

    def back_profile(self):
        self.page.locator('#profileBack').click()
        self.page.wait_for_timeout(700)


def main():
    page_errors = RESULTS['pageErrors']
    console_errors = RESULTS['consoleErrors']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('console', lambda msg: console_errors.append(f'{msg.type}: {msg.text}') if msg.type == 'error' else None)
        page.goto(URL, wait_until='domcontentloaded')
        page.wait_for_timeout(2600)
        ui = UI(page)
        ui.dismiss()
        ui.open_panel()

        def readonly_history():
            ui.nav('contacts')
            page.locator('#contactList').wait_for(state='visible', timeout=20000)
            page.wait_for_timeout(700)
            before = page.locator('#contactList .rm-contact-unread').first.inner_text()
            assert before.isdigit() and int(before) > 0, before
            RESULTS['unreadBaseline'] = int(before)
            status, raw = post_tool('raminga_chat_history', {'limit': 20})
            assert status == 200, (status, raw[:400])
            payload = json.loads(raw)
            assert payload.get('ok') is True, payload
            page.wait_for_timeout(1300)
            after = page.locator('#contactList .rm-contact-unread').first.inner_text()
            assert after == before, f'read-only Agent history changed human unread: {before} -> {after}'
            badge = page.locator('[data-nav-badge="contacts"]').first.inner_text()
            assert badge == before, (badge, before)
            return {'unreadBefore': before, 'unreadAfterAgentHistory': after, 'navBadge': badge}

        case('C1-01', 'Read-only Agent history does not advance the human unread cursor', readonly_history)

        def contact_row_entry():
            page.locator('#contactQuery').fill('lin')
            page.wait_for_timeout(500)
            assert page.locator('[data-contact-row]').count() == 11
            page.locator('#page-contacts').evaluate('(node) => { node.scrollTop = 180; }')
            page.wait_for_timeout(200)
            row = ui.row()
            row.scroll_into_view_if_needed()
            page.wait_for_timeout(250)
            entry_scroll = page.locator('#page-contacts').evaluate('(node) => node.scrollTop')
            assert entry_scroll >= 150, entry_scroll
            chat = row.locator('button[data-chat-peer]')
            main = row.locator('button[data-contact-peer]')
            chat_box = chat.bounding_box()
            main_box = main.bounding_box()
            assert chat_box and chat_box['width'] >= 38 and chat_box['height'] >= 38, chat_box
            assert main_box and main_box['height'] >= 60, main_box
            assert row.locator('button').count() == 4, row.locator('button').count()
            assert int(chat.locator('.rm-contact-unread').inner_text()) == RESULTS['unreadBaseline']
            ui.shot('c1-wide-contacts-row-entry')
            chat.click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            assert ui.nav_current() == ['contacts'], ui.nav_current()
            assert page.locator('#conversationBack').inner_text() == '← 返回联系人'
            page.locator('#messageInput').fill('联系人行内聊天草稿')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(700)
            assert page.locator('#page-contacts').is_visible()
            assert page.locator('#contactQuery').input_value() == 'lin'
            assert page.locator('#page-contacts').evaluate('(node) => node.scrollTop') == entry_scroll, 'contact scroll must return to the exact entry position'
            assert ui.active_focus() == f'contact-chat:{PEER_B}', ui.active_focus()
            assert ui.nav_current() == ['contacts']
            return {'chatBox': {k: round(chat_box[k], 1) for k in ('width', 'height')}, 'mainHeight': round(main_box['height'], 1), 'entryScroll': entry_scroll, 'restoredScroll': page.locator('#page-contacts').evaluate('(node) => node.scrollTop')}

        case('C1-02', 'Contact row: body opens profile, distinct inline chat returns search/filter/scroll/focus', contact_row_entry)

        def profile_posts():
            ui.open_profile()
            page.locator('[data-profile-tab="posts"]').click()
            page.locator('#profilePostList .rm-post').first.wait_for(state='visible', timeout=15000)
            assert page.locator('#profilePostList .rm-post').count() == 6
            page.locator('#profileView').evaluate('(node) => { node.scrollTop = 220; }')
            page.wait_for_timeout(250)
            profile_scroll = page.locator('#profileView').evaluate('(node) => node.scrollTop')
            assert profile_scroll >= 150, profile_scroll
            page.locator('#profileMessage').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            assert page.locator('#conversationBack').inner_text() == '← 返回联系人档案'
            assert ui.nav_current() == ['contacts'], ui.nav_current()
            page.locator('#messageInput').fill('档案动态草稿')
            page.locator('#messageList').evaluate('(node) => { node.scrollTop = 120; }')
            page.wait_for_timeout(200)
            chat_scroll = page.locator('#messageList').evaluate('(node) => node.scrollTop')
            ui.shot('c1-wide-chat-from-profile')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#profileView').is_visible()
            assert page.locator('[data-profile-tab="posts"]').get_attribute('aria-current') == 'page'
            assert page.locator('#contactProfilePosts').is_visible()
            assert page.locator('#profileView').evaluate('(node) => node.scrollTop') == profile_scroll, 'profile posts scroll not restored'
            assert ui.active_focus() == f'profile-message:{PEER_B}', ui.active_focus()
            ui.shot('c1-wide-profile-posts-return')
            ui.back_profile()
            assert page.locator('#contactQuery').input_value() == 'lin'
            assert ui.active_focus() == f'contact:{PEER_B}', ui.active_focus()
            return {'posts': 6, 'profileScroll': profile_scroll, 'chatScroll': chat_scroll}

        case('C1-03', 'Profile “他的动态” → 发消息 → back restores the same tab, scroll and message action', profile_posts)

        def profile_address():
            ui.open_profile()
            page.locator('[data-profile-tab="address"]').click()
            page.locator('#profileFriendList .rm-friend-row').first.wait_for(state='visible', timeout=15000)
            page.locator('#profileView').evaluate('(node) => { node.scrollTop = 160; }')
            page.wait_for_timeout(200)
            address_scroll = page.locator('#profileView').evaluate('(node) => node.scrollTop')
            page.locator('#profileMessage').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#profileView').is_visible()
            assert page.locator('[data-profile-tab="address"]').get_attribute('aria-current') == 'page'
            assert page.locator('#contactProfileAddress').is_visible()
            assert page.locator('#profileView').evaluate('(node) => node.scrollTop') == address_scroll
            assert ui.active_focus() == f'profile-message:{PEER_B}'
            friends = page.locator('#profileFriendList .rm-friend-row').count()
            ui.back_profile()
            return {'friends': friends, 'profileScroll': address_scroll}

        case('C1-04', 'Profile “他的通讯录” → 发消息 → back restores the same tab, scroll and message action', profile_address)

        def profile_evidence():
            ui.open_profile()
            page.locator('[data-profile-tab="interactions"]').click()
            page.locator('#profileTimeline [data-memory-message]').first.wait_for(state='visible', timeout=15000)
            page.locator('#profileView').evaluate('(node) => { node.scrollTop = 70; }')
            page.wait_for_timeout(200)
            evidence_scroll = page.locator('#profileView').evaluate('(node) => node.scrollTop')
            evidence = page.locator('#profileTimeline [data-memory-message]').first
            focus_key = evidence.get_attribute('data-focus-key')
            message_id = evidence.get_attribute('data-memory-message')
            evidence.click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            assert page.locator('#conversationBack').inner_text() == '← 返回联系人档案'
            page.locator(f'#messageList [data-message-id="{message_id}"]').wait_for(state='visible', timeout=15000)
            assert '已在当前保留记录中找到' in page.locator('#messageFocusNote').inner_text()
            ui.shot('c1-wide-chat-from-evidence')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#profileView').is_visible()
            assert page.locator('[data-profile-tab="interactions"]').get_attribute('aria-current') == 'page'
            assert page.locator('#profileView').evaluate('(node) => node.scrollTop') == evidence_scroll
            assert ui.active_focus() == focus_key, (ui.active_focus(), focus_key)
            ui.shot('c1-wide-profile-evidence-return')
            ui.back_profile()
            return {'messageId': message_id, 'focusKey': focus_key, 'scroll': evidence_scroll}

        case('C1-05', 'Contact interaction evidence opens the exact chat and returns to the same evidence row and position', profile_evidence)

        def conversation_index():
            page.locator('#contactsMessages').click()
            page.locator('#messagesIndex').wait_for(state='visible', timeout=15000)
            assert ui.nav_current() == ['contacts']
            page.locator('#conversationQuery').fill('lin')
            page.wait_for_timeout(500)
            page.locator('#page-messages').evaluate('(node) => { node.scrollTop = 120; }')
            page.wait_for_timeout(200)
            index_scroll = page.locator('#page-messages').evaluate('(node) => node.scrollTop')
            row = page.locator(f'#conversationList button[data-conversation-peer="{PEER_B}"]')
            row.click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            assert page.locator('#conversationBack').inner_text() == '← 返回对话'
            page.locator('#messageInput').fill('会话列表草稿')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(800)
            assert page.locator('#messagesIndex').is_visible()
            assert page.locator('#conversationQuery').input_value() == 'lin'
            assert page.locator('#page-messages').evaluate('(node) => node.scrollTop') == index_scroll
            assert ui.active_focus() == f'conversation:{PEER_B}', ui.active_focus()
            return {'indexScroll': index_scroll}

        case('C1-06', 'Conversation list → chat → back restores the index query, scroll and row focus', conversation_index)

        def settings_from_index():
            ui.shot('c1-wide-conversation-index')
            page.locator('#settingsTrigger').click()
            page.locator('#page-settings').wait_for(state='visible', timeout=15000)
            assert page.locator('#settingsIndex').is_visible()
            page.locator('#settingsClose').click()
            page.wait_for_timeout(500)
            assert page.locator('#messagesIndex').is_visible()
            assert page.locator('#conversationQuery').input_value() == 'lin'
            assert page.locator('#page-messages').evaluate('(node) => node.scrollTop') >= 100
            assert ui.active_focus() in ('conversationQuery', f'conversation:{PEER_B}'), ui.active_focus()
            return {'focus': ui.active_focus(), 'nav': ui.nav_current()}

        case('C1-07', 'Gear from the conversation list opens settings and returns to the same index state/focus', settings_from_index)

        def settings_from_chat():
            page.locator(f'#conversationList button[data-conversation-peer="{PEER_B}"]').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            page.locator('#messageInput').fill('设置往返草稿')
            page.locator('#messageList').evaluate('(node) => { node.scrollTop = 160; }')
            page.wait_for_timeout(200)
            chat_scroll = page.locator('#messageList').evaluate('(node) => node.scrollTop')
            page.locator('#settingsTrigger').click()
            page.locator('#page-settings').wait_for(state='visible', timeout=15000)
            assert page.locator('#settingsIndex').is_visible()
            page.locator('#settingsClose').click()
            page.wait_for_timeout(600)
            assert page.locator('#conversationView').is_visible()
            assert page.locator('#messageInput').input_value() == '设置往返草稿'
            assert abs(page.locator('#messageList').evaluate('(node) => node.scrollTop') - chat_scroll) <= 1
            assert ui.active_id() == 'messageInput', ui.active_id()
            assert ui.nav_current() == ['contacts']
            ui.shot('c1-wide-chat-settings-return')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(700)
            return {'chatScroll': chat_scroll, 'focus': ui.active_id()}

        case('C1-08', 'Gear from a chat returns to the same conversation, draft and history position', settings_from_chat)

        def journey_evidence():
            ui.nav('home')
            page.locator('#homeJourneysAll').click()
            page.locator('#page-journeys').wait_for(state='visible', timeout=15000)
            page.locator(f'#journeyList [data-journey-open="{FIXTURE["journeyId"]}"]').click()
            page.locator('#page-journey').wait_for(state='visible', timeout=15000)
            page.locator('#journeyDetail [data-journey-locate-peer]').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            assert '返回漫游' in page.locator('#conversationBack').inner_text()
            page.locator(f'#messageList [data-message-id="{FIXTURE["outboundMessageId"]}"]').wait_for(state='visible', timeout=15000)
            assert ui.nav_current() == ['contacts'], 'an open chat selects only the contacts section, even from a Journey'
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#page-journey').is_visible()
            expected = f'journey-evidence:{FIXTURE["journeyId"]}:{FIXTURE["journeyEvidenceSeq"]}:{FIXTURE["outboundMessageId"]}'
            assert ui.active_focus() == expected, (ui.active_focus(), expected)
            assert ui.nav_current() == ['home'], 'returning to the Journey selects the home section again'
            ui.shot('c1-wide-journey-evidence-return')
            page.locator('#journeyBack').click()
            page.wait_for_timeout(500)
            return {'focus': expected, 'messageId': FIXTURE['outboundMessageId']}

        case('C1-09', 'B regression: Journey message evidence opens the historical chat and returns to the exact evidence', journey_evidence)

        def post_detail():
            ui.nav('explore')
            page.locator('#discoveryList .rm-post').first.wait_for(state='visible', timeout=20000)
            page.locator('[data-filter="familiar"]').click()
            page.wait_for_timeout(800)
            page.locator('#exploreSearchToggle').click()
            page.locator('#exploreQuery').fill('潮汐')
            page.wait_for_timeout(700)
            assert page.locator('#discoveryList .rm-post').count() >= 1
            page.locator('#page-explore').evaluate('(node) => { node.scrollTop = 60; }')
            page.wait_for_timeout(200)
            cards = page.locator('#discoveryList .rm-post')
            trigger_focus = cards.first.locator('.rm-post-open').get_attribute('data-focus-key')
            title = cards.first.locator('.rm-post-title').inner_text()
            cards.first.locator('.rm-post-open').click()
            page.locator('#page-post').wait_for(state='visible', timeout=15000)
            body = ui.text('#page-post')
            assert title in body
            assert '来源详情' in body
            assert page.locator('#postDetail .rm-post-media').count() == 0, 'text post must not invent a media placeholder'
            page.locator('#postBack').click()
            page.wait_for_timeout(800)
            assert page.locator('#page-explore').is_visible()
            assert page.locator('[data-filter="familiar"]').get_attribute('aria-pressed') == 'true'
            assert page.locator('#exploreQuery').input_value() == '潮汐'
            assert ui.active_focus() == trigger_focus, (ui.active_focus(), trigger_focus)
            return {'title': title, 'focus': trigger_focus, 'filter': 'familiar', 'query': '潮汐'}

        case('C1-10', 'A regression: filtered post detail keeps title/source and returns filter, query and focus', post_detail)

        def unread_filter():
            sent = send_unread(3)
            wait_for(lambda: page.locator('[data-nav-badge="contacts"]').first.inner_text() not in ('', '0'), 'new unread badge', timeout=15)
            ui.nav('contacts')
            page.locator('[data-contact-filter="unread"]').click()
            page.wait_for_timeout(1000)
            assert ui.row().count() == 1, 'only the contact with new unread should remain'
            page.locator('#contactList button[data-chat-peer]').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            page.locator('#messageList').wait_for(state='visible', timeout=15000)
            page.locator('#messageList').evaluate('(node) => { node.scrollTop = node.scrollHeight; }')
            page.locator('#messageInput').focus()
            page.wait_for_timeout(1200)
            page.locator('#conversationBack').click()
            page.wait_for_timeout(900)
            assert page.locator('#page-contacts').is_visible()
            assert page.locator('#contactList').is_hidden()
            assert ui.active_focus() == 'contact-filter:unread', ui.active_focus()
            state = ui.text('#contactsStateTitle')
            assert '未读' in state or '联系人' in state, state
            ui.shot('c1-wide-unread-filter-empty')
            return {'sent': sent, 'state': state, 'focus': ui.active_focus()}

        case('C1-11', 'Unread reaches zero: the row leaves the unread filter and focus falls back to the filter', unread_filter)

        def narrow():
            ui.viewport(390, 844)
            ui.dismiss()
            ui.open_panel()
            ui.nav('contacts')
            page.locator('#contactQuery').fill('')
            page.locator('[data-contact-filter="all"]').click()
            page.wait_for_timeout(700)
            assert page.locator('#mobileNav').is_visible()
            assert page.locator('#desktopNav').is_hidden()
            assert ui.nav_current() == ['contacts'], ui.nav_current()
            assert ui.overflow() == 0, ui.overflow()
            assert ui.visual_overflow('#page-contacts') == 0, ui.visual_overflow('#page-contacts')
            row = ui.row()
            row.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            chat_box = row.locator('button[data-chat-peer]').bounding_box()
            main_box = row.locator('button[data-contact-peer]').bounding_box()
            assert chat_box['width'] >= 42 and chat_box['height'] >= 42, chat_box
            assert main_box['height'] >= 60, main_box
            row.locator('button[data-chat-peer]').focus()
            assert ui.active_focus() == f'contact-chat:{PEER_B}'
            ui.shot('c1-narrow-contact-row-chat-action')
            row.locator('button[data-chat-peer]').click()
            page.locator('#conversationView').wait_for(state='visible', timeout=15000)
            page.wait_for_timeout(500)
            assert ui.overflow() == 0, ui.overflow()
            assert ui.visual_overflow('#conversationView') == 0, ui.visual_overflow('#conversationView')
            assert ui.nav_current() == ['contacts'], ui.nav_current()
            composer = page.locator('.rm-composer').bounding_box()
            nav_box = page.locator('#mobileNav').bounding_box()
            assert composer and nav_box and composer['y'] + composer['height'] <= nav_box['y'] + 1, (composer, nav_box)
            page.locator('#messageInput').fill('窄屏未发送草稿')
            page.locator('#settingsTrigger').click()
            page.locator('#page-settings').wait_for(state='visible', timeout=15000)
            page.locator('#settingsClose').click()
            page.wait_for_timeout(600)
            assert page.locator('#conversationView').is_visible()
            assert page.locator('#messageInput').input_value() == '窄屏未发送草稿'
            assert ui.active_id() == 'messageInput'
            assert ui.overflow() == 0
            ui.shot('c1-narrow-chat-settings-return')
            page.locator('#conversationBack').click()
            page.wait_for_timeout(600)
            assert ui.overflow() == 0
            return {'chatBox': {k: round(chat_box[k], 1) for k in ('width', 'height')}, 'mainHeight': round(main_box['height'], 1), 'composerGap': round(nav_box['y'] - (composer['y'] + composer['height']), 1), 'nav': 'contacts'}

        case('C1-12', '390x844: row chat target, focus, composer safety area, one visible nav and no horizontal overflow', narrow)

        RESULTS['limits'] = {
            'desktopShell': 'Isolated DSH Web host in headless Chromium; not an Electron desktop shell, real IME or system drag test.',
            'isolation': 'Uses only the C1 data/DSH_HOME/ports 4366 and 4337; Codex fixtures on 4354/4362 and their data were untouched.',
            'scrollModel': 'Profile/contact scrolls are real Chromium layout positions; the fixture inserts extra local contact rows only to make the list scrollable.',
        }
        save()
        browser.close()

    if page_errors or console_errors:
        raise AssertionError(f'page errors={page_errors[:3]} console errors={console_errors[:3]}')


if __name__ == '__main__':
    main()
