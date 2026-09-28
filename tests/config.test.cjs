const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { API_KEY, run, startServer, tempDir, writeJson } = require('./support.cjs');

let server;
before(async () => {
  server = await startServer((request) => (request.path === '/agent/v1/health'
    ? { status: 200, body: { ok: true, data: { organizationId: 'org_1', keyName: 'laptop', user: { id: 'u1', name: 'Ada' } } } }
    : { status: 200, body: { ok: true, data: [] } }));
});
after(() => server.close());

const savedKey = (suffix) => `bichon_org_${suffix}0000000000000000000000000000000000000`;

test('env key wins over every saved config and is never printed', async () => {
  const home = tempDir();
  writeJson(path.join(home, '.config/bichon/config.json'), { apiKey: savedKey('global') });
  const result = await run(['config'], { env: { HOME: home, BICHON_AGENT_API_KEY: API_KEY } });
  assert.equal(result.code, 0);
  assert.equal(result.json.data.source, 'env');
  assert.equal(result.json.data.keyPrefix, 'bichon_org_TESTSECR…');
  assert.ok(!result.stdout.includes(API_KEY));
});

test('explicit --config and BICHON_CONFIG_PATH beat local and global files', async () => {
  const home = tempDir();
  const explicit = writeJson(path.join(home, 'elsewhere/cfg.json'), { apiKey: savedKey('explicit') });
  writeJson(path.join(home, '.bichon/config.json'), { apiKey: savedKey('local') });
  const byFlag = await run(['config', '--config', explicit], { env: { HOME: home } });
  assert.equal(byFlag.json.data.source, 'explicit');
  assert.equal(byFlag.json.data.configPath, explicit);
  const byEnv = await run(['config'], { env: { HOME: home, BICHON_CONFIG_PATH: explicit } });
  assert.equal(byEnv.json.data.configPath, explicit);
});

test('a missing explicit config file fails instead of falling back', async () => {
  const home = tempDir();
  writeJson(path.join(home, '.config/bichon/config.json'), { apiKey: savedKey('global') });
  const result = await run(['brands', '--config', path.join(home, 'nope.json')], { env: { HOME: home } });
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, 'config_invalid');
});

test('finds the nearest .bichon/config.json walking upward, then the global file', async () => {
  const home = tempDir();
  const project = path.join(home, 'project');
  const nested = path.join(project, 'packages/app/src');
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(home, '.config/bichon/config.json'), { apiKey: savedKey('global') });
  writeJson(path.join(project, '.bichon/config.json'), { apiKey: savedKey('local') });
  const local = await run(['config'], { env: { HOME: home }, cwd: nested });
  assert.equal(local.json.data.source, 'local');
  assert.equal(local.json.data.configPath, path.join(project, '.bichon/config.json'));
  fs.rmSync(path.join(project, '.bichon'), { recursive: true });
  const global = await run(['config'], { env: { HOME: home }, cwd: nested });
  assert.equal(global.json.data.source, 'global');
});

test('reports unconfigured state and refuses API commands without a request', async () => {
  const before = server.requests.length;
  const config = await run(['config']);
  assert.deepEqual(config.json.data.configured, false);
  const brands = await run(['brands'], { env: { BICHON_AGENT_BASE_URL: server.url } });
  assert.equal(brands.code, 1);
  assert.equal(brands.json.ok, false);
  assert.equal(brands.json.error.code, 'config_missing');
  assert.equal(server.requests.length, before);
});

test('base URL resolves env, then saved baseUrl, then the production default', async () => {
  const home = tempDir();
  writeJson(path.join(home, '.config/bichon/config.json'), { apiKey: savedKey('global'), baseUrl: 'https://staging.example.test/' });
  const saved = await run(['config'], { env: { HOME: home } });
  assert.equal(saved.json.data.baseUrl, 'https://staging.example.test');
  assert.equal(saved.json.data.baseUrlSource, 'config');
  const env = await run(['config'], { env: { HOME: home, BICHON_AGENT_BASE_URL: 'http://127.0.0.1:9' } });
  assert.equal(env.json.data.baseUrlSource, 'env');
  const fallback = await run(['config'], { env: { BICHON_AGENT_API_KEY: API_KEY } });
  assert.equal(fallback.json.data.baseUrl, 'https://intent-crab-142.convex.site');
  assert.equal(fallback.json.data.baseUrlSource, 'default');
});

test('setup verifies with health, saves the key privately and prints only its prefix', async () => {
  const home = tempDir();
  const result = await run(['setup', '--api-key', API_KEY, '--base-url', server.url], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stdout);
  const file = path.join(home, '.config/bichon/config.json');
  assert.equal(result.json.data.configPath, file);
  assert.equal(result.json.data.verified, true);
  assert.equal(result.json.data.keyName, 'laptop');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { apiKey: API_KEY, baseUrl: server.url });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(API_KEY) && !result.stderr.includes(API_KEY));
  const health = server.requests.at(-1);
  assert.equal(health.path, '/agent/v1/health');
  assert.equal(health.headers.authorization, `Bearer ${API_KEY}`);
  const after = await run(['config'], { env: { HOME: home } });
  assert.equal(after.json.data.baseUrl, server.url);
});

test('setup --local writes ./.bichon/config.json in the working directory', async () => {
  const home = tempDir();
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const result = await run(['setup', '--api-key', API_KEY, '--local', '--no-verify'], { env: { HOME: home }, cwd: project });
  assert.equal(result.code, 0);
  assert.equal(result.json.data.location, 'local');
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.bichon/config.json'), 'utf8')).apiKey, API_KEY);
});

test('setup rejects foreign keys and saves nothing when verification fails', async () => {
  const home = tempDir();
  const foreign = await run(['setup', '--api-key', 'po_live_org_x', '--no-verify'], { env: { HOME: home } });
  assert.equal(foreign.code, 1);
  assert.equal(foreign.json.error.code, 'invalid_request');
  server.reply(() => ({ status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'Unknown or revoked API key.' } } }));
  const denied = await run(['setup', '--api-key', API_KEY, '--base-url', server.url], { env: { HOME: home } });
  server.reply(() => ({ status: 200, body: { ok: true, data: {} } }));
  assert.equal(denied.code, 1);
  assert.equal(denied.json.error.code, 'unauthorized');
  assert.equal(fs.existsSync(path.join(home, '.config/bichon/config.json')), false);
});
