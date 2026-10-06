# Expressive speech: breaths, laughter, and style

How to direct a performance — laughter, sighs, pauses, whispering, emotion,
and the community favorite: *"how do I make it take a sharp audible breath,
like a person running out of breath?"* Some of this is supported today
(engine-dependent), some is spec'd but not shipped yet. This page tells you
exactly which is which, so you don't burn an evening on tags an engine
ignores.

## The short version

| You want | Do this | Works on |
|---|---|---|
| A pause | Type `[pause]`, `[pause 500ms]`, or `[pause 1.5s]` in the text — on Clone and Voice Design, ⊕ Insert (or **Alt+/**) offers the Audiobook pause lengths and a custom one, and typing `[` suggests pauses and reactions; tags are highlighted as you type, clicking a pause, reaction or respelling (or **Alt+Enter** on it) opens a card to change it, and right-clicking offers the same; voice, delivery and volume tags, which only Audiobook and Stories read, are underlined there as not used on the page (the engine would read them aloud), and their card only removes them — see [The script editor](#the-script-editor) | Every engine |
| Pauses, voice switches and tags in Stories or Audiobook | The toolbar above the script: **Pause**, **Voice** (select text first to voice only that part), **Slow / Fast / Emphasis / Spell**, **Volume**, **Pronounce**, **Reactions**, **Chapter**; Audiobook adds **Listen** for the selected text or the paragraph at the cursor. **?** opens the markup guide. Clicking a tag (or **Alt+Enter** on it) opens a card to change it, right-clicking offers the same actions, and typing `[` suggests tags — see [The script editor](#the-script-editor) | Every engine (Reactions: default engine) |
| Voices at an even volume, or one voice louder | **Even out voice volume** (on by default), plus a −12 to +12 dB volume per voice in **Cast** or a voice tag's card — see [Voice volume](#voice-volume) | Every engine |
| One passage quieter or louder (a whisper, a shout) | Wrap it in `[volume -6dB]…[/volume]` — the toolbar's **Volume** does it for the selected text — see [Voice volume](#voice-volume) | Every engine |
| Laughter or a sigh | ⊕ Insert → `[laughter]` / `[sigh]` | Default engine (VoiceStudio) |
| An audible breath **on demand** | `[breath]` in the text | CosyVoice 3 only (opt-in) — see [Breaths](#breaths-specifically) |
| Whispering | Style → `whisper` (the voice-design/style field) | Default engine |
| Emotion ("excited", "sad", graded intensity) | IndexTTS2's emotion controls — Audiobook tab's Production Overrides, or the `/ws/tts` API — or CosyVoice 3 instruct | Opt-in engines only |
| The same take again | Pin the seed / lock the profile | Default engine |

## Sentence-by-sentence rendering and punctuation pauses

The default engine fixes a take's length up front and fills it in parallel, so
a long take with near-identical clauses ("Spring is …; Summer is …; Autumn is
…") can come back with a clause copied, dropped or swapped. VoiceStudio
therefore reads long text sentence by sentence: every sentence and clause is
its own take, joined with a deliberate silence. A sentence or clause shorter
than 40 characters is read together with the next one (the last with the one
before), up to 120 characters a take: very short takes drift in pitch from one
another and sound warped, so the engine pauses at those marks itself. A line
that ends without a mark — a heading or list item — keeps its own take.

**Settings → Reading** holds this for the whole app — Audiobook, Stories, Clone
and Voice Design. The **Phrasing** button next to the quality controls in
Clone and Voice Design, and **Pauses & phrasing** in the Audiobook and Stories
setup panel, open the same settings in place. It sets the silence per mark —
end of sentence or line break (300 ms; a line that ends on its own mark keeps
that mark's pause), ellipsis (500), semicolon (250), colon (250), dash
(200) and comma (120, used where a long sentence is cut at a comma, or at every
comma when **Pause at every comma** is on). Turning **Read sentence by
sentence** off restores one take per paragraph. A book or story can keep its
own values instead (**This project only**). Dubbing never uses them: its lines
must fit their subtitle timing. In long-form renders the pause is exact when
**Trim engine silence** is on; otherwise the engine's own lead-in is kept at
the outer edges of each line.

**Check the reading and redo mistakes** (off by default) listens to each
sentence with the speech recognizer you already installed, re-renders the ones
whose words differ from the script (up to twice, keeping the closest take) and,
in Audiobook and Stories, lists the sentences that still differ after the
render. It never downloads a recognizer; without one, rendering continues
unchecked. Expect it to take noticeably longer.

API callers keep the take they had unless they ask: long-form requests
(`/audiobook`, `/longform/render`, `/audiobook/preview`) send
`use_app_reading: true` to follow Settings → Reading, or the explicit
`punctuation_pauses` / `split_commas` / `verify_speech` fields; `/generate`
takes `reading=app` or a JSON object with those fields. The setting itself is
`GET`/`PUT /api/settings/reading`.

## The script editor

The Audiobook script editor numbers its lines and draws a thin lane beside
them in the color of the voice reading each line, so you can see where a
`[voice:NAME]` switch takes effect without reading the tags. Every name keeps
the same color in the editor, the **Cast** panel and the toolbar's voice
picker; `[voice:]` and `[voice:default]` (back to the default voice) are
outlined in gray. The line with the cursor is shaded, `# Chapter` lines show
as bands (`## Section` and `### Section` lines as lighter ones), and the
gutter marks them: a chapter heading shows its number (*C1*, *C2*…) instead
of the line number, a section shows *§*, and the lane breaks at every chapter
heading, where the voice starts over. Text before the first heading is the
book's intro and is labeled *Intro*. The status bar underneath shows the line
and column, the voice in effect at the cursor and the profile cast to read it
(*Voice: Mara, read by Lan*; just *Voice: Lan* when the name and the profile
are the same), the script's length, and the text size: **−** / **+**, or
click the percentage for 80–160 %. **Ctrl/⌘ +**, **Ctrl/⌘ −**, **Ctrl/⌘ 0**
and Ctrl+wheel change it too while the pointer or the cursor is in the
editor; the size is remembered on this computer.

### Spellcheck

Spellchecking is off by default in every field whose text is read aloud —
the Audiobook and Stories editors and chapter titles, the Clone and Voice
Design scripts, reference transcripts, voice-preview and Compare voices
phrases, phone greetings and disclosures, workflow scripts, the speech-rate
line in Tools, the pronunciation test line, dubbing segments and pasted
translations — since an English dictionary would underline every Vietnamese
word. **Settings → General → Spellcheck while writing** turns it on for all of
them at once and checks in Vietnamese and English. Other fields (AI
instructions, descriptions, chat, forms) keep the usual check either way.

VoiceStudio never downloads a dictionary. Windows and macOS check with the
system's own spellchecker, offline (macOS chooses its languages itself, from
the ones installed in System Settings). On Linux the app only uses Hunspell
dictionaries already in its profile's `Dictionaries` folder (for example
`~/.config/VoiceStudio/Dictionaries/vi-VN-3-0.bdic`); with none there, the
setting says that spellchecking is unavailable offline on this system and
nothing is underlined. Right-click spelling suggestions are not offered.

`# Title` starts a chapter (a chapter of the finished file). `## Title` and
`### Title` start a section inside it: the title is read aloud without the
marks, as a paragraph of its own, by whichever voice is reading there — a
section never resets the voice. `####` and deeper lines are ordinary text.

**Contents**, a rail on the left of the editor, lists the chapters and their
sections with their word count and estimated length; fold it away with its
button (in a narrow window it opens over the editor from the toggle). Click
one to move the cursor to its heading and scroll the editor there; its menu
renames it, adds a chapter or section after it, or removes the heading and
keeps the text (all undoable with Ctrl+Z). The text before the first heading
shows as *Intro (untitled)*, and its menu's **Add title** puts a `# ` heading
above it. Each chapter says whether its audio is **Rendered** for the script
and settings as they are now, **Changed** (its script or settings changed
since the last audiobook, so it renders again; hover the badge for the
reason), or **Not rendered**; its play button renders that chapter on its own
in a compact player under the contents, and the full book reuses it.

In Audiobook and Stories, click a tag — or put the cursor on it and press
**Alt+Enter** — to open a card for it:

- **`[voice:NAME]`** — pick the **Reading voice**: the profile cast to the
  name, for every passage of it (the same setting as the Cast panel); set the
  name's volume, **Listen to this part** or **Select this part** (everything
  that voice reads up to the next switch), or remove the tag. When the script
  has two names or more, **Switch this tag to another role** moves this one
  tag to another name, a voice profile or the default voice.
- **`[pause …]`** — pick a preset or type a length.
- **Delivery** (`[slow]`, `[fast]`, `[emphasis]`, `[spell]`) — switch both
  halves of the pair to another kind, or remove the pair.
- **`[volume …]`** — pick a step (quieter, a little quieter, a little louder,
  louder) or set the passage's gain with the slider; from either half, only
  the opening tag changes. **Remove this markup** unwraps the words.
- **`[[word|respelling]]`** — edit the respelling.
- **Reactions** — swap for another sound.
- **Unknown tags** — the card explains that the engine reads them aloud as
  written.

Every change is one ordinary edit, so **Ctrl+Z** undoes it. Right-clicking a
tag offers the same actions. Typing `[` suggests voices (the script's names
and your voice profiles), pauses, delivery, volume steps and reactions; ↑↓ choose, **Enter** or **Tab** inserts and
**Esc** closes. Tags inside a `# Chapter` line are part of the title, so they
are not clickable there.

On Clone and Voice Design the same cards and right-click menu work for the
markup a single-voice script reads: **`[pause …]`** (a preset, a typed length,
or remove), **reactions** (swap or remove) and **`[[word|respelling]]`** (edit
the respelling, or keep the word). A voice, delivery or volume tag there says
it is not used on the page and offers only its removal. The right-click menu
keeps cut, copy, paste and select all, and inserts pauses, reactions and
**Pronounce**; voices, delivery, volume and chapters stay in Audiobook and
Stories. Edits undo with **Ctrl+Z**, and only one of the card, the menu, the
`[` suggestions and ⊕ Insert is open at a time.

## Voice volume

Each voice profile is cloned from its own recording, and the default engine
matches the loudness of that recording — so a book with a quiet narrator and a
loud character comes out uneven. **Even out voice volume** (Production
Overrides, on by default in Audiobook and Stories) measures how loud each voice
speaks in each chapter and brings every voice to the same level (−20 dBFS of
speech; silence is ignored). Each voice gets one gain per chapter, so its own
rises and falls stay intact; the automatic change is capped at ±12 dB, and a
boost never pushes a peak past 0.97 of full scale.

To make one voice louder or quieter on top of that, use the volume slider for
that name in the **Cast** panel (the **Default voice** row covers untagged text
and `[voice:]`) or in a voice tag's card: −12 to +12 dB in 1 dB steps. It
applies to every passage that voice reads. Turning leveling on or changing a volume
reassembles the affected chapters from takes already rendered, without new
synthesis; a remote GPU worker has no take cache, so it renders those chapters
once more. After a render with leveling on, the **Cast** panel shows under each
volume what leveling did, for example *Auto: +5.2 dB · Total: +7.2 dB* — the
median of that voice's automatic gain across the book's chapters, and that plus
your own volume.

To change **one passage** only — a whisper, a shout — wrap it in
`[volume -6dB]…[/volume]` (or use the toolbar's **Volume**, which wraps the
selected text). The gain is in dB: `dB`, `db` or a bare number, with or
without a space (`[volume +3 dB]`, `[volume -4]`), within ±12 dB; nested
volumes add up and are capped at ±12 dB. Like `[slow]`, an unclosed
`[volume]` lasts until the next `[pause]`, voice switch or chapter. A
`[volume]` without a number it can read is an unknown tag, read aloud. The
passage is moved after leveling and the voice's own volume, with the same peak
guard, and leveling never measures it — so a whispered line does not make the
whole voice louder. Changing a passage's volume reassembles its chapter from
the takes already rendered; scripts without the tag keep their cached audio.

API callers opt in per request: `/audiobook`, `/longform/render` and
`/audiobook/preview` take `level_voices: true` and `voice_gains`, a map of
voice name to dB (`""` is the default voice; at most 64 names, each value
clamped to ±12 dB). Requests without them render exactly as before. A
`/longform/render` span may carry `gain_db` (±12), the passage gain the parser
writes for `[volume]`. With leveling on, each SSE `chapter` event carries
`levels`: voice name → `{level_db, auto_db}`, the measured speech level and
the gain leveling added in that chapter.

## Listening back in the reader

When a book finishes, **Audiobook ready** shows a compact player: play/pause, a
seek bar with a mark at each chapter, previous/next chapter, the elapsed and
total time, a speed menu (0.75× to 2×) and the sentence being read, with the
current word highlighted. **Open reader** opens the full text over the same
audio. The current sentence and word are highlighted as the book plays and the
text scrolls to follow; scroll yourself and following pauses until you press
**Back to the current line** or seek. Click any word to play from there, or
jump with the chapter menu. **Space** plays or pauses and **←/→** skip 5
seconds.

A render records where each sentence lands in the audio, so the highlight
moves to a sentence exactly when the voice reaches it and stays there through
the pause after it; within a sentence, each word's share of the time follows
its length. The reader follows the words as they were rendered, so editing the
script afterwards does not throw it off. Books rendered before this, and
chapters reused from an older cache, fall back to timing estimated from the
text; the reader says when the chapter playing is estimated, and its highlight
can run slightly ahead of or behind the voice.

**Export HTML** saves the book as a web page: a ZIP holding `index.html`, the
audio (`.m4a` for an M4B book, so every browser plays it) and the cover. Unpack
it and open `index.html` in any browser, offline — the page makes no network
request and loads no web font. It reads like an e-book: a title block with the
author, narrator and cover; chapters with a "Chapter N" label and their title,
sections as subheadings, and the text in the script's own paragraphs and line
breaks, justified (without automatic hyphenation) in a serif reading font. Text
before the first chapter heading is shown as the opening, without a heading. A
contents sidebar (a drawer on phones) lists chapters and sections, marks the one
playing and jumps to it. The sentence being read is shaded and its word
underlined; click any word to play from there. The page keeps the sentence being
read in the upper third of the window, stops following when you scroll away and
offers **Back to current**. The **Aa** menu sets the text size, the theme (auto,
light, sepia, dark), justified or left-aligned text and whether to follow the
voice; the browser remembers them. The player bar has previous/next chapter,
back and forward 10 seconds, play/pause, a seek bar with chapter marks, the time
and the speed; **?** lists the keys (**Space**, **←/→**, **Shift+←/→** for
chapters). Printing gives the text alone. Its labels are in the app's language.
The reader in the app justifies its text the same way. A book rendered before
the timeline kept line and paragraph breaks takes them from the script it was
rendered from, when the script still holds that text.

## Recovering an interrupted audiobook

Switching away from the Audiobook tab explicitly interrupts synthesis at a chapter boundary. The Audiobook recovery card lets you resume with its cached chapters, and **Open chapter cache** reveals the chapter audio cache.

Cached chapters are matched by their script, voice and render settings, not by where the data folder lives, so they stay reusable after the folder is moved (in **Settings → Storage** or by hand) or the machine loses power. One exception: chapters cached by an earlier version render once more if the folder is moved by hand before this version has been launched from the old location. When a chapter you expected to reuse renders again, the backend log names the input that changed (for example a voice's reference text or the pronunciation lexicon); the diagnostic bundle includes that log.

## Why bracket tags work at all (and when they don't)

Everything you type in the text box reaches the active engine **verbatim** —
the pipeline goes out of its way not to break tags:

- Tilde-separated integer, signed, and decimal ranges get a spoken separator in
  English, Korean, Japanese, and Chinese; malformed chains and product codes
  are left unchanged.
- The text-normalization pass (numbers, abbreviations) skips every `[…]` span
  (`backend/services/text_normalization.py`).
- The same pass drops quotation marks, which are never spoken: the default
  model misread or stumbled on a word glued to one (`“đừng` came out as
  "dừng"; `'đừng bỏ cuộc'` and `‘hãy tiếp tục’` jolted). Double quotes go
  everywhere; a single quote between two letters is an apostrophe (`don't`,
  `l'eau`) and stays. It also speaks shouted words that carry accents in lower case
  (`MÙA THU` → `mùa thu`), since the model tends to spell all-caps words letter
  by letter; vowel-less acronyms (`ĐHQG`), Roman numerals and lone plain-ASCII
  capitals (`USA`, `KTNB`) stay as written — use `[spell]…[/spell]` to have an
  acronym spelled out.
- The long-text chunker never cuts inside a bracket tag
  (`backend/services/chunked_tts.py`, `_BRACKET_TAG_RE`).

The flip side is just as important: **unrecognized tags are not stripped.**
An engine that doesn't know a tag receives it as literal text and will try to
speak it. Pasting an ElevenLabs script full of `[excited]` / `[whispers]`
degrades output on every engine we ship — those tags are on the roadmap (see
[What's coming](#whats-coming)), not in the engines. Use only the tags listed
for your engine below.

## What each engine can do today

### Every engine

- **`[pause Nms]` markers** — `[pause]` (350 ms default), `[pause 500ms]`,
  `[pause 1s]`, up to 10 s. Rendered as real stitched silence, so it works
  identically on all engines.
- **Punctuation** — ellipses, dashes, exclamation marks, and short fragments
  genuinely shape pacing and intonation. Cheap, underrated.
- **The reference clip is a performance direction.** Zero-shot cloning mirrors
  the *delivery* of the reference, not just the timbre — a flat reference
  clones flat, an animated one clones animated (see the tip in
  [generation-parameters.md](generation-parameters.md)). This is the most
  reliable expressive control in the app.
- **Pronunciation overrides** — `[[Nuh-VAD-uh]]` or `[[gif|jiff]]` inline, or the
  pronunciation dictionary. Not expression, but often what a "it says this
  weirdly" problem actually needs. Inline overrides also work in Stories and
  Audiobook scripts (the **Pronounce** button writes one for the selected word);
  long-form renders use the Audiobook project's own pronunciation list rather
  than the global dictionary.

Pronunciation dictionary matching uses Unicode case-insensitive literal matches. Each matched term uses its own respelling; distinct terms such as Straße and STRASSE can have different respellings. Longer terms win overlaps, and later equal-length case variants retain precedence.

### Default engine (VoiceStudio)

**Non-verbal tags.** The bundled model natively tokenizes 13 reaction tags
(`omnivoice/models/omnivoice.py`, `_NONVERBAL_PATTERN`) — the ⊕ Insert button
at the corner of the Script box lists them all:

`[laughter]` `[sigh]` `[confirmation-en]` `[question-en]` `[question-ah]`
`[question-oh]` `[question-ei]` `[question-yi]` `[surprise-ah]`
`[surprise-oh]` `[surprise-wa]` `[surprise-yo]` `[dissatisfaction-hnn]`

Honest expectations: `[laughter]` and `[sigh]` are the broadly useful ones;
most of the interjection variants (`-ah`, `-yi`, `-hnn`) are tuned for
Mandarin-flavored speech. How convincingly a tag renders varies with the
voice — a tag that lands great on one reference clip can come out subdued on
another. There is **no intensity control**, and **no `[breath]` tag** in this
set.

**Whispering.** `whisper` is the one delivery style the instruct validator
accepts (the taxonomy is Gender / Age / Pitch / Style / Accent / Dialect —
see [voice-design.md](voice-design.md)). `[happy]` / `[sad]`-style emotion
direction is **not** something the base model takes.

**Sampling knobs + seed.** The Voice workspace **and the Audiobook tab** each
carry a Production Overrides panel exposing the sampling surface (defaults in
parentheses; details in [generation-parameters.md](generation-parameters.md)):

- `position_temperature` (5.0) and `class_temperature` (0.0) — 0 is greedy;
  higher is more random, which means more expressive variation *and* more
  artifacts.
- `num_step` — the Voice page defaults to 16 (fast); Audiobook renders default
  to 32 (cleaner), overridable in the Audiobook panel. Fewer steps = rougher,
  occasionally more "human-sounding" edges.
- **Seed** — unpinned by default, so every render differs. The history rail
  shows the seed each take used; "Keep this seed" (Design tab) or locking a
  profile from history pins reference + seed, making the voice
  bit-reproducible. The Audiobook panel also takes a book-level seed directly.
- `postprocess_output` (on) — removes long silences from the output. Turn it
  off when the silence *is* the performance.

The Audiobook panel adds two longform-only controls on top of that surface:
IndexTTS2 emotion (see below), and **Vary repeated lines** — a cache opt-out
that gives every identical line its own take instead of replaying one recording
(off by default, so books stay byte-reproducible unless you ask for variety).

It also owns the **joins**. Every engine pads each rendered line with its own
lead-in and tail silence (GPT-SoVITS ≈ 70 ms / 300 ms, others similar); joined
raw, a book reads as a string of separate takes. By default the renderer trims
that padding (**Trim engine silence**, −40 dBFS with 40 ms kept at each edge)
and inserts deliberate silence instead: **Gap between lines** (250 ms) between
consecutive lines that carry no `[pause]` of their own — an explicit `[pause]`
replaces the gap rather than adding to it — and **Gap between paragraphs**
(350 ms) at a blank line inside one line of script. A line that inline markup
(`[slow]`, `[emphasis]`, `[spell]`) splits into several renders is still one
line: no gap lands in the middle of it (and a blank line sitting on that split
still gets the paragraph gap). A `[voice:NAME]` change is a line boundary and
gets the line gap, blank line or not — the paragraph gap is for breaks inside
one voice's text. With the paragraph gap at 0 a line is
rendered in one engine call exactly as before, so setting both gaps to 0 and
turning trimming off gives the pre-existing hard joins (and their cache keys)
back, including cached renders with seed or emotion overrides. A chapter may
request at most 15 minutes of added join silence; larger requests fail before
synthesis or cache reads. Reduce the gaps or split the chapter to proceed.
Accepted gaps retain their exact duration on fresh renders and cache reuse.

**Longform-only tags.** Audiobook and Stories additionally parse SSML-lite —
`[slow]…[/slow]`, `[fast]…[/fast]`, `[emphasis]…[/emphasis]`, `[spell]`,
`[volume -6dB]…[/volume]` — plus `[voice:NAME]` for multi-voice scripts
(`backend/services/longform_parser.py`). These are not parsed on the Voice
page.

### CosyVoice 3 (opt-in)

The most direct paralinguistic control in the app, if you're willing to
install it. CosyVoice 3 honors, inline in the text:

- `[breath]` — an audible breath, exactly where you put it
- `[laughter]`
- `<strong>word</strong>` — emphasis

plus **natural-language instruct** ("speak with a Sichuan accent", "sound
exhausted") — the backend appends the model's required `<|endofprompt|>`
terminator for you (`backend/services/tts_backend.py`,
`CosyVoiceBackend`). One catch: the Studio style field whitelists instruct to
the default engine's taxonomy, so free-text instruct currently needs the API
(`POST /generate` with an `instruct` form field, or `/ws/tts`).

Setup: clone + install [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)
(non-trivial: `git clone --recursive`, its requirements, SoX), then set
`OMNIVOICE_COSYVOICE_MODEL` to the model directory and select it in
Model Catalogue. CUDA or CPU; MPS is unverified upstream.

### VoxCPM2 (opt-in)

VoxCPM2's native convention is an instruct prefix inside the text itself:
`(speaking fast, out of breath) I can't stop now.` The app maps the
`instruct` field onto that prefix (`backend/services/tts_backend.py`,
`VoxCPM2Backend.generate`), and because the convention is literally in-text,
typing the parenthetical at the start of your text works too. Treat it as
guidance, not a guarantee — adherence varies by voice and language.

### IndexTTS2 (opt-in)

The only engine with **graded** emotion control: an 8-value emotion vector
(happy, angry, sad, afraid, disgusted, melancholic, surprised, calm), an
emotion *reference clip* whose delivery is mimicked (with a blend strength),
or a natural-language emotion description. The **Audiobook tab's Production
Overrides** expose the natural-language path — an *Emotion description* field
plus an *Emotion strength* slider (`emo_alpha`), shown only when IndexTTS2 is
the active engine so there are no dead controls. The full surface (the 8-float
`emo_vector`, an `emo_audio` reference clip) is on the streaming WebSocket API
(`/ws/tts` — `emo_vector`, `emo_audio`, `emo_alpha`, `emo_text` fields;
`backend/api/routers/tts_stream.py`). The single-shot Voice page does not carry
emotion controls yet.

## Breaths, specifically

The honest answer to *"how do I invoke a sharp inhale on demand?"*:

**On the default engine — you can't yet, not directly.** There is no
`[breath]` or `[inhale]` token in its tag set; `[sigh]` is the nearest
neighbor and it's an exhale. An engine-agnostic breath/reaction tag layer is
spec'd ([specs/01-expressive-tts.md](specs/01-expressive-tts.md)) but not
shipped — see below.

**The direct route: CosyVoice 3.** Its `[breath]` tag puts an audible breath
exactly where you type it. If on-demand breaths matter to your work, this is
the supported path today.

**The coax-it recipe (default engine).** Breaths *can* be elicited — this is
exactly what v0.3.9 was doing by accident. Roughly in order of effectiveness:

1. **Put the breathing in the reference clip.** Record 8–15 s of yourself (or
   your speaker) genuinely winded — audible inhales between phrases. The
   clone mirrors the delivery. This alone gets most of the way there.
2. **Write for it.** Short gasping fragments with pauses:
   `I can't… [pause 300ms] I can't keep… [pause 200ms] keep running.`
3. **Turn off `postprocess_output`** (Production Overrides — Voice tab *or*
   Audiobook tab) so the silences — where breath artifacts live — aren't
   trimmed away.
4. **Add randomness, then farm takes.** Raise `class_temperature` to 0.3–0.7
   (default is 0, fully greedy) and regenerate a few times — the seed is
   unpinned, so each take differs. Both controls live in the same Production
   Overrides panel, so this whole recipe now works for an audiobook chapter
   (audition it with the per-chapter Preview button), not just a single Voice
   render. In a book, the **Vary repeated lines** toggle farms takes across
   repeated lines automatically.
5. **Keep the winner.** When a take breathes right, its seed is on the
   history entry — lock the profile from there (or set the Audiobook panel's
   book-level seed) and every future generation uses the same reference + seed.

Tradeoffs, stated plainly: temperature cuts both ways (the same randomness
that produces a great gasp produces slurred words and timbre drift), takes
are non-repeatable until you pin the seed, and postprocess-off keeps *all*
long silences, wanted or not. This is a workaround, not a feature — which is
why the feature is spec'd.

## Why v0.3.9-style random breaths faded

Users of v0.3.9 remember outputs that would spontaneously breathe, gasp, and
rustle — and noticed v0.3.15+ is smooth. Those breaths were never a feature:
they were uncontrolled sampling variance (unpinned seed + the default
`position_temperature` of 5.0) surviving an output chain that was, at the
time, less tidy. Then the chain got deliberately cleaner:

- **v0.3.12** — the mastering pre-stage was cut down to highpass + compressor
  after a field report of hidden echo; every generation had been getting a
  small room reverb baked in, which made outputs sound roomier and
  breathier (#986).
- **Silence post-processing** (`postprocess_output`, default on) removes long
  silences — the gaps where stray breath noise lived.
- **v0.3.16** — VoxCPM2 reference clips get edge-silence trimming before
  conditioning, and outputs get a trailing-silence trim (#1055), so that
  engine stopped inheriting dead air and its artifacts.

Net effect: the default output is now clean by design, and expressiveness is
becoming something you *ask for* (tags, instruct, the recipe above) rather
than something that happens to you.

## What's coming

[Spec 01 — Expressive TTS](specs/01-expressive-tts.md) defines the plan: one
engine-agnostic tag surface (`[excited]`, `[whispers]`, reaction tags like
`[breath]`) that lowers to whatever the active engine can really do and
**visibly degrades** where it can't, plus an Expression panel (emotion
dropdown + intensity + emotion-reference clip) everywhere in the UI. The
pronunciation phases have shipped (dictionary + `[[…]]` overrides), and the
Audiobook tab now carries a first Expression surface — IndexTTS2 emotion
description + strength, engine-gated. Still spec'd, not shipped: the
engine-agnostic inline emotion/reaction tag grammar, the emotion-reference
clip picker, and the Expression panel on the single-shot Voice page. No
promised date — when each lands, this page gets updated in the same PR.

Omitted API join options keep legacy hard joins (zero gaps, no edge trim).
Clients enable seamless joins by sending their chosen gaps and trim explicitly.
