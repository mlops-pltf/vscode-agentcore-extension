const vscode = require('vscode');

// Editor actions requested by the panel: one {type: "editor", op, ...} message.
// The panel is untrusted (it shows agent output), so everything is checked here.

const MAX_TEXT = 1000000;

// Code-fence names -> VS Code language ids (others are used as-is if VS Code knows them)
const LANGUAGE_IDS = {
  js: 'javascript', jsx: 'javascriptreact', ts: 'typescript', tsx: 'typescriptreact',
  py: 'python', rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript',
  ps1: 'powershell', pwsh: 'powershell', yml: 'yaml', md: 'markdown', tf: 'terraform', hcl: 'terraform',
  text: 'plaintext', txt: 'plaintext'
};

/**
 * @param {{op: string, text?: string, url?: string, language?: string}} msg
 * @param {object} log   the Output channel
 */
async function runEditorAction(msg, log) {
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (text.length > MAX_TEXT) {
    log.warn(`Editor action ${msg.op} ignored: text is longer than ${MAX_TEXT} characters`);
    return;
  }
  switch (msg.op) {
    case 'copy':
      await vscode.env.clipboard.writeText(text);
      return;
    case 'openLink':
      await openLink(msg.url, log);
      return;
    case 'insertAtCursor':
      await insertAtCursor(text);
      return;
    case 'newFile':
      await openInNewFile(text, msg.language);
      return;
    case 'insertInTerminal':
      await insertInTerminal(text);
      return;
    default:
      log.warn(`Unknown editor action from the panel: ${msg.op}`);
  }
}

// Web links only; VS Code asks the user before opening an external site
async function openLink(url, log) {
  let uri;
  try {
    uri = vscode.Uri.parse(String(url), true);
  } catch {
    uri = undefined;
  }
  if (!uri || (uri.scheme !== 'http' && uri.scheme !== 'https')) {
    log.warn(`Blocked a link that is not http(s): ${url}`);
    return;
  }
  await vscode.env.openExternal(uri);
}

// Replaces the selection(s) of the last active editor (focus is in the chat panel)
async function insertAtCursor(text) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('AgentCore Chat: open a file first, then insert the code at its cursor.');
    return;
  }
  await editor.edit((edit) => {
    for (const selection of editor.selections) edit.replace(selection, text);
  });
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

async function openInNewFile(text, language) {
  const name = String(language || '').toLowerCase().slice(0, 40);
  const id = LANGUAGE_IDS[name] || name;
  const known = await vscode.languages.getLanguages();
  const document = await vscode.workspace.openTextDocument({ content: text, language: known.includes(id) ? id : 'plaintext' });
  await vscode.window.showTextDocument(document);
}

// Puts the command on the terminal's prompt without running it
async function insertInTerminal(text) {
  const command = text.replace(/\s+$/, '');
  const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('AgentCore');
  terminal.show();
  if (!command.includes('\n')) {
    terminal.sendText(command, false);
    return;
  }
  // sendText would press Enter at every newline. A paste lets shells with
  // bracketed paste (zsh, bash 5.1+, PowerShell) take all lines without running them.
  // The user's clipboard is put back afterwards.
  let previous;
  try {
    previous = await vscode.env.clipboard.readText();
  } catch {
    previous = undefined;
  }
  await vscode.env.clipboard.writeText(command);
  await vscode.commands.executeCommand('workbench.action.terminal.paste');
  if (previous !== undefined) await vscode.env.clipboard.writeText(previous);
}

module.exports = { runEditorAction };
