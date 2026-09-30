const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillExamples } = require('./support.cjs');

let server;
let dir;
let env;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ok = (data) => ({ status: 200, body: { ok: true, data } });

before(async () => {
  server = await startServer(() => ok({ campaignId: 'c9', warnings: [] }));
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
const create = (setup, extra = []) => call(['campaigns:create', '--brand', 'b1', '--file', file(setup), ...extra]);
const update = (setup, extra = []) => call(['campaigns:update', '--campaign', 'c1', '--file', file(setup), ...extra]);
const setPersonas = (body, extra = []) => call(['personas:set', '--brand', 'b1', '--file', file(body), ...extra]);

function assertRejected(result, paths) {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(result.json.error.code, 'validation_failed');
  assert.equal(result.json.error.details.source, 'client');
  const reported = result.json.error.details.issues.map((issue) => issue.path);
  for (const expected of paths) assert.ok(reported.includes(expected), `${expected} not in ${reported.join(', ')}`);
}

test('maps the intake read commands to their routes', async () => {
  const cases = [
    [['brand:context', '--brand', 'b1'], '/agent/v1/brands/b1/context', {}],
    [['personas:draft', '--brand', 'b1'], '/agent/v1/brands/b1/personas/draft', {}],
    [['personas:draft', '--brand', 'b1', '--profile', 'sp1'], '/agent/v1/brands/b1/personas/draft', { socialProfileId: 'sp1' }],
    [['threads', '--campaign', 'c1'], '/agent/v1/campaigns/c1/threads', {}],
  ];
  for (const [args, pathname, query] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(result.requests.length, 1, args.join(' '));
    assert.equal(result.requests[0].method, 'GET', args.join(' '));
    assert.equal(result.requests[0].path, pathname, args.join(' '));
    assert.deepEqual(result.requests[0].query, query, args.join(' '));
  }
});

test('threads prints keywords, analyzed posts and the pending count unchanged', async () => {
  const threads = {
    keywords: [{ sourceId: 'src1', keyword: 'pour over', rationale: 'The core question.', status: 'active' }],
    items: [{ signalId: 's1', versionId: 'v1', discoveryId: null, kind: 'threads_post', summary: 'A home brewer asks why the cup is sour.' }],
    pendingCount: 3,
  };
  server.reply(() => ok(threads));
  const result = await call(['threads', '--campaign', 'c1']);
  server.reply(() => ok({ campaignId: 'c9', warnings: [] }));
  assert.equal(result.code, 0);
  assert.deepEqual(result.json, { ok: true, data: threads });
  assert.deepEqual(Object.keys(result.json.data).sort(), ['items', 'keywords', 'pendingCount']);
});

test('sends setup and personas files with their methods and routes', async () => {
  const { setup, personas } = skillExamples();
  const created = await create(setup);
  assert.equal(created.code, 0, created.stdout);
  assert.equal(created.requests[0].method, 'POST');
  assert.equal(created.requests[0].path, '/agent/v1/brands/b1/campaigns');
  assert.deepEqual(created.requests[0].body, setup);
  assert.deepEqual(created.json, { ok: true, data: { campaignId: 'c9', warnings: [] } });

  const updated = await update({ goal: 'More saves.' });
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(updated.requests[0].method, 'PATCH');
  assert.equal(updated.requests[0].path, '/agent/v1/campaigns/c1');
  assert.deepEqual(updated.requests[0].body, { goal: 'More saves.' });

  const saved = await setPersonas(personas);
  assert.equal(saved.code, 0, saved.stdout);
  assert.equal(saved.requests[0].method, 'PUT');
  assert.equal(saved.requests[0].path, '/agent/v1/brands/b1/personas');
  assert.deepEqual(saved.requests[0].body, personas);
});

test('analysis:request posts without a body to the account analysis route', async () => {
  const status = { socialProfileId: 'sp1', status: 'insufficient_data', note: 'Only 3 posts in the last 90 days.' };
  server.reply(() => ok(status));
  const result = await call(['analysis:request', '--brand', 'b1', '--profile', 'sp1']);
  server.reply(() => ok({ campaignId: 'c9', warnings: [] }));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].method, 'POST');
  assert.equal(result.requests[0].path, '/agent/v1/brands/b1/accounts/sp1/analysis');
  assert.equal(result.requests[0].body, undefined);
  assert.deepEqual(result.json.data, status);
  for (const args of [['analysis:request', '--brand', 'b1'], ['analysis:request', '--profile', 'sp1'], ['playbook:request', '--brand', 'b1', '--profile', 'sp1']]) {
    const refused = await call(args);
    assert.equal(refused.code, 1, args.join(' '));
    assert.equal(refused.requests.length, 0, args.join(' '));
    assert.equal(refused.json.error.code, 'invalid_request', args.join(' '));
  }
});

test('--impact-key is added to the update body', async () => {
  const result = await update({ contentLanguage: 'zh-TW' }, ['--impact-key', 'impact_abc']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.requests[0].body, { contentLanguage: 'zh-TW', impactKey: 'impact_abc' });
});

test('impact_confirmation is printed unchanged with exit code 1', async () => {
  const envelope = {
    ok: false,
    error: {
      code: 'impact_confirmation',
      message: 'This change affects existing work.',
      details: { impactKey: 'impact_abc', impact: ['3 proposed ideas will be re-checked', '2 drafts change language'] },
    },
  };
  server.reply(() => ({ status: 409, body: envelope }));
  const result = await update({ contentLanguage: 'zh-TW' });
  server.reply(() => ok({ campaignId: 'c9', warnings: [] }));
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.json, envelope);
});

test('the SKILL.md setup and personas examples are valid', async () => {
  const { setup, personas } = skillExamples();
  const created = await create(setup, ['--dry-run']);
  assert.equal(created.code, 0, created.stdout);
  assert.equal(created.requests.length, 0);
  assert.deepEqual(created.json.data, { valid: true, dryRun: true, bundle: 'setup', counts: { fields: Object.keys(setup).length, personas: 1, keywords: 3 } });
  const saved = await setPersonas(personas, ['--dry-run']);
  assert.equal(saved.code, 0, saved.stdout);
  assert.equal(saved.requests.length, 0);
  assert.deepEqual(saved.json.data.counts, { personas: 1 });
});

test('create requires name, brief, contentLanguage and targets', async () => {
  const setup = clone(skillExamples().setup);
  delete setup.name;
  delete setup.targetProfileIds;
  assertRejected(await create(setup), ['name', 'targetProfileIds']);
  assertRejected(await create({ ...clone(skillExamples().setup), targetProfileIds: [] }), ['targetProfileIds']);
});

test('update accepts any subset but not an empty file', async () => {
  const partial = await update({ keywords: ['latte art'] }, ['--dry-run']);
  assert.equal(partial.code, 0, partial.stdout);
  assert.equal(partial.requests.length, 0);
  assertRejected(await update({}), ['(root)']);
});

test('rejects unknown fields, bounds and bad values in a setup', async () => {
  const setup = clone(skillExamples().setup);
  setup.budget = 500;
  setup.impactKey = 'k';
  setup.contentLanguage = 'Traditional Chinese';
  setup.keywords = Array.from({ length: 21 }, (_, index) => `kw${index}`);
  setup.personas = Array.from({ length: 6 }, () => clone(setup.personas[0]));
  setup.requirements.allowedFormats = ['image', 'story'];
  setup.requirements.content[0].sourceExcerpt = 'x'.repeat(501);
  setup.sources.rssUrls = ['feed.example.com/rss'];
  setup.sources.competitorUsernames[0].provider = 'tiktok';
  assertRejected(await create(setup), [
    'budget',
    'impactKey',
    'contentLanguage',
    'keywords',
    'personas',
    'requirements.allowedFormats[1]',
    'requirements.content[0].sourceExcerpt',
    'sources.rssUrls[0]',
    'sources.competitorUsernames[0].provider',
  ]);
});

test('rejects duplicate targets, long keywords and a patch with a bad field', async () => {
  const setup = clone(skillExamples().setup);
  setup.targetProfileIds = ['sp1', 'sp1'];
  setup.keywords = ['k'.repeat(61)];
  assertRejected(await create(setup), ['targetProfileIds', 'keywords[0]']);
  assertRejected(await update({ goal: 'g'.repeat(301), color: 'red' }), ['goal', 'color']);
});

test('validates the personas file', async () => {
  const base = clone(skillExamples().personas.personas[0]);
  assertRejected(await setPersonas({ personas: Array.from({ length: 6 }, () => clone(base)) }), ['personas']);
  assertRejected(await setPersonas({ personas: [] }), ['personas']);
  const bad = clone(base);
  bad.name = 'n'.repeat(81);
  bad.who = 'w'.repeat(301);
  bad.fears = Array.from({ length: 9 }, () => 'fear');
  bad.words = ['w'.repeat(121)];
  bad.mood = 'tired';
  delete bad.avoid;
  assertRejected(await setPersonas({ personas: [bad], brand: 'b1' }), [
    'personas[0].name',
    'personas[0].who',
    'personas[0].fears',
    'personas[0].words[0]',
    'personas[0].mood',
    'personas[0].avoid',
    'brand',
  ]);
});

test('rejects missing intake options before any request', async () => {
  const setupFile = file(skillExamples().setup);
  const invalid = [
    ['brand:context'],
    ['personas:draft'],
    ['personas:set', '--brand', 'b1'],
    ['campaigns:create', '--file', setupFile],
    ['campaigns:update', '--file', setupFile],
    ['threads'],
    ['schema', '--bundle', 'intake'],
  ];
  for (const args of invalid) {
    const result = await call(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.requests.length, 0, args.join(' '));
    assert.equal(result.json.error.code, 'invalid_request', args.join(' '));
  }
});

test('schema prints the setup and personas schemas', async () => {
  const all = await run(['schema']);
  assert.equal(all.code, 0);
  const { setup, personas } = all.json.data;
  for (const schema of [setup, personas]) assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(setup.required, ['name', 'brief', 'contentLanguage', 'targetProfileIds']);
  assert.equal(setup.additionalProperties, false);
  assert.equal(setup.properties.keywords.maxItems, 20);
  assert.equal(setup.properties.keywords.items.maxLength, 60);
  assert.equal(setup.properties.requirements.properties.content.maxItems, 20);
  assert.equal(personas.properties.personas.maxItems, 5);
  const persona = personas.properties.personas.items;
  assert.equal(persona.properties.name.maxLength, 80);
  assert.equal(persona.properties.fears.maxItems, 8);
  assert.equal(persona.properties.fears.items.maxLength, 120);
  const one = await run(['schema', '--bundle', 'setup']);
  assert.deepEqual(one.json.data, setup);
  const other = await run(['schema', '--bundle', 'personas']);
  assert.deepEqual(other.json.data, personas);
});
