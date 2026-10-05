import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiPath: (path: string) => path,
  describeError: String,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src }: { src: string }) => <audio data-testid="preview" src={src} />,
}));
import { ChapterPreview, useChapterPreview, type ChapterPreviewState } from './chapter-previews';
import { blankLongformDraft, type Draft } from './longform-session';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const draft: Draft = {
  ...blankLongformDraft(),
  script: '# One\nThe night was quiet. [voice:Mara] Who is there?',
  voice: 'narrator',
};

let state: ChapterPreviewState;
const rendered = vi.fn();
function Harness({ value }: { value: Draft }) {
  state = useChapterPreview(value, {
    disabled: false,
    canPreview: true,
    onBusy: () => {},
    onRendered: rendered,
  });
  return <ChapterPreview preview={state} />;
}

it('renders one chapter through the preview endpoint and reports it', async () => {
  mock.api.mockResolvedValue({ output: 'longform_cache/abc.wav', title: 'One' });
  render(<Harness value={draft} />);
  await act(() => state.render(0));
  expect(mock.api).toHaveBeenCalledWith(
    '/audiobook/preview',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(JSON.parse(mock.api.mock.calls[0][1].body)).toMatchObject({
    chapter_index: 0,
    text: draft.script,
  });
  expect(screen.getByText('One')).toBeVisible();
  expect(screen.getByTestId('preview')).toHaveAttribute(
    'src',
    '/audio/' + encodeURIComponent('longform_cache/abc.wav'),
  );
  expect(rendered).toHaveBeenCalledTimes(1);
});

it('clears the preview when a volume the script uses changes', async () => {
  mock.api.mockResolvedValue({ output: 'longform_cache/abc.wav', title: 'One' });
  const view = render(<Harness value={draft} />);
  await act(() => state.render(0));
  expect(screen.getByText('One')).toBeVisible();

  // A name the script never speaks does not change the preview request.
  view.rerender(<Harness value={{ ...draft, voiceGains: { Ben: 6 } }} />);
  expect(screen.getByText('One')).toBeVisible();

  view.rerender(<Harness value={{ ...draft, voiceGains: { Mara: 3 } }} />);
  expect(screen.queryByText('One')).toBeNull();
});
