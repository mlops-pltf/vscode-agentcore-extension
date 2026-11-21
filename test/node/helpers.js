// Shared helpers for the Node tests (run with `npm run test:js`):
// - a stand-in for the `vscode` module that records what the extension does
// - loading a fresh copy of extension.js against that stand-in
// - the panel's HTML, and a panel running in jsdom wired to the real Python bridge
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const readline = require('node:readline');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..', '..');
const PYTHON = path.join(REPO, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const MOCK_SETTINGS = { mock: true, region: 'eu-central-1', a2aStreaming: false, debugRaw: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, ms = 6000) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) await sleep(30);
  return predicate();
}

// ---------- vscode stand-in ----------

let currentStub;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? currentStub : originalLoad.call(this, request, ...rest);
};

function createVscodeStub(config = {}) {
  const state = {
    config: { mock: true, ...config },
    logs: [],
    errors: [],
    commands: {},
    executed: [],
    registered: [],
    configListeners: []
  };
  const log = (level) => (message) => state.logs.push(`${level}: ${message}`);
  currentStub = {
    __state: state,
    ProgressLocation: { Notification: 15 },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    window: {
      createOutputChannel: () => ({ info: log('info'), warn: log('warn'), error: log('error'), show: () => state.logs.push('SHOWN'), dispose() {} }),
      registerWebviewViewProvider: (id, provider) => { state.registered.push(id); state.provider = provider; return { dispose() {} }; },
      showErrorMessage: (message, ...buttons) => { state.errors.push({ message, buttons }); return Promise.resolve(undefined); },
      withProgress: (_options, task) => task(),
      createTerminal: () => ({ show() {}, sendText() {} })
    },
    commands: {
      registerCommand: (id, fn) => { state.commands[id] = fn; return { dispose() {} }; },
      executeCommand: (id) => { state.executed.push(id); return Promise.resolve(); }
    },
    workspace: {
      getConfiguration: () => ({ get: (key) => state.config[key] }),
      onDidChangeConfiguration: (fn) => { state.configListeners.push(fn); return { dispose() {} }; }
    }
  };
  return state;
}

// A fresh extension.js (and anything it loads from the repo) against a new stub
function loadExtension(config) {
  const state = createVscodeStub(config);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(REPO) && !key.includes('node_modules') && !key.includes(path.join('test', 'node'))) {
      delete require.cache[key];
    }
  }
  const ext = require(path.join(REPO, 'extension.js'));
  ext.activate({ subscriptions: [], extensionUri: { fsPath: REPO }, globalStorageUri: { fsPath: path.join(REPO, '.git', 'test-global-storage') } });
  return { ext, state, provider: state.provider };
}

function fireConfigChange(state, ...keys) {
  const affects = (key) => key === 'agentcore' || keys.includes(key);
  state.configListeners.forEach((fn) => fn({ affectsConfiguration: affects }));
}

// A fake webview view that records what the extension posts to it
function fakeView() {
  const view = { posted: [], disposers: [], html: '' };
  view.webview = {
    options: {},
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri) => 'vscode-resource:' + uri.fsPath,
    set html(value) { view.html = value; },
    onDidReceiveMessage: (fn) => { view.send = fn; },
    postMessage: (message) => { view.posted.push(message); return Promise.resolve(true); }
  };
  view.onDidDispose = (fn) => view.disposers.push(fn);
  view.dispose = () => view.disposers.forEach((fn) => fn());
  return view;
}

// ---------- the panel in jsdom ----------

function panelHtml() {
  const { provider } = loadExtension();
  return provider._getHtml(fakeView().webview);
}

// jsdom can't fetch vscode-resource: URLs, so the panel's own scripts are inlined
function inlineScripts(html) {
  return html.replace(/<script nonce="[^"]+" src="vscode-resource:([^"]+)"><\/script>/g,
    (_tag, file) => `<script>${fs.readFileSync(file, 'utf8')}</script>`);
}

function openPanel({ savedState, settings = MOCK_SETTINGS } = {}) {
  const python = cp.spawn(PYTHON, ['-W', 'ignore', path.join(REPO, 'python', 'bridge.py')]);
  const sent = [];
  let state = savedState;
  const dom = new JSDOM(inlineScripts(panelHtml()), {
    runScripts: 'dangerously',
    beforeParse(window) {
      // Plays the part of extension.js: forwards actions to Python with settings
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => {
          sent.push(message);
          if (message.action) python.stdin.write(JSON.stringify({ ...message, settings }) + '\n');
        },
        getState: () => state,
        setState: (value) => { state = value; }
      });
    }
  });
  const window = dom.window;
  const document = window.document;
  readline.createInterface({ input: python.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type !== 'raw') window.dispatchEvent(new window.MessageEvent('message', { data: message }));
  });

  const $ = (id) => document.getElementById(id);
  const panel = {
    window, document, $, sent, python,
    getState: () => state,
    post: (data) => window.dispatchEvent(new window.MessageEvent('message', { data })),
    bubbles: () => [...document.querySelectorAll('.msg.agent')],
    last: () => panel.bubbles().slice(-1)[0],
    part: (bubble, cls) => bubble && bubble.querySelector('.' + cls),
    empty: () => document.querySelector('#chat .empty'),
    type: (text) => {
      $('promptInput').value = text;
      $('promptInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    },
    pick: (name) => {
      const select = $('agentSelect');
      select.value = [...select.options].find((o) => o.textContent === name).value;
      select.dispatchEvent(new window.Event('change'));
    },
    pressed: () => document.querySelector('#protocolToggle button[aria-pressed="true"]').dataset.protocol,
    toggle: (protocol) => document.querySelector(`#protocolToggle button[data-protocol="${protocol}"]`).click(),
    idle: () => !$('sendBtn').disabled && $('stopBtn').disabled,
    ready: () => until(() => $('agentSelect').options.length === 3),
    close: () => { python.kill(); window.close(); }
  };
  return panel;
}

module.exports = {
  assert, REPO, MOCK_SETTINGS, sleep, until,
  loadExtension, fireConfigChange, fakeView, panelHtml, openPanel
};
