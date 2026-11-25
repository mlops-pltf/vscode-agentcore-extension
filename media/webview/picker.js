// Searchable agent picker (Phase 8). A native <select> can't be searched, so the
// agent chip opens this list instead. The hidden <select> stays the source of
// truth: the picker shows its options and sets its value (with a "change" event),
// so main.js handles an agent change exactly as before.
(function (app) {
  const { el } = app.dom;

  // Text with every match of query wrapped in <mark> (text nodes only, never HTML)
  function highlighted(text, query) {
    const fragment = document.createDocumentFragment();
    const lower = text.toLowerCase();
    let at = 0;
    for (let found = query ? lower.indexOf(query) : -1; found !== -1; found = lower.indexOf(query, at)) {
      fragment.append(document.createTextNode(text.slice(at, found)), el('mark', '', text.slice(found, found + query.length)));
      at = found + query.length;
    }
    fragment.append(document.createTextNode(text.slice(at)));
    return fragment;
  }

  // One agent row (name, protocol, description; matches highlighted). Also used
  // by the "@" pop-up (mentions.js).
  function agentRow(option, index, query, { onChoose, onHover, idPrefix = 'agent-option' }) {
    const item = el('li', 'agent-option' + (option.selected ? ' current' : ''));
    item.id = `${idPrefix}-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    const top = el('div', 'top');
    const name = el('span', 'name');
    name.appendChild(highlighted(option.textContent, query));
    top.append(name, el('span', 'proto', option.dataset.protocol || '?'));
    item.appendChild(top);
    if (option.title) {
      const description = el('div', 'desc');
      description.appendChild(highlighted(option.title, query));
      item.appendChild(description);
    }
    // mousedown would move focus out of the text box and close the list
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => onChoose(option));
    item.addEventListener('mousemove', () => onHover(index));
    return item;
  }

  // The highlighted row of an agent list, moved with ↑/↓ (wrapping) or the mouse,
  // and scrolled into view. onMove(row) runs when it moves. Also used by mentions.js.
  function rowCursor(list, onMove) {
    let index = 0;
    const rows = () => list.querySelectorAll('.agent-option');
    const cursor = {
      get index() { return index; },
      set(i) {
        index = i;
        rows().forEach((row, n) => row.classList.toggle('active', n === i));
        const row = rows()[i];
        if (row) {
          row.scrollIntoView?.({ block: 'nearest' });
          if (onMove) onMove(row);
        }
      },
      step(delta, count) { if (count) cursor.set((index + delta + count) % count); },
      // The list was re-rendered with `count` rows: keep the highlight on a row that exists
      fit(count) { cursor.set(Math.min(index, Math.max(0, count - 1))); },
      reset() { index = 0; }
    };
    return cursor;
  }

  /**
   * @param {object} parts
   * @param {HTMLSelectElement} parts.select   the hidden agent <select>
   * @param {HTMLButtonElement} parts.button   the chip that opens the picker
   * @param {HTMLElement} parts.label          the agent name inside the chip
   * @param {HTMLElement} parts.popup          the panel holding input and list
   * @param {HTMLInputElement} parts.input     the search box
   * @param {HTMLElement} parts.list           the result list
   * @param {() => void} parts.onRefresh       reload the agent list
   * @param {() => boolean} [parts.canOpen]     false in @ mode (the chip then starts an @ instead)
   */
  function create({ select, button, label, popup, input, list, onRefresh, canOpen = () => true }) {
    let shown = [];   // options matching the search
    const cursor = rowCursor(list, (row) => input.setAttribute('aria-activedescendant', row.id));

    const agentOptions = () => [...select.options].filter((option) => option.value);

    // Show the select's state in the chip (also "Loading agents...", "No agents found")
    function sync() {
      const selected = select.options[select.selectedIndex];
      label.textContent = selected ? selected.textContent : '';
      button.title = selected && selected.value && selected.title ? `${selected.textContent}: ${selected.title}` : 'Agent';
      button.disabled = agentOptions().length === 0;
      if (button.disabled) close();
      else if (!popup.hidden) render();
    }

    function open() {
      if (button.disabled || !canOpen()) return;
      popup.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      input.value = '';
      input.placeholder = `Search ${agentOptions().length} agent${agentOptions().length === 1 ? '' : 's'}...`;
      render();
      cursor.set(Math.max(0, shown.findIndex((option) => option.selected)));
      input.focus();
    }

    function close(focusButton) {
      if (popup.hidden) return;
      popup.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (focusButton) button.focus();
    }

    function choose(option) {
      close(true);
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
      }
      sync();
    }

    function render() {
      const query = input.value.trim().toLowerCase();
      shown = agentOptions().filter((option) => !query
        || option.textContent.toLowerCase().includes(query)
        || (option.title || '').toLowerCase().includes(query));
      list.replaceChildren(...shown.map((option, i) => agentRow(option, i, query, {
        onChoose: choose,
        onHover: (index) => { if (cursor.index !== index) cursor.set(index); }
      })));
      if (!shown.length) {
        const none = el('li', 'none', 'No agents match. ');
        const refresh = el('button', 'link', 'Refresh agents');
        refresh.addEventListener('mousedown', (event) => event.preventDefault());
        refresh.addEventListener('click', () => { close(true); onRefresh(); });
        none.appendChild(refresh);
        list.appendChild(none);
      }
      cursor.fit(shown.length);
    }

    button.addEventListener('click', () => (popup.hidden ? open() : close(true)));
    input.addEventListener('input', () => { cursor.reset(); render(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        cursor.step(event.key === 'ArrowDown' ? 1 : -1, shown.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (shown[cursor.index]) choose(shown[cursor.index]);
      } else if (event.key === 'Escape') {
        // Only close the picker; Esc elsewhere stops a reply (main.js)
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'Tab') {
        close();
      }
    });
    // A click anywhere else closes it
    document.addEventListener('mousedown', (event) => {
      if (!popup.hidden && !popup.contains(event.target) && !button.contains(event.target)) close();
    });

    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
    select.addEventListener('change', sync);
    sync();
    return { open, close, sync };
  }

  app.picker = { create, agentRow, rowCursor };
})(window.AgentCore);
