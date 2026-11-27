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

const pack = () => examples().find((block) => block.format === 'bichon-ad-iteration/v1' && block.pack);
const variant = () => examples().find((block) => block.format === 'bichon-ad-creative/v1' && block.creative.variant);

test('maps the avatar and pack commands to their routes', async () => {
  const cases = [
    [['avatar:list', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/ad-book/avatars'],
    [['avatar:upsert', '--brand', 'b1', '--file', file(example('bichon-ad-avatar/v1'))], null, '/agent/v1/brands/b1/ad-book/avatars'],
    [['creative:iteration:update', '--brand', 'b1', '--iteration', 'i1', '--file', file(example('bichon-ad-pack-patch/v1'))], 'PATCH', null],
  ];
  for (const [args, method, route] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stdout);
    if (method) assert.equal(result.requests[0].method, method);
    if (route) assert.equal(result.requests[0].path, route);
  }
});

test('the pack examples in SKILL.md validate', async () => {
  assert.ok(pack(), 'a pack iteration example');
  assert.ok(variant(), 'a variant creative example');
  const created = await call(['creative:iteration:create', '--brand', 'b1', '--file', file(pack()), '--dry-run']);
  assert.equal(created.code, 0, created.stdout);
  assert.equal(created.requests.length, 0);
});

test('a pack needs its primary text and headline before it is sent', async () => {
  const bundle = pack();
  const { primaryText: _dropped, ...copy } = bundle.pack.copy;
  const result = await call(['creative:iteration:create', '--brand', 'b1', '--file', file({ ...bundle, pack: { ...bundle.pack, copy } })]);
  assert.notEqual(result.code, 0);
  assert.equal(result.requests.length, 0);
});

test('an avatar over 16,000 bytes is refused before it is sent', async () => {
  const bundle = example('bichon-ad-avatar/v1');
  const long = '字'.repeat(2000);
  const avatar = { ...bundle.avatar, situation: long, problem: long, evidence: '字'.repeat(4000) };
  const result = await call(['avatar:upsert', '--brand', 'b1', '--file', file({ ...bundle, avatar })]);
  assert.notEqual(result.code, 0);
  assert.equal(result.requests.length, 0);
});

test('a creative names its variant or its angle', async () => {
  const bundle = variant();
  const { variant: _variant, angle: _angle, ...creative } = bundle.creative;
  const dir2 = file({ ...bundle, creative });
  const result = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', dir2, '--image', dir2, '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /variant/);
});

const reviewWithNext = () => examples().find((block) => block.format === 'bichon-ad-test-review/v1' && block.next);

test('the pack read maps to its route', async () => {
  const result = await call(['creative:pack:read', '--brand', 'b1', '--iteration', 'i1']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests[0].method, 'GET');
  assert.equal(result.requests[0].path, '/agent/v1/brands/b1/ad-review/iterations/i1/read');
});

test('a review draft carries the next step, and an agent cannot send stop', async () => {
  const bundle = reviewWithNext();
  assert.ok(bundle, 'a review example with next');
  const sent = await call(['creative:review:draft', '--brand', 'b1', '--iteration', 'i1', '--file', file(bundle), '--dry-run']);
  assert.equal(sent.code, 0, sent.stdout);
  const stop = await call(['creative:review:draft', '--brand', 'b1', '--iteration', 'i1', '--file', file({ ...bundle, next: { direction: 'stop' } })]);
  assert.notEqual(stop.code, 0);
  assert.equal(stop.requests.length, 0);
});
