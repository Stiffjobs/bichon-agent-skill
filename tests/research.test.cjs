const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillBlocks, skillExamples } = require('./support.cjs');

let server;
let dir;
let env;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ok = (data) => ({ status: 200, body: { ok: true, data } });
const stored = ok({ stored: 3, rejected: [], remaining: 0 });

before(async () => {
  server = await startServer(() => stored);
  dir = tempDir();
  env = { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: server.url };
});
after(() => server.close());

async function call(args, cwd) {
  const count = server.requests.length;
  const result = await run(args, { env, cwd });
  return { ...result, requests: server.requests.slice(count) };
}

const file = (value) => writeJson(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), value);
const submit = (bundle, extra = []) => call(['research:submit', '--campaign', 'c1', '--file', file(bundle), ...extra]);

function assertRejected(result, paths) {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(result.json.error.code, 'validation_failed');
  assert.equal(result.json.error.details.source, 'client');
  const reported = result.json.error.details.issues.map((issue) => issue.path);
  for (const expected of paths) assert.ok(reported.includes(expected), `${expected} not in ${reported.join(', ')}`);
}

test('maps the research commands to their routes, queries and bodies', async () => {
  const cases = [
    [['research:collect', '--campaign', 'c1'], 'POST', '/agent/v1/campaigns/c1/research/collect', {}, { kinds: ['rss', 'competitors', 'threads'] }],
    [['research:collect', '--campaign', 'c1', '--kinds', 'threads, rss,threads'], 'POST', '/agent/v1/campaigns/c1/research/collect', {}, { kinds: ['threads', 'rss'] }],
    [['research:runs', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/research/runs', {}, undefined],
    [['research:pending', '--campaign', 'c1'], 'GET', '/agent/v1/campaigns/c1/research/pending', {}, undefined],
    [['research:pending', '--campaign', 'c1', '--limit', '25', '--kind', 'threads_post'], 'GET', '/agent/v1/campaigns/c1/research/pending', { limit: '25', kind: 'threads_post' }, undefined],
    [['research:sources', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/research/sources', {}, undefined],
    [['evidence', '--campaign', 'c1', '--kind', 'competitor_post'], 'GET', '/agent/v1/campaigns/c1/evidence', { kind: 'competitor_post' }, undefined],
  ];
  for (const [args, method, pathname, query, body] of cases) {
    const result = await call(args);
    const label = args.join(' ');
    assert.equal(result.code, 0, label);
    assert.equal(result.requests.length, 1, label);
    assert.equal(result.requests[0].method, method, label);
    assert.equal(result.requests[0].path, pathname, label);
    assert.deepEqual(result.requests[0].query, query, label);
    assert.deepEqual(result.requests[0].body, body, label);
  }
});

test('research:pending --out writes the batch and prints the lease and counts only', async () => {
  const batch = {
    leaseId: 'lease_1',
    leaseUntil: 1790000000000,
    remaining: 40,
    items: [
      { itemRef: 'v1', kind: 'article', text: 'Full article text.', engagement: null },
      { itemRef: 'v2', kind: 'competitor_post', text: 'Post text.', engagement: { likes: 900 } },
      { itemRef: 'd1', kind: 'threads_post', text: 'Thread text.', engagement: { likes: 12 } },
      { itemRef: 'd2', kind: 'threads_post', text: 'Another thread.', engagement: null },
    ],
  };
  server.reply(() => ok(batch));
  const cwd = tempDir();
  const result = await call(['research:pending', '--campaign', 'c1', '--out', 'work/batch-1.json'], cwd);
  server.reply(() => stored);
  assert.equal(result.code, 0, result.stdout);
  const written = path.join(cwd, 'work/batch-1.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf8')), batch);
  const { bytes, ...summary } = result.json.data;
  assert.ok(bytes > 0);
  assert.deepEqual(summary, {
    written,
    leaseId: 'lease_1',
    leaseUntil: 1790000000000,
    remaining: 40,
    items: 4,
    kinds: { article: 1, competitor_post: 1, threads_post: 2 },
  });
  assert.ok(!result.stdout.includes('Full article text.'));
});

test('context --out reports the research counts', async () => {
  server.reply(() => ok({ versions: { briefVersion: 'bv1' }, research: { analyzed: 12, pending: 30, useful: 5 } }));
  const result = await call(['context', '--campaign', 'c1', '--out', 'context.json'], tempDir());
  server.reply(() => stored);
  assert.deepEqual(result.json.data.research, { analyzed: 12, pending: 30, useful: 5 });
});

test('the SKILL.md ResearchAnalysisBundle example is valid and posted verbatim', async () => {
  const { research } = skillExamples();
  const dry = await submit(research, ['--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal(dry.requests.length, 0);
  assert.deepEqual(dry.json.data, { valid: true, dryRun: true, bundle: 'research', counts: { items: 3 } });
  const posted = await submit(research);
  assert.equal(posted.code, 0, posted.stdout);
  assert.equal(posted.requests[0].method, 'POST');
  assert.equal(posted.requests[0].path, '/agent/v1/campaigns/c1/research/analyses');
  assert.deepEqual(posted.requests[0].body, research);
  assert.deepEqual(posted.json.data, { stored: 3, rejected: [], remaining: 0 });
});

test('the analyst brief asks for the bundle, a dry run and untrusted-data handling', () => {
  const [brief] = skillBlocks('text').filter((block) => block.includes('research analyst'));
  assert.ok(brief, 'analyst brief template missing');
  for (const needle of ['bichon-research-analyses/v1', 'research:submit', '--dry-run', '{{BATCH_FILE}}', '{{OUTPUT_FILE}}', '{{CAMPAIGN_BRIEF}}', '{{PERSONAS_SUMMARY}}', 'untrusted', 'authorBaseline', 'No trend claims']) {
    assert.ok(brief.includes(needle), `brief lacks ${needle}`);
  }
});

test('rejects bounds, bad enums, unknown fields and missing fields with their paths', async () => {
  const bundle = clone(skillExamples().research);
  delete bundle.leaseId;
  bundle.submissionId = 'x';
  const [article, competitor, thread] = bundle.items;
  article.summary = 's'.repeat(401);
  article.facts = Array.from({ length: 7 }, () => 'fact');
  article.quality = 'great';
  article.score = 4;
  competitor.themes = ['a', 'b', 'c', 'd'];
  competitor.relevance = 'maybe';
  delete thread.whyItMatters;
  thread.angle = 'a'.repeat(301);
  assertRejected(await submit(bundle), [
    'leaseId',
    'submissionId',
    'items[0].summary',
    'items[0].facts',
    'items[0].quality',
    'items[0].score',
    'items[1].themes',
    'items[1].relevance',
    'items[2].whyItMatters',
    'items[2].angle',
  ]);
});

test('rejects numbers in an engagement read, duplicate items and batch sizes outside 1..25', async () => {
  const bundle = clone(skillExamples().research);
  bundle.items[1].engagementRead = '3x the usual likes';
  bundle.items[2].itemRef = bundle.items[0].itemRef;
  assertRejected(await submit(bundle), ['items[1].engagementRead', 'items[2].itemRef']);
  assertRejected(await submit({ ...clone(skillExamples().research), items: [] }), ['items']);
  const item = skillExamples().research.items[0];
  const many = Array.from({ length: 26 }, (_, index) => ({ ...item, itemRef: `v${index}` }));
  assertRejected(await submit({ ...clone(skillExamples().research), items: many }), ['items']);
});

test('rejects bad research options before any request', async () => {
  const invalid = [
    ['research:collect'],
    ['research:collect', '--campaign', 'c1', '--kinds', 'rss,tiktok'],
    ['research:collect', '--campaign', 'c1', '--kinds', ','],
    ['research:runs'],
    ['research:pending', '--campaign', 'c1', '--limit', '26'],
    ['research:pending', '--campaign', 'c1', '--kind', 'rss'],
    ['research:pending', '--campaign', 'c1', '--out'],
    ['research:submit', '--campaign', 'c1'],
    ['research:sources'],
    ['evidence', '--campaign', 'c1', '--kind', 'post'],
  ];
  for (const args of invalid) {
    const result = await call(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.requests.length, 0, args.join(' '));
    assert.equal(result.json.error.code, 'invalid_request', args.join(' '));
  }
});

test('passes per-item not_leased rejections through', async () => {
  const data = { stored: 2, rejected: [{ itemRef: 'v9', code: 'not_leased', reason: 'The lease expired.' }], remaining: 7 };
  server.reply(() => ok(data));
  const result = await submit(skillExamples().research);
  server.reply(() => stored);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.data, data);
});

test('schema --bundle research prints the ResearchAnalysisBundle schema', async () => {
  const one = await run(['schema', '--bundle', 'research']);
  assert.equal(one.code, 0);
  const schema = one.json.data;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.title, 'ResearchAnalysisBundle');
  assert.deepEqual(schema.required, ['format', 'agent', 'leaseId', 'items']);
  const item = schema.properties.items.items;
  assert.equal(schema.properties.items.maxItems, 25);
  assert.equal(item.additionalProperties, false);
  assert.equal(item.properties.summary.maxLength, 400);
  assert.equal(item.properties.facts.maxItems, 6);
  assert.equal(item.properties.facts.items.maxLength, 300);
  assert.equal(item.properties.engagementRead.maxLength, 200);
  assert.equal(item.properties.themes.maxItems, 3);
  assert.deepEqual(item.properties.quality.enum, ['useful', 'thin', 'promo', 'off_topic']);
  const all = await run(['schema']);
  assert.deepEqual(all.json.data.research, schema);
});
