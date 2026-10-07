import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The option a key moves to in a row of `count` radio options (the ARIA radio
 * group pattern): → and ↓ the next, ← and ↑ the one before, both wrapping
 * round, ← and → trading places in a right-to-left language; Home the first,
 * End the last. `null` for any other key.
 */
export function radioStep(key: string, current: number, count: number, rtl = false): number | null {
  if (count < 1) return null;
  const next = rtl ? 'ArrowLeft' : 'ArrowRight';
  const previous = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === next || key === 'ArrowDown') return (current + 1) % count;
  if (key === previous || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Keys for a radio group of buttons: one Tab stop (the checked option, else
 * the first), and the arrow keys, Home and End move to an option and choose
 * it. Spread `group` on the `role="radiogroup"` element and `option(i)` on
 * each `role="radio"` button.
 */
export function useRadioKeys<T>(values: readonly T[], checked: T, choose: (value: T) => void) {
  const { i18n } = useTranslation();
  const options = useRef<Array<HTMLElement | null>>([]);
  const current = values.indexOf(checked);
  return {
    group: {
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const rtl = i18n.dir?.(i18n.language) === 'rtl';
        const next = radioStep(event.key, Math.max(0, current), values.length, rtl);
        if (next === null) return;
        event.preventDefault();
        options.current[next]?.focus();
        choose(values[next]);
      },
    },
    option: (index: number) => ({
      ref: (node: HTMLElement | null) => {
        options.current[index] = node;
      },
      tabIndex: index === (current < 0 ? 0 : current) ? 0 : -1,
    }),
  };
}
