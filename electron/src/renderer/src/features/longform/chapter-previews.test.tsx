import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiPath: (path: string) => path,
  describeError: String,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ChapterPreviews } from './chapter-previews';
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

function mount(value: Draft) {
  const props = { disabled: false, canPreview: true, onBusy: () => {} };
  const view = render(<ChapterPreviews draft={value} {...props} />);
  return (next: Draft) => view.rerender(<ChapterPreviews draft={next} {...props} />);
}

it('clears the chapter plan when a volume the script uses changes', async () => {
  mock.api.mockResolvedValue({ chapters: [{ title: 'One', char_count: 42 }] });
  const update = mount(draft);
  fireEvent.click(screen.getByRole('button', { name: 'audiobook.preview_plan' }));
  expect(await screen.findByText('One')).toBeVisible();

  // A name the script never speaks does not change the preview request.
  update({ ...draft, voiceGains: { Ben: 6 } });
  expect(screen.getByText('One')).toBeVisible();

  update({ ...draft, voiceGains: { Mara: 3 } });
  expect(screen.queryByText('One')).toBeNull();
});
