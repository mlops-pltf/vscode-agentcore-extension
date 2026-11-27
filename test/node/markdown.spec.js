// media/webview/markdown.js: parse() is plain data, so it runs here without a
// browser; render() is covered by the panel tests (webview.e2e.spec.js).
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert, REPO } = require('./helpers');

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'media', 'webview', 'markdown.js'), 'utf8'), { window });
const { parse, isWebLink } = window.AgentCore.markdown;
// Plain copies: objects from the vm context belong to another realm
const md = (text) => JSON.parse(JSON.stringify(parse(text)));
const text = (t) => ({ type: 'text', text: t });

test('paragraphs keep single newlines as line breaks', () => {
  assert.deepStrictEqual(md('one\ntwo\n\nthree'), [
    { type: 'paragraph', children: [text('one'), { type: 'break' }, text('two')] },
    { type: 'paragraph', children: [text('three')] }
  ]);
});

test('headings, rules and quotes', () => {
  assert.deepStrictEqual(md('## Title ##\n---\n> quoted\n> **more**'), [
    { type: 'heading', level: 2, children: [text('Title')] },
    { type: 'rule' },
    { type: 'quote', children: [{ type: 'paragraph', children: [
      text('quoted'), { type: 'break' }, { type: 'strong', children: [text('more')] }
    ] }] }
  ]);
  assert.strictEqual(md('#hashtag')[0].type, 'paragraph', 'a heading needs a space');
});

test('inline: bold, italic, strike, code, escapes, snake_case', () => {
  assert.deepStrictEqual(md('**b** *i* _u_ ~~s~~ `a*b*`')[0].children, [
    { type: 'strong', children: [text('b')] }, text(' '),
    { type: 'em', children: [text('i')] }, text(' '),
    { type: 'em', children: [text('u')] }, text(' '),
    { type: 'strike', children: [text('s')] }, text(' '),
    { type: 'code', text: 'a*b*' }
  ]);
  assert.deepStrictEqual(md('*a **b** c*')[0].children, [
    { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] }
  ]);
  assert.deepStrictEqual(md('my_var_name and 2 * 3 * 4')[0].children, [text('my_var_name and 2 * 3 * 4')]);
  assert.deepStrictEqual(md('\\*not italic\\*')[0].children, [text('*not italic*')]);
  assert.deepStrictEqual(md('**unclosed')[0].children, [text('**unclosed')], 'streaming: shown as typed');
});

test('links: markdown, autolinks and bare URLs', () => {
  assert.deepStrictEqual(md('see [docs](https://a.example/x?y=1) or <https://b.example> or https://c.example/p.')[0].children, [
    text('see '),
    { type: 'link', href: 'https://a.example/x?y=1', children: [text('docs')] },
    text(' or '),
    { type: 'link', href: 'https://b.example', children: [text('https://b.example')] },
    text(' or '),
    { type: 'link', href: 'https://c.example/p', children: [text('https://c.example/p')] },
    text('.')
  ]);
  assert.ok(isWebLink('https://x') && isWebLink('HTTP://x'));
  assert.ok(!isWebLink('javascript:alert(1)') && !isWebLink('file:///etc/hosts') && !isWebLink('command:workbench.action.quit'));
});

test('fenced code: language, contents kept verbatim, open while streaming', () => {
  assert.deepStrictEqual(md('```Python\ndef f():\n    return "**x**"\n```\nafter'), [
    { type: 'code', lang: 'python', text: 'def f():\n    return "**x**"', open: false },
    { type: 'paragraph', children: [text('after')] }
  ]);
  assert.deepStrictEqual(md('~~~\n```\nstill code'), [
    { type: 'code', lang: '', text: '```\nstill code', open: true }
  ]);
});

test('lists: ordered start, nesting, continuation and loose items', () => {
  const [list] = md('3. one\n   - a\n   - b\n4. two\n   more text\n\n   second para\n5. three');
  assert.strictEqual(list.type, 'list');
  assert.strictEqual(list.ordered, true);
  assert.strictEqual(list.start, 3);
  assert.strictEqual(list.items.length, 3);
  assert.deepStrictEqual(list.items[0][1], {
    type: 'list', ordered: false, items: [
      [{ type: 'paragraph', children: [text('a')] }],
      [{ type: 'paragraph', children: [text('b')] }]
    ]
  });
  assert.deepStrictEqual(list.items[1], [
    { type: 'paragraph', children: [text('two'), { type: 'break' }, text('more text')] },
    { type: 'paragraph', children: [text('second para')] }
  ]);

  const blocks = md('- a\n- b\n\nAfter the list\n1. x');
  assert.deepStrictEqual(blocks.map((b) => b.type), ['list', 'paragraph', 'list']);
  assert.strictEqual(blocks[0].items.length, 2);
  assert.deepStrictEqual(md('* x\n1. y').map((b) => b.ordered), [false, true], 'a different marker starts a new list');
});

test('every prefix of a reply parses (streaming never throws)', () => {
  const sample = '# T\n\n1. **a** [l](https://x.example)\n   ```sh\n   ls\n   ```\n> q `c`\n\n***\n_e_ ~~s~~';
  for (let i = 0; i <= sample.length; i++) assert.ok(Array.isArray(parse(sample.slice(0, i))));
});

test('tables: header, alignment, inline content, escaped pipes, ragged rows', () => {
  const [table, after] = md('|Day|Focus|Hours|\n|:---|:---:|---:|\n|Mon|**API** `v2`|4|\n| Tue | a \\| b |\n\nafter');
  assert.strictEqual(table.type, 'table');
  assert.deepStrictEqual(table.align, ['left', 'center', 'right']);
  assert.deepStrictEqual(table.header, [[text('Day')], [text('Focus')], [text('Hours')]]);
  assert.deepStrictEqual(table.rows, [
    [[text('Mon')], [{ type: 'strong', children: [text('API')] }, text(' '), { type: 'code', text: 'v2' }], [text('4')]],
    [[text('Tue')], [text('a | b')], []]
  ]);
  assert.strictEqual(after.type, 'paragraph');

  // Without outer pipes, and right after a paragraph line
  const blocks = md('Plan:\nDay | Focus\n--- | ---\nMon | API');
  assert.deepStrictEqual(blocks.map((b) => b.type), ['paragraph', 'table']);
  assert.deepStrictEqual(blocks[1].rows, [[[text('Mon')], [text('API')]]]);
});

test('not tables: no delimiter yet (streaming), column mismatch, plain pipes', () => {
  assert.strictEqual(md('|Day|Focus|')[0].type, 'paragraph', 'header alone while the delimiter is still coming');
  assert.strictEqual(md('|Day|Focus|\n|---|')[0].type, 'paragraph', 'delimiter must match the header');
  assert.strictEqual(md('a | b\nc | d')[0].type, 'paragraph');
  assert.strictEqual(md('|a|\n---')[1].type, 'rule', 'a rule is not a delimiter row');
});
