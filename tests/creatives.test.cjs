const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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

async function call(args, extraEnv = {}) {
  const count = server.requests.length;
  const result = await run(args, { env: { ...env, ...extraEnv } });
  return { ...result, requests: server.requests.slice(count) };
}

const file = (value) => writeJson(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), value);
const AGENT = { name: 'claude-code' };

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, body) {
  const named = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of named) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(body.length);
  named.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + body.length);
  return out;
}

// An opaque RGB PNG whose left half is one color and right half another,
// using a different scanline filter per row.
function testPng(width, height, transparentKey) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const pixel = (x) => (x < width / 2 ? [10, 200, 30] : [200, 40, 120]);
  for (let y = 0; y < height; y += 1) {
    const filter = y % 3 === 1 ? 1 : y % 3 === 2 ? 2 : 0;
    const start = y * (stride + 1);
    raw[start] = filter;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x);
      const left = filter === 1 && x > 0 ? pixel(x - 1) : [0, 0, 0];
      const up = filter === 2 ? pixel(x) : [0, 0, 0];
      raw[start + 1 + x * 3] = (r - left[0] - up[0] + 512) & 0xff;
      raw[start + 2 + x * 3] = (g - left[1] - up[1] + 512) & 0xff;
      raw[start + 3 + x * 3] = (b - left[2] - up[2] + 512) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(transparentKey ? [chunk('tRNS', Buffer.from(transparentKey.flatMap((value) => [0, value])))] : []),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readPng(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    pixels: () => {
      let at = 8;
      const data = [];
      while (at < bytes.length) {
        const length = bytes.readUInt32BE(at);
        if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length));
        at += 12 + length;
      }
      return zlib.inflateSync(Buffer.concat(data));
    },
  };
}

const imagePath = () => {
  const target = path.join(dir, `${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(target, testPng(100, 80));
  return target;
};

const CREATIVE = {
  format: 'bichon-ad-creative/v1',
  agent: AGENT,
  creative: { title: 'F0', angle: 'a', hook: 'h', format: '手拿', utmCreative: 'f0-hand-v1' },
  prompt: 'p',
  onImageText: '',
};

test('maps the brand book and iteration commands to their routes', async () => {
  const cases = [
    [['ad-book', '--brand', 'b1'], 'GET', '/agent/v1/brands/b1/ad-book'],
    [['creative:iterations', '--brand', 'b1', '--product', 'p1'], 'GET', '/agent/v1/brands/b1/ad-review/iterations', { productId: 'p1' }],
    [['creative:list', '--brand', 'b1', '--status', 'approved', '--iteration', 'i1', '--limit', '5'], 'GET', '/agent/v1/brands/b1/ad-review/creatives', { status: 'approved', iterationId: 'i1', limit: '5' }],
    [['creative:get', '--brand', 'b1', '--id', 'c1'], 'GET', '/agent/v1/brands/b1/ad-review/creatives/c1'],
  ];
  for (const [args, method, route, query] of cases) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests[0].method, method);
    assert.equal(result.requests[0].path, route);
    if (query) assert.deepEqual(result.requests[0].query, query);
  }
});

test('the example bundles in SKILL.md validate', async () => {
  const blocks = skillBlocks('json').map((block) => JSON.parse(block));
  const find = (format) => blocks.find((block) => block.format === format);
  const cases = [
    ['ad-product:import', 'bichon-ad-product/v1'],
    ['ad-rule:import', 'bichon-ad-rule/v1'],
    ['creative:iteration:create', 'bichon-ad-iteration/v1'],
  ];
  for (const [command, format] of cases) {
    const result = await call([command, '--brand', 'b1', '--file', file(find(format)), '--dry-run']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests.length, 0);
  }
  const image = imagePath();
  const creative = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', file(find('bichon-ad-creative/v1')), '--image', image, '--dry-run']);
  assert.equal(creative.code, 0, creative.stdout);
  assert.deepEqual(
    { width: creative.json.data.image.width, height: creative.json.data.image.height },
    { width: 100, height: 80 },
  );
  const revision = await call(['creative:revise', '--brand', 'b1', '--id', 'c1', '--file', file(find('bichon-ad-revision/v1')), '--image', image, '--dry-run']);
  assert.equal(revision.code, 0, revision.stdout);
});

test('bad bundles fail locally and name the path', async () => {
  const product = await call(['ad-product:import', '--brand', 'b1', '--file', file({ format: 'bichon-ad-product/v1', agent: AGENT, product: { name: '' } })]);
  assert.equal(product.code, 1);
  assert.equal(product.requests.length, 0);
  assert.ok(product.json.error.details.issues.some((issue) => issue.path === 'product.name'));
  const slug = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', file({ ...CREATIVE, creative: { ...CREATIVE.creative, utmCreative: 'Has Space' } }), '--image', imagePath(), '--dry-run']);
  assert.equal(slug.code, 1);
  assert.ok(slug.json.error.details.issues.some((issue) => issue.path === 'creative.utmCreative'));
  const note = await call(['creative:revise', '--brand', 'b1', '--id', 'c1', '--file', file({ format: 'bichon-ad-revision/v1', agent: AGENT, basedOnRevision: 1, prompt: 'p', onImageText: '' }), '--image', imagePath()]);
  assert.equal(note.code, 1);
  assert.ok(note.json.error.details.issues.some((issue) => issue.path === 'responseNote'));
});

test('creative:submit uploads the image, then submits with its key and real size', async () => {
  server.reply((request) => {
    if (request.path.endsWith('/uploads')) return ok({ key: 'ad-creatives/b1/k1', uploadUrl: `${server.url}/put` }, 201);
    if (request.path === '/put') return ok({});
    return ok({ creativeId: 'c1', revision: 1, status: 'submitted' }, 201);
  });
  const result = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', file(CREATIVE), '--image', imagePath()]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.requests.map((request) => request.path), [
    '/agent/v1/brands/b1/ad-review/uploads',
    '/put',
    '/agent/v1/brands/b1/ad-review/iterations/i1/creatives',
  ]);
  assert.deepEqual(result.requests[0].body, { contentType: 'image/png' });
  assert.deepEqual(result.requests[2].body.image, { key: 'ad-creatives/b1/k1', width: 100, height: 80 });
  assert.equal(result.requests[2].body.creative.utmCreative, 'f0-hand-v1');
  server.reply(() => ok({ echo: true }));
});

test('creative:revise posts to the revisions route and ad-product:cutout attaches the upload', async () => {
  server.reply((request) => {
    if (request.path.endsWith('/uploads')) return ok({ key: 'k2', uploadUrl: `${server.url}/put` }, 201);
    return ok({ done: true }, request.path === '/put' ? 200 : 201);
  });
  const revise = await call(['creative:revise', '--brand', 'b1', '--id', 'c1', '--file', file({ format: 'bichon-ad-revision/v1', agent: AGENT, basedOnRevision: 2, prompt: 'p', onImageText: '', responseNote: '1: done' }), '--image', imagePath()]);
  assert.equal(revise.code, 0, revise.stdout);
  assert.equal(revise.requests[2].path, '/agent/v1/brands/b1/ad-review/creatives/c1/revisions');
  assert.equal(revise.requests[2].body.basedOnRevision, 2);
  const cutout = await call(['ad-product:cutout', '--brand', 'b1', '--id', 'p1', '--file', imagePath(), '--label', 'bottle']);
  assert.equal(cutout.code, 0, cutout.stdout);
  assert.equal(cutout.requests[0].path, '/agent/v1/brands/b1/ad-book/products/p1/cutouts/uploads');
  assert.deepEqual(cutout.requests[2].body, { key: 'k2', label: 'bottle' });
  server.reply(() => ok({ echo: true }));
});

test('creative:regions writes the image, a numbered overlay, a crop per box and the manifest', async () => {
  const creative = {
    creativeId: 'c1',
    revision: 2,
    utmCreative: 'f0',
    image: { url: `${server.url}/image.png`, width: 100, height: 80 },
    prompt: 'p',
    onImageText: 't',
    copy: { headline: 'h' },
    comments: [
      {
        commentId: 'x',
        author: 'Rae',
        decision: 'request_changes',
        body: 'Keep the hook.',
        regions: [
          { number: 1, note: 'Bottle bigger', normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, pixels: { x: 25, y: 20, width: 50, height: 40 } },
          { number: 2, note: 'Label', normalized: { x: 0, y: 0, width: 0.1, height: 0.1 }, pixels: { x: 0, y: 0, width: 10, height: 8 } },
        ],
      },
    ],
  };
  server.reply((request) =>
    request.path === '/image.png'
      ? { status: 200, contentType: 'image/png', body: testPng(100, 80) }
      : ok(creative),
  );
  const out = path.join(dir, 'regions');
  const result = await call(['creative:regions', '--brand', 'b1', '--id', 'c1', '--out', out]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.data.regions, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'regions.json'), 'utf8'));
  assert.deepEqual(manifest.regions.map((region) => region.number), [1, 2]);
  assert.equal(manifest.regions[0].note, 'Bottle bigger');
  assert.deepEqual(manifest.regions[0].pixels, { x: 25, y: 20, width: 50, height: 40 });
  assert.equal(manifest.generalComments[0].body, 'Keep the hook.');

  const crop = readPng(path.join(out, 'region-1.png'));
  assert.deepEqual([crop.width, crop.height], [50, 40]);
  // The crop spans the seam: left pixels from the left half, right from the right.
  const scan = crop.pixels();
  assert.deepEqual([...scan.subarray(1, 4)], [10, 200, 30]);
  assert.deepEqual([...scan.subarray(1 + 49 * 4, 4 + 49 * 4)], [200, 40, 120]);

  const overlay = readPng(path.join(out, 'overlay.png'));
  assert.deepEqual([overlay.width, overlay.height], [100, 80]);
  const raw = overlay.pixels();
  const at = (x, y) => [...raw.subarray(y * 401 + 1 + x * 4, y * 401 + 4 + x * 4)];
  assert.deepEqual(at(60, 20), [230, 30, 90], 'the top edge of box 1');
  assert.deepEqual(at(99, 79), [200, 40, 120], 'an untouched pixel');
  server.reply(() => ok({ echo: true }));
});

test('creative:regions keeps PNG color-key transparency', async () => {
  const creative = {
    creativeId: 'c1',
    revision: 1,
    image: { url: `${server.url}/key.png`, width: 100, height: 80 },
    comments: [{ author: 'Rae', decision: null, body: '', regions: [{ number: 1, note: 'n', normalized: { x: 0, y: 0, width: 0.2, height: 0.2 }, pixels: {} }] }],
  };
  server.reply((request) =>
    request.path === '/key.png' ? { status: 200, contentType: 'image/png', body: testPng(100, 80, [10, 200, 30]) } : ok(creative),
  );
  const out = path.join(dir, 'keyed');
  const result = await call(['creative:regions', '--brand', 'b1', '--id', 'c1', '--out', out]);
  assert.equal(result.code, 0, result.stdout);
  const crop = readPng(path.join(out, 'region-1.png')).pixels();
  assert.deepEqual([...crop.subarray(1, 5)], [10, 200, 30, 0]);
  server.reply(() => ok({ echo: true }));
});

test('a JPEG with an EXIF rotation is refused before upload', async () => {
  const rotated = path.join(dir, 'rotated.jpg');
  fs.writeFileSync(rotated, Buffer.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x46, 0x04, 0x38, 0x03, 0, 0, 0, 0,
  ]));
  const result = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', file(CREATIVE), '--image', rotated]);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.match(result.json.error.message, /upright/);
});

test('a PNG with an EXIF rotation is refused before upload', async () => {
  const png = testPng(10, 10);
  const exif = chunk('eXIf', Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]));
  const rotated = path.join(dir, 'rotated.png');
  fs.writeFileSync(rotated, Buffer.concat([png.subarray(0, 33), exif, png.subarray(33)]));
  const result = await call(['creative:submit', '--brand', 'b1', '--iteration', 'i1', '--file', file(CREATIVE), '--image', rotated]);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.requests.length, 0);
  assert.match(result.json.error.message, /upright/);
});

test('creative:regions explains what is missing for an image it cannot decode', async () => {
  const creative = { creativeId: 'c1', revision: 1, image: { url: `${server.url}/image.jpg`, width: 1, height: 1 }, comments: [] };
  server.reply((request) =>
    request.path === '/image.jpg' ? { status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } : ok(creative),
  );
  const result = await call(['creative:regions', '--brand', 'b1', '--id', 'c1', '--out', path.join(dir, 'jpeg')], { PATH: '' });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.json.error.code, 'image_tool_missing');
  server.reply(() => ok({ echo: true }));
});
