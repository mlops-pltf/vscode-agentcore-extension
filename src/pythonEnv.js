const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Find the Python to run the bridge with, creating or updating a managed venv
// if needed. Order: agentcore.pythonPath setting, the repo's .venv (local
// development), then a venv in VS Code's global storage for end users.
async function resolvePython(context) {
  const config = vscode.workspace.getConfiguration('agentcore');
  const customPython = config.get('pythonPath');
  const isWin = process.platform === 'win32';
  const extensionDir = context.extensionUri.fsPath;

  // 1. Respect explicit user override if set
  if (customPython && customPython !== 'python3') {
    return customPython;
  }

  // 2. Check local .venv (for local development)
  const localVenv = path.join(extensionDir, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (fs.existsSync(localVenv)) {
    return localVenv;
  }

  // 3. Auto-bootstrap .venv in VS Code global storage for end users
  const storageDir = context.globalStorageUri.fsPath;
  const managedVenvDir = path.join(storageDir, 'venv');
  const managedPython = path.join(managedVenvDir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

  // Re-install when requirements.txt changes (hash stored inside the venv)
  const reqPath = path.join(extensionDir, 'python', 'requirements.txt');
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
              `AgentCore Chat setup failed (Python 3.10+ required): ${stderr || err.message}`
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

module.exports = { resolvePython };
