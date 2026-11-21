// Prints one version's section of CHANGELOG.md (used as GitHub Release notes).
// Usage: node scripts/changelog-section.js 0.9.0
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
const lines = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (!version || start === -1) {
  console.error(`No "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
console.log(lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim());
