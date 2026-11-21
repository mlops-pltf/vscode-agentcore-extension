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
    // Works wherever the user has put the view (they can drag it to the right side)
    vscode.commands.registerCommand('agentcore.openChat', () =>
      vscode.commands.executeCommand('agentcoreChatView.focus')
    ),
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
      // If VS Code re-creates the view (e.g. after the user moves it), the new one can
      // resolve before the old one is disposed; only stop Python for the current view
      if (this._view !== webviewView) return;
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
    const webviewDir = vscode.Uri.joinPath(this._extensionUri, 'media', 'webview');
    const asset = (file) => String(webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file)));
    const values = {
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      mainCss: asset('main.css'),
      mainJs: asset('main.js'),
      // Starting values for main.js; "<" is escaped so a value can't close the <script> tag
      init: JSON.stringify({ sessionId: crypto.randomUUID(), settings: this._settings() }).replace(/</g, '\\u003c')
    };
    const template = fs.readFileSync(path.join(webviewDir.fsPath, 'index.html'), 'utf8');
    // A replacer function, so "$" in a value is never treated as a replacement pattern
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in values ? values[name] : match));
  }
}

function deactivate() {
  provider?.dispose();
}

module.exports = { activate, deactivate };
