const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson, skillBlocks } = require('./support.cjs');

let server;
let dir;
let env;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ok = (data) => ({ status: 200, body: { ok: true, data } });
const echo = () => ok({ echo: true });

before(async () => {
  server = await startServer(echo);
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

function adExamples() {
  const blocks = skillBlocks('json').map((block) => JSON.parse(block));
  return {
    campaign: blocks.find((block) => 'objective' in block),
    adset: blocks.find((block) => 'campaign_id' in block),
    creative: blocks.find((block) => 'object_story_spec' in block),
    ad: blocks.find((block) => 'adset_id' in block),
  };
}

function assertRejected(result, paths) {
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(result.json.error.code, 'validation_failed');
  assert.equal(result.json.error.details.source, 'client');
  const reported = result.json.error.details.issues.map((issue) => issue.path);
  for (const expected of paths) assert.ok(reported.includes(expected), `${expected} not in ${reported.join(', ')}`);
  return result.json.error.details.issues;
}

test('maps the ads read commands to their routes and queries', async () => {
  const cases = [
    [['ads:account', '--brand', 'b1'], '/agent/v1/brands/b1/ads/account', {}],
    [['ads:insights', '--brand', 'b1'], '/agent/v1/brands/b1/ads/insights', {}],
    [
      ['ads:insights', '--brand', 'b1', '--level', 'ad', '--range', 'last_7d', '--daily', '--breakdown', 'age', '--campaign', '120210000000000001', '--adset', '120210000000000002', '--ad', '120210000000000004', '--limit', '500'],
      '/agent/v1/brands/b1/ads/insights',
      { level: 'ad', range: 'last_7d', daily: '1', breakdown: 'age', campaignId: '120210000000000001', adsetId: '120210000000000002', adId: '120210000000000004', limit: '500' },
    ],
    [
      ['ads:insights', '--brand', 'b1', '--daily', '--level', 'account', '--since', '2026-09-01', '--until', '2026-09-30'],
      '/agent/v1/brands/b1/ads/insights',
      { level: 'account', since: '2026-09-01', until: '2026-09-30', daily: '1' },
    ],
    [['ads:list', '--brand', 'b1', '--kind', 'campaigns'], '/agent/v1/brands/b1/ads/campaigns', {}],
    [['ads:list', '--brand', 'b1', '--kind', 'adsets', '--campaign', '1', '--limit', '200'], '/agent/v1/brands/b1/ads/adsets', { campaignId: '1', limit: '200' }],
    [['ads:list', '--brand', 'b1', '--kind', 'ads', '--campaign', '1', '--adset', '2'], '/agent/v1/brands/b1/ads/ads', { campaignId: '1', adsetId: '2' }],
    [['ads:list', '--brand', 'b1', '--kind', 'creatives'], '/agent/v1/brands/b1/ads/creatives', {}],
    [['ads:media', '--brand', 'b1'], '/agent/v1/brands/b1/ads/media', {}],
    [['ads:media', '--brand', 'b1', '--kind', 'video', '--limit', '20'], '/agent/v1/brands/b1/ads/media', { kind: 'video', limit: '20' }],
    [['ads:targeting', '--brand', 'b1', '--type', 'interest', '--q', 'pour over & coffee'], '/agent/v1/brands/b1/ads/targeting', { type: 'interest', q: 'pour over & coffee' }],
  ];
  for (const [args, pathname, query] of cases) {
    const result = await call(args);
    const label = args.join(' ');
    assert.equal(result.code, 0, `${label}: ${result.stdout}`);
    assert.equal(result.requests.length, 1, label);
    assert.equal(result.requests[0].method, 'GET', label);
    assert.equal(result.requests[0].path, pathname, label);
    assert.deepEqual(result.requests[0].query, query, label);
  }
});

test('rejects bad ads options before any request', async () => {
  const invalid = [
    ['ads:account'],
    ['ads:insights', '--brand', 'b1', '--range', 'last_28d', '--since', '2026-09-01', '--until', '2026-09-30'],
    ['ads:insights', '--brand', 'b1', '--range', 'last_28d', '--until', '2026-09-30'],
    ['ads:insights', '--brand', 'b1', '--since', '2026-09-01'],
    ['ads:insights', '--brand', 'b1', '--until', '2026-09-30'],
    ['ads:insights', '--brand', 'b1', '--since', '2026-09-30', '--until', '2026-09-01'],
    ['ads:insights', '--brand', 'b1', '--since', '2026/09/01', '--until', '2026-09-30'],
    ['ads:insights', '--brand', 'b1', '--range', 'last_60d'],
    ['ads:insights', '--brand', 'b1', '--level', 'account_group'],
    ['ads:insights', '--brand', 'b1', '--breakdown', 'region'],
    ['ads:insights', '--brand', 'b1', '--daily=yes'],
    ['ads:insights', '--brand', 'b1', '--limit', '501'],
    ['ads:insights', '--brand', 'b1', '--campaign', 'act_123'],
    ['ads:insights', '--brand', 'b1', '--adset', '12a'],
    ['ads:insights', '--brand', 'b1', '--ad', '1'.repeat(33)],
    ['ads:list', '--brand', 'b1'],
    ['ads:list', '--brand', 'b1', '--kind', 'campaign'],
    ['ads:list', '--brand', 'b1', '--kind', 'pixels'],
    ['ads:list', '--brand', 'b1', '--kind', 'campaigns', '--campaign', '1'],
    ['ads:list', '--brand', 'b1', '--kind', 'adsets', '--adset', '1'],
    ['ads:list', '--brand', 'b1', '--kind', 'ads', '--limit', '201'],
    ['ads:media', '--brand', 'b1', '--kind', 'gif'],
    ['ads:targeting', '--brand', 'b1', '--q', 'coffee'],
    ['ads:targeting', '--brand', 'b1', '--type', 'behavior', '--q', 'coffee'],
    ['ads:targeting', '--brand', 'b1', '--type', 'geo'],
    ['ads:targeting', '--brand', 'b1', '--type', 'geo', '--q', 'q'.repeat(101)],
    ['ads:create', '--brand', 'b1', '--file', 'x.json'],
    ['ads:create', '--brand', 'b1', '--kind', 'campaigns', '--file', 'x.json'],
    ['ads:update', '--brand', 'b1', '--kind', 'creative', '--id', '1', '--file', 'x.json'],
    ['ads:update', '--brand', 'b1', '--kind', 'ad', '--file', 'x.json'],
    ['ads:update', '--brand', 'b1', '--kind', 'ad', '--id', 'abc', '--file', 'x.json'],
    ['ads:media:add', '--brand', 'b1'],
  ];
  for (const args of invalid) {
    const result = await call(args);
    const label = args.join(' ');
    assert.equal(result.code, 1, label);
    assert.equal(result.requests.length, 0, label);
    assert.equal(result.json.error.code, 'invalid_request', `${label}: ${result.stdout}`);
  }
});

test('the SKILL.md ads examples are valid params', async () => {
  const examples = adExamples();
  for (const kind of ['campaign', 'adset', 'creative', 'ad']) {
    assert.ok(examples[kind], `no ${kind} example`);
    const result = await call(['ads:create', '--brand', 'b1', '--kind', kind, '--file', file(examples[kind]), '--dry-run']);
    assert.equal(result.code, 0, `${kind}: ${result.stdout}`);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(result.json.data, { valid: true, dryRun: true, bundle: `ad-${kind}`, counts: { fields: Object.keys(examples[kind]).length } });
  }
});

test('ads:create posts the params verbatim to the kind route', async () => {
  const examples = adExamples();
  const routes = { campaign: 'campaigns', adset: 'adsets', creative: 'creatives', ad: 'ads' };
  server.reply(() => ({ status: 201, body: { ok: true, data: { id: '120210000000000009', kind: 'campaign', status: 'PAUSED' } } }));
  try {
    for (const [kind, segment] of Object.entries(routes)) {
      const result = await call(['ads:create', '--brand', 'b1', '--kind', kind, '--file', file(examples[kind])]);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0].method, 'POST');
      assert.equal(result.requests[0].path, `/agent/v1/brands/b1/ads/${segment}`);
      assert.equal(result.requests[0].headers['content-type'], 'application/json');
      assert.deepEqual(result.requests[0].body, examples[kind]);
    }
  } finally {
    server.reply(echo);
  }
});

test('ads:create rejects unknown fields, missing required fields, activation and bad money', async () => {
  const create = (kind, params) => call(['ads:create', '--brand', 'b1', '--kind', kind, '--file', file(params)]);
  const { campaign, adset, creative, ad } = adExamples();

  const issues = assertRejected(
    await create('campaign', { ...clone(campaign), status: 'ACTIVE', daily_budget: 20.5, lifetime_budget: '2000', spend_cap: 0, effective_status: 'ACTIVE' }),
    ['status', 'daily_budget', 'lifetime_budget', 'spend_cap', 'effective_status'],
  );
  assert.match(issues.find((issue) => issue.path === 'status').message, /PAUSED/);
  assert.match(issues.find((issue) => issue.path === 'effective_status').message, /not an allowed field/);

  const missing = clone(adset);
  delete missing.targeting;
  delete missing.optimization_goal;
  missing.campaign_id = 120210000000000001;
  missing.bid_amount = -5;
  assertRejected(await create('adset', missing), ['targeting', 'optimization_goal', 'campaign_id', 'bid_amount']);

  const sourceless = clone(creative);
  delete sourceless.object_story_spec;
  sourceless.status = 'PAUSED';
  assertRejected(await create('creative', sourceless), ['(root)', 'status']);

  assertRejected(await create('ad', { ...clone(ad), creative: { creative_id: 'abc' } }), ['creative.creative_id']);
  assertRejected(await create('ad', { name: 'x' }), ['adset_id', 'creative']);
  assertRejected(await create('campaign', [campaign]), ['(root)']);
  assertRejected(await create('campaign', { ...clone(campaign), objective: 'CONVERSIONS' }), ['objective']);

  const paused = await create('campaign', { ...clone(campaign), status: 'PAUSED', daily_budget: 2000 });
  assert.equal(paused.code, 0, paused.stdout);
});

test('ads:update patches the entity route and refuses fields fixed at creation', async () => {
  const patch = { creative: { creative_id: '120210000000000010' } };
  server.reply(() => ok({ id: '120210000000000004', kind: 'ad', updated: ['creative'] }));
  try {
    const result = await call(['ads:update', '--brand', 'b1', '--kind', 'ad', '--id', '120210000000000004', '--file', file(patch)]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].method, 'PATCH');
    assert.equal(result.requests[0].path, '/agent/v1/brands/b1/ads/ads/120210000000000004');
    assert.deepEqual(result.requests[0].body, patch);
    assert.deepEqual(result.json.data, { id: '120210000000000004', kind: 'ad', updated: ['creative'] });

    const pause = await call(['ads:update', '--brand', 'b1', '--kind', 'campaign', '--id', '1', '--file', file({ status: 'PAUSED' })]);
    assert.equal(pause.code, 0, pause.stdout);
    assert.equal(pause.requests[0].path, '/agent/v1/brands/b1/ads/campaigns/1');
    assert.deepEqual(pause.requests[0].body, { status: 'PAUSED' });

    const update = (kind, params) => call(['ads:update', '--brand', 'b1', '--kind', kind, '--id', '1', '--file', file(params)]);
    assertRejected(await update('campaign', { objective: 'OUTCOME_SALES', buying_type: 'AUCTION' }), ['objective', 'buying_type']);
    assertRejected(await update('adset', { campaign_id: '2', status: 'ACTIVE' }), ['campaign_id', 'status']);
    assertRejected(await update('ad', { adset_id: '2' }), ['adset_id']);
    assertRejected(await update('adset', {}), ['(root)']);

    const dry = await call(['ads:update', '--brand', 'b1', '--kind', 'adset', '--id', '1', '--file', file({ daily_budget: 800 }), '--dry-run']);
    assert.equal(dry.code, 0, dry.stdout);
    assert.equal(dry.requests.length, 0);
    assert.deepEqual(dry.json.data, { valid: true, dryRun: true, bundle: 'ad-adset-update', counts: { fields: 1 } });
  } finally {
    server.reply(echo);
  }
});

test('ads:media:add uploads the file to storage and hands the key to the ad account', async () => {
  const video = path.join(dir, 'teaser.MOV');
  fs.writeFileSync(video, Buffer.alloc(4096, 3));
  const image = path.join(dir, 'card.jpeg');
  fs.writeFileSync(image, Buffer.alloc(1024, 5));
  server.reply((request) => {
    if (request.path === '/agent/v1/brands/b1/ads/media/uploads')
      return { status: 201, body: { ok: true, data: { key: 'ad-media/b1/k', uploadUrl: `${server.url}/storage/put?signed=1` } } };
    if (request.path === '/storage/put') return { status: 200, body: '' };
    return { status: 201, body: { ok: true, data: { kind: 'video', name: 'Autumn teaser', videoId: '120210000000000020' } } };
  });
  try {
    const result = await call(['ads:media:add', '--brand', 'b1', '--file', video, '--name', 'Autumn teaser']);
    assert.equal(result.code, 0, result.stdout);
    const [mint, put, add] = result.requests;
    assert.deepEqual([mint.method, mint.path, mint.body], ['POST', '/agent/v1/brands/b1/ads/media/uploads', { contentType: 'video/quicktime' }]);
    assert.equal(put.method, 'PUT');
    assert.equal(put.headers['content-type'], 'video/quicktime');
    assert.equal(put.headers.authorization, undefined);
    assert.equal(put.bytes, 4096);
    assert.deepEqual([add.method, add.path, add.body], ['POST', '/agent/v1/brands/b1/ads/media', { key: 'ad-media/b1/k', name: 'Autumn teaser' }]);
    assert.deepEqual(result.json, {
      ok: true,
      data: { kind: 'video', name: 'Autumn teaser', videoId: '120210000000000020', contentType: 'video/quicktime', bytes: 4096 },
    });

    const unnamed = await call(['ads:media:add', '--brand', 'b1', '--file', image]);
    assert.equal(unnamed.code, 0, unnamed.stdout);
    assert.deepEqual(unnamed.requests[0].body, { contentType: 'image/jpeg' });
    assert.deepEqual(unnamed.requests[2].body, { key: 'ad-media/b1/k' });

    for (const name of ['card.webp', 'clip.gif', 'empty.png']) {
      const refused = path.join(dir, name);
      fs.writeFileSync(refused, name === 'empty.png' ? '' : 'x');
      const result = await call(['ads:media:add', '--brand', 'b1', '--file', refused]);
      assert.equal(result.code, 1, name);
      assert.equal(result.json.error.code, 'invalid_request', name);
      assert.equal(result.requests.length, 0, name);
    }
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1));
    const tooBig = await call(['ads:media:add', '--brand', 'b1', '--file', big]);
    assert.equal(tooBig.json.error.code, 'invalid_request');
    assert.match(tooBig.json.error.message, /images must be 1 byte to 8388608 bytes/);
    assert.equal(tooBig.requests.length, 0);
    const longName = await call(['ads:media:add', '--brand', 'b1', '--file', image, '--name', 'n'.repeat(101)]);
    assert.equal(longName.json.error.code, 'invalid_request');
    assert.equal(longName.requests.length, 0);

    server.reply((request) => request.path === '/storage/put'
      ? { status: 403, body: '' }
      : { status: 201, body: { ok: true, data: { key: 'ad-media/b1/k', uploadUrl: `${server.url}/storage/put` } } });
    const blocked = await call(['ads:media:add', '--brand', 'b1', '--file', image]);
    assert.equal(blocked.json.error.code, 'upload_failed');
    assert.equal(blocked.requests.length, 2);
  } finally {
    server.reply(echo);
  }
});

test('passes ad account and Meta rejections through unchanged', async () => {
  const envelopes = [
    [409, { ok: false, error: { code: 'ad_account_unavailable', message: 'Connect a Meta ad account on the Connections page.' } }],
    [422, { ok: false, error: { code: 'meta_rejected', message: 'Invalid targeting', details: { status: 400, code: 100, subcode: 1885364, userTitle: 'Invalid targeting', userMessage: 'Add the advertiser identity for Taiwan.', traceId: 'AbC' } } }],
  ];
  try {
    for (const [status, envelope] of envelopes) {
      server.reply(() => ({ status, body: envelope }));
      const result = await call(['ads:account', '--brand', 'b1']);
      assert.equal(result.code, 1);
      assert.deepEqual(result.json, envelope);
    }
  } finally {
    server.reply(echo);
  }
});

test('help lists every ads command', async () => {
  const help = await call(['help']);
  for (const command of ['ads:account', 'ads:insights', 'ads:list', 'ads:create', 'ads:update', 'ads:media:add', 'ads:media', 'ads:targeting']) {
    assert.ok(command in help.json.data.commands, command);
  }
  assert.match(help.json.data.commands['ads:insights'], /--daily/);
});
