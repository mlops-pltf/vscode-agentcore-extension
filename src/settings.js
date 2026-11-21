const vscode = require('vscode');

// agentcore.a2aStreaming is "auto" | "on" | "off"; older versions stored true/false
function streamingMode(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return ['on', 'off'].includes(value) ? value : 'auto';
}

// The agentcore.* settings Python and the panel need. Read fresh every time,
// so nothing ever works with stale values.
function readSettings() {
  const config = vscode.workspace.getConfiguration('agentcore');
  return {
    mock: config.get('mock') === true,
    region: config.get('region') || '',
    a2aStreaming: streamingMode(config.get('a2aStreaming')),
    jsonReplies: ['full', 'text', 'raw'].includes(config.get('jsonReplies')) ? config.get('jsonReplies') : 'full',
    jsonHiddenFields: (config.get('jsonHiddenFields') || []).filter((name) => typeof name === 'string'),
    debugRaw: config.get('debugRawResponses') === true
  };
}

module.exports = { readSettings };
