// Node 22+ treats `node --test tests/` as a module path, not a directory to scan.
const fs = require('node:fs');

for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs')).sort()) {
  require(`./${file}`);
}
