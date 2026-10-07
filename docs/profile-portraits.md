# Profile portraits and saving

The Electron cloning workspace shows a name-and-portrait form immediately after
an audio upload or recording. Saving selects the new profile; **Use without
saving** proceeds with the temporary reference. **Change voice** opens the saved
voice chooser without discarding the script.

The sidebar lists saved voices as compact selectable rows, with separate
preview/delete controls. The voice chooser (**Choose a voice**) uses the window's
width: cards fill as many columns as fit (four or five at 1500 px), the page
scrolls instead of a box inside it, and only the rows in view are mounted once
there are more than 30 voices. A card shows the whole name on up to two lines,
the clip's length and a short date (the language too when the library mixes
languages) and, on hover or focus, ▶ to audition the clip through one shared
player and ✎ to edit. Chips filter by a name prefix that two or more voices
share (`ktnb-…`, `chanel-…`). The arrow keys, Home and End move between cards,
Enter chooses one, Tab leaves the grid from the card it is on, and `/` jumps to
the search box. **Add a new voice** stays one row (Upload audio, Record and the
5–15 s hint) until one of them is pressed or audio is dragged over the window;
a library without voices shows the drop zone and recorder at once.

Clone and Voice Design share one script frame: the editor column widens with
the window up to 72rem and takes the height left over, its status line counts
characters, words and sentences and estimates the time read aloud (at the voice
controls' speed), and Ctrl/⌘ + − 0 or Ctrl+wheel in it size the script's text
(the same per-viewer size as the Audiobook editor). Generation controls stay
anchored under the editor. Preserve this layout when polishing visuals rather
than moving the primary action. **Focus** hides the sidebar, the workspace's own
panes and the takes until Esc, Focus again, opening a pane, or leaving the page.
They are hidden, not closed: a take or voice preview playing in them plays on,
and the library's search and filters, the takes' open row and an unsaved
profile edit are as they were when they come back. Beside an open pane the
script toolbar shows its buttons as icons (named in their tooltips), and the
takes drop their voice and date by their own width, never the window's.
The reference pane includes saved-reference playback.
Language search measures its virtual list after the popover mounts.

**Recent takes** sits under the composer behind a draggable edge (↑/↓ on it
too), folds to one line, and remembers both per viewer. It lists the
workspace's takes newest first, one row each with ▶ to audition it; only the
chosen take opens with its waveform, file details, Save as…, Reuse script,
Details and the folded **Check audio**. A new take opens chosen, as **Latest
take**; closing it stops its playback and clears the current player without
deleting the saved take from history.

Initials are generated locally from the first and last words of the profile name.
Optional JPEG, PNG and WebP uploads are limited to 5 MB and 16 megapixels,
cropped to 256 × 256, and re-encoded without source metadata. Portraits live next
to profile audio as `<id>.portrait.jpg`; deleting a profile removes its portrait.
The reference pane and saved-profile editor allow replacing a portrait through either upload or the same explicit five-result image search used while creating a profile.

After a new clone profile is saved, Electron releases the temporary upload and
switches the composer to the returned profile as one atomic state change. The
returned language, style and server-generated local-ASR transcript become the
composer metadata, so deleting or changing that profile cannot revive a stale
reference file from before the save.

`POST /profiles` accepts an optional `image` multipart field and returns the full
profile, including `image_url`. `PUT /profiles/{id}/image` replaces the portrait;
`GET /profiles/{id}/image` serves it. No database migration is required.

## Optional image search

Search runs only when the user clicks **Search images**. It sends the entered
name to the ordinary Google Images search page. No API key is required.
The search requests SafeSearch and Google's JPEG file-type filter, then returns
up to five valid thumbnails. Thumbnails are decoded, normalized and saved locally
through the same profile-image flow as uploads; remote originals are never fetched.

Only Google's HTTPS thumbnail proxy hosts and embedded JPEG previews are accepted from that page.
If Google requires browser JavaScript, consent, or a CAPTCHA, VoiceStudio falls back to Openverse's
public search with mature content excluded and reuse-friendly licensing filters. It never bypasses
Google challenges. Initials and file uploads remain available if neither source responds.
Filtering does not guarantee that every result is appropriate or licensed for reuse.

Live verification: `node electron/tests/profile-image-search-real-smoke.mjs` creates a disposable
local profile, opens its Electron editor, requests the explicit no-key search, verifies five
selectable portraits, persists one through the real image endpoint, verifies the normalized JPEG
and refreshed avatar, then removes the profile.

## Recoverable generation failures

Generation failures appear once in the composer, with technical details collapsed.
The script is preserved for retry. Shared audio writers recreate missing parent
directories before writing, including folders removed after backend startup.

Playback belongs to the takes under the composer. Synthesize always starts
generation; playing a take never replaces that button with a playback control.

The synthesis button reserves fixed space for its label and cancellation control.
Elapsed time uses tabular digits below the button. During an active request,
`/model/status` supplies the localized runtime sub-stage and model-load percentage;
response-body progress takes over when audio delivery begins.

Until it can run, Synthesize looks unfinished (dashed, its shortcut hint replaced by
a not-ready mark) rather than greyed out, and the first reason shows above the
controls. Pressing it, or Ctrl/⌘ + Enter, lists everything missing — the script, a
voice, a voice sample still recording, an engine still starting, not set up or
unable to clone — each with a button to the script, the voice, the engine notice or
the engine settings. Esc returns to where you were.

The voice selector labels the active voice explicitly. Voice sample opens its
reference pane, and an empty script prompts with the selected voice name.
Paste and Insert remain secondary actions; Insert offers pauses (the Audiobook
presets and a custom length) above the expression tokens, and says so in its
accessible label and tooltip. These refinements preserve the anchored layout.

## Reference transcription and editing

The save-profile view uses the editor's full content width. New uploaded or
recorded references use the selected local dictation pipeline (including its
configured Parakeet/Whisper fallback). Installed-model readiness is checked before
transcription; no model downloads are initiated. Missing models leave manual
transcript entry available. ASR never overwrites text edited while it runs.
Saving waits for transcription; using the reference without saving remains possible.

Saved-voice pencil buttons, and **Edit voice** on the selected voice in the
voice-sample pane, open a profile editor for name, transcript, style, portrait
and reference sample. Clicking a saved voice still only selects it; editing does
not select a different voice. The voice-sample pane's chevron collapses it; the
Voice sample toolbar control reopens it.

The editor plays the stored reference. For clone voices, **Replace reference**
accepts an upload or recording with the same format and length checks as a new
voice. **Keep current reference** discards the new clip. **Save** writes it
to the same profile. The profile id, name, portrait, style, language and history
stay the same. The transcript field clears when a new clip is chosen; leave it
blank to transcribe the new clip locally. Replacing the reference also clears
the voice's locked take and own-voice verification, because the new clip may be
a different speaker. Designed voices are edited through their recipe instead.

`PUT /profiles/{id}/audio` (multipart `ref_audio`, optional `ref_text`, `name`,
`instruct`, `language` and `personality`) stores the clip under a new
`<id>-<token>.<ext>` filename and saves the other fields in the same database
update, so an editor save commits every change or none. The old files are
deleted only after the database update succeeds. The new filename also
invalidates engine prompt caches and audiobook chapter caches, because those are
keyed by the reference path. Profile records include a versioned `audio_url` so
players reload the new clip, and `audio_duration_seconds`, that clip's length
read from its header once per version (null when libsndfile cannot read the
format, absent from older backends, which the chooser shows without a length).
`GET /profiles/{id}/audio` serves each clip with
its own media type. The route accepts WAV, MP3, M4A, FLAC, OGG, Opus, AAC and
WebM up to 128 MiB, and requires libsndfile or FFmpeg to decode real samples
before the clip replaces the old one; a file neither can decode returns 422.
Replacements of one voice run one at a time, and a clip changed by another
writer during an upload returns 409. Designed voices return 409. A Gallery or
Community voice whose reference is replaced counts as the user's own edit: importing the same voice again creates a separate profile
and leaves the edited one unchanged. No database migration is required.

The sidebar lists selected TTS, ASR and LLM engines, resolved model identities
where available, and the selected installed dictation model. These are selections,
not a claim that model weights are currently loaded.

Engine change controls open Settings / Models with separate TTS, ASR, dictation,
and LLM pages. Lists scroll independently of the settings sidebar; unavailable
engines and undownloaded dictation models cannot be selected. Engine selection
uses the shared backend preferences and refreshes sidebar metadata.

Script import supports TXT, Markdown, DOC, DOCX, PDF and EPUB (text documents,
not scanned-image OCR). Paste inserts at the caret; Replace script offers Undo.
Clicking in the script shows the expression picker near the caret without taking
typing focus. The save-profile form keeps the editor's width; the voice chooser
takes the window's.

Deleting a saved voice commits the profile and history changes before removing its reference, locked take, consent recording and portrait. A failed database transaction leaves those assets available. Cleanup after a successful deletion is best effort; one unavailable asset does not prevent cleanup of the others.

If cleanup fails after the profile record is deleted, the response reports incomplete cleanup and names the remaining confined paths relative to the voices folder, including nested locations. If a location can no longer be confined, the response directs the operator to the local backend log instead of exposing a host path. The backend log records their local locations for manual cleanup with home-directory prefixes redacted to `~`. Electron refreshes the saved-voice list after an error and clears selected clone/design references only when that list confirms the profile is gone; the existing error message still reports incomplete asset cleanup. Deleting the missing profile again does not retry its former audio files; no automatic cleanup retry is promised.

If the backend becomes unavailable during a deletion error, the error settles immediately while confirmation waits in the managed saved-voice query. Backend readiness resumes that query. Only a successful list confirming absence clears the selected voice; rollback, failed confirmation and query cancellation preserve it. This refresh does not retry asset cleanup.

Errors during batch deletion are each checked in order, so a later error cannot discard an earlier deletion check. A confirmation request stalled for 30 seconds is cancelled so later checks can continue; the timed-out check preserves its voice selection because absence remains unknown. Time paused offline does not count toward this request limit. Clearing the query-client cache cancels checks from that earlier cache lifecycle.
