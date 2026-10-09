'use strict';
// Unisce launcher + server + parser in un unico file (serve per l'.exe: lì require() carica solo moduli di Node).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^#!.*\n/, '');

function bundle(outFile) {
  const mods = [
    ['./lib/parser', 'lib/parser.js'],
    ['./server', 'server.js'],
    ['./launcher', 'launcher.js'],
  ];
  const defs = mods.map(([name, file]) =>
    `${JSON.stringify(name)}: function (module, exports, require, __dirname, __filename) {\n${read(file)}\n}`).join(',\n');
  const out = `'use strict';
const __defs = {
${defs}
};
const __cache = {};
// Fuori dall'.exe (prove con node dist/exe-main.js) la cartella public/ sta accanto a dist/.
const __dir = require('fs').existsSync(require('path').join(__dirname, '..', 'public'))
  ? require('path').resolve(__dirname, '..')
  : require('path').dirname(process.execPath);
function __req(name) {
  if (!Object.prototype.hasOwnProperty.call(__defs, name)) return require(name);
  if (!__cache[name]) {
    const m = { exports: {} };
    __cache[name] = m;
    __defs[name](m, m.exports, __req, __dir, process.execPath);
  }
  return __cache[name].exports;
}
__req('./launcher');
`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out);
  return outFile;
}

if (require.main === module) {
  const out = bundle(path.join(root, 'dist', 'exe-main.js'));
  console.log('Creato', path.relative(root, out), `(${fs.statSync(out).size} byte)`);
}
module.exports = { bundle };
