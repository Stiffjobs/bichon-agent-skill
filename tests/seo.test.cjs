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

test('maps the SEO commands to their routes', async () => {
  const cases = [
    [['seo:plan', '--brand', 'b1', '--metrics-days', '28'], 'GET', '/agent/v1/brands/b1/seo', { metricsDays: '28' }],
    [['seo:task', '--brand', 'b1', '--task', '1.4'], 'GET', '/agent/v1/brands/b1/seo/tasks/1.4'],
    [['seo:plan:sync', '--brand', 'b1', '--file', file(example('bichon-seo-plan/v1'))], 'PUT', '/agent/v1/brands/b1/seo'],
    [['seo:task:update', '--brand', 'b1', '--task', '0.1', '--file', file(example('bichon-seo-task-update/v1'))], 'PATCH', '/agent/v1/brands/b1/seo/tasks/0.1'],
    [['seo:metrics:push', '--brand', 'b1', '--file', file(example('bichon-seo-metrics/v1'))], 'POST', '/agent/v1/brands/b1/seo/metrics'],
    [['seo:keywords:push', '--brand', 'b1', '--file', file(example('bichon-seo-keyword-stats/v1'))], 'POST', '/agent/v1/brands/b1/seo/keywords/stats'],
    [['seo:questions:check', '--brand', 'b1', '--file', file(example('bichon-seo-question-checks/v1'))], 'POST', '/agent/v1/brands/b1/seo/questions/checks'],
    [['seo:scorecard:push', '--brand', 'b1', '--file', file(example('bichon-seo-scorecard/v1'))], 'POST', '/agent/v1/brands/b1/seo/scorecards'],
  ];
  for (const [args, method, route, query] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests[0].method, method);
    assert.equal(result.requests[0].path, route);
    if (query) assert.deepEqual(result.requests[0].query, query);
  }
});

test('--prune is sent only when asked for', async () => {
  const bundle = file(example('bichon-seo-plan/v1'));
  const plain = await call(['seo:plan:sync', '--brand', 'b1', '--file', bundle]);
  assert.equal(plain.requests[0].body.prune, undefined);
  const pruned = await call(['seo:plan:sync', '--brand', 'b1', '--file', bundle, '--prune']);
  assert.equal(pruned.requests[0].body.prune, true);
});

test('the SEO example bundles in SKILL.md validate', async () => {
  const cases = [
    ['seo:plan:sync', 'bichon-seo-plan/v1', []],
    ['seo:task:update', 'bichon-seo-task-update/v1', ['--task', '0.1']],
    ['seo:metrics:push', 'bichon-seo-metrics/v1', []],
    ['seo:keywords:push', 'bichon-seo-keyword-stats/v1', []],
    ['seo:questions:check', 'bichon-seo-question-checks/v1', []],
    ['seo:scorecard:push', 'bichon-seo-scorecard/v1', []],
  ];
  for (const [command, format, extra] of cases) {
    const bundle = example(format);
    assert.ok(bundle, `SKILL.md has a ${format} example`);
    const result = await call([command, '--brand', 'b1', ...extra, '--file', file(bundle), '--dry-run']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests.length, 0);
    assert.equal(result.json.data.valid, true);
  }
});

test('bad SEO bundles fail locally and name the path', async () => {
  const plan = example('bichon-seo-plan/v1');
  const badPlan = {
    ...plan,
    plan: { ...plan.plan, site: 'ftp://example.com', dimensions: [{ key: 'a', title: 'A', weight: 60 }] },
    tasks: [{ ...plan.tasks[0], phase: 'nope' }, plan.tasks[0]],
  };
  const sync = await call(['seo:plan:sync', '--brand', 'b1', '--file', file(badPlan)]);
  assert.equal(sync.code, 1);
  assert.equal(sync.requests.length, 0);
  const paths = sync.json.error.details.issues.map((issue) => issue.path);
  for (const expected of ['plan.site', 'plan.dimensions', 'tasks[0].phase', 'tasks[1]']) assert.ok(paths.includes(expected), `${expected} in ${paths}`);

  const empty = await call(['seo:task:update', '--brand', 'b1', '--task', '0.1', '--file', file({ format: 'bichon-seo-task-update/v1', agent: AGENT })]);
  assert.equal(empty.code, 1);
  assert.equal(empty.requests.length, 0);

  const metrics = await call(['seo:metrics:push', '--brand', 'b1', '--file', file({
    format: 'bichon-seo-metrics/v1',
    agent: AGENT,
    rows: [{ date: '2026-02-30', impressions: 1, clicks: 2 }],
  })]);
  assert.equal(metrics.code, 1);
  const metricPaths = metrics.json.error.details.issues.map((issue) => issue.path);
  assert.ok(metricPaths.includes('rows[0].date'));
  assert.ok(metricPaths.includes('rows[0].clicks'));

  const checks = await call(['seo:questions:check', '--brand', 'b1', '--file', file({
    format: 'bichon-seo-question-checks/v1',
    agent: AGENT,
    checks: [{ question: 'q1', engine: 'Chat GPT', checkedOn: '2026-11-13', mentioned: true, cited: false, citedUrl: 'https://x.test', accuracy: 'wrong' }],
  })]);
  assert.equal(checks.code, 1);
  const checkPaths = checks.json.error.details.issues.map((issue) => issue.path);
  for (const expected of ['checks[0].engine', 'checks[0].citedUrl', 'checks[0].accuracy']) assert.ok(checkPaths.includes(expected));

  const stats = await call(['seo:keywords:push', '--brand', 'b1', '--file', file({
    format: 'bichon-seo-keyword-stats/v1',
    agent: AGENT,
    checkedOn: '2026-11-17',
    rows: [{ key: 'kw1', position: 0 }],
  })]);
  assert.equal(stats.code, 1);
});

test('a keyword out of the tracked range is a null position, not 0', async () => {
  const result = await call(['seo:keywords:push', '--brand', 'b1', '--dry-run', '--file', file({
    format: 'bichon-seo-keyword-stats/v1',
    agent: AGENT,
    checkedOn: '2026-11-17',
    rows: [{ key: 'kw1', position: null, positionLimit: 20 }],
  })]);
  assert.equal(result.code, 0, result.stdout);
});

test('seo:plan --out writes the plan and prints a summary', async () => {
  server.reply(() => ok({
    plan: { title: 'Plan', site: 'https://example.com/', syncedAt: 1 },
    tasks: [{ key: '0.1', status: 'done' }, { key: '1.1', status: 'todo' }],
    keywords: [],
    questions: [{}],
    scorecards: [],
    metrics: [],
    members: [{}],
  }));
  const out = path.join(dir, 'seo.json');
  const result = await call(['seo:plan', '--brand', 'b1', '--out', out]);
  server.reply(() => ok({ echo: true }));
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.json.data.byStatus, { done: 1, todo: 1 });
  assert.equal(result.json.data.questions, 1);
  assert.equal(result.json.data.written, out);
});
