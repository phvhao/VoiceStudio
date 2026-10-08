import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DownloadIcon, FileCodeIcon, MonitorIcon, SmartphoneIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useRadioKeys } from '@/hooks/use-radio-keys';
import { useProfiles } from '@/hooks/use-profiles';
import { apiJson, describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { BOOK_FONT_CATEGORIES, useBookFonts, type BookFontFamily } from './book-fonts';
import {
  DEFAULT_TEMPLATE,
  NUMBERING,
  SYSTEM_FONT,
  templateDesign,
  type HtmlDesign,
  type HtmlTemplate,
  type HtmlTemplates,
  type Numbering,
} from './html-design';
import { exportBookHtml, htmlExportBody } from './html-export';
import { editLongform, type Draft, type Mode } from './longform-session';

/** How wide the preview lays the page out, in CSS pixels, before it is scaled to fit. */
const PREVIEW_WIDTH = { desktop: 1280, phone: 390 } as const;
type PreviewSize = keyof typeof PREVIEW_WIDTH;
const PREVIEW_SIZES = Object.keys(PREVIEW_WIDTH) as PreviewSize[];
/** Quiet time after a change before the preview is asked for again. */
const PREVIEW_DELAY_MS = 250;

/** Each template's name and what it looks like, in the app's words. */
const TEMPLATE_TEXT: Record<string, (t: TFunction) => [string, string]> = {
  classic: (t) => [t('bookExport.template_classic'), t('bookExport.template_classic_hint')],
  modern: (t) => [t('bookExport.template_modern'), t('bookExport.template_modern_hint')],
  magazine: (t) => [t('bookExport.template_magazine'), t('bookExport.template_magazine_hint')],
  cinematic: (t) => [t('bookExport.template_cinematic'), t('bookExport.template_cinematic_hint')],
  kids: (t) => [t('bookExport.template_kids'), t('bookExport.template_kids_hint')],
  script: (t) => [t('bookExport.template_script'), t('bookExport.template_script_hint')],
};

/** The accent colours the backend offers, by name. */
const ACCENT_NAMES: Record<string, (t: TFunction) => string> = {
  '#b3261e': (t) => t('bookExport.accent_red'),
  '#c2410c': (t) => t('bookExport.accent_orange'),
  '#a16207': (t) => t('bookExport.accent_gold'),
  '#15803d': (t) => t('bookExport.accent_green'),
  '#0f766e': (t) => t('bookExport.accent_teal'),
  '#1d4ed8': (t) => t('bookExport.accent_blue'),
  '#6d28d9': (t) => t('bookExport.accent_violet'),
  '#be185d': (t) => t('bookExport.accent_pink'),
  '#475569': (t) => t('bookExport.accent_slate'),
};

const CATEGORY_NAMES: Record<BookFontFamily['category'], (t: TFunction) => string> = {
  serif: (t) => t('bookExport.font_serif'),
  display: (t) => t('bookExport.font_display'),
  sans: (t) => t('bookExport.font_sans'),
  rounded: (t) => t('bookExport.font_rounded'),
  handwriting: (t) => t('bookExport.font_handwriting'),
  mono: (t) => t('bookExport.font_mono'),
};

function numberingLabel(t: TFunction, numbering: Numbering) {
  if (numbering === 'words') return t('audiobook.chapter_n', { n: 1 });
  if (numbering === 'numeral') return t('bookExport.numbering_numeral');
  if (numbering === 'roman') return t('bookExport.numbering_roman');
  return t('bookExport.numbering_none');
}

/** `value` once it has stayed the same for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The bytes the page carries for `design`'s fonts: each bundled family once,
 * its italics only where the template sets them, as base64.
 */
export function embeddedFontBytes(
  design: HtmlDesign,
  template: HtmlTemplate | undefined,
  families: readonly BookFontFamily[],
) {
  const italic = new Map<string, boolean>();
  for (const [role, id] of [
    ['body', design.bodyFont],
    ['heading', design.headingFont],
  ] as const) {
    if (!families.some((family) => family.id === id)) continue;
    italic.set(id, (italic.get(id) ?? false) || Boolean(template?.italic.includes(role)));
  }
  let bytes = 0;
  for (const [id, withItalic] of italic) {
    const family = families.find((f) => f.id === id)!;
    for (const face of family.files) if (withItalic || face.style !== 'italic') bytes += face.bytes;
  }
  return Math.ceil(bytes / 3) * 4;
}

function formatSize(bytes: number, locale: string) {
  const mega = bytes >= 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: mega ? 'megabyte' : 'kilobyte',
    unitDisplay: 'short',
    maximumFractionDigits: mega ? 1 : 0,
  }).format(mega ? bytes / 1_000_000 : bytes / 1000);
}

/** A template's card picture: its paper, type and accent, drawn small. */
function TemplateSwatch({ template }: { template: HtmlTemplate }) {
  const { bg, fg, accent, line } = template.swatch;
  const text = { background: fg, opacity: 0.32 } as CSSProperties;
  const id = template.id;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex aspect-[4/3] w-full flex-col justify-center gap-[5%] overflow-hidden rounded-md px-[14%] ring-1 ring-black/10 ring-inset',
        id === 'kids' && 'rounded-xl',
      )}
      style={{ background: bg }}
    >
      {id === 'cinematic' && (
        <span
          className="absolute inset-x-0 top-0 h-[42%]"
          style={{ background: `linear-gradient(${accent}55, transparent)` }}
        />
      )}
      {id === 'magazine' && (
        <span className="h-[3%] w-full" style={{ background: fg, opacity: 0.85 }} />
      )}
      <span
        className={cn(
          'relative rounded-sm',
          id === 'magazine' ? 'h-[14%] w-4/5' : 'h-[9%] w-1/2',
          id === 'classic' && 'mx-auto',
          id === 'kids' && 'mx-auto h-[12%] rounded-full',
          id === 'script' && 'h-[7%] w-2/5',
        )}
        style={{ background: id === 'magazine' ? fg : accent }}
      />
      {[0.92, 0.84, 0.88, 0.6].map((width, row) => (
        <span key={row} className="relative flex items-center gap-[6%]">
          {id === 'script' && (
            <span
              className="h-[3px] w-[18%] shrink-0 rounded-full"
              style={{ background: row % 2 ? line : accent }}
            />
          )}
          <span
            className={cn('h-[3px] rounded-full', id === 'kids' && 'h-[4px]')}
            style={{ ...text, width: `${width * (id === 'script' ? 70 : 100)}%` }}
          />
        </span>
      ))}
      {id === 'kids' && (
        <span className="mx-auto mt-[2%] size-[16%] rounded-full" style={{ background: accent }} />
      )}
      {id === 'modern' && (
        <span
          className="absolute end-[8%] bottom-[10%] h-[22%] w-[24%] rounded-sm"
          style={{ background: line }}
        />
      )}
    </span>
  );
}

function TemplateGallery({
  templates,
  value,
  onChange,
}: {
  templates: HtmlTemplate[];
  value: string;
  onChange: (template: HtmlTemplate) => void;
}) {
  const { t } = useTranslation();
  const heading = useId();
  const hints = useId();
  const keys = useRadioKeys(
    templates.map((template) => template.id),
    value,
    (id) => onChange(templates.find((template) => template.id === id)!),
  );
  const chosen = templates.find((template) => template.id === value);
  return (
    <section className="space-y-2">
      <h3 id={heading} className="text-xs font-medium text-muted-foreground">
        {t('bookExport.design')}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={heading}
        {...keys.group}
        className="grid grid-cols-3 gap-2"
      >
        {templates.map((template, index) => {
          const [name, hint] = TEMPLATE_TEXT[template.id]?.(t) ?? [template.id, ''];
          const checked = template.id === value;
          return (
            <button
              key={template.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-describedby={hint ? `${hints}-${template.id}` : undefined}
              title={hint}
              {...keys.option(index)}
              onClick={() => onChange(template)}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg border p-1.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                checked
                  ? 'border-primary bg-primary/8 ring-1 ring-primary'
                  : 'border-border/60 hover:border-border hover:bg-muted/40',
              )}
            >
              <TemplateSwatch template={template} />
              <span className="truncate px-0.5 text-xs font-medium">{name}</span>
            </button>
          );
        })}
      </div>
      {/* What each template looks like: its card's description, not its name. */}
      <div hidden>
        {templates.map((template) => (
          <span key={template.id} id={`${hints}-${template.id}`}>
            {TEMPLATE_TEXT[template.id]?.(t)[1]}
          </span>
        ))}
      </div>
      {chosen && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {TEMPLATE_TEXT[chosen.id]?.(t)[1]}
        </p>
      )}
    </section>
  );
}

function AccentPicker({
  value,
  own,
  offered,
  onChange,
}: {
  value: string;
  /** The template's own colour, offered first. */
  own: string;
  offered: string[];
  onChange: (accent: string) => void;
}) {
  const { t } = useTranslation();
  const heading = useId();
  const colors = useMemo(() => [...new Set([own, ...offered])], [own, offered]);
  const keys = useRadioKeys(colors, value, onChange);
  const custom = !colors.includes(value);
  return (
    <section className="space-y-2">
      <h3 id={heading} className="text-xs font-medium text-muted-foreground">
        {t('bookExport.accent')}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          role="radiogroup"
          aria-labelledby={heading}
          {...keys.group}
          className="flex flex-wrap gap-1.5"
        >
          {colors.map((color, index) => {
            const name =
              color === own ? t('bookExport.accent_design') : (ACCENT_NAMES[color]?.(t) ?? color);
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={color === value}
                aria-label={name}
                title={name}
                {...keys.option(index)}
                onClick={() => onChange(color)}
                className={cn(
                  'size-7 rounded-full ring-offset-2 ring-offset-background outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                  color === value ? 'ring-2 ring-foreground' : 'ring-1 ring-black/15',
                  color === own && 'outline-2 outline-offset-[-6px] outline-white/80',
                )}
                style={{ background: color }}
              />
            );
          })}
        </div>
        <label
          className={cn(
            'relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 ps-1 pe-2.5 text-xs focus-within:ring-2 focus-within:ring-ring',
            custom && 'border-foreground',
          )}
          title={t('bookExport.accent_custom')}
        >
          <span
            aria-hidden="true"
            className="size-5 rounded-full ring-1 ring-black/15"
            style={{
              background: custom
                ? value
                : 'conic-gradient(#ef4444, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #ef4444)',
            }}
          />
          {t('bookExport.accent_custom')}
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={value}
            aria-label={t('bookExport.accent_custom')}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
          />
        </label>
      </div>
    </section>
  );
}

function FontSelect({
  label,
  value,
  families,
  onChange,
}: {
  label: string;
  value: string;
  families: readonly BookFontFamily[];
  onChange: (font: string) => void;
}) {
  const { t } = useTranslation();
  const items = [
    { value: SYSTEM_FONT, label: t('bookExport.system_fonts') },
    ...families.map((family) => ({ value: family.id, label: family.family })),
  ];
  return (
    <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <Select items={items} value={value} onValueChange={(font) => onChange(String(font))}>
        <SelectTrigger aria-label={label} className="w-full text-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false} className="max-h-80">
          <SelectItem value={SYSTEM_FONT}>{t('bookExport.system_fonts')}</SelectItem>
          {BOOK_FONT_CATEGORIES.map((category) => {
            const members = families.filter((family) => family.category === category);
            if (!members.length) return null;
            return (
              <SelectGroup key={category}>
                <SelectLabel>{CATEGORY_NAMES[category](t)}</SelectLabel>
                {members.map((family) => (
                  <SelectItem key={family.id} value={family.id}>
                    {family.family}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

/** The page, laid out at a desktop or phone width and scaled to fit. */
function PagePreview({ html, size }: { html: string | undefined; size: PreviewSize }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const width = PREVIEW_WIDTH[size];
  const scale = box.width ? Math.min(1, box.width / width) : 1;
  const shown = size === 'phone' ? Math.min(width * scale, box.width) : box.width;
  return (
    // A picture of the page, not a page to use: out of the tab order and the
    // accessibility tree (the template's name and hint describe it).
    <div ref={frame} inert className="relative min-h-0 flex-1 overflow-hidden">
      {html !== undefined && (
        <div
          className={cn(
            'absolute top-0 overflow-hidden bg-background shadow-sm ring-1 ring-border/60',
            size === 'phone'
              ? 'start-1/2 -translate-x-1/2 rounded-[1.25rem] rtl:translate-x-1/2'
              : 'start-0 rounded-md',
          )}
          style={{ width: shown || '100%', height: '100%' }}
        >
          <iframe
            title={t('bookExport.preview_title')}
            srcDoc={html}
            // No script: the page sets its text itself, and the frame shows it.
            sandbox=""
            tabIndex={-1}
            className="origin-top-left border-0 rtl:origin-top-right"
            style={{
              width,
              height: box.height && scale ? box.height / scale : '100%',
              transform: `scale(${scale})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Export HTML: pick the page's design — a template and its quick options,
 * kept with the book — over a live preview of its first chapter, then export
 * the whole book and its audio as a ZIP.
 */
export function HtmlExportDialog({
  open,
  onOpenChange,
  draft,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: Draft;
  mode: Mode;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const direction = i18n.dir(lang);
  const templatesQuery = useQuery({
    queryKey: ['html-book-templates'],
    queryFn: ({ signal }) => apiJson<HtmlTemplates>('/audiobook/export/html/templates', { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: open,
  });
  const fonts = useBookFonts({ enabled: open });
  const families = fonts.data ?? [];
  const profiles = useProfiles();
  const templates = templatesQuery.data?.templates ?? [];
  const saved = draft.htmlExport;
  // Each opening starts from the book's own design; changes are kept with it.
  const [chosen, setChosen] = useState<HtmlDesign | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setChosen(null);
  }
  const start =
    templates.find((template) => template.id === DEFAULT_TEMPLATE[mode]) ?? templates[0];
  const design: HtmlDesign | null =
    chosen ??
    (saved && templates.some((template) => template.id === saved.template)
      ? saved
      : start
        ? templateDesign(start)
        : null);
  const template = templates.find((item) => item.id === design?.template);
  const change = (next: HtmlDesign) => {
    setChosen(next);
    editLongform(mode, { htmlExport: next });
  };
  const patch = (value: Partial<HtmlDesign>) => design && change({ ...design, ...value });
  // A book's voices by name: a [voice:…] tag may name a profile by its id.
  const voiceNames = useMemo(
    () =>
      mode === 'audiobook'
        ? Object.fromEntries((profiles.data ?? []).map((profile) => [profile.id, profile.name]))
        : undefined,
    [mode, profiles.data],
  );
  const [size, setSize] = useState<PreviewSize>('desktop');
  const sizeKeys = useRadioKeys(PREVIEW_SIZES, size, setSize);
  // The preview follows the design once it has stayed put a moment (by its
  // value: a design is rebuilt on every render).
  const settledKey = useSettled(design && JSON.stringify(design), PREVIEW_DELAY_MS);
  const settled: HtmlDesign | null = settledKey ? JSON.parse(settledKey) : null;
  const preview = useQuery({
    queryKey: ['html-book-preview', draft.output, settledKey, lang],
    queryFn: ({ signal }) =>
      apiJson<{ html: string }>('/audiobook/export/html/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          htmlExportBody(draft, t, lang, direction, { mode, design: settled, voiceNames }),
        ),
        signal,
      }),
    enabled: open && Boolean(settled) && Boolean(draft.output),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exportNow = async () => {
    if (!design) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await exportBookHtml(draft, t, lang, direction, {
        mode,
        design,
        voiceNames,
      });
      // A save dialog closed without saving keeps the choices open for another try.
      if (outcome !== 'canceled') onOpenChange(false);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const bytes = design ? embeddedFontBytes(design, template, families) : 0;
  const status = preview.isError
    ? t('bookExport.preview_failed', { error: describeError(preview.error) })
    : preview.isFetching || !preview.data
      ? t('bookExport.preview_loading')
      : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(92vh,52rem)] w-[min(96vw,76rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="flex items-start gap-3 border-b border-border/50 py-3 pe-3 ps-5">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileCodeIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">{t('bookExport.title')}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              {t('bookExport.description')}
            </DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.close')}
                title={t('common.close')}
              />
            }
          >
            <XIcon />
          </DialogClose>
        </div>
        {/* Wide: the options beside the preview, each scrolling on its own.
            Narrow: the options, then the preview at a set height, scrolling together. */}
        <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[21rem_minmax(0,1fr)] md:overflow-hidden">
          <div className="mx-auto max-w-md space-y-5 p-5 md:mx-0 md:min-h-0 md:max-w-none md:overflow-y-auto md:border-e md:border-border/50">
            {templatesQuery.isError && (
              <p role="alert" className="text-xs text-destructive">
                {describeError(templatesQuery.error)}
              </p>
            )}
            {!design ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <>
                <TemplateGallery
                  templates={templates}
                  value={design.template}
                  // A template starts the look over; where the page opens stays.
                  onChange={(next) =>
                    change({ ...templateDesign(next), ...(design?.view ? { view: design.view } : {}) })
                  }
                />
                <AccentPicker
                  value={design.accent}
                  own={template?.defaults.accent ?? design.accent}
                  offered={templatesQuery.data?.accents ?? []}
                  onChange={(accent) => patch({ accent })}
                />
                <div className="space-y-3">
                  <FontSelect
                    label={t('bookExport.body_font')}
                    value={design.bodyFont}
                    families={families}
                    onChange={(bodyFont) => patch({ bodyFont })}
                  />
                  <FontSelect
                    label={t('bookExport.heading_font')}
                    value={design.headingFont}
                    families={families}
                    onChange={(headingFont) => patch({ headingFont })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {bytes
                      ? t('bookExport.fonts_size', { size: formatSize(bytes, lang) })
                      : t('bookExport.fonts_none')}
                  </p>
                </div>
                <label className="flex items-center justify-between gap-3 text-sm">
                  {mode === 'stories'
                    ? t('bookExport.show_characters')
                    : t('bookExport.show_voices')}
                  <Switch
                    checked={design.showNames}
                    onCheckedChange={(showNames) => patch({ showNames })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    <span className="block">{t('bookExport.open_slideshow')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('bookExport.open_slideshow_hint')}
                    </span>
                  </span>
                  <Switch
                    checked={design.view === 'show'}
                    onCheckedChange={(on) =>
                      design &&
                      change(
                        on
                          ? { ...design, view: 'show' }
                          : (({ view: _view, ...rest }) => rest)(design),
                      )
                    }
                  />
                </label>
                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  <span>{t('bookExport.numbering')}</span>
                  <Select
                    items={NUMBERING.map((value) => ({ value, label: numberingLabel(t, value) }))}
                    value={design.numbering}
                    onValueChange={(numbering) => patch({ numbering: numbering as Numbering })}
                  >
                    <SelectTrigger
                      aria-label={t('bookExport.numbering')}
                      className="w-full text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      {NUMBERING.map((value) => (
                        <SelectItem key={value} value={value}>
                          {numberingLabel(t, value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </>
            )}
          </div>
          <div className="flex h-[32rem] min-w-0 flex-col gap-3 border-t border-border/50 bg-muted/25 p-4 md:h-auto md:min-h-0 md:border-t-0">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('bookExport.preview')}
              </h3>
              <div
                role="radiogroup"
                aria-label={t('bookExport.preview')}
                {...sizeKeys.group}
                className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5 ring-1 ring-border/50 ring-inset"
              >
                {PREVIEW_SIZES.map((value, index) => {
                  const Icon = value === 'phone' ? SmartphoneIcon : MonitorIcon;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={size === value}
                      {...sizeKeys.option(index)}
                      onClick={() => setSize(value)}
                      className={cn(
                        'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                        size === value
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                      {value === 'phone'
                        ? t('bookExport.preview_phone')
                        : t('bookExport.preview_desktop')}
                    </button>
                  );
                })}
              </div>
            </div>
            <PagePreview html={preview.data?.html} size={size} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
          <p
            role={error ? 'alert' : 'status'}
            className={cn(
              'me-auto min-w-0 flex-1 truncate text-xs',
              error ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {error ?? status}
          </p>
          <DialogClose render={<Button variant="ghost" />}>{t('common.cancel')}</DialogClose>
          <Button disabled={busy || !design} onClick={() => void exportNow()}>
            {busy ? <Spinner /> : <DownloadIcon />}
            {busy ? t('bookExport.exporting') : t('bookExport.export')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Export HTML" beside a finished book's or story's downloads: opens the design dialog. */
export function ExportHtmlButton({
  draft,
  mode,
  disabled,
}: {
  draft: Draft;
  mode: Mode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={t('book.export_html_hint')}
        onClick={() => setOpen(true)}
      >
        <FileCodeIcon />
        {t('book.export_html')}
      </Button>
      <HtmlExportDialog open={open} onOpenChange={setOpen} draft={draft} mode={mode} />
    </>
  );
}
