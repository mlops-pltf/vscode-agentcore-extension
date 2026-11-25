// "@agent" in the message box (Phases 12, 15). In @ mode, a message that starts
// with @name talks to that agent (main.js decides what that means for the chat).
// Typing "@" at the start opens the agent list (rows shared with picker.js); the
// mention is highlighted by a mirror layer behind the textarea (a textarea can't
// style part of its text). In picker mode all of this is off: "@" is plain text.
(function (app) {
  const { el } = app.dom;

  // "@name" at the very start, optionally followed by "," or ":"
  const LEADING = /^@([\w.-]+)[,:]?\s*/;
  // While typing: "@" and the name so far, with the caret right after it
  const TYPING = /^@([\w.-]*)$/;

  /**
   * @param {object} parts
   * @param {HTMLTextAreaElement} parts.input   the message box
   * @param {HTMLElement} parts.mirror          the highlight layer behind it
   * @param {HTMLElement} parts.popup           the list's panel
   * @param {HTMLElement} parts.list            the list
   * @param {HTMLSelectElement} parts.select    the agents (the picker's hidden select)
   * @param {() => void} parts.onChange         the text changed (main.js resizes the box)
   * @param {() => boolean} parts.enabled        whether @ mode is on
   */
  function create({ input, mirror, popup, list, select, onChange, enabled }) {
    let shown = [];
    const cursor = app.picker.rowCursor(list);

    const agentOptions = () => [...select.options].filter((option) => option.value);
    const byName = (name) => agentOptions().find((o) => o.textContent.toLowerCase() === name.toLowerCase());

    // The agent a message is addressed to: null if it doesn't start with "@";
    // otherwise {name, option (undefined if no such agent), rest (the message without it), length}
    function resolve(text) {
      if (!enabled()) return null;
      const match = LEADING.exec(text);
      if (!match) return null;
      return { name: match[1], option: byName(match[1]), rest: text.slice(match[0].length).trim(), length: 1 + match[1].length };
    }

    // Highlight a known "@name" at the start; the rest of the mirror is invisible
    function refresh() {
      const text = input.value;
      const match = enabled() ? LEADING.exec(text) : null;
      const length = match && byName(match[1]) ? 1 + match[1].length : 0;
      mirror.replaceChildren();
      if (length) mirror.appendChild(el('span', 'mention', text.slice(0, length)));
      // A trailing newline keeps the mirror's last line as tall as the textarea's
      mirror.appendChild(document.createTextNode(text.slice(length) + '\n'));
      mirror.scrollTop = input.scrollTop;
    }

    function typedQuery() {
      if (input.selectionStart !== input.selectionEnd) return null;
      const match = TYPING.exec(input.value.slice(0, input.selectionStart));
      return match ? match[1] : null;
    }

    function close() {
      popup.hidden = true;
    }

    function update() {
      const query = enabled() ? typedQuery() : null;
      if (query === null || !agentOptions().length) {
        close();
        return;
      }
      const lower = query.toLowerCase();
      shown = agentOptions().filter((option) => option.textContent.toLowerCase().includes(lower));
      if (!shown.length) {
        close();
        return;
      }
      popup.hidden = false;
      list.replaceChildren(...shown.map((option, i) => app.picker.agentRow(option, i, lower, {
        onChoose: insert,
        onHover: (index) => cursor.set(index),
        idPrefix: 'mention-option'
      })));
      cursor.fit(shown.length);
    }

    // Replace "@partial" with "@name " and keep whatever was after the caret
    function insert(option) {
      const after = input.value.slice(input.selectionStart).replace(/^[\w.-]*[,:]?\s*/, '');
      const head = `@${option.textContent} `;
      input.value = head + after;
      input.setSelectionRange(head.length, head.length);
      close();
      input.focus();
      onChange();
    }

    // Keys for the list while it is open; returns true when the key was used
    function handleKey(event) {
      if (popup.hidden) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        cursor.step(event.key === 'ArrowDown' ? 1 : -1, shown.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        insert(shown[cursor.index]);
      } else if (event.key === 'Escape') {
        close();
        event.stopPropagation();  // Esc elsewhere stops a reply (main.js)
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    }

    input.addEventListener('input', () => { cursor.reset(); update(); refresh(); });
    input.addEventListener('click', update);
    input.addEventListener('scroll', () => { mirror.scrollTop = input.scrollTop; });
    input.addEventListener('blur', close);
    // The agent list changed (loaded, refreshed): a mention may have become (un)known
    new MutationObserver(refresh).observe(select, { childList: true });

    refresh();
    return { resolve, refresh, handleKey, close };
  }

  app.mentions = { create };
})(window.AgentCore);
