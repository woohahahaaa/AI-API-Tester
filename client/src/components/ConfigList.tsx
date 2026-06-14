import { useState, useEffect, useCallback, useRef } from 'react';
import { useColumnResizer } from '../hooks/useColumnResizer';

export type Protocol = 'openai-completions' | 'openai-responses' | 'anthropic';

export interface EndpointConfig {
  baseUrl: string;
  basePath: string;
}

export type EndpointsByProtocol = Partial<Record<Protocol, EndpointConfig>>;

export interface ConfigEntry {
  id: string;
  name: string;
  protocol: Protocol;
  models: string[];
  endpoints: EndpointsByProtocol;
  apiKey: string;
  notes: string;
}

type SortField = 'name' | 'protocol' | 'models' | 'baseUrl';
type SortDir = 'asc' | 'desc';

const COLUMNS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'protocol', label: 'Protocol' },
  { field: 'models', label: 'Model' },
  { field: 'baseUrl', label: 'Base URL' },
];

const PROTOCOL_LABEL: Record<Protocol, string> = {
  'openai-completions': 'Chat',
  'openai-responses': 'Responses',
  'anthropic': 'Anthropic',
};

async function apiGetConfigs(): Promise<ConfigEntry[]> {
  const r = await fetch('/api/configs');
  if (!r.ok) throw new Error(`GET /api/configs → HTTP ${r.status}`);
  return r.json();
}

async function apiCreateConfig(entry: Omit<ConfigEntry, 'id'>): Promise<ConfigEntry> {
  const r = await fetch('/api/configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!r.ok) throw new Error(`POST /api/configs → HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function apiUpdateConfig(id: string, entry: Omit<ConfigEntry, 'id'>): Promise<ConfigEntry> {
  const r = await fetch(`/api/configs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!r.ok) throw new Error(`PUT /api/configs/${id} → HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function apiDeleteConfig(id: string): Promise<void> {
  const r = await fetch(`/api/configs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE /api/configs/${id} → HTTP ${r.status}: ${await r.text()}`);
}

interface Props {
  selectedId: string | null;
  onSelect: (cfg: ConfigEntry) => void;
  reloadKey?: number;
}

export default function ConfigList({ selectedId, onSelect, reloadKey }: Props) {
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const { percents: colPercents, onResizeStart: onColResizeStart } = useColumnResizer({
    count: 5,
    initial: [24, 12, 24, 34, 6],
    storageKey: 'config-cols-percent',
    containerRef: tableWrapRef,
    minPercent: 4,
  });
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [loadError, setLoadError] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editing, setEditing] = useState<ConfigEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [modelInput, setModelInput] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<{ models: string[]; source: string; count: number } | null>(null);
  const [fetchError, setFetchError] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<ConfigEntry>(emptyForm());
  const [formProtocolTab, setFormProtocolTab] = useState<Protocol>('openai-completions');

  function emptyForm(): ConfigEntry {
    return { id: '', name: '', protocol: 'openai-completions', models: [], endpoints: {}, apiKey: '', notes: '' };
  }

  const reload = useCallback(async () => {
    try {
      const list = await apiGetConfigs();
      setConfigs(list);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load configs');
    }
  }, []);

  useEffect(() => { reload(); }, [reload, reloadKey]);

  const setEndpoint = (p: Protocol, patch: Partial<EndpointConfig>) => {
    setForm(f => {
      const cur = f.endpoints[p] ?? { baseUrl: '', basePath: '' };
      const next = { ...cur, ...patch };
      const endpoints = { ...f.endpoints };
      if (next.baseUrl.trim() || next.basePath.trim()) endpoints[p] = next;
      else delete endpoints[p];
      return { ...f, endpoints };
    });
  };

  const currentFormEndpoint = (): EndpointConfig => form.endpoints[formProtocolTab] ?? { baseUrl: '', basePath: '' };

  const addModel = () => {
    const m = modelInput.trim();
    if (m && !form.models.includes(m)) {
      setForm(f => ({ ...f, models: [...f.models, m] }));
    }
    setModelInput('');
  };

  const removeModel = (m: string) => {
    setForm(f => ({ ...f, models: f.models.filter(x => x !== m) }));
  };

  const handleModelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); addModel(); }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const startAdd = () => {
    setForm(emptyForm());
    setAdding(true);
    setEditing(null);
    setFormProtocolTab('openai-completions');
    resetFetch();
  };

  const startEdit = (cfg: ConfigEntry) => {
    setForm({ ...cfg, endpoints: { ...cfg.endpoints } });
    setEditing(cfg);
    setAdding(false);
    setFormProtocolTab(cfg.protocol);
    resetFetch();
  };

  const cancelForm = () => {
    setAdding(false);
    setEditing(null);
    resetFetch();
  };

  const resetFetch = () => {
    setFetchResult(null);
    setFetchError('');
    setFetching(false);
  };

  const fetchModels = async () => {
    const ep = currentFormEndpoint();
    if (!ep.baseUrl.trim()) {
      setFetchError(`Base URL is required for ${formProtocolTab}`);
      return;
    }
    setFetching(true);
    setFetchError('');
    setFetchResult(null);
    try {
      const params = new URLSearchParams({
        baseUrl: ep.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        protocol: formProtocolTab,
      });
      const resp = await fetch(`/api/models?${params}`);
      const data = await resp.json();
      if (!resp.ok) {
        setFetchError(data.error || `HTTP ${resp.status}`);
        return;
      }
      setFetchResult(data);
    } catch (err: any) {
      setFetchError(err.message || 'Network error');
    } finally {
      setFetching(false);
    }
  };

  const applyFetched = (mode: 'replace' | 'append') => {
    if (!fetchResult) return;
    const incoming = fetchResult.models.filter(m => !form.models.includes(m));
    const newModels = mode === 'replace' ? fetchResult.models : [...form.models, ...incoming];
    setForm(f => ({ ...f, models: newModels }));
    resetFetch();
  };

  const saveForm = async () => {
    if (saving) return;
    if (!form.name.trim()) return;
    const hasAnyEndpoint = Object.values(form.endpoints).some(ep => ep && ep.baseUrl.trim());
    if (!hasAnyEndpoint) return;
    const { id, ...payload } = form;
    setSaving(true);
    try {
      if (editing && id) {
        await apiUpdateConfig(id, payload);
      } else {
        await apiCreateConfig(payload);
      }
      await reload();
      cancelForm();
    } catch (err: any) {
      setFetchError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const deleteConfig = async (id: string) => {
    if (!confirm('Delete this configuration?')) return;
    try {
      await apiDeleteConfig(id);
      await reload();
    } catch (err: any) {
      setLoadError(err.message || 'Delete failed');
    }
  };

  const handleSelect = (cfg: ConfigEntry) => {
    onSelect(cfg);
  };

  const sorted = [...configs].sort((a, b) => {
    const va = String(getSortValue(a, sortField)).toLowerCase();
    const vb = String(getSortValue(b, sortField)).toLowerCase();
    return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  useEffect(() => {
    if (!adding && !editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelForm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adding, editing]);

  return (
    <div className="config-list">
      <div className="config-list-header">
        <h2 className="panel-title">Configurations</h2>
        <button className="btn btn-sm btn-primary" onClick={startAdd} title="添加 Provider">+ 添加 Provider</button>
      </div>

      {loadError && (
        <div className="fetch-status fetch-error" style={{ marginBottom: 8 }}>
          <b>Load failed:</b> {loadError}
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }} onClick={reload}>Retry</button>
        </div>
      )}

      <div className="config-scroll">
        <div className="config-table-wrap" ref={tableWrapRef}>
          <table className="config-table">
            <colgroup>
              {colPercents.map((p, i) => (
                <col key={i} style={{ width: `${p}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((col, i) => (
                  <th key={col.field} onClick={() => handleSort(col.field)} className={sortField === col.field ? `sorted ${sortDir}` : ''}>
                    {col.label}
                    {sortField === col.field && <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                    <span
                      className="col-resize-handle"
                      onMouseDown={e => { e.stopPropagation(); onColResizeStart(i)(e); }}
                      onClick={e => e.stopPropagation()}
                      title="拖动调整列宽"
                    />
                  </th>
                ))}
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && !loadError && (
                <tr><td colSpan={5} className="empty-row">No configs. Click <b>+ 添加 Provider</b> to create one.</td></tr>
              )}
              {sorted.map(cfg => {
                const activeEp = cfg.endpoints[cfg.protocol];
                const fullUrl = activeEp ? (activeEp.baseUrl + activeEp.basePath) : '';
                return (
                  <tr
                    key={cfg.id}
                    className={selectedId === cfg.id ? 'selected' : ''}
                    onClick={() => handleSelect(cfg)}
                  >
                    <td className="cell-name">{cfg.name}</td>
                    <td><span className="protocol-badge">{PROTOCOL_LABEL[cfg.protocol]}</span></td>
                    <td className="cell-models">{formatModels(cfg.models)}</td>
                    <td className="cell-url" title={fullUrl}>{truncateUrl(fullUrl)}</td>
                    <td className="actions-col" onClick={e => e.stopPropagation()}>
                      <button className="btn btn-sm btn-ghost" onClick={() => startEdit(cfg)} title="Edit">✎</button>
                      <button className="btn btn-sm btn-ghost btn-danger" onClick={() => deleteConfig(cfg.id)} title="Delete">❌</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(adding || editing) && (
        <div className="modal-backdrop" onClick={cancelForm}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="form-title">{editing ? 'Edit Configuration' : 'New Configuration'}</div>
              <button className="modal-close" onClick={cancelForm} title="Close (Esc)">×</button>
            </div>
            <div className="modal-body">
              <label className="field-label">Name</label>
              <input className="input" placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />

              <label className="field-label">Default Protocol</label>
              <select className="input" value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value as Protocol }))}>
                <option value="openai-completions">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>

              <div className="field-label-row">
                <label className="field-label" style={{ margin: 0 }}>Endpoints (per protocol)</label>
                <span className="endpoint-hint">Configure URL for each protocol the provider supports</span>
              </div>
              <div className="endpoint-subtabs">
                {(['openai-completions', 'openai-responses', 'anthropic'] as Protocol[]).map(p => {
                  const ep = form.endpoints[p];
                  const configured = !!(ep && ep.baseUrl.trim());
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`endpoint-subtab${formProtocolTab === p ? ' active' : ''}${configured ? ' configured' : ''}`}
                      onClick={() => { setFormProtocolTab(p); resetFetch(); }}
                    >
                      {PROTOCOL_LABEL[p]}{configured ? ' ●' : ''}
                    </button>
                  );
                })}
              </div>
              {(() => {
                const ep = currentFormEndpoint();
                return (
                  <div className="endpoint-fields">
                    <input
                      className="input mono"
                      placeholder="Base URL (e.g. https://api.example.com)"
                      value={ep.baseUrl}
                      onChange={e => setEndpoint(formProtocolTab, { baseUrl: e.target.value })}
                    />
                    <input
                      className="input mono"
                      placeholder="Path suffix (e.g. /v1/chat/completions)"
                      value={ep.basePath}
                      onChange={e => setEndpoint(formProtocolTab, { basePath: e.target.value })}
                    />
                  </div>
                );
              })()}

              <div className="field-label-row">
                <label className="field-label" style={{ margin: 0 }}>Models</label>
                <button
                  className="btn btn-sm btn-ghost fetch-models-btn"
                  onClick={fetchModels}
                  disabled={fetching}
                  title={`Fetch models using ${formProtocolTab} endpoint`}
                >
                  {fetching ? <><span className="spinner spinner-sm" /> Fetching…</> : <>🔄 Fetch ({PROTOCOL_LABEL[formProtocolTab]})</>}
                </button>
              </div>
              <div className="model-list">
                {form.models.map(m => (
                  <div key={m} className="model-row">
                    <span className="model-row-name">{m}</span>
                    <button className="model-row-remove" onClick={() => removeModel(m)}>×</button>
                  </div>
                ))}
                <input className="input model-new-input" placeholder="Type model name and press Enter to add..." value={modelInput} onChange={e => setModelInput(e.target.value)} onKeyDown={handleModelKeyDown} />
              </div>
              {fetchError && (
                <div className="fetch-status fetch-error">
                  <b>Fetch failed:</b> {fetchError}
                </div>
              )}
              {fetchResult && (
                <div className="fetch-status fetch-success">
                  <div className="fetch-summary">
                    <b>Found {fetchResult.count} model(s)</b>
                    <span className="fetch-source">via {fetchResult.source}</span>
                  </div>
                  <div className="fetch-actions">
                    <button className="btn btn-sm btn-primary" onClick={() => applyFetched('replace')}>Replace all</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => applyFetched('append')}>Append new</button>
                    <button className="btn btn-sm btn-ghost" onClick={resetFetch}>Cancel</button>
                  </div>
                  <details className="fetch-preview">
                    <summary>Preview ({fetchResult.models.length})</summary>
                    <div className="fetch-model-chips">
                      {fetchResult.models.slice(0, 50).map(m => <span key={m} className="fetch-model-chip">{m}</span>)}
                      {fetchResult.models.length > 50 && <span className="fetch-model-chip more">+{fetchResult.models.length - 50} more</span>}
                    </div>
                  </details>
                </div>
              )}

              <label className="field-label">API Key (shared across protocols)</label>
              <input className="input mono" type="password" placeholder="API Key" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} />

              <label className="field-label">Notes</label>
              <input className="input" placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={saveForm} disabled={saving}>
                {saving ? <><span className="spinner spinner-sm" /> Saving…</> : 'Save'}
              </button>
              <button className="btn btn-ghost" onClick={cancelForm} disabled={saving}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 20) + (u.pathname.length > 20 ? '…' : '') : '');
  } catch {
    return url.length > 28 ? url.slice(0, 26) + '…' : url;
  }
}

function formatModels(models: string[]): string {
  if (!models || models.length === 0) return '—';
  if (models.length === 1) return models[0];
  return `${models[0]} +${models.length - 1}`;
}

function getSortValue(cfg: ConfigEntry, field: SortField): string {
  if (field === 'models') return cfg.models[0] ?? '';
  if (field === 'baseUrl') {
    const ep = cfg.endpoints[cfg.protocol];
    return ep ? ep.baseUrl + ep.basePath : '';
  }
  if (field === 'name') return cfg.name;
  return cfg.protocol;
}
