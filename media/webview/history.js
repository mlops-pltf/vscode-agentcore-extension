// Chat history in the panel (Phase 14): the History list, and showing a saved
// chat's turns. Saving and loading are Python's (python/agentcore/history.py);
// main.js's continueChat() takes over a chat the user opens.
(function (app) {
  const { el, iconButton } = app.dom;
  const chatView = app.chat;

  const WAITING = ['input-required', 'auth-required'];

  // A saved turn (python/agentcore/history.py), shown like it was: the prompt,
  // then the reply with its tool steps, footer and actions (no Retry)
  function renderPastTurn(container, turn) {
    chatView.appendMessage(container, turn.prompt || '', 'user', turn.mentionLength || 0);
    const saved = turn.reply || {};
    const meta = saved.meta || {};
    const reply = chatView.createReply(container, turn.agentName || 'Agent');
    for (const segment of saved.segments || []) {
      if (segment.kind === 'text') {
        reply.segments.push({ kind: 'text', text: segment.text || '' });
        reply.received = true;
      } else if (segment.kind === 'tool' && segment.id) {
        const step = { ...segment, open: false };
        reply.steps.set(step.id, step);
        reply.segments.push(step);
      }
    }
    chatView.finishReply(reply, { footer: chatView.footerText(meta), error: saved.error, trace: meta, rawJson: meta.rawJson });
    if (WAITING.includes(meta.taskState)) chatView.setStatus(reply, 'Agent is waiting for your input');
    if (!reply.segments.length && !saved.error) reply.text.textContent = saved.state === 'cancelled' ? '(cancelled)' : '(empty reply)';
    return reply;
  }

  function when(iso) {
    const date = new Date(iso);
    return isNaN(date) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  // The History list. items: [{sessionId, title, agentName, turns, updated, mock}]
  function renderHistory(container, { items, enabled, currentSessionId, onOpen, onDelete, onClearAll, onBack }) {
    const view = el('div', 'history');
    const head = el('div', 'history-head');
    const back = el('button', 'secondary', '← Back');
    back.addEventListener('click', onBack);
    head.append(back, el('h2', '', 'History'));
    if (items.length) {
      // Two clicks, so one stray click can't delete everything
      const clear = el('button', 'secondary clear-all', 'Clear all');
      clear.addEventListener('click', () => {
        if (clear.dataset.confirm) return onClearAll();
        clear.dataset.confirm = '1';
        clear.textContent = 'Click again to delete all';
      });
      head.appendChild(clear);
    }
    view.appendChild(head);
    if (!enabled) view.appendChild(el('p', 'note', 'Saving is off (setting agentcore.history). Saved chats stay here until you delete them.'));
    if (!items.length) view.appendChild(el('p', 'history-empty', 'No saved chats yet. Chats are saved here as you go.'));

    const list = el('ul', 'history-list');
    for (const item of items) {
      const row = el('li', 'history-item' + (item.sessionId === currentSessionId ? ' current' : ''));
      const open = el('button', 'history-open');
      open.title = 'Open and continue this chat';
      open.appendChild(el('span', 'history-title', item.title));
      const details = [item.agentName, `${item.turns} message${item.turns === 1 ? '' : 's'}`, when(item.updated)].filter(Boolean).join(' · ');
      const meta = el('span', 'history-meta', details);
      if (item.mock) meta.prepend(el('span', 'badge', 'MOCK'));
      open.appendChild(meta);
      open.addEventListener('click', () => onOpen(item.sessionId));
      row.append(open, iconButton('trash', 'Delete this chat', () => onDelete(item.sessionId)));
      list.appendChild(row);
    }
    view.appendChild(list);
    container.replaceChildren(view);
  }

  /**
   * @param {object} parts
   * @param {(message: object) => void} parts.post   send to the extension (and Python)
   * @param {HTMLElement} parts.chat                 the conversation, hidden while History is open
   * @param {HTMLElement} parts.view                 where the list goes
   * @param {() => string|null} parts.openSessionId  the chat now open, marked in the list
   * @param {(chat: object) => void} parts.onContinue   a saved chat was opened
   */
  function create({ post, chat, view, openSessionId, onContinue }) {
    function open() {
      view.replaceChildren(el('p', 'history-loading', 'Loading...'));
      view.hidden = false;
      chat.hidden = true;
      post({ action: 'list_history' });
    }

    function close() {
      view.hidden = true;
      chat.hidden = false;
    }

    // Messages from Python, merged into main.js's handler table
    const handlers = {
      history(msg) {
        if (view.hidden) return;
        renderHistory(view, {
          items: msg.items,
          enabled: msg.enabled,
          currentSessionId: openSessionId(),
          onOpen: (id) => post({ action: 'get_history', sessionId: id }),
          onDelete: (id) => post({ action: 'delete_history', sessionId: id }),
          onClearAll: () => post({ action: 'delete_history', all: true }),
          onBack: close
        });
      },
      history_chat(msg) {
        if (msg.chat && msg.chat.turns && msg.chat.turns.length) {
          onContinue(msg.chat);
        } else {
          view.prepend(el('p', 'note warn', 'That chat could not be opened (it may have been deleted).'));
        }
      }
    };

    return {
      open,
      close,
      toggle: () => (view.hidden ? open() : close()),
      handlers,
      showTurns: (container, turns) => turns.forEach((turn) => renderPastTurn(container, turn))
    };
  }

  app.history = { create };
})(window.AgentCore);
