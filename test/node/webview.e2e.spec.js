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
