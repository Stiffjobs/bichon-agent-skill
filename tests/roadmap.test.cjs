const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillBlocks } = require('./support.cjs');

let server;
let dir;
let env;
const ok = (data, status = 200) => ({ status, body: { ok: true, data } });

before(async () => {
  server = await startServer(() => ok({ echo: true }));
  dir = tempDir();
  env = { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: server.url };
});
after(() => server.close());

async function call(args) {
  const count = server.requests.length;
  const result = await run(args, { env });
  return { ...result, requests: server.requests.slice(count) };
}

const file = (value) => writeJson(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), value);
const AGENT = { name: 'claude-code' };
const examples = () => skillBlocks('json').map((block) => JSON.parse(block));
const example = (format) => examples().find((block) => block.format === format);

test('maps the roadmap commands to their routes', async () => {
  const cases = [
    [['roadmap', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/ad-roadmap'],
    [['roadmap:sync', '--brand', 'b1', '--file', file(example('bichon-ad-roadmap/v1'))], 'PUT', '/agent/v1/brands/b1/ad-roadmap'],
    [['roadmap:item', '--brand', 'b1', '--key', 'xmas-2026.brief'], 'GET', '/agent/v1/brands/b1/ad-roadmap/items'],
    [['roadmap:item:update', '--brand', 'b1', '--file', file(example('bichon-ad-roadmap-item-update/v1'))], 'PATCH', '/agent/v1/brands/b1/ad-roadmap/items'],
  ];
  for (const [args, method, route] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests[0].method, method);
    assert.equal(result.requests[0].path, route);
  }
});

test('--prune is sent only when asked for', async () => {
  const bundle = file(example('bichon-ad-roadmap/v1'));
  const plain = await call(['roadmap:sync', '--brand', 'b1', '--file', bundle]);
  assert.equal(plain.requests[0].body.prune, undefined);
  const pruned = await call(['roadmap:sync', '--brand', 'b1', '--file', bundle, '--prune']);
  assert.equal(pruned.requests[0].body.prune, true);
});

test('a roadmap past its bounds is refused before it is sent', async () => {
  const bundle = example('bichon-ad-roadmap/v1');
  const events = Array.from({ length: 51 }, (_, index) => ({ ...bundle.events[0], key: `e${index}` }));
  const result = await call(['roadmap:sync', '--brand', 'b1', '--file', file({ ...bundle, events })]);
  assert.notEqual(result.code, 0);
  assert.equal(result.requests.length, 0);
});

test('a sync with more than 20 notes is refused before it is sent', async () => {
  const bundle = example('bichon-ad-roadmap/v1');
  const notes = Array.from({ length: 11 }, (_, index) => ({ text: `note ${index}` }));
  const items = bundle.items.slice(0, 2).map((item) => ({ ...item, notes }));
  const result = await call(['roadmap:sync', '--brand', 'b1', '--file', file({ ...bundle, items })]);
  assert.notEqual(result.code, 0);
  assert.equal(result.requests.length, 0);
});
