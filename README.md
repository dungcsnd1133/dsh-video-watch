# dsh-video-watch

Một tool DSH: `watch_video`.

Nhận link YouTube, TikTok, Facebook, Instagram, X, hoặc file `mp4`. Tải video, tách 8 đến 24 khung hình, và chép lời nếu máy có `XAI_API_KEY`.

Máy chạy DSH cần `ffmpeg`, `ffprobe`, và `yt-dlp` trên `PATH`.

## Cài

```bash
dsh plugin --profile web add ./dsh-video-watch
dsh web
```

Profile `superagent` dùng cùng lệnh, đổi `--profile web` thành `--profile superagent`.

## API key để chép lời

Tạo key tại [API Keys](https://console.x.ai/team/default/api-keys), rồi đặt biến `XAI_API_KEY`. Không có key thì tool vẫn trả khung hình và ghi rõ là chưa chép lời.

Lời nói gửi `POST https://api.x.ai/v1/stt`, model `grok-voice-transcribe-2.0`.
