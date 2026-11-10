#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const DEFAULT_BASE_URL = 'https://intent-crab-142.convex.site';
const API_PREFIX = '/agent/v1';
const KEY_PREFIX = 'bichon_org_';
const SCRIPT = './scripts/bichon.cjs';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const UPLOAD_TIMEOUT_MS = 600000;
const MAX_REPORTED_ISSUES = 50;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const AD_MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
const BOOLEAN_FLAGS = new Set(['pretty', 'local', 'no-verify', 'dry-run', 'help', 'history', 'daily']);
const REDACTED = '[redacted]';
const SENSITIVE_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authcode',
  'authorization',
  'bearertoken',
  'clientsecret',
  'idtoken',
  'password',
  'refreshtoken',
  'secret',
  'sessiontoken',
]);
const CAMPAIGN_STATUSES = ['active', 'archived'];
const IDEA_STATUSES = ['proposed', 'approved', 'killed', 'done'];
const REVIEW_STATUSES = ['changes_requested', 'rejected', 'submitted', 'approved', 'all'];
const PUBLICATION_STATUSES = ['pending', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'];
const WHY_NOW_CATEGORIES = ['timely_news', 'active_discussion', 'competitor_performance', 'evergreen'];
const MODES = ['evidence', 'brief', 'mixed'];
const POST_TYPES = ['image', 'video', 'text'];
const PLATFORMS = ['facebook', 'instagram', 'threads'];
const POST_FORMATS = ['text', 'image', 'carousel', 'video', 'reel', 'link'];
const COMPETITOR_PROVIDERS = ['instagram', 'threads'];
const COLLECT_KINDS = ['rss', 'competitors', 'threads'];
const ITEM_KINDS = ['article', 'competitor_post', 'threads_post'];
const ANALYSIS_CATEGORIES = ['report', 'announcement', 'opinion', 'how_to', 'data_point', 'product_post', 'promo', 'discussion', 'other'];
const ANALYSIS_QUALITIES = ['useful', 'thin', 'promo', 'off_topic'];
const ANALYSIS_RELEVANCE = ['direct', 'adjacent', 'off_topic'];
const ADS_LEVELS = ['account', 'campaign', 'adset', 'ad'];
const ADS_RANGES = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month'];
const ADS_BREAKDOWNS = ['age', 'gender', 'country', 'publisher_platform', 'platform_position', 'device_platform'];
const ADS_SORTS = [
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'linkClicks', 'ctr', 'linkCtr', 'cpc', 'costPerLinkClick', 'cpm',
  'results', 'costPerResult', 'contentViews', 'addsToCart', 'checkoutsInitiated', 'purchases', 'purchaseValue', 'purchaseRoas',
  'videoPlays', 'videoViews', 'thruPlays',
];
const MAX_FILTER_IDS = 100;
const AD_SEGMENTS = { campaign: 'campaigns', adset: 'adsets', creative: 'creatives', ad: 'ads' };
const AD_KINDS = Object.keys(AD_SEGMENTS);
const AD_UPDATE_KINDS = ['campaign', 'adset', 'ad'];
const AD_LIST_KINDS = ['campaigns', 'adsets', 'ads', 'creatives'];
const AD_MEDIA_KINDS = ['image', 'video'];
const TARGETING_TYPES = ['interest', 'geo', 'locale'];
const META_ID = /^\d{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const HTTP_CODES = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
};

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.envelope = { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
  }
}

class ApiError extends Error {
  constructor(envelope) {
    super(envelope.error && envelope.error.message);
    this.envelope = envelope;
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      throw new CliError('invalid_request', `Unexpected argument "${token}". Options take the form --name value.`);
    }
    const eq = token.indexOf('=');
    if (eq > 2) {
      parsed[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requireOption(parsed, name) {
  const value = parsed[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('invalid_request', `Missing --${name} <value>.`);
  }
  return value.trim();
}

function optionalOption(parsed, name) {
  if (parsed[name] === undefined) return undefined;
  return requireOption(parsed, name);
}

function enumOption(parsed, name, allowed) {
  const value = optionalOption(parsed, name);
  if (value !== undefined && !allowed.includes(value)) {
    throw new CliError('invalid_request', `--${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function requiredEnumOption(parsed, name, allowed) {
  const value = enumOption(parsed, name, allowed);
  if (value === undefined) throw new CliError('invalid_request', `Missing --${name} ${allowed.join('|')}.`);
  return value;
}

function metaIdOption(parsed, name, required = false) {
  const value = required ? requireOption(parsed, name) : optionalOption(parsed, name);
  if (value !== undefined && !META_ID.test(value)) {
    throw new CliError('invalid_request', `--${name} must be a Meta id (digits only).`);
  }
  return value;
}

// Date.parse rolls 2026-02-30 over to March 2; a real date round-trips.
function isRealDate(value) {
  return DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function dateOption(parsed, name) {
  const value = optionalOption(parsed, name);
  if (value !== undefined && !isRealDate(value)) {
    throw new CliError('invalid_request', `--${name} must be a YYYY-MM-DD date.`);
  }
  return value;
}

function integerOption(parsed, name, min, max) {
  const value = optionalOption(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new CliError('invalid_request', `--${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

// One Meta id or a comma-separated list of them, sent on as one string.
function metaIdsOption(parsed, name) {
  const value = optionalOption(parsed, name);
  if (value === undefined) return undefined;
  const ids = [...new Set(value.split(',').map((id) => id.trim()))];
  if (ids.length > MAX_FILTER_IDS || !ids.every((id) => META_ID.test(id))) {
    throw new CliError('invalid_request', `--${name} must be a Meta id or up to ${MAX_FILTER_IDS} comma-separated ids.`);
  }
  return ids.join(',');
}

function accountOption(parsed) {
  const value = optionalOption(parsed, 'account');
  if (value === undefined) return undefined;
  const id = value.replace(/^act_/, '');
  if (!META_ID.test(id)) throw new CliError('invalid_request', '--account must be an ad account id (act_123 or 123).');
  return id;
}

function flagOption(parsed, name) {
  if (parsed[name] === undefined) return undefined;
  if (parsed[name] !== true) throw new CliError('invalid_request', `--${name} is a flag and takes no value.`);
  return true;
}

function listOption(parsed, name, allowed) {
  const value = optionalOption(parsed, name);
  if (value === undefined) return undefined;
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  const unknown = items.filter((item) => !allowed.includes(item));
  if (items.length === 0 || unknown.length > 0) {
    throw new CliError('invalid_request', `--${name} takes a comma-separated list of: ${allowed.join(', ')}.`);
  }
  return items;
}

function normalizeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('invalid_request', `${label} is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('invalid_request', `${label} must be an http(s) URL.`);
  }
  return url.toString().replace(/\/+$/, '');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(filePath, mode);
}

function globalConfigPath() {
  return path.join(os.homedir(), '.config', 'bichon', 'config.json');
}

function localConfigPath() {
  return path.join(process.cwd(), '.bichon', 'config.json');
}

function explicitConfigPath(parsed) {
  const value = typeof parsed.config === 'string' ? parsed.config : process.env.BICHON_CONFIG_PATH;
  return value ? path.resolve(value) : null;
}

function findNearestLocalConfig(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.bichon', 'config.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadSavedConfig(filePath, source) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const saved = readJsonFile(filePath);
  if (!saved || typeof saved.apiKey !== 'string' || !saved.apiKey) return null;
  return { apiKey: saved.apiKey, savedBaseUrl: saved.baseUrl, source, configPath: filePath };
}

function resolveBaseUrl(savedBaseUrl) {
  if (process.env.BICHON_AGENT_BASE_URL) {
    return { baseUrl: normalizeBaseUrl(process.env.BICHON_AGENT_BASE_URL, 'BICHON_AGENT_BASE_URL'), baseUrlSource: 'env' };
  }
  if (typeof savedBaseUrl === 'string' && savedBaseUrl) {
    return { baseUrl: normalizeBaseUrl(savedBaseUrl, 'Saved baseUrl'), baseUrlSource: 'config' };
  }
  return { baseUrl: DEFAULT_BASE_URL, baseUrlSource: 'default' };
}

function resolveConfig(parsed) {
  let found = null;
  if (process.env.BICHON_AGENT_API_KEY) {
    found = { apiKey: process.env.BICHON_AGENT_API_KEY, source: 'env', configPath: null };
  } else {
    const explicit = explicitConfigPath(parsed);
    if (explicit) {
      found = loadSavedConfig(explicit, 'explicit');
      if (!found) {
        throw new CliError('config_invalid', `Config file ${explicit} is missing or has no apiKey.`);
      }
    } else {
      found = loadSavedConfig(findNearestLocalConfig(), 'local') || loadSavedConfig(globalConfigPath(), 'global');
    }
  }
  if (!found) return null;
  return { apiKey: found.apiKey, source: found.source, configPath: found.configPath, ...resolveBaseUrl(found.savedBaseUrl) };
}

function requireConfig(parsed) {
  const config = resolveConfig(parsed);
  if (!config) {
    throw new CliError(
      'config_missing',
      `No Bichon API key configured. Run ${SCRIPT} setup --api-key ${KEY_PREFIX}<secret>, or set BICHON_AGENT_API_KEY.`,
    );
  }
  return config;
}

function redactApiKey(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith(KEY_PREFIX)) return `${apiKey.slice(0, KEY_PREFIX.length + 8)}…`;
  return '***';
}

function isSensitiveFieldName(name) {
  const normalized = String(name).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password');
}

function redact(value, apiKey) {
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey));
  if (typeof value === 'string') return apiKey && value.includes(apiKey) ? value.split(apiKey).join(REDACTED) : value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
    isSensitiveFieldName(key) ? [key, REDACTED] : [key, redact(entry, apiKey)]
  )));
}

let activeApiKey = null;
let pretty = false;

function emit(envelope) {
  const safe = redact(envelope, activeApiKey || process.env.BICHON_AGENT_API_KEY);
  console.log(pretty ? JSON.stringify(safe, null, 2) : JSON.stringify(safe));
}

function succeed(data) {
  emit({ ok: true, data });
}

async function api(config, method, route, options = {}) {
  const url = new URL(`${config.baseUrl}${API_PREFIX}${route}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined && Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new CliError('payload_too_large', `Request body is ${Buffer.byteLength(body)} bytes; the API accepts at most ${MAX_BODY_BYTES}.`);
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err && err.cause && err.cause.code ? err.cause.code : err && err.name === 'TimeoutError' ? 'timeout' : err && err.message;
    throw new CliError('network_error', `Could not reach ${config.baseUrl} (${reason}).`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
    if (parsed.ok && response.ok) return parsed;
    if (!parsed.ok && parsed.error) throw new ApiError(parsed);
  }
  if (response.ok && parsed !== undefined) return { ok: true, data: parsed };
  const code = HTTP_CODES[response.status] || (response.status >= 500 ? 'server_error' : `http_${response.status}`);
  throw new ApiError({
    ok: false,
    error: {
      code,
      message: `HTTP ${response.status} from ${url.pathname}${text ? `: ${text.slice(0, 300)}` : ''}`,
    },
  });
}

function segment(value) {
  return encodeURIComponent(value);
}

const str = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const list = (items, maxItems, extra = {}) => ({ type: 'array', maxItems, items, ...extra });
const strictObject = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const agentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: str(80), model: str(80), promptVersion: str(80) },
};
const signalEvidenceSchema = strictObject(
  { signalId: str(200), versionId: str(200), excerpt: str(400, 0), reason: str(2000) },
  ['signalId', 'reason'],
);
const discoveryEvidenceSchema = strictObject({ discoveryId: str(200), reason: str(2000) }, ['discoveryId', 'reason']);

const IDEA_SCHEMA = strictObject(
  {
    title: str(200),
    hook: str(1000),
    treatment: str(2000),
    audienceBenefit: str(300),
    whyNow: str(2000),
    limitation: str(300),
    whyNowCategory: { enum: WHY_NOW_CATEGORIES },
    recommendedFormat: str(200),
    personaKey: nullable(str(200)),
    pov: strictObject({ moment: str(300), fear: str(300), desire: str(300) }, ['moment', 'fear', 'desire']),
    coreMessage: str(300),
    assetId: nullable(str(200)),
    assetReason: nullable(str(300, 0)),
    evidence: list({ oneOf: [signalEvidenceSchema, discoveryEvidenceSchema] }, 10),
    primaryEvidence: { type: 'integer', minimum: 0, maximum: 9 },
    claims: list(strictObject({ text: str(2000), evidence: { type: 'integer', minimum: 0, maximum: 9 } }, ['text']), 8),
    formatPlan: list(
      strictObject(
        { socialProfileId: str(200), formatKey: str(200), layoutModelPostId: str(200), openerSource: str(300) },
        ['socialProfileId', 'formatKey', 'layoutModelPostId'],
      ),
      10,
    ),
  },
  [
    'title', 'hook', 'treatment', 'audienceBenefit', 'whyNow', 'limitation', 'whyNowCategory',
    'recommendedFormat', 'personaKey', 'pov', 'coreMessage', 'assetId', 'assetReason', 'evidence',
    'claims', 'formatPlan',
  ],
);

const DRAFT_SCHEMA = strictObject(
  {
    socialProfileId: str(200),
    caption: str(5000),
    followUps: {
      ...list(str(1000), 10),
      description: 'Threads accounts only: replies published under the post, in order; each at most 500 characters (counted server-side)',
    },
    title: str(200, 0),
    postType: { enum: POST_TYPES },
    variantNote: str(1000, 0),
    mediaNotes: str(2000, 0),
  },
  ['socialProfileId', 'caption'],
);
const MAX_DRAFTS = 10;

const POSTS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:posts:v1',
  title: 'PostsBundle',
  description: 'Body of posts:submit. Each post is its idea brief plus one caption per target account.',
  ...strictObject(
    {
      format: { const: 'bichon-posts/v1' },
      agent: agentSchema,
      mode: { enum: MODES },
      briefVersion: str(200),
      sourcePolicyVersion: str(200),
      submissionId: str(80),
      note: str(300, 0),
      noPostsReason: str(300, 0),
      posts: list(
        {
          ...IDEA_SCHEMA,
          required: [...IDEA_SCHEMA.required, 'drafts'],
          properties: {
            ...IDEA_SCHEMA.properties,
            reviewNote: { ...str(300, 0), description: 'what the manager should check before approving' },
            plannedDate: { ...str(10), pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'a YYYY-MM-DD date, the day the post is planned for' },
            drafts: list(DRAFT_SCHEMA, MAX_DRAFTS, { minItems: 1 }),
          },
        },
        5,
      ),
    },
    ['format', 'agent', 'mode', 'briefVersion', 'sourcePolicyVersion', 'posts'],
  ),
};

const DRAFTS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:drafts:v1',
  title: 'DraftsBundle',
  description: "Body of drafts:submit: rewrites of an existing post's drafts, or drafts for accounts it has none for.",
  ...strictObject(
    {
      format: { const: 'bichon-drafts/v1' },
      agent: agentSchema,
      drafts: list(
        {
          ...DRAFT_SCHEMA,
          properties: {
            ...DRAFT_SCHEMA.properties,
            responseNote: { ...str(1000, 0), description: 'what changed in answer to review requests, and what was left as is and why; stored on the next revision' },
          },
        },
        MAX_DRAFTS,
        { minItems: 1 },
      ),
    },
    ['format', 'agent', 'drafts'],
  ),
};

const PERSONA_SCHEMA = strictObject(
  {
    key: str(20),
    name: str(80),
    who: str(300, 0),
    moment: str(300, 0),
    fears: list(str(120), 8),
    desires: list(str(120), 8),
    goal: str(300, 0),
    words: list(str(120), 8),
    needFromAccount: str(300, 0),
    avoid: str(300, 0),
  },
  ['name', 'who', 'moment', 'fears', 'desires', 'goal', 'words', 'needFromAccount', 'avoid'],
);

const PERSONAS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:personas:v1',
  title: 'PersonasFile',
  description: 'Body of personas:set. Keys are reassigned p1..p5 by the server.',
  ...strictObject({ personas: list(PERSONA_SCHEMA, 5, { minItems: 1 }) }, ['personas']),
};

const RESEARCH_ANALYSES_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:research-analyses:v1',
  title: 'ResearchAnalysisBundle',
  description: 'Body of research:submit. Every itemRef must come from the batch leased under leaseId.',
  ...strictObject(
    {
      format: { const: 'bichon-research-analyses/v1' },
      agent: agentSchema,
      leaseId: str(200),
      items: list(
        strictObject(
          {
            itemRef: str(200),
            summary: str(400),
            facts: list(str(300), 6),
            category: { enum: ANALYSIS_CATEGORIES },
            quality: { enum: ANALYSIS_QUALITIES },
            relevance: { enum: ANALYSIS_RELEVANCE },
            whyItMatters: str(300),
            engagementRead: { ...str(200), description: 'words relative to the author baseline, never numbers; threads_post and competitor_post only' },
            themes: { ...list(str(80), 3), description: 'competitor_post only' },
            angle: str(300),
          },
          ['itemRef', 'summary', 'facts', 'category', 'quality', 'relevance', 'whyItMatters'],
        ),
        25,
        { minItems: 1 },
      ),
    },
    ['format', 'agent', 'leaseId', 'items'],
  ),
};

const tally = { type: 'integer', minimum: 0, maximum: 1e12 };

const RESEARCH_CAPTURES_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:research-captures:v1',
  title: 'ResearchCaptureBundle',
  description: 'Body of research:add: pages and posts you read yourself. They become pending research items, keyed by URL.',
  ...strictObject(
    {
      format: { const: 'bichon-research-captures/v1' },
      agent: agentSchema,
      items: list(
        strictObject(
          {
            kind: { enum: ITEM_KINDS, description: 'article: a page; competitor_post: a post by another account on any platform; threads_post: a Threads post found in a discussion' },
            url: { ...str(2000), pattern: '^https?://\\S+$', description: 'the http(s) URL of the page or post itself' },
            text: { ...str(20000), description: 'the full text as you read it, verbatim; no summary, no commentary' },
            title: str(300),
            author: { ...str(200), description: 'display name' },
            username: { ...str(100), description: 'account handle; required for competitor_post and threads_post' },
            publishedAt: { ...str(40), description: 'ISO 8601, only when the page states it' },
            language: str(35),
            engagement: { ...strictObject({ likes: tally, comments: tally, views: tally }), description: 'the counts shown on the post; posts only' },
            note: { ...str(300), description: 'how you found it: the account you were reading or the search you ran' },
          },
          ['kind', 'url', 'text'],
        ),
        25,
        { minItems: 1 },
      ),
    },
    ['format', 'agent', 'items'],
  ),
};

const idList = (maxItems, extra) => list(str(200), maxItems, { uniqueItems: true, ...extra });

const SETUP_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:campaign-setup:v1',
  title: 'CampaignSetup',
  description: 'Body of campaigns:create. campaigns:update takes the same object with every field optional.',
  ...strictObject(
    {
      name: str(120),
      brief: str(2000),
      goal: str(300, 0),
      topic: str(200, 0),
      audience: str(1000, 0),
      voiceOverride: str(2000, 0),
      contentLanguage: { ...str(80), pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$', description: 'a BCP-47 language tag such as en or zh-TW' },
      targetProfileIds: idList(10, { minItems: 1 }),
      sourceProfileId: nullable(str(200)),
      personas: nullable(list(PERSONA_SCHEMA, 5)),
      requirements: strictObject({
        allowedPlatforms: list({ enum: PLATFORMS }, PLATFORMS.length, { minItems: 1, uniqueItems: true }),
        allowedFormats: list({ enum: POST_FORMATS }, POST_FORMATS.length, { minItems: 1, uniqueItems: true }),
        content: list(strictObject({ instruction: str(500), sourceExcerpt: str(500) }, ['instruction', 'sourceExcerpt']), 20),
      }),
      keywords: list(str(60), 20, { uniqueItems: true }),
      sources: strictObject({
        rssUrls: list({ ...str(2000), pattern: '^https?://\\S+$', description: 'an http(s) URL' }, 10, { uniqueItems: true }),
        competitorUsernames: list(
          strictObject({ provider: { enum: COMPETITOR_PROVIDERS }, username: str(100) }, ['provider', 'username']),
          10,
          { uniqueItems: true },
        ),
        assetIds: idList(20),
        ownPosts: { type: 'boolean' },
        threadsTrends: { type: 'boolean' },
      }),
    },
    ['name', 'brief', 'contentLanguage', 'targetProfileIds'],
  ),
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function validate(schema, value, at, issues) {
  const add = (message) => issues.push({ path: at || '(root)', message });
  if ('const' in schema && value !== schema.const) return add(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) return add(`must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`);
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const actual = typeOf(value);
    const matches = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!matches) return add(`must be ${allowed.join(' or ')} (got ${actual})`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) add('must not be empty');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`is ${value.length} characters; max ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) add(schema.description ? `must be ${schema.description}` : `must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`has ${value.length} items; max ${schema.maxItems}`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) add('has duplicate items');
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`, issues));
  }
  if (schema.oneOf) {
    const attempts = schema.oneOf.map((branch) => {
      const found = [];
      validate(branch, value, at, found);
      return found;
    });
    if (!attempts.some((found) => found.length === 0)) {
      issues.push(...attempts.reduce((best, found) => (found.length < best.length ? found : best)));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) issues.push({ path: at ? `${at}.${key}` : key, message: 'is required' });
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = at ? `${at}.${key}` : key;
      if (schema.properties[key]) validate(schema.properties[key], entry, child, issues);
      else if (schema.additionalProperties === false) issues.push({ path: child, message: 'is not an allowed field' });
    }
  }
  return undefined;
}

function checkPostsBundle(bundle, issues) {
  if (!Array.isArray(bundle.posts)) return;
  bundle.posts.forEach((post, index) => {
    if (!post || typeof post !== 'object') return;
    const at = `posts[${index}]`;
    const evidence = Array.isArray(post.evidence) ? post.evidence : [];
    const inRange = (value) => Number.isInteger(value) && value >= 0 && value < evidence.length;
    if (evidence.length > 0 && post.primaryEvidence === undefined) {
      issues.push({ path: `${at}.primaryEvidence`, message: 'is required when evidence is not empty' });
    }
    if (post.primaryEvidence !== undefined && !inRange(post.primaryEvidence)) {
      issues.push({ path: `${at}.primaryEvidence`, message: `must index evidence (0..${evidence.length - 1}); got ${post.primaryEvidence}` });
    }
    (Array.isArray(post.claims) ? post.claims : []).forEach((claim, claimIndex) => {
      if (claim && claim.evidence !== undefined && !inRange(claim.evidence)) {
        issues.push({ path: `${at}.claims[${claimIndex}].evidence`, message: `must index evidence (0..${evidence.length - 1}); got ${claim.evidence}` });
      }
    });
    if (post.whyNowCategory && post.whyNowCategory !== 'evergreen' && evidence.length === 0) {
      issues.push({ path: `${at}.whyNowCategory`, message: `${post.whyNowCategory} needs cited evidence; use evergreen or cite a signal` });
    }
    if (typeof post.plannedDate === 'string' && DATE.test(post.plannedDate) && !isRealDate(post.plannedDate)) {
      issues.push({ path: `${at}.plannedDate`, message: 'is not a real date' });
    }
    if (post.assetId && !post.assetReason) {
      issues.push({ path: `${at}.assetReason`, message: 'is required when assetId is set' });
    }
    checkUnique(post.formatPlan, 'socialProfileId', `${at}.formatPlan`, 'appears twice; plan one format per account', issues);
    checkUnique(post.drafts, 'socialProfileId', `${at}.drafts`, 'appears twice; send one draft per account', issues);
  });
}

function retiredPostsFormat(bundle) {
  return bundle.format === 'bichon-ideation-run/v1'
    ? [{ path: 'format', message: `bichon-ideation-run/v1 is retired: send a bichon-posts/v1 bundle with posts:submit, each post carrying its drafts (${SCRIPT} schema --bundle posts)` }]
    : [];
}

function checkUnique(entries, field, at, message, issues) {
  const seen = new Set();
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (!entry || typeof entry[field] !== 'string') return;
    if (seen.has(entry[field])) issues.push({ path: `${at}[${index}].${field}`, message });
    seen.add(entry[field]);
  });
}

function checkDraftsBundle(bundle, issues) {
  checkUnique(bundle.drafts, 'socialProfileId', 'drafts', 'appears twice; send one draft per account', issues);
}

function checkResearchBundle(bundle, issues) {
  checkUnique(bundle.items, 'itemRef', 'items', 'appears twice; analyze each item once', issues);
  (Array.isArray(bundle.items) ? bundle.items : []).forEach((item, index) => {
    if (item && typeof item.engagementRead === 'string' && /\d/.test(item.engagementRead)) {
      issues.push({ path: `items[${index}].engagementRead`, message: 'must describe engagement in words, relative to the author baseline; no numbers' });
    }
  });
}

function checkCapturesBundle(bundle, issues) {
  checkUnique(bundle.items, 'url', 'items', 'appears twice; capture each URL once', issues);
  (Array.isArray(bundle.items) ? bundle.items : []).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    if (item.kind !== 'article' && item.kind !== undefined && !item.username) {
      issues.push({ path: `items[${index}].username`, message: `is required for a ${item.kind}` });
    }
    if (typeof item.publishedAt === 'string' && Number.isNaN(Date.parse(item.publishedAt))) {
      issues.push({ path: `items[${index}].publishedAt`, message: 'must be an ISO 8601 date; leave it out when unknown' });
    }
  });
}

function checkSetupPatch(setup, issues) {
  if (Object.keys(setup).length === 0) issues.push({ path: '(root)', message: 'sets no fields; name at least one to change' });
}

// Ad params are Meta Marketing API fields, checked against the same allowlist
// the server forwards (convex/lib/metaAds.ts checkAdParams).
const AD_OBJECTIVES = ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'];
const AD_BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'];
const adText = (max, values) => ({ type: 'string', max, values });
const adName = adText(400);
const adTime = adText(40);
const adMoney = { type: 'money' };
const adId = { type: 'id' };
const adObject = { type: 'object' };
const adArray = { type: 'array' };
const AD_PARAMS = {
  campaign: {
    fields: {
      name: adName,
      objective: adText(undefined, AD_OBJECTIVES),
      special_ad_categories: adArray,
      special_ad_category_country: adArray,
      buying_type: adText(40),
      bid_strategy: adText(undefined, AD_BID_STRATEGIES),
      daily_budget: adMoney,
      lifetime_budget: adMoney,
      spend_cap: adMoney,
      start_time: adTime,
      stop_time: adTime,
      is_adset_budget_sharing_enabled: { type: 'boolean' },
    },
    required: ['name', 'objective'],
    createOnly: ['objective', 'buying_type'],
  },
  adset: {
    fields: {
      name: adName,
      campaign_id: adId,
      optimization_goal: adText(80),
      billing_event: adText(80),
      targeting: adObject,
      daily_budget: adMoney,
      lifetime_budget: adMoney,
      bid_amount: adMoney,
      bid_strategy: adText(undefined, AD_BID_STRATEGIES),
      start_time: adTime,
      end_time: adTime,
      promoted_object: adObject,
      destination_type: adText(80),
      attribution_spec: adArray,
      pacing_type: adArray,
      frequency_control_specs: adArray,
      is_dynamic_creative: { type: 'boolean' },
      daily_min_spend_target: adMoney,
      daily_spend_cap: adMoney,
      lifetime_min_spend_target: adMoney,
      lifetime_spend_cap: adMoney,
      dsa_beneficiary: adText(200),
      dsa_payor: adText(200),
      regional_regulated_categories: adArray,
      regional_regulation_identities: adObject,
    },
    required: ['name', 'campaign_id', 'optimization_goal', 'targeting'],
    createOnly: ['campaign_id'],
  },
  creative: {
    fields: {
      name: adName,
      object_story_spec: adObject,
      object_story_id: adText(80),
      asset_feed_spec: adObject,
      source_instagram_media_id: adId,
      instagram_user_id: adId,
      url_tags: adText(2000),
      degrees_of_freedom_spec: adObject,
      contextual_multi_ads: adObject,
      product_set_id: adId,
    },
    required: ['name'],
    createOnly: [],
    oneOf: ['object_story_spec', 'object_story_id', 'asset_feed_spec', 'source_instagram_media_id'],
  },
  ad: {
    fields: {
      name: adName,
      adset_id: adId,
      creative: adObject,
      tracking_specs: adArray,
      conversion_domain: adText(255),
    },
    required: ['name', 'adset_id', 'creative'],
    createOnly: ['adset_id'],
  },
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function adFieldIssue(spec, value) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
      if (spec.values && !spec.values.includes(value)) return `must be one of ${spec.values.join(', ')}`;
      if (spec.max !== undefined && value.length > spec.max) return `is ${value.length} characters; max ${spec.max}`;
      return null;
    case 'id':
      return typeof value === 'string' && META_ID.test(value) ? null : 'must be a Meta id (digits, as a string)';
    case 'money':
      return Number.isInteger(value) && value > 0
        ? null
        : 'must be a positive integer in the smallest currency unit (amount × budgetUnitsPerCurrency)';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be boolean';
    case 'object':
      return isPlainObject(value) ? null : 'must be an object';
    default:
      return Array.isArray(value) ? null : 'must be an array';
  }
}

// What an ad tests. Bichon keeps it with the ad's copy and never sends it to Meta.
const AD_BRIEF_SCHEMA = strictObject(
  { angle: str(300), hook: str(300), personaKey: str(80), offer: str(200), coreMessage: str(500), ideaId: str(64) },
  ['angle', 'hook'],
);

function checkAdParams(kind, mode, body, issues) {
  const { fields, required, createOnly, oneOf } = AD_PARAMS[kind];
  const { brief, ...params } = body;
  const briefed = brief !== undefined;
  if (briefed && kind !== 'ad') {
    issues.push({ path: 'brief', message: 'goes on ads only (--kind ad)' });
  } else if (briefed) {
    validate(AD_BRIEF_SCHEMA, brief, 'brief', issues);
  } else if (kind === 'ad' && mode === 'create') {
    issues.push({ path: 'brief', message: 'is required: say what this ad tests ({ angle, hook, personaKey?, offer?, coreMessage?, ideaId? })' });
  }
  for (const [key, value] of Object.entries(params)) {
    if (key === 'status' && kind !== 'creative') {
      if (value !== 'PAUSED') issues.push({ path: key, message: 'may only be PAUSED; a manager activates ads in the Bichon dashboard' });
      continue;
    }
    const spec = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
    if (!spec) {
      issues.push({ path: key, message: `is not an allowed field (allowed: ${Object.keys(fields).join(', ')})` });
    } else if (mode === 'update' && createOnly.includes(key)) {
      issues.push({ path: key, message: 'cannot be changed after creation' });
    } else {
      const message = adFieldIssue(spec, value);
      if (message) issues.push({ path: key, message });
    }
  }
  if (kind === 'ad' && isPlainObject(params.creative) && !(typeof params.creative.creative_id === 'string' && META_ID.test(params.creative.creative_id))) {
    issues.push({ path: 'creative.creative_id', message: 'must be the id of a creative in this ad account' });
  }
  if (mode === 'update') {
    if (Object.keys(params).length === 0 && !briefed) issues.push({ path: '(root)', message: 'has no field to update' });
    return;
  }
  for (const key of required) {
    if (params[key] === undefined) issues.push({ path: key, message: 'is required' });
  }
  if (oneOf && !oneOf.some((key) => params[key] !== undefined)) {
    issues.push({ path: '(root)', message: `needs one of ${oneOf.join(', ')}` });
  }
}

const countOf = (value) => (Array.isArray(value) ? value.length : 0);

function adBundles() {
  const entry = (kind, mode) => ({
    schema: { type: 'object' },
    check: (params, issues) => checkAdParams(kind, mode, params, issues),
    counts: (params) => ({ fields: Object.keys(params).length }),
  });
  return Object.fromEntries([
    ...AD_KINDS.map((kind) => [`ad-${kind}`, entry(kind, 'create')]),
    ...AD_UPDATE_KINDS.map((kind) => [`ad-${kind}-update`, entry(kind, 'update')]),
  ]);
}

const CREATIVE_STATUSES = ['changes_requested', 'submitted', 'approved', 'rejected'];
const adCopySchema = strictObject({
  primaryText: str(5000),
  headline: str(255),
  description: str(255),
  callToAction: str(50),
  link: str(2000),
});
const adClaimEntrySchema = strictObject({ topic: str(100, 0), text: str(1000), note: str(1000, 0) }, ['text']);
const adProductFields = {
  name: str(100),
  bannedNames: list(str(100), 30),
  pageUrl: str(2000, 0),
  claimLabels: list(
    strictObject({ ingredient: str(100), label: str(200), shortLabel: str(100, 0), avoid: list(str(200), 10) }, ['ingredient', 'label', 'avoid']),
    40,
  ),
  canSay: list(adClaimEntrySchema, 60),
  cannotSay: list(adClaimEntrySchema, 60),
  listingCopy: strictObject({
    primaryText: str(5000, 0),
    headline: str(255, 0),
    description: str(255, 0),
    callToAction: str(50, 0),
    link: str(2000, 0),
    utmTemplate: str(1000, 0),
  }),
};
const adRuleFields = {
  productId: str(64, 0),
  kind: { enum: ['visual', 'wording', 'compliance'] },
  text: str(2000),
  acceptedExamples: list(str(500), 20),
  rejectedExamples: list(str(500), 20),
  source: str(200, 0),
  setOn: { ...str(10), pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  status: { enum: ['active', 'retired'] },
};
const pickFields = (fields, names) => Object.fromEntries(Object.entries(fields).filter(([name]) => names.includes(name)));
const adBundleSchema = (id, title, properties, required) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `urn:bichon:schema:${id}:v1`,
  title,
  ...strictObject({ format: { const: `bichon-${id}/v1` }, agent: agentSchema, ...properties }, ['format', 'agent', ...required]),
});
const AD_PRODUCT_SCHEMA = adBundleSchema('ad-product', 'AdProduct', { product: strictObject(adProductFields, ['name']) }, ['product']);
const AD_PRODUCT_PATCH_SCHEMA = adBundleSchema('ad-product-patch', 'AdProductPatch', { patch: strictObject(adProductFields) }, ['patch']);
const AD_RULE_SCHEMA = adBundleSchema('ad-rule', 'AdRule', { rule: strictObject(adRuleFields, ['kind', 'text']) }, ['rule']);
const AD_RULE_PATCH_SCHEMA = adBundleSchema('ad-rule-patch', 'AdRulePatch', { patch: strictObject(adRuleFields) }, ['patch']);
const AD_ITERATION_SCHEMA = adBundleSchema('ad-iteration', 'AdIteration', { productId: str(64), name: str(100), note: str(2000, 0) }, ['productId', 'name']);
const ruleFlagsSchema = list(strictObject({ ruleId: str(64), note: str(500) }, ['ruleId', 'note']), 20);
const AD_CREATIVE_SCHEMA = adBundleSchema(
  'ad-creative',
  'AdCreative',
  {
    creative: strictObject(
      {
        title: str(200),
        angle: str(300),
        hook: str(300),
        format: str(100),
        utmCreative: { ...str(100), pattern: '^[a-z0-9][a-z0-9._-]*$' },
        copy: adCopySchema,
      },
      ['title', 'angle', 'hook', 'format', 'utmCreative'],
    ),
    prompt: str(20000),
    onImageText: str(4000, 0),
    ruleFlags: ruleFlagsSchema,
  },
  ['creative', 'prompt', 'onImageText'],
);
const AD_REVISION_SCHEMA = adBundleSchema(
  'ad-revision',
  'AdRevision',
  {
    basedOnRevision: { type: 'integer', minimum: 1 },
    prompt: str(20000),
    onImageText: str(4000, 0),
    responseNote: str(2000),
    copy: { ...adCopySchema, type: ['object', 'null'] },
    ruleFlags: ruleFlagsSchema,
  },
  ['basedOnRevision', 'prompt', 'onImageText', 'responseNote'],
);

function exifRotated(bytes, at) {
  if (bytes.toString('latin1', at + 4, at + 10) !== 'Exif\0\0') return false;
  return tiffRotated(bytes, at + 10);
}

function tiffRotated(bytes, tiff) {
  const little = bytes.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (offset) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
  try {
    const directory = tiff + (little ? bytes.readUInt32LE(tiff + 4) : bytes.readUInt32BE(tiff + 4));
    for (let index = 0; index < u16(directory); index += 1) {
      const entry = directory + 2 + index * 12;
      if (u16(entry) === 0x0112) return u16(entry + 8) > 1;
    }
  } catch {
    return false;
  }
  return false;
}

// The intrinsic size from the file's header, without an image library.
function pngRotated(bytes) {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') return false;
    if (type === 'eXIf') return tiffRotated(bytes, at + 8);
    at += 12 + bytes.readUInt32BE(at);
  }
  return false;
}

function webpRotated(bytes) {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('latin1', at, at + 4) === 'EXIF') {
      const start = at + 8;
      return tiffRotated(bytes, bytes.toString('latin1', start, start + 6) === 'Exif\0\0' ? start + 6 : start);
    }
    at += 8 + size + (size & 1);
  }
  return false;
}

function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.toString('latin1', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), rotated: pngRotated(bytes) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    let rotated = false;
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5), rotated };
      }
      if (marker === 0xe1 && exifRotated(bytes, at)) rotated = true;
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    const rotated = webpRotated(bytes);
    if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, rotated };
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, rotated };
    }
    if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, rotated };
  }
  return null;
}

async function sendWithImage(parsed, config, kind, route) {
  const bundle = loadBundle(parsed, kind);
  const upload = readUploadFile(parsed, IMAGE_TYPES, 'a JPEG, PNG or WebP image', 'image');
  const size = imageDimensions(upload.bytes);
  if (!size) throw new CliError('invalid_request', `Could not read the size of ${upload.file}.`);
  if (size.rotated) throw new CliError('invalid_request', `${upload.file} carries an EXIF rotation. Export it upright.`);
  if (parsed['dry-run']) {
    return succeed({ valid: true, dryRun: true, bundle: kind, image: { width: size.width, height: size.height, contentType: upload.contentType, bytes: upload.bytes.byteLength } });
  }
  const { key } = await uploadToStorage(config, brandRoute('/ad-review')(parsed), upload);
  return emit(await api(config, 'POST', route(parsed), { body: { ...bundle, image: { key, width: size.width, height: size.height } } }));
}

async function addCutout(parsed, config) {
  const route = productRoute('/cutouts')(parsed);
  const upload = readUploadFile(parsed, IMAGE_TYPES, 'a JPEG, PNG or WebP image');
  const { key } = await uploadToStorage(config, route, upload);
  const label = optionalOption(parsed, 'label') || path.basename(upload.file);
  return emit(await api(config, 'POST', route, { body: { key, label } }));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

// Every PNG decodes here, to 8-bit RGBA; only other formats need a tool.
function decodePng(bytes) {
  if (bytes.length < 33 || bytes.toString('latin1', 1, 4) !== 'PNG') return null;
  let at = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header || !(PNG_DEPTHS[header.color] || []).includes(header.depth) || header.interlace > 1) return null;
  if (header.color === 3 && !palette) return null;
  const { width, height, depth, color, interlace } = header;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const pixelBytes = Math.max(1, (channels * depth) >> 3);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const rgba = Buffer.alloc(width * height * 4);
  const sampleOf = (line, index) => {
    if (depth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
    if (depth === 8) return line[index];
    const bit = index * depth;
    return (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const to8Bit = (sample) => (depth === 16 ? sample >> 8 : depth === 8 ? sample : Math.round((sample * 255) / ((1 << depth) - 1)));
  const key = (index) => transparency.readUInt16BE(index * 2);
  let offset = 0;
  for (const [startX, startY, stepX, stepY] of interlace === 1 ? ADAM7 : [[0, 0, 1, 1]]) {
    const columns = Math.ceil((width - startX) / stepX);
    const rows = Math.ceil((height - startY) / stepY);
    if (columns <= 0 || rows <= 0) continue;
    const stride = Math.ceil((columns * channels * depth) / 8);
    if (raw.length < offset + (stride + 1) * rows) return null;
    const line = Buffer.alloc(stride);
    const previous = Buffer.alloc(stride);
    for (let row = 0; row < rows; row += 1) {
      const filter = raw[offset];
      for (let x = 0; x < stride; x += 1) {
        const left = x >= pixelBytes ? line[x - pixelBytes] : 0;
        const up = previous[x];
        const corner = x >= pixelBytes ? previous[x - pixelBytes] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - corner;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - corner);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
        }
        line[x] = (raw[offset + 1 + x] + predictor) & 0xff;
      }
      offset += stride + 1;
      for (let column = 0; column < columns; column += 1) {
        const to = ((startY + row * stepY) * width + startX + column * stepX) * 4;
        const base = column * channels;
        const first = sampleOf(line, base);
        if (color === 3) {
          rgba[to] = palette[first * 3];
          rgba[to + 1] = palette[first * 3 + 1];
          rgba[to + 2] = palette[first * 3 + 2];
          rgba[to + 3] = transparency && first < transparency.length ? transparency[first] : 255;
        } else if (color === 0 || color === 4) {
          rgba[to] = rgba[to + 1] = rgba[to + 2] = to8Bit(first);
          const keyed = color === 0 && transparency && key(0) === first;
          rgba[to + 3] = color === 4 ? to8Bit(sampleOf(line, base + 1)) : keyed ? 0 : 255;
        } else {
          const second = sampleOf(line, base + 1);
          const third = sampleOf(line, base + 2);
          rgba[to] = to8Bit(first);
          rgba[to + 1] = to8Bit(second);
          rgba[to + 2] = to8Bit(third);
          const keyed = color === 2 && transparency && key(0) === first && key(1) === second && key(2) === third;
          rgba[to + 3] = color === 6 ? to8Bit(sampleOf(line, base + 3)) : keyed ? 0 : 255;
        }
      }
      line.copy(previous);
    }
  }
  return { width, height, rgba };
}

function pngChunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const named = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(named));
  return Buffer.concat([head, named, tail]);
}

function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// JPEG and WebP need a decoder; macOS has sips, elsewhere ImageMagick.
function convertToPng(file, directory) {
  const target = path.join(directory, '.decoded.png');
  const tools = [
    ['sips', ['-s', 'format', 'png', file, '--out', target]],
    ['magick', [file, target]],
    ['convert', [file, target]],
  ];
  for (const [command, args] of tools) {
    try {
      execFileSync(command, args, { stdio: 'ignore' });
      const decoded = decodePng(fs.readFileSync(target));
      fs.rmSync(target, { force: true });
      if (decoded) return decoded;
    } catch {
      fs.rmSync(target, { force: true });
    }
  }
  throw new CliError(
    'image_tool_missing',
    `Could not decode ${path.basename(file)}. Install ImageMagick (macOS sips also works), or upload creatives as 8-bit PNG.`,
  );
}

const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];

function fillRect(image, left, top, width, height, [r, g, b]) {
  const right = Math.min(left + width, image.width);
  const bottom = Math.min(top + height, image.height);
  for (let y = Math.max(top, 0); y < bottom; y += 1) {
    for (let x = Math.max(left, 0); x < right; x += 1) {
      const at = (y * image.width + x) * 4;
      image.rgba[at] = r;
      image.rgba[at + 1] = g;
      image.rgba[at + 2] = b;
      image.rgba[at + 3] = 255;
    }
  }
}

const BOX_COLOR = [230, 30, 90];
const WHITE = [255, 255, 255];

function drawBox(image, box, number) {
  const stroke = Math.max(3, Math.round(Math.min(image.width, image.height) / 300));
  const outline = (grow, color, thickness) => {
    const left = box.x - grow;
    const top = box.y - grow;
    const width = box.width + grow * 2;
    const height = box.height + grow * 2;
    fillRect(image, left, top, width, thickness, color);
    fillRect(image, left, top + height - thickness, width, thickness, color);
    fillRect(image, left, top, thickness, height, color);
    fillRect(image, left + width - thickness, top, thickness, height, color);
  };
  outline(stroke, WHITE, stroke);
  outline(0, BOX_COLOR, stroke);
  const digits = String(number).split('').map(Number);
  const scale = Math.max(3, Math.round(Math.min(image.width, image.height) / 160));
  const tagWidth = (digits.length * 4 + 1) * scale;
  const tagHeight = 7 * scale;
  const tagLeft = Math.min(box.x, image.width - tagWidth);
  const tagTop = Math.min(box.y, image.height - tagHeight);
  fillRect(image, tagLeft, tagTop, tagWidth, tagHeight, BOX_COLOR);
  digits.forEach((digit, index) => {
    [...DIGITS[digit]].forEach((pixel, cell) => {
      if (pixel !== '1') return;
      fillRect(
        image,
        tagLeft + scale + index * 4 * scale + (cell % 3) * scale,
        tagTop + scale + Math.floor(cell / 3) * scale,
        scale,
        scale,
        WHITE,
      );
    });
  });
}

function cropImage(image, box) {
  const rgba = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    image.rgba.copy(rgba, y * box.width * 4, from, from + box.width * 4);
  }
  return { width: box.width, height: box.height, rgba };
}

function regionBox({ x, y, width, height }, image) {
  const left = Math.min(Math.round(x * image.width), image.width - 1);
  const top = Math.min(Math.round(y * image.height), image.height - 1);
  const right = Math.min(Math.round((x + width) * image.width), image.width);
  const bottom = Math.min(Math.round((y + height) * image.height), image.height);
  return { x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) };
}

function imageExtension(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF') return '.webp';
  return '.png';
}

async function downloadImage(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new CliError('network_error', `Could not download the image (${(err && err.message) || 'unknown error'}).`);
  }
  if (!response.ok) throw new CliError('download_failed', `Storage refused the download (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

// Everything a revise run needs on disk: the image reviewed, one overlay with
// every box numbered, a crop per box and a manifest tying each note to it.
async function writeRegionFiles(parsed, config) {
  const directory = path.resolve(requireOption(parsed, 'out'));
  const creative = (await api(config, 'GET', creativeRoute()(parsed))).data;
  if (!creative.image || !creative.image.url) throw new CliError('image_unavailable', 'This revision has no readable image.');
  const bytes = await downloadImage(creative.image.url);
  fs.mkdirSync(directory, { recursive: true });
  const original = path.join(directory, `v${creative.revision}-original${imageExtension(bytes)}`);
  fs.writeFileSync(original, bytes);
  const decoded = decodePng(bytes) || convertToPng(original, directory);
  const overlay = { ...decoded, rgba: Buffer.from(decoded.rgba) };
  const regions = [];
  for (const comment of creative.comments) {
    for (const region of comment.regions) {
      const box = regionBox(region.normalized, decoded);
      const crop = path.join(directory, `region-${region.number}.png`);
      fs.writeFileSync(crop, encodePng(cropImage(decoded, box)));
      drawBox(overlay, box, region.number);
      regions.push({ number: region.number, note: region.note, author: comment.author, normalized: region.normalized, pixels: box, crop });
    }
  }
  const overlayFile = path.join(directory, 'overlay.png');
  fs.writeFileSync(overlayFile, encodePng(overlay));
  const manifest = path.join(directory, 'regions.json');
  const generalComments = creative.comments
    .filter((comment) => comment.body)
    .map((comment) => ({ author: comment.author, decision: comment.decision, body: comment.body }));
  writeJsonFile(manifest, {
    creativeId: creative.creativeId,
    revision: creative.revision,
    utmCreative: creative.utmCreative,
    image: { file: original, width: decoded.width, height: decoded.height },
    overlay: overlayFile,
    prompt: creative.prompt,
    onImageText: creative.onImageText,
    ruleFlags: creative.ruleFlags ?? [],
    copy: creative.copy,
    regions,
    generalComments,
  });
  return succeed({ creativeId: creative.creativeId, revision: creative.revision, manifest, overlay: overlayFile, original, regions: regions.length, generalComments: generalComments.length });
}

const BUNDLES = {
  'ad-product': { schema: AD_PRODUCT_SCHEMA, counts: () => ({ products: 1 }) },
  'ad-product-patch': { schema: AD_PRODUCT_PATCH_SCHEMA, counts: () => ({ products: 1 }) },
  'ad-rule': { schema: AD_RULE_SCHEMA, counts: () => ({ rules: 1 }) },
  'ad-rule-patch': { schema: AD_RULE_PATCH_SCHEMA, counts: () => ({ rules: 1 }) },
  'ad-iteration': { schema: AD_ITERATION_SCHEMA, counts: () => ({ iterations: 1 }) },
  'creative-review': { schema: AD_CREATIVE_SCHEMA, counts: () => ({ creatives: 1 }) },
  'creative-revision': { schema: AD_REVISION_SCHEMA, counts: () => ({ revisions: 1 }) },
  ...adBundles(),
  posts: {
    schema: POSTS_SCHEMA,
    check: checkPostsBundle,
    retired: retiredPostsFormat,
    counts: (bundle) => ({ posts: bundle.posts.length, drafts: bundle.posts.reduce((sum, post) => sum + post.drafts.length, 0) }),
  },
  drafts: { schema: DRAFTS_SCHEMA, check: checkDraftsBundle, counts: (bundle) => ({ drafts: bundle.drafts.length }) },
  setup: { schema: SETUP_SCHEMA, counts: (setup) => ({ fields: Object.keys(setup).length, personas: countOf(setup.personas), keywords: countOf(setup.keywords) }) },
  'setup-patch': { schema: { ...SETUP_SCHEMA, required: [] }, check: checkSetupPatch, counts: (setup) => ({ fields: Object.keys(setup).length }) },
  personas: { schema: PERSONAS_SCHEMA, counts: (file) => ({ personas: file.personas.length }) },
  research: { schema: RESEARCH_ANALYSES_SCHEMA, check: checkResearchBundle, counts: (bundle) => ({ items: bundle.items.length }) },
  captures: { schema: RESEARCH_CAPTURES_SCHEMA, check: checkCapturesBundle, counts: (bundle) => ({ items: bundle.items.length }) },
};
const SCHEMA_BUNDLES = ['posts', 'drafts', 'setup', 'personas', 'research', 'captures', 'ad-product', 'ad-product-patch', 'ad-rule', 'ad-rule-patch', 'ad-iteration', 'creative-review', 'creative-revision'];

function validateBundle(kind, bundle) {
  const issues = [];
  const { schema, check, retired } = BUNDLES[kind];
  const isObject = bundle && typeof bundle === 'object' && !Array.isArray(bundle);
  const hints = retired && isObject ? retired(bundle) : [];
  validate(schema, bundle, '', issues);
  if (check && isObject) check(bundle, issues);
  if (hints.length === 0) return issues;
  const hinted = new Set(hints.map((hint) => hint.path));
  return [...hints, ...issues.filter((issue) => !hinted.has(issue.path))];
}

function loadBundle(parsed, kind) {
  const file = path.resolve(requireOption(parsed, 'file'));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('invalid_request', `Cannot read ${file}: ${err.code || err.message}`);
  }
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (err) {
    throw new CliError('invalid_request', `${file} is not valid JSON: ${err.message}`);
  }
  const issues = validateBundle(kind, bundle);
  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_REPORTED_ISSUES);
    const summary = shown.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw new CliError(
      'validation_failed',
      `${path.basename(file)} failed ${kind} bundle validation (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${summary}${issues.length > 3 ? '; …' : ''}`,
      { source: 'client', file, issues: shown },
    );
  }
  return bundle;
}

async function runSetup(args) {
  const parsed = parseArgs(args);
  const apiKey = requireOption(parsed, 'api-key');
  if (!apiKey.startsWith(KEY_PREFIX)) {
    throw new CliError('invalid_request', `API keys start with ${KEY_PREFIX}. Create one in Bichon under the workspace "Run locally" panel.`);
  }
  activeApiKey = apiKey;
  const explicitBaseUrl = parsed['base-url'] === undefined ? undefined : normalizeBaseUrl(requireOption(parsed, 'base-url'), '--base-url');
  const resolved = explicitBaseUrl ? { baseUrl: explicitBaseUrl, baseUrlSource: 'option' } : resolveBaseUrl(undefined);
  const explicit = explicitConfigPath(parsed);
  const location = explicit ? 'explicit' : parsed.local ? 'local' : 'global';
  const filePath = explicit || (parsed.local ? localConfigPath() : globalConfigPath());
  let identity = null;
  if (!parsed['no-verify']) {
    identity = (await api({ apiKey, ...resolved }, 'GET', '/health')).data;
  }
  const existing = readJsonFile(filePath) || {};
  const next = { ...existing, apiKey };
  if (explicitBaseUrl) next.baseUrl = explicitBaseUrl;
  writeJsonFile(filePath, next, 0o600);
  succeed({
    status: 'configured',
    location,
    configPath: filePath,
    baseUrl: resolved.baseUrl,
    baseUrlSource: resolved.baseUrlSource,
    verified: Boolean(identity),
    keyPrefix: redactApiKey(apiKey),
    ...(identity ? { organizationId: identity.organizationId, keyName: identity.keyName, user: identity.user } : {}),
    ...(location === 'local' ? { hint: 'Add .bichon/ to .gitignore; the file holds the API key.' } : {}),
  });
}

function configView(config) {
  return {
    configured: true,
    source: config.source,
    configPath: config.configPath,
    baseUrl: config.baseUrl,
    baseUrlSource: config.baseUrlSource,
    keyPrefix: redactApiKey(config.apiKey),
  };
}

function withConfig(handler) {
  return async (args) => {
    const parsed = parseArgs(args);
    const config = requireConfig(parsed);
    activeApiKey = config.apiKey;
    return handler(parsed, config);
  };
}

function get(route, query) {
  return withConfig(async (parsed, config) => emit(await api(config, 'GET', route(parsed), { query: query && query(parsed) })));
}

function post(route, body) {
  return withConfig(async (parsed, config) => emit(await api(config, 'POST', route(parsed), { body: body && body(parsed) })));
}

// --out keeps large payloads (full context, raw research batches) out of the
// agent's transcript: the data goes to a file and only a summary is printed.
function getToFile(route, query, summarize) {
  return withConfig(async (parsed, config) => {
    const out = optionalOption(parsed, 'out');
    const result = await api(config, 'GET', route(parsed), { query: query && query(parsed) });
    if (!out) return emit(result);
    const file = path.resolve(out);
    writeJsonFile(file, result.data);
    return succeed({ written: file, bytes: fs.statSync(file).size, ...summarize(result.data || {}) });
  });
}

function del(route) {
  return withConfig(async (parsed, config) => emit(await api(config, 'DELETE', route(parsed))));
}

function readUploadFile(parsed, types, described, option = 'file') {
  const file = path.resolve(requireOption(parsed, option));
  const contentType = types[path.extname(file).toLowerCase()];
  if (!contentType) {
    throw new CliError('invalid_request', `--${option} must be ${described} (${Object.keys(types).join(', ')}).`);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new CliError('invalid_request', `Cannot read ${file}.`);
  }
  const kind = contentType.split('/')[0];
  const max = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > max) {
    throw new CliError('invalid_request', `${file} is ${bytes.byteLength} bytes; ${kind}s must be 1 byte to ${max} bytes.`);
  }
  return { file, contentType, bytes };
}

// A file reaches Bichon in three steps: a signed upload URL from
// `${route}/uploads`, the file PUT straight to storage, then the caller
// hands the returned key to `route`.
async function uploadToStorage(config, route, { file, contentType, bytes }) {
  const upload = (await api(config, 'POST', `${route}/uploads`, { body: { contentType } })).data;
  let response;
  try {
    response = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CliError('network_error', `Could not upload ${file} to storage (${(err && err.message) || 'unknown error'}).`);
  }
  if (!response.ok) {
    throw new CliError('upload_failed', `Storage refused the upload (HTTP ${response.status}).`);
  }
  return upload;
}

async function addDraftMedia(parsed, config) {
  const mediaRoute = idRoute('drafts', 'id', '/media')(parsed);
  const upload = readUploadFile(parsed, IMAGE_TYPES, 'a JPEG, PNG or WebP image');
  const { key } = await uploadToStorage(config, mediaRoute, upload);
  const attached = await api(config, 'POST', mediaRoute, { body: { key, contentType: upload.contentType } });
  return succeed({ ...attached.data, contentType: upload.contentType, bytes: upload.bytes.byteLength });
}

async function addAdMedia(parsed, config) {
  const mediaRoute = brandRoute('/ads/media')(parsed);
  const name = optionalOption(parsed, 'name');
  if (name !== undefined && name.length > 100) throw new CliError('invalid_request', '--name must be 1 to 100 characters.');
  const upload = readUploadFile(parsed, AD_MEDIA_TYPES, 'a JPEG or PNG image, or an MP4 or MOV video');
  const { key } = await uploadToStorage(config, mediaRoute, upload);
  const added = await api(config, 'POST', mediaRoute, { body: name === undefined ? { key } : { key, name }, query: { accountId: accountOption(parsed) } });
  return succeed({ ...added.data, contentType: upload.contentType, bytes: upload.bytes.byteLength });
}

function adsInsightsQuery(parsed) {
  const range = enumOption(parsed, 'range', ADS_RANGES);
  const since = dateOption(parsed, 'since');
  const until = dateOption(parsed, 'until');
  if (range && (since || until)) throw new CliError('invalid_request', 'Give either --range or --since and --until, not both.');
  if (Boolean(since) !== Boolean(until)) throw new CliError('invalid_request', '--since and --until go together.');
  if (since && since > until) throw new CliError('invalid_request', '--since must not be after --until.');
  const sort = enumOption(parsed, 'sort', ADS_SORTS);
  const order = enumOption(parsed, 'order', ['asc', 'desc']);
  if (order && !sort) throw new CliError('invalid_request', '--order needs --sort.');
  return {
    level: enumOption(parsed, 'level', ADS_LEVELS),
    range,
    since,
    until,
    daily: flagOption(parsed, 'daily') ? 1 : undefined,
    breakdown: enumOption(parsed, 'breakdown', ADS_BREAKDOWNS),
    campaignId: metaIdsOption(parsed, 'campaign'),
    adsetId: metaIdsOption(parsed, 'adset'),
    adId: metaIdOption(parsed, 'ad'),
    sort,
    order,
    compare: flagOption(parsed, 'compare') ? 1 : undefined,
    limit: integerOption(parsed, 'limit', 1, 500),
    accountId: accountOption(parsed),
  };
}

const TABLE_ROWS = 20;

// A ranked Markdown table of the rows for the manager: spend with its share,
// the result and what it cost, the purchase funnel's end, and click quality.
function insightsTable(data) {
  const currency = data.account && data.account.currency;
  const money = (value) => (value === null || value === undefined ? '—' : `${currency} ${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const count = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US'));
  const percent = (value) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(2)}%`);
  const rows = data.rows || [];
  // Shares of a truncated read would only count the rows that came back.
  const spendTotal = data.totals ? data.totals.spend : data.truncated ? 0 : rows.reduce((sum, row) => sum + (row.spend || 0), 0);
  const label = (row) => [row.name || row.id || data.level, row.date, row.breakdown].filter(Boolean).join(' · ').replace(/\|/g, '/');
  const lines = [
    '| # | Row | Spend | Share | Results | Cost / result | Purchases | ROAS | CTR (link) | CPC (link) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.slice(0, TABLE_ROWS).map((row, index) => `| ${index + 1} | ${label(row)} | ${money(row.spend)} | ${spendTotal > 0 ? `${Math.round((row.spend / spendTotal) * 100)}%` : '—'} | ${count(row.results)} | ${money(row.costPerResult)} | ${count(row.purchases)} | ${row.purchaseRoas === null || row.purchaseRoas === undefined ? '—' : Number(row.purchaseRoas).toFixed(2)} | ${percent(row.linkCtr)} | ${money(row.costPerLinkClick)} |`),
  ];
  if (rows.length > TABLE_ROWS) lines.push('', `${rows.length - TABLE_ROWS} more rows not shown.`);
  if (data.totals && data.previous) {
    const change = (now, before) => (now === null || before === null || before === undefined || before === 0 ? '—' : `${now >= before ? '+' : ''}${(((now - before) / before) * 100).toFixed(0)}%`);
    const t = data.totals;
    const p = data.previous.totals;
    lines.push(
      '',
      `| ${data.range.since} – ${data.range.until} | This period | ${data.previous.range.since} – ${data.previous.range.until} | Change |`,
      '|---|---:|---:|---:|',
      `| Spend | ${money(t.spend)} | ${money(p.spend)} | ${change(t.spend, p.spend)} |`,
      `| Results | ${count(t.results)} | ${count(p.results)} | ${change(t.results, p.results)} |`,
      `| Cost / result | ${money(t.costPerResult)} | ${money(p.costPerResult)} | ${change(t.costPerResult, p.costPerResult)} |`,
      `| Purchases | ${count(t.purchases)} | ${count(p.purchases)} | ${change(t.purchases, p.purchases)} |`,
      `| ROAS | ${t.purchaseRoas === null ? '—' : t.purchaseRoas.toFixed(2)} | ${p.purchaseRoas === null ? '—' : p.purchaseRoas.toFixed(2)} | ${change(t.purchaseRoas, p.purchaseRoas)} |`,
      `| CTR (link) | ${percent(t.linkCtr)} | ${percent(p.linkCtr)} | ${change(t.linkCtr, p.linkCtr)} |`,
      `| CPM | ${money(t.cpm)} | ${money(p.cpm)} | ${change(t.cpm, p.cpm)} |`,
    );
  }
  return lines.join('\n');
}

async function readInsights(parsed, config) {
  const table = flagOption(parsed, 'table');
  const result = await api(config, 'GET', brandRoute('/ads/insights')(parsed), { query: adsInsightsQuery(parsed) });
  if (table && result.data) result.data = { ...result.data, table: insightsTable(result.data) };
  return emit(result);
}

// Days are read in this machine's time zone: --until is inclusive, so the
// window ends at the next local midnight.
function localMidnight(date, addDays = 0) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day + addDays).getTime();
}

function publicationsQuery(parsed) {
  const month = optionalOption(parsed, 'month');
  const since = dateOption(parsed, 'since');
  const until = dateOption(parsed, 'until');
  if (month !== undefined && !MONTH.test(month)) throw new CliError('invalid_request', '--month must be YYYY-MM.');
  if (month && (since || until)) throw new CliError('invalid_request', 'Give either --month or --since and --until, not both.');
  if (!month && !(since && until)) throw new CliError('invalid_request', 'Give --month YYYY-MM, or --since and --until.');
  if (since && since > until) throw new CliError('invalid_request', '--since must not be after --until.');
  const [year, monthNumber] = (month || '').split('-').map(Number);
  return {
    from: month ? new Date(year, monthNumber - 1, 1).getTime() : localMidnight(since),
    to: month ? new Date(year, monthNumber, 1).getTime() : localMidnight(until, 1),
    campaignId: optionalOption(parsed, 'campaign'),
    status: enumOption(parsed, 'status', PUBLICATION_STATUSES),
  };
}

function summarizePublications(data) {
  const rows = Array.isArray(data.publications) ? data.publications : [];
  const statuses = {};
  const reads = { at24h: {}, at7d: {} };
  for (const row of rows) {
    statuses[row.status] = (statuses[row.status] || 0) + 1;
    for (const checkpoint of ['at24h', 'at7d']) {
      const state = row.reads && row.reads[checkpoint] ? row.reads[checkpoint].state : null;
      if (state) reads[checkpoint][state] = (reads[checkpoint][state] || 0) + 1;
    }
  }
  return {
    publications: rows.length,
    statuses,
    withPermalink: rows.filter((row) => row.permalink).length,
    reads,
    truncated: Boolean(data.truncated),
  };
}

function adsListQuery(parsed) {
  const kind = requiredEnumOption(parsed, 'kind', AD_LIST_KINDS);
  const campaignId = metaIdOption(parsed, 'campaign');
  const adsetId = metaIdOption(parsed, 'adset');
  if (campaignId && (kind === 'campaigns' || kind === 'creatives')) {
    throw new CliError('invalid_request', '--campaign filters adsets and ads only.');
  }
  if (adsetId && kind !== 'ads') throw new CliError('invalid_request', '--adset filters ads only.');
  return { campaignId, adsetId, limit: integerOption(parsed, 'limit', 1, 200) };
}

function adsTargetingQuery(parsed) {
  const type = requiredEnumOption(parsed, 'type', TARGETING_TYPES);
  const q = requireOption(parsed, 'q');
  if (q.length > 100) throw new CliError('invalid_request', '--q must be 1 to 100 characters.');
  return { type, q };
}

const idRoute = (collection, option, suffix = '') => (parsed) => `/${collection}/${segment(requireOption(parsed, option))}${suffix}`;
const campaignRoute = (suffix) => idRoute('campaigns', 'campaign', suffix);
const brandRoute = (suffix) => idRoute('brands', 'brand', suffix);

async function submitBundle(parsed, config, kind, route, { method = 'POST', extra = {}, query } = {}) {
  const bundle = loadBundle(parsed, kind);
  if (parsed['dry-run']) {
    return succeed({ valid: true, dryRun: true, bundle: kind, counts: BUNDLES[kind].counts(bundle) });
  }
  return emit(await api(config, method, route, { body: { ...bundle, ...extra }, query }));
}

function sendFile(kind, route, options) {
  return withConfig((parsed, config) => submitBundle(parsed, config, kind, route(parsed), options && options(parsed)));
}

const productRoute = (suffix = '') => (parsed) => `${brandRoute('/ad-book/products')(parsed)}/${segment(requireOption(parsed, 'id'))}${suffix}`;
const adRuleRoute = (parsed) => `${brandRoute('/ad-book/rules')(parsed)}/${segment(requireOption(parsed, 'id'))}`;
const creativeRoute = (suffix = '') => (parsed) => `${brandRoute('/ad-review/creatives')(parsed)}/${segment(requireOption(parsed, 'id'))}${suffix}`;
const iterationCreativesRoute = (parsed) => `${brandRoute('/ad-review/iterations')(parsed)}/${segment(requireOption(parsed, 'iteration'))}/creatives`;

const COMMANDS = {
  setup: runSetup,
  config: async (args) => {
    const config = resolveConfig(parseArgs(args));
    succeed(config ? configView(config) : { configured: false, setup: `${SCRIPT} setup --api-key ${KEY_PREFIX}<secret>` });
  },
  health: withConfig(async (parsed, config) => {
    const result = await api(config, 'GET', '/health');
    succeed({ ...result.data, config: configView(config) });
  }),
  brands: get(() => '/brands'),
  campaigns: get(
    brandRoute('/campaigns'),
    (parsed) => ({ status: enumOption(parsed, 'status', CAMPAIGN_STATUSES) }),
  ),
  context: getToFile(campaignRoute('/context'), undefined, (data) => ({
    versions: data.versions || null,
    campaign: data.campaign ? { id: data.campaign.id, name: data.campaign.name, contentLanguage: data.campaign.contentLanguage || null } : null,
    research: data.research || null,
    counts: {
      personas: countOf(data.personas),
      accounts: countOf(data.accounts),
      formatMenu: countOf(data.formatMenu),
      priorIdeas: countOf(data.priorIdeas),
    },
  })),
  evidence: get(
    campaignRoute('/evidence'),
    (parsed) => ({
      q: optionalOption(parsed, 'q'),
      limit: integerOption(parsed, 'limit', 1, 50),
      kind: enumOption(parsed, 'kind', ITEM_KINDS),
    }),
  ),
  competitors: get(brandRoute('/competitors')),
  ideas: get(
    campaignRoute('/ideas'),
    (parsed) => ({ status: enumOption(parsed, 'status', IDEA_STATUSES) }),
  ),
  'posts:submit': sendFile('posts', campaignRoute('/posts')),
  'run:get': get(idRoute('ideation-runs', 'id')),
  'post:date': withConfig(async (parsed, config) => {
    const date = dateOption(parsed, 'date');
    const clear = flagOption(parsed, 'clear');
    if (Boolean(date) === Boolean(clear)) throw new CliError('invalid_request', 'Give either --date YYYY-MM-DD or --clear.');
    return emit(await api(config, 'PATCH', idRoute('ideas', 'idea')(parsed), { body: { plannedDate: date || null } }));
  }),
  'post:title': withConfig(async (parsed, config) => {
    const title = requireOption(parsed, 'title');
    if (title.length > 200) throw new CliError('invalid_request', '--title takes at most 200 characters.');
    return emit(await api(config, 'PATCH', idRoute('ideas', 'idea')(parsed), { body: { title } }));
  }),
  'drafts:submit': sendFile('drafts', idRoute('ideas', 'idea', '/drafts')),
  'draft:get': get(idRoute('drafts', 'id')),
  'draft:title': withConfig(async (parsed, config) => {
    const title = optionalOption(parsed, 'title');
    const rawNote = parsed['variant-note'];
    if (rawNote === true) throw new CliError('invalid_request', "Missing --variant-note <value> (pass '' to clear it).");
    const variantNote = rawNote === undefined ? undefined : rawNote.trim();
    if (title === undefined && variantNote === undefined) throw new CliError('invalid_request', 'Give --title <text>, --variant-note <text> or both.');
    if (title !== undefined && title.length > 200) throw new CliError('invalid_request', '--title takes at most 200 characters.');
    if (variantNote !== undefined && variantNote.length > 1000) throw new CliError('invalid_request', '--variant-note takes at most 1000 characters.');
    return emit(await api(config, 'PATCH', idRoute('drafts', 'id')(parsed), { body: { ...(title !== undefined ? { title } : {}), ...(variantNote !== undefined ? { variantNote } : {}) } }));
  }),
  'draft:submit': post(idRoute('drafts', 'id', '/submit'), () => ({})),
  'draft:media:add': withConfig(addDraftMedia),
  'draft:media:remove': del((parsed) => `${idRoute('drafts', 'id')(parsed)}${idRoute('media', 'media')(parsed)}`),
  reviews: get(
    campaignRoute('/reviews'),
    (parsed) => ({
      status: enumOption(parsed, 'status', REVIEW_STATUSES),
      history: flagOption(parsed, 'history') ? 1 : undefined,
    }),
  ),
  publications: getToFile(brandRoute('/publications'), publicationsQuery, summarizePublications),
  'brand:context': get(brandRoute('/context')),
  'personas:draft': get(
    brandRoute('/personas/draft'),
    (parsed) => ({ socialProfileId: optionalOption(parsed, 'profile') }),
  ),
  'personas:set': sendFile('personas', brandRoute('/personas'), () => ({ method: 'PUT' })),
  'campaigns:create': sendFile('setup', brandRoute('/campaigns')),
  'campaigns:update': sendFile('setup-patch', campaignRoute(), (parsed) => {
    const impactKey = optionalOption(parsed, 'impact-key');
    return { method: 'PATCH', extra: impactKey === undefined ? {} : { impactKey } };
  }),
  threads: get(campaignRoute('/threads')),
  'research:collect': post(campaignRoute('/research/collect'), (parsed) => ({ kinds: listOption(parsed, 'kinds', COLLECT_KINDS) || COLLECT_KINDS })),
  'research:runs': get(campaignRoute('/research/runs')),
  'research:pending': getToFile(
    campaignRoute('/research/pending'),
    (parsed) => ({ limit: integerOption(parsed, 'limit', 1, 25), kind: enumOption(parsed, 'kind', ITEM_KINDS) }),
    (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      const kinds = {};
      for (const item of items) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
      return { leaseId: data.leaseId || null, leaseUntil: data.leaseUntil || null, remaining: data.remaining ?? null, order: data.order || null, items: items.length, kinds };
    },
  ),
  'research:submit': sendFile('research', campaignRoute('/research/analyses')),
  'research:add': sendFile('captures', campaignRoute('/research/captures')),
  'research:sources': get(brandRoute('/research/sources')),
  'analysis:request': post((parsed) => `${brandRoute()(parsed)}${idRoute('accounts', 'profile', '/analysis')(parsed)}`),
  'ads:accounts': get(brandRoute('/ads/accounts')),
  'ads:account': get(brandRoute('/ads/account'), (parsed) => ({ accountId: accountOption(parsed) })),
  'ads:records': get(
    brandRoute('/ads/records'),
    (parsed) => ({
      campaignId: metaIdOption(parsed, 'campaign'),
      adsetId: metaIdOption(parsed, 'adset'),
      limit: integerOption(parsed, 'limit', 1, 200),
      accountId: accountOption(parsed),
    }),
  ),
  'ads:insights': withConfig(readInsights),
  'ads:list': get(
    (parsed) => brandRoute(`/ads/${requiredEnumOption(parsed, 'kind', AD_LIST_KINDS)}`)(parsed),
    (parsed) => ({ ...adsListQuery(parsed), accountId: accountOption(parsed) }),
  ),
  'ads:create': withConfig((parsed, config) => {
    const kind = requiredEnumOption(parsed, 'kind', AD_KINDS);
    return submitBundle(parsed, config, `ad-${kind}`, brandRoute(`/ads/${AD_SEGMENTS[kind]}`)(parsed), { query: { accountId: accountOption(parsed) } });
  }),
  'ads:update': withConfig((parsed, config) => {
    const kind = requiredEnumOption(parsed, 'kind', AD_UPDATE_KINDS);
    const route = `${brandRoute(`/ads/${AD_SEGMENTS[kind]}`)(parsed)}/${metaIdOption(parsed, 'id', true)}`;
    return submitBundle(parsed, config, `ad-${kind}-update`, route, { method: 'PATCH', query: { accountId: accountOption(parsed) } });
  }),
  'ads:media:add': withConfig(addAdMedia),
  'ads:media': get(
    brandRoute('/ads/media'),
    (parsed) => ({ kind: enumOption(parsed, 'kind', AD_MEDIA_KINDS), limit: integerOption(parsed, 'limit', 1, 200), accountId: accountOption(parsed) }),
  ),
  'ads:targeting': get(brandRoute('/ads/targeting'), (parsed) => ({ ...adsTargetingQuery(parsed), accountId: accountOption(parsed) })),
  'ad-book': get(brandRoute('/ad-book')),
  'ad-product:import': sendFile('ad-product', brandRoute('/ad-book/products')),
  'ad-product:update': sendFile('ad-product-patch', productRoute(), () => ({ method: 'PATCH' })),
  'ad-product:cutout': withConfig(addCutout),
  'ad-rule:import': sendFile('ad-rule', brandRoute('/ad-book/rules')),
  'ad-rule:update': sendFile('ad-rule-patch', adRuleRoute, () => ({ method: 'PATCH' })),
  'creative:iterations': get(brandRoute('/ad-review/iterations'), (parsed) => ({ productId: optionalOption(parsed, 'product') })),
  'creative:iteration:create': sendFile('ad-iteration', brandRoute('/ad-review/iterations')),
  'creative:submit': withConfig((parsed, config) => sendWithImage(parsed, config, 'creative-review', iterationCreativesRoute)),
  'creative:list': getToFile(
    brandRoute('/ad-review/creatives'),
    (parsed) => ({
      status: enumOption(parsed, 'status', CREATIVE_STATUSES),
      iterationId: optionalOption(parsed, 'iteration'),
      limit: integerOption(parsed, 'limit', 1, 50),
    }),
    (data) => ({ creatives: countOf(data.creatives), truncated: Boolean(data.truncated) }),
  ),
  'creative:get': get(creativeRoute()),
  'creative:regions': withConfig(writeRegionFiles),
  'creative:revise': withConfig((parsed, config) => sendWithImage(parsed, config, 'creative-revision', creativeRoute('/revisions'))),
  schema: async (args) => {
    const parsed = parseArgs(args);
    const bundle = enumOption(parsed, 'bundle', SCHEMA_BUNDLES);
    if (bundle) return succeed(BUNDLES[bundle].schema);
    return succeed({ posts: POSTS_SCHEMA, drafts: DRAFTS_SCHEMA, setup: SETUP_SCHEMA, personas: PERSONAS_SCHEMA, research: RESEARCH_ANALYSES_SCHEMA, captures: RESEARCH_CAPTURES_SCHEMA });
  },
  help: async () => succeed({
    usage: `${SCRIPT} <command> [--options] [--pretty]`,
    commands: {
      setup: '--api-key <key> [--base-url <url>] [--local] [--config <path>] [--no-verify]',
      config: '[--config <path>]',
      health: '',
      brands: '',
      campaigns: '--brand <brandId> [--status active|archived]',
      context: '--campaign <campaignId> [--out <file>]',
      evidence: `--campaign <campaignId> [--q <text>] [--limit 1..50] [--kind ${ITEM_KINDS.join('|')}]`,
      competitors: '--brand <brandId>',
      ideas: `--campaign <campaignId> [--status ${IDEA_STATUSES.join('|')}]`,
      'posts:submit': '--campaign <campaignId> --file <posts.json> [--dry-run]',
      'run:get': '--id <runId>',
      'post:date': '--idea <ideaId> (--date YYYY-MM-DD | --clear)',
      'post:title': '--idea <ideaId> --title <text>',
      'drafts:submit': '--idea <ideaId> --file <drafts.json> [--dry-run]',
      'draft:get': '--id <draftId>',
      'draft:title': '--id <draftId> [--title <text>] [--variant-note <text>]',
      'draft:submit': '--id <draftId>',
      'draft:media:add': '--id <draftId> --file <image.jpg|png|webp>',
      'draft:media:remove': '--id <draftId> --media <mediaId>',
      reviews: `--campaign <campaignId> [--status ${REVIEW_STATUSES.join('|')}] [--history]`,
      publications: `--brand <brandId> (--month YYYY-MM | --since YYYY-MM-DD --until YYYY-MM-DD) [--campaign <campaignId>] [--status ${PUBLICATION_STATUSES.join('|')}] [--out <file>]`,
      'brand:context': '--brand <brandId>',
      'personas:draft': '--brand <brandId> [--profile <socialProfileId>]',
      'personas:set': '--brand <brandId> --file <personas.json> [--dry-run]',
      'campaigns:create': '--brand <brandId> --file <setup.json> [--dry-run]',
      'campaigns:update': '--campaign <campaignId> --file <setup.json> [--impact-key <key>] [--dry-run]',
      threads: '--campaign <campaignId>',
      'research:collect': `--campaign <campaignId> [--kinds ${COLLECT_KINDS.join(',')}]`,
      'research:runs': '--campaign <campaignId>',
      'research:pending': `--campaign <campaignId> [--limit 1..25] [--kind ${ITEM_KINDS.join('|')}] [--out <batch.json>]`,
      'research:submit': '--campaign <campaignId> --file <analyses.json> [--dry-run]',
      'research:add': '--campaign <campaignId> --file <captures.json> [--dry-run]',
      'research:sources': '--brand <brandId>',
      'analysis:request': '--brand <brandId> --profile <socialProfileId>',
      'ads:accounts': '--brand <brandId>',
      'ads:account': '--brand <brandId> [--account <accountId>]',
      'ads:records': '--brand <brandId> [--account <accountId>] [--campaign <id>] [--adset <id>] [--limit 1..200]',
      'ads:insights': `--brand <brandId> [--account <accountId>] [--level ${ADS_LEVELS.join('|')}] [--range ${ADS_RANGES.join('|')}] [--since YYYY-MM-DD --until YYYY-MM-DD] [--daily] [--breakdown ${ADS_BREAKDOWNS.join('|')}] [--campaign <id,...>] [--adset <id,...>] [--ad <id>] [--sort <metric> [--order asc|desc]] [--compare] [--table] [--limit 1..500]`,
      'ads:list': `--brand <brandId> [--account <accountId>] --kind ${AD_LIST_KINDS.join('|')} [--campaign <id>] [--adset <id>] [--limit 1..200]`,
      'ads:create': `--brand <brandId> [--account <accountId>] --kind ${AD_KINDS.join('|')} --file <params.json> [--dry-run]`,
      'ads:update': `--brand <brandId> [--account <accountId>] --kind ${AD_UPDATE_KINDS.join('|')} --id <metaId> --file <params.json> [--dry-run]`,
      'ads:media:add': '--brand <brandId> [--account <accountId>] --file <image.jpg|png|video.mp4|mov> [--name <name>]',
      'ads:media': `--brand <brandId> [--account <accountId>] [--kind ${AD_MEDIA_KINDS.join('|')}] [--limit 1..200]`,
      'ads:targeting': `--brand <brandId> [--account <accountId>] --type ${TARGETING_TYPES.join('|')} --q <text>`,
      'ad-book': '--brand <brandId>',
      'ad-product:import': '--brand <brandId> --file <product.json> [--dry-run]',
      'ad-product:update': '--brand <brandId> --id <productId> --file <patch.json> [--dry-run]',
      'ad-product:cutout': '--brand <brandId> --id <productId> --file <image.jpg|png|webp> [--label <text>]',
      'ad-rule:import': '--brand <brandId> --file <rule.json> [--dry-run]',
      'ad-rule:update': '--brand <brandId> --id <ruleId> --file <patch.json> [--dry-run]',
      'creative:iterations': '--brand <brandId> [--product <productId>]',
      'creative:iteration:create': '--brand <brandId> --file <iteration.json> [--dry-run]',
      'creative:submit': '--brand <brandId> --iteration <iterationId> --file <creative.json> --image <image.jpg|png|webp> [--dry-run]',
      'creative:list': `--brand <brandId> [--status ${CREATIVE_STATUSES.join('|')}] [--iteration <iterationId>] [--limit 1..50] [--out <file>]`,
      'creative:get': '--brand <brandId> --id <creativeId>',
      'creative:regions': '--brand <brandId> --id <creativeId> --out <dir>',
      'creative:revise': '--brand <brandId> --id <creativeId> --file <revision.json> --image <image.jpg|png|webp> [--dry-run]',
      schema: `[--bundle ${SCHEMA_BUNDLES.join('|')}]`,
    },
    env: ['BICHON_AGENT_API_KEY', 'BICHON_AGENT_BASE_URL', 'BICHON_CONFIG_PATH'],
    defaultBaseUrl: DEFAULT_BASE_URL,
  }),
};

async function main() {
  const argv = process.argv.slice(2);
  pretty = argv.includes('--pretty');
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const args = command === argv[0] ? argv.slice(1) : argv;
  try {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
      throw new CliError('invalid_request', `Unknown command "${command}". Commands: ${Object.keys(COMMANDS).join(', ')}.`);
    }
    await COMMANDS[command](args);
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof CliError || err instanceof ApiError) {
      emit(err.envelope);
    } else {
      emit({ ok: false, error: { code: 'internal_error', message: err && err.message ? err.message : String(err) } });
    }
  }
}

main();
