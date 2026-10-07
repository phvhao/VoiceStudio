import { useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';

export function usePaneResize({
  storageKey,
  side,
  minimum = 280,
  initial = 360,
  maximum = Infinity,
  reserve = 320,
  room = 0,
  floor = minimum,
  enabled = true,
}: {
  storageKey: string;
  side: 'left' | 'right';
  minimum?: number;
  initial?: number;
  maximum?: number;
  reserve?: number;
  /**
   * The width the content beside the pane cannot do without — its title bar
   * with the title in full. Past `reserve`, the pane narrows for it, below the
   * `minimum` a drag reaches, down to `floor`.
   */
  room?: number;
  floor?: number;
  enabled?: boolean;
}) {
  const host = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const limit =
    available === null ? initial : Math.max(minimum, Math.min(maximum, available - reserve));
  const [preferred, setPreferred] = useState(() => {
    try {
      const width = Number(localStorage.getItem(storageKey));
      return Number.isFinite(width) && width >= minimum ? width : initial;
    } catch {
      return initial;
    }
  });
  const chosen = Math.max(minimum, Math.min(preferred, limit));
  const width =
    available === null || room <= 0
      ? chosen
      : Math.max(Math.min(floor, chosen), Math.min(chosen, available - room));
  useLayoutEffect(() => {
    let parent = host.current?.parentElement ?? null;
    while (
      parent &&
      (parent.clientWidth === 0 || window.getComputedStyle(parent).display === 'contents')
    )
      parent = parent.parentElement;
    if (!enabled || !parent) return;
    const measure = () => setAvailable(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [enabled]);
  const resize = (value: number) => {
    const next = Math.max(minimum, Math.min(value, limit));
    setPreferred(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* Session layout remains usable. */
    }
  };
  const separatorProps: HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-valuemin': Math.min(minimum, width),
    'aria-valuemax': limit,
    'aria-valuenow': width,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      if (drag.current)
        resize(drag.current.width + (event.clientX - drag.current.x) * (side === 'left' ? 1 : -1));
    },
    onPointerUp: (event) => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onDoubleClick: () => resize(initial),
    onKeyDown: (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        resize(width + (event.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1));
      }
    },
  };
  return { host, width, separatorProps };
}
