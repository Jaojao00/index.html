const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE SIMULATION ---
const db = {
    employees: [],
    attendance: [],
    timesheet: [],
    timesheetHeaders: [],
    schedule: [],
    scheduleHeaders: [],
    leaveRequests: [],
    leaveHeaders: [],
    absenceRecords: [],
    kpi_results: [],
    employeeNotes: {}, // { ops_id: 'note text' }
    complaints: [],
    uploadHistory: [], // { id, type, originalName, filename, month, year, recordCount, timestamp }
    config: {
        target_total_cong: 26,
        target_mini: 6,
        target_cp: 5,
        miniDays: [1, 2, 15, 16, 25, 26],
        cpDays: [4, 5, 6, 7, 8],
        template_timesheet: '',
        template_schedule: ''
    },
    shift_config: {
        'S19': 8,
        'S10': 8,
        'S3': 8,
        'OFF': 0,
        'AL': 8,
        'NPL': 0
    }
};

// Seed some initial employee data
db.employees = [
    { id: 1, name: 'Nguyễn Văn A', ops_id: 'OPS34168', vendor: 'Vendor A', loai_ctv: 'BPO' },
    { id: 2, name: 'Trần Thị B', ops_id: 'OPS34169', vendor: 'Vendor B', loai_ctv: 'S-BPO' },
    { id: 3, name: 'Lê Văn C', ops_id: 'OPS34170', vendor: 'Vendor A', loai_ctv: 'BPO' }
];

// --- HELPER: Auto-detect dominant month/year from attendance data ---
function getDataMonth() {
    const counts = {};
    db.attendance.forEach(a => {
        if (!a.date) return;
        const d = new Date(a.date);
        if (isNaN(d.getTime())) return;
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
        counts[key] = (counts[key] || 0) + 1;
    });
    const entries = Object.entries(counts);
    if (entries.length === 0) return { month: new Date().getMonth() + 1, year: new Date().getFullYear() };
    entries.sort((a, b) => b[1] - a[1]);
    const [year, month] = entries[0][0].split('-').map(Number);
    return { month, year };
}

// --- MODULE 2: Chuẩn hóa dữ liệu ---
function normalizeAttendance(rawData) {
    // rawData is an array of objects from Excel like: { ops_id: 'OPS34168', date: '2026-04-01', status: 'S19' }
    return rawData.map(row => {
        let normalizedStatus = 'N/A';
        if (['S19', 'S10', 'S3'].includes(row.status)) normalizedStatus = 'working';
        else if (row.status === 'OFF') normalizedStatus = 'nghỉ';
        else if (row.status === 'AL') normalizedStatus = 'nghỉ phép';
        else if (row.status === 'NPL') normalizedStatus = 'nghỉ không phép';

        return {
            employee_id: row.ops_id,
            date: row.date,
            status: row.status,
            normalizedStatus: normalizedStatus,
            working_hours: db.shift_config[row.status] || 0
        };
    });
}

// --- MODULE 3: KPI Engine ---
function calculateKPI(ops_id, month, year) {
    // 1. Lọc data chấm công theo nhân viên và tháng (so sánh KHÔNG phân biệt hoa/thường)
    const opsUpper = ops_id.toUpperCase();
    const empAttendance = db.attendance.filter(a =>
        a.employee_id && a.employee_id.toUpperCase() === opsUpper &&
        new Date(a.date).getMonth() + 1 === parseInt(month) &&
        new Date(a.date).getFullYear() === parseInt(year)
    );

    let total_ngay_cong = 0;
    let total_ngay_cong_cp = 0;
    let total_ngay_cong_mini = 0;
    let no_permission_leave = 0;
    let vi_pham = 0;
    let kpi_grade = 'B';

    // Set of attendance days for quick lookup
    const attendanceDayMap = {}; // day -> { status, worked }

    empAttendance.forEach(record => {
        const recordDate = new Date(record.date).getDate();
        const isWorking = ['S19', 'S10', 'S3', 'WORKING'].includes(record.status);

        // Track which days have attendance
        if (!attendanceDayMap[recordDate]) {
            attendanceDayMap[recordDate] = { status: record.status, worked: isWorking };
        } else if (isWorking) {
            attendanceDayMap[recordDate].worked = true;
        }

        // 1. total_ngay_cong
        if (isWorking) {
            total_ngay_cong += 1;
        }

        // 2. total_ngay_cong_cp (Ngày Công Campaign)
        if (db.config.cpDays.includes(recordDate) && isWorking) {
            total_ngay_cong_cp += 1;
        }

        // 3. total_ngay_cong_mini (Ngày Công Mini Campaign)
        if (db.config.miniDays.includes(recordDate) && isWorking) {
            total_ngay_cong_mini += 1;
        }

        // 4. Vi phạm: attendance có nhưng thiếu claim hoặc bất thường khác
        // (HỦY claim = Nghỉ KP theo yêu cầu business)
        if (record.status === 'HỦY') {
            // Claim không OK → mặc định là nghỉ KP
            no_permission_leave += 1;
        }

        // 5. no_permission_leave from attendance records marked NPL
        if (record.status === 'NPL') {
            const complaint = db.complaints.find(c => c.employee_id === ops_id && c.date === record.date && c.status === 'approved');
            if (!complaint) {
                no_permission_leave += 1;
            }
        }
    });

    // --- CROSS-REFERENCE: Schedule vs Attendance ---
    // Find this employee's schedule row
    const scheduleRow = db.schedule.find(row => {
        const keys = Object.keys(row);
        return keys.some(k => {
            const val = String(row[k]).trim().toUpperCase();
            return val === opsUpper;
        });
    });

    if (scheduleRow) {
        const scheduleKeys = Object.keys(scheduleRow);
        const workShifts = ['S19', 'S10', 'S3'];
        // Keywords to skip (non-day columns)
        const nonDayPattern = /rank|trạng thái|công thức|vendor|loại|mã|tên|name|id|ops|đối tác|ghi chú|note/i;

        scheduleKeys.forEach(key => {
            // Skip non-day columns
            if (nonDayPattern.test(key)) return;

            // Extract day number from column header (e.g., "Wed 1" → 1, "Mon 13" → 13, "1" → 1)
            const dayMatch = key.match(/(\d{1,2})/);
            if (!dayMatch) return;
            const dayNum = parseInt(dayMatch[1]);
            if (dayNum < 1 || dayNum > 31) return;

            const scheduledShift = String(scheduleRow[key]).trim().toUpperCase();

            // If scheduled to WORK (S3, S10, S19) but NO attendance record for that day
            if (workShifts.includes(scheduledShift)) {
                const dayRecord = attendanceDayMap[dayNum];
                if (!dayRecord) {
                    // Scheduled to work but completely absent → nghỉ không phép
                    no_permission_leave += 1;
                } else if (!dayRecord.worked && dayRecord.status !== 'AL') {
                    // Has record but didn't actually work (and not approved leave)
                    // Already counted via NPL/HỦY above, skip duplicate
                }
            }
        });
    }

    // 6. KPI RESULT logic
    let result = 'FAIL';
    if (
        total_ngay_cong >= db.config.target_total_cong &&
        total_ngay_cong_cp >= db.config.target_cp &&
        total_ngay_cong_mini >= db.config.target_mini &&
        vi_pham === 0 &&
        no_permission_leave === 0
    ) {
        result = 'PASS';
    }

    return {
        ops_id,
        month,
        year,
        total_ngay_cong,
        total_ngay_cong_cp,
        total_ngay_cong_mini,
        no_permission_leave,
        vi_pham,
        kpi_grade,
        result
    };
}

// API Endpoints

// Config Endpoints
app.get('/api/config', (req, res) => res.json(db.config));
app.post('/api/config', (req, res) => {
    db.config = { ...db.config, ...req.body };
    // Auto-detect month from attendance data, not current date
    const dm = getDataMonth();
    db.kpi_results = [];
    db.employees.forEach(emp => {
        db.kpi_results.push(calculateKPI(emp.ops_id, dm.month, dm.year));
    });
    res.json({ message: 'Cập nhật cấu hình thành công', config: db.config });
});

// Import attendance data (Simulating Phase 1)
app.post('/api/import-attendance', (req, res) => {
    const rawData = req.body;
    const normalizedData = normalizeAttendance(rawData);

    // In real app, we'd upsert. Here we just push.
    db.attendance.push(...normalizedData);

    res.json({ message: 'Import and normalization successful', count: normalizedData.length });
});

// Upload Timesheet
app.post('/api/upload-timesheet', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

        // Log first row headers for debugging
        if (rawData.length > 0) {
            console.log('[Upload Timesheet] Headers detected:', Object.keys(rawData[0]));
            console.log('[Upload Timesheet] First row sample:', JSON.stringify(rawData[0]).substring(0, 500));
        }

        const normalizedData = rawData.map((row, rowIdx) => {
            // Find keys that match our expected headers (case-insensitive)
            const keys = Object.keys(row);
            let ops_id_key = keys.find(k => k.match(/mã(\s)?(số\s)?(ctv|nhân viên|nv)|ops(\s)?id/i));
            const date_key = keys.find(k => k.match(/ngày|date/i));
            const name_key = keys.find(k => k.match(/họ và tên|tên|name/i));
            const vendor_key = keys.find(k => k.match(/vendor|đối tác/i));
            const type_key = keys.find(k => k.match(/loại(\s)?ctv|type/i));
            const in_time_key = keys.find(k => k.match(/giờ vào/i));
            const out_time_key = keys.find(k => k.match(/giờ ra/i));
            const claim_key = keys.find(k => k.match(/claim/i));

            // Fallback: if ops_id not found by header, scan cell VALUES for OPS ID pattern
            if (!ops_id_key) {
                ops_id_key = keys.find(k => {
                    const val = String(row[k]).trim();
                    return val.match(/^OPS\d+$/i);
                });
            }

            const ops_id = ops_id_key ? String(row[ops_id_key]).trim() : null;
            const name = name_key ? String(row[name_key]).trim() : '';
            const vendor = vendor_key ? String(row[vendor_key]).trim() : '';
            const loai_ctv = type_key ? String(row[type_key]).trim().toUpperCase() : 'BPO';
            const inTime = in_time_key ? String(row[in_time_key]).trim() : '';
            const outTime = out_time_key ? String(row[out_time_key]).trim() : '';
            const claim = claim_key ? String(row[claim_key]).trim().toUpperCase() : 'OK';

            // Debug: log first row parsing result
            if (rowIdx === 0) {
                console.log('[Upload Timesheet] ops_id_key:', ops_id_key, '→ ops_id:', ops_id);
                console.log('[Upload Timesheet] date_key:', date_key, '→ date:', row[date_key]);
                console.log('[Upload Timesheet] in_time_key:', in_time_key, '→ inTime:', inTime);
                console.log('[Upload Timesheet] claim_key:', claim_key, '→ claim:', claim);
            }

            // Format Excel dates
            let date = date_key ? row[date_key] : null;
            if (typeof date === 'number') {
                const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                date = new Date(excelEpoch.getTime() + date * 86400000).toISOString().split('T')[0];
            } else if (typeof date === 'string') {
                // If format is DD/MM/YYYY
                if (date.includes('/')) {
                    const parts = date.split('/');
                    if (parts.length >= 3) {
                        date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                    }
                }
            }

            let status = 'N/A';
            if (claim && claim !== 'OK' && !claim.includes('OK')) {
                status = 'HỦY';
            } else {
                // Try to find "Ca chấm công" column first (contains clean time range like "06:00-15:00")
                const shift_key = keys.find(k => k.match(/ca chấm|ca làm|shift/i));
                const hours_key = keys.find(k => k.match(/tổng giờ|total.*hour|giờ công/i));

                // Extract only HH:MM from datetime strings like "2026-04-01 06:00"
                const extractTime = (val) => {
                    if (!val) return '';
                    const s = String(val).trim();
                    // If it's a datetime like "2026-04-01 06:00", extract the time part
                    const dtMatch = s.match(/(\d{1,2}:\d{2})/);
                    return dtMatch ? dtMatch[1] : s;
                };

                const inTimeClean = extractTime(inTime);
                const outTimeClean = extractTime(outTime);

                // Check "Ca chấm công" column first (cleanest source)
                if (shift_key && row[shift_key]) {
                    const shiftVal = String(row[shift_key]).trim();
                    if (shiftVal.includes('06:00-15:00') || shiftVal.includes('6:00-15:00')) {
                        status = 'S3';
                    } else if (shiftVal.includes('13:00-22:00')) {
                        status = 'S10';
                    } else if (shiftVal.includes('22:00-06:00') || shiftVal.includes('22:00-6:00')) {
                        status = 'S19';
                    } else if (shiftVal.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/)) {
                        // Any other time range format = WORKING
                        status = 'WORKING';
                    }
                }

                // If not determined from shift column, try from in/out times
                if (status === 'N/A') {
                    const timeString = `${inTimeClean}-${outTimeClean}`;
                    if (timeString.includes('06:00-15:00') || timeString.includes('6:00-15:00')) {
                        status = 'S3';
                    } else if (timeString.includes('13:00-22:00')) {
                        status = 'S10';
                    } else if (timeString.includes('22:00-06:00') || timeString.includes('22:00-6:00')) {
                        status = 'S19';
                    } else {
                        // Try status/ca column
                        const status_key = keys.find(k => k.match(/trạng thái|ca(?!\s*chấm)|shift/i));
                        if (status_key) {
                            const rawStatus = String(row[status_key]).trim().toUpperCase();
                            if (['OFF', 'AL', 'NPL', 'S3', 'S10', 'S19'].includes(rawStatus)) {
                                status = rawStatus;
                            } else if (rawStatus && claim.includes('OK')) {
                                status = 'WORKING';
                            }
                        } else if ((inTimeClean || outTimeClean) && claim.includes('OK')) {
                            status = 'WORKING';
                        }
                    }
                }

                // Final fallback: check "Tổng giờ" - if >= 7 hours, count as WORKING
                if (status === 'N/A' && hours_key) {
                    const totalHours = parseFloat(row[hours_key]);
                    if (!isNaN(totalHours) && totalHours >= 7) {
                        status = 'WORKING';
                    }
                }

                // Ultra fallback: if has any in/out time and claim is OK
                if (status === 'N/A' && (inTime || outTime) && claim.includes('OK')) {
                    status = 'WORKING';
                }
            }

            let normalizedStatus = 'N/A';
            if (['S19', 'S10', 'S3', 'WORKING'].includes(status)) normalizedStatus = 'working';
            else if (status === 'OFF') normalizedStatus = 'nghỉ';
            else if (status === 'AL') normalizedStatus = 'nghỉ phép';
            else if (status === 'NPL') normalizedStatus = 'nghỉ không phép';
            else if (status === 'HỦY') normalizedStatus = 'hủy';

            if (ops_id) {
                const existingEmp = db.employees.find(e => e.ops_id === ops_id);
                if (existingEmp) {
                    if (name) existingEmp.name = name;
                    if (vendor) existingEmp.vendor = vendor;
                    if (loai_ctv) existingEmp.loai_ctv = loai_ctv;
                } else {
                    db.employees.push({
                        id: db.employees.length + 1,
                        ops_id: ops_id,
                        name: name || ops_id,
                        vendor: vendor || 'Unknown Vendor',
                        loai_ctv: loai_ctv || 'BPO'
                    });
                }
            }

            return {
                employee_id: ops_id,
                date: date,
                status: status,
                normalizedStatus: normalizedStatus,
                working_hours: db.shift_config[status] || 0
            };
        }).filter(r => r.employee_id && r.date);

        // Debug: log import results
        console.log(`[Upload Timesheet] rawData: ${rawData.length} rows → normalizedData: ${normalizedData.length} records`);
        if (normalizedData.length > 0) {
            console.log('[Upload Timesheet] Sample record:', JSON.stringify(normalizedData[0]));
        } else if (rawData.length > 0) {
            // Debug why filter removed everything
            const testRow = rawData[0];
            const testKeys = Object.keys(testRow);
            const testOpsKey = testKeys.find(k => k.match(/mã(\s)?(số\s)?(ctv|nhân viên|nv)|ops(\s)?id/i));
            const testOpsValKey = testKeys.find(k => String(testRow[k]).trim().match(/^OPS\d+$/i));
            console.log('[Upload Timesheet] WARNING: 0 records after filter!');
            console.log('[Upload Timesheet] ops_id by header:', testOpsKey);
            console.log('[Upload Timesheet] ops_id by value:', testOpsValKey);
        }

        // Update DB
        db.attendance.push(...normalizedData);
        if (rawData.length > 0) {
            db.timesheetHeaders = Object.keys(rawData[0]);

            // Format for display
            db.timesheet = rawData.map(row => {
                const newRow = {};
                for (const key in row) {
                    let val = row[key];
                    if (typeof val === 'number') {
                        if (val > 40000 && val < 60000) {
                            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                            const dateObj = new Date(excelEpoch.getTime() + val * 86400000);
                            if (val % 1 !== 0) {
                                // Có phần thập phân = DateTime (VD: 46082.208 = 2026-03-01 05:00)
                                const dateStr = dateObj.toISOString().split('T')[0];
                                const fractional = val - Math.floor(val);
                                const totalSec = Math.round(fractional * 86400);
                                const hh = Math.floor(totalSec / 3600);
                                const mm = Math.floor((totalSec % 3600) / 60);
                                val = `${dateStr} ${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
                            } else {
                                // Ngày nguyên = Date only (VD: 46082 = 2026-03-01)
                                val = dateObj.toISOString().split('T')[0];
                            }
                        } else if (val > 0 && val < 1) {
                            const totalSeconds = Math.round(val * 86400);
                            const h = Math.floor(totalSeconds / 3600);
                            const m = Math.floor((totalSeconds % 3600) / 60);
                            val = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                        } else {
                            val = Math.round(val * 100) / 100;
                        }
                    }
                    newRow[key] = val;
                }
                return newRow;
            });
        }

        // Detect month directly from the UPLOADED data (not from db.attendance)
        let uploadMonth = new Date().getMonth() + 1;
        let uploadYear = new Date().getFullYear();
        const monthCounts = {};

        // First try from normalizedData (already parsed dates)
        normalizedData.forEach(r => {
            if (!r.date) return;
            const d = new Date(r.date);
            if (isNaN(d.getTime())) return;
            const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
            monthCounts[key] = (monthCounts[key] || 0) + 1;
        });

        // If normalizedData had no dates, scan rawData directly
        if (Object.keys(monthCounts).length === 0) {
            rawData.forEach(row => {
                const keys = Object.keys(row);
                const date_key = keys.find(k => k.match(/ngày|date/i));
                if (!date_key) return;
                let dateVal = row[date_key];
                let parsed;
                if (typeof dateVal === 'number' && dateVal > 40000 && dateVal < 60000) {
                    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                    parsed = new Date(excelEpoch.getTime() + Math.floor(dateVal) * 86400000);
                } else if (typeof dateVal === 'string') {
                    // Handle YYYY-MM-DD or DD/MM/YYYY
                    if (dateVal.includes('/')) {
                        const parts = dateVal.split('/');
                        if (parts.length >= 3) parsed = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
                    } else {
                        parsed = new Date(dateVal);
                    }
                }
                if (parsed && !isNaN(parsed.getTime())) {
                    const key = `${parsed.getFullYear()}-${parsed.getMonth() + 1}`;
                    monthCounts[key] = (monthCounts[key] || 0) + 1;
                }
            });
        }

        const mcEntries = Object.entries(monthCounts);
        if (mcEntries.length > 0) {
            mcEntries.sort((a, b) => b[1] - a[1]);
            const [y, m] = mcEntries[0][0].split('-').map(Number);
            uploadMonth = m;
            uploadYear = y;
        }

        // Track upload history
        db.uploadHistory.push({
            id: Date.now(),
            type: 'timesheet',
            originalName: req.file.originalname || 'Timesheet',
            filename: req.file.filename,
            month: uploadMonth,
            year: uploadYear,
            recordCount: normalizedData.length,
            timestamp: new Date().toISOString()
        });

        res.json({
            message: `Upload Timesheet thành công! Đã import ${normalizedData.length} bản ghi (Tháng ${uploadMonth}/${uploadYear}).`,
            file: req.file.filename,
            dataMonth: uploadMonth,
            dataYear: uploadYear
        });
    } catch (error) {
        console.error('Lỗi khi đọc file Timesheet:', error);
        res.status(500).json({ error: 'Lỗi khi xử lý file Excel' });
    }
});

// API Get Timesheet Data
app.get('/api/timesheet', (req, res) => {
    res.json({ headers: db.timesheetHeaders, data: db.timesheet });
});

// Upload Schedule (Lịch làm việc)
app.post('/api/upload-schedule', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Use sheet_to_json to get raw arrays of objects
        const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

        if (rawData.length > 0) {
            db.scheduleHeaders = Object.keys(rawData[0]);
            db.schedule = rawData;

            // Cập nhật thông tin nhân sự từ Lịch làm việc
            rawData.forEach(row => {
                const keys = Object.keys(row);
                const ops_id_key = keys.find(k => k.match(/mã(\s)?(số\s)?(nv|nhân viên|ctv)|id|ops/i));
                const name_key = keys.find(k => k.match(/họ và tên|tên|name/i));

                let vendor_key = keys.find(k => k.match(/vendor|đối tác/i));
                let type_key = keys.find(k => k.match(/loại/i)); // 'loại', 'Loại'

                let ops_id = ops_id_key ? String(row[ops_id_key]).trim() : null;
                let name = name_key ? String(row[name_key]).trim() : '';
                let vendor = vendor_key ? String(row[vendor_key]).trim() : '';
                let loai_ctv = type_key ? String(row[type_key]).trim() : '';

                // Fallback: Nếu header bị trống/gộp, quét các cột đầu để đoán Vendor (AGR) và Loại (S-BPO, BPO, OS)
                if (!vendor || !loai_ctv) {
                    for (let i = 0; i < Math.min(10, keys.length); i++) {
                        const val = String(row[keys[i]]).trim().toUpperCase();
                        if (!vendor && (val === 'AGR' || val.includes('VENDOR'))) {
                            vendor = val;
                        }
                        if (!loai_ctv && (val === 'S-BPO' || val === 'BPO' || val === 'OS')) {
                            loai_ctv = val;
                        }
                    }
                }

                if (ops_id && ops_id !== 'undefined' && ops_id !== '') {
                    const existingEmp = db.employees.find(e => e.ops_id.toUpperCase() === ops_id.toUpperCase());
                    if (existingEmp) {
                        // Cập nhật nếu đã có
                        if (name) existingEmp.name = name;
                        if (vendor) existingEmp.vendor = vendor;
                        if (loai_ctv) existingEmp.loai_ctv = loai_ctv;
                    } else {
                        // Thêm mới
                        db.employees.push({
                            ops_id: ops_id,
                            name: name || 'Chưa cập nhật',
                            vendor: vendor || 'Unknown Vendor',
                            loai_ctv: loai_ctv || 'BPO'
                        });
                    }
                }
            });
        }

        // Track upload history
        db.uploadHistory.push({
            id: Date.now(),
            type: 'schedule',
            originalName: req.file.originalname || 'Schedule',
            filename: req.file.filename,
            month: null, // Schedule doesn't have a specific month
            year: null,
            recordCount: rawData.length,
            timestamp: new Date().toISOString()
        });

        res.json({ message: `Upload Lịch làm việc thành công! (${rawData.length} nhân viên)`, file: req.file.filename });
    } catch (error) {
        console.error('Lỗi khi đọc file Lịch làm việc:', error);
        res.status(500).json({ error: 'Lỗi khi xử lý file Excel' });
    }
});

// API Get Schedule Data
app.get('/api/schedule', (req, res) => {
    res.json({ headers: db.scheduleHeaders, data: db.schedule });
});

app.post('/api/upload-template/:type', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Không có file nào được tải lên' });
    }
    const { type } = req.params;
    if (type === 'timesheet') {
        db.config.template_timesheet = req.file.filename;
        res.json({ message: 'Cập nhật mẫu Timesheet thành công!' });
    } else if (type === 'schedule') {
        db.config.template_schedule = req.file.filename;
        res.json({ message: 'Cập nhật mẫu Lịch làm việc thành công!' });
    } else {
        res.status(400).json({ error: 'Loại file không hợp lệ' });
    }
});

// Download Template (Timesheet)
app.get('/api/download-template/timesheet', (req, res) => {
    let filePath = path.join(__dirname, 'mẫu đang dùng.xlsx');

    // Nếu có file mẫu custom đã tải lên, dùng file đó
    if (db.config.template_timesheet) {
        filePath = path.join(__dirname, 'uploads', db.config.template_timesheet);
    }

    // Thử gửi file mẫu user cung cấp
    res.download(filePath, 'Timesheet_Template.xlsx', (err) => {
        if (err) {
            console.log('Không tìm thấy file mẫu gốc, đang tạo file mẫu tự động...');
            // Fallback: Tạo file mẫu tự động nếu không tìm thấy file gốc
            const ws_data = [
                ['Vendor', 'Mã NV', 'Họ Tên', 'Ngày', 'Ca', 'Giờ làm việc', 'Tổng giờ', 'Ghi chú'], // Headers
                ['Vendor A', 'OPS34168', 'Nguyễn Văn A', '01/04/2026', 'S19', '08:00 - 17:00', 8, 'Ví dụ mẫu'] // Example row
            ];
            const ws = xlsx.utils.aoa_to_sheet(ws_data);
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, ws, "Timesheet Template");

            const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Disposition', 'attachment; filename="Timesheet_Template.xlsx"');
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);
        }
    });
});

// Download Template (Schedule)
app.get('/api/download-template/schedule', (req, res) => {
    if (db.config.template_schedule) {
        const filePath = path.join(__dirname, 'uploads', db.config.template_schedule);
        return res.download(filePath, 'Schedule_Template.xlsx', (err) => {
            if (err) {
                console.error('Không tải được file mẫu Lịch làm việc:', err);
                res.status(404).send('Không tìm thấy file mẫu Lịch làm việc');
            }
        });
    }

    // Fallback tạo file tự động
    const ws_data = [
        ['Vendor', 'Mã NV', 'Họ Tên', 'Ngày', 'Lịch Dự Kiến', 'Ghi chú'], // Headers
        ['Vendor B', 'OPS34169', 'Trần Thị B', '01/04/2026', 'S10', 'Ví dụ mẫu'] // Example row
    ];
    const ws = xlsx.utils.aoa_to_sheet(ws_data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Schedule Template");

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Schedule_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Run KPI Engine
app.post('/api/calculate-kpi', (req, res) => {
    let { month, year } = req.body;
    // Auto-detect month from data if not provided or if it doesn't match data
    const dm = getDataMonth();
    if (!month || !year) {
        month = dm.month;
        year = dm.year;
    }

    // Chỉ lấy nhân viên có trong lịch làm việc (nếu có lịch)
    const scheduleOpsIds = new Set();
    if (db.schedule.length > 0) {
        db.schedule.forEach(row => {
            const keys = Object.keys(row);
            const ops_id_key = keys.find(k => k.match(/mã(\s)?(số\s)?(nv|nhân viên|ctv)|id|ops/i));
            if (ops_id_key && row[ops_id_key]) scheduleOpsIds.add(String(row[ops_id_key]).trim().toUpperCase());
        });
    }

    const validEmployees = db.schedule.length > 0
        ? db.employees.filter(e => scheduleOpsIds.has(e.ops_id.toUpperCase()))
        : db.employees;

    db.kpi_results = [];
    validEmployees.forEach(emp => {
        const kpi = calculateKPI(emp.ops_id, month, year);
        db.kpi_results.push(kpi);
    });

    res.json({ message: 'KPI calculation completed', results: db.kpi_results, dataMonth: dm.month, dataYear: dm.year });
});

// Get Dashboard Data
app.get('/api/dashboard', (req, res) => {
    // Chỉ lấy nhân viên có trong lịch làm việc
    const scheduleOpsIds = new Set();
    if (db.schedule.length > 0) {
        db.schedule.forEach(row => {
            const keys = Object.keys(row);
            let ops_id_key = keys.find(k => k.match(/mã(\s)?(số\s)?(nv|nhân viên|ctv)|ops(\s)?id/i));
            if (!ops_id_key) {
                ops_id_key = keys.find(k => String(row[k]).trim().match(/^OPS\d+$/i));
            }
            if (ops_id_key && row[ops_id_key]) scheduleOpsIds.add(String(row[ops_id_key]).trim().toUpperCase());
        });
    }

    const validEmployees = db.schedule.length > 0
        ? db.employees.filter(e => scheduleOpsIds.has(e.ops_id.toUpperCase()))
        : db.employees;

    // Lọc lại KPIs theo những nhân sự hợp lệ này
    const validKPIs = db.kpi_results.filter(k => validEmployees.some(e => e.ops_id === k.ops_id));

    const passCount = validKPIs.filter(r => r.result === 'PASS').length;
    const failCount = validKPIs.filter(r => r.result === 'FAIL').length;

    // Get employees with their kpi results
    const employeesWithKPI = validEmployees.map(emp => {
        const kpi = validKPIs.find(k => k.ops_id === emp.ops_id) || null;
        return { ...emp, kpi };
    });

    // Include data month so frontend can auto-detect
    const dm = getDataMonth();
    res.json({
        stats: { pass: passCount, fail: failCount, total: validEmployees.length },
        employees: employeesWithKPI,
        complaints: db.complaints,
        dataMonth: dm.month,
        dataYear: dm.year
    });
});

// Submit Complaint (Ops)
app.post('/api/complaint', (req, res) => {
    const { employee_id, date, type, reason } = req.body;
    const newComplaint = {
        id: db.complaints.length + 1,
        employee_id,
        date,
        type,
        reason,
        status: 'pending', // pending, approved, rejected
        vendor_note: ''
    };
    db.complaints.push(newComplaint);
    res.json({ message: 'Complaint submitted', complaint: newComplaint });
});

// Delete employee API
app.delete('/api/employees/:ops_id', (req, res) => {
    const { ops_id } = req.params;
    const initialLength = db.employees.length;
    db.employees = db.employees.filter(e => e.ops_id !== ops_id);
    if (db.employees.length < initialLength) {
        res.json({ message: 'Đã xóa nhân sự thành công' });
    } else {
        res.status(404).json({ error: 'Không tìm thấy nhân sự' });
    }
});

// Export Complaints to Excel
app.post('/api/export-complaints', (req, res) => {
    const { opsIds } = req.body;
    if (!opsIds || opsIds.length === 0) {
        return res.status(400).json({ error: 'Không có nhân sự nào được chọn' });
    }

    const data = opsIds.map(id => {
        const emp = db.employees.find(e => e.ops_id === id);
        const kpi = db.kpi_results.find(k => k.ops_id.toUpperCase() === id.toUpperCase());
        return {
            'OPS ID': id,
            'Họ Tên': emp?.name || '',
            'Vendor': emp?.vendor || '',
            'Loại CTV': emp?.loai_ctv || '',
            'Tổng Công': kpi?.total_ngay_cong || 0,
            'Công CP': kpi?.total_ngay_cong_cp || 0,
            'Công Mini': kpi?.total_ngay_cong_mini || 0,
            'Kết Quả': kpi?.result || 'N/A'
        };
    });

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Khiếu Nại');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Danh_Sach_Khieu_Nai.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Upload Leave Request file
app.post('/api/upload-leave', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

        if (rawData.length > 0) {
            db.leaveHeaders = Object.keys(rawData[0]);
            db.leaveRequests = rawData.map(row => {
                const newRow = {};
                for (const key in row) {
                    let val = row[key];
                    if (typeof val === 'number' && val > 40000 && val < 60000) {
                        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                        const dateObj = new Date(excelEpoch.getTime() + val * 86400000);
                        val = dateObj.toISOString().split('T')[0];
                    }
                    newRow[key] = val;
                }
                return newRow;
            });
        }

        // Track upload history
        db.uploadHistory.push({
            id: Date.now(),
            type: 'leave',
            originalName: req.file.originalname || 'Leave',
            filename: req.file.filename,
            month: null,
            year: null,
            recordCount: rawData.length,
            timestamp: new Date().toISOString()
        });

        res.json({ message: 'Upload Xin nghỉ phép thành công!', file: req.file.filename });
    } catch (error) {
        console.error('Lỗi khi đọc file nghỉ phép:', error);
        res.status(500).json({ error: 'Lỗi khi xử lý file Excel' });
    }
});

// Get Leave Requests
app.get('/api/leave', (req, res) => {
    res.json({ headers: db.leaveHeaders, data: db.leaveRequests });
});

// Absence Check - Cross-reference Schedule vs Timesheet (GROUPED by employee)
// Logic: So sánh Lịch làm việc (Schedule) với Chấm công (Attendance) để tìm:
//   1. Ngày được lên lịch làm việc nhưng không có chấm công (vắng mặt)
//   2. Nghỉ ngoài lịch: nhân viên có trong lịch nhưng thiếu ngày chấm công
app.get('/api/absence-check', (req, res) => {
    const dm = getDataMonth();
    const refMonth = dm.month; // 1-indexed
    const refYear = dm.year;

    if (db.attendance.length === 0) {
        return res.json({ records: [], refMonth: null, refYear: null, message: 'Chưa có dữ liệu chấm công để xác định tháng.' });
    }

    // Build a set of worked days per employee from attendance (for the reference month only)
    const workedDays = {}; // { OPS_ID_UPPER: { dayNum: status } }
    const workedDates = {}; // { OPS_ID_UPPER: Set of day numbers }
    db.attendance.forEach(a => {
        if (!a.employee_id) return;
        const key = a.employee_id.toUpperCase();
        const dateObj = new Date(a.date);
        if (isNaN(dateObj.getTime())) return;
        const m = dateObj.getMonth() + 1;
        const y = dateObj.getFullYear();
        if (m !== refMonth || y !== refYear) return; // Only process data for the reference month
        const dayNum = dateObj.getDate();
        if (!workedDays[key]) workedDays[key] = {};
        if (!workedDates[key]) workedDates[key] = new Set();
        workedDays[key][dayNum] = a.status;
        // Only count actual working statuses (not HỦY, N/A)
        if (['S3', 'S10', 'S19', 'WORKING'].includes(a.status)) {
            workedDates[key].add(dayNum);
        }
    });

    // List of known non-day column keywords to exclude from day matching
    const nonDayKeywords = /vendor|mã|ops|id|tên|name|loại|type|ghi chú|note|stt|no\b|rank|công thức|trạng thái|ca làm/i;

    // Temporary map: ops_id_upper -> grouped record
    const grouped = {};

    // ========== APPROACH A: Schedule -> Attendance ==========
    // For each employee in schedule, check each day column
    // If scheduled to work (S3/S10/S19) but no valid attendance -> absence
    db.schedule.forEach(row => {
        const keys = Object.keys(row);
        // OPS ID detection - same logic as timesheet upload
        let ops_id_key = keys.find(k => k.match(/mã(\s)?(số\s)?(nv|nhân viên|ctv)|ops(\s)?id/i));
        // Fallback: scan values for OPS ID pattern
        if (!ops_id_key) {
            ops_id_key = keys.find(k => {
                const val = String(row[k]).trim();
                return val.match(/^OPS\d+$/i);
            });
        }
        const name_key = keys.find(k => k.match(/họ và tên|tên|name/i));
        const ops_id = ops_id_key ? String(row[ops_id_key]).trim() : null;
        const name = name_key ? String(row[name_key]).trim() : '';
        if (!ops_id || ops_id === 'undefined' || ops_id === '') return;

        const opsUpper = ops_id.toUpperCase();
        const empWorked = workedDays[opsUpper] || {};
        const emp = db.employees.find(e => e.ops_id.toUpperCase() === opsUpper);
        const loai_ctv = emp?.loai_ctv || '';

        // Track scheduled work days from this schedule row
        const scheduledWorkDays = new Set();

        keys.forEach(key => {
            // Skip known non-day columns to avoid false matches
            if (nonDayKeywords.test(key)) return;

            // Extract day number from various formats:
            // "Wed 1", "Thu 2", "Mon 13" → number after weekday
            // "1", "13", "31" → pure number
            // "Ngày 5" → number after ngày
            let dayNum = null;

            // Try "Wed 1", "Mon 13" format (weekday + number)
            const weekdayMatch = key.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|T2|T3|T4|T5|T6|T7|CN)\s+(\d{1,2})$/i);
            if (weekdayMatch) {
                dayNum = parseInt(weekdayMatch[1]);
            }

            // Try pure number "1", "13"
            if (dayNum === null) {
                const pureNum = key.trim().match(/^(\d{1,2})$/);
                if (pureNum) dayNum = parseInt(pureNum[1]);
            }

            // Try "Ngày 5" format
            if (dayNum === null) {
                const ngayMatch = key.match(/ngày\s*(\d{1,2})/i);
                if (ngayMatch) dayNum = parseInt(ngayMatch[1]);
            }

            if (dayNum === null || dayNum < 1 || dayNum > 31) return;

            const scheduled = String(row[key]).trim().toUpperCase();
            if (['S3', 'S10', 'S19'].includes(scheduled)) {
                scheduledWorkDays.add(dayNum);
                checkAndAddAbsence(opsUpper, ops_id, name, dayNum, scheduled, empWorked[dayNum]);
            } else if (loai_ctv === 'S-BPO' && (['PH', 'NPL', 'AL', 'OFF'].includes(scheduled) || (empWorked[dayNum] && ['PH', 'NPL', 'AL', 'OFF'].includes(empWorked[dayNum])))) {
                // Also add days that are scheduled as leave or attended as leave
                checkAndAddAbsence(opsUpper, ops_id, name, dayNum, scheduled || empWorked[dayNum], empWorked[dayNum]);
            }
        });

        // ========== APPROACH B: Attendance -> Schedule (nghỉ ngoài lịch) ==========
        // If this employee has attendance data but some scheduled work days have no attendance
        // This catches cases where schedule column detection might miss some days
        if (scheduledWorkDays.size > 0 && workedDates[opsUpper]) {
            const empWorkSet = workedDates[opsUpper];
            scheduledWorkDays.forEach(dayNum => {
                if (!empWorkSet.has(dayNum)) {
                    // Already handled above in approach A - skip duplicates
                    // (the checkAndAddAbsence function handles dedup)
                }
            });
        }

        // Also check: employee is in schedule but has NO attendance at all
        if (!workedDays[opsUpper] && scheduledWorkDays.size > 0) {
            // All scheduled work days are absent - already handled above
        }
    });

    // Helper function to add absence record (with dedup)
    function checkAndAddAbsence(opsUpper, ops_id, name, dayNum, scheduled, workedStatus) {
        const emp = db.employees.find(e => e.ops_id.toUpperCase() === opsUpper);
        const loai_ctv = emp?.loai_ctv || '';

        if (workedStatus && workedStatus !== 'HỦY' && workedStatus !== 'N/A') {
            // Only S-BPO employees get leave statuses tracked in absence check
            if (['PH', 'NPL', 'AL', 'OFF'].includes(workedStatus)) {
                if (loai_ctv !== 'S-BPO') return; // Skip for non-S-BPO
            } else {
                return; // Has valid attendance
            }
        }

        if (!grouped[opsUpper]) {
            const emp = db.employees.find(e => e.ops_id.toUpperCase() === opsUpper);
            grouped[opsUpper] = {
                ops_id: ops_id,
                name: name || emp?.name || '',
                vendor: emp?.vendor || '',
                loai_ctv: emp?.loai_ctv || '',
                days: [],
                day_reasons: {},
                leave_status: 'Không phép',
                note: ''
            };
        }

        // Dedup check
        if (grouped[opsUpper].days.some(d => d.day === dayNum)) return;

        const existing = db.absenceRecords.find(r => r.ops_id.toUpperCase() === opsUpper && r.day === dayNum);
        
        let actualStatus = workedStatus || 'Vắng';
        let autoReason = '';
        if (actualStatus === 'PH' || scheduled === 'PH') autoReason = 'Nghỉ lễ';
        else if (actualStatus === 'AL' || scheduled === 'AL') autoReason = 'Có phép';
        else if (actualStatus === 'NPL' || scheduled === 'NPL') autoReason = 'Không phép';

        if (autoReason) {
            grouped[opsUpper].day_reasons[dayNum] = autoReason;
        }

        grouped[opsUpper].days.push({
            day: dayNum,
            scheduled: scheduled,
            actual: actualStatus
        });
        if (existing) {
            grouped[opsUpper].leave_status = existing.leave_status;
            grouped[opsUpper].note = existing.note || '';
        }
    }

    // ========== APPROACH C: Find employees with attendance but NOT in schedule ==========
    // Check attendance-only employees: those who have attendance records
    // but total worked days is significantly less than expected (e.g., < target_total_cong)
    // This helps detect "nghỉ ngoài lịch" for employees not in schedule
    const daysInMonth = new Date(refYear, refMonth, 0).getDate(); // e.g., 30 for April
    const displayMonth = String(refMonth).padStart(2, '0');
    const displayYear = String(refYear);

    const results = Object.values(grouped).map(g => {
        g.days.sort((a, b) => a.day - b.day);
        const formattedDates = g.days.map(d => `${displayYear},${displayMonth},${String(d.day).padStart(2, '0')}`);
        return {
            ops_id: g.ops_id,
            name: g.name,
            vendor: g.vendor,
            loai_ctv: g.loai_ctv,
            days: g.days,
            day_reasons: g.day_reasons,
            dates_display: formattedDates.join(', '),
            total_absent: g.days.length,
            leave_status: g.leave_status,
            note: g.note
        };
    });

    res.json({ records: results, refMonth: refMonth, refYear: refYear, daysInMonth: daysInMonth });
});

// Export Absence Report to Excel
app.post('/api/export-absence', (req, res) => {
    const { records } = req.body;
    if (!records || records.length === 0) {
        return res.status(400).json({ error: 'Không có dữ liệu để xuất' });
    }

    const data = records.map(r => {
        // Build Vendor phản hồi from per-day reasons + global note
        let feedback = '';
        if (r.day_reasons && Object.keys(r.day_reasons).length > 0) {
            const dayReasonParts = Object.entries(r.day_reasons)
                .filter(([_, reason]) => reason)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([day, reason]) => `Ngày ${day}: ${reason}`);
            if (dayReasonParts.length > 0) {
                feedback = dayReasonParts.join('; ');
            }
        }
        if (r.note) {
            feedback = feedback ? `${feedback}. ${r.note}` : r.note;
        }
        return {
            'Vendor': r.vendor || '',
            'Loại CTV': r.loai_ctv || '',
            'Mã Ops': r.ops_id || '',
            'Tên Nhân viên': r.name || '',
            'Vendor phản hồi': feedback,
            'Ngày OFF cụ thể': r.dates_display || ''
        };
    });

    const ws = xlsx.utils.json_to_sheet(data);
    // Auto-width columns
    const colWidths = [
        { wch: 12 }, // Vendor
        { wch: 12 }, // Loại CTV
        { wch: 14 }, // Mã Ops
        { wch: 25 }, // Tên Nhân viên
        { wch: 60 }, // Vendor phản hồi
        { wch: 80 }, // Ngày OFF cụ thể
    ];
    ws['!cols'] = colWidths;

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Báo Cáo Vắng Mặt');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Bao_Cao_Vang_Mat.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Update absence record - now handles bulk update for grouped records
app.post('/api/absence-update', (req, res) => {
    const { ops_id, days, leave_status, note } = req.body;
    // Support both single day (legacy) and multiple days (grouped)
    const dayList = days || (req.body.day ? [req.body.day] : []);

    dayList.forEach(day => {
        const existing = db.absenceRecords.find(r => r.ops_id.toUpperCase() === ops_id.toUpperCase() && r.day === day);
        if (existing) {
            existing.leave_status = leave_status;
            existing.note = note || '';
        } else {
            db.absenceRecords.push({ ops_id, day, leave_status, note: note || '' });
        }
    });
    res.json({ message: 'Cập nhật thành công' });
});

// Resolve Complaint (Vendor)
app.put('/api/complaint/:id', (req, res) => {
    const { status, vendor_note } = req.body;
    const complaint = db.complaints.find(c => c.id === parseInt(req.params.id));

    if (complaint) {
        complaint.status = status;
        complaint.vendor_note = vendor_note;
        res.json({ message: 'Complaint updated', complaint });
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});


// --- UPLOAD HISTORY & MONTH MANAGEMENT ---

// Get upload history
app.get('/api/history', (req, res) => {
    res.json(db.uploadHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
});

// Delete history entry
app.delete('/api/history/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.uploadHistory = db.uploadHistory.filter(h => h.id !== id);
    res.json({ message: 'Đã xóa' });
});

// Get available months from attendance data
app.get('/api/available-months', (req, res) => {
    const months = {};
    db.attendance.forEach(a => {
        if (!a.date) return;
        const d = new Date(a.date);
        if (isNaN(d.getTime())) return;
        const m = d.getMonth() + 1;
        const y = d.getFullYear();
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if (!months[key]) months[key] = { month: m, year: y, count: 0 };
        months[key].count++;
    });
    const result = Object.values(months).sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        return b.month - a.month;
    });
    res.json(result);
});

// Serve logo from artifacts directory
app.get('/logo.png', (req, res) => {
    const logoPath = 'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\b6dd67b0-072f-4236-85ca-76a7073e9d9e\\hr_logo_1778082874418.png';
    res.sendFile(logoPath, (err) => {
        if (err) {
            // Fallback: serve from public if exists
            const fallback = path.join(__dirname, 'public', 'logo.png');
            res.sendFile(fallback, (err2) => {
                if (err2) res.status(404).send('Logo not found');
            });
        }
    });
});

// --- CHECK REPORT APIs ---

// Get detailed daily timesheet for one employee
app.get('/api/employee-timesheet/:ops_id', (req, res) => {
    const { ops_id } = req.params;
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const opsUpper = ops_id.toUpperCase();

    const records = db.attendance.filter(a => {
        if (!a.employee_id) return false;
        if (a.employee_id.toUpperCase() !== opsUpper) return false;
        const d = new Date(a.date);
        return d.getMonth() + 1 === month && d.getFullYear() === year;
    }).map(a => {
        const d = new Date(a.date);
        const dayNum = d.getDate();
        return {
            day: dayNum,
            date: a.date,
            status: a.status,
            normalizedStatus: a.normalizedStatus,
            working_hours: a.working_hours,
            is_cp: db.config.cpDays.includes(dayNum),
            is_mini: db.config.miniDays.includes(dayNum)
        };
    }).sort((a, b) => a.day - b.day);

    res.json({ records });
});

// Employee notes CRUD
app.get('/api/employee-notes', (req, res) => {
    res.json(db.employeeNotes);
});

app.post('/api/employee-note', (req, res) => {
    const { ops_id, note } = req.body;
    if (!ops_id) return res.status(400).json({ error: 'Missing ops_id' });
    db.employeeNotes[ops_id] = note || '';
    res.json({ message: 'Đã lưu ghi chú!' });
});

// Export Check Report to Excel
app.post('/api/export-check-report', (req, res) => {
    const { opsIds, notes } = req.body;
    if (!opsIds || opsIds.length === 0) {
        return res.status(400).json({ error: 'Không có dữ liệu để xuất' });
    }

    const data = opsIds.map(id => {
        const emp = db.employees.find(e => e.ops_id === id);
        const kpi = db.kpi_results.find(k => k.ops_id.toUpperCase() === id.toUpperCase());
        const note = (notes && notes[id]) || db.employeeNotes[id] || '';
        return {
            'OPS ID': id,
            'Họ Tên': emp?.name || '',
            'Vendor': emp?.vendor || '',
            'Loại CTV': emp?.loai_ctv || '',
            'Tổng Công': kpi?.total_ngay_cong || 0,
            'Công CP': kpi?.total_ngay_cong_cp || 0,
            'Công Mini': kpi?.total_ngay_cong_mini || 0,
            'Vi Phạm': kpi?.vi_pham || 0,
            'Nghỉ KP': kpi?.no_permission_leave || 0,
            'Kết Quả': kpi?.result || 'N/A',
            'Ghi Chú': note
        };
    });

    const ws = xlsx.utils.json_to_sheet(data);
    ws['!cols'] = [
        { wch: 12 }, { wch: 25 }, { wch: 12 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 40 }
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Check Lịch & Báo Cáo');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Check_Lich_Bao_Cao.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`KPI System backend running at http://localhost:${PORT}`);
    console.log(`Lưu ý: Để truy cập từ máy khác trong cùng mạng LAN/WiFi, hãy tìm địa chỉ IPv4 của máy này (vd: 192.168.1.x) và truy cập http://192.168.1.x:${PORT}`);
});
