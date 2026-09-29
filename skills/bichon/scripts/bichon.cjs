#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_BASE_URL = 'https://intent-crab-142.convex.site';
const API_PREFIX = '/agent/v1';
const KEY_PREFIX = 'bichon_org_';
const SCRIPT = './scripts/bichon.cjs';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_REPORTED_ISSUES = 50;
const BOOLEAN_FLAGS = new Set(['pretty', 'local', 'no-verify', 'dry-run', 'help']);
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
const IDEA_STATUSES = ['proposed', 'approved', 'assigned', 'killed', 'done'];
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

function integerOption(parsed, name, min, max) {
  const value = optionalOption(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new CliError('invalid_request', `--${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
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

const IDEATION_RUN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:ideation-run:v1',
  title: 'IdeationRunBundle',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'agent', 'mode', 'briefVersion', 'sourcePolicyVersion', 'ideas'],
  properties: {
    format: { const: 'bichon-ideation-run/v1' },
    agent: agentSchema,
    mode: { enum: MODES },
    briefVersion: str(200),
    sourcePolicyVersion: str(200),
    submissionId: str(80),
    note: str(300, 0),
    noIdeasReason: str(300, 0),
    ideas: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title', 'hook', 'treatment', 'audienceBenefit', 'whyNow', 'limitation', 'whyNowCategory',
          'recommendedFormat', 'personaKey', 'pov', 'coreMessage', 'assetId', 'assetReason', 'evidence',
          'claims', 'formatPlan',
        ],
        properties: {
          title: str(200),
          hook: str(1000),
          treatment: str(2000),
          audienceBenefit: str(300),
          whyNow: str(2000),
          limitation: str(300),
          whyNowCategory: { enum: WHY_NOW_CATEGORIES },
          recommendedFormat: str(200),
          personaKey: nullable(str(200)),
          pov: {
            type: 'object',
            additionalProperties: false,
            required: ['moment', 'fear', 'desire'],
            properties: { moment: str(300), fear: str(300), desire: str(300) },
          },
          coreMessage: str(300),
          assetId: nullable(str(200)),
          assetReason: nullable(str(300, 0)),
          evidence: list({ oneOf: [signalEvidenceSchema, discoveryEvidenceSchema] }, 10),
          primaryEvidence: { type: 'integer', minimum: 0, maximum: 9 },
          claims: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: { text: str(2000), evidence: { type: 'integer', minimum: 0, maximum: 9 } },
            },
          },
          formatPlan: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['socialProfileId', 'formatKey', 'layoutModelPostId'],
              properties: {
                socialProfileId: str(200),
                formatKey: str(200),
                layoutModelPostId: str(200),
                openerSource: str(300),
              },
            },
          },
        },
      },
    },
  },
};

const DRAFTS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:bichon:schema:drafts:v1',
  title: 'DraftsBundle',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'agent', 'drafts'],
  properties: {
    format: { const: 'bichon-drafts/v1' },
    agent: agentSchema,
    drafts: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['socialProfileId', 'caption'],
        properties: {
          socialProfileId: str(200),
          caption: str(5000),
          title: str(200, 0),
          postType: { enum: POST_TYPES },
          variantNote: str(1000, 0),
          mediaNotes: str(2000, 0),
        },
      },
    },
  },
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

function checkIdeationBundle(bundle, issues) {
  if (!Array.isArray(bundle.ideas)) return;
  bundle.ideas.forEach((idea, index) => {
    if (!idea || typeof idea !== 'object') return;
    const at = `ideas[${index}]`;
    const evidence = Array.isArray(idea.evidence) ? idea.evidence : [];
    const inRange = (value) => Number.isInteger(value) && value >= 0 && value < evidence.length;
    if (evidence.length > 0 && idea.primaryEvidence === undefined) {
      issues.push({ path: `${at}.primaryEvidence`, message: 'is required when evidence is not empty' });
    }
    if (idea.primaryEvidence !== undefined && !inRange(idea.primaryEvidence)) {
      issues.push({ path: `${at}.primaryEvidence`, message: `must index evidence (0..${evidence.length - 1}); got ${idea.primaryEvidence}` });
    }
    (Array.isArray(idea.claims) ? idea.claims : []).forEach((claim, claimIndex) => {
      if (claim && claim.evidence !== undefined && !inRange(claim.evidence)) {
        issues.push({ path: `${at}.claims[${claimIndex}].evidence`, message: `must index evidence (0..${evidence.length - 1}); got ${claim.evidence}` });
      }
    });
    if (idea.whyNowCategory && idea.whyNowCategory !== 'evergreen' && evidence.length === 0) {
      issues.push({ path: `${at}.whyNowCategory`, message: `${idea.whyNowCategory} needs cited evidence; use evergreen or cite a signal` });
    }
    if (idea.assetId && !idea.assetReason) {
      issues.push({ path: `${at}.assetReason`, message: 'is required when assetId is set' });
    }
    checkUnique(idea.formatPlan, 'socialProfileId', `${at}.formatPlan`, 'appears twice; plan one format per account', issues);
  });
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

function checkSetupPatch(setup, issues) {
  if (Object.keys(setup).length === 0) issues.push({ path: '(root)', message: 'sets no fields; name at least one to change' });
}

const countOf = (value) => (Array.isArray(value) ? value.length : 0);

const BUNDLES = {
  'ideation-run': { schema: IDEATION_RUN_SCHEMA, check: checkIdeationBundle, counts: (bundle) => ({ ideas: bundle.ideas.length }) },
  drafts: { schema: DRAFTS_SCHEMA, check: checkDraftsBundle, counts: (bundle) => ({ drafts: bundle.drafts.length }) },
  setup: { schema: SETUP_SCHEMA, counts: (setup) => ({ fields: Object.keys(setup).length, personas: countOf(setup.personas), keywords: countOf(setup.keywords) }) },
  'setup-patch': { schema: { ...SETUP_SCHEMA, required: [] }, check: checkSetupPatch, counts: (setup) => ({ fields: Object.keys(setup).length }) },
  personas: { schema: PERSONAS_SCHEMA, counts: (file) => ({ personas: file.personas.length }) },
  research: { schema: RESEARCH_ANALYSES_SCHEMA, check: checkResearchBundle, counts: (bundle) => ({ items: bundle.items.length }) },
};
const SCHEMA_BUNDLES = ['ideation-run', 'drafts', 'setup', 'personas', 'research'];

function validateBundle(kind, bundle) {
  const issues = [];
  const { schema, check } = BUNDLES[kind];
  validate(schema, bundle, '', issues);
  if (check && bundle && typeof bundle === 'object' && !Array.isArray(bundle)) check(bundle, issues);
  return issues;
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

const idRoute = (collection, option, suffix = '') => (parsed) => `/${collection}/${segment(requireOption(parsed, option))}${suffix}`;
const campaignRoute = (suffix) => idRoute('campaigns', 'campaign', suffix);
const brandRoute = (suffix) => idRoute('brands', 'brand', suffix);

async function submitBundle(parsed, config, kind, route, { method = 'POST', extra = {} } = {}) {
  const bundle = loadBundle(parsed, kind);
  if (parsed['dry-run']) {
    return succeed({ valid: true, dryRun: true, bundle: kind, counts: BUNDLES[kind].counts(bundle) });
  }
  return emit(await api(config, method, route, { body: { ...bundle, ...extra } }));
}

function sendFile(kind, route, options) {
  return withConfig((parsed, config) => submitBundle(parsed, config, kind, route(parsed), options && options(parsed)));
}

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
      sourceId: optionalOption(parsed, 'source'),
    }),
  ),
  competitors: get(brandRoute('/competitors')),
  ideas: get(
    campaignRoute('/ideas'),
    (parsed) => ({ status: enumOption(parsed, 'status', IDEA_STATUSES) }),
  ),
  'ideas:submit': sendFile('ideation-run', campaignRoute('/ideation-runs')),
  'run:get': get(idRoute('ideation-runs', 'id')),
  'drafts:submit': sendFile('drafts', idRoute('ideas', 'idea', '/drafts')),
  'draft:get': get(idRoute('drafts', 'id')),
  'draft:submit': post(idRoute('drafts', 'id', '/submit'), () => ({})),
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
      return { leaseId: data.leaseId || null, leaseUntil: data.leaseUntil || null, remaining: data.remaining ?? null, items: items.length, kinds };
    },
  ),
  'research:submit': sendFile('research', campaignRoute('/research/analyses')),
  'research:sources': get(brandRoute('/research/sources')),
  'analysis:request': post((parsed) => `${brandRoute()(parsed)}${idRoute('accounts', 'profile', '/analysis')(parsed)}`),
  schema: async (args) => {
    const parsed = parseArgs(args);
    const bundle = enumOption(parsed, 'bundle', SCHEMA_BUNDLES);
    if (bundle) return succeed(BUNDLES[bundle].schema);
    return succeed({ ideationRun: IDEATION_RUN_SCHEMA, drafts: DRAFTS_SCHEMA, setup: SETUP_SCHEMA, personas: PERSONAS_SCHEMA, research: RESEARCH_ANALYSES_SCHEMA });
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
      evidence: `--campaign <campaignId> [--q <text>] [--limit 1..50] [--kind ${ITEM_KINDS.join('|')}] [--source <sourceId>]`,
      competitors: '--brand <brandId>',
      ideas: `--campaign <campaignId> [--status ${IDEA_STATUSES.join('|')}]`,
      'ideas:submit': '--campaign <campaignId> --file <bundle.json> [--dry-run]',
      'run:get': '--id <runId>',
      'drafts:submit': '--idea <ideaId> --file <bundle.json> [--dry-run]',
      'draft:get': '--id <draftId>',
      'draft:submit': '--id <draftId>',
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
      'research:sources': '--brand <brandId>',
      'analysis:request': '--brand <brandId> --profile <socialProfileId>',
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
