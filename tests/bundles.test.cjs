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

const submitPosts = (bundle, extra) => submit('posts:submit', ['--campaign', 'c1'], bundle, extra);
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
  const { posts, drafts } = skillExamples();
  const checked = await submitPosts(posts, ['--dry-run']);
  assert.equal(checked.code, 0, checked.stdout);
  assert.deepEqual(checked.json.data, { valid: true, dryRun: true, bundle: 'posts', counts: { posts: 1, drafts: 2 } });
  assert.equal(checked.requests.length, 0);
  const posted = await submitDrafts(drafts, ['--dry-run']);
  assert.equal(posted.code, 0, posted.stdout);
  assert.equal(posted.requests.length, 0);
});

test('accepts an empty submission with a no-posts reason', async () => {
  const bundle = { ...clone(skillExamples().posts), posts: [], noPostsReason: 'Nothing new fits the brief.' };
  const result = await submitPosts(bundle);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 1);
});

test('rejects more than five posts', async () => {
  const bundle = clone(skillExamples().posts);
  bundle.posts = Array.from({ length: 6 }, () => clone(bundle.posts[0]));
  assertRejected(await submitPosts(bundle), ['posts']);
});

test('a post needs one to ten drafts, one per account', async () => {
  const bundle = clone(skillExamples().posts);
  bundle.posts.push({ ...clone(bundle.posts[0]), drafts: [] });
  bundle.posts.push(clone(bundle.posts[0]));
  delete bundle.posts[2].drafts;
  bundle.posts[0].drafts[1].socialProfileId = bundle.posts[0].drafts[0].socialProfileId;
  bundle.posts[0].drafts[0].caption = 'a'.repeat(5001);
  assertRejected(await submitPosts(bundle), [
    'posts[0].drafts[0].caption',
    'posts[0].drafts[1].socialProfileId',
    'posts[1].drafts',
    'posts[2].drafts',
  ]);
});

test('a post reviewNote is optional and at most 300 characters', async () => {
  const bundle = clone(skillExamples().posts);
  assert.ok('reviewNote' in bundle.posts[0]);
  delete bundle.posts[0].reviewNote;
  const without = await submitPosts(bundle, ['--dry-run']);
  assert.equal(without.code, 0, without.stdout);
  bundle.posts[0].reviewNote = 'n'.repeat(301);
  assertRejected(await submitPosts(bundle), ['posts[0].reviewNote']);
});

test('a retired ideation-run bundle names posts:submit instead', async () => {
  const bundle = clone(skillExamples().posts);
  bundle.format = 'bichon-ideation-run/v1';
  const result = await submitPosts(bundle);
  assertRejected(result, ['format']);
  const issue = result.json.error.details.issues.find((entry) => entry.path === 'format');
  assert.match(issue.message, /bichon-posts\/v1/);
  assert.match(issue.message, /posts:submit/);
});

test('posts:submit refuses a drafts bundle and drafts:submit refuses a posts bundle', async () => {
  const { posts, drafts } = skillExamples();
  assertRejected(await submitPosts(drafts), ['format']);
  assertRejected(await submitDrafts(posts), ['format']);
});

test('rejects an unknown or retired whyNowCategory and accepts active_discussion', async () => {
  for (const retired of ['dated_event', 'growing_discussion']) {
    const bundle = clone(skillExamples().posts);
    bundle.posts[0].whyNowCategory = retired;
    assertRejected(await submitPosts(bundle), ['posts[0].whyNowCategory']);
  }
  const bundle = clone(skillExamples().posts);
  bundle.posts[0].whyNowCategory = 'active_discussion';
  const result = await submitPosts(bundle, ['--dry-run']);
  assert.equal(result.code, 0, result.stdout);
});

test('evidence cites a signal or a Threads discovery, never both', async () => {
  const bundle = clone(skillExamples().posts);
  assert.ok(bundle.posts[0].evidence.some((entry) => 'discoveryId' in entry));
  bundle.posts[0].evidence[0].discoveryId = 'd1';
  bundle.posts[0].evidence[2] = { discoveryId: 'd2', reason: 'Readers ask this.', excerpt: 'why is it sour' };
  bundle.posts[0].evidence.push({ reason: 'No id at all.' });
  assertRejected(await submitPosts(bundle), [
    'posts[0].evidence[0].discoveryId',
    'posts[0].evidence[2].excerpt',
    'posts[0].evidence[3].signalId',
  ]);
});

test('rejects evidence indexes outside the post evidence', async () => {
  const bundle = clone(skillExamples().posts);
  bundle.posts[0].primaryEvidence = 3;
  bundle.posts[0].claims[1].evidence = 5;
  assertRejected(await submitPosts(bundle), ['posts[0].primaryEvidence', 'posts[0].claims[1].evidence']);
});

test('requires primaryEvidence with evidence and evidence for non-evergreen why-now', async () => {
  const bundle = clone(skillExamples().posts);
  delete bundle.posts[0].primaryEvidence;
  bundle.posts.push({ ...clone(bundle.posts[0]), evidence: [], claims: [], whyNowCategory: 'timely_news' });
  assertRejected(await submitPosts(bundle), ['posts[0].primaryEvidence', 'posts[1].whyNowCategory']);
});

test('rejects bounds, missing fields and unknown fields with their paths', async () => {
  const bundle = clone(skillExamples().posts);
  bundle.format = 'bichon-posts/v2';
  bundle.posts[0].title = 'x'.repeat(201);
  bundle.posts[0].pov.fear = '';
  delete bundle.posts[0].coreMessage;
  bundle.posts[0].score = 9;
  bundle.posts[0].evidence[0].excerpt = 'e'.repeat(401);
  assertRejected(await submitPosts(bundle), [
    'format',
    'posts[0].title',
    'posts[0].pov.fear',
    'posts[0].coreMessage',
    'posts[0].score',
    'posts[0].evidence[0].excerpt',
  ]);
});

test('rejects a caption over 5000 characters and duplicate accounts', async () => {
  const bundle = clone(skillExamples().drafts);
  bundle.drafts.push(clone(bundle.drafts[0]));
  bundle.drafts[0].caption = 'a'.repeat(5001);
  bundle.drafts[1].socialProfileId = bundle.drafts[0].socialProfileId;
  bundle.drafts[1].postType = 'carousel';
  assertRejected(await submitDrafts(bundle), ['drafts[0].caption', 'drafts[1].socialProfileId', 'drafts[1].postType']);
});

test('a draft responseNote is optional and at most 1000 characters', async () => {
  const bundle = clone(skillExamples().drafts);
  assert.ok(bundle.drafts.some((draft) => 'responseNote' in draft));
  bundle.drafts.push({ ...clone(bundle.drafts[0]), socialProfileId: '<threads socialProfileId>' });
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
    const result = await submitPosts(file);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 0);
    assert.equal(result.json.error.code, 'invalid_request');
  }
});

test('schema prints draft 2020-12 schemas for both bundles', async () => {
  const result = await run(['schema']);
  assert.equal(result.code, 0);
  const { posts, drafts } = result.json.data;
  for (const schema of [posts, drafts]) assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(posts.properties.format.const, 'bichon-posts/v1');
  assert.equal(posts.properties.posts.maxItems, 5);
  const post = posts.properties.posts.items.properties;
  assert.ok(posts.properties.posts.items.required.includes('drafts'));
  assert.ok(!posts.properties.posts.items.required.includes('reviewNote'));
  assert.equal(post.reviewNote.maxLength, 300);
  assert.equal(post.drafts.minItems, 1);
  assert.equal(post.drafts.maxItems, 10);
  assert.equal(post.drafts.items.properties.caption.maxLength, 5000);
  assert.deepEqual(post.whyNowCategory.enum, ['timely_news', 'active_discussion', 'competitor_performance', 'evergreen']);
  assert.deepEqual(post.evidence.items.oneOf.map((branch) => branch.required), [['signalId', 'reason'], ['discoveryId', 'reason']]);
  assert.equal(drafts.properties.drafts.items.properties.caption.maxLength, 5000);
  assert.equal(drafts.properties.drafts.items.properties.responseNote.maxLength, 1000);
  assert.ok(!drafts.properties.drafts.items.required.includes('responseNote'));
  const one = await run(['schema', '--bundle', 'drafts']);
  assert.deepEqual(one.json.data, drafts);
  const other = await run(['schema', '--bundle', 'posts']);
  assert.deepEqual(other.json.data, posts);
  const retired = await run(['schema', '--bundle', 'ideation-run']);
  assert.equal(retired.code, 1);
  assert.equal(retired.json.error.code, 'invalid_request');
});
