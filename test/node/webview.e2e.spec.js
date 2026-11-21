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

  assert.ok(p.empty(), 'welcome card shown');
  assert.strictEqual(p.empty().querySelector('h2').textContent, 'demo-a2a');
  assert.strictEqual($('promptInput').placeholder, 'Ask demo-a2a...');

  p.pick('demo-http-strands');
  const card = p.empty();
  assert.strictEqual(card.querySelector('h2').textContent, 'demo-http-strands');
  assert.strictEqual(card.querySelector('.protocol').textContent, 'HTTP agent');
  assert.strictEqual(card.querySelectorAll('.chip').length, 3, 'generic suggestions');
  assert.strictEqual($('promptInput').placeholder, 'Ask demo-http-strands...');

  card.querySelector('.chip').click();
  assert.strictEqual($('promptInput').value, 'What can you help me with?');
  assert.ok(!p.sent.some((m) => m.action === 'invoke_agent'), 'a chip fills the composer but does not send');

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
  const table = text.querySelector('.table-wrap table');
  assert.deepStrictEqual([...table.querySelectorAll('th')].map((th) => th.textContent), ['Step', 'Command', 'Time']);
  assert.deepStrictEqual([...table.querySelectorAll('tbody tr')].map((tr) => tr.textContent), ['Configureagentcore configure1 min', 'Launchagentcore launch5 min']);
  assert.ok(table.querySelector('td code'), 'inline Markdown inside cells');
  assert.strictEqual(table.querySelector('tbody td:last-child').className, 'align-right');

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

test('A2A Agent Card: version, skills and example chips; asked once per agent', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;
  const cardRequests = () => p.sent.filter((m) => m.action === 'get_agent_card');

  assert.ok(await until(() => p.empty().querySelector('.skills')), 'skills shown once the card arrives');
  const card = p.empty();
  assert.strictEqual(card.querySelector('.protocol').textContent, 'A2A agent · v1.2.0');
  assert.deepStrictEqual([...card.querySelectorAll('.skill')].map((s) => s.textContent), ['Deploy services', 'Explain errors']);
  assert.strictEqual(card.querySelector('.skill').title, 'Plans and runs deployments to dev or prod.');
  assert.deepStrictEqual([...card.querySelectorAll('.chip')].map((c) => c.textContent), [
    "Deploy the billing service (I'll ask for input)", 'Show the deployment guide as markdown', 'Why did the last deploy fail?'
  ]);
  assert.deepStrictEqual(plain(cardRequests()), [{ action: 'get_agent_card', profile: $('profileSelect').value, agentArn: $('agentSelect').value }]);

  // HTTP agents have no card; going back to the A2A agent uses the one already fetched
  p.pick('demo-http-strands');
  assert.ok(!p.empty().querySelector('.skills'));
  p.pick('demo-a2a');
  assert.ok(p.empty().querySelector('.skills'));
  assert.strictEqual(cardRequests().length, 1, 'cached in the panel');

  // Switched to HTTP: no card shown; an agent without a card keeps the generic chips
  p.toggle('HTTP');
  assert.ok(!p.empty().querySelector('.skills'));
  p.toggle('A2A');
  assert.ok(p.empty().querySelector('.skills'), 'back to A2A: card shown again');
  p.pick('demo-unknown');
  p.toggle('A2A');
  await until(() => cardRequests().length === 2);
  await sleep(300);
  assert.ok(!p.empty().querySelector('.skills'));
  assert.strictEqual(p.empty().querySelector('.chip').textContent, 'What can you help me with?');

  // Refresh asks again
  $('refreshBtn').click();
  await p.ready();
  await until(() => cardRequests().length === 3);
  assert.strictEqual(cardRequests().length, 3);

  // A chip with "markdown" in it: the A2A reply renders it
  p.pick('demo-a2a');
  await until(() => p.empty() && p.empty().querySelector('.skills'));
  [...p.empty().querySelectorAll('.chip')][1].click();
  $('sendBtn').click();
  await until(p.idle, 10000);
  assert.strictEqual(p.part(p.last(), 'text').querySelector('h2').textContent, 'Deploying the demo agent');
});

test('A2A auto streaming follows the Agent Card', async (t) => {
  const p = openPanel({ settings: { ...MOCK_SETTINGS, a2aStreaming: 'auto' } });
  t.after(p.close);
  await p.ready();
  p.type('hi');
  await until(p.idle);
  assert.match(p.part(p.last(), 'footer').textContent, /^A2A · streamed · \d+\.\ds · completed$/);

  p.pick('demo-unknown');
  p.toggle('A2A');
  p.type('hi');
  await until(p.idle);
  assert.match(p.part(p.last(), 'footer').textContent, /^A2A · \d+\.\ds · completed$/, 'no card: message/send');
});

test('trace ID: copy it or open CloudWatch from the reply; also on agent failures', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const editorOps = () => p.sent.filter((m) => m.type === 'editor');
  const labels = () => [...p.last().querySelectorAll('.reply-actions button')].map((b) => b.getAttribute('aria-label') || b.textContent);

  p.type('hi');
  await until(p.idle);
  const [copy, trace, cloudwatch] = p.last().querySelectorAll('.reply-actions button');
  assert.strictEqual(copy.getAttribute('aria-label'), 'Copy reply');
  const traceId = trace.getAttribute('aria-label').match(/^Copy trace ID \((1-[0-9a-f]{8}-[0-9a-f]{24})\)$/)[1];
  trace.click();
  assert.deepStrictEqual(plain(editorOps().pop()), { type: 'editor', op: 'copy', text: traceId });
  assert.strictEqual(cloudwatch.getAttribute('aria-label'), 'Open in CloudWatch (GenAI Observability)');
  cloudwatch.click();
  assert.deepStrictEqual(plain(editorOps().pop()), {
    type: 'editor', op: 'openLink',
    url: 'https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#gen-ai-observability'
  });

  p.type('please fail');  // the A2A task fails: the agent was reached
  await until(p.idle);
  assert.ok(p.part(p.last(), 'error-text'));
  assert.ok(labels()[0].startsWith('Copy trace ID'), 'trace offered on a failed reply');
  assert.ok(p.last().querySelector('.retry'));

  p.type('error');  // the call itself failed: no trace
  await until(p.idle);
  assert.ok(!labels().some((l) => l.startsWith('Copy trace ID')));
});

test('profile tooltip shows who you are signed in as', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const select = p.$('profileSelect');
  assert.ok(await until(() => select.title.startsWith('mock-user')));
  assert.strictEqual(select.title, 'mock-user@example.com\nAccount 123456789012 · eu-central-1');
  const whoami = () => p.sent.filter((m) => m.action === 'whoami');
  assert.strictEqual(whoami().length, 1);

  // Region setting changed: asked again, shows the new region
  p.post({ type: 'settings', data: { ...MOCK_SETTINGS, region: 'us-west-2' } });
  assert.strictEqual(whoami().length, 2);
  // (the jsdom harness keeps sending the original settings to Python, so only the request is checked)

  p.post({ type: 'identity', profile: select.value, error: 'SSO session expired' });
  assert.strictEqual(select.title, `AWS profile ${select.value}: SSO session expired`);
  p.post({ type: 'identity', profile: 'some-other-profile', account: '9', region: 'x', user: 'stale' });
  assert.strictEqual(select.title, `AWS profile ${select.value}: SSO session expired`, 'answers for other profiles are ignored');
});

test('agent picker: search by name or description, pick by mouse or keyboard', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;
  const key = (k) => {
    const event = new p.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    $('agentSearch').dispatchEvent(event);
    return event;
  };
  const search = (text) => {
    $('agentSearch').value = text;
    $('agentSearch').dispatchEvent(new p.window.Event('input'));
  };
  const rows = () => [...$('agentList').querySelectorAll('.agent-option')];
  const names = () => rows().map((r) => r.querySelector('.name').textContent);

  assert.strictEqual($('agentSelect').hidden, true, 'the native select is only the model');
  assert.strictEqual($('agentName').textContent, 'demo-a2a');
  assert.strictEqual($('agentPicker').hidden, true);

  $('agentBtn').click();
  assert.strictEqual($('agentPicker').hidden, false);
  assert.strictEqual($('agentBtn').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(p.document.activeElement, $('agentSearch'), 'search box focused');
  assert.strictEqual($('agentSearch').placeholder, 'Search 3 agents...');
  assert.deepStrictEqual(names(), ['demo-a2a', 'demo-http-strands', 'demo-unknown']);
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.proto').textContent), ['A2A', 'HTTP', '?']);
  assert.ok(rows()[0].classList.contains('current') && rows()[0].classList.contains('active'), 'starts on the current agent');
  assert.strictEqual(rows()[1].querySelector('.desc').textContent, 'Mock Strands agent over HTTP (SSE streaming)');

  // Name match, case-insensitive, highlighted
  search('HTTP-S');
  assert.deepStrictEqual(names(), ['demo-http-strands']);
  assert.strictEqual(rows()[0].querySelector('.name mark').textContent, 'http-s');
  // Description match
  search('json-rpc');
  assert.deepStrictEqual(names(), ['demo-a2a']);
  assert.strictEqual(rows()[0].querySelector('.desc mark').textContent, 'JSON-RPC');
  // Nothing matches
  search('zzz');
  assert.strictEqual(rows().length, 0);
  assert.match($('agentList').textContent, /No agents match/);
  const refreshes = p.sent.filter((m) => m.action === 'list_agents' && m.refresh).length;
  $('agentList').querySelector('.link').click();
  assert.strictEqual(p.sent.filter((m) => m.action === 'list_agents' && m.refresh).length, refreshes + 1);
  assert.strictEqual($('agentPicker').hidden, true);
  await p.ready();

  // Keyboard: ↓ wraps around, Enter picks
  $('agentBtn').click();
  search('demo');
  key('ArrowUp');
  assert.ok(rows()[2].classList.contains('active'), '↑ from the first row wraps to the last');
  key('ArrowDown');
  key('ArrowDown');
  assert.ok(rows()[1].classList.contains('active'));
  assert.ok(key('Enter').defaultPrevented);
  assert.strictEqual($('agentPicker').hidden, true);
  assert.strictEqual($('agentName').textContent, 'demo-http-strands');
  assert.strictEqual(p.empty().querySelector('h2').textContent, 'demo-http-strands', 'main.js saw the change');
  assert.strictEqual(p.document.activeElement, $('agentBtn'));

  // Mouse: click a row
  $('agentBtn').click();
  rows()[2].click();
  assert.strictEqual($('agentName').textContent, 'demo-unknown');

  // Esc closes the picker only; a click outside closes it too
  p.pick('demo-http-strands');
  assert.strictEqual($('agentName').textContent, 'demo-http-strands', 'chip follows the select');
  p.type('slow');
  $('agentBtn').click();
  key('Escape');
  assert.strictEqual($('agentPicker').hidden, true);
  assert.ok(!p.sent.some((m) => m.action === 'cancel'), 'Esc in the picker does not stop the reply');
  $('agentBtn').click();
  p.$('chat').dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true }));
  assert.strictEqual($('agentPicker').hidden, true);

  // Picking another agent mid-chat starts a new chat, as before
  $('agentBtn').click();
  rows()[0].click();
  assert.strictEqual(p.bubbles().length, 0);
  assert.ok(p.sent.some((m) => m.action === 'reset_session'));
});

test('agent picker: empty states and untrusted text', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const { $ } = p;

  p.post({ type: 'agents', profile: $('profileSelect').value, data: [] });
  await sleep(10);  // the picker follows the select after the DOM update
  assert.strictEqual($('agentName').textContent, 'No agents found');
  assert.ok($('agentBtn').disabled, 'nothing to pick');
  $('agentBtn').click();
  assert.strictEqual($('agentPicker').hidden, true);

  const evil = '<img src=x onerror=alert(1)>';
  p.post({ type: 'agents', profile: $('profileSelect').value, data: [
    { name: evil, arn: 'arn:1', description: '<b>bold</b> <script>alert(2)</script>', protocol: 'A2A' }
  ] });
  await sleep(10);
  assert.ok(!$('agentBtn').disabled);
  assert.strictEqual($('agentName').textContent, evil);
  $('agentBtn').click();
  const searchFor = (text) => {
    $('agentSearch').value = text;
    $('agentSearch').dispatchEvent(new p.window.Event('input'));
  };
  searchFor('img');
  const row = $('agentList').querySelector('.agent-option');
  assert.strictEqual(row.querySelector('.name').textContent, evil);
  assert.strictEqual(row.querySelector('.desc').textContent, '<b>bold</b> <script>alert(2)</script>');
  assert.strictEqual(p.document.querySelectorAll('#agentList img, #agentList b, #agentList script').length, 0);
  assert.strictEqual($('agentSearch').placeholder, 'Search 1 agent...');
});

test('JSON replies: shown whole as Markdown, with Open raw JSON', async (t) => {
  const p = openPanel();
  t.after(p.close);
  await p.ready();
  const editorOps = () => p.sent.filter((m) => m.type === 'editor');
  p.pick('demo-http-strands');

  p.type('structured please');
  await until(p.idle);
  const text = p.part(p.last(), 'text');
  assert.strictEqual(text.querySelector('p').textContent, 'Deployed billing-service to dev.');
  assert.ok(text.textContent.includes('Status: success'));
  assert.deepStrictEqual([...text.querySelectorAll('th')].map((th) => th.textContent), ['Title', 'Url']);
  assert.deepStrictEqual([...text.querySelectorAll('ul li')].map((li) => li.textContent), ['Run the smoke tests', 'Promote to prod']);
  assert.ok(!text.textContent.includes('inputTokens'), 'plumbing hidden');
  assert.strictEqual(text.querySelectorAll('a').length, 2, 'URLs in the table are links');

  const button = [...p.last().querySelectorAll('.reply-actions button')].find((b) => b.getAttribute('aria-label') === 'Open raw JSON');
  button.click();
  const op = editorOps().pop();
  assert.strictEqual(op.op, 'newFile');
  assert.strictEqual(op.language, 'json');
  assert.deepStrictEqual(Object.keys(JSON.parse(op.text)).slice(0, 3), ['message', 'status', 'confidence'], 'the original, including hidden fields');
  assert.ok(JSON.parse(op.text).usage);

  // A2A: a text part plus a data part
  p.pick('demo-a2a');
  p.type('structured please');
  await until(p.idle);
  const a2a = p.part(p.last(), 'text');
  assert.ok(a2a.textContent.startsWith('Deployed billing-service to dev.'));
  assert.ok(a2a.querySelector('table'));
  assert.ok([...p.last().querySelectorAll('.reply-actions button')].some((b) => b.getAttribute('aria-label') === 'Open raw JSON'));

  // A plain reply has no raw JSON button
  p.type('hi');
  await until(p.idle);
  assert.ok(![...p.last().querySelectorAll('.reply-actions button')].some((b) => b.getAttribute('aria-label') === 'Open raw JSON'));
});

test('JSON replies: text and raw modes', async (t) => {
  const p = openPanel({ settings: { ...MOCK_SETTINGS, jsonReplies: 'text' } });
  t.after(p.close);
  await p.ready();
  p.pick('demo-http-strands');
  p.type('structured please');
  await until(p.idle);
  assert.strictEqual(p.part(p.last(), 'text').textContent, 'Deployed billing-service to dev.');
  p.close();

  const q = openPanel({ settings: { ...MOCK_SETTINGS, jsonReplies: 'raw' } });
  t.after(q.close);
  await q.ready();
  q.pick('demo-http-strands');
  q.type('structured please');
  await until(q.idle);
  const block = q.part(q.last(), 'text').querySelector('.code-block');
  assert.strictEqual(block.querySelector('.lang').textContent, 'json');
  assert.ok(block.querySelector('code').textContent.includes('"usage"'), 'raw shows everything');
});
