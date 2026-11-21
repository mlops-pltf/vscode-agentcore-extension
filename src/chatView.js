const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runEditorAction } = require('./editorActions');

// The chat panel (a webview view). Shows media/webview, passes the panel's
// actions to the Python bridge, and handles the few requests meant for VS Code.
class ChatViewProvider {
  /**
   * @param {object} options
   * @param {vscode.Uri} options.extensionUri
   * @param {import('./pythonBridge').PythonBridge} options.bridge
   * @param {() => object} options.getSettings
   * @param {object} options.log   the Output channel
   */
  constructor({ extensionUri, bridge, getSettings, log }) {
    this._extensionUri = extensionUri;
    this.bridge = bridge;
    this._getSettings = getSettings;
    this._log = log;
    this._view = undefined;
  }

  post(message) {
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
    webviewView.webview.onDidReceiveMessage((msg) => this._onWebviewMessage(msg));

    webviewView.onDidDispose(() => {
      // If VS Code re-creates the view (e.g. after the user moves it), the new one can
      // resolve before the old one is disposed; only stop Python for the current view
      if (this._view !== webviewView) return;
      this._view = undefined;
      this.bridge.stop();
    });

    await this.bridge.start();
  }

  // Messages with an "action" go to Python; messages with a "type" are for VS Code
  _onWebviewMessage(msg) {
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
    if (msg.type === 'editor') {
      runEditorAction(msg, this._log).catch((e) => this._log.error(`Editor action ${msg.op} failed: ${e.message}`));
      return;
    }
    this.bridge.send(msg);
  }

  _getHtml(webview) {
    const webviewDir = vscode.Uri.joinPath(this._extensionUri, 'media', 'webview');
    const asset = (file) => String(webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file)));
    const values = {
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      mainCss: asset('main.css'),
      domJs: asset('dom.js'),
      markdownJs: asset('markdown.js'),
      chatJs: asset('chat.js'),
      pickerJs: asset('picker.js'),
      mainJs: asset('main.js'),
      // Starting values for main.js; "<" is escaped so a value can't close the <script> tag
      init: JSON.stringify({ sessionId: crypto.randomUUID(), settings: this._getSettings() }).replace(/</g, '\\u003c')
    };
    const template = fs.readFileSync(path.join(webviewDir.fsPath, 'index.html'), 'utf8');
    // A replacer function, so "$" in a value is never treated as a replacement pattern
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in values ? values[name] : match));
  }
}

module.exports = { ChatViewProvider };
