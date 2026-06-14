import type { Request, Response } from 'express';

// ─── Shared Types ───

export interface ProxyRequest {
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic';
  stream: boolean;
  model: string;
  messages: { role: string; content: string }[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  apiKey: string;
  baseUrl?: string;
  extraBody?: Record<string, unknown>;
  reasoningFields?: Array<{ name: string; value: string; target: string }>;
}

export interface ProxyResult {
  sentRequest: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  receivedResponse: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  };
  outputText: string;
  reasoningText: string;
  rawFrames: { event?: string; data: string }[];
}

// ─── Nested set helper ───

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in cur) || typeof cur[key] !== 'object' || cur[key] === null) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  cur[last] = value;
}

// ─── SSE Parser ───

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ev: string | undefined;
  let data = '';

  const flushFrame = () => {
    if (data) {
      const frame = { event: ev, data };
      ev = undefined;
      data = '';
      return frame;
    }
    ev = undefined;
    data = '';
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (l.startsWith('event: ')) {
          ev = l.slice(7);
        } else if (l.startsWith('data: ')) {
          data += l.slice(6);
        } else if (l === '') {
          const frame = flushFrame();
          if (frame) yield frame;
        }
      }
    }
    const tail = buffer.replace(/\r$/, '');
    if (tail) {
      if (tail.startsWith('data: ')) {
        data += tail.slice(6);
      } else if (tail.startsWith('event: ')) {
        ev = tail.slice(7);
      }
    }
    const frame = flushFrame();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

// ─── OpenAI Chat Completions ───

async function proxyOpenAIChat(
  opts: ProxyRequest,
  onFrame?: (frame: { event?: string; data: string }) => void
): Promise<ProxyResult> {
  const url = opts.baseUrl || 'https://api.openai.com/v1/chat/completions';
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
  };
  if (opts.maxTokens) bodyObj.max_tokens = opts.maxTokens;
  if (typeof opts.temperature === 'number') bodyObj.temperature = opts.temperature;
  if (typeof opts.topP === 'number') bodyObj.top_p = opts.topP;
  if (opts.reasoningFields) {
    for (const field of opts.reasoningFields) {
      if (!field.name || !field.value) continue;
      const val = parseValue(field.value);
      if (field.target) setNested(bodyObj, field.target, val);
      else bodyObj[field.name] = val;
    }
  }
  if (opts.extraBody) Object.assign(bodyObj, opts.extraBody);

  const bodyStr = JSON.stringify(bodyObj);
  const reqHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };

  const fetchResp = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: bodyStr,
  });

  const respHeaders: Record<string, string> = {};
  fetchResp.headers.forEach((v, k) => { respHeaders[k] = v; });

  if (!opts.stream) {
    const respBody = await fetchResp.text();
    let outputText = '';
    let reasoningText = '';
    try {
      const j = JSON.parse(respBody);
      const msg = j.choices?.[0]?.message;
      outputText = msg?.content ?? '';
      reasoningText = msg?.reasoning_content ?? '';
    } catch { /* ignore */ }
    return {
      sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
      receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: respBody },
      outputText,
      reasoningText,
      rawFrames: [],
    };
  }

  // Stream mode: merge chunks
  let mergedContent = '';
  let mergedReasoning = '';
  const rawChunks: unknown[] = [];
  const rawFrames: { event?: string; data: string }[] = [];

  for await (const frame of parseSSE(fetchResp.body!)) {
    rawFrames.push(frame);
    onFrame?.(frame);
    if (frame.data === '[DONE]') break;
    try {
      const chunk = JSON.parse(frame.data);
      rawChunks.push(chunk);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) mergedContent += delta.content;
      if (delta?.reasoning_content) mergedReasoning += delta.reasoning_content;
    } catch { /* skip unparseable */ }
  }

  // Reconstruct a single merged response JSON like the non-stream shape
  const mergedMessage: Record<string, unknown> = { role: 'assistant', content: mergedContent };
  if (mergedReasoning) mergedMessage.reasoning_content = mergedReasoning;
  const mergedBody = {
    id: (rawChunks[0] as any)?.id ?? '',
    object: 'chat.completion',
    created: (rawChunks[0] as any)?.created ?? 0,
    model: (rawChunks[0] as any)?.model ?? opts.model,
    choices: [{
      index: 0,
      message: mergedMessage,
      finish_reason: (rawChunks[rawChunks.length - 1] as any)?.choices?.[0]?.finish_reason ?? 'stop',
    }],
    usage: (rawChunks[rawChunks.length - 1] as any)?.usage ?? null,
  };

  return {
    sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
    receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: JSON.stringify(mergedBody, null, 2) },
    outputText: mergedContent,
    reasoningText: mergedReasoning,
    rawFrames,
  };
}

// ─── OpenAI Responses API ───

async function proxyOpenAIResponses(
  opts: ProxyRequest,
  onFrame?: (frame: { event?: string; data: string }) => void
): Promise<ProxyResult> {
  const url = opts.baseUrl || 'https://api.openai.com/v1/responses';
  const inputArr = opts.messages.map(m => ({ role: m.role, content: m.content }));
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    input: inputArr,
    stream: opts.stream,
  };
  if (opts.system) bodyObj.instructions = opts.system;
  if (opts.maxTokens) bodyObj.max_output_tokens = opts.maxTokens;
  if (typeof opts.temperature === 'number') bodyObj.temperature = opts.temperature;
  if (typeof opts.topP === 'number') bodyObj.top_p = opts.topP;
  if (opts.reasoningFields) {
    for (const field of opts.reasoningFields) {
      if (!field.name || !field.value) continue;
      const val = parseValue(field.value);
      if (field.target) setNested(bodyObj, field.target, val);
      else bodyObj[field.name] = val;
    }
  }
  if (opts.extraBody) Object.assign(bodyObj, opts.extraBody);

  const bodyStr = JSON.stringify(bodyObj);
  const reqHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };

  const fetchResp = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: bodyStr,
  });

  const respHeaders: Record<string, string> = {};
  fetchResp.headers.forEach((v, k) => { respHeaders[k] = v; });

  if (!opts.stream) {
    const respBody = await fetchResp.text();
    let outputText = '';
    let reasoningText = '';
    try {
      const j = JSON.parse(respBody);
      outputText = j.output_text ?? j.output?.[0]?.content?.[0]?.text ?? '';
      const items: any[] = j.output ?? [];
      for (const item of items) {
        if (item.type === 'reasoning') {
          reasoningText += item.summary?.map((s: any) => s.text ?? '').join('\n') ?? '';
        }
      }
    } catch { /* ignore */ }
    return {
      sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
      receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: respBody },
      outputText,
      reasoningText,
      rawFrames: [],
    };
  }

  // Stream: use the final response.completed event body
  let mergedText = '';
  let mergedReasoning = '';
  let finalResponse: any = null;
  const rawChunks: unknown[] = [];
  const rawFrames: { event?: string; data: string }[] = [];

  for await (const frame of parseSSE(fetchResp.body!)) {
    rawFrames.push(frame);
    onFrame?.(frame);
    try {
      const data = JSON.parse(frame.data);
      rawChunks.push(data);
      if (frame.event === 'response.output_text.delta') {
        mergedText += data.delta ?? '';
      } else if (frame.event === 'response.refusal.delta') {
        mergedText += data.delta ?? '';
      } else if (frame.event === 'response.reasoning_text.delta') {
        mergedReasoning += data.delta ?? '';
      }
      if (frame.event === 'response.completed' || data.response?.object === 'response') {
        finalResponse = data.response ?? data;
      }
    } catch { /* skip */ }
  }

  if (!mergedText && finalResponse) {
    const items: any[] = finalResponse.output ?? [];
    for (const item of items) {
      const parts: any[] = item.content ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string') mergedText += part.text;
        else if (typeof part.refusal === 'string') mergedText += part.refusal;
      }
    }
  }

  const finalBody = finalResponse
    ? JSON.stringify(finalResponse, null, 2)
    : JSON.stringify({ output_text: mergedText, reasoning_text: mergedReasoning, _note: 'stream ended without response.completed event', _rawChunks: rawChunks }, null, 2);

  return {
    sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
    receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: finalBody },
    outputText: mergedText,
    reasoningText: mergedReasoning,
    rawFrames,
  };
}

// ─── Anthropic Messages ───

async function proxyAnthropic(
  opts: ProxyRequest,
  onFrame?: (frame: { event?: string; data: string }) => void
): Promise<ProxyResult> {
  const url = opts.baseUrl || 'https://api.anthropic.com/v1/messages';
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
    stream: opts.stream,
  };
  if (opts.system) bodyObj.system = opts.system;
  if (opts.reasoningFields) {
    for (const field of opts.reasoningFields) {
      if (!field.name || !field.value) continue;
      const val = parseValue(field.value);
      if (field.target) setNested(bodyObj, field.target, val);
      else bodyObj[field.name] = val;
    }
  }
  // Anthropic requires temperature=1 when thinking is enabled
  const thinkingEnabled = opts.reasoningFields?.some(f => f.name === 'type' && f.value === 'enabled' && f.target === 'thinking.type');
  if (thinkingEnabled) {
    bodyObj.temperature = 1;
  } else if (typeof opts.temperature === 'number') {
    bodyObj.temperature = opts.temperature;
  }
  if (typeof opts.topP === 'number') bodyObj.top_p = opts.topP;
  if (opts.extraBody) Object.assign(bodyObj, opts.extraBody);

  const bodyStr = JSON.stringify(bodyObj);
  const reqHeaders: Record<string, string> = {
    'x-api-key': opts.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  const fetchResp = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: bodyStr,
  });

  const respHeaders: Record<string, string> = {};
  fetchResp.headers.forEach((v, k) => { respHeaders[k] = v; });

  if (!opts.stream) {
    const respBody = await fetchResp.text();
    let outputText = '';
    let reasoningText = '';
    try {
      const j = JSON.parse(respBody);
      const blocks: any[] = j.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') outputText += b.text ?? '';
        else if (b.type === 'thinking') reasoningText += b.thinking ?? '';
      }
    } catch { /* ignore */ }
    return {
      sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
      receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: respBody },
      outputText,
      reasoningText,
      rawFrames: [],
    };
  }

  // Stream: merge per Anthropic event protocol
  const snapshot: Record<string, any> = { content: [] };
  let textBuffers: string[] = [];
  let mergedText = '';
  const rawChunks: unknown[] = [];
  const rawFrames: { event?: string; data: string }[] = [];

  for await (const frame of parseSSE(fetchResp.body!)) {
    rawFrames.push(frame);
    onFrame?.(frame);
    try {
      const data = JSON.parse(frame.data);
      rawChunks.push(data);

      if (frame.event === 'message_start') {
        Object.assign(snapshot, data.message);
        snapshot.content = data.message.content ?? [];
      } else if (frame.event === 'content_block_start') {
        const idx = data.index;
        snapshot.content[idx] = { ...data.content_block };
        textBuffers[idx] = '';
      } else if (frame.event === 'content_block_delta') {
        const idx = data.index;
        const delta = data.delta;
        if (delta.type === 'text_delta') {
          textBuffers[idx] = (textBuffers[idx] ?? '') + delta.text;
          snapshot.content[idx] = { type: 'text', text: textBuffers[idx] };
        } else if (delta.type === 'input_json_delta') {
          textBuffers[idx] = (textBuffers[idx] ?? '') + delta.partial_json;
        } else if (delta.type === 'thinking_delta') {
          snapshot.content[idx] ??= { type: 'thinking', thinking: '' };
          snapshot.content[idx].thinking += delta.thinking;
        } else if (delta.type === 'signature_delta') {
          snapshot.content[idx] ??= { type: 'thinking', thinking: '', signature: '' };
          snapshot.content[idx].signature = delta.signature;
        }
      } else if (frame.event === 'message_delta') {
        if (data.delta?.stop_reason) snapshot.stop_reason = data.delta.stop_reason;
        if (data.usage) snapshot.usage = { ...snapshot.usage, ...data.usage };
      }
    } catch { /* skip */ }
  }

  mergedText = (snapshot.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('');

  const mergedReasoning = (snapshot.content ?? [])
    .filter((b: any) => b.type === 'thinking')
    .map((b: any) => b.thinking ?? '')
    .join('\n');

  const finalBody = JSON.stringify(snapshot, null, 2);

  return {
    sentRequest: { method: 'POST', url, headers: reqHeaders, body: bodyStr },
    receivedResponse: { status: fetchResp.status, statusText: fetchResp.statusText, headers: respHeaders, body: finalBody },
    outputText: mergedText,
    reasoningText: mergedReasoning,
    rawFrames,
  };
}

// ─── Express ───

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.post('/api/proxy', async (req: Request, res: Response) => {
  const opts = req.body as ProxyRequest;

  if (!opts.protocol || !opts.apiKey || !opts.model) {
    res.status(400).json({ error: 'Missing required fields: protocol, apiKey, model' });
    return;
  }

  // ─── Non-stream: keep JSON path ───
  if (!opts.stream) {
    try {
      let result: ProxyResult;
      switch (opts.protocol) {
        case 'openai-completions':
          result = await proxyOpenAIChat(opts);
          break;
        case 'openai-responses':
          result = await proxyOpenAIResponses(opts);
          break;
        case 'anthropic':
          result = await proxyAnthropic(opts);
          break;
        default:
          res.status(400).json({ error: `Unknown protocol: ${opts.protocol}` });
          return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
    return;
  }

  // ─── Stream: SSE pass-through + final summary frame ───
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const writeFrame = (event: string, data: string) => {
    res.write(`event: ${event}\n`);
    for (const line of data.split('\n')) res.write(`data: ${line}\n`);
    res.write('\n');
  };

  const onFrame = (frame: { event?: string; data: string }) => {
    writeFrame('upstream', JSON.stringify(frame));
  };

  try {
    let result: ProxyResult;
    switch (opts.protocol) {
      case 'openai-completions':
        result = await proxyOpenAIChat(opts, onFrame);
        break;
      case 'openai-responses':
        result = await proxyOpenAIResponses(opts, onFrame);
        break;
      case 'anthropic':
        result = await proxyAnthropic(opts, onFrame);
        break;
      default:
        writeFrame('error', JSON.stringify({ error: `Unknown protocol: ${opts.protocol}` }));
        res.end();
        return;
    }
    writeFrame('done', JSON.stringify(result));
    res.end();
  } catch (err: any) {
    writeFrame('error', JSON.stringify({ error: err.message, stack: err.stack }));
    res.end();
  }
});

app.get('/api/models', async (req: Request, res: Response) => {
  const baseUrl = String(req.query.baseUrl || '').trim();
  const apiKey = String(req.query.apiKey || '').trim();
  const protocol = String(req.query.protocol || 'openai-completions');
  if (!baseUrl) {
    res.status(400).json({ error: 'baseUrl is required' });
    return;
  }

  let origin: string;
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
  } catch {
    res.status(400).json({ error: `Invalid baseUrl: ${baseUrl}` });
    return;
  }

  const candidates = [`${origin}/v1/models`, `${origin}/models`];
  const isAnthropic = protocol === 'anthropic';
  const authHeaders: Record<string, string> = isAnthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` };

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: 'GET', headers: authHeaders });
      if (!r.ok) {
        errors.push(`${url} → HTTP ${r.status}`);
        continue;
      }
      const text = await r.text();
      let j: any;
      try { j = JSON.parse(text); } catch { errors.push(`${url} → non-JSON response`); continue; }
      const list: any[] = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      const models = list
        .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? m?.model))
        .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);
      if (models.length > 0) {
        res.json({ models, source: url, count: models.length });
        return;
      }
      errors.push(`${url} → empty model list`);
    } catch (err: any) {
      errors.push(`${url} → ${err.message}`);
    }
  }

  res.status(502).json({ error: 'Failed to fetch models from all candidates', tried: errors });
});

import { promises as fs } from 'fs';
import path from 'path';

interface ConfigEntryFile {
  id: string;
  name: string;
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic';
  models: string[];
  endpoints: Record<string, { baseUrl: string; basePath: string }>;
  apiKey: string;
  notes: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIGS_FILE = path.join(DATA_DIR, 'sensitive_configs.json');

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readConfigs(): Promise<ConfigEntryFile[]> {
  try {
    const raw = await fs.readFile(CONFIGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeConfigs(configs: ConfigEntryFile[]): Promise<void> {
  await ensureDataDir();
  const tmp = CONFIGS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(configs, null, 2), 'utf-8');
  await fs.rename(tmp, CONFIGS_FILE);
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function validateConfigEntry(raw: any): ConfigEntryFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const validProtocols = ['openai-completions', 'openai-responses', 'anthropic'];
  if (!validProtocols.includes(raw.protocol)) return null;
  if (typeof raw.name !== 'string') return null;
  if (!Array.isArray(raw.models) || !raw.models.every((m: any) => typeof m === 'string')) return null;
  if (!raw.endpoints || typeof raw.endpoints !== 'object') return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : makeId(),
    name: raw.name,
    protocol: raw.protocol,
    models: raw.models,
    endpoints: raw.endpoints,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

app.get('/api/configs', async (_req, res) => {
  try {
    const configs = await readConfigs();
    res.json(configs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configs', async (req, res) => {
  try {
    const entry = validateConfigEntry(req.body);
    if (!entry) {
      res.status(400).json({ error: 'Invalid config entry' });
      return;
    }
    entry.id = makeId();
    const configs = await readConfigs();
    configs.push(entry);
    await writeConfigs(configs);
    res.json(entry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/configs/:id', async (req, res) => {
  try {
    const entry = validateConfigEntry(req.body);
    if (!entry) {
      res.status(400).json({ error: 'Invalid config entry' });
      return;
    }
    const configs = await readConfigs();
    const idx = configs.findIndex(c => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    entry.id = req.params.id;
    configs[idx] = entry;
    await writeConfigs(configs);
    res.json(entry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/configs/:id', async (req, res) => {
  try {
    const configs = await readConfigs();
    const next = configs.filter(c => c.id !== req.params.id);
    if (next.length === configs.length) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    await writeConfigs(next);
    res.json({ ok: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/configs/:id/endpoint', async (req, res) => {
  try {
    const { protocol, baseUrl, basePath } = req.body ?? {};
    const validProtocols = ['openai-completions', 'openai-responses', 'anthropic'];
    if (!validProtocols.includes(protocol)) {
      res.status(400).json({ error: 'Invalid protocol' });
      return;
    }
    const configs = await readConfigs();
    const idx = configs.findIndex(c => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    const cfg = configs[idx];
    const endpoints = { ...cfg.endpoints };
    if (typeof baseUrl === 'string' && (baseUrl.trim() || (typeof basePath === 'string' && basePath.trim()))) {
      endpoints[protocol] = { baseUrl: String(baseUrl), basePath: String(basePath ?? '') };
    } else {
      delete endpoints[protocol];
    }
    configs[idx] = { ...cfg, endpoints };
    await writeConfigs(configs);
    res.json(configs[idx]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Reasoning Templates Storage ───

interface ReasoningField {
  name: string;
  value: string;
  target: string;
  options?: string[];
  enableWhen?: string;
}

interface ReasoningTemplate {
  id: string;
  name: string;
  fields: ReasoningField[];
}

const REASONING_TEMPLATES_FILE = path.join(DATA_DIR, 'reasoning-templates.json');

function deriveIdFromName(name: string, existing: ReasoningTemplate[], ignoreId?: string): string {
  const base = name.trim();
  if (!base) return makeId();
  const taken = new Set(existing.filter(t => t.id !== ignoreId).map(t => t.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return makeId();
}

async function readReasoningTemplates(): Promise<ReasoningTemplate[]> {
  try {
    const raw = await fs.readFile(REASONING_TEMPLATES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeReasoningTemplates(templates: ReasoningTemplate[]): Promise<void> {
  await ensureDataDir();
  const tmp = REASONING_TEMPLATES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(templates, null, 2), 'utf-8');
  await fs.rename(tmp, REASONING_TEMPLATES_FILE);
}

async function bootstrapReasoningTemplatesIfEmpty(): Promise<void> {
  const existing = await readReasoningTemplates();
  if (existing.length > 0) return;
  const seed: ReasoningTemplate[] = [
    { id: '自定义', name: '自定义', fields: [] },
    {
      id: 'GPT o-series',
      name: 'GPT o-series',
      fields: [
        { name: 'effort', value: 'low', target: 'reasoning_effort', options: ['low', 'medium', 'high'] },
      ],
    },
    {
      id: '通用 Thinking',
      name: '通用 Thinking',
      fields: [
        { name: 'type', value: 'enabled', target: 'thinking.type' },
        { name: 'budget_tokens', value: '10000', target: 'budget_tokens' },
      ],
    },
    {
      id: 'GPT o-series (Responses)',
      name: 'GPT o-series (Responses)',
      fields: [
        { name: 'effort', value: 'medium', target: 'reasoning.effort', options: ['low', 'medium', 'high'] },
        { name: 'summary', value: 'auto', target: 'reasoning.summary', options: ['auto', 'concise', 'detailed'] },
      ],
    },
    {
      id: 'Claude Thinking',
      name: 'Claude Thinking',
      fields: [
        { name: 'type', value: 'enabled', target: 'thinking.type' },
        { name: 'budget_tokens', value: '10000', target: 'thinking.budget_tokens' },
      ],
    },
  ];
  await writeReasoningTemplates(seed);
  console.log(`[reasoning-templates] Bootstrapped ${seed.length} preset(s) to ${REASONING_TEMPLATES_FILE}`);
}

function validateReasoningTemplate(raw: any): ReasoningTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (!Array.isArray(raw.fields)) return null;
  const fields: ReasoningField[] = [];
  for (const f of raw.fields) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.name !== 'string' || typeof f.value !== 'string' || typeof f.target !== 'string') return null;
    const field: ReasoningField = { name: f.name, value: f.value, target: f.target };
    if (Array.isArray(f.options) && f.options.every((o: any) => typeof o === 'string')) {
      field.options = f.options;
    }
    if (typeof f.enableWhen === 'string' && f.enableWhen.trim()) {
      field.enableWhen = f.enableWhen;
    }
    fields.push(field);
  }
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : '',
    name: raw.name,
    fields,
  };
}

app.get('/api/reasoning-templates', async (_req, res) => {
  try {
    const templates = await readReasoningTemplates();
    res.json(templates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reasoning-templates', async (req, res) => {
  try {
    const entry = validateReasoningTemplate(req.body);
    if (!entry) {
      res.status(400).json({ error: 'Invalid reasoning template' });
      return;
    }
    const templates = await readReasoningTemplates();
    entry.id = deriveIdFromName(entry.name, templates);
    templates.push(entry);
    await writeReasoningTemplates(templates);
    res.json(entry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reasoning-templates', async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      res.status(400).json({ error: 'Body must be an array of reasoning templates' });
      return;
    }
    const validated: ReasoningTemplate[] = [];
    for (let i = 0; i < req.body.length; i++) {
      const v = validateReasoningTemplate(req.body[i]);
      if (!v) {
        res.status(400).json({ error: `Invalid reasoning template at index ${i}` });
        return;
      }
      v.id = deriveIdFromName(v.name, validated);
      validated.push(v);
    }
    await writeReasoningTemplates(validated);
    res.json(validated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reasoning-templates/:id', async (req, res) => {
  try {
    const entry = validateReasoningTemplate(req.body);
    if (!entry) {
      res.status(400).json({ error: 'Invalid reasoning template' });
      return;
    }
    const templates = await readReasoningTemplates();
    const idx = templates.findIndex(t => t.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Reasoning template not found' });
      return;
    }
    entry.id = deriveIdFromName(entry.name, templates, req.params.id);
    templates[idx] = entry;
    await writeReasoningTemplates(templates);
    res.json(entry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reasoning-templates/:id', async (req, res) => {
  try {
    const templates = await readReasoningTemplates();
    const next = templates.filter(t => t.id !== req.params.id);
    if (next.length === templates.length) {
      res.status(404).json({ error: 'Reasoning template not found' });
      return;
    }
    await writeReasoningTemplates(next);
    res.json({ ok: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, async () => {
  await bootstrapReasoningTemplatesIfEmpty();
  console.log(`API tester server running on http://localhost:${PORT}`);
});