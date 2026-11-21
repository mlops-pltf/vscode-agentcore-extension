// Rendering of the conversation: welcome card, user prompts and agent replies.
// These functions only build and update DOM; state lives in main.js.
(function (app) {
  const { el, avatar, icon, iconButton } = app.dom;
  const markdown = app.markdown;

  // Set by main.js: onEditor(op, fields) asks the extension to copy, open a link,
  // insert code, ... (one {type: "editor", op} message, see chatView.js)
  const options = { onEditor: () => {} };
  function configure(values) {
    Object.assign(options, values);
  }

  // Code blocks in these languages get "Insert into Terminal"
  const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console']);

  // Re-render streaming text at most once per frame (a timer where frames don't exist)
  const nextFrame = window.requestAnimationFrame
    ? (fn) => window.requestAnimationFrame(fn)
    : (fn) => setTimeout(fn, 16);

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

  // Swap a button's icon for a tick for a moment after copying
  function showCopied(button) {
    const label = button.getAttribute('aria-label');
    button.replaceChildren(icon('check'));
    button.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      button.replaceChildren(icon('copy'));
      button.setAttribute('aria-label', label);
    }, 1500);
  }

  function copyButton(label, getText) {
    const button = iconButton('copy', label, () => {
      options.onEditor('copy', { text: getText() });
      showCopied(button);
    });
    return button;
  }

  // Header buttons of a fenced code block; none while the block is still streaming
  function codeActions(block) {
    if (block.open) return [];
    const buttons = [
      copyButton('Copy', () => block.text),
      iconButton('insert', 'Insert at Cursor', () => options.onEditor('insertAtCursor', { text: block.text })),
      iconButton('newFile', 'Open in New File', () => options.onEditor('newFile', { text: block.text, language: block.lang }))
    ];
    if (SHELL_LANGS.has(block.lang)) {
      buttons.push(iconButton('terminal', 'Insert into Terminal (does not run it)',
        () => options.onEditor('insertInTerminal', { text: block.text })));
    }
    return buttons;
  }

  const markdownHooks = {
    onLink: (url) => options.onEditor('openLink', { url }),
    codeActions
  };

  // An agent reply: header (avatar + name), optional status line, text, then a
  // bar with the footer ("A2A · 1.8s · completed") and the reply's actions
  function createReply(container, agentName) {
    const bubble = appendMessage(container, '', 'agent');
    const head = el('div', 'agent-head');
    head.appendChild(avatar(14));
    head.appendChild(el('span', 'name', agentName));
    bubble.appendChild(head);

    const reply = { bubble, container, received: false, markdown: '', renderQueued: false };
    reply.status = el('div', 'status');
    reply.text = el('div', 'text');
    reply.bar = el('div', 'reply-bar');
    reply.footer = el('div', 'footer');
    reply.actions = el('div', 'reply-actions');
    reply.bar.append(reply.footer, reply.actions);
    bubble.append(reply.status, reply.text, reply.bar);
    reply.status.hidden = true;
    reply.footer.hidden = true;
    reply.bar.hidden = true;
    reply.text.replaceChildren(typingDots());
    return reply;
  }

  function renderReply(reply) {
    reply.renderQueued = false;
    reply.text.replaceChildren(markdown.render(markdown.parse(reply.markdown), markdownHooks));
    scrollToBottom(reply.container);
  }

  function addChunk(reply, text) {
    reply.received = true;
    reply.markdown += text;
    if (!reply.renderQueued) {
      reply.renderQueued = true;
      nextFrame(() => { if (reply.renderQueued) renderReply(reply); });
    }
  }

  function setStatus(reply, text) {
    reply.status.textContent = text;
    reply.status.hidden = false;
    scrollToBottom(reply.container);
  }

  // End a reply: render the final text, then add an error line, the footer and
  // the actions (Copy when there is text; Retry when it failed and onRetry is given)
  function finishReply(reply, { footer, error, onRetry } = {}) {
    if (reply.received) {
      renderReply(reply);
    } else {
      reply.text.textContent = '';
    }
    if (error) reply.bubble.insertBefore(el('div', 'error-text', error), reply.bar);
    if (footer) {
      reply.footer.textContent = footer;
      reply.footer.hidden = false;
    }
    if (reply.received) reply.actions.appendChild(copyButton('Copy reply', () => reply.markdown));
    if (error && onRetry) {
      const retry = el('button', 'retry secondary');
      retry.append(icon('retry', 12), document.createTextNode('Retry'));
      retry.addEventListener('click', onRetry);
      reply.actions.appendChild(retry);
    }
    reply.bar.hidden = reply.footer.hidden && !reply.actions.childElementCount;
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

  app.chat = { configure, appendMessage, renderWelcome, createReply, addChunk, setStatus, finishReply, footerText };
})(window.AgentCore);
