import { useState, useCallback, useEffect, useMemo, useRef, createContext, useContext, memo } from 'react';
import type { ConfigEntry, Protocol } from './ConfigList';

interface Result {
  sentRequest: { method: string; url: string; headers: Record<string, string>; body: string };
  receivedResponse: { status: number; statusText: string; headers: Record<string, string>; body: string };
  outputText: string;
  reasoningText: string;
  rawFrames: { event?: string; data: string }[];
}

const PROTOCOL_META: Record<Protocol, { label: string; defaultModel: string }> = {
  'openai-completions': { label: 'OpenAI Chat Completions', defaultModel: 'gpt-4o' },
  'openai-responses': { label: 'OpenAI Responses', defaultModel: 'gpt-4o' },
  'anthropic': { label: 'Anthropic Messages', defaultModel: 'claude-sonnet-4-20250514' },
};

const DEFAULT_PATH: Record<Protocol, string> = {
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic': '/v1/messages',
};

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

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

const TIMEOUT_MS = 60_000;

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

type EnableTok =
  | { kind: 'IDENT'; text: string }
  | { kind: 'EQ' | 'NEQ' | 'AND' | 'OR' | 'NOT' | 'LP' | 'RP' | 'EOF' };

function tokenizeEnableWhen(src: string): EnableTok[] {
  const out: EnableTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { out.push({ kind: 'LP' }); i++; continue; }
    if (c === ')') { out.push({ kind: 'RP' }); i++; continue; }
    if (c === '=' && src[i + 1] === '=') { out.push({ kind: 'EQ' }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { out.push({ kind: 'NEQ' }); i += 2; continue; }
    if (c === '&' && src[i + 1] === '&') { out.push({ kind: 'AND' }); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { out.push({ kind: 'OR' }); i += 2; continue; }
    if (c === '!') { out.push({ kind: 'NOT' }); i++; continue; }
    let j = i;
    while (j < src.length && !/[\s()=!&|]/.test(src[j])) j++;
    if (j === i) throw new Error(`Unexpected char '${c}' at ${i}`);
    out.push({ kind: 'IDENT', text: src.slice(i, j) });
    i = j;
  }
  out.push({ kind: 'EOF' });
  return out;
}

type EnableNode =
  | { type: 'cmp'; op: 'eq' | 'neq'; left: string; right: string }
  | { type: 'and' | 'or'; left: EnableNode; right: EnableNode }
  | { type: 'not'; expr: EnableNode };

function parseEnableWhen(src: string): EnableNode {
  const toks = tokenizeEnableWhen(src);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (kind: EnableTok['kind']) => {
    if (toks[pos].kind !== kind) throw new Error(`Expected ${kind} got ${toks[pos].kind}`);
    return toks[pos++];
  };
  const parsePrimary = (): EnableNode => {
    if (peek().kind === 'LP') { pos++; const inner = parseOr(); eat('RP'); return inner; }
    const left = eat('IDENT') as Extract<EnableTok, { kind: 'IDENT' }>;
    const opTok = peek();
    if (opTok.kind !== 'EQ' && opTok.kind !== 'NEQ') throw new Error(`Expected == or != after '${left.text}'`);
    pos++;
    const right = eat('IDENT') as Extract<EnableTok, { kind: 'IDENT' }>;
    return { type: 'cmp', op: opTok.kind === 'EQ' ? 'eq' : 'neq', left: left.text, right: right.text };
  };
  const parseNot = (): EnableNode => {
    if (peek().kind === 'NOT') { pos++; return { type: 'not', expr: parseNot() }; }
    return parsePrimary();
  };
  const parseAnd = (): EnableNode => {
    let node = parseNot();
    while (peek().kind === 'AND') { pos++; node = { type: 'and', left: node, right: parseNot() }; }
    return node;
  };
  const parseOr = (): EnableNode => {
    let node = parseAnd();
    while (peek().kind === 'OR') { pos++; node = { type: 'or', left: node, right: parseAnd() }; }
    return node;
  };
  const root = parseOr();
  if (peek().kind !== 'EOF') throw new Error(`Trailing tokens`);
  return root;
}

function evalEnableWhen(node: EnableNode, byName: Map<string, string>): boolean {
  if (node.type === 'cmp') {
    const lv = byName.get(node.left);
    if (lv === undefined) return false;
    return node.op === 'eq' ? lv === node.right : lv !== node.right;
  }
  if (node.type === 'not') return !evalEnableWhen(node.expr, byName);
  if (node.type === 'and') return evalEnableWhen(node.left, byName) && evalEnableWhen(node.right, byName);
  return evalEnableWhen(node.left, byName) || evalEnableWhen(node.right, byName);
}

function isFieldEnabled(field: ReasoningField, allFields: ReasoningField[]): { enabled: boolean; error?: string } {
  if (!field.enableWhen || !field.enableWhen.trim()) return { enabled: true };
  try {
    const ast = parseEnableWhen(field.enableWhen);
    const map = new Map(allFields.map(f => [f.name, f.value]));
    return { enabled: evalEnableWhen(ast, map) };
  } catch (e: any) {
    return { enabled: false, error: e.message };
  }
}

// 解析 value 字符串：含分号 → 拆成 options 数组（首项为当前 value），否则返回 undefined
function parseValueSpec(spec: string): { value: string; options?: string[] } {
  if (!spec.includes(';')) return { value: spec };
  const parts = spec.split(';').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length <= 1) return { value: parts[0] ?? '' };
  return { value: parts[0], options: parts };
}

const CUSTOM_DRAFT_ID = '__custom_draft__';

function makeCustomDraft(): ReasoningTemplate {
  return { id: CUSTOM_DRAFT_ID, name: '', fields: [] };
}

async function fetchReasoningTemplates(): Promise<ReasoningTemplate[]> {
  const r = await fetch('/api/reasoning-templates');
  if (!r.ok) throw new Error(`GET /api/reasoning-templates → HTTP ${r.status}`);
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

async function createReasoningTemplate(t: { name: string; fields: ReasoningField[] }): Promise<ReasoningTemplate> {
  const r = await fetch('/api/reasoning-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  if (!r.ok) throw new Error(`POST /api/reasoning-templates → HTTP ${r.status}`);
  return r.json();
}

async function updateReasoningTemplate(id: string, t: ReasoningTemplate): Promise<ReasoningTemplate> {
  const r = await fetch(`/api/reasoning-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  if (!r.ok) throw new Error(`PUT /api/reasoning-templates/${id} → HTTP ${r.status}`);
  return r.json();
}

async function deleteReasoningTemplate(id: string): Promise<void> {
  const r = await fetch(`/api/reasoning-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE /api/reasoning-templates/${id} → HTTP ${r.status}`);
}

async function replaceAllReasoningTemplates(list: ReasoningTemplate[]): Promise<ReasoningTemplate[]> {
  const r = await fetch('/api/reasoning-templates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
  if (!r.ok) {
    let msg = `PUT /api/reasoning-templates → HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error) msg += ` — ${j.error}`; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

function normalizeReasoning(raw: unknown, fallback: ReasoningTemplate[]): ReasoningState {
  const draft = makeCustomDraft();
  const fresh = (): ReasoningState => ({
    templateId: fallback[0]?.id ?? draft.id,
    templates: [...fallback, draft],
    draft,
  });
  if (!raw || typeof raw !== 'object') return fresh();
  const r = raw as Partial<ReasoningState>;
  if (!Array.isArray(r.templates) || r.templates.length === 0) return fresh();
  const validTemplate = r.templates.every(t => t && typeof t.id === 'string' && Array.isArray(t.fields));
  if (!validTemplate) return fresh();
  const templates = r.templates;
  const templateId = typeof r.templateId === 'string' && templates.some(t => t.id === r.templateId)
    ? r.templateId
    : templates[0].id;
  const restoredDraft = templates.find(t => t.id === CUSTOM_DRAFT_ID) ?? draft;
  return { templateId, templates, draft: restoredDraft };
}

interface ReasoningState {
  templateId: string;
  templates: ReasoningTemplate[];
  draft: ReasoningTemplate;
}

interface TesterState {
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  model: string;
  setModel: (m: string) => void;
  system: string;
  setSystem: (s: string) => void;
  messages: { role: 'user' | 'assistant'; content: string }[];
  setMessages: (m: { role: 'user' | 'assistant'; content: string }[]) => void;
  stream: boolean;
  setStream: (b: boolean) => void;
  apiKey: string;
  setApiKey: (s: string) => void;
  baseUrl: string;
  setBaseUrl: (s: string) => void;
  basePath: string;
  setBasePath: (s: string) => void;
  temperature: string;
  setTemperature: (s: string) => void;
  maxTokens: string;
  setMaxTokens: (s: string) => void;
  topP: string;
  setTopP: (s: string) => void;
  extraBody: string;
  setExtraBody: (s: string) => void;
  reasoning: ReasoningState;
  setReasoning: (r: ReasoningState) => void;
  loading: boolean;
  setLoading: (b: boolean) => void;
  error: string;
  setError: (s: string) => void;
  result: Result | null;
  setResult: (r: Result | null) => void;
  streaming: { frameCount: number; hasContent: boolean; active: boolean } | null;
  streamOutputRef: React.MutableRefObject<HTMLPreElement | null>;
  streamReasoningRef: React.MutableRefObject<HTMLPreElement | null>;
  elapsedMs: number;
  loadedConfig: ConfigEntry | null;
  onSaveConfig: (cfg: ConfigEntry) => void;
  doSubmit: () => void;
  doTest: () => void;
  doCancel: () => void;
  flushEndpoint: () => Promise<void>;
  requestPreview: { url: string; bodyObj: Record<string, unknown> | null; error: string | null };
}

const TesterCtx = createContext<TesterState | null>(null);

function useTester(): TesterState {
  const ctx = useContext(TesterCtx);
  if (!ctx) throw new Error('useTester must be used within Tester provider');
  return ctx;
}

interface Props {
  loadedConfig: ConfigEntry | null;
  onSaveConfig: (cfg: ConfigEntry) => void;
  onUpdateConfig: (cfg: ConfigEntry) => void;
  children?: React.ReactNode;
}

interface ModelParams {
  temperature: string;
  maxTokens: string;
  topP: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  stream: boolean;
  reasoning: ReasoningState;
  extraBody: string;
}

const EMPTY_PARAMS: ModelParams = (() => {
  const draft = makeCustomDraft();
  return {
    temperature: '',
    maxTokens: '2048',
    topP: '',
    system: '',
    messages: [{ role: 'user', content: '' }],
    stream: true,
    reasoning: {
      templateId: draft.id,
      templates: [draft],
      draft,
    },
    extraBody: '',
  };
})();

const MODEL_CACHE_KEY = 'api-tester-model-params';

function loadModelCache(): Record<string, ModelParams> {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveModelCache(cache: Record<string, ModelParams>) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

function cacheKeyFor(protocol: Protocol, baseUrl: string, model: string): string {
  return `${protocol}::${baseUrl.trim()}::${model}`;
}

export default function Tester({ loadedConfig, onSaveConfig, onUpdateConfig, children }: Props) {
  const [protocol, setProtocolState] = useState<Protocol>('openai-completions');
  const [model, setModel] = useState(PROTOCOL_META['openai-completions'].defaultModel);
  const [system, setSystem] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([{ role: 'user', content: '' }]);
  const [stream, setStream] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [basePath, setBasePath] = useState(DEFAULT_PATH['openai-completions']);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [topP, setTopP] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [streaming, setStreaming] = useState<{ frameCount: number; hasContent: boolean; active: boolean } | null>(null);
  const streamOutputRef = useRef<HTMLPreElement | null>(null);
  const streamReasoningRef = useRef<HTMLPreElement | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [extraBody, setExtraBody] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningState>(() => {
    const draft = makeCustomDraft();
    return { templateId: draft.id, templates: [draft], draft };
  });
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);
  const remoteTemplatesRef = useRef<ReasoningTemplate[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchReasoningTemplates().then(list => {
      if (cancelled) return;
      remoteTemplatesRef.current = list;
      const draft = makeCustomDraft();
      setReasoning(prev => {
        const keepDraft = prev.templates.find(t => t.id === CUSTOM_DRAFT_ID) ?? draft;
        const merged = [...list, keepDraft];
        const stillValid = merged.some(t => t.id === prev.templateId);
        return {
          templateId: stillValid ? prev.templateId : (list[0]?.id ?? keepDraft.id),
          templates: merged,
          draft: keepDraft,
        };
      });
    }).catch(err => {
      console.error('[reasoning] fetch templates failed:', err);
    });
    return () => { cancelled = true; };
  }, []);

  // ─── track applied id::protocol ───
  const loadedIdRef = useRef<string | null>(null);
  const appliedKeyRef = useRef<string>('');

  const applyEndpoint = useCallback((cfg: ConfigEntry, proto: Protocol) => {
    const ep = cfg.endpoints[proto];
    setBaseUrl(ep?.baseUrl ?? '');
    setBasePath(ep?.basePath ?? DEFAULT_PATH[proto]);
    appliedKeyRef.current = `${cfg.id}::${proto}`;
  }, []);

  useEffect(() => {
    if (!loadedConfig) {
      loadedIdRef.current = null;
      appliedKeyRef.current = '';
      return;
    }
    if (loadedIdRef.current === loadedConfig.id) return;
    loadedIdRef.current = loadedConfig.id;
    setProtocolState(loadedConfig.protocol);
    if (loadedConfig.models.length > 0) setModel(loadedConfig.models[0]);
    setApiKey(loadedConfig.apiKey);
    applyEndpoint(loadedConfig, loadedConfig.protocol);
    setResult(null);
    setError('');
  }, [loadedConfig, applyEndpoint]);

  useEffect(() => {
    if (!loadedConfig) return;
    if (appliedKeyRef.current === `${loadedConfig.id}::${protocol}`) return;
    applyEndpoint(loadedConfig, protocol);
  }, [protocol, loadedConfig, applyEndpoint]);

  useEffect(() => {
    if (!model) return;
    const key = cacheKeyFor(protocol, baseUrl, model);
    const cache = loadModelCache();
    const cached = cache[key];
    if (!cached) return;
    setTemperature(cached.temperature ?? '');
    setMaxTokens(cached.maxTokens ?? '2048');
    setTopP(cached.topP ?? '');
    setSystem(cached.system ?? '');
    setMessages(Array.isArray(cached.messages) && cached.messages.length > 0 ? cached.messages : EMPTY_PARAMS.messages);
    setStream(cached.stream ?? true);
    setReasoning(normalizeReasoning(cached.reasoning, remoteTemplatesRef.current));
    setExtraBody(cached.extraBody ?? '');
    setResult(null);
    setError('');
  }, [model, protocol, baseUrl]);

  const setProtocol = useCallback((p: Protocol) => {
    setProtocolState(p);
    setResult(null);
    setError('');
  }, []);

  const setStreamCb = useCallback((b: boolean) => setStream(b), []);

  const buildBodyObj = useCallback((): { body: Record<string, unknown> | null; error: string | null } => {
    let parsedExtra: Record<string, unknown> | undefined;
    if (extraBody.trim()) {
      try { parsedExtra = JSON.parse(extraBody.trim()); }
      catch { return { body: null, error: 'Extra body JSON is invalid.' }; }
    }

    const activeTemplate = reasoning.templates.find(t => t.id === reasoning.templateId);
    const allFields = activeTemplate?.fields ?? [];
    const reasoningFields: Array<{ name: string; value: string; target: string }> = allFields
      .filter(f => f.name.trim() && f.value.trim())
      .filter(f => isFieldEnabled(f, allFields).enabled)
      .map(f => ({ name: f.name.trim(), value: f.value.trim(), target: f.target.trim() }));

    const hasReasoning = reasoningFields.length > 0;
    const body: Record<string, unknown> = {
      protocol,
      stream,
      model,
      messages: messages.filter(m => m.content.trim()),
      system: system.trim() || undefined,
      maxTokens: maxTokens ? parseInt(maxTokens, 10) : 2048,
      apiKey,
      baseUrl: (baseUrl.trim() + basePath.trim()) || undefined,
      extraBody: parsedExtra,
      reasoningFields: hasReasoning ? reasoningFields : undefined,
    };
    if (temperature) body.temperature = parseFloat(temperature);
    if (topP) body.topP = parseFloat(topP);
    return { body, error: null };
  }, [protocol, stream, model, messages, system, maxTokens, apiKey, baseUrl, basePath, extraBody, temperature, topP, reasoning]);

  const buildRequestBody = useCallback(() => buildBodyObj(), [buildBodyObj]);

  const doFetch = useCallback(async (body: Record<string, unknown>) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeoutId = setTimeout(() => ctrl.abort(new Error('Client timeout')), TIMEOUT_MS);
    startTimeRef.current = performance.now();
    const isStream = body.stream === true;
    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!isStream || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setResult(data);
        return;
      }

      const protocol = body.protocol as Protocol;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let curEvent: string | undefined;
      let curData = '';
      let outAcc = '';
      let reasonAcc = '';
      let frameCount = 0;
      let finalResult: Result | null = null;
      let errorMsg: string | null = null;
      const anthroBlocks: Record<number, { type: string; text?: string; thinking?: string }> = {};

      setStreaming({ frameCount: 0, hasContent: false, active: true });
      if (streamOutputRef.current) streamOutputRef.current.textContent = '';
      if (streamReasoningRef.current) streamReasoningRef.current.textContent = '';

      let rafScheduled = false;
      let lastFlushedFrameCount = 0;
      const scheduleFlush = () => {
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(() => {
          rafScheduled = false;
          // ─── direct DOM write, bypass React reconciliation ───
          if (streamOutputRef.current && streamOutputRef.current.textContent !== outAcc) {
            streamOutputRef.current.textContent = outAcc;
          }
          if (streamReasoningRef.current && streamReasoningRef.current.textContent !== reasonAcc) {
            streamReasoningRef.current.textContent = reasonAcc;
          }
          // ─── only setState when frame count changes meaningfully (≤10/s) ───
          if (frameCount !== lastFlushedFrameCount) {
            lastFlushedFrameCount = frameCount;
            setStreaming({ frameCount, hasContent: !!(outAcc || reasonAcc), active: true });
          }
        });
      };

      const handleUpstream = (frameJson: string) => {
        let frame: { event?: string; data: string };
        try { frame = JSON.parse(frameJson); } catch { return; }
        frameCount += 1;
        if (frame.data === '[DONE]') return;
        let parsed: any;
        try { parsed = JSON.parse(frame.data); } catch { return; }

        if (protocol === 'openai-completions') {
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) outAcc += delta.content;
          if (delta?.reasoning_content) reasonAcc += delta.reasoning_content;
        } else if (protocol === 'openai-responses') {
          if (frame.event === 'response.output_text.delta' || frame.event === 'response.refusal.delta') {
            outAcc += parsed.delta ?? '';
          } else if (frame.event === 'response.reasoning_text.delta') {
            reasonAcc += parsed.delta ?? '';
          }
        } else if (protocol === 'anthropic') {
          if (frame.event === 'content_block_start') {
            const idx = parsed.index;
            anthroBlocks[idx] = { type: parsed.content_block?.type, text: '', thinking: '' };
          } else if (frame.event === 'content_block_delta') {
            const idx = parsed.index;
            const delta = parsed.delta;
            const blk = anthroBlocks[idx] ?? (anthroBlocks[idx] = { type: 'text', text: '', thinking: '' });
            if (delta?.type === 'text_delta') {
              blk.text = (blk.text ?? '') + (delta.text ?? '');
              outAcc += delta.text ?? '';
            } else if (delta?.type === 'thinking_delta') {
              blk.thinking = (blk.thinking ?? '') + (delta.thinking ?? '');
              reasonAcc += delta.thinking ?? '';
            }
          }
        }
        scheduleFlush();
      };

      const handleFrame = (event: string | undefined, data: string) => {
        if (!event) return;
        if (event === 'upstream') {
          handleUpstream(data);
        } else if (event === 'done') {
          try { finalResult = JSON.parse(data); } catch { /* ignore */ }
        } else if (event === 'error') {
          try { errorMsg = JSON.parse(data).error ?? 'Unknown error'; } catch { errorMsg = data; }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (line.startsWith('event: ')) {
            curEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            curData += (curData ? '\n' : '') + line.slice(6);
          } else if (line === '') {
            if (curEvent || curData) handleFrame(curEvent, curData);
            curEvent = undefined;
            curData = '';
          }
        }
      }
      if (curEvent || curData) handleFrame(curEvent, curData);

      if (errorMsg) throw new Error(errorMsg);
      if (finalResult) setResult(finalResult);
      else setStreaming({ frameCount, hasContent: !!(outAcc || reasonAcc), active: true });
    } finally {
      clearTimeout(timeoutId);
      setElapsedMs(performance.now() - startTimeRef.current);
      setStreaming(null);
      abortRef.current = null;
    }
  }, []);

  const flushEndpoint = useCallback(async () => {
    if (!loadedConfig) return;
    const url = baseUrl.trim();
    const path = basePath.trim();
    const baseEp = loadedConfig.endpoints[protocol];
    if (url === (baseEp?.baseUrl ?? '') && path === (baseEp?.basePath ?? '')) return;
    try {
      const r = await fetch(`/api/configs/${encodeURIComponent(loadedConfig.id)}/endpoint`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol, baseUrl: url, basePath: path }),
      });
      if (r.ok) {
        const updated: ConfigEntry = await r.json();
        appliedKeyRef.current = `${updated.id}::${protocol}`;
        onUpdateConfig(updated);
      }
    } catch {
      /* user can re-edit */
    }
  }, [loadedConfig, baseUrl, basePath, protocol, onUpdateConfig]);

  const doSubmit = useCallback(async () => {
    const validMessages = messages.filter(m => m.content.trim());
    if (validMessages.length === 0) { setError('Need at least one non-empty message.'); return; }
    if (!apiKey) { setError('API key is required.'); return; }
    if (!model) { setError('Model is required.'); return; }
    await flushEndpoint();
    setLoading(true);
    setError('');
    setResult(null);
    const { body, error: buildErr } = buildRequestBody();
    if (buildErr) { setError(buildErr); setLoading(false); return; }
    try {
      await doFetch(body!);
      const cache = loadModelCache();
      cache[cacheKeyFor(protocol, baseUrl, model)] = {
        temperature, maxTokens, topP, system, messages, stream, reasoning, extraBody,
      };
      saveModelCache(cache);
    } catch (err: any) {
      if (err.name === 'AbortError') setError(`Request aborted after ${TIMEOUT_MS / 1000}s timeout.`);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [messages, apiKey, model, buildRequestBody, doFetch, protocol, baseUrl, temperature, maxTokens, topP, system, stream, reasoning, extraBody, flushEndpoint]);

  const doTest = useCallback(async () => {
    if (!apiKey) { setError('API key is required to test connection.'); return; }
    await flushEndpoint();
    setLoading(true);
    setError('');
    setResult(null);
    setMessages([{ role: 'user', content: 'hi' }]);
    setSystem('');
    const { body, error: buildErr } = buildRequestBody();
    if (buildErr) { setError(buildErr); setLoading(false); return; }
    try {
      await doFetch(body!);
    } catch (err: any) {
      if (err.name === 'AbortError') setError(`Test aborted after ${TIMEOUT_MS / 1000}s.`);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiKey, buildRequestBody, doFetch, flushEndpoint]);

  const doCancel = useCallback(() => {
    abortRef.current?.abort(new Error('User cancelled'));
    setLoading(false);
  }, []);

  const requestPreview = useMemo<{ url: string; bodyObj: Record<string, unknown> | null; error: string | null }>(() => {
    const { body, error } = buildBodyObj();
    const url = (baseUrl.trim() + basePath.trim()) || '';

    let bodyObj = body;
    if (!error && body) {
      const { protocol: _p, apiKey: _k, baseUrl: _u, extraBody: _e, reasoningFields, ...rest } = body as Record<string, unknown>;
      const simulated: Record<string, unknown> = { ...rest };
      if (Array.isArray(reasoningFields)) {
        for (const f of reasoningFields as Array<{ name: string; value: string; target: string }>) {
          if (!f.name || !f.value) continue;
          const val = parseValue(f.value);
          if (f.target) setNested(simulated, f.target, val);
          else simulated[f.name] = val;
        }
      }
      if (_e && typeof _e === 'object') Object.assign(simulated, _e);
      bodyObj = simulated;
    }

    return { url, bodyObj, error };
  }, [buildBodyObj, baseUrl, basePath]);

  const ctx: TesterState = {
    protocol, setProtocol,
    model, setModel: (m) => { setModel(m); setResult(null); },
    system, setSystem: (s) => { setSystem(s); setResult(null); },
    messages, setMessages: (m) => { setMessages(m); setResult(null); },
    stream, setStream: setStreamCb,
    apiKey, setApiKey,
    baseUrl, setBaseUrl,
    basePath, setBasePath,
    temperature, setTemperature,
    maxTokens, setMaxTokens,
    topP, setTopP,
    extraBody, setExtraBody,
    reasoning, setReasoning,
    loading, setLoading,
    error, setError,
    result, setResult,
    streaming,
    streamOutputRef,
    streamReasoningRef,
    elapsedMs,
    loadedConfig, onSaveConfig,
    doSubmit, doTest, doCancel,
    flushEndpoint,
    requestPreview,
  };

  return (
    <TesterCtx.Provider value={ctx}>
      {children}
    </TesterCtx.Provider>
  );
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-header">
        <span className="section-icon">{icon}</span>
        <span className="section-title">{title}</span>
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

export function RequestPanel() {
  const t = useTester();
  const [showKey, setShowKey] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ReasoningTemplate | null>(null);
  const [editingJson, setEditingJson] = useState('');
  const [editingError, setEditingError] = useState('');
  const [editingAllOpen, setEditingAllOpen] = useState(false);
  const [editingAllJson, setEditingAllJson] = useState('');
  const [editingAllError, setEditingAllError] = useState('');
  const [optionsEditingIdx, setOptionsEditingIdx] = useState<number | null>(null);
  const [optionsEditingText, setOptionsEditingText] = useState('');
  const [enableWhenEditingIdx, setEnableWhenEditingIdx] = useState<number | null>(null);
  const [enableWhenEditingText, setEnableWhenEditingText] = useState('');

  const hasConfig = t.loadedConfig !== null;
  const modelOptions = t.loadedConfig?.models ?? [];
  const useModelSelect = hasConfig && modelOptions.length >= 1;

  const updateMessage = (idx: number, val: string) => {
    t.setMessages(t.messages.map((m, i) => i === idx ? { ...m, content: val } : m));
  };
  const addMessage = () => t.setMessages([...t.messages, { role: 'user', content: '' }]);
  const removeMessage = (idx: number) => t.setMessages(t.messages.filter((_, i) => i !== idx));
  const clearAll = () => {
    t.setMessages([{ role: 'user', content: '' }]);
    t.setSystem('');
    t.setExtraBody('');
    t.setTemperature('');
    t.setTopP('');
    t.setResult(null);
    t.setError('');
  };

  return (
    <section className="panel controls-panel">
      <div className="controls-header">
        <h2 className="panel-title">Request</h2>
        <div className="controls-actions">
          {hasConfig && <span className="loaded-hint">from <b>{t.loadedConfig!.name}</b></span>}
          <button className="btn btn-sm btn-ghost" onClick={clearAll} title="Clear all">Clear</button>
        </div>
      </div>

      {!hasConfig && (
        <div className="empty-hint">
          <div className="empty-hint-icon">↑</div>
          <div className="empty-hint-text">
            <b>No config selected.</b><br />
            Click any row above to load a preset, or click <b>+ 添加 Provider</b> to create one.
          </div>
        </div>
      )}

      <Section icon="🎯" title="Protocol">
        <div className="protocol-tabs">
          {(Object.entries(PROTOCOL_META) as [Protocol, typeof PROTOCOL_META[Protocol]][])
            .map(([key, meta]) => (
              <button
                key={key}
            className={`protocol-tab${t.protocol === key ? ' active' : ''}`}
            onClick={() => t.setProtocol(key)}
              >
                {meta.label}
              </button>
            ))}
        </div>
      </Section>

      <Section icon="🔧" title="Endpoint">
        <div className="field-row endpoint-row">
          {useModelSelect ? (
            <select className="input" value={t.model} onChange={e => t.setModel(e.target.value)}>
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input className="input mono" value={t.model} onChange={e => t.setModel(e.target.value)} placeholder="model name, e.g. gpt-4o" />
          )}
          <input
            className="input mono"
            value={t.baseUrl}
            onChange={e => t.setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com"
            title="Base host (origin)"
          />
          <input
            className="input mono"
            value={t.basePath}
            onChange={e => t.setBasePath(e.target.value)}
            placeholder="/v1/chat/completions"
            title="Path suffix"
          />
        </div>
      </Section>

      <Section icon="🎚️" title="Sampling">
        <div className="field-row sampling-row">
          <input className="input" type="number" step="0.1" min="0" max="2" value={t.temperature} onChange={e => t.setTemperature(e.target.value)} placeholder="temp" />
          <input className="input" type="number" min="1" value={t.maxTokens} onChange={e => t.setMaxTokens(e.target.value)} placeholder="max tokens" />
          <input className="input" type="number" step="0.05" min="0" max="1" value={t.topP} onChange={e => t.setTopP(e.target.value)} placeholder="top p" />
          <label className="toggle">
            <input type="checkbox" checked={t.stream} onChange={() => t.setStream(!t.stream)} />
            <span className="toggle-track"><span className="toggle-knob" /></span>
            <span className="toggle-label">Stream</span>
          </label>
        </div>
      </Section>

      <Section icon="🧠" title="Reasoning">
        <div className="reasoning-header">
          <select
            className="input reasoning-select"
            value={t.reasoning.templateId}
            onChange={async e => {
              const newId = e.target.value;
              try {
                const fresh = await fetchReasoningTemplates();
                const draft = t.reasoning.draft;
                t.setReasoning({
                  templateId: newId,
                  templates: [...fresh, draft],
                  draft,
                });
              } catch {
                t.setReasoning({ ...t.reasoning, templateId: newId });
              }
            }}
          >
            {t.reasoning.templates.map(tmpl => (
              <option key={tmpl.id} value={tmpl.id}>
                {tmpl.id === CUSTOM_DRAFT_ID ? '自定义…' : tmpl.name}
              </option>
            ))}
          </select>
          <div className="reasoning-actions">
            {(() => {
              const active = t.reasoning.templates.find(tm => tm.id === t.reasoning.templateId);
              if (!active) return null;
              const isDraft = active.id === CUSTOM_DRAFT_ID;
              if (isDraft) {
                return (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={!active.name.trim() || active.fields.length === 0}
                    onClick={async () => {
                      try {
                        const created = await createReasoningTemplate({
                          name: active.name.trim(),
                          fields: active.fields,
                        });
                        const fresh = await fetchReasoningTemplates();
                        const newDraft = makeCustomDraft();
                        t.setReasoning({
                          templateId: created.id,
                          templates: [...fresh, newDraft],
                          draft: newDraft,
                        });
                      } catch (err: any) {
                        alert(`保存失败: ${err.message}`);
                      }
                    }}
                    title="保存为新模板"
                  >保存</button>
                );
              }
              return (
                <>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setEditingTemplate(active);
                      setEditingJson(JSON.stringify(active, null, 2));
                      setEditingError('');
                    }}
                    title="编辑模板 JSON"
                  >编辑</button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      if (!confirm(`删除模板 "${active.name}"？`)) return;
                      try {
                        await deleteReasoningTemplate(active.id);
                        const fresh = await fetchReasoningTemplates();
                        const draft = t.reasoning.draft;
                        t.setReasoning({
                          templateId: fresh[0]?.id ?? draft.id,
                          templates: [...fresh, draft],
                          draft,
                        });
                      } catch (err: any) {
                        alert(`删除失败: ${err.message}`);
                      }
                    }}
                    title="删除模板"
                  >删除</button>
                </>
              );
            })()}
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                const all = t.reasoning.templates.filter(tm => tm.id !== CUSTOM_DRAFT_ID);
                setEditingAllJson(JSON.stringify(all, null, 2));
                setEditingAllError('');
                setEditingAllOpen(true);
              }}
              title="编辑所有模板（整个 JSON 配置）"
            >编辑全部</button>
          </div>
        </div>

        {(() => {
          const activeTemplate = t.reasoning.templates.find(tm => tm.id === t.reasoning.templateId);
          if (!activeTemplate) return null;
          const isDraft = activeTemplate.id === CUSTOM_DRAFT_ID;
          return (
            <div className="reasoning-fields">
              {isDraft && (
                <div className="reasoning-field-row reasoning-name-row">
                  <input
                    className="input reasoning-template-name"
                    value={activeTemplate.name}
                    onChange={e => {
                      const newName = e.target.value;
                      const newTemplates = t.reasoning.templates.map(tmpl =>
                        tmpl.id === CUSTOM_DRAFT_ID ? { ...tmpl, name: newName } : tmpl
                      );
                      const newDraft = { ...t.reasoning.draft, name: newName };
                      t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
                    }}
                    placeholder="模板名称（保存后将出现在下拉列表中）"
                  />
                </div>
              )}
              {activeTemplate.fields.map((field, i) => {
                const enableState = isFieldEnabled(field, activeTemplate.fields);
                const updateField = (patch: Partial<ReasoningField>) => {
                  const newTemplates = t.reasoning.templates.map(tmpl => {
                    if (tmpl.id !== t.reasoning.templateId) return tmpl;
                    const newFields = tmpl.fields.map((f, j) => j === i ? { ...f, ...patch } : f);
                    return { ...tmpl, fields: newFields };
                  });
                  const newDraft = isDraft
                    ? { ...t.reasoning.draft, fields: t.reasoning.draft.fields.map((f, j) => j === i ? { ...f, ...patch } : f) }
                    : t.reasoning.draft;
                  t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
                };
                const isEditingEnableWhen = enableWhenEditingIdx === i;
                return (
                <div className="reasoning-field-block" key={i}>
                <div className={`reasoning-field-row ${enableState.enabled ? '' : 'reasoning-field-disabled'}`}>
                  <input
                    className="input mono reasoning-field-name"
                    value={field.name}
                    onChange={e => {
                      const newTemplates = t.reasoning.templates.map(tmpl => {
                        if (tmpl.id !== t.reasoning.templateId) return tmpl;
                        const newFields = tmpl.fields.map((f, j) => j === i ? { ...f, name: e.target.value } : f);
                        return { ...tmpl, fields: newFields };
                      });
                      const newDraft = isDraft
                        ? { ...t.reasoning.draft, fields: t.reasoning.draft.fields.map((f, j) => j === i ? { ...f, name: e.target.value } : f) }
                        : t.reasoning.draft;
                      t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
                    }}
                    placeholder="name"
                  />
                  {(() => {
                    const isEditingOptions = optionsEditingIdx === i;
                    const hasOptions = Array.isArray(field.options) && field.options.length > 1;

                    if (isEditingOptions) {
                      const commitEdit = () => {
                        const parsed = parseValueSpec(optionsEditingText);
                        updateField({ value: parsed.value, options: parsed.options });
                        setOptionsEditingIdx(null);
                      };
                      return (
                        <div className="reasoning-field-value-wrap">
                          <input
                            className="input mono reasoning-field-value"
                            value={optionsEditingText}
                            onChange={e => setOptionsEditingText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); }}
                            placeholder="a;b;c → 下拉框；单值 → 输入框"
                            autoFocus
                          />
                          <button
                            className="btn btn-sm btn-ghost reasoning-field-pencil"
                            onClick={commitEdit}
                            title="完成编辑"
                          >完成</button>
                        </div>
                      );
                    }
                    if (hasOptions) {
                      return (
                        <div className="reasoning-field-value-wrap">
                          <select
                            className="input mono reasoning-field-value"
                            value={field.value}
                            onChange={e => updateField({ value: e.target.value })}
                          >
                            {field.options!.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          <button
                            className="btn btn-sm btn-ghost reasoning-field-pencil"
                            onClick={() => {
                              setOptionsEditingIdx(i);
                              setOptionsEditingText((field.options ?? []).join(';'));
                            }}
                            title="编辑选项列表（分号分隔）"
                          >编辑</button>
                        </div>
                      );
                    }
                    return (
                      <input
                        className="input mono reasoning-field-value"
                        value={field.value}
                        onChange={e => updateField({ value: e.target.value })}
                        onBlur={e => {
                          const parsed = parseValueSpec(e.target.value);
                          if (parsed.options) {
                            updateField({ value: parsed.value, options: parsed.options });
                          }
                        }}
                        placeholder="value（用 ; 分隔多个值变下拉框）"
                      />
                    );
                  })()}
                  <input
                    className="input mono reasoning-field-target"
                    value={field.target}
                    onChange={e => {
                      const newTemplates = t.reasoning.templates.map(tmpl => {
                        if (tmpl.id !== t.reasoning.templateId) return tmpl;
                        const newFields = tmpl.fields.map((f, j) => j === i ? { ...f, target: e.target.value } : f);
                        return { ...tmpl, fields: newFields };
                      });
                      const newDraft = isDraft
                        ? { ...t.reasoning.draft, fields: t.reasoning.draft.fields.map((f, j) => j === i ? { ...f, target: e.target.value } : f) }
                        : t.reasoning.draft;
                      t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
                    }}
                    placeholder="target (dot-path)"
                  />
                  <button
                    className="btn btn-sm btn-ghost btn-danger"
                    onClick={() => {
                      const newTemplates = t.reasoning.templates.map(tmpl => {
                        if (tmpl.id !== t.reasoning.templateId) return tmpl;
                        return { ...tmpl, fields: tmpl.fields.filter((_, j) => j !== i) };
                      });
                      const newDraft = isDraft
                        ? { ...t.reasoning.draft, fields: t.reasoning.draft.fields.filter((_, j) => j !== i) }
                        : t.reasoning.draft;
                      t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
                    }}
                  >❌</button>
                </div>
                <div className="reasoning-field-cond">
                  {isEditingEnableWhen ? (
                    <>
                      <input
                        className="input mono reasoning-field-cond-input"
                        value={enableWhenEditingText}
                        onChange={e => setEnableWhenEditingText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            updateField({ enableWhen: enableWhenEditingText.trim() || undefined });
                            setEnableWhenEditingIdx(null);
                          }
                        }}
                        placeholder="例: type == enabled && mode != debug"
                        autoFocus
                      />
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          updateField({ enableWhen: enableWhenEditingText.trim() || undefined });
                          setEnableWhenEditingIdx(null);
                        }}
                      >完成</button>
                    </>
                  ) : field.enableWhen ? (
                    <>
                      <span className={enableState.error ? 'reasoning-field-cond-error' : 'reasoning-field-cond-text'}>
                        {enableState.error ? `条件语法错误: ${enableState.error}` : `仅当 ${field.enableWhen} 时启用`}
                      </span>
                      {!enableState.enabled && !enableState.error && <span className="reasoning-field-cond-tag">已禁用</span>}
                      <button
                        className="btn btn-sm btn-ghost reasoning-field-cond-btn"
                        onClick={() => {
                          setEnableWhenEditingIdx(i);
                          setEnableWhenEditingText(field.enableWhen ?? '');
                        }}
                      >编辑</button>
                      <button
                        className="btn btn-sm btn-ghost reasoning-field-cond-btn"
                        onClick={() => updateField({ enableWhen: undefined })}
                      >清除</button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm btn-ghost reasoning-field-cond-btn"
                      onClick={() => {
                        setEnableWhenEditingIdx(i);
                        setEnableWhenEditingText('');
                      }}
                    >添加启用条件</button>
                  )}
                </div>
                </div>
                );
              })}
              <button className="btn btn-sm btn-ghost" onClick={() => {
                const newTemplates = t.reasoning.templates.map(tmpl => {
                  if (tmpl.id !== t.reasoning.templateId) return tmpl;
                  return { ...tmpl, fields: [...tmpl.fields, { name: '', value: '', target: '' }] };
                });
                const newDraft = isDraft
                  ? { ...t.reasoning.draft, fields: [...t.reasoning.draft.fields, { name: '', value: '', target: '' }] }
                  : t.reasoning.draft;
                t.setReasoning({ ...t.reasoning, templates: newTemplates, draft: newDraft });
              }}>
                + Add field
              </button>
            </div>
          );
        })()}

        {editingTemplate && (
          <div className="reasoning-edit-modal-backdrop" onClick={() => setEditingTemplate(null)}>
            <div className="reasoning-edit-modal" onClick={e => e.stopPropagation()}>
              <div className="reasoning-edit-modal-header">
                <span>编辑模板 JSON</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditingTemplate(null)}>❌</button>
              </div>
              <textarea
                className="input mono reasoning-edit-modal-textarea"
                value={editingJson}
                onChange={e => { setEditingJson(e.target.value); setEditingError(''); }}
                spellCheck={false}
                rows={16}
              />
              {editingError && <div className="error-banner">{editingError}</div>}
              <div className="reasoning-edit-modal-actions">
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    let parsed: any;
                    try { parsed = JSON.parse(editingJson); }
                    catch (err: any) { setEditingError(`JSON 解析失败: ${err.message}`); return; }
                    if (!parsed || typeof parsed !== 'object'
                      || typeof parsed.name !== 'string' || !parsed.name.trim()
                      || !Array.isArray(parsed.fields)) {
                      setEditingError('字段无效：必须包含 name (string) 和 fields (array)');
                      return;
                    }
                    try {
                      await updateReasoningTemplate(editingTemplate.id, {
                        id: editingTemplate.id,
                        name: parsed.name,
                        fields: parsed.fields,
                      });
                      const fresh = await fetchReasoningTemplates();
                      const draft = t.reasoning.draft;
                      t.setReasoning({
                        templateId: editingTemplate.id,
                        templates: [...fresh, draft],
                        draft,
                      });
                      setEditingTemplate(null);
                    } catch (err: any) {
                      setEditingError(`保存失败: ${err.message}`);
                    }
                  }}
                >保存</button>
                <button className="btn btn-ghost" onClick={() => setEditingTemplate(null)}>取消</button>
              </div>
            </div>
          </div>
        )}

        {editingAllOpen && (
          <div className="reasoning-edit-modal-backdrop" onClick={() => setEditingAllOpen(false)}>
            <div className="reasoning-edit-modal" onClick={e => e.stopPropagation()}>
              <div className="reasoning-edit-modal-header">
                <span>编辑所有模板（整个 JSON 配置）</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditingAllOpen(false)}>❌</button>
              </div>
              <textarea
                className="input mono reasoning-edit-modal-textarea"
                value={editingAllJson}
                onChange={e => { setEditingAllJson(e.target.value); setEditingAllError(''); }}
                spellCheck={false}
                rows={20}
              />
              {editingAllError && <div className="error-banner">{editingAllError}</div>}
              <div className="reasoning-edit-modal-actions">
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    let parsed: any;
                    try { parsed = JSON.parse(editingAllJson); }
                    catch (err: any) { setEditingAllError(`JSON 解析失败: ${err.message}`); return; }
                    if (!Array.isArray(parsed)) {
                      setEditingAllError('顶层必须是数组');
                      return;
                    }
                    for (let i = 0; i < parsed.length; i++) {
                      const item = parsed[i];
                      if (!item || typeof item !== 'object'
                        || typeof item.name !== 'string' || !item.name.trim()
                        || !Array.isArray(item.fields)) {
                        setEditingAllError(`第 ${i} 项无效：必须是 { id?, name, fields[] }`);
                        return;
                      }
                    }
                    try {
                      const saved = await replaceAllReasoningTemplates(parsed);
                      const draft = t.reasoning.draft;
                      const stillValid = saved.some(tm => tm.id === t.reasoning.templateId);
                      t.setReasoning({
                        templateId: stillValid ? t.reasoning.templateId : (saved[0]?.id ?? draft.id),
                        templates: [...saved, draft],
                        draft,
                      });
                      setEditingAllOpen(false);
                    } catch (err: any) {
                      setEditingAllError(`保存失败: ${err.message}`);
                    }
                  }}
                >保存全部</button>
                <button className="btn btn-ghost" onClick={() => setEditingAllOpen(false)}>取消</button>
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section icon="💬" title="Prompt">
        <div className="field">
          <input className="input" value={t.system} onChange={e => t.setSystem(e.target.value)} placeholder="System prompt (optional)" />
        </div>
        <div className="field">
          <div className="messages-header">
            <span className="messages-label">Messages</span>
            <button className="btn btn-sm btn-ghost" onClick={addMessage}>+ Add</button>
          </div>
          {t.messages.map((msg, i) => (
            <div className="msg-row" key={i}>
              <span className={`msg-role msg-role-${msg.role}`}>{msg.role}</span>
              <input
                className="input msg-input"
                value={msg.content}
                onChange={e => updateMessage(i, e.target.value)}
                placeholder="Message content..."
              />
              {t.messages.length > 1 && (
                <button className="btn btn-sm btn-ghost btn-danger" onClick={() => removeMessage(i)}>❌</button>
              )}
            </div>
          ))}
        </div>
        <div className="field">
          <textarea
            className="input mono"
            value={t.extraBody}
            onChange={e => t.setExtraBody(e.target.value)}
            placeholder='Extra body JSON, e.g. { "stop": ["\n"] }'
            rows={2}
            spellCheck={false}
          />
        </div>
      </Section>

      <Section icon="🔑" title="Auth">
        <div className="field">
          <input
            className="input mono"
            type={showKey ? 'text' : 'password'}
            value={t.apiKey}
            onChange={e => t.setApiKey(e.target.value)}
            placeholder="API key"
          />
        </div>
        <button className="btn btn-sm btn-ghost show-key-btn" onClick={() => setShowKey(s => !s)}>
          {showKey ? '🙈 Hide key' : '👁 Show key'}
        </button>
      </Section>

      <div className="submit-row">
        <button className="btn btn-primary" onClick={t.doSubmit} disabled={t.loading}>
          {t.loading ? <><span className="spinner" /> Sending…</> : <>▶ Send Request</>}
        </button>
        <button className="btn btn-ghost" onClick={t.doTest} disabled={t.loading} title="Send 'hi' to test the connection">
          ⚡ Test
        </button>
        {t.loading && <button className="btn btn-ghost" onClick={t.doCancel}>Cancel</button>}
      </div>
      {t.error && <div className="error-banner">{t.error}</div>}
    </section>
  );
}

type TabKey = 'output' | 'request' | 'response' | 'chunks';
const DEFAULT_TAB_LS_KEY = 'default-response-tab';
function readDefaultTab(): TabKey {
  try {
    const v = localStorage.getItem(DEFAULT_TAB_LS_KEY);
    if (v === 'output' || v === 'request' || v === 'response' || v === 'chunks') return v;
  } catch { /* ignore */ }
  return 'output';
}

export function ResponsePanel() {
  const t = useTester();
  const [defaultTab, setDefaultTabState] = useState<TabKey>(readDefaultTab);
  const setDefaultTab = useCallback((v: TabKey) => {
    setDefaultTabState(v);
    try { localStorage.setItem(DEFAULT_TAB_LS_KEY, v); } catch { /* ignore */ }
  }, []);
  const [activeTab, setActiveTab] = useState<TabKey>(defaultTab);
  const [copiedKey, setCopiedKey] = useState<'request' | 'response' | 'chunks' | null>(null);
  const prevResultRef = useRef<Result | null>(null);
  const streamSwitchedRef = useRef<boolean>(false);

  useEffect(() => {
    if (t.result && t.result !== prevResultRef.current) {
      setActiveTab(defaultTab);
      streamSwitchedRef.current = false;
    }
    prevResultRef.current = t.result;
  }, [t.result, defaultTab]);

  useEffect(() => {
    if (!t.streaming?.active) {
      streamSwitchedRef.current = false;
      return;
    }
    if (!streamSwitchedRef.current && t.streaming.hasContent) {
      setActiveTab('output');
      streamSwitchedRef.current = true;
    }
  }, [t.streaming]);

  const copyToClipboard = async (text: string, key: 'request' | 'response' | 'chunks') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch { /* ignore */ }
  };

  const statusClass = t.result ? statusToClass(t.result.receivedResponse.status) : '';
  const statusText = t.result ? `${t.result.receivedResponse.status} ${t.result.receivedResponse.statusText || statusToText(t.result.receivedResponse.status)}`.trim() : '';
  const timeText = t.result ? `${(t.elapsedMs / 1000).toFixed(2)}s` : '';
  const sizeText = t.result ? formatBytes(t.result.receivedResponse.body.length) : '';
  const hasChunks = !!t.result && t.result.rawFrames.length > 0;

  const chunksAsText = t.result
    ? t.result.rawFrames.map(f => (f.event ? `event: ${f.event}\n` : '') + `data: ${f.data}`).join('\n\n')
    : '';

  return (
    <section className="panel result-panel">
      <div className="controls-header">
        <h2 className="panel-title">Response</h2>
        {t.result && (
          <div className={`status-pill ${statusClass}`}>
            <span className="status-dot" />
            <span className="status-code">{statusText}</span>
            <span className="status-sep">·</span>
            <span className="status-time">{timeText}</span>
            <span className="status-sep">·</span>
            <span className="status-size">{sizeText}</span>
          </div>
        )}
      </div>

      {!t.result && !t.loading && (
        <div className="preview-pane">
          <div className="preview-header">
            <span className="preview-tag">PREVIEW</span>
            <span className="preview-hint">If you send now, this is what will be POSTed.</span>
          </div>
          {t.requestPreview.url && (
            <div className="preview-line"><span className="raw-meta">URL:</span> {t.requestPreview.url}</div>
          )}
          <div className="raw-line preview-body-label"><span className="raw-meta">Body:</span></div>
          <pre className="raw-json preview-body">
            {t.requestPreview.error
              ? `// ${t.requestPreview.error}`
              : (t.requestPreview.bodyObj ? JSON.stringify(t.requestPreview.bodyObj, null, 2) : '// (no body)')}
          </pre>
        </div>
      )}
      {t.loading && !t.result && !t.streaming?.hasContent && (
        <div className="empty-state">
          <span className="spinner" /> Waiting for response…
        </div>
      )}

      {t.loading && !t.result && t.streaming && (
        <>
          <div className="request-summary">
            <span className="rs-method">POST</span>
            <span className="rs-url" title={t.requestPreview.url}>{t.requestPreview.url || '(streaming…)'}</span>
          </div>
          <div className="tabs">
            <button className={`tab ${activeTab === 'output' ? 'active' : ''}`} onClick={() => setActiveTab('output')}>
              Output <span className="tab-count">(streaming · {t.streaming.frameCount})</span>
            </button>
            <div className="tab-spacer" />
            <span className="status-pill streaming-pill"><span className="spinner" /> live</span>
          </div>
          <div className="output-box">
            <details className="thinking-details" open>
              <summary className="thinking-summary">🧠 Thinking</summary>
              <pre ref={t.streamReasoningRef} className="streaming-raw thinking-content" />
            </details>
            <pre ref={t.streamOutputRef} className="streaming-raw" />
          </div>
        </>
      )}

      {t.result && (
        <>
          <div className="request-summary">
            <span className="rs-method">{t.result.sentRequest.method}</span>
            <span className="rs-url" title={t.result.sentRequest.url}>{t.result.sentRequest.url}</span>
          </div>
          <div className="tabs">
            <button className={`tab ${activeTab === 'request' ? 'active' : ''}`} onClick={() => setActiveTab('request')}>Sent</button>
            <button className={`tab ${activeTab === 'output' ? 'active' : ''}`} onClick={() => setActiveTab('output')}>Output</button>
            <button className={`tab ${activeTab === 'response' ? 'active' : ''}`} onClick={() => setActiveTab('response')}>Received</button>
            {hasChunks && (
              <button className={`tab ${activeTab === 'chunks' ? 'active' : ''}`} onClick={() => setActiveTab('chunks')}>
                Chunks <span className="tab-count">({t.result!.rawFrames.length})</span>
              </button>
            )}
            <div className="tab-spacer" />
            <label className="default-tab-picker" title="每次请求完成后默认显示的 tab">
              默认:
              <select
                className="default-tab-select"
                value={defaultTab}
                onChange={e => setDefaultTab(e.target.value as TabKey)}
              >
                <option value="output">Output</option>
                <option value="request">Sent</option>
                <option value="response">Received</option>
                <option value="chunks">Chunks</option>
              </select>
            </label>
            {activeTab !== 'output' && (
              <button
                className="tab copy-tab"
                onClick={() => {
                  if (activeTab === 'request') copyToClipboard(t.requestPreview.bodyObj ? JSON.stringify(t.requestPreview.bodyObj, null, 2) : '// (no body)', 'request');
                  else if (activeTab === 'response') copyToClipboard(t.result!.receivedResponse.body, 'response');
                  else if (activeTab === 'chunks') copyToClipboard(chunksAsText, 'chunks');
                }}
                title="Copy body"
              >
                {copiedKey === activeTab ? '✅ Copied' : '📋 Copy'}
              </button>
            )}
          </div>

          {activeTab === 'output' && (
            <div className="output-box">
              {t.result.reasoningText && (
                <details className="thinking-details" open>
                  <summary className="thinking-summary">🧠 Thinking</summary>
                  <div className="thinking-content">
                    <Markdown text={t.result.reasoningText} />
                  </div>
                </details>
              )}
              <Markdown text={t.result.outputText} />
            </div>
          )}

          {activeTab === 'request' && (
            <div className="raw-packet">
              <div className="raw-line"><span className="raw-meta">Method:</span> POST</div>
              <div className="raw-line"><span className="raw-meta">URL:</span> {t.requestPreview.url || '(empty)'}</div>
              <div className="raw-line"><span className="raw-meta">Headers:</span></div>
              <pre className="raw-json">{JSON.stringify({ 'Content-Type': 'application/json', Authorization: 'Bearer <api-key>' }, null, 2)}</pre>
              <div className="raw-line"><span className="raw-meta">Body:</span></div>
              <pre className="raw-json">
                {t.requestPreview.error
                  ? `// ${t.requestPreview.error}`
                  : (t.requestPreview.bodyObj ? JSON.stringify(t.requestPreview.bodyObj, null, 2) : '// (no body)')}
              </pre>
            </div>
          )}

          {activeTab === 'response' && (
            <div className="raw-packet">
              <div className="raw-line"><span className="raw-meta">Status:</span> {t.result.receivedResponse.status} {t.result.receivedResponse.statusText}</div>
              <div className="raw-line"><span className="raw-meta">Headers:</span></div>
              <pre className="raw-json">{JSON.stringify(t.result.receivedResponse.headers, null, 2)}</pre>
              <div className="raw-line"><span className="raw-meta">Body (merged):</span></div>
              <pre className="raw-json">{tryFormatJSON(t.result.receivedResponse.body) || t.result.receivedResponse.body}</pre>
            </div>
          )}

          {activeTab === 'chunks' && hasChunks && (
            <div className="chunks-list">
              {t.result.rawFrames.map((f, i) => (
                <div key={i} className="chunk-card">
                  <div className="chunk-head">
                    <span className="chunk-idx">#{i + 1}</span>
                    {f.event && <span className="chunk-event">{f.event}</span>}
                    <span className="chunk-size">{f.data.length} chars</span>
                  </div>
                  <pre className="chunk-data">{tryFormatJSON(f.data) || f.data}</pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function tryFormatJSON(s: string): string | null {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return null; }
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  let out = escapeHTML(text);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

function MarkdownImpl({ text }: { text: string }) {
  if (!text) return <div className="md-empty">(no text output)</div>;

  const lines = text.split('\n');
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} className={`md-code-block${lang ? ` md-lang-${lang}` : ''}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      blocks.push(
        level === 1 ? <h1 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} /> :
        level === 2 ? <h2 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} /> :
        level === 3 ? <h3 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} /> :
        level === 4 ? <h4 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} /> :
        level === 5 ? <h5 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} /> :
                      <h6 key={key++} dangerouslySetInnerHTML={{ __html: renderInline(content) }} />
      );
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} dangerouslySetInnerHTML={{ __html: renderInline(quoteLines.join('\n')) }} />
      );
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />)}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />)}
        </ol>
      );
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length
        && !/^\s*$/.test(lines[i])
        && !/^```/.test(lines[i])
        && !/^#{1,6}\s/.test(lines[i])
        && !/^>\s?/.test(lines[i])
        && !/^[-*+]\s+/.test(lines[i])
        && !/^\d+\.\s+/.test(lines[i])) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length) {
      blocks.push(
        <p key={key++} dangerouslySetInnerHTML={{ __html: renderInline(paragraphLines.join(' ')) }} />
      );
    }
  }

  return <div className="md-body">{blocks}</div>;
}

const Markdown = memo(MarkdownImpl, (a, b) => a.text === b.text);

function statusToClass(s: number): string {
  if (s >= 200 && s < 300) return 'status-2xx';
  if (s >= 300 && s < 400) return 'status-3xx';
  if (s >= 400 && s < 500) return 'status-4xx';
  return 'status-5xx';
}

function statusToText(s: number): string {
  if (s >= 200 && s < 300) return 'OK';
  if (s === 401) return 'Unauthorized';
  if (s === 403) return 'Forbidden';
  if (s === 404) return 'Not Found';
  if (s === 429) return 'Rate Limited';
  if (s >= 500) return 'Server Error';
  return '';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}