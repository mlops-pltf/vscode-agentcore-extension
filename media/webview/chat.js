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

  // ---------- smart scrolling ----------

  // New text keeps the chat scrolled to the bottom only while the user is there.
  // Scrolling up to read stops that and shows the "Jump to latest" button.
  const scroll = { follow: true, lastTop: 0, button: null };
  const NEAR_BOTTOM_PX = 40;

  function stopFollowing() {
    scroll.follow = false;
    scroll.button.hidden = false;
  }

  function initScroll(container, button) {
    scroll.button = button;
    // Wheel/trackpad up stops following at once, before the next text renders;
    // waiting for the scroll event let new text pull the view back down
    container.addEventListener('wheel', (event) => {
      if (event.deltaY < 0) stopFollowing();
    }, { passive: true });
    container.addEventListener('scroll', () => {
      const top = container.scrollTop;
      const atBottom = container.scrollHeight - top - container.clientHeight < NEAR_BOTTOM_PX;
      // Only the user scrolls up (also with the scrollbar); our own scrolling and
      // growing text only go down. Following resumes when moving down to the bottom.
      if (top < scroll.lastTop - 2) {
        scroll.follow = false;
      } else if (atBottom) {
        scroll.follow = true;
      }
      scroll.lastTop = top;
      button.hidden = scroll.follow;
    });
    button.addEventListener('click', () => scrollToBottom(container, true));
  }

  // force: the user sent a prompt or clicked "Jump to latest"
  function scrollToBottom(container, force) {
    if (force) scroll.follow = true;
    if (scroll.follow) {
      container.scrollTop = container.scrollHeight;
      scroll.lastTop = container.scrollTop;
    }
    if (scroll.button) scroll.button.hidden = scroll.follow;
  }

  // mentionLength: the first characters are an "@agent" mention, shown highlighted
  function appendMessage(container, text, cls, mentionLength = 0) {
    container.querySelector('.empty')?.remove();
    const div = el('div', 'msg ' + cls, mentionLength ? undefined : text);
    if (mentionLength) {
      div.append(el('span', 'mention', text.slice(0, mentionLength)), document.createTextNode(text.slice(mentionLength)));
    }
    container.appendChild(div);
    scrollToBottom(container, cls === 'user');
    return div;
  }

  // Welcome card shown while the chat is empty. onPick(text) fills the composer.
  // agentCard (A2A agents, when available) adds the version and the skills.
  function renderWelcome(container, { agent, agentCard, protocol, suggestions, onPick }) {
    const card = el('div', 'empty');
    card.appendChild(avatar(26));
    card.appendChild(el('h2', '', agent ? agent.name : 'AgentCore Chat'));
    if (agent) {
      const version = agentCard && agentCard.version ? ` · v${agentCard.version}` : '';
      card.appendChild(el('div', 'protocol', `${protocol} agent${version}`));
    }
    card.appendChild(el('p', '', agent
      ? (agent.description || (agentCard && agentCard.description) || 'Ask a question to start the conversation.')
      : 'Choose an AWS profile and an agent below to start chatting.'));

    if (agent && agentCard && agentCard.skills.length) {
      const skills = el('div', 'skills');
      skills.appendChild(el('div', 'label', 'Skills'));
      for (const skill of agentCard.skills) {
        const tag = el('span', 'skill', skill.name);
        if (skill.description) tag.title = skill.description;
        skills.appendChild(tag);
      }
      card.appendChild(skills);
    }

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
    scrollToBottom(container, true);
  }

  // Three bouncing dots and "Thinking · 4s" until the first words arrive
  // (main.css animates the dots). Returns the node; the timer is kept on the reply.
  function typingIndicator(reply) {
    const wrap = el('span', 'thinking');
    const dots = el('span', 'typing');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Agent is replying');
    for (let i = 0; i < 3; i++) dots.appendChild(el('span'));
    const label = el('span', 'elapsed', 'Thinking');
    wrap.append(dots, label);
    const started = Date.now();
    reply.timer = setInterval(() => {
      label.textContent = `Thinking · ${Math.floor((Date.now() - started) / 1000)}s`;
    }, 1000);
    return wrap;
  }

  function stopTimer(reply) {
    clearInterval(reply.timer);
    reply.timer = undefined;
  }

  // Swap a button's icon for a tick for a moment after copying
  function showCopied(button, iconName) {
    const label = button.getAttribute('aria-label');
    button.replaceChildren(icon('check'));
    button.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      button.replaceChildren(icon(iconName));
      button.setAttribute('aria-label', label);
    }, 1500);
  }

  function copyButton(label, getText, iconName = 'copy') {
    const button = iconButton(iconName, label, () => {
      options.onEditor('copy', { text: getText() });
      showCopied(button, iconName);
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
    reply.text.replaceChildren(typingIndicator(reply));
    return reply;
  }

  function renderReply(reply) {
    stopTimer(reply);
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
  // the actions: Copy when there is text; Open raw JSON when the reply was built
  // from JSON; Copy trace ID and Open in CloudWatch when trace = {traceId,
  // cloudwatchUrl} is known; Retry when it failed
  function finishReply(reply, { footer, error, trace, rawJson, onRetry } = {}) {
    stopTimer(reply);
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
    if (rawJson) {
      reply.actions.appendChild(iconButton('json', 'Open raw JSON',
        () => options.onEditor('newFile', { text: rawJson, language: 'json' })));
    }
    if (trace && trace.traceId) {
      reply.actions.appendChild(copyButton(`Copy trace ID (${trace.traceId})`, () => trace.traceId, 'trace'));
      if (trace.cloudwatchUrl) {
        reply.actions.appendChild(iconButton('external', 'Open in CloudWatch (GenAI Observability)',
          () => options.onEditor('openLink', { url: trace.cloudwatchUrl })));
      }
    }
    if (error && onRetry) {
      const retry = el('button', 'retry secondary');
      retry.append(icon('retry', 12), document.createTextNode('Retry'));
      retry.addEventListener('click', onRetry);
      reply.actions.appendChild(retry);
    }
    reply.bar.hidden = reply.footer.hidden && !reply.actions.childElementCount;
    scrollToBottom(reply.container);
  }

  // e.g. "A2A · streamed · 1.8s · completed"
  function footerText(meta) {
    const parts = [meta.protocol];
    if (meta.streamed) parts.push('streamed');
    if (typeof meta.ms === 'number') parts.push((meta.ms / 1000).toFixed(1) + 's');
    const state = meta.state === 'cancelled' ? 'cancelled' : (meta.taskState || meta.state);
    if (state) parts.push(state.replace(/-/g, ' '));
    return parts.filter(Boolean).join(' · ');
  }

  app.chat = { configure, initScroll, appendMessage, renderWelcome, createReply, addChunk, setStatus, finishReply, footerText };
})(window.AgentCore);
