// AgentCore Chat panel script. Talks to extension.js with postMessage;
// extension.js forwards to the Python bridge and posts its events back.
const vscode = acquireVsCodeApi();

// Starting values written into the page by extension.js (see _getHtml)
const init = JSON.parse(document.getElementById('init').textContent);
let sessionId = init.sessionId;
let currentSettings = init.settings;
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
  } else if (msg.type === 'settings') {
    // Mock mode or region decides which agents exist, so reload the list
    const changed = msg.data.mock !== currentSettings.mock || msg.data.region !== currentSettings.region;
    currentSettings = msg.data;
    if (changed) loadAgents(true);
  } else if (msg.type === 'sessionReset') {
    sessionId = msg.sessionId;
    chat.replaceChildren();
  } else if (msg.type === 'error') {
    appendMsg('Error: ' + msg.message, 'error');
    currentAgentBubble = null;
  }
});
