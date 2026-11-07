# dsh-video-watch

Một tool DSH: `watch_video`.

Nhận link YouTube, TikTok, Facebook, Instagram, X, hoặc file `mp4`. Tải video, tách 8 đến 24 khung hình, và chép lời bằng Groq Whisper nếu máy có `GROQ_API_KEY`.

Máy chạy DSH cần `ffmpeg`, `ffprobe`, và `yt-dlp` trên `PATH`.

## Cài

```bash
dsh plugin --profile web add ./dsh-video-watch
dsh web
```

Profile `superagent` dùng cùng lệnh, đổi `--profile web` thành `--profile superagent`.

## API key để chép lời

Tạo key tại [Groq Console](https://console.groq.com/keys), rồi đặt biến `GROQ_API_KEY`. Không có key thì tool vẫn trả khung hình và ghi rõ là chưa chép lời.

Lời nói gửi `POST https://api.groq.com/openai/v1/audio/transcriptions`, model
`whisper-large-v3-turbo` (mặc định). Đổi model bằng biến `GROQ_STT_MODEL` — ví dụ
`whisper-large-v3` nếu cần độ chính xác cao hơn trên audio khó; nó đắt hơn khoảng ba lần
mỗi giờ và chậm hơn, nên chỉ dùng khi thật sự cần.

Âm thanh dài hơn 24 MB (giới hạn một request của Groq ở gói miễn phí) được cắt thành
các cửa sổ 15 phút rồi ghép lại — một video hội thoại dài sẽ vượt giới hạn đó nếu gửi
nguyên khối.
