const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

// Restart the Python bridge after these delays if it crashes; give up when it
// crashes more than RESTART_DELAYS_MS.length times within CRASH_WINDOW_MS
const RESTART_DELAYS_MS = [1000, 3000, 10000];
const CRASH_WINDOW_MS = 60000;

let provider;

function activate(context) {
  const log = vscode.window.createOutputChannel('AgentCore Chat', { log: true });
  provider = new AgentCoreViewProvider(context, log);
  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider('agentcoreChatView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('agentcore.showLogs', () => log.show()),
    vscode.commands.registerCommand('agentcore.restartBackend', () => provider.restartBridge()),
    vscode.workspace.onDidChangeConfiguration((e) => provider.onConfigChanged(e))
  );
}

class AgentCoreViewProvider {
  constructor(context, log) {
    this._context = context;
    this._extensionUri = context.extensionUri;
    this._log = log;
    this._view = undefined;
    this._pyProcess = undefined;
    // Messages sent before Python is running (e.g. during first-time venv setup)
    this._pending = [];
    // Times of recent unexpected bridge exits, for restart backoff
    this._crashTimes = [];
    this._disposed = false;
  }

  dispose() {
    this._disposed = true;
    this._stopBridge();
  }

  // Sent to Python with every message, so Python never keeps stale settings
  _settings() {
    const config = vscode.workspace.getConfiguration('agentcore');
    return {
      mock: config.get('mock') === true,
      region: config.get('region') || '',
      a2aStreaming: config.get('a2aStreaming') === true,
      debugRaw: config.get('debugRawResponses') === true
    };
  }

  onConfigChanged(event) {
    if (!event.affectsConfiguration('agentcore')) return;
    this._log.info('Settings changed: ' + JSON.stringify(this._settings()));
    if (event.affectsConfiguration('agentcore.pythonPath')) {
      this.restartBridge();
    }
    // The webview reloads the agent list if mock mode or region changed
    this._post({ type: 'settings', data: this._settings() });
  }

  async restartBridge() {
    this._crashTimes = [];
    this._stopBridge();
    await this._startPythonBridge();
  }

  _stopBridge() {
    const proc = this._pyProcess;
    this._pyProcess = undefined;
    if (proc) {
      proc.stoppedOnPurpose = true;
      proc.kill();
    }
  }

  _post(message) {
    this._view?.webview.postMessage(message);
  }

  async resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media', 'webview')]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Listen before starting Python so the webview's first messages aren't lost
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ssoLogin') {
        // Profile name goes into a shell command, so only allow safe characters
        if (!/^[\w.@+-]+$/.test(msg.profile || '')) {
          vscode.window.showErrorMessage(`AgentCore Chat: refusing to run SSO login for invalid profile name "${msg.profile}".`);
          return;
        }
        const terminal = vscode.window.createTerminal(`AWS SSO (${msg.profile})`);
        terminal.show();
        terminal.sendText(`aws sso login --profile ${msg.profile}`);
        return;
      }
      if (msg.type === 'restartBackend') {
        vscode.commands.executeCommand('agentcore.restartBackend');
        return;
      }
      if (msg.type === 'showLogs') {
        vscode.commands.executeCommand('agentcore.showLogs');
        return;
      }
      this._sendToPython(msg);
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._stopBridge();
    });

    await this._startPythonBridge();
  }

  async _ensurePythonEnv() {
    const config = vscode.workspace.getConfiguration('agentcore');
    const customPython = config.get('pythonPath');
    const isWin = process.platform === 'win32';

    // 1. Respect explicit user override if set
    if (customPython && customPython !== 'python3') {
      return customPython;
    }

    // 2. Check local .venv (for local development)
    const localVenv = path.join(
      this._extensionUri.fsPath,
      '.venv',
      isWin ? 'Scripts' : 'bin',
      isWin ? 'python.exe' : 'python'
    );
    if (fs.existsSync(localVenv)) {
      return localVenv;
    }

    // 3. Auto-bootstrap .venv in VS Code global storage for end users
    const storageDir = this._context.globalStorageUri.fsPath;
    const managedVenvDir = path.join(storageDir, 'venv');
    const managedPython = path.join(
      managedVenvDir,
      isWin ? 'Scripts' : 'bin',
      isWin ? 'python.exe' : 'python'
    );

    // Re-install when requirements.txt changes (hash stored inside the venv)
    const reqPath = path.join(this._extensionUri.fsPath, 'python', 'requirements.txt');
    const reqHash = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex');
    const hashFile = path.join(managedVenvDir, '.req-hash');
    const venvExists = fs.existsSync(managedPython);

    if (venvExists && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === reqHash) {
      return managedPython;
    }

    const basePython = isWin ? 'python' : 'python3';
    const steps = [];
    if (!venvExists) {
      steps.push(`"${basePython}" -m venv "${managedVenvDir}"`);
      steps.push(`"${managedPython}" -m pip install --upgrade pip -q`);
    }
    steps.push(`"${managedPython}" -m pip install -r "${reqPath}" -q`);

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: venvExists
          ? 'AgentCore Chat: Updating Python dependencies...'
          : 'AgentCore Chat: Setting up Python environment (first-time setup)...',
        cancellable: true
      },
      () =>
        new Promise((resolve, reject) => {
          fs.mkdirSync(storageDir, { recursive: true });
          cp.exec(steps.join(' && '), (err, _stdout, stderr) => {
            if (err) {
              vscode.window.showErrorMessage(
                `AgentCore Chat setup failed (Python 3.9+ required): ${stderr || err.message}`
              );
              reject(err);
            } else {
              fs.writeFileSync(hashFile, reqHash);
              resolve(managedPython);
            }
          });
        })
    );
  }

  async _startPythonBridge() {
    if (this._disposed || this._pyProcess) return;
    let pythonPath;
    try {
      pythonPath = await this._ensurePythonEnv();
    } catch (e) {
      this._log.error(`Python environment setup failed: ${e.message}`);
      return;
    }
    // Something else may have started or stopped the bridge while we waited
    if (this._disposed || this._pyProcess) return;

    const scriptPath = path.join(this._extensionUri.fsPath, 'python', 'bridge.py');
    this._log.info(`Starting Python bridge: ${pythonPath} ${scriptPath}`);
    const proc = cp.spawn(pythonPath, [scriptPath]);
    this._pyProcess = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onPythonLine(line));
    proc.stderr.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) this._log.warn(`[python] ${line}`);
      }
    });
    // Writing to a process that just died raises EPIPE; log it instead of crashing
    proc.stdin.on('error', (e) => this._log.warn(`Python stdin: ${e.message}`));
    proc.on('error', (e) => {
      this._log.error(`Python bridge could not start: ${e.message}`);
      this._onBridgeExit(proc, null, null);
    });
    proc.on('exit', (code, signal) => this._onBridgeExit(proc, code, signal));

    this._post({ type: 'bridge', state: 'ready' });
    for (const payload of this._pending.splice(0)) {
      this._sendToPython(payload);
    }
  }

  _onPythonLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._log.error(`Invalid JSON from Python: ${line}`);
      return;
    }
    // Raw response lines are for the Output channel only (debugRawResponses)
    if (message.type === 'raw') {
      this._log.info(`[raw ${String(message.requestId).slice(0, 8)}] ${message.line}`);
      return;
    }
    if (message.type === 'error') {
      this._log.warn(`Error: ${message.message}`);
    }
    this._post(message);
  }

  _onBridgeExit(proc, code, signal) {
    // 'error' and 'exit' can both fire for one process
    if (proc.exitHandled) return;
    proc.exitHandled = true;
    if (this._pyProcess === proc) this._pyProcess = undefined;

    if (proc.stoppedOnPurpose || this._disposed) {
      this._log.info('Python bridge stopped');
      return;
    }

    this._log.error(`Python bridge exited unexpectedly (code ${code}, signal ${signal})`);
    const now = Date.now();
    this._crashTimes = this._crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    const attempt = this._crashTimes.length;

    if (attempt > RESTART_DELAYS_MS.length) {
      this._post({ type: 'bridge', state: 'down' });
      vscode.window
        .showErrorMessage('AgentCore Chat: the Python backend keeps crashing.', 'Show Logs', 'Restart')
        .then((choice) => {
          if (choice === 'Show Logs') this._log.show();
          if (choice === 'Restart') this.restartBridge();
        });
      return;
    }

    const delay = RESTART_DELAYS_MS[attempt - 1];
    this._log.info(`Restarting Python bridge in ${delay / 1000}s (attempt ${attempt} of ${RESTART_DELAYS_MS.length})`);
    this._post({ type: 'bridge', state: 'restarting' });
    setTimeout(() => this._startPythonBridge(), delay);
  }

  _sendToPython(payload) {
    if (this._pyProcess && this._pyProcess.stdin.writable) {
      this._pyProcess.stdin.write(JSON.stringify({ ...payload, settings: this._settings() }) + '\n');
    } else {
      this._pending.push(payload);
    }
  }

  _getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', file));
    // Starting values for main.js; "<" is escaped so a value can't close the <script> tag
    const init = JSON.stringify({ sessionId: crypto.randomUUID(), settings: this._settings() }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('main.css')}">
</head>
<body>
  <div class="controls">
    <div class="row">
      <select id="profileSelect"><option value="">Loading profiles...</option></select>
      <span id="mockBadge" class="badge" title="Replies come from the built-in mock (setting agentcore.mock)" hidden>MOCK</span>
      <button id="refreshBtn" title="Refresh Agents">↻</button>
    </div>
    <div class="row">
      <select id="agentSelect"><option value="">Select profile first...</option></select>
      <div id="protocolToggle" class="segmented" role="group" aria-label="Agent protocol">
        <button data-protocol="HTTP" aria-pressed="true">HTTP</button>
        <button data-protocol="A2A" aria-pressed="false">A2A</button>
      </div>
      <button id="newChatBtn" title="New chat">+</button>
    </div>
    <div id="agentsNote" class="note" hidden></div>
    <div id="ssoBanner">
      <span>SSO token expired for this profile.</span>
      <button id="ssoLoginBtn">Run aws sso login</button>
    </div>
  </div>

  <div id="bridgeBanner" class="banner" hidden>
    <span id="bridgeText"></span>
    <button id="bridgeRestartBtn">Restart</button>
    <button id="bridgeLogsBtn" class="secondary">Show Logs</button>
  </div>
  <div id="switchNotice" class="notice" hidden>
    <span id="switchText"></span>
    <button id="switchYesBtn">Switch</button>
    <button id="switchNoBtn" class="secondary">Cancel</button>
  </div>

  <div id="chat"></div>

  <div class="input-box">
    <textarea id="promptInput" placeholder="Message selected agent... (Enter to send)"></textarea>
    <!-- One action spot: arrow to send, square to stop (main.js shows one at a time) -->
    <button id="sendBtn" class="icon-btn" title="Send (Enter)" aria-label="Send">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button id="stopBtn" class="icon-btn secondary" title="Stop" aria-label="Stop" disabled hidden>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
    </button>
  </div>

  <script nonce="${nonce}" id="init" type="application/json">${init}</script>
  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

function deactivate() {
  provider?.dispose();
}

module.exports = { activate, deactivate };
