// A small, safe Markdown renderer for agent replies.
//   parse(text)         -> a tree of plain objects (no DOM; unit-tested in Node)
//   render(tree, hooks) -> DOM nodes built with createElement/textContent only
// Supports paragraphs, headings, **bold**, *italic*, ~~strike~~, `code`, fenced
// code blocks, bulleted/numbered lists (nested), block quotes, rules, links and
// GitHub-style tables.
// Single newlines inside a paragraph are kept as line breaks (agents rely on them).
(function (app) {
  // ---------- blocks ----------

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const BULLET = /^( *)([-*+])( +)(.*)$/;
  const ORDERED = /^( *)(\d{1,9})[.)]( +)(.*)$/;

  const indentOf = (line) => line.match(/^ */)[0].length;

  // Tables: a header row, then a delimiter row like |---|:---:|---:|
  const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  // Cells of a table row; "\|" is a literal pipe inside a cell
  function tableCells(line) {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }

  function tableStartsAt(lines, i) {
    const next = lines[i + 1];
    return lines[i].includes('|') && next !== undefined && next.includes('|') && TABLE_DELIMITER.test(next)
      && tableCells(next).length === tableCells(lines[i]).length;
  }

  function parseTable(lines, i, blocks) {
    const header = tableCells(lines[i]);
    const align = tableCells(lines[i + 1]).map((cell) =>
      cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
    const fit = (cells) => header.map((_, c) => parseInline(cells[c] || ''));
    const rows = [];
    for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|') && !startsBlock(lines[i]); i++) {
      rows.push(fit(tableCells(lines[i])));
    }
    blocks.push({ type: 'table', align, header: fit(header), rows });
    return i;
  }

  function listMarker(line) {
    let m = BULLET.exec(line);
    if (m) return { ordered: false, indent: m[1].length, content: m[4], contentIndent: m[1].length + 1 + m[3].length };
    m = ORDERED.exec(line);
    if (m) return { ordered: true, start: Number(m[2]), indent: m[1].length, content: m[4], contentIndent: m[1].length + m[2].length + 1 + m[3].length };
    return null;
  }

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || listMarker(line) !== null;
  }

  function parse(text) {
    return parseBlocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
  }

  function parseBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if ((m = FENCE.exec(line))) {
        // A fence still open (reply streaming in) is shown as code so far
        const fence = m[1];
        const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
        const body = [];
        let open = true;
        for (i++; i < lines.length; i++) {
          if (closing.test(lines[i])) { open = false; i++; break; }
          body.push(lines[i]);
        }
        blocks.push({ type: 'code', lang: m[2].toLowerCase(), text: body.join('\n'), open });
      } else if ((m = HEADING.exec(line))) {
        blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
        i++;
      } else if (RULE.test(line)) {
        blocks.push({ type: 'rule' });
        i++;
      } else if (QUOTE.test(line)) {
        const inner = [];
        for (; i < lines.length && (m = QUOTE.exec(lines[i])); i++) inner.push(m[1]);
        blocks.push({ type: 'quote', children: parseBlocks(inner) });
      } else if (listMarker(line)) {
        i = parseList(lines, i, blocks);
      } else if (tableStartsAt(lines, i)) {
        i = parseTable(lines, i, blocks);
      } else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(para.length && tableStartsAt(lines, i)); i++) {
          para.push(lines[i].trim());
        }
        blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
      }
    }
    return blocks;
  }

  // One list starting at lines[i]; returns the index after it. Each item's lines
  // (minus its indent) are parsed as blocks, which gives nested lists for free.
  function parseList(lines, i, blocks) {
    const first = listMarker(lines[i]);
    const list = { type: 'list', ordered: first.ordered, start: first.start, items: [] };
    while (i < lines.length) {
      const marker = listMarker(lines[i]);
      if (!marker || marker.ordered !== list.ordered || marker.indent > first.indent + 1) break;
      const itemLines = [marker.content];
      for (i++; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
          // A blank line continues the item only if indented content follows
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          if (next < lines.length && indentOf(lines[next]) > marker.indent + 1) {
            for (; i < next; i++) itemLines.push('');
            i--;
            continue;
          }
          break;
        }
        if (indentOf(line) > marker.indent + 1) {
          itemLines.push(line.slice(Math.min(indentOf(line), marker.contentIndent)));
        } else if (startsBlock(line)) {
          break;
        } else {
          itemLines.push(line.trim());  // lazy continuation of the item's text
        }
      }
      list.items.push(parseBlocks(itemLines));
    }
    blocks.push(list);
    return i;
  }

  // ---------- inline ----------

  // Sticky regexes, tried at the current position only
  const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/y;
  const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
  const EM = /([*_])(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![*_])/y;
  const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;
  const LINK = /\[([^\]\n]*)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"]*")?\s*\)/y;
  const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;
  const BARE_URL = /https?:\/\/[^\s<>]*[^\s<>.,:;"'!?)\]]/y;
  const WORD_CHAR = /[A-Za-z0-9]/;

  function at(regex, text, i) {
    regex.lastIndex = i;
    return regex.exec(text);
  }

  function parseInline(text) {
    const out = [];
    let plain = '';
    const push = (node) => {
      if (plain) out.push({ type: 'text', text: plain });
      plain = '';
      out.push(node);
    };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      // "_" inside a word (snake_case) is never emphasis
      const wordBefore = i > 0 && WORD_CHAR.test(text[i - 1]);
      let m = null;
      if (c === '\\' && /[!-/:-@[-`{-~]/.test(text[i + 1] || '')) {
        plain += text[i + 1];
        i += 2;
        continue;
      } else if (c === '\n') {
        push({ type: 'break' });
      } else if (c === '`' && (m = at(CODE_SPAN, text, i))) {
        push({ type: 'code', text: m[2].replace(/^ ([\s\S]*[^ ][\s\S]*) $/, '$1') });
      } else if ((c === '*' || (c === '_' && !wordBefore)) && (m = at(STRONG, text, i)) && !(c === '_' && WORD_CHAR.test(text[i + m[0].length] || ''))) {
        push({ type: 'strong', children: parseInline(m[2]) });
      } else if ((c === '*' || (c === '_' && !wordBefore)) && (m = at(EM, text, i)) && !(c === '_' && WORD_CHAR.test(text[i + m[0].length] || ''))) {
        push({ type: 'em', children: parseInline(m[2]) });
      } else if (c === '~' && (m = at(STRIKE, text, i))) {
        push({ type: 'strike', children: parseInline(m[1]) });
      } else if (c === '[' && (m = at(LINK, text, i))) {
        push({ type: 'link', href: m[2], children: parseInline(m[1]) });
      } else if (c === '<' && (m = at(AUTOLINK, text, i))) {
        push({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }] });
      } else if (c === 'h' && !wordBefore && (m = at(BARE_URL, text, i))) {
        push({ type: 'link', href: m[0], children: [{ type: 'text', text: m[0] }] });
      } else {
        plain += c;
        i++;
        continue;
      }
      i += m ? m[0].length : 1;
    }
    if (plain) out.push({ type: 'text', text: plain });
    return out;
  }

  // ---------- rendering ----------

  // Only web links become clickable; anything else (file:, command:, javascript:) stays text
  const isWebLink = (href) => /^https?:\/\//i.test(href);

  /**
   * @param {object[]} blocks   from parse()
   * @param {object} hooks
   * @param {(url: string) => void} [hooks.onLink]   a web link was clicked
   * @param {(block: object) => Node[]} [hooks.codeActions]   buttons for a code block's header
   */
  function render(blocks, hooks = {}) {
    const fragment = document.createDocumentFragment();
    for (const block of blocks) fragment.appendChild(renderBlock(block, hooks));
    return fragment;
  }

  function renderBlock(block, hooks) {
    switch (block.type) {
      case 'heading':
        return renderInline(document.createElement('h' + block.level), block.children, hooks);
      case 'paragraph':
        return renderInline(document.createElement('p'), block.children, hooks);
      case 'code':
        return renderCode(block, hooks);
      case 'list': {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        if (block.ordered && block.start !== 1) list.start = block.start;
        for (const item of block.items) {
          const li = document.createElement('li');
          li.appendChild(render(item, hooks));
          list.appendChild(li);
        }
        return list;
      }
      case 'quote': {
        const quote = document.createElement('blockquote');
        quote.appendChild(render(block.children, hooks));
        return quote;
      }
      case 'table':
        return renderTable(block, hooks);
      default:
        return document.createElement('hr');
    }
  }

  // Wide tables scroll sideways inside their wrapper instead of widening the chat
  function renderTable(block, hooks) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    const row = (cells, tag) => {
      const tr = document.createElement('tr');
      cells.forEach((cell, c) => {
        const td = renderInline(document.createElement(tag), cell, hooks);
        if (block.align[c]) td.className = 'align-' + block.align[c];
        tr.appendChild(td);
      });
      return tr;
    };
    const head = document.createElement('thead');
    head.appendChild(row(block.header, 'th'));
    table.appendChild(head);
    if (block.rows.length) {
      const body = document.createElement('tbody');
      for (const cells of block.rows) body.appendChild(row(cells, 'td'));
      table.appendChild(body);
    }
    wrap.appendChild(table);
    return wrap;
  }

  function renderCode(block, hooks) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const lang = document.createElement('span');
    lang.className = 'lang';
    lang.textContent = block.lang;
    head.appendChild(lang);
    if (hooks.codeActions) head.append(...hooks.codeActions(block));
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = block.text;
    pre.appendChild(code);
    wrap.append(head, pre);
    return wrap;
  }

  function renderInline(parent, nodes, hooks) {
    for (const node of nodes) {
      if (node.type === 'text') {
        parent.appendChild(document.createTextNode(node.text));
      } else if (node.type === 'break') {
        parent.appendChild(document.createElement('br'));
      } else if (node.type === 'code') {
        const code = document.createElement('code');
        code.textContent = node.text;
        parent.appendChild(code);
      } else if (node.type === 'link') {
        if (!isWebLink(node.href)) {
          renderInline(parent, node.children, hooks);
          continue;
        }
        // No href on purpose: VS Code's webview opens any <a href> click by itself,
        // which would skip the extension's checks and its "open external site?" prompt.
        // So the link is opened only by the extension, and works by click or Enter.
        const link = document.createElement('a');
        link.title = node.href;
        link.dataset.href = node.href;
        link.tabIndex = 0;
        link.setAttribute('role', 'link');
        const open = (event) => {
          event.preventDefault();
          if (hooks.onLink) hooks.onLink(node.href);
        };
        link.addEventListener('click', open);
        link.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(event); });
        parent.appendChild(renderInline(link, node.children, hooks));
      } else {
        const tag = { strong: 'strong', em: 'em', strike: 's' }[node.type];
        parent.appendChild(renderInline(document.createElement(tag), node.children, hooks));
      }
    }
    return parent;
  }

  app.markdown = { parse, render, isWebLink };
})(window.AgentCore = window.AgentCore || {});
