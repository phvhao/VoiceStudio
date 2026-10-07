import { expect, it } from 'vitest';
import { scriptCounts } from './script-counts';

it('counts characters as code points, the way the backend limits them', () => {
  expect(scriptCounts('Xin chào 👋').chars).toBe(10);
  expect(scriptCounts('').chars).toBe(0);
});

it('counts spoken words and sentences, leaving markup out', () => {
  expect(scriptCounts('Hello world. [laughter] Hi [pause 1s] there!')).toMatchObject({
    words: 4,
    sentences: 2,
  });
  // A respelling is what is spoken.
  expect(scriptCounts('Say [[GIF|jif]] now.')).toMatchObject({ words: 3, sentences: 1 });
  // Tags alone are silent.
  expect(scriptCounts('[pause 1s] [laughter]')).toMatchObject({ words: 0, sentences: 0 });
});

it('ends a sentence at a line break, as reading does, and at full-width marks', () => {
  expect(scriptCounts('Một dòng\nDòng thứ hai\n\nBa').sentences).toBe(3);
  expect(scriptCounts('你好。今天天气很好！').sentences).toBe(2);
  expect(scriptCounts('Thật sao? Vâng. Đi thôi!').sentences).toBe(3);
});

it('estimates the time read aloud, at the chosen speed', () => {
  const words = Array.from({ length: 155 }, () => 'word').join(' ');
  expect(scriptCounts(words).seconds).toBeCloseTo(60);
  expect(scriptCounts(words, 2).seconds).toBeCloseTo(30);
  expect(scriptCounts(words, Number.NaN).seconds).toBeCloseTo(60);
  expect(scriptCounts('').seconds).toBe(0);
});
