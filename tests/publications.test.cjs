const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir } = require('./support.cjs');

const rows = [
  {
    status: 'published',
    permalink: 'https://www.threads.com/@acme/post/abc',
    reads: { at24h: { state: 'verified' }, at7d: { state: 'not_due' } },
  },
  { status: 'failed', permalink: null, reads: null },
];

let server;
let env;
before(async () => {
  server = await startServer(() => ({ status: 200, body: { ok: true, data: { publications: rows, truncated: false } } }));
  env = { BICHON_AGENT_API_KEY: API_KEY, BICHON_AGENT_BASE_URL: server.url, TZ: 'Asia/Taipei' };
});
after(() => server.close());

async function call(args) {
  const count = server.requests.length;
  const result = await run(args, { env });
  return { ...result, requests: server.requests.slice(count) };
}

test('publications turns local days into an epoch-ms window', async () => {
  const cases = [
    [
      ['publications', '--brand', 'b1', '--month', '2026-10'],
      { from: String(Date.parse('2026-10-01T00:00:00+08:00')), to: String(Date.parse('2026-11-01T00:00:00+08:00')) },
    ],
    [
      ['publications', '--brand', 'b1', '--since', '2026-10-05', '--until', '2026-10-05', '--campaign', 'c1', '--status', 'failed'],
      {
        from: String(Date.parse('2026-10-05T00:00:00+08:00')),
        to: String(Date.parse('2026-10-06T00:00:00+08:00')),
        campaignId: 'c1',
        status: 'failed',
      },
    ],
  ];
  for (const [args, query] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests[0].method, 'GET');
    assert.equal(result.requests[0].path, '/agent/v1/brands/b1/publications');
    assert.deepEqual(result.requests[0].query, query);
  }
});

test('publications --out writes the rows and prints counts', async () => {
  const out = path.join(tempDir(), 'october.json');
  const result = await call(['publications', '--brand', 'b1', '--month', '2026-10', '--out', out]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).publications, rows);
  assert.deepEqual(result.json.data, {
    written: out,
    bytes: fs.statSync(out).size,
    publications: 2,
    statuses: { published: 1, failed: 1 },
    withPermalink: 1,
    reads: { at24h: { verified: 1 }, at7d: { not_due: 1 } },
    truncated: false,
  });
});

test('rejects bad publications windows before any request', async () => {
  const invalid = [
    ['publications', '--brand', 'b1'],
    ['publications', '--brand', 'b1', '--month', '2026-13'],
    ['publications', '--brand', 'b1', '--month', '2026-10', '--since', '2026-10-01', '--until', '2026-10-31'],
    ['publications', '--brand', 'b1', '--since', '2026-10-01'],
    ['publications', '--brand', 'b1', '--since', '2026-10-31', '--until', '2026-10-01'],
    ['publications', '--brand', 'b1', '--month', '2026-10', '--status', 'live'],
    ['publications', '--brand', 'b1', '--since', '2026-02-30', '--until', '2026-03-02'],
    ['publications', '--brand', 'b1', '--since', '2026-04-01', '--until', '2026-04-31'],
  ];
  for (const args of invalid) {
    const result = await call(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.requests.length, 0, args.join(' '));
  }
});
