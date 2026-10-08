# Bàn giao: nâng cấp Sách nói / Truyện (fork phvhao)

Cập nhật: 2026-10-08 · Nhánh `feat/longform-voice-preview-pronunciation` (đã push; `main` của
`phvhao/VoiceStudio` trỏ cùng commit mới nhất). Bản cài đặt Windows cuối:
`electron/release/VoiceStudio-Electron-0.5.7-win-x64.exe` (build từ `95cbf842`). Chưa gửi PR lên repo gốc `debpalash/VoiceStudio`.

## Trạng thái nhanh

- Toàn bộ tính năng được yêu cầu đã làm, commit và push.
- Kiểm tra lần cuối đạt: typecheck, lint, locale (21 ngôn ngữ), ~1775 test renderer, ~2990 test
  shared, hơn 2500 test Python, các smoke giao diện CI chạy (longform-layout, playback, longform,
  language-picker, dub).
- Test `backend-setup.test.ts` ("only ever names a uv that is really there") từng đỏ trên máy không có uv:
  `OMNIVOICE_BUNDLED_UV` rỗng được truyền nguyên cho backend. Đã sửa (bỏ biến khi không tìm thấy uv).
- 2026-10-08: đã gộp repo gốc đến `06c6e077` (bản 0.5.7 chính thức, 206 commit: bảo mật chặn yêu cầu
  từ trang web lạ, chuyển model sang RAM sau khi tạo, phụ đề lồng tiếng…). Gỡ 20 file xung đột, giữ cả
  hai phía; route tải bản xuất HTML (xóa file sau khi gửi) được thêm lớp chặn GET từ trang lạ như các
  route tải khác của repo gốc.
- Sau phần tính năng là 6 đợt tối ưu theo bản rà soát đo đạc (xem mục "Đợt tối ưu"); mỗi đợt có kiểm tra
  toàn bộ, review đối kháng và sửa lỗi trước khi commit.

## Các commit

| Commit | Nội dung |
|---|---|
| `6016071d` | Thanh công cụ markup dùng chung, editor tô sáng tag |
| `825abf34` | Hướng dẫn giọng mặc định, nghe thử đoạn chọn, phát âm `[[từ\|cách đọc]]` |
| `3d322d53` | Đọc từng câu, kiểm tra lời đọc (ASR + đọc lại), Cài đặt → Đọc, menu chuột phải |
| `39cbf5cc` | Xuống dòng tính như dấu chấm |
| `23086381` | Cache chương/đoạn render lại khi quy tắc đọc thay đổi (`PHRASE_SPLIT_REVISION`) |
| `0dfc44d1` | Lề số dòng + dải màu giọng, tag tương tác, gợi ý `[`, cân bằng âm lượng, trình đọc |
| `b4b371ef` | Timeline câu chính xác, `## Phần`, Mục lục, tạo từng chương, xuất HTML, ô chọn giọng |
| `bef3a9cf` | 24 lỗi từ review đối kháng |
| `9d4e5a21` | Bảo mật: file tạm xuất HTML nằm trong thư mục dữ liệu app, không ở temp dùng chung |
| `81fab8f1` | Thư viện sách/truyện, tag `[volume]`, HTML kiểu e-book, zoom, cột mục lục, hiệu năng trình đọc, Nhân bản/Thiết kế chèn pause |
| `d41e8765` | Cài đặt kiểm tra chính tả, gợi ý `[` theo trang |
| `2527aa7e`, `d8432cd1` | Tag bấm được ở Nhân bản/Thiết kế; ô chọn giọng sắp A–Z |
| `52c8d89b`, `369b281b`, `aeaed18c` | Bỏ nháy đơn khi đọc; gộp câu ngắn (trong cùng dòng) chống méo giọng |
| `9c9f08ab` | Tối ưu đợt 1: khóa cache đúng số bước, LRU, bớt dò, khởi động, xuất ACX, lưu file theo luồng |
| `8d04d997` | Tối ưu đợt 2: một model nhận dạng giữ sẵn cho cả lần render; mã ngôn ngữ chung |
| `b54c8175` | Tối ưu đợt 3: cache từng câu, "Tạo lại câu này", kiểm tra VRAM trước khi nạp Whisper |
| `6c6525e3`, `9f13229b` | Đợt 4: nghe thử không khóa, tiến độ trong chương, bố cục Nhân bản, menu sửa chữ, quay lại/tới, nút báo thiếu gì, thẻ mô hình, Lồng tiếng dịch từng câu + co/giãn hai chiều |
| `f1ec3cd3` | Đợt 5: 6 mẫu HTML + 14 phông OFL, Truyện xuất HTML, editor nhanh hơn, rà tiếng Việt |
| `3ed6a2fc` | Đợt 6: bộ giải mã OmniVoice nhanh hơn 26–31% (CUDA), 35–39% (CPU) |
| `95cbf842` | Nhân bản/Thiết kế/API chuẩn hóa theo mức lời nói −20 dBFS (chênh 9,2 → 2,2 LU); tiêu đề trang không bị cắt |
| `e37f599b` | Thẻ tag giọng đổi được giọng của tag; editor giãn theo cửa sổ rộng (Khổ đọc / Vừa khung) |
| merge `upstream/main` | Gộp repo gốc 0.5.7 chính thức (2026-10-08) |

## Đã làm

### Editor kịch bản (Sách nói, Truyện)
- Lề trái: số dòng, dải màu theo giọng đang đọc (đổi giọng giữa dòng thì đổi từ dòng đó; mỗi chương
  về giọng mặc định), dấu chương/phần/mở đầu ở lề. Tag giọng màu theo từng giọng, khớp chấm màu trong
  Dàn giọng. Dòng đang soạn và tiêu đề chương có dải nền.
- Tag tương tác: rê chuột hiện gợi ý; bấm hoặc `Alt+Enter` mở bảng thao tác theo loại tag (đổi giọng,
  gán hồ sơ, âm lượng giọng, nghe/chọn đoạn, đổi độ dài pause, đổi kiểu nhấn nhá cả cặp, sửa cách đọc,
  xóa). Chuột phải có cùng thao tác (kể cả macOS). Gõ `[` hiện gợi ý tag.
- Thanh trạng thái: dòng/cột, giọng tại con trỏ, số chương/từ/thời lượng; zoom 80–160 %
  (`Ctrl +/−/0`, `Ctrl` + lăn chuột). Mọi thao tác hoàn tác được bằng `Ctrl+Z`; gõ Telex không bị ảnh hưởng.
- Kiểm tra chính tả: Cài đặt → Chung, mặc định tắt; bật thì kiểm tra tiếng Việt + tiếng Anh
  (Windows/macOS dùng bộ của hệ điều hành; Linux không tải từ điển qua mạng).

### Giọng và âm lượng
- Ô chọn giọng có tìm kiếm (không dấu) cho Giọng mặc định và từng dòng Dàn giọng.
- Cân bằng âm lượng tự động giữa các giọng (bật sẵn): đo độ to phần có lời của từng giọng trong chương,
  đưa về −20 dBFS, tối đa ±12 dB, chặn đỉnh. Chỉ ghép lại từ cache, không tạo lại giọng.
- Chỉnh tay ±12 dB theo tên giọng (Dàn giọng hoặc bảng thao tác của tag); Dàn giọng hiện "Tự động: … ·
  Tổng: …" sau khi tạo sách.
- Tag `[volume ±N dB]…[/volume]` cho từng đoạn, áp sau cân bằng (đoạn thì thầm không bị kéo lên).
- `[voice:default]` (mọi kiểu viết hoa) luôn là giọng mặc định.

### Đọc và render
- Đọc từng câu/vế với khoảng nghỉ theo dấu câu (Cài đặt → Đọc, dùng chung cả app); xuống dòng = dấu chấm.
- Kiểm tra lời đọc tùy chọn (ASR, đọc lại tối đa 2 lần, liệt kê câu cần nghe lại).
- Chuẩn hóa: bỏ ngoặc kép (“đừng” không còn thành “dừng”), chữ HOA có dấu đọc thành từ.
- Khóa cache có phiên bản quy tắc tách câu (test dấu vân tay buộc tăng `PHRASE_SPLIT_REVISION` khi đổi
  quy tắc) và dấu mốc cho dòng bị quy tắc ngoặc kép/chữ HOA ảnh hưởng.

### Sách nói
- `## Phần` / `### Phần`: đọc tên phần (không đọc `#`), không tạo chapter m4b; parser Python và JS
  khớp nhau qua `tests/fixtures/longform_parser_cases.json`.
- Cột Mục lục cạnh editor: bấm để nhảy, thêm/đổi tên/xóa tiêu đề, trạng thái từng chương (chưa tạo /
  đã có / đã đổi), tạo và nghe thử từng chương.
- Timeline chính xác theo câu: `<output>.timeline.json` cạnh file sách, lưu kèm cache đoạn và chương;
  `GET /audiobook/timeline/{output}`. Bản cũ không có timeline thì ước lượng.
- Phần nghe: thẻ "đang phát" gọn + cửa sổ trình đọc (tô câu đang đọc, bấm từ để phát, tự cuộn chỉ trong
  cửa sổ, chữ căn đều); chỉ vẽ lại khi đổi từ.
- Xuất HTML: zip gồm `index.html` chạy offline (bìa, mục lục, đoạn văn, chữ căn đều, cỡ chữ, nền
  sáng/sepia/tối, karaoke, in ấn) + audio + ảnh bìa.

### Quản lý và các trang khác
- Thư viện sách/truyện: ô chuyển sách ở đầu trang, tìm/mới/mở/đổi tên/nhân bản/xóa, tự lưu sau ~1 giây,
  chuyển dữ liệu cũ an toàn, một dự án hỏng không làm hỏng cả thư viện. Trang Dự án mở đúng sách của
  từng lần tạo.
- Nhân bản và Thiết kế: menu Chèn có pause, tô màu tag, gợi ý `[` chỉ pause/âm thanh, tag không dùng được
  ở trang này bị gạch đỏ kèm giải thích.

## Đợt tối ưu (số đo trên RTX 3060, Windows)

| Hạng mục | Trước → sau |
|---|---|
| Sửa một từ rồi tạo lại (chương 12 đoạn) | 48 câu → 1 câu (~5,5 phút → ~7 s) |
| Tạo lại sách 9–10 giờ sau khi sửa một câu (cache đầy) | 2,9–4,2 giờ GPU → 13–18 phút |
| Đổi giọng một vai (vai 10% lời, sách 3 giờ) | ~3,8 giờ → ~0,4 giờ GPU |
| Kiểm tra lời đọc, mỗi câu sau câu đầu | 3,96 s → 0,64 s |
| Một bản thu 32 bước, giọng mẫu 15 s | 3,39 s → 2,49 s |
| Gõ phím, kịch bản 150.000 ký tự | ~110 ms → ~10 ms (jsdom); 89–97 → ~26 ms (Chromium) |
| `/api/settings/performance-profile` | 476 ms → 35 ms; CPU backend lúc rảnh −85% |
| Lưu sách 400 MB | +1,22 GB RAM → +84 MB |

Thay đổi hành vi cần biết: số bước theo mức hiệu năng (thanh trượt hiện số thực); seed cố định ở fp16 cho
bản thu khác trước (`OMNIVOICE_PACKED_CFG=0` để trở lại); máy GPU từ xa phải chạy bản này; cache cũ vẫn dùng được.

## Chưa làm

| Việc | Ghi chú |
|---|---|
| Kéo thả sắp xếp chương trong Mục lục | Đã nói để sau |
| Karaoke khớp từng từ bằng ASR | Hiện từ được ước lượng trong từng câu (câu thì chính xác); có thể tận dụng bước kiểm tra lời đọc |
| Gợi ý chính tả trong menu riêng của editor markup | Ô nhập thường đã có (menu hệ thống); editor Sách nói/Truyện chưa |
| Bật bộ giải mã mới cho ROCm/MPS/DirectML/torch.compile | Cần kiểm tra trên máy tương ứng (`OMNIVOICE_PACKED_CFG=1`) |
| Lồng tiếng chuyển sang chuẩn hóa theo mức lời nói | Còn dùng đỉnh −2 dBFS; cần thêm phiên bản mastering vào khóa cache lồng tiếng |
| L1–L12 của bản rà soát (CUDA graph, FLAC cache, giới hạn cache…) | Để sau |
| Lưu mức âm lượng đo được vào hồ sơ giọng | Chờ quyết định; chỉ để tham khảo, không thay cân bằng |
| PR lên repo gốc | Chưa gửi |

## Cần kiểm tra thủ công

- File HTML xuất ra trên Firefox và Safari (mới thử Chromium).
- Cột Mục lục khi cửa sổ hẹp (< 720 px); nhãn chương ở lề với tiếng Trung, Nhật, Thái.
- Số đo hiệu năng trình đọc trên app thật (đã đo bằng jsdom; trước khi sửa đo trên app: ~57 lần
  layout/giây, ~33 % CPU luồng giao diện).

## Vấn đề đã biết

- **App dev thỉnh thoảng thoát với mã 9** khi agent vừa sửa code vừa chạy test (đã loại trừ: test của
  tiến trình chính, từng file test longform, việc electron-vite khởi động lại). Chưa rõ gốc; không thấy
  ở bản cài đặt. Bẫy theo dõi: `exit-trap.ps1` (ghi các tiến trình chạy trong 60 giây trước khi
  Electron biến mất).
- Máy GPU từ xa chạy bản cũ bỏ qua `[volume]` và cân bằng âm lượng.
- Hạ cấp app (mở thư viện bằng bản cũ hơn) thấy danh sách dự án trống; bản nháp đang dùng không mất.
- Kịch bản có dòng `##` và dự án từng gán giọng cho `[voice:default]` sẽ render lại các chương liên
  quan một lần (đúng ý đồ).

## Chạy và kiểm tra trên Windows

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\VoiceStudio\resources\tools;$env:PATH"
bun run dev
```

```bash
cd electron && bun run typecheck && bun run lint && bun run locale:check
bun x vp test --run                                   # renderer
bun x vp test --run --config vite.shared.config.ts    # shared
cd ../backend && ../.venv/Scripts/python -m pytest -q -p no:cacheprovider ../tests
```

`bun run dev` có thể đổi xuống dòng của `bun.lock`; nếu `git diff --ignore-cr-at-eol bun.lock` rỗng thì
`git checkout -- bun.lock`.

## Tài liệu liên quan

`docs/expressive-speech.md` (markup, đọc từng câu, âm lượng, chính tả), `docs/electron-longform.md`
(timeline, xuất HTML, thư viện), `CHANGELOG.md` mục `[Unreleased]`.
