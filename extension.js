// AgentCore Chat: wires the pieces together and registers commands.
//   src/chatView.js     the chat panel (webview view)
//   src/pythonBridge.js runs and supervises python/bridge.py
//   src/pythonEnv.js    finds or creates the Python environment
//   src/settings.js     reads the agentcore.* settings
const vscode = require('vscode');
const { ChatViewProvider } = require('./src/chatView');
const { PythonBridge } = require('./src/pythonBridge');
const { resolvePython } = require('./src/pythonEnv');
const { readSettings } = require('./src/settings');

let bridge;

function activate(context) {
  const log = vscode.window.createOutputChannel('AgentCore Chat', { log: true });
  let view;
  bridge = new PythonBridge({
    extensionDir: context.extensionUri.fsPath,
    findPython: () => resolvePython(context),
    getSettings: readSettings,
    log,
    onMessage: (message) => view.post(message),
    onState: (state) => view.post({ type: 'bridge', state })
  });
  view = new ChatViewProvider({ extensionUri: context.extensionUri, bridge, getSettings: readSettings });

  context.subscriptions.push(
    log,
    bridge,
    vscode.window.registerWebviewViewProvider('agentcoreChatView', view, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    // Works wherever the user has put the view (they can drag it to the left side)
    vscode.commands.registerCommand('agentcore.openChat', () =>
      vscode.commands.executeCommand('agentcoreChatView.focus')
    ),
    vscode.commands.registerCommand('agentcore.showLogs', () => log.show()),
    vscode.commands.registerCommand('agentcore.restartBackend', () => bridge.restart()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('agentcore')) return;
      log.info('Settings changed: ' + JSON.stringify(readSettings()));
      if (event.affectsConfiguration('agentcore.pythonPath')) {
        bridge.restart();
      }
      // The panel reloads the agent list if mock mode or region changed
      view.post({ type: 'settings', data: readSettings() });
    })
  );
}

function deactivate() {
  bridge?.dispose();
}

module.exports = { activate, deactivate };
