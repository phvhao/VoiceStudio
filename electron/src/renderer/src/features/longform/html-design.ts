/**
 * A book's look as a web page — the template and its quick options — as its
 * project keeps it (`Draft.htmlExport`), and as the backend reads it
 * (`services/book_templates.py`, which lists the templates and what each
 * starts with: `GET /audiobook/export/html/templates`).
 */

export type Numbering = 'words' | 'numeral' | 'roman' | 'none';
export const NUMBERING: readonly Numbering[] = ['words', 'numeral', 'roman', 'none'];
/** The font choice that embeds no font: the reader's own, the smallest page. */
export const SYSTEM_FONT = 'system';
/** What Audiobook and Stories start with before a design is picked. */
export const DEFAULT_TEMPLATE = { audiobook: 'classic', stories: 'script' } as const;

export interface HtmlDesign {
  template: string;
  /** `#rrggbb`. */
  accent: string;
  /** A bundled family's id (`GET /fonts`) or `SYSTEM_FONT`. */
  bodyFont: string;
  headingFont: string;
  /** Voice (Audiobook) or character (Stories) names beside the text. */
  showNames: boolean;
  numbering: Numbering;
  /** The page opens in its slideshow; left out, in its text. */
  view?: 'show';
}

/** A template as the backend lists it. */
export interface HtmlTemplate {
  id: string;
  /** Offered first for Stories. */
  stories: boolean;
  /** Whose italics the page embeds too: `body`, `heading`. */
  italic: string[];
  defaults: {
    accent: string;
    body_font: string;
    heading_font: string;
    show_names: boolean;
    numbering: Numbering;
  };
  /** Its light paper, text, accent and rule colours, for its card. */
  swatch: { bg: string; fg: string; accent: string; line: string };
}

export interface HtmlTemplates {
  templates: HtmlTemplate[];
  /** Accent colours offered besides each template's own. */
  accents: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9-]{1,40}$/;

/** A kept design, checked; `null` when there is none (or it is not one). */
export function restoreHtmlDesign(value: unknown): HtmlDesign | null {
  const v = value as Partial<HtmlDesign> | null | undefined;
  if (
    !v ||
    typeof v.template !== 'string' ||
    !ID.test(v.template) ||
    typeof v.accent !== 'string' ||
    !HEX.test(v.accent) ||
    typeof v.bodyFont !== 'string' ||
    !ID.test(v.bodyFont) ||
    typeof v.headingFont !== 'string' ||
    !ID.test(v.headingFont) ||
    typeof v.showNames !== 'boolean' ||
    !NUMBERING.includes(v.numbering as Numbering)
  )
    return null;
  return {
    template: v.template,
    accent: v.accent.toLowerCase(),
    bodyFont: v.bodyFont,
    headingFont: v.headingFont,
    showNames: v.showNames,
    numbering: v.numbering as Numbering,
    // Kept only when set: a design saved before the slideshow restores as it was.
    ...(v.view === 'show' ? { view: 'show' as const } : {}),
  };
}

/**
 * `template` as it is designed: picking a template shows it as it is, and the
 * quick options then change it from there.
 */
export function templateDesign(template: HtmlTemplate): HtmlDesign {
  return {
    template: template.id,
    accent: template.defaults.accent,
    bodyFont: template.defaults.body_font,
    headingFont: template.defaults.heading_font,
    showNames: template.defaults.show_names,
    numbering: template.defaults.numbering,
  };
}

/** The design as `POST /audiobook/export/html` reads it. */
export function designRequest(design: HtmlDesign) {
  return {
    template: design.template,
    accent: design.accent,
    body_font: design.bodyFont,
    heading_font: design.headingFont,
    show_names: design.showNames,
    numbering: design.numbering,
    ...(design.view === 'show' ? { view: 'show' as const } : {}),
  };
}
