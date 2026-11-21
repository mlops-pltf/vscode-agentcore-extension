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

  app.dom = { $, newId, el, setOptions, setPlaceholder, robotIcon, avatar };
})(window.AgentCore = window.AgentCore || {});
