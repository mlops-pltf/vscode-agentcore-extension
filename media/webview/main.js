// AgentCore Chat panel: state, wiring and message handling. Talks to
// extension.js with postMessage; extension.js forwards to the Python bridge and
// posts its events back. Rendering lives in chat.js, helpers in dom.js.
(function (app) {
  const vscode = acquireVsCodeApi();
  const { $, newId, setOptions, setPlaceholder } = app.dom;
  const chatView = app.chat;

  // Copy, open link, insert code...: handled by the extension (src/editorActions.js)
  chatView.configure({
    onEditor: (op, fields) => vscode.postMessage({ type: 'editor', op, ...fields })
  });

  // Starting values written into the page by extension.js (see chatView.js _getHtml)
  const init = JSON.parse($('init').textContent);
  let sessionId = init.sessionId;
  let currentSettings = init.settings;

  // Protocols the user picked with the toggle, per agent ARN; kept across reloads
  const savedState = vscode.getState() || {};
  const protocolOverrides = savedState.protocolOverrides || {};

  // Shown on the welcome card when the agent has no Agent Card with examples
  const SUGGESTIONS = [
    'What can you help me with?',
    'Show me an example of a task you can do',
    'What do you need from me to get started?'
  ];

  let agents = new Map();      // arn -> agent from the last agents event
  const agentCards = new Map(); // arn -> {card, note} from agent_card events; null while asked
  let currentAgentArn = '';
  let protocol = 'HTTP';
  let turns = 0;               // prompts sent in the current session
  let lastPrompt = '';         // for ↑ in an empty composer
  const requests = new Map();  // requestId -> reply being written (see chat.createReply)
  let mentionBox;              // the @agent support (mentions.js), set up below

  const profileSelect = $('profileSelect');
  const agentSelect = $('agentSelect');
  const ssoBanner = $('ssoBanner');
  const chat = $('chat');
  const promptInput = $('promptInput');
  const sendBtn = $('sendBtn');
  const stopBtn = $('stopBtn');
  const protocolToggle = $('protocolToggle');

  const currentAgent = () => agents.get(currentAgentArn);

  // The textarea grows with its content up to the CSS max-height, then scrolls;
  // the @mention highlight follows the text
  function autoGrow() {
    promptInput.style.height = 'auto';
    promptInput.style.height = promptInput.scrollHeight + 'px';
    mentionBox?.refresh();
  }

  // The current agent's Agent Card summary (A2A only), if Python found one
  function currentCard() {
    const entry = protocol === 'A2A' ? agentCards.get(currentAgentArn) : null;
    return entry ? entry.card : null;
  }

  // A2A agents publish an Agent Card; ask Python for it once per agent
  function requestCard() {
    if (protocol !== 'A2A' || !currentAgentArn || agentCards.has(currentAgentArn)) return;
    agentCards.set(currentAgentArn, null);
    vscode.postMessage({ action: 'get_agent_card', profile: profileSelect.value, agentArn: currentAgentArn });
  }

  function showWelcome() {
    const agentCard = currentCard();
    // The agent's own example prompts, up to four, instead of the generic ones
    const examples = agentCard ? agentCard.skills.flatMap((s) => s.examples).slice(0, 4) : [];
    chatView.renderWelcome(chat, {
      agent: currentAgent(),
      agentCard,
      protocol,
      suggestions: examples.length ? examples : SUGGESTIONS,
      // Fill the composer rather than sending, so the user can edit first
      onPick: (text) => {
        promptInput.value = text;
        autoGrow();
        promptInput.focus();
      }
    });
  }

  // ---------- profiles and agents ----------

  // Who the profile signs in as, shown as the profile picker's tooltip
  function loadIdentity() {
    const profile = profileSelect.value;
    if (!profile) return;
    profileSelect.title = 'AWS profile';
    vscode.postMessage({ action: 'whoami', profile });
  }

  // refresh = true skips the agent-list cache in Python
  function loadAgents(refresh) {
    const profile = profileSelect.value;
    if (!profile) return;
    agentCards.clear();
    ssoBanner.style.display = 'none';
    setPlaceholder(agentSelect, 'Loading agents...');
    vscode.postMessage({ action: 'list_agents', profile, refresh: refresh === true });
  }

  function renderAgents(msg) {
    agents = new Map(msg.data.map((a) => [a.arn, a]));
    if (!msg.data.length) {
      setPlaceholder(agentSelect, 'No agents found');
    } else {
      setOptions(agentSelect, msg.data.map((a) => ({ value: a.arn, label: a.name, title: a.description, data: { protocol: a.protocol } })));
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
    const agent = currentAgent();
    protocol = protocolOverrides[arn] || (agent && agent.protocol) || 'HTTP';
    renderProtocol();
    requestCard();
    promptInput.placeholder = agent ? `Ask ${agent.name}...` : 'Select an agent to start...';
    if (turns === 0) showWelcome();
  }

  // ---------- protocol toggle ----------

  function renderProtocol() {
    const agent = currentAgent();
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
    const agent = currentAgent();
    if (agent && agent.protocol === next) {
      delete protocolOverrides[currentAgentArn];
    } else {
      protocolOverrides[currentAgentArn] = next;
    }
    vscode.setState({ ...savedState, protocolOverrides });
    renderProtocol();
    requestCard();
    if (turns === 0) showWelcome();
  }

  // ---------- sessions and sending ----------

  function startNewSession() {
    stopAll();
    vscode.postMessage({ action: 'reset_session', sessionId });
    sessionId = newId();
    turns = 0;
    $('switchNotice').hidden = true;
    showWelcome();
  }

  function updateBusy() {
    const busy = requests.size > 0;
    sendBtn.disabled = busy;
    sendBtn.hidden = busy;
    stopBtn.disabled = !busy;
    stopBtn.hidden = !busy;
  }

  // The protocol to use with an agent: the one chosen with the toggle, else the detected one
  function protocolFor(arn) {
    if (arn === currentAgentArn) return protocol;
    const agent = agents.get(arn);
    return protocolOverrides[arn] || (agent && agent.protocol) || 'HTTP';
  }

  function showMentionNote(text) {
    $('mentionNote').textContent = text;
    $('mentionNote').hidden = false;
  }

  function sendMessage() {
    const text = promptInput.value.trim();
    if (requests.size > 0 || !text) return;
    // "@agent ..." goes to that agent only; the picker keeps its agent (Phase 12)
    const mention = mentionBox.resolve(text);
    let agentArn = agentSelect.value;
    let prompt = text;
    if (mention) {
      if (!mention.option) return showMentionNote(`No agent called @${mention.name}. Type @ to pick one.`);
      if (!mention.rest) return showMentionNote(`Add your question after @${mention.option.textContent}.`);
      agentArn = mention.option.value;
      prompt = mention.rest;
    }
    if (!agentArn) return;

    chatView.appendMessage(chat, text, 'user', mention ? mention.length : 0);
    lastPrompt = text;
    promptInput.value = '';
    autoGrow();
    const agent = agents.get(agentArn);
    invoke({ prompt, agentArn, protocol: protocolFor(agentArn), agentName: agent ? agent.name : 'Agent' });
  }

  // Ask the agent; `replace` is a failed reply to put the new one in place of (Retry)
  function invoke(request, replace) {
    // Only the latest failed reply can be retried
    for (const button of chat.querySelectorAll('.retry')) button.remove();
    const requestId = newId();
    const reply = chatView.createReply(chat, request.agentName);
    if (replace) replace.bubble.replaceWith(reply.bubble);
    reply.request = request;
    requests.set(requestId, reply);
    turns += 1;
    updateBusy();

    vscode.postMessage({
      action: 'invoke_agent',
      requestId,
      profile: profileSelect.value,
      agentArn: request.agentArn,
      protocol: request.protocol,
      prompt: request.prompt,
      sessionId
    });
  }

  // Failed replies only: re-running a successful one could repeat its side effects
  function retry(reply) {
    if (requests.size > 0) return;
    invoke(reply.request, reply);
  }

  function stopAll() {
    for (const requestId of requests.keys()) {
      vscode.postMessage({ action: 'cancel', requestId });
    }
  }

  // Stop tracking a reply and render how it ended; failed replies offer Retry
  function finish(requestId, outcome) {
    const reply = requests.get(requestId);
    if (!reply) return undefined;
    requests.delete(requestId);
    chatView.finishReply(reply, { ...outcome, onRetry: () => retry(reply) });
    updateBusy();
    return reply;
  }

  // The backend died: replies in progress will never finish
  function failAll(reason) {
    for (const requestId of [...requests.keys()]) {
      finish(requestId, { error: reason });
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

  // ---------- messages from the extension (one handler per type) ----------

  const handlers = {
    profiles(msg) {
      setOptions(profileSelect, msg.data.map((p) => ({ value: p, label: p })));
      loadIdentity();
      loadAgents();
    },
    identity(msg) {
      if (msg.profile !== profileSelect.value) return;
      profileSelect.title = msg.error
        ? `AWS profile ${msg.profile}: ${msg.error}`
        : `${msg.user}\nAccount ${msg.account} · ${msg.region}`;
    },
    agents(msg) {
      // Ignore a slow reply for a profile the user has already switched away from
      if (msg.profile && msg.profile !== profileSelect.value) return;
      renderAgents(msg);
    },
    agent_card(msg) {
      if (msg.profile !== profileSelect.value) return;
      agentCards.set(msg.agentArn, { card: msg.card, note: msg.note });
      if (msg.agentArn === currentAgentArn && turns === 0) showWelcome();
    },
    sso_expired(msg) {
      if (msg.requestId) finish(msg.requestId, { error: 'SSO session expired.' });
      ssoBanner.style.display = 'block';
      setPlaceholder(agentSelect, 'SSO Login Required');
    },
    chunk(msg) {
      const reply = requests.get(msg.requestId);
      if (reply) chatView.addChunk(reply, msg.text);
    },
    tool(msg) {
      const reply = requests.get(msg.requestId);
      if (reply) chatView.addTool(reply, msg);
    },
    status(msg) {
      const reply = requests.get(msg.requestId);
      if (reply) chatView.setStatus(reply, msg.text);
    },
    done(msg) {
      const meta = msg.meta || {};
      const reply = finish(msg.requestId, { footer: chatView.footerText(meta), trace: meta, rawJson: meta.rawJson });
      if (!reply) return;
      const waiting = meta.taskState === 'input-required' || meta.taskState === 'auth-required';
      // Keep "Agent is waiting for your input"; drop progress lines like "Thinking..."
      if (!waiting) reply.status.hidden = true;
      if (!reply.received && !reply.segments.length) reply.text.textContent = meta.state === 'cancelled' ? '(cancelled)' : '(empty reply)';
    },
    error(msg) {
      if (requests.has(msg.requestId)) {
        finish(msg.requestId, { error: 'Error: ' + msg.message, trace: msg });
      } else {
        chatView.appendMessage(chat, 'Error: ' + msg.message, 'error');
      }
    },
    bridge(msg) {
      showBridge(msg.state);
    },
    settings(msg) {
      // Mock mode or region decides which agents exist, so reload the list
      const changed = msg.data.mock !== currentSettings.mock || msg.data.region !== currentSettings.region;
      currentSettings = msg.data;
      showSettings();
      if (changed) {
        loadIdentity();
        loadAgents(true);
      }
    }
  };

  window.addEventListener('message', (event) => {
    const handler = handlers[event.data.type];
    if (handler) handler(event.data);
  });

  // ---------- wiring ----------

  profileSelect.addEventListener('change', () => {
    loadIdentity();
    loadAgents(false);
  });
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
  stopBtn.addEventListener('click', stopAll);
  promptInput.addEventListener('input', () => {
    autoGrow();
    $('mentionNote').hidden = true;
  });
  promptInput.addEventListener('keydown', (e) => {
    if (mentionBox.handleKey(e)) return;  // the @ list is open
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'ArrowUp' && !promptInput.value && lastPrompt) {
      // Recall the last prompt to edit or resend it
      e.preventDefault();
      promptInput.value = lastPrompt;
      autoGrow();
      promptInput.setSelectionRange(lastPrompt.length, lastPrompt.length);
    }
  });
  // Esc anywhere in the panel stops the reply in progress
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && requests.size > 0) {
      e.preventDefault();
      stopAll();
    }
  });
  chatView.initScroll(chat, $('jumpBtn'));
  mentionBox = app.mentions.create({
    input: promptInput,
    mirror: $('promptMirror'),
    popup: $('mentionPopup'),
    list: $('mentionList'),
    select: agentSelect,
    onChange: autoGrow
  });
  app.picker.create({
    select: agentSelect,
    button: $('agentBtn'),
    label: $('agentName'),
    popup: $('agentPicker'),
    input: $('agentSearch'),
    list: $('agentList'),
    onRefresh: () => loadAgents(true)
  });

  showSettings();
  updateBusy();
  showWelcome();
  vscode.postMessage({ action: 'list_profiles' });
})(window.AgentCore);
