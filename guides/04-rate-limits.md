# Rate limits — comments per hour

## Khuyến nghị

| Rate | Mức độ | Nhận xét |
|---|---|---|
| **5-10/hr** | Rất an toàn | Phù hợp account mới, account chưa warm-up, hoặc đang test |
| **10-20/hr** | Safe (mặc định 15) | Phù hợp account đã hoạt động bình thường ≥ 1 tháng |
| **20-30/hr** | Aggressive | Account warm, có engagement thật, dùng cẩn thận |
| **>30/hr** | Risky | Twitter có thể restrict / phone-verify / shadowban |

## Twitter giới hạn cứng (tham khảo)

- Tweet/reply: ~2400/ngày (theo TOS), nhưng thực tế bot bị limit sớm hơn rất nhiều
- Search: bị throttle sau ~50 request liên tiếp
- Account < 1 tuần tuổi: limit nghiêm hơn nữa, bị `403` / `RATE_LIMITED` rất nhanh

## Cách bot tránh bị block

- **Hourly cap**: không bao giờ vượt `commentsPerHour` trong cửa sổ 60 phút trượt
- **Random jitter**: giữa mỗi reply, sleep 60-240 giây ngẫu nhiên (tweak `delayMinMs` / `delayMaxMs` trong `data/config.json`)
- **Cycle gap**: hết một vòng quét, sleep 5-10 phút trước khi quét lại
- **Backoff**: nếu nhận `RATE_LIMITED 429/403`, dừng cycle hiện tại, gửi alert Telegram

## Khi nào tăng rate?

Sau 1 tuần chạy ổn định ở 15/hr mà không có warning, có thể tăng dần:
- Tuần 2: 20/hr
- Tuần 3: 25/hr
- Không nên vượt 30/hr trừ khi bạn có account verified + đã age > 6 tháng

## Khi bị restrict

Triệu chứng: log liên tục có `RATE_LIMITED 403`, hoặc `SESSION_EXPIRED`.

Xử lý:
1. Stop bot ngay (`schtasks /End /TN TwitterCommentPack` hoặc kill process)
2. Đăng nhập browser thật, comment / like vài tweet bằng tay → xem có bị Twitter yêu cầu phone-verify không
3. Nghỉ 24-48h
4. Hạ rate xuống 5/hr, chạy lại
