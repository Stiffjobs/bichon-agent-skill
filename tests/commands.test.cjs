const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillExamples } = require('./support.cjs');

let server;
let env;
const ok = (data) => ({ status: 200, body: { ok: true, data } });

before(async () => {
  server = await startServer(() => ok({ echo: true }));
  env = { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: server.url };
});
after(() => server.close());

async function call(args, extra = {}) {
  const count = server.requests.length;
  const result = await run(args, { env: { ...env, ...extra.env }, cwd: extra.cwd });
  return { ...result, requests: server.requests.slice(count) };
}

test('sends the bearer key and JSON headers', async () => {
  const result = await call(['brands']);
  assert.equal(result.code, 0);
  const [request] = result.requests;
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers.accept, 'application/json');
  assert.deepEqual(result.json, { ok: true, data: { echo: true } });
});

test('maps each read command to its route and query', async () => {
  const cases = [
    [['health'], 'GET', '/agent/v1/health', {}],
    [['brands'], 'GET', '/agent/v1/brands', {}],
    [['campaigns', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/campaigns', {}],
    [['campaigns', '--brand', 'b1', '--status', 'archived'], 'GET', '/agent/v1/brands/b1/campaigns', { status: 'archived' }],
    [['context', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/context', {}],
    [['evidence', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/evidence', {}],
    [['evidence', '--campaign', 'c1', '--q', 'sour coffee & grind', '--limit', '50'], 'GET', '/agent/v1/campaigns/c1/evidence', { q: 'sour coffee & grind', limit: '50' }],
    [['competitors', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/competitors', {}],
    [['ideas', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/ideas', {}],
    [['ideas', '--campaign', 'c1', '--status', 'killed'], 'GET', '/agent/v1/campaigns/c1/ideas', { status: 'killed' }],
    [['run:get', '--id', 'r1'], 'GET', '/agent/v1/ideation-runs/r1', {}],
    [['draft:get', '--id', 'd1'], 'GET', '/agent/v1/drafts/d1', {}],
    [['draft:submit', '--id', 'd1'], 'POST', '/agent/v1/drafts/d1/submit', {}],
    [['reviews', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/reviews', {}],
    [['reviews', '--campaign', 'c1', '--status', 'all', '--history'], 'GET', '/agent/v1/campaigns/c1/reviews', { status: 'all', history: '1' }],
    [['reviews', '--history', '--campaign', 'c1', '--status', 'submitted'], 'GET', '/agent/v1/campaigns/c1/reviews', { status: 'submitted', history: '1' }],
  ];
  for (const [args, method, pathname, query] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(result.requests.length, 1, args.join(' '));
    assert.equal(result.requests[0].method, method, args.join(' '));
    assert.equal(result.requests[0].path, pathname, args.join(' '));
    assert.deepEqual(result.requests[0].query, query, args.join(' '));
  }
});

test('reviews prints drafts with their requests unchanged', async () => {
  const reviews = {
    drafts: [{
      draftId: 'd1',
      ideaId: 'i1',
      ideaTitle: 'Why your pour-over tastes sour',
      socialProfileId: 'sp1',
      username: 'acme.coffee',
      status: 'changes_requested',
      revision: 1,
      caption: 'Sour cup? Grind finer.',
      reviewNote: 'Open with the fix, not the problem.',
      requests: [{
        commentId: 'k1',
        author: 'manager',
        body: 'Open with the fix, not the problem.',
        decision: 'request_changes',
        revision: 1,
        createdAt: 1790000000000,
        images: [{ url: 'https://r2.test/draft-review-1', width: null, height: null, expiresAt: 1790003600000 }],
      }],
    }],
    truncated: false,
  };
  server.reply(() => ok(reviews));
  const result = await call(['reviews', '--campaign', 'c1']);
  server.reply(() => ok({ echo: true }));
  assert.equal(result.code, 0);
  assert.deepEqual(result.json, { ok: true, data: reviews });
});

test('health adds the resolved config without the key', async () => {
  server.reply(() => ok({ organizationId: 'org_1', keyName: 'ci', user: { id: 'u1', name: 'Ada' } }));
  const result = await call(['health']);
  server.reply(() => ok({ echo: true }));
  assert.equal(result.json.data.organizationId, 'org_1');
  assert.equal(result.json.data.config.source, 'env');
  assert.ok(!result.stdout.includes(API_KEY));
});

test('encodes ids into path segments', async () => {
  const result = await call(['draft:get', '--id', 'a/b?c']);
  assert.equal(result.requests[0].path, '/agent/v1/drafts/a%2Fb%3Fc');
});

test('posts bundles verbatim to the submit routes', async () => {
  const dir = tempDir();
  const { ideationRun, drafts } = skillExamples();
  const runFile = writeJson(path.join(dir, 'run.json'), ideationRun);
  const draftsFile = writeJson(path.join(dir, 'drafts.json'), drafts);
  const ideas = await call(['ideas:submit', '--campaign', 'c1', '--file', runFile]);
  assert.equal(ideas.code, 0, ideas.stdout);
  assert.equal(ideas.requests[0].method, 'POST');
  assert.equal(ideas.requests[0].path, '/agent/v1/campaigns/c1/ideation-runs');
  assert.equal(ideas.requests[0].headers['content-type'], 'application/json');
  assert.deepEqual(ideas.requests[0].body, ideationRun);
  const posted = await call(['drafts:submit', '--idea', 'i1', '--file', draftsFile]);
  assert.equal(posted.requests[0].path, '/agent/v1/ideas/i1/drafts');
  assert.deepEqual(posted.requests[0].body, drafts);
});

test('context --out writes the bundle and prints a summary with versions', async () => {
  const context = {
    versions: { briefVersion: 'bv1', sourcePolicyVersion: 'sp1' },
    campaign: { id: 'c1', name: 'Autumn', contentLanguage: 'zh-TW' },
    personas: [{ key: 'p1' }],
    accounts: [{ socialProfileId: 'sp' }],
    formatMenu: ['image', 'text'],
    priorIdeas: [],
  };
  server.reply(() => ok(context));
  const dir = tempDir();
  const result = await call(['context', '--campaign', 'c1', '--out', 'out/context.json'], { cwd: dir });
  server.reply(() => ok({ echo: true }));
  assert.equal(result.code, 0);
  const file = path.join(dir, 'out/context.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), context);
  assert.equal(result.json.data.written, file);
  assert.deepEqual(result.json.data.versions, context.versions);
  assert.deepEqual(result.json.data.counts, { personas: 1, accounts: 1, formatMenu: 2, priorIdeas: 0 });
});

test('rejects bad options before any request', async () => {
  const invalid = [
    ['campaigns'],
    ['campaigns', '--brand'],
    ['campaigns', '--brand', 'b1', '--status', 'paused'],
    ['evidence', '--campaign', 'c1', '--limit', '0'],
    ['evidence', '--campaign', 'c1', '--limit', '51'],
    ['evidence', '--campaign', 'c1', '--limit', '5x'],
    ['ideas', '--campaign', 'c1', '--status', 'draft'],
    ['ideas:submit', '--campaign', 'c1'],
    ['drafts:submit', '--file', 'x.json'],
    ['draft:get'],
    ['reviews'],
    ['reviews', '--campaign', 'c1', '--status', 'rejected'],
    ['reviews', '--campaign', 'c1', '--history=0'],
    ['brands', 'stray'],
    ['publish'],
  ];
  for (const args of invalid) {
    const result = await call(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.requests.length, 0, args.join(' '));
    assert.equal(result.json.ok, false, args.join(' '));
    assert.equal(result.json.error.code, 'invalid_request', args.join(' '));
  }
});

test('passes API error envelopes through unchanged with exit code 1', async () => {
  const envelope = { ok: false, error: { code: 'stale_versions', message: 'The brief changed.', details: { briefVersion: 'bv2' } } };
  server.reply(() => ({ status: 409, body: envelope }));
  const result = await call(['draft:submit', '--id', 'd1']);
  server.reply(() => ok({ echo: true }));
  assert.equal(result.code, 1);
  assert.deepEqual(result.json, envelope);
});

test('wraps non-JSON failures and unreachable hosts in the error envelope', async () => {
  server.reply(() => ({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }));
  const gateway = await call(['brands']);
  server.reply(() => ok({ echo: true }));
  assert.equal(gateway.code, 1);
  assert.equal(gateway.json.error.code, 'server_error');
  const offline = await run(['brands'], { env: { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: 'http://127.0.0.1:9' } });
  assert.equal(offline.code, 1);
  assert.equal(offline.json.error.code, 'network_error');
  assert.ok(!offline.stdout.includes(API_KEY));
});

test('redacts sensitive fields and the key itself from output', async () => {
  server.reply(() => ok({ apiKey: 'x', nested: { refreshToken: 'y', note: `leaked ${API_KEY}` } }));
  const result = await call(['brands']);
  server.reply(() => ok({ echo: true }));
  assert.deepEqual(result.json.data, { apiKey: '[redacted]', nested: { refreshToken: '[redacted]', note: 'leaked [redacted]' } });
});

test('--pretty indents output', async () => {
  const result = await call(['brands', '--pretty']);
  assert.equal(result.stdout, `${JSON.stringify({ ok: true, data: { echo: true } }, null, 2)}\n`);
});
