// Rendering of the conversation: welcome card, user prompts and agent replies.
// These functions only build and update DOM; state lives in main.js.
(function (app) {
  const { el, avatar } = app.dom;

  function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }

  function appendMessage(container, text, cls) {
    container.querySelector('.empty')?.remove();
    const div = el('div', 'msg ' + cls, text);
    container.appendChild(div);
    scrollToBottom(container);
    return div;
  }

  // Welcome card shown while the chat is empty. onPick(text) fills the composer.
  function renderWelcome(container, { agent, protocol, suggestions, onPick }) {
    const card = el('div', 'empty');
    card.appendChild(avatar(26));
    card.appendChild(el('h2', '', agent ? agent.name : 'AgentCore Chat'));
    if (agent) card.appendChild(el('div', 'protocol', `${protocol} agent`));
    card.appendChild(el('p', '', agent
      ? (agent.description || 'Ask a question to start the conversation.')
      : 'Choose an AWS profile and an agent below to start chatting.'));

    if (agent) {
      const chips = el('div', 'chips');
      for (const suggestion of suggestions) {
        const chip = el('button', 'chip', suggestion);
        chip.addEventListener('click', () => onPick(suggestion));
        chips.appendChild(chip);
      }
      card.appendChild(chips);
    }
    container.replaceChildren(card);
  }

  // Three bouncing dots until the first words arrive (main.css animates them)
  function typingDots() {
    const dots = el('span', 'typing');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Agent is replying');
    for (let i = 0; i < 3; i++) dots.appendChild(el('span'));
    return dots;
  }

  // An agent reply: header (avatar + name), optional status line, text, footer
  function createReply(container, agentName) {
    const bubble = appendMessage(container, '', 'agent');
    const head = el('div', 'agent-head');
    head.appendChild(avatar(14));
    head.appendChild(el('span', 'name', agentName));
    bubble.appendChild(head);

    const reply = { bubble, container, received: false };
    for (const name of ['status', 'text', 'footer']) {
      reply[name] = el('div', name);
      bubble.appendChild(reply[name]);
    }
    reply.status.hidden = true;
    reply.footer.hidden = true;
    reply.text.replaceChildren(typingDots());
    return reply;
  }

  function addChunk(reply, text) {
    if (!reply.received) reply.text.textContent = '';
    reply.received = true;
    reply.text.textContent += text;
    scrollToBottom(reply.container);
  }

  function setStatus(reply, text) {
    reply.status.textContent = text;
    reply.status.hidden = false;
    scrollToBottom(reply.container);
  }

  // End a reply: clear the dots, then add an error line and/or footer
  function finishReply(reply, { footer, error } = {}) {
    if (!reply.received) reply.text.textContent = '';
    if (error) reply.bubble.insertBefore(el('div', 'error-text', error), reply.footer);
    if (footer) {
      reply.footer.textContent = footer;
      reply.footer.hidden = false;
    }
    scrollToBottom(reply.container);
  }

  // e.g. "A2A · 1.8s · completed"
  function footerText(meta) {
    const parts = [meta.protocol];
    if (typeof meta.ms === 'number') parts.push((meta.ms / 1000).toFixed(1) + 's');
    const state = meta.state === 'cancelled' ? 'cancelled' : (meta.taskState || meta.state);
    if (state) parts.push(state.replace(/-/g, ' '));
    return parts.filter(Boolean).join(' · ');
  }

  app.chat = { appendMessage, renderWelcome, createReply, addChunk, setStatus, finishReply, footerText };
})(window.AgentCore);
