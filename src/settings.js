const vscode = require('vscode');

// The agentcore.* settings Python and the panel need. Read fresh every time,
// so nothing ever works with stale values.
function readSettings() {
  const config = vscode.workspace.getConfiguration('agentcore');
  return {
    mock: config.get('mock') === true,
    region: config.get('region') || '',
    a2aStreaming: config.get('a2aStreaming') === true,
    debugRaw: config.get('debugRawResponses') === true
  };
}

module.exports = { readSettings };
