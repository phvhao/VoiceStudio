import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OmissionFlag, VideoFitBadge, VideoFitControl, segmentVideoRatio } from './segment-fit';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
afterEach(cleanup);

it('reads the retimed video ratio of Smart Fit and Stretch Video segments, both ways', () => {
  expect(segmentVideoRatio({ status: 'video_shrunk', video_ratio: 0.85 })).toBe(0.85);
  expect(segmentVideoRatio({ status: 'hybrid', video_ratio: 1.18 })).toBe(1.18);
  expect(segmentVideoRatio({ status: 'video_stretched', stretch_ratio: 0.9 })).toBe(0.9);
  // Stretch Video reports 1.0 for a line that already matched; nothing to show.
  expect(segmentVideoRatio({ status: 'video_stretched', stretch_ratio: 1.001 })).toBeUndefined();
  expect(segmentVideoRatio({ status: 'audio_slowed', audio_rate: 0.9 })).toBeUndefined();
  expect(segmentVideoRatio(undefined)).toBeUndefined();
});

it('badges a sped-up segment as "Video 0.85×" and explains the direction', () => {
  render(<VideoFitBadge fit={{ status: 'video_shrunk', audio_rate: 0.9, video_ratio: 0.85 }} />);
  const badge = screen.getByTitle('segment.fit_video_sped_title {"ratio":"0.85"}');
  expect(badge.textContent).toContain('segment.fit_stretched {"ratio":"0.85"}');
  cleanup();
  render(<VideoFitBadge fit={{ status: 'hybrid', video_ratio: 1.2 }} />);
  expect(screen.getByTitle('segment.fit_video_slowed_title {"ratio":"1.20"}')).toBeTruthy();
  cleanup();
  const { container } = render(<VideoFitBadge fit={{ status: 'fits' }} />);
  expect(container.textContent).toBe('');
});

it('flags possibly missing content with its reason and a Translate again action', () => {
  const again = vi.fn();
  render(
    <OmissionFlag
      omission={{ reason: 'sentences', ratio: 0.65, source_sentences: 2, target_sentences: 1 }}
      onTranslateAgain={again}
    />,
  );
  const button = screen.getByRole('button', { name: 'segment.translate_again' });
  const reason = 'segment.omission_sentences_title {"source":2,"target":1}';
  expect(screen.getByText('segment.omission')).toBeTruthy();
  // The reason is on screen (truncated, in full on hover) and describes the action.
  expect(screen.getByTitle(reason).textContent).toBe(reason);
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
    reason,
  );
  fireEvent.click(button);
  expect(again).toHaveBeenCalledOnce();
  cleanup();
  render(
    <OmissionFlag
      omission={{ reason: 'short', ratio: 0.4, source_sentences: 1, target_sentences: 1 }}
      disabled
      onTranslateAgain={again}
    />,
  );
  expect(screen.getByTitle('segment.omission_short_title')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'segment.translate_again' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('says why a translation stuck repeating one word is flagged, with Translate again', () => {
  const again = vi.fn();
  render(
    <OmissionFlag
      omission={{
        reason: 'repeated',
        ratio: 6.6,
        source_sentences: 1,
        target_sentences: 1,
        repeats: 40,
      }}
      onTranslateAgain={again}
    />,
  );
  const button = screen.getByRole('button', { name: 'segment.translate_again' });
  expect(screen.getByText('segment.omission')).toBeTruthy();
  expect(screen.getByTitle('segment.omission_repeated_title')).toBeTruthy();
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
    'segment.omission_repeated_title',
  );
  fireEvent.click(button);
  expect(again).toHaveBeenCalledOnce();
});

it('offers Auto, Keep, Allow shrink and Allow stretch for a line', () => {
  const change = vi.fn();
  render(<VideoFitControl value="keep" onChange={change} />);
  const group = screen.getByRole('group', { name: 'segment.video_fit' });
  const buttons = Array.from(group.querySelectorAll('button'));
  expect(buttons.map((button) => button.textContent)).toEqual([
    'segment.video_fit_auto',
    'segment.video_fit_keep',
    'segment.video_fit_shrink',
    'segment.video_fit_stretch',
  ]);
  expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
    'false',
    'true',
    'false',
    'false',
  ]);
  fireEvent.click(buttons[2]);
  expect(change).toHaveBeenLastCalledWith('shrink');
  fireEvent.click(buttons[0]);
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(screen.queryByText('segment.video_fit_incomplete')).toBeNull();
  cleanup();
  render(<VideoFitControl value={undefined} mayBeIncomplete onChange={change} />);
  expect(screen.getByText('segment.video_fit_incomplete')).toBeTruthy();
});
