# Vietnamese UI glossary

The words the Vietnamese catalog (`electron/src/renderer/src/i18n/locales/vi.json`)
uses for VoiceStudio's concepts. Follow it when you add or review a Vietnamese
string, so one idea keeps one name across Clone, Dubbing, Stories, Audiobook and
Settings. `tests/test_locale_terms.py` fails on the mistakes that already shipped
once (trade words for export and import, a motor for an engine, a verb for the
cast).

## Style

- Sentence case: "Dàn giọng", not "DÀN GIỌNG", even where English writes the
  label in capitals. Typed confirmation words are the only exception.
- Short, direct buttons and labels ("Xuất", "Thử lại"). Use "Hãy …" only in
  guidance sentences, and address the user as "bạn".
- Keep names and technical words in English where Vietnamese users meet them in
  English: VoiceStudio, Pro, engine, GPU, CUDA, ffmpeg, LLM, API, URL, seed, tag,
  stem, zip, SRT.
- Leave `{{placeholders}}` exactly as they are. Plural forms (`_one`, `_other`)
  can read the same, since Vietnamese nouns do not inflect.
- Markup is syntax, not prose: keep `[pause 0.5s]`, `[pause 500ms]`,
  `[voice:NAME]`, `[slow]…[/slow]` and the other tags in English, with a dot in
  decimals, and keep the space after `#` in chapter headings. Only the voice
  name inside `[voice:…]` of an example script may be Vietnamese. A translated
  tag such as `[tạm dừng 0,5 giây]` is read aloud instead of pausing.

## Terms

| English | Vietnamese | Notes |
| --- | --- | --- |
| Dub, dubbing | Lồng tiếng | Batch dubbing: Lồng tiếng hàng loạt |
| Cast (the voices given to speakers or characters) | Dàn giọng | Never "Đúng", "Truyền" or "Diễn viên". Auto-cast: Tự động gán giọng. "Cast X as Y": Gán X cho Y |
| Take | Bản thu | Retake a sentence: Đọc lại câu |
| Render, generate, synthesize | Tạo | Synthesize audio: Tạo âm thanh. Avoid "Kết xuất", which reads like "Xuất" (export), and "Tổng hợp", which reads like "summary" |
| Export | Xuất | Exported file: Tệp đã xuất. Never "Xuất khẩu" (trade export) |
| Import | Nhập | My imports: Đã nhập. Never "Nhập khẩu" (trade import) |
| Engine | engine | Never "Động cơ" (a motor) |
| Model | Mô hình | |
| Voice | Giọng nói; Giọng in short labels | |
| Voice profile | Hồ sơ giọng nói | Profiles (navigation): Hồ sơ |
| Voice cloning, clone | Nhân bản giọng nói, Nhân bản | |
| Voice design | Thiết kế giọng nói | |
| Reference audio | Âm thanh tham chiếu | |
| Speaker (a person in a recording) | Người nói | Never "Loa" (a loudspeaker) |
| Narrator | Người kể chuyện | Audiobook credit ("Narrated by"): Người đọc |
| Transcribe, transcript | Chép lời, Bản chép lời | Avoid "Phiên âm", which means phonetic spelling |
| Dictation | Đọc chính tả | |
| Translate, translation | Dịch, Dịch thuật | |
| Segment | Phân đoạn | |
| Chapter | Chương | The reader's chapter list: Mục lục |
| Live preview (listening) | Nghe thử trực tiếp | Preview a voice: Nghe thử. Preview a document or video: Xem trước |
| Original (audio or track) | Bản gốc | |
| Project | Dự án | |
| Gallery | Thư viện | |
| Audiobook | Sách nói | |
| Stories | Truyện | |
| Script | Kịch bản | |
| Subtitles | Phụ đề | |
| Queue | Hàng đợi | |
| Logs | Nhật ký | |
| Repair | Sửa lỗi | |
| More actions | Thao tác khác | |
| Get Pro | Nâng cấp Pro | |
| Workspace | Không gian làm việc | |

## Other languages

The same mistakes appear in machine translation for other languages, and the
test checks those too:

- **Cast** is a noun (the voices assigned to a story's characters or a video's
  speakers), never the verb "to throw" or "to broadcast".
- **Export** and **import** are file operations, never international trade.
- **Speaker** is a person who speaks, never a loudspeaker.
- **Markup examples** keep the literal tags and `# ` headings that the long-form
  parser (`backend/services/longform_parser.py`) reads.
