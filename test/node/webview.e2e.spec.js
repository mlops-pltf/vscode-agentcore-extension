// The real chat panel (HTML + scripts from media/webview) running in jsdom,
// wired to the real Python bridge in mock mode. Run with `npm run test:js`.
const { test } = require('node:test');
const { assert, MOCK_SETTINGS, sleep, until, openPanel } = require('./helpers');

// Objects created inside jsdom belong to another JS realm; compare plain copies
const plain = (value) => JSON.parse(JSON.stringify(value));

test('agent list, note, MOCK badge and welcome card', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;

  assert.deepStrictEqual([...$('agentSelect').options].map((o) => o.textContent), ['demo-a2a', 'demo-http-strands', 'demo-unknown']);
  assert.strictEqual($('agentsNote').hidden, false);
  assert.strictEqual($('agentsNote').textContent, '1 non-chat agent (MCP/AGUI) hidden');
  assert.strictEqual($('mockBadge').hidden, false);

  const card = p.empty();
  assert.ok(card, 'welcome card shown');
  assert.strictEqual(card.querySelector('h2').textContent, 'demo-a2a');
  assert.strictEqual(card.querySelector('.protocol').textContent, 'A2A agent');
  assert.strictEqual(card.querySelectorAll('.chip').length, 3);
  assert.strictEqual($('promptInput').placeholder, 'Ask demo-a2a...');

  card.querySelector('.chip').click();
  assert.strictEqual($('promptInput').value, 'What can you help me with?');
  assert.ok(!p.sent.some((m) => m.action === 'invoke_agent'), 'a chip fills the composer but does not send');

  p.pick('demo-http-strands');
  assert.strictEqual(p.empty().querySelector('h2').textContent, 'demo-http-strands');
  assert.strictEqual($('promptInput').placeholder, 'Ask demo-http-strands...');

  p.post({ type: 'settings', data: { ...MOCK_SETTINGS, mock: false } });
  assert.strictEqual($('mockBadge').hidden, true, 'badge follows the mock setting');
});

test('protocol toggle follows the agent and remembers manual choices', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;

  assert.strictEqual(p.pressed(), 'A2A');
  assert.ok($('protocolToggle').classList.contains('auto'), 'dot = detected');
  p.pick('demo-unknown');
  assert.strictEqual(p.pressed(), 'HTTP');
  assert.ok(!$('protocolToggle').classList.contains('auto'));
  assert.ok($('protocolToggle').title.startsWith('Protocol unknown'));

  p.pick('demo-a2a');
  p.toggle('HTTP');  // empty chat: no confirmation needed
  assert.strictEqual(p.pressed(), 'HTTP');
  assert.deepStrictEqual(plain(p.getState()), { protocolOverrides: { [$('agentSelect').value]: 'HTTP' } });
  const saved = p.getState();
  p.close();

  const q = openPanel({ savedState: saved });
  t.after(q.close);
  await q.ready();
  q.pick('demo-a2a');
  assert.strictEqual(q.pressed(), 'HTTP', 'override restored after reload');
  q.toggle('A2A');
  assert.ok(q.$('protocolToggle').classList.contains('auto'), 'back to detected clears the override');
  assert.deepStrictEqual(plain(q.getState().protocolOverrides), {});
});

test('A2A conversation: reply, busy state, footer, input-required', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;

  p.type('hi');
  assert.ok(!p.empty(), 'welcome card removed on first send');
  assert.strictEqual(p.document.querySelector('.msg.user').textContent, 'hi');
  assert.ok(p.last().querySelector('.agent-head .avatar svg'));
  assert.strictEqual(p.part(p.last(), 'name').textContent, 'demo-a2a');
  assert.ok($('sendBtn').disabled && $('sendBtn').hidden, 'send hidden while busy');
  assert.ok(!$('stopBtn').disabled && !$('stopBtn').hidden, 'stop shown while busy');
  assert.strictEqual(p.last().querySelectorAll('.text .typing span').length, 3, 'typing dots');

  p.type('ignored while busy');
  await until(p.idle);
  assert.strictEqual(p.sent.filter((m) => m.action === 'invoke_agent').length, 1);
  const invoke = p.sent.find((m) => m.action === 'invoke_agent');
  assert.strictEqual(invoke.protocol, 'A2A');
  assert.ok(invoke.requestId);
  assert.ok(!p.last().querySelector('.typing'));
  assert.ok(p.part(p.last(), 'text').textContent.startsWith("You said: 'hi'"));
  assert.match(p.part(p.last(), 'footer').textContent, /^A2A · \d+\.\ds · completed$/);

  p.type('need input');
  await until(p.idle);
  assert.strictEqual(p.part(p.last(), 'text').textContent, 'Which environment should I use: dev or prod?');
  assert.strictEqual(p.part(p.last(), 'status').hidden, false);
  assert.strictEqual(p.part(p.last(), 'status').textContent, 'Agent is waiting for your input');
  assert.ok(p.part(p.last(), 'footer').textContent.endsWith('input required'));
});

test('switching protocol or agent mid-chat starts a new chat', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;

  p.type('hi');
  await until(p.idle);
  p.toggle('HTTP');
  assert.strictEqual($('switchNotice').hidden, false);
  assert.strictEqual($('switchText').textContent, 'Switching to HTTP starts a new chat.');
  $('switchNoBtn').click();
  assert.strictEqual(p.pressed(), 'A2A');
  assert.strictEqual(p.bubbles().length, 1);

  p.toggle('HTTP');
  $('switchYesBtn').click();
  assert.strictEqual(p.pressed(), 'HTTP');
  assert.strictEqual(p.bubbles().length, 0);
  assert.strictEqual(p.empty().querySelector('.protocol').textContent, 'HTTP agent');
  assert.ok(p.sent.some((m) => m.action === 'reset_session'));

  p.type('hi');
  await until(p.idle);
  p.pick('demo-http-strands');
  assert.strictEqual(p.bubbles().length, 0, 'agent change mid-chat starts a new chat');
  assert.ok(p.empty());
});

test('HTTP status line, stop and errors', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  p.pick('demo-http-strands');

  p.type('tool hi');
  await until(() => !p.part(p.last(), 'status').hidden, 3000);
  assert.strictEqual(p.part(p.last(), 'status').textContent, 'Using tool: web_search');
  await until(p.idle);
  assert.strictEqual(p.part(p.last(), 'status').hidden, true, 'progress status removed when done');
  assert.match(p.part(p.last(), 'footer').textContent, /^HTTP · \d+\.\ds · completed$/);

  p.type('slow');
  await until(() => !p.last().querySelector('.typing'), 4000);
  p.$('stopBtn').click();
  await until(p.idle);
  assert.ok(p.part(p.last(), 'footer').textContent.endsWith('cancelled'));
  assert.ok(p.part(p.last(), 'text').textContent.length > 0, 'partial text kept');

  p.type('error');
  await until(p.idle);
  assert.ok(!p.last().querySelector('.typing'));
  assert.ok(p.part(p.last(), 'error-text').textContent.startsWith('Error: RuntimeClientError'));
});

test('backend banner and lost replies', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;
  p.pick('demo-http-strands');

  p.type('slow');
  await sleep(100);
  p.post({ type: 'bridge', state: 'restarting' });
  assert.strictEqual($('bridgeBanner').hidden, false);
  assert.strictEqual($('bridgeText').textContent, 'Reconnecting to backend...');
  assert.strictEqual($('bridgeRestartBtn').hidden, true);
  assert.strictEqual(p.part(p.last(), 'error-text').textContent, 'Backend stopped before the reply finished.');
  assert.ok(p.idle());

  p.post({ type: 'bridge', state: 'down' });
  assert.ok($('bridgeBanner').classList.contains('down'));
  assert.strictEqual($('bridgeRestartBtn').hidden, false);
  $('bridgeRestartBtn').click();
  $('bridgeLogsBtn').click();
  assert.ok(p.sent.some((m) => m.type === 'restartBackend'));
  assert.ok(p.sent.some((m) => m.type === 'showLogs'));

  p.post({ type: 'bridge', state: 'ready' });
  assert.strictEqual($('bridgeBanner').hidden, true);
});

test('untrusted names and descriptions are shown as text', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const evil = '<img src=x onerror=alert(1)>';
  p.post({ type: 'profiles', data: [evil] });
  p.post({ type: 'agents', profile: evil, data: [{ name: evil, arn: 'arn:1', description: '"><script>alert(2)</script>', protocol: 'HTTP' }] });
  assert.strictEqual(p.document.querySelectorAll('img').length, 0);
  assert.strictEqual(p.$('agentSelect').options[0].textContent, evil);
  assert.strictEqual(p.empty().querySelector('h2').textContent, evil);
});

test('Markdown replies: rendered while streaming, safe links, code-block actions', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const editorOps = () => p.sent.filter((m) => m.type === 'editor');
  p.pick('demo-http-strands');

  p.type('markdown please');
  // Mid-stream: already Markdown, and a half-received code block has no buttons yet
  assert.ok(await until(() => p.last().querySelector('.text h2'), 4000), 'heading rendered while streaming');
  await until(() => p.last().querySelector('.code-block'), 4000);
  if (!p.idle()) assert.strictEqual(p.last().querySelectorAll('.code-block .icon-btn').length, 0, 'no actions on an open block');
  await until(p.idle, 10000);

  const text = p.part(p.last(), 'text');
  assert.strictEqual(text.querySelector('h2').textContent, 'Deploying the demo agent');
  assert.strictEqual(text.querySelector('strong').textContent, 'deploy');
  assert.strictEqual(text.querySelector('em').textContent, 'one');
  assert.strictEqual(text.querySelector('ol').children.length, 3);
  assert.deepStrictEqual([...text.querySelectorAll('ol ul li')].map((li) => li.textContent), ['pick a region, e.g. eu-central-1', 'pick an execution role']);
  assert.ok(text.querySelector('blockquote code'));
  assert.ok(text.querySelector('hr'));

  const blocks = [...text.querySelectorAll('.code-block')];
  assert.deepStrictEqual(blocks.map((b) => b.querySelector('.lang').textContent), ['bash', 'python']);
  assert.strictEqual(blocks[1].querySelector('code').textContent, 'def handler(payload):\n    return {"result": payload["prompt"].upper()}');
  const labels = (block) => [...block.querySelectorAll('.code-head button')].map((b) => b.getAttribute('aria-label'));
  assert.deepStrictEqual(labels(blocks[0]), ['Copy', 'Insert at Cursor', 'Open in New File', 'Insert into Terminal (does not run it)']);
  assert.deepStrictEqual(labels(blocks[1]), ['Copy', 'Insert at Cursor', 'Open in New File'], 'terminal only for shell blocks');

  const [copy, insert, newFile, terminal] = blocks[0].querySelectorAll('.code-head button');
  copy.click();
  assert.strictEqual(copy.getAttribute('aria-label'), 'Copied');
  insert.click();
  terminal.click();
  blocks[1].querySelectorAll('.code-head button')[2].click();
  const bashText = 'agentcore configure --entrypoint agent.py\nagentcore launch';
  assert.deepStrictEqual(plain(editorOps()), [
    { type: 'editor', op: 'copy', text: bashText },
    { type: 'editor', op: 'insertAtCursor', text: bashText },
    { type: 'editor', op: 'insertInTerminal', text: bashText },
    { type: 'editor', op: 'newFile', text: blocks[1].querySelector('code').textContent, language: 'python' }
  ]);
  assert.ok(newFile);

  // Web links open through the extension; other schemes are plain text
  const links = [...text.querySelectorAll('a')];
  assert.deepStrictEqual(links.map((a) => a.textContent), ['AgentCore guide']);
  const click = new p.window.MouseEvent('click', { bubbles: true, cancelable: true });
  links[0].dispatchEvent(click);
  assert.ok(click.defaultPrevented, 'the webview never navigates');
  const url = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html';
  assert.deepStrictEqual(plain(editorOps().pop()), { type: 'editor', op: 'openLink', url });
  // No href, or VS Code's webview would open it itself, skipping the extension's prompt
  assert.ok(!links[0].hasAttribute('href'));
  assert.strictEqual(links[0].title, url);
  assert.strictEqual(links[0].tabIndex, 0, 'reachable with Tab');
  links[0].dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepStrictEqual(plain(editorOps().pop()), { type: 'editor', op: 'openLink', url }, 'Enter opens it');
  assert.ok(text.textContent.includes('plain text: local file.'));

  // Copy reply copies the original Markdown, not the rendered text
  const copyReply = p.last().querySelector('.reply-actions button');
  assert.strictEqual(copyReply.getAttribute('aria-label'), 'Copy reply');
  copyReply.click();
  assert.match(editorOps().pop().text, /^## Deploying the demo agent\n\nHere is how to \*\*deploy\*\*/);
  assert.ok(!p.last().querySelector('.retry'), 'no Retry on a successful reply');
});

test('agent text is never parsed as HTML', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  p.type('hi');
  const requestId = p.sent.find((m) => m.action === 'invoke_agent').requestId;
  await until(p.idle);
  // A second reply driven by hand, as if the agent sent it
  p.type('again');
  const id2 = p.sent.filter((m) => m.action === 'invoke_agent').pop().requestId;
  assert.notStrictEqual(id2, requestId);
  p.post({ type: 'chunk', requestId: id2, text: '<img src=x onerror=alert(1)> [x](javascript:alert(2)) <script>alert(3)</script>\n```html\n<b>hi</b>\n```' });
  p.post({ type: 'done', requestId: id2, meta: { protocol: 'A2A', state: 'completed' } });
  const text = p.part(p.last(), 'text');
  assert.strictEqual(p.document.querySelectorAll('#chat img, #chat script, #chat b').length, 0);
  assert.strictEqual(text.querySelectorAll('a').length, 0, 'javascript: link stays text');
  assert.ok(text.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.strictEqual(text.querySelector('code').textContent, '<b>hi</b>');
});

test('Retry: only on the latest failed reply, resends the same request in place', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const invokes = () => p.sent.filter((m) => m.action === 'invoke_agent');
  p.pick('demo-http-strands');

  p.type('error please');
  await until(p.idle);
  const failed = p.last();
  assert.ok(p.part(failed, 'error-text'));
  assert.strictEqual(p.part(failed, 'reply-actions').querySelectorAll('.icon-btn').length, 0, 'nothing to copy');
  failed.querySelector('.retry').click();
  assert.ok(!p.idle(), 'busy again');
  assert.strictEqual(p.bubbles().length, 1, 'the new reply takes the failed one\'s place');
  assert.strictEqual(p.document.querySelectorAll('.msg.user').length, 1, 'the prompt is not repeated');
  const [first, second] = plain(invokes());
  assert.notStrictEqual(first.requestId, second.requestId);
  delete first.requestId;
  delete second.requestId;
  assert.deepStrictEqual(second, first, 'same prompt, agent, protocol and session');
  await until(p.idle);
  assert.ok(p.last().querySelector('.retry'), 'failed again: Retry offered again');

  p.type('hi');
  assert.strictEqual(p.document.querySelectorAll('.retry').length, 0, 'a new prompt removes older Retry buttons');
  await until(p.idle);
  assert.ok(!p.last().querySelector('.retry'));

  // Backend lost mid-reply: Retry too
  p.type('slow');
  await sleep(100);
  p.post({ type: 'bridge', state: 'restarting' });
  assert.ok(p.last().querySelector('.retry'));
});

test('thinking timer counts until the first words arrive', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  p.pick('demo-http-strands');

  p.type('slow');  // a second before each line
  const elapsed = () => p.last().querySelector('.elapsed');
  assert.strictEqual(elapsed().textContent, 'Thinking');
  assert.ok(await until(() => elapsed() && elapsed().textContent === 'Thinking · 1s', 2500), 'counts seconds');
  await until(() => !elapsed(), 6000);
  assert.ok(p.part(p.last(), 'text').textContent.length > 0, 'replaced by the reply text');
  p.$('stopBtn').click();
  await until(p.idle);
});

test('smart scrolling: follows the reply until the user scrolls up', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;
  const chat = $('chat');
  // jsdom has no layout: give the chat a fake size
  let height = 1000;
  Object.defineProperty(chat, 'scrollHeight', { get: () => height });
  Object.defineProperty(chat, 'clientHeight', { get: () => 300 });
  const userScroll = (top) => {
    chat.scrollTop = top;
    chat.dispatchEvent(new p.window.Event('scroll'));
  };

  p.type('hi');
  assert.strictEqual(chat.scrollTop, 1000, 'sending scrolls to the bottom');
  userScroll(chat.scrollTop);
  userScroll(200);  // the user scrolls up to read
  assert.strictEqual($('jumpBtn').hidden, false, 'Jump to latest shown');
  height = 1500;    // more text arrives
  await until(p.idle);
  assert.strictEqual(chat.scrollTop, 200, 'view left alone');
  assert.strictEqual($('jumpBtn').hidden, false);

  $('jumpBtn').click();
  assert.strictEqual(chat.scrollTop, 1500);
  assert.strictEqual($('jumpBtn').hidden, true);

  userScroll(400);
  userScroll(1190);  // back near the bottom: following again
  assert.strictEqual($('jumpBtn').hidden, true);
  userScroll(300);
  p.type('more');
  assert.strictEqual(chat.scrollTop, 1500, 'a new prompt always scrolls down');
  assert.strictEqual($('jumpBtn').hidden, true);
  await until(p.idle);

  // Small scrolls up near the bottom (a trackpad's first steps) still stop following
  userScroll(1500);
  userScroll(1490);
  assert.strictEqual($('jumpBtn').hidden, false, 'a few pixels up is enough');
  $('jumpBtn').click();
  // Wheel up stops following before any scroll event arrives
  chat.dispatchEvent(new p.window.WheelEvent('wheel', { deltaY: -4 }));
  assert.strictEqual($('jumpBtn').hidden, false);
  p.type('again');
  await until(p.idle);
  p.type('and again');
  chat.dispatchEvent(new p.window.WheelEvent('wheel', { deltaY: -4 }));
  height = 2000;
  await until(p.idle);
  assert.strictEqual(chat.scrollTop, 1500, 'new text did not pull the view down');
});

test('keyboard: ↑ recalls the last prompt, Esc stops the reply', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;
  const key = (target, k) => {
    const event = new p.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  p.pick('demo-http-strands');

  assert.ok(!key($('promptInput'), 'ArrowUp').defaultPrevented, 'nothing to recall yet');
  p.type('slow one');
  key(p.document.body, 'Escape');
  await until(p.idle);
  assert.ok(p.sent.some((m) => m.action === 'cancel'), 'Esc sent cancel');
  assert.ok(p.part(p.last(), 'footer').textContent.endsWith('cancelled'));

  key($('promptInput'), 'ArrowUp');
  assert.strictEqual($('promptInput').value, 'slow one');
  $('promptInput').value = 'draft';
  assert.ok(!key($('promptInput'), 'ArrowUp').defaultPrevented, '↑ moves the cursor normally when there is text');
  assert.strictEqual($('promptInput').value, 'draft');

  const cancels = p.sent.filter((m) => m.action === 'cancel').length;
  assert.ok(!key(p.document.body, 'Escape').defaultPrevented, 'Esc when idle is left to VS Code');
  assert.strictEqual(p.sent.filter((m) => m.action === 'cancel').length, cancels, 'Esc when idle does nothing');
});
