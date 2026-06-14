import { useState, useCallback, useEffect, useRef } from 'react';

// ─── 通用列拖拽 hook ───
// percents 加和必须 = 100。拖动 index 处的 resizer 会同时调整 [index] 与 [index+1]，
// 总和守恒。最小占比 5% 防止挤没。
export function useColumnResizer(opts: {
  count: number;
  initial: number[];
  storageKey: string;
  containerRef: React.RefObject<HTMLElement>;
  minPercent?: number;
}) {
  const { count, initial, storageKey, containerRef, minPercent = 5 } = opts;

  const readStored = useCallback((): number[] => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return initial;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length !== count) return initial;
      if (!arr.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) return initial;
      const sum = arr.reduce((a: number, b: number) => a + b, 0);
      if (Math.abs(sum - 100) > 0.5) return initial;
      return arr;
    } catch {
      return initial;
    }
  }, [storageKey, initial, count]);

  const [percents, setPercents] = useState<number[]>(readStored);
  const percentsRef = useRef(percents);
  percentsRef.current = percents;

  const persist = useCallback((arr: number[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(arr)); } catch { /* ignore */ }
  }, [storageKey]);

  const dragRef = useRef<{ index: number; startX: number; startA: number; startB: number; totalPx: number } | null>(null);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const deltaPct = (dx / drag.totalPx) * 100;
    let newA = drag.startA + deltaPct;
    let newB = drag.startB - deltaPct;
    if (newA < minPercent) { newA = minPercent; newB = drag.startA + drag.startB - minPercent; }
    if (newB < minPercent) { newB = minPercent; newA = drag.startA + drag.startB - minPercent; }
    const next = [...percentsRef.current];
    next[drag.index] = newA;
    next[drag.index + 1] = newB;
    setPercents(next);
  }, [minPercent]);

  const onMouseUp = useCallback(() => {
    if (dragRef.current) {
      persist(percentsRef.current);
      dragRef.current = null;
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [persist]);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onResizeStart = useCallback((index: number) => (e: React.MouseEvent) => {
    if (index < 0 || index >= count - 1) return;
    e.preventDefault();
    const container = containerRef.current;
    const totalPx = container?.getBoundingClientRect().width ?? 0;
    if (totalPx <= 0) return;
    const cur = percentsRef.current;
    dragRef.current = {
      index,
      startX: e.clientX,
      startA: cur[index],
      startB: cur[index + 1],
      totalPx,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [containerRef, count]);

  const reset = useCallback(() => {
    setPercents(initial);
    persist(initial);
  }, [initial, persist]);

  return { percents, onResizeStart, reset };
}
