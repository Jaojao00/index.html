# KPI & HR Management System

Hệ thống quản lý KPI, Timesheet và Đối soát được build dựa trên yêu cầu thực tế của Operations.

## 🚀 Tính năng nổi bật

1. **KPI Engine (Trái tim hệ thống)**: Tự động chuẩn hóa dữ liệu timesheet (S19, S10, S3, OFF, NPL) và tính toán các chỉ số:
   - Tổng công
   - Công Chiến Dịch (Campaign)
   - Công Mini
   - Lỗi Vi phạm & Nghỉ không phép
   - **Tự động đưa ra kết quả PASS/FAIL**

2. **Hệ thống Đối soát (Complaint System)**:
   - Ops có thể tạo khiếu nại cho các ca FAIL.
   - Vendor có thể Duyệt/Từ chối trực tiếp trên phần mềm.
   - Khi Vendor duyệt (ví dụ: NPL -> Có phép), hệ thống tự động chạy lại KPI Engine và cập nhật kết quả.

3. **Giao diện hiện đại (Premium UI)**:
   - Dashboard tổng quan số liệu trực quan.
   - Thiết kế Dark Mode chuyên nghiệp, tối giản.

## 🛠️ Công nghệ sử dụng

- **Backend**: NodeJS + Express (Mô phỏng Database qua Runtime Object).
- **Frontend**: Vue 3 (CDN) + Vanilla CSS (Aesthetics).
- Cấu trúc thư mục:
  - `server.js`: API Backend & KPI Engine.
  - `public/`: Chứa file tĩnh (UI Vue).

## 📥 Cách chạy dự án

1. Mở Terminal / PowerShell, di chuyển vào thư mục dự án:
   ```bash
   cd C:\Users\ASUS\.gemini\antigravity\scratch\kpi-system
   ```

2. Cài đặt thư viện:
   ```bash
   npm install
   ```

3. Chạy server:
   ```bash
   npm start
   ```

4. Truy cập web app tại: [http://localhost:3000](http://localhost:3000)
