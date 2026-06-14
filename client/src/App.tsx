import { useState, useCallback, useRef } from 'react';
import ConfigList, { type ConfigEntry } from './components/ConfigList';
import Tester, { RequestPanel, ResponsePanel } from './components/Tester';
import { useColumnResizer } from './hooks/useColumnResizer';

function App() {
  const [selectedConfig, setSelectedConfig] = useState<ConfigEntry | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const handleSelect = useCallback((cfg: ConfigEntry) => {
    setSelectedConfig(cfg);
  }, []);

  const handleConfigSaved = useCallback((cfg: ConfigEntry) => {
    setSelectedConfig(cfg);
    setReloadKey(k => k + 1);
  }, []);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { percents, onResizeStart } = useColumnResizer({
    count: 3,
    initial: [50, 25, 25],
    storageKey: 'app-cols-percent',
    containerRef: bodyRef,
    minPercent: 8,
  });

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1>
            <span className="logo-bracket">&lt;</span>
            API Tester
            <span className="logo-bracket">/&gt;</span>
          </h1>
          <span className="version-badge">build 2026-06-13 18:55</span>
        </div>
        <p className="app-subtitle">AI endpoint debugging console</p>
      </header>
      <Tester loadedConfig={selectedConfig} onSaveConfig={() => {}} onUpdateConfig={handleConfigSaved}>
        <div className="app-body app-body-row" ref={bodyRef}>
          <section className="app-col providers-col" style={{ flex: `${percents[0]} 0 0`, minWidth: 0 }}>
            <ConfigList selectedId={selectedConfig?.id ?? null} onSelect={handleSelect} reloadKey={reloadKey} />
          </section>
          <div className="col-resizer" onMouseDown={onResizeStart(0)} title="拖动调整列宽" />
          <section className="app-col request-col" style={{ flex: `${percents[1]} 0 0`, minWidth: 0 }}>
            <RequestPanel />
          </section>
          <div className="col-resizer" onMouseDown={onResizeStart(1)} title="拖动调整列宽" />
          <section className="app-col response-col" style={{ flex: `${percents[2]} 0 0`, minWidth: 0 }}>
            <ResponsePanel />
          </section>
        </div>
      </Tester>
    </div>
  );
}

export default App;