const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../skills/bichon/scripts/bichon.cjs');
const SKILL_MD = path.join(__dirname, '../skills/bichon/SKILL.md');
const API_KEY = 'bichon_org_TESTSECRETabcdefghijklmnopqrstuvwxyz0123456';

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bichon-skill-')));
}

async function startServer(handler = () => ({ status: 200, body: { ok: true, data: {} } })) {
  const requests = [];
  let respond = handler;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const request = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(request);
      const reply = respond(request);
      res.writeHead(reply.status, { 'Content-Type': reply.contentType || 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    reply(next) { respond = next; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(args, { env = {}, cwd } = {}) {
  const home = env.HOME || tempDir();
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      cwd: cwd || home,
      env: { PATH: process.env.PATH, HOME: home, ...env },
    }, (error, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ code: error ? error.code : 0, stdout, stderr, json });
    });
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function skillExamples() {
  const source = fs.readFileSync(SKILL_MD, 'utf8');
  const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
  return {
    ideationRun: blocks.find((block) => block.format === 'bichon-ideation-run/v1'),
    drafts: blocks.find((block) => block.format === 'bichon-drafts/v1'),
  };
}

module.exports = { API_KEY, SCRIPT, run, startServer, tempDir, writeJson, skillExamples };
