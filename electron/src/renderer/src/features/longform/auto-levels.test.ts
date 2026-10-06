import { describe, expect, it } from 'vitest';
import { bookAutoLevels, chapterLevels } from './auto-levels';

describe('auto levels', () => {
  it('keeps only the well-formed levels of a chapter event', () => {
    expect(chapterLevels({ type: 'chapter' })).toBeUndefined();
    expect(chapterLevels({ levels: [] })).toBeUndefined();
    expect(
      chapterLevels({
        levels: {
          '': { level_db: -26, auto_db: 6 },
          Mara: { level_db: 'loud', auto_db: 1 },
          Cole: { level_db: -14, auto_db: Number.NaN },
          Gone: null,
        },
      }),
    ).toEqual({ '': { level_db: -26, auto_db: 6 } });
  });

  it('takes the median of each voice’s chapter gains, to 0.1 dB', () => {
    const chapter = (levels?: Record<string, number>) => ({
      title: '',
      status: 'done',
      ...(levels && {
        levels: Object.fromEntries(
          Object.entries(levels).map(([name, auto_db]) => [name, { level_db: -20, auto_db }]),
        ),
      }),
    });
    expect(
      bookAutoLevels([
        chapter({ '': 4.94, Mara: -3 }),
        chapter({ '': 5.3 }),
        chapter(),
        chapter({ '': 12, Mara: -2.04 }),
      ]),
    ).toEqual({ '': 5.3, Mara: -2.5 });
    expect(bookAutoLevels(undefined)).toEqual({});
    expect(bookAutoLevels([chapter()])).toEqual({});
  });
});
