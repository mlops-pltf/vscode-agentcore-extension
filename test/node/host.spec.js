// extension.js (the extension host side) against a stand-in `vscode` module and
// the real Python bridge. Run with `npm run test:js`.
const { test } = require('node:test');
const { assert, sleep, until, loadExtension, fireConfigChange, fakeView } = require('./helpers');

async function started(config) {
  const host = loadExtension(config);
  const view = fakeView();
  await host.provider.resolveWebviewView(view);
  return { ...host, view, posted: (pred) => view.posted.filter(pred) };
}

test('registers the chat view and commands; Open Chat focuses it', async (t) => {
  const { ext, state } = loadExtension();
  t.after(() => ext.deactivate());
  assert.deepStrictEqual(state.registered, ['agentcoreChatView']);
  for (const id of ['agentcore.openChat', 'agentcore.showLogs', 'agentcore.restartBackend']) {
    assert.ok(state.commands[id], id);
  }
  await state.commands['agentcore.openChat']();
  assert.strictEqual(state.executed.pop(), 'agentcoreChatView.focus');
  state.commands['agentcore.showLogs']();
  assert.ok(state.logs.includes('SHOWN'));
});

test('webview HTML: strict CSP, scripts with nonce, starting settings', async (t) => {
  const { ext, view } = await started({ region: 'eu-central-1' });
  t.after(() => ext.deactivate());
  assert.match(view.html, /Content-Security-Policy" content="default-src 'none'; style-src vscode-webview:\/\/test; script-src 'nonce-[^']+';"/);
  assert.ok(!view.html.includes("'unsafe-inline'"));
  assert.match(view.html, /"settings":\{"mock":true,"region":"eu-central-1"/);
  assert.ok(!/\$\{|\{\{/.test(view.html), 'no unreplaced placeholders');
});

test('settings reach Python; raw lines go to the log only', async (t) => {
  const { ext, state, view, posted } = await started();
  t.after(() => ext.deactivate());

  view.send({ action: 'list_agents', profile: 'dev' });
  assert.ok(await until(() => posted((m) => m.type === 'agents').length === 1), 'mock setting reached Python');

  state.config.debugRawResponses = true;
  view.send({ action: 'invoke_agent', requestId: 'R1', profile: 'dev', agentArn: 'arn:x/demo', prompt: 'json please', sessionId: 's'.repeat(36) });
  await until(() => posted((m) => m.type === 'done' && m.requestId === 'R1').length === 1);
  assert.ok(state.logs.some((l) => l.startsWith('info: [raw R1]')), 'raw line logged');
  assert.strictEqual(posted((m) => m.type === 'raw').length, 0, 'raw lines never reach the webview');
});

test("Python's log lines go to the Output channel only; old a2aStreaming values still work", async (t) => {
  const { ext, state, view, posted } = await started();
  t.after(() => ext.deactivate());

  view.send({ action: 'get_agent_card', profile: 'dev', agentArn: 'arn:x:runtime/demo_http-1' });
  assert.ok(await until(() => posted((m) => m.type === 'agent_card').length === 1));
  assert.ok(state.logs.some((l) => l.startsWith('warn: No Agent Card: ResourceNotFoundException')), 'logged as a warning');
  assert.strictEqual(posted((m) => m.type === 'log').length, 0, 'never posted to the panel');

  const { readSettings } = require('../../src/settings');
  for (const [stored, expected] of [[undefined, 'auto'], ['auto', 'auto'], ['on', 'on'], ['off', 'off'], [true, 'on'], [false, 'off'], ['bad', 'auto']]) {
    state.config.a2aStreaming = stored;
    assert.strictEqual(readSettings().a2aStreaming, expected, String(stored));
  }
});

test('settings changes: webview told; pythonPath change restarts Python', async (t) => {
  const { ext, state, provider, posted } = await started();
  t.after(() => ext.deactivate());
  const firstPid = provider.bridge.process.pid;

  state.config.mock = false;
  fireConfigChange(state, 'agentcore.mock');
  assert.strictEqual(posted((m) => m.type === 'settings' && m.data.mock === false).length, 1);
  assert.strictEqual(provider.bridge.process.pid, firstPid, 'mock change does not restart Python');

  fireConfigChange(state, 'agentcore.pythonPath');
  assert.ok(await until(() => provider.bridge.process && provider.bridge.process.pid !== firstPid), 'restarted');
});

test('crash recovery: restarts with backoff, queues messages, then gives up', { timeout: 60000 }, async (t) => {
  const { ext, state, provider, view, posted } = await started();
  t.after(() => ext.deactivate());

  const first = provider.bridge.process.pid;
  process.kill(first, 'SIGKILL');
  await until(() => posted((m) => m.type === 'bridge' && m.state === 'restarting').length === 1);
  view.send({ action: 'list_agents', profile: 'queued' });
  const t0 = Date.now();
  await until(() => provider.bridge.process && provider.bridge.process.pid !== first, 4000);
  const waited = Date.now() - t0;
  assert.ok(waited >= 700 && waited < 2500, `first restart after ~1s (took ${waited}ms)`);
  assert.ok(await until(() => posted((m) => m.type === 'agents' && m.profile === 'queued').length === 1), 'queued message delivered');

  for (const attempt of [2, 3]) {
    const pid = provider.bridge.process.pid;
    process.kill(pid, 'SIGKILL');
    assert.ok(await until(() => provider.bridge.process && provider.bridge.process.pid !== pid, 12000), `restart #${attempt}`);
  }
  process.kill(provider.bridge.process.pid, 'SIGKILL');
  assert.ok(await until(() => posted((m) => m.type === 'bridge' && m.state === 'down').length === 1), 'gives up');
  await sleep(200);
  assert.ok(state.errors.some((e) => e.buttons.join() === 'Show Logs,Restart'));
  assert.ok(!provider.bridge.process, 'no further restart');

  await state.commands['agentcore.restartBackend']();
  assert.ok(provider.bridge.process, 'Restart Backend starts it again');
});

test('editor actions from the panel are checked and carried out', async (t) => {
  const { ext, state, view } = await started();
  t.after(() => ext.deactivate());
  const editor = (op, fields) => view.send({ type: 'editor', op, ...fields });
  const settle = () => sleep(50);

  editor('copy', { text: '# reply' });
  await settle();
  assert.strictEqual(state.clipboard, '# reply');

  editor('openLink', { url: 'https://example.com/docs' });
  editor('openLink', { url: 'javascript:alert(1)' });
  editor('openLink', { url: 'file:///etc/hosts' });
  editor('openLink', { url: 'not a url' });
  await settle();
  assert.deepStrictEqual(state.opened, ['https://example.com/docs']);
  assert.strictEqual(state.logs.filter((l) => l.startsWith('warn: Blocked a link')).length, 3);

  editor('insertAtCursor', { text: 'x = 1' });
  await settle();
  assert.match(state.infos.pop(), /open a file first/, 'no editor: told, nothing thrown');
  const edits = [];
  state.editor = {
    document: 'the-doc', viewColumn: 1, selections: ['cursor-1', 'cursor-2'],
    edit: (fn) => { fn({ replace: (selection, text) => edits.push([selection, text]) }); return Promise.resolve(true); }
  };
  editor('insertAtCursor', { text: 'x = 1' });
  await settle();
  assert.deepStrictEqual(edits, [['cursor-1', 'x = 1'], ['cursor-2', 'x = 1']]);
  assert.strictEqual(state.shown.pop(), 'the-doc', 'editor focused after inserting');

  editor('newFile', { text: 'print(1)', language: 'py' });
  editor('newFile', { text: 'ls', language: 'bash' });
  editor('newFile', { text: '?', language: 'klingon' });
  await settle();
  assert.deepStrictEqual(state.documents.map((d) => d.language), ['python', 'shellscript', 'plaintext']);
  assert.strictEqual(state.documents[0].content, 'print(1)');

  editor('insertInTerminal', { text: 'ls -la\n' });
  await settle();
  const created = state.terminals.pop();
  assert.ok(created.shown);
  assert.deepStrictEqual(created.sent, [['ls -la', false]], 'inserted, never run');

  const active = state.newTerminal('zsh');
  active.active = true;
  editor('insertInTerminal', { text: 'cd /tmp\nls\n' });
  await settle();
  assert.deepStrictEqual(active.sent, [], 'multi-line text is pasted, not sent line by line');
  assert.strictEqual(state.pasted, 'cd /tmp\nls');
  assert.strictEqual(state.clipboard, '# reply', "the user's clipboard is put back");

  editor('runCommand', { text: 'rm -rf /' });
  editor('copy', { text: 'x'.repeat(1000001) });
  await settle();
  assert.ok(state.logs.includes('warn: Unknown editor action from the panel: runCommand'));
  assert.strictEqual(state.clipboard, '# reply', 'oversized text ignored');
  assert.ok(!view.posted.some((m) => m.type === 'error'), 'editor messages never reach Python');
});

test('a missing Python is reported, not thrown', async (t) => {
  const { ext, state, provider } = await started();
  t.after(() => ext.deactivate());
  state.config.pythonPath = '/nonexistent/python3';
  fireConfigChange(state, 'agentcore.pythonPath');
  provider.bridge.send({ action: 'list_profiles' });  // must not throw EPIPE
  await sleep(500);
  assert.ok(state.logs.some((l) => l.includes('could not start') && l.includes('ENOENT')));
});

test('view hand-over keeps Python; disposing the current view stops it', async (t) => {
  const { ext, provider, view } = await started();
  t.after(() => ext.deactivate());
  const pid = provider.bridge.process.pid;

  const moved = fakeView();
  await provider.resolveWebviewView(moved);
  view.dispose();
  await sleep(300);
  assert.strictEqual(provider.bridge.process && provider.bridge.process.pid, pid, 'same Python after the move');
  moved.send({ action: 'list_agents', profile: 'dev' });
  assert.ok(await until(() => moved.posted.some((m) => m.type === 'agents')));
  assert.ok(!view.posted.some((m) => m.type === 'agents'), 'old view gets nothing');

  moved.dispose();
  await sleep(300);
  assert.ok(!provider.bridge.process, 'Python stopped with the current view');
});

test('deactivate stops Python and it is not restarted', async () => {
  const { ext, provider } = await started();
  const proc = provider.bridge.process;
  ext.deactivate();
  await sleep(1000);
  assert.ok(proc.exitCode !== null || proc.signalCode !== null);
  assert.ok(!provider.bridge.process);
});
