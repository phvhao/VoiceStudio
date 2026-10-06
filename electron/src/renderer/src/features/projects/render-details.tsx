import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { PUNCTUATION_FAMILIES } from '@shared/utils/longformOverrides';
import { useVoiceGainText } from '../longform/cast-settings';

export interface RenderSummary {
  engine?: string;
  voices?: { id: string; name: string }[];
  language?: string;
  format?: string;
  lines?: number;
  words?: number;
  speeds?: number[];
  options?: Record<string, unknown>;
  chapter_titles?: string[];
}

export interface RenderRecord {
  job_id: string;
  title?: string;
  output: string;
  type?: 'story' | 'audiobook';
  created_at?: number | string;
  duration_s?: number;
  chapters?: number;
  summary?: RenderSummary;
  /** The library project it was rendered from; renders made before the library have none. */
  project_id?: string;
  /** Whether its reading timeline was kept. */
  timeline?: boolean;
}

export function clock(seconds: number | undefined): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function speedLabel(speeds: number[] | undefined): string {
  const values = (Array.isArray(speeds) ? speeds : []).filter((value) => Number.isFinite(value));
  if (!values.length) return '';
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? `${low.toFixed(2)}×` : `${low.toFixed(2)}–${high.toFixed(2)}×`;
}

export const voiceLabel = (summary: RenderSummary | undefined) =>
  (Array.isArray(summary?.voices) ? summary.voices : [])
    .map((voice) => voice?.name || voice?.id)
    .filter(Boolean)
    .join(', ');

/** One language-neutral line that tells two renders apart in a list. */
export function renderRecipe(render: RenderRecord): string {
  return [
    voiceLabel(render.summary),
    speedLabel(render.summary?.speeds),
    render.summary?.engine,
    render.duration_s ? clock(render.duration_s) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const OPTION_LABELS: Record<string, string> = {
  num_step: 'clone.steps',
  guidance_scale: 'clone.cfg',
  position_temperature: 'clone.pos_temp',
  class_temperature: 'clone.class_temp',
  postprocess_output: 'clone.postprocess',
  seed: 'audiobook.seed',
  emo_vector: 'audiobook.emotion_help',
  emo_text: 'audiobook.emotion_text',
  emo_alpha: 'audiobook.emotion_alpha',
  vary_repeats: 'audiobook.vary_repeats',
  line_gap_ms: 'audiobook.line_gap',
  paragraph_gap_ms: 'audiobook.paragraph_gap',
  trim_edges: 'audiobook.trim_edges',
  punctuation_pauses: 'pacing.pauses',
  split_commas: 'pacing.split_commas',
  verify_speech: 'pacing.verify',
  level_voices: 'leveling.auto',
  voice_gains: 'leveling.volume',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** One recorded setting as a reader sees it; '' when there is nothing readable to show. */
function optionText(
  key: string,
  value: unknown,
  t: TFunction,
  gainText: (db: number) => string,
): string {
  if (key === 'voice_gains' || key === 'punctuation_pauses') {
    if (!isRecord(value)) return '';
    return Object.entries(value)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      )
      .map(([name, amount]) => {
        // Gains are dB by cast name, '' naming the book's default voice;
        // pauses are milliseconds by punctuation family.
        if (key === 'voice_gains')
          return `${name || t('audiobook.default_voice')} ${gainText(amount)}`;
        const mark = (PUNCTUATION_FAMILIES as readonly string[]).includes(name)
          ? t(`pacing.mark_${name}`)
          : name;
        return `${mark} ${t('engines.latencyMs', { ms: amount })}`;
      })
      .join(', ');
  }
  if (typeof value === 'boolean')
    return t(value ? 'pronunciation.enabled' : 'supportPlans.disabled');
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (Array.isArray(value)) return value.filter((item) => Number.isFinite(item)).join(', ');
  return '';
}

/** "How it was made" for one finished render; older renders have no summary. */
export function RenderDetails({ render }: { render: RenderRecord }) {
  const { t } = useTranslation();
  const gainText = useVoiceGainText();
  const summary = render.summary;
  if (!summary)
    return <p className="text-xs text-muted-foreground">{t('projects.render_no_details')}</p>;
  const options = Object.entries(
    summary.options && typeof summary.options === 'object' ? summary.options : {},
  )
    .filter(([key]) => Object.hasOwn(OPTION_LABELS, key))
    .map(([key, value]) => [key, optionText(key, value, t, gainText)] as const)
    .filter(([, display]) => display)
    .map(([key, display]) => `${t(OPTION_LABELS[key])} ${display}`)
    .join(' · ');
  const rows: [string, string][] = [
    [t('projects.render_voice'), voiceLabel(summary)],
    [t('projects.render_speed'), speedLabel(summary.speeds)],
    [t('projects.render_engine'), summary.engine || ''],
    [t('projects.render_language'), summary.language || ''],
    [t('projects.render_format'), (summary.format || '').toUpperCase()],
    [
      t('projects.render_size_label'),
      t('projects.render_size', {
        chapters: render.chapters ?? summary.chapter_titles?.length ?? 0,
        lines: summary.lines ?? 0,
        words: summary.words ?? 0,
      }),
    ],
    [t('projects.render_settings'), options],
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
    </dl>
  );
}
