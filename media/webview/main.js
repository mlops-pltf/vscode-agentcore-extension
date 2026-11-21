// AgentCore Chat panel script. Talks to extension.js with postMessage;
// extension.js forwards to the Python bridge and posts its events back.
const vscode = acquireVsCodeApi();

// Starting values written into the page by extension.js (see _getHtml)
const init = JSON.parse(document.getElementById('init').textContent);
let sessionId = init.sessionId;
let currentSettings = init.settings;

// Protocols the user picked with the toggle, per agent ARN; kept across reloads
const savedState = vscode.getState() || {};
const protocolOverrides = savedState.protocolOverrides || {};

// Shown on the welcome card; round 6e replaces them with the agent's own skills
const SUGGESTIONS = [
  'What can you help me with?',
  'Show me an example of a task you can do',
  'What do you need from me to get started?'
];

let agents = new Map();      // arn -> agent from the last agents event
let currentAgentArn = '';
let protocol = 'HTTP';
let turns = 0;               // prompts sent in the current session
const requests = new Map();  // requestId -> agent bubble parts, while a reply is in progress

const $ = (id) => document.getElementById(id);
const profileSelect = $('profileSelect');
const agentSelect = $('agentSelect');
const ssoBanner = $('ssoBanner');
const chat = $('chat');
const promptInput = $('promptInput');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const protocolToggle = $('protocolToggle');

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// The extension's robot icon, built as SVG nodes (no innerHTML)
function robotIcon(size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const parts = [
    ['rect', { x: '4.5', y: '7.5', width: '15', height: '10', rx: '3' }],
    ['path', { d: 'M12 4.5v3' }],
    ['path', { d: 'M9.5 12.5h.01M14.5 12.5h.01', 'stroke-width': '2.6' }]
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function avatar(size) {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.appendChild(robotIcon(size));
  return span;
}

// The textarea grows with its content up to the CSS max-height, then scrolls
function autoGrow() {
  promptInput.style.height = 'auto';
  promptInput.style.height = promptInput.scrollHeight + 'px';
}

function currentAgent() {
  return agents.get(currentAgentArn);
}

// ---------- profiles and agents ----------

// refresh = true skips the agent-list cache in Python
function loadAgents(refresh) {
  const profile = profileSelect.value;
  if (!profile) return;
  ssoBanner.style.display = 'none';
  setPlaceholder(agentSelect, 'Loading agents...');
  vscode.postMessage({ action: 'list_agents', profile, refresh: refresh === true });
}

function renderAgents(msg) {
  agents = new Map(msg.data.map((a) => [a.arn, a]));
  if (!msg.data.length) {
    setPlaceholder(agentSelect, 'No agents found');
  } else {
    setOptions(agentSelect, msg.data.map((a) => ({ value: a.arn, label: a.name, title: a.description })));
    // Keep the selected agent across a refresh
    if (agents.has(currentAgentArn)) agentSelect.value = currentAgentArn;
  }
  $('agentsNote').textContent = msg.note || '';
  $('agentsNote').hidden = !msg.note;
  onAgentChanged();
}

function onAgentChanged() {
  const arn = agentSelect.value;
  if (arn !== currentAgentArn && turns > 0) {
    // A2A context belongs to one agent, so a different agent gets a new chat
    startNewSession();
  }
  currentAgentArn = arn;
  const agent = agents.get(arn);
  protocol = protocolOverrides[arn] || (agent && agent.protocol) || 'HTTP';
  renderProtocol();
  promptInput.placeholder = agent ? `Ask ${agent.name}...` : 'Select an agent to start...';
  if (turns === 0) renderEmptyState();
}

// ---------- protocol toggle ----------

function renderProtocol() {
  const agent = agents.get(currentAgentArn);
  const detected = agent ? agent.protocol : null;
  for (const button of protocolToggle.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.protocol === protocol));
  }
  // The dot on the active button means "detected from the agent"
  protocolToggle.classList.toggle('auto', detected === protocol);
  protocolToggle.title = !agent ? 'Agent protocol'
    : !detected ? 'Protocol unknown for this agent: choose HTTP or A2A'
    : detected === protocol ? `Detected from the agent (${detected})`
    : `Chosen manually (agent reports ${detected})`;
}

function requestProtocol(next) {
  if (next === protocol || !currentAgentArn) return;
  if (turns > 0) {
    $('switchText').textContent = `Switching to ${next} starts a new chat.`;
    $('switchNotice').hidden = false;
    $('switchYesBtn').onclick = () => {
      $('switchNotice').hidden = true;
      applyProtocol(next);
      startNewSession();
    };
    return;
  }
  applyProtocol(next);
}

function applyProtocol(next) {
  protocol = next;
  const agent = agents.get(currentAgentArn);
  if (agent && agent.protocol === next) {
    delete protocolOverrides[currentAgentArn];
  } else {
    protocolOverrides[currentAgentArn] = next;
  }
  vscode.setState({ ...savedState, protocolOverrides });
  renderProtocol();
  if (turns === 0) renderEmptyState();
}

// ---------- sessions and sending ----------

function startNewSession() {
  stopAll();
  vscode.postMessage({ action: 'reset_session', sessionId });
  sessionId = newId();
  turns = 0;
  chat.replaceChildren();
  $('switchNotice').hidden = true;
  renderEmptyState();
}

// Welcome card shown while the chat is empty
function renderEmptyState() {
  const agent = currentAgent();
  const card = document.createElement('div');
  card.className = 'empty';
  card.appendChild(avatar(26));

  const title = document.createElement('h2');
  title.textContent = agent ? agent.name : 'AgentCore Chat';
  card.appendChild(title);

  if (agent) {
    const proto = document.createElement('div');
    proto.className = 'protocol';
    proto.textContent = `${protocol} agent`;
    card.appendChild(proto);
  }

  const text = document.createElement('p');
  text.textContent = agent
    ? (agent.description || 'Ask a question to start the conversation.')
    : 'Choose an AWS profile and an agent below to start chatting.';
  card.appendChild(text);

  if (agent) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const suggestion of SUGGESTIONS) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = suggestion;
      // Fill the composer rather than sending, so the user can edit first
      chip.addEventListener('click', () => {
        promptInput.value = suggestion;
        autoGrow();
        promptInput.focus();
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
  }
  chat.replaceChildren(card);
}

function updateBusy() {
  const busy = requests.size > 0;
  sendBtn.disabled = busy;
  sendBtn.hidden = busy;
  stopBtn.disabled = !busy;
  stopBtn.hidden = !busy;
}

function sendMessage() {
  const prompt = promptInput.value.trim();
  const agentArn = agentSelect.value;
  if (requests.size > 0 || !prompt || !agentArn) return;

  appendMsg(prompt, 'user');
  promptInput.value = '';
  autoGrow();
  const requestId = newId();
  requests.set(requestId, createAgentBubble());
  turns += 1;
  updateBusy();

  vscode.postMessage({
    action: 'invoke_agent',
    requestId,
    profile: profileSelect.value,
    agentArn,
    protocol,
    prompt,
    sessionId
  });
}

function stopAll() {
  for (const requestId of requests.keys()) {
    vscode.postMessage({ action: 'cancel', requestId });
  }
}

function appendMsg(text, cls) {
  chat.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  chat.appendChild(div);
  scrollToBottom();
  return div;
}

// An agent reply: optional status line, the text, and a footer when done
function createAgentBubble() {
  const bubble = appendMsg('', 'agent');
  const head = document.createElement('div');
  head.className = 'agent-head';
  head.appendChild(avatar(14));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = currentAgent() ? currentAgent().name : 'Agent';
  head.appendChild(name);
  bubble.appendChild(head);
  const parts = { bubble, received: false };
  for (const name of ['status', 'text', 'footer']) {
    parts[name] = document.createElement('div');
    parts[name].className = name;
    bubble.appendChild(parts[name]);
  }
  parts.status.hidden = true;
  parts.footer.hidden = true;
  parts.text.replaceChildren(typingDots());
  return parts;
}

// Three bouncing dots until the first words arrive (main.css animates them)
function typingDots() {
  const dots = document.createElement('span');
  dots.className = 'typing';
  dots.setAttribute('role', 'status');
  dots.setAttribute('aria-label', 'Agent is replying');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
  return dots;
}

function onChunk(r, text) {
  if (!r.received) r.text.textContent = '';
  r.received = true;
  r.text.textContent += text;
  scrollToBottom();
}

function onStatus(r, text) {
  r.status.textContent = text;
  r.status.hidden = false;
  scrollToBottom();
}

function finish(requestId, footer, errorText) {
  const r = requests.get(requestId);
  if (!r) return;
  requests.delete(requestId);
  if (!r.received) r.text.textContent = '';
  if (errorText) {
    const error = document.createElement('div');
    error.className = 'error-text';
    error.textContent = errorText;
    r.bubble.insertBefore(error, r.footer);
  }
  if (footer) {
    r.footer.textContent = footer;
    r.footer.hidden = false;
  }
  updateBusy();
  scrollToBottom();
  return r;
}

// e.g. "A2A · 1.8s · completed"
function footerText(meta) {
  const parts = [meta.protocol];
  if (typeof meta.ms === 'number') parts.push((meta.ms / 1000).toFixed(1) + 's');
  const state = meta.state === 'cancelled' ? 'cancelled' : (meta.taskState || meta.state);
  if (state) parts.push(state.replace(/-/g, ' '));
  return parts.filter(Boolean).join(' · ');
}

function onDone(msg) {
  const meta = msg.meta || {};
  const r = finish(msg.requestId, footerText(meta));
  if (!r) return;
  const waiting = meta.taskState === 'input-required' || meta.taskState === 'auth-required';
  // Keep "Agent is waiting for your input"; drop progress lines like "Thinking..."
  if (!waiting) r.status.hidden = true;
  if (!r.received) r.text.textContent = meta.state === 'cancelled' ? '(cancelled)' : '(empty reply)';
}

// The backend died: replies in progress will never finish
function failAll(reason) {
  for (const requestId of [...requests.keys()]) {
    finish(requestId, null, reason);
  }
}

function showBridge(state) {
  const banner = $('bridgeBanner');
  banner.hidden = state === 'ready';
  banner.classList.toggle('down', state === 'down');
  $('bridgeText').textContent = state === 'down' ? 'Backend stopped.' : 'Reconnecting to backend...';
  $('bridgeRestartBtn').hidden = state !== 'down';
  if (state !== 'ready') failAll('Backend stopped before the reply finished.');
}

function showSettings() {
  $('mockBadge').hidden = !currentSettings.mock;
}

// ---------- wiring ----------

profileSelect.addEventListener('change', () => loadAgents(false));
agentSelect.addEventListener('change', onAgentChanged);
$('refreshBtn').addEventListener('click', () => loadAgents(true));
$('ssoLoginBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'ssoLogin', profile: profileSelect.value });
});
$('newChatBtn').addEventListener('click', startNewSession);
for (const button of protocolToggle.querySelectorAll('button')) {
  button.addEventListener('click', () => requestProtocol(button.dataset.protocol));
}
$('switchNoBtn').addEventListener('click', () => { $('switchNotice').hidden = true; });
$('bridgeRestartBtn').addEventListener('click', () => vscode.postMessage({ type: 'restartBackend' }));
$('bridgeLogsBtn').addEventListener('click', () => vscode.postMessage({ type: 'showLogs' }));
sendBtn.addEventListener('click', sendMessage);
promptInput.addEventListener('input', autoGrow);
stopBtn.addEventListener('click', stopAll);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  const r = msg.requestId ? requests.get(msg.requestId) : undefined;

  if (msg.type === 'profiles') {
    setOptions(profileSelect, msg.data.map((p) => ({ value: p, label: p })));
    loadAgents();
  } else if (msg.type === 'agents') {
    // Ignore a slow reply for a profile the user has already switched away from
    if (msg.profile && msg.profile !== profileSelect.value) return;
    renderAgents(msg);
  } else if (msg.type === 'sso_expired') {
    if (msg.requestId) finish(msg.requestId, null, 'SSO session expired.');
    ssoBanner.style.display = 'block';
    setPlaceholder(agentSelect, 'SSO Login Required');
  } else if (msg.type === 'chunk') {
    if (r) onChunk(r, msg.text);
  } else if (msg.type === 'status') {
    if (r) onStatus(r, msg.text);
  } else if (msg.type === 'done') {
    onDone(msg);
  } else if (msg.type === 'error') {
    if (r) {
      finish(msg.requestId, null, 'Error: ' + msg.message);
    } else {
      appendMsg('Error: ' + msg.message, 'error');
    }
  } else if (msg.type === 'bridge') {
    showBridge(msg.state);
  } else if (msg.type === 'settings') {
    // Mock mode or region decides which agents exist, so reload the list
    const changed = msg.data.mock !== currentSettings.mock || msg.data.region !== currentSettings.region;
    currentSettings = msg.data;
    showSettings();
    if (changed) loadAgents(true);
  }
});

showSettings();
updateBusy();
renderEmptyState();
vscode.postMessage({ action: 'list_profiles' });
