const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillExamples } = require('./support.cjs');

let server;
let dir;
const clone = (value) => JSON.parse(JSON.stringify(value));

before(async () => {
  server = await startServer(() => ({ status: 200, body: { ok: true, data: { runId: 'r1', accepted: [], rejected: [] } } }));
  dir = tempDir();
});
after(() => server.close());

async function submit(command, target, bundle, extra = []) {
  const file = typeof bundle === 'string' ? bundle : writeJson(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), bundle);
  const count = server.requests.length;
  const result = await run([command, ...target, '--file', file, ...extra], {
    env: { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: server.url },
  });
  return { ...result, requests: server.requests.slice(count) };
}

const submitRun = (bundle, extra) => submit('ideas:submit', ['--campaign', 'c1'], bundle, extra);
const submitDrafts = (bundle, extra) => submit('drafts:submit', ['--idea', 'i1'], bundle, extra);

function assertRejected(result, paths) {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(result.json.error.code, 'validation_failed');
  assert.equal(result.json.error.details.source, 'client');
  const reported = result.json.error.details.issues.map((issue) => issue.path);
  for (const expected of paths) assert.ok(reported.includes(expected), `${expected} not in ${reported.join(', ')}`);
}

test('the SKILL.md examples are valid bundles', async () => {
  const { ideationRun, drafts } = skillExamples();
  const ideas = await submitRun(ideationRun, ['--dry-run']);
  assert.equal(ideas.code, 0, ideas.stdout);
  assert.deepEqual(ideas.json.data, { valid: true, dryRun: true, bundle: 'ideation-run', counts: { ideas: 1 } });
  assert.equal(ideas.requests.length, 0);
  const posted = await submitDrafts(drafts, ['--dry-run']);
  assert.equal(posted.code, 0, posted.stdout);
  assert.equal(posted.requests.length, 0);
});

test('accepts an empty run with a no-ideas reason', async () => {
  const bundle = { ...clone(skillExamples().ideationRun), ideas: [], noIdeasReason: 'Nothing new fits the brief.' };
  const result = await submitRun(bundle);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 1);
});

test('rejects more than five ideas', async () => {
  const bundle = clone(skillExamples().ideationRun);
  bundle.ideas = Array.from({ length: 6 }, () => clone(bundle.ideas[0]));
  assertRejected(await submitRun(bundle), ['ideas']);
});

test('rejects an unknown or retired whyNowCategory and accepts active_discussion', async () => {
  for (const retired of ['dated_event', 'growing_discussion']) {
    const bundle = clone(skillExamples().ideationRun);
    bundle.ideas[0].whyNowCategory = retired;
    assertRejected(await submitRun(bundle), ['ideas[0].whyNowCategory']);
  }
  const bundle = clone(skillExamples().ideationRun);
  bundle.ideas[0].whyNowCategory = 'active_discussion';
  const result = await submitRun(bundle, ['--dry-run']);
  assert.equal(result.code, 0, result.stdout);
});

test('evidence cites a signal or a Threads discovery, never both', async () => {
  const bundle = clone(skillExamples().ideationRun);
  assert.ok(bundle.ideas[0].evidence.some((entry) => 'discoveryId' in entry));
  bundle.ideas[0].evidence[0].discoveryId = 'd1';
  bundle.ideas[0].evidence[2] = { discoveryId: 'd2', reason: 'Readers ask this.', excerpt: 'why is it sour' };
  bundle.ideas[0].evidence.push({ reason: 'No id at all.' });
  assertRejected(await submitRun(bundle), [
    'ideas[0].evidence[0].discoveryId',
    'ideas[0].evidence[2].excerpt',
    'ideas[0].evidence[3].signalId',
  ]);
});

test('rejects evidence indexes outside the idea evidence', async () => {
  const bundle = clone(skillExamples().ideationRun);
  bundle.ideas[0].primaryEvidence = 3;
  bundle.ideas[0].claims[1].evidence = 5;
  assertRejected(await submitRun(bundle), ['ideas[0].primaryEvidence', 'ideas[0].claims[1].evidence']);
});

test('requires primaryEvidence with evidence and evidence for non-evergreen why-now', async () => {
  const bundle = clone(skillExamples().ideationRun);
  delete bundle.ideas[0].primaryEvidence;
  bundle.ideas.push({ ...clone(bundle.ideas[0]), evidence: [], claims: [], whyNowCategory: 'timely_news' });
  assertRejected(await submitRun(bundle), ['ideas[0].primaryEvidence', 'ideas[1].whyNowCategory']);
});

test('rejects bounds, missing fields and unknown fields with their paths', async () => {
  const bundle = clone(skillExamples().ideationRun);
  bundle.format = 'bichon-ideation-run/v2';
  bundle.ideas[0].title = 'x'.repeat(201);
  bundle.ideas[0].pov.fear = '';
  delete bundle.ideas[0].coreMessage;
  bundle.ideas[0].score = 9;
  bundle.ideas[0].evidence[0].excerpt = 'e'.repeat(401);
  assertRejected(await submitRun(bundle), [
    'format',
    'ideas[0].title',
    'ideas[0].pov.fear',
    'ideas[0].coreMessage',
    'ideas[0].score',
    'ideas[0].evidence[0].excerpt',
  ]);
});

test('rejects a caption over 5000 characters and duplicate accounts', async () => {
  const bundle = clone(skillExamples().drafts);
  bundle.drafts[0].caption = 'a'.repeat(5001);
  bundle.drafts[1].socialProfileId = bundle.drafts[0].socialProfileId;
  bundle.drafts[1].postType = 'carousel';
  assertRejected(await submitDrafts(bundle), ['drafts[0].caption', 'drafts[1].socialProfileId', 'drafts[1].postType']);
});

test('a draft responseNote is optional and at most 1000 characters', async () => {
  const bundle = clone(skillExamples().drafts);
  assert.ok(bundle.drafts.some((draft) => 'responseNote' in draft));
  bundle.drafts[0].responseNote = 'n'.repeat(1000);
  const fits = await submitDrafts(bundle);
  assert.equal(fits.code, 0, fits.stdout);
  assert.equal(fits.requests[0].body.drafts[0].responseNote, 'n'.repeat(1000));
  bundle.drafts[0].responseNote = 'n'.repeat(1001);
  bundle.drafts[1].responseNote = 42;
  assertRejected(await submitDrafts(bundle), ['drafts[0].responseNote', 'drafts[1].responseNote']);
});

test('rejects unreadable or malformed bundle files as invalid requests', async () => {
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "format": ');
  for (const file of [broken, path.join(dir, 'missing.json')]) {
    const result = await submitRun(file);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 0);
    assert.equal(result.json.error.code, 'invalid_request');
  }
});

test('schema prints draft 2020-12 schemas for both bundles', async () => {
  const result = await run(['schema']);
  assert.equal(result.code, 0);
  const { ideationRun, drafts } = result.json.data;
  for (const schema of [ideationRun, drafts]) assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(ideationRun.properties.ideas.maxItems, 5);
  const idea = ideationRun.properties.ideas.items.properties;
  assert.deepEqual(idea.whyNowCategory.enum, ['timely_news', 'active_discussion', 'competitor_performance', 'evergreen']);
  assert.deepEqual(idea.evidence.items.oneOf.map((branch) => branch.required), [['signalId', 'reason'], ['discoveryId', 'reason']]);
  assert.equal(drafts.properties.drafts.items.properties.caption.maxLength, 5000);
  assert.equal(drafts.properties.drafts.items.properties.responseNote.maxLength, 1000);
  assert.ok(!drafts.properties.drafts.items.required.includes('responseNote'));
  const one = await run(['schema', '--bundle', 'drafts']);
  assert.deepEqual(one.json.data, drafts);
});
