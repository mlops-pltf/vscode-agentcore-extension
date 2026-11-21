const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

function activate(context) {
  const provider = new AgentCoreViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentcoreChatView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

class AgentCoreViewProvider {
  constructor(context) {
    this._context = context;
    this._extensionUri = context.extensionUri;
    this._view = undefined;
    this._pyProcess = undefined;
    // Messages sent before Python is running (e.g. during first-time venv setup)
    this._pending = [];
  }

  async resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
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
      if (msg.type === 'newSession') {
        this._view?.webview.postMessage({ type: 'sessionReset', sessionId: crypto.randomUUID() });
        return;
      }
      this._sendToPython(msg);
    });

    webviewView.onDidDispose(() => {
      this._pyProcess?.kill();
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
    let pythonPath;
    try {
      pythonPath = await this._ensurePythonEnv();
    } catch {
      return;
    }

    const scriptPath = path.join(this._extensionUri.fsPath, 'python', 'bridge.py');
    this._pyProcess = cp.spawn(pythonPath, [scriptPath]);

    if (this._pyProcess.stdout) {
      const rl = readline.createInterface({ input: this._pyProcess.stdout });
      rl.on('line', (line) => {
        try {
          const parsed = JSON.parse(line);
          this._view?.webview.postMessage(parsed);
        } catch (e) {
          console.error('Invalid JSON from Python:', line);
        }
      });
    }

    this._pyProcess.stderr?.on('data', (data) => {
      console.error(`Python stderr: ${data}`);
    });

    for (const payload of this._pending.splice(0)) {
      this._sendToPython(payload);
    }
  }

  _sendToPython(payload) {
    if (this._pyProcess && this._pyProcess.stdin) {
      this._pyProcess.stdin.write(JSON.stringify(payload) + '\n');
    } else {
      this._pending.push(payload);
    }
  }

  _getHtml(webview) {
    const initialSessionId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; display: flex; flex-direction: column; height: 95vh; margin: 0; }
  .controls { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .row { display: flex; gap: 6px; align-items: center; }
  select, button, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; border-radius: 3px; font-family: inherit; }
  select { flex: 1; }
  button { cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #ssoBanner { display: none; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 8px; border-radius: 4px; margin-top: 6px; font-size: 12px; }
  #chat { flex: 1; overflow-y: auto; padding: 10px 0; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.4; }
  .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 85%; }
  .agent { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 90%; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; }
  .input-box { display: flex; gap: 6px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; resize: none; height: 50px; }
</style>
</head>
<body>
  <div class="controls">
    <div class="row">
      <select id="profileSelect"><option value="">Loading profiles...</option></select>
      <button id="refreshBtn" title="Refresh Agents">↻</button>
    </div>
    <div class="row">
      <select id="agentSelect"><option value="">Select profile first...</option></select>
      <button id="newChatBtn" title="New Session">+</button>
    </div>
    <div id="ssoBanner">
      <span>SSO token expired for this profile.</span>
      <button id="ssoLoginBtn" style="margin-top:5px; width:100%;">Run aws sso login</button>
    </div>
  </div>

  <div id="chat"></div>

  <div class="input-box">
    <textarea id="promptInput" placeholder="Message selected agent... (Enter to send)"></textarea>
    <button id="sendBtn">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let sessionId = "${initialSessionId}";
    let currentAgentBubble = null;

    const profileSelect = document.getElementById('profileSelect');
    const agentSelect = document.getElementById('agentSelect');
    const ssoBanner = document.getElementById('ssoBanner');
    const chat = document.getElementById('chat');
    const promptInput = document.getElementById('promptInput');

    // Fill a <select> safely: text goes through textContent, never parsed as HTML
    function setOptions(select, items) {
      select.replaceChildren(...items.map(({ value, label, title }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (title) opt.title = title;
        return opt;
      }));
    }

    function setPlaceholder(select, label) {
      setOptions(select, [{ value: '', label }]);
    }

    vscode.postMessage({ action: 'list_profiles' });

    // refresh = true skips the agent-list cache in Python
    function loadAgents(refresh) {
      const profile = profileSelect.value;
      if (!profile) return;
      ssoBanner.style.display = 'none';
      setPlaceholder(agentSelect, 'Loading agents...');
      vscode.postMessage({ action: 'list_agents', profile, refresh: refresh === true });
    }

    profileSelect.addEventListener('change', () => loadAgents(false));
    document.getElementById('refreshBtn').addEventListener('click', () => loadAgents(true));
    document.getElementById('ssoLoginBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'ssoLogin', profile: profileSelect.value });
    });
    document.getElementById('newChatBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    function sendMessage() {
      const prompt = promptInput.value.trim();
      const agentArn = agentSelect.value;
      const profile = profileSelect.value;
      if (!prompt || !agentArn) return;

      appendMsg(prompt, 'user');
      promptInput.value = '';
      currentAgentBubble = appendMsg('...', 'agent');

      vscode.postMessage({
        action: 'invoke_agent',
        profile,
        agentArn,
        prompt,
        sessionId
      });
    }

    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    function appendMsg(text, cls) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'profiles') {
        setOptions(profileSelect, msg.data.map(p => ({ value: p, label: p })));
        loadAgents();
      } else if (msg.type === 'agents') {
        // Ignore a slow reply for a profile the user has already switched away from
        if (msg.profile && msg.profile !== profileSelect.value) return;
        if (!msg.data.length) {
          setPlaceholder(agentSelect, 'No agents found');
        } else {
          setOptions(agentSelect, msg.data.map(a => ({ value: a.arn, label: a.name, title: a.description })));
        }
      } else if (msg.type === 'sso_expired') {
        ssoBanner.style.display = 'block';
        setPlaceholder(agentSelect, 'SSO Login Required');
      } else if (msg.type === 'chunk') {
        if (currentAgentBubble) {
          if (currentAgentBubble.textContent === '...') currentAgentBubble.textContent = '';
          currentAgentBubble.textContent += msg.text;
          chat.scrollTop = chat.scrollHeight;
        }
      } else if (msg.type === 'done') {
        currentAgentBubble = null;
      } else if (msg.type === 'sessionReset') {
        sessionId = msg.sessionId;
        chat.replaceChildren();
      } else if (msg.type === 'error') {
        appendMsg('Error: ' + msg.message, 'error');
        currentAgentBubble = null;
      }
    });
  </script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
