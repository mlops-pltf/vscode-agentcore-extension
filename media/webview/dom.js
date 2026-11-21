// Small DOM helpers and icons shared by the panel scripts. Everything is built
// with createElement/textContent: untrusted text is never parsed as HTML.
// Panel scripts are classic scripts sharing window.AgentCore (see index.html).
(function (app) {
  const $ = (id) => document.getElementById(id);

  function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // Create an element with an optional class and text
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Fill a <select> safely: text goes through textContent, never parsed as HTML.
  // data becomes data-* attributes (e.g. the agent's protocol for the picker).
  function setOptions(select, items) {
    select.replaceChildren(...items.map(({ value, label, title, data }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (title) opt.title = title;
      for (const [key, val] of Object.entries(data || {})) if (val) opt.dataset[key] = val;
      return opt;
    }));
  }

  function setPlaceholder(select, label) {
    setOptions(select, [{ value: '', label }]);
  }

  // The extension's robot icon, built as SVG nodes
  function robotIcon(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    const parts = [
      ['rect', { x: '4.5', y: '7.5', width: '15', height: '10', rx: '3' }],
      ['path', { d: 'M12 4.5v3' }],
      ['path', { d: 'M9.5 12.5h.01M14.5 12.5h.01', 'stroke-width': '2.6' }]
    ];
    for (const [tag, partAttrs] of parts) {
      const part = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(partAttrs)) part.setAttribute(k, v);
      svg.appendChild(part);
    }
    return svg;
  }

  function avatar(size) {
    const span = el('span', 'avatar');
    span.appendChild(robotIcon(size));
    return span;
  }

  // Small stroke icons (16x16 grid) for reply and code-block actions
  const ICONS = {
    copy: 'M5.5 5.5h7v7h-7z M3.5 10.5v-7h7',
    check: 'M3.5 8.5l3 3 6-7',
    insert: 'M8 2.5v7 M5 6.5l3 3 3-3 M3 13h10',
    newFile: 'M4 2.5h5l3 3v8H4z M9 2.5v3h3 M8 8v4 M6 10h4',
    terminal: 'M2.5 3.5h11v9h-11z M5 6.5l2 1.5-2 1.5 M8.5 10h2.5',
    retry: 'M3 8a5 5 0 1 0 1.5-3.6 M3 2.5v3h3',
    trace: 'M1.5 8.5h3l1.5-4 3 7 1.5-3h4',
    external: 'M9 2.5h4.5V7 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4',
    json: 'M5.5 2.5c-1.3 0-1.8.6-1.8 1.8v1.9c0 .9-.5 1.5-1.4 1.8.9.3 1.4.9 1.4 1.8v1.9c0 1.2.5 1.8 1.8 1.8 M10.5 2.5c1.3 0 1.8.6 1.8 1.8v1.9c0 .9.5 1.5 1.4 1.8-.9.3-1.4.9-1.4 1.8v1.9c0 1.2-.5 1.8-1.8 1.8'
  };

  function icon(name, size = 14) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // An icon-only button; label is its tooltip and accessible name
  function iconButton(name, label, onClick, className = '') {
    const button = el('button', ('icon-btn small ' + className).trim());
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(icon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  app.dom = { $, newId, el, setOptions, setPlaceholder, robotIcon, avatar, icon, iconButton };
})(window.AgentCore = window.AgentCore || {});
