const { createApp } = Vue;

// Cấu hình Axios để luôn gọi tới Backend đang chạy ở port 3000
// Điều này giúp tránh lỗi khi bạn mở file HTML bằng Live Server (port 5500)
axios.defaults.baseURL = 'http://localhost:3000';

createApp({
    data() {
        return {
            currentTab: 'home',
            currentMonth: new Date().getMonth() + 1,
            currentYear: new Date().getFullYear(),
            dashboardData: {
                stats: { pass: 0, fail: 0, total: 0 },
                employees: [],
                complaints: []
            },
            scheduleData: {
                headers: [],
                data: []
            },
            timesheetData: {
                headers: [],
                data: []
            },
            leaveData: {
                headers: [],
                data: []
            },
            absenceData: [],
            absenceRefMonth: null,
            absenceRefYear: null,
            absenceDaysInMonth: 31,
            selectedAbsenceIdx: null,
            showAbsenceCalendar: false,
            selectedCalDay: null,
            showComplaintModal: false,
            selectedEmp: null,
            complaintForm: {
                date: '',
                type: 'NPL',
                reason: ''
            },
            searchQuery: '',
            filterType: '',
            filterResult: '',
            selectedEmployees: [],
            uploadHistory: [],
            availableMonths: [],
            _monthAutoDetected: false,
            systemConfig: {
                target_total_cong: 26,
                target_mini: 6,
                target_cp: 5,
                cpDays: [4, 5, 6, 7, 8],
                miniDays: [1, 2, 15, 16, 25, 26]
            },
            scheduleSearchQuery: '',
            scheduleFilterVendor: '',
            // Check Report tab
            crShowUpload: false,
            crShowKpiConfig: false,
            crSearch: '',
            crVendorFilter: '',
            crSelectedEmpId: null,
            crEmpTimesheet: [],
            crEmpNotes: {},
            crIsUploading: false,
            crUploadStatus: ''
        }
    },
    computed: {
        pendingComplaints() {
            return this.dashboardData.complaints.filter(c => c.status === 'pending').map(c => ({...c, tempNote: ''}));
        },
        uniqueTypes() {
            const types = this.dashboardData.employees.map(e => e.loai_ctv || 'BPO');
            return [...new Set(types)].filter(Boolean);
        },
        allMonths() {
            const year = this.currentYear || new Date().getFullYear();
            const months = [];
            for (let m = 1; m <= 12; m++) {
                const found = this.availableMonths.find(a => a.month === m && a.year === year);
                months.push({
                    month: m,
                    year: year,
                    count: found ? found.count : 0,
                    label: `Tháng ${m}/${year}${found ? ` (${found.count} bản ghi)` : ''}`
                });
            }
            return months;
        },
        filteredEmployees() {
            let emps = this.dashboardData.employees;
            if (this.searchQuery) {
                const q = this.searchQuery.toLowerCase();
                emps = emps.filter(e => e.name.toLowerCase().includes(q) || e.ops_id.toLowerCase().includes(q));
            }
            if (this.filterType) {
                emps = emps.filter(e => (e.loai_ctv || 'BPO') === this.filterType);
            }
            if (this.filterResult) {
                emps = emps.filter(e => e.kpi?.result === this.filterResult);
            }
            return emps;
        },
        uniqueScheduleVendors() {
            if (!this.scheduleData.data) return [];
            const vendors = this.scheduleData.data.map(row => row['Công thức Vendor'] || row['Vendor'] || '');
            return [...new Set(vendors)].filter(Boolean);
        },
        filteredSchedule() {
            let data = this.scheduleData.data || [];
            if (this.scheduleSearchQuery) {
                const q = this.scheduleSearchQuery.toLowerCase();
                data = data.filter(row => {
                    const name = (row['Công thức Họ và tên'] || row['Họ và tên'] || '').toLowerCase();
                    const id = (row['Mã số nhân viên'] || row['Mã nhân viên'] || '').toLowerCase();
                    return name.includes(q) || id.includes(q);
                });
            }
            if (this.scheduleFilterVendor) {
                data = data.filter(row => {
                    const vendor = row['Công thức Vendor'] || row['Vendor'] || '';
                    return vendor === this.scheduleFilterVendor;
                });
            }
            return data.map(row => {
                let work = 0;
                let off = 0;
                let workDaysList = [];
                let offDaysList = [];
                if (this.scheduleData.headers) {
                    this.scheduleData.headers.forEach(h => {
                        // Assuming day columns are short strings like "Wed 1", "Thu 2" and not one of the standard headers
                        if (h !== '__EMPTY' && !h.includes('Công thức') && !h.includes('Mã số') && !h.includes('Vendor')) {
                            const val = (row[h] || '').toString().toUpperCase().trim();
                            
                            // Extract day number from header, e.g. "Wed 1" -> "1"
                            const dayMatch = h.match(/\d+/);
                            const dayStr = dayMatch ? dayMatch[0] : h;

                            if (val === 'OFF') {
                                off++;
                                offDaysList.push(dayStr);
                            } else if (val !== '' && !['AL', 'SL', 'U', 'N'].includes(val)) {
                                work++;
                                workDaysList.push({ day: dayStr, shift: val });
                            }
                        }
                    });
                }
                return { ...row, _totalWork: work, _totalOff: off, _workDaysList: workDaysList, _offDaysList: offDaysList };
            });
        },
        // Check Report computed
        crFilteredEmployees() {
            let emps = this.dashboardData.employees;
            if (this.crSearch) {
                const q = this.crSearch.toLowerCase();
                emps = emps.filter(e => e.name.toLowerCase().includes(q) || e.ops_id.toLowerCase().includes(q));
            }
            if (this.crVendorFilter) {
                emps = emps.filter(e => e.vendor === this.crVendorFilter);
            }
            return emps;
        },
        crSelectedEmp() {
            if (!this.crSelectedEmpId) return null;
            return this.dashboardData.employees.find(e => e.ops_id === this.crSelectedEmpId) || null;
        },
        crUniqueVendors() {
            const vendors = this.dashboardData.employees.map(e => e.vendor);
            return [...new Set(vendors)].filter(Boolean);
        },
        crWorkDays() {
            return this.crEmpTimesheet.filter(r => ['S3','S10','S19','WORKING'].includes(r.status));
        },
        crOffDays() {
            if (!this.crSelectedEmp) return [];
            const daysInMonth = new Date(this.currentYear, this.currentMonth, 0).getDate();
            const workedDays = new Set(this.crWorkDays.map(r => r.day));
            const offDays = [];
            for (let d = 1; d <= daysInMonth; d++) {
                if (!workedDays.has(d)) {
                    offDays.push({ day: d, is_cp: this.systemConfig.cpDays.includes(d), is_mini: this.systemConfig.miniDays.includes(d) });
                }
            }
            return offDays;
        },
        crKpiProgress() {
            const kpi = this.crSelectedEmp?.kpi;
            if (!kpi) return null;
            const cfg = this.systemConfig;
            return {
                total: { current: kpi.total_ngay_cong, target: cfg.target_total_cong, pct: Math.min(100, Math.round((kpi.total_ngay_cong / cfg.target_total_cong) * 100)) },
                cp: { current: kpi.total_ngay_cong_cp, target: cfg.target_cp, pct: Math.min(100, Math.round((kpi.total_ngay_cong_cp / cfg.target_cp) * 100)) },
                mini: { current: kpi.total_ngay_cong_mini, target: cfg.target_mini, pct: Math.min(100, Math.round((kpi.total_ngay_cong_mini / cfg.target_mini) * 100)) },
                vipham: kpi.vi_pham,
                nghikp: kpi.no_permission_leave
            };
        }
    },
    methods: {
        getTabTitle() {
            const titles = {
                'home': 'Trang Chủ',
                'dashboard': 'Tổng Quan KPI',
                'employees': 'Chi Tiết Nhân Sự',
                'complaints': 'Hệ Thống Khiếu Nại',
                'vendor': 'Vendor Duyệt Yêu Cầu',
                'import': 'Nhập Liệu & Tự Động Hóa',
                'checkReport': 'Check Lịch & Báo Cáo'
            };
            return titles[this.currentTab];
        },
        async fetchDashboardData() {
            try {
                const res = await axios.get('/api/dashboard');
                this.dashboardData = res.data;
                // Auto-detect month from data (only on first load)
                if (!this._monthAutoDetected && res.data.dataMonth && res.data.dataYear) {
                    this.currentMonth = res.data.dataMonth;
                    this.currentYear = res.data.dataYear;
                }
                const configRes = await axios.get('/api/config');
                // Ensure arrays exist
                this.systemConfig = {
                    ...configRes.data,
                    cpDays: configRes.data.cpDays || [4, 5, 6, 7, 8],
                    miniDays: configRes.data.miniDays || [1, 2, 15, 16, 25, 26]
                };
            } catch (error) {
                console.error("Error fetching data:", error);
            }
        },
        async fetchScheduleData() {
            try {
                const res = await axios.get('/api/schedule');
                this.scheduleData = res.data;
            } catch (error) {
                console.error("Error fetching schedule data:", error);
            }
        },
        async fetchTimesheetData() {
            try {
                const res = await axios.get('/api/timesheet');
                this.timesheetData = res.data;
            } catch (error) {
                console.error("Error fetching timesheet data:", error);
            }
        },
        toggleDay(type, day) {
            const index = this.systemConfig[type].indexOf(day);
            if (index === -1) {
                this.systemConfig[type].push(day);
            } else {
                this.systemConfig[type].splice(index, 1);
            }
        },
        async updateSystemConfig() {
            try {
                await axios.post('/api/config', this.systemConfig);
                alert('Đã cập nhật điều kiện KPI và hệ thống đang tính toán lại!');
                await this.fetchDashboardData();
            } catch (error) {
                alert('Lỗi khi cập nhật cấu hình!');
            }
        },
        async runKPIEngine(silent = false) {
            try {
                await axios.post('/api/calculate-kpi', { month: this.currentMonth, year: this.currentYear });
                if (!silent) alert('KPI Engine đã chạy xong!');
                await this.fetchDashboardData();
            } catch (error) {
                if (!silent) alert('Lỗi khi chạy KPI Engine');
            }
        },
        async changeMonth(month, year) {
            this.currentMonth = parseInt(month);
            this.currentYear = parseInt(year);
            try {
                await axios.post('/api/calculate-kpi', { month: this.currentMonth, year: this.currentYear });
                await this.fetchDashboardData();
                await this.fetchAbsenceData();
            } catch (error) {
                console.error('Error changing month:', error);
            }
        },
        async fetchHistory() {
            try {
                const res = await axios.get('/api/history');
                this.uploadHistory = res.data;
            } catch (e) { console.error(e); }
        },
        async fetchAvailableMonths() {
            try {
                const res = await axios.get('/api/available-months');
                this.availableMonths = res.data;
            } catch (e) { console.error(e); }
        },
        async deleteHistory(id) {
            if (!confirm('Xóa bản ghi này khỏi lịch sử?')) return;
            try {
                await axios.delete(`/api/history/${id}`);
                await this.fetchHistory();
            } catch (e) { console.error(e); }
        },
        formatHistoryType(type) {
            const map = { timesheet: 'Chấm Công', schedule: 'Lịch LV', leave: 'Nghỉ Phép' };
            return map[type] || type;
        },
        formatDate(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
        },
        selectAllEmployees(event) {
            if (event.target.checked) {
                this.selectedEmployees = this.filteredEmployees.map(e => e.ops_id);
            } else {
                this.selectedEmployees = [];
            }
        },
        async exportComplaints() {
            if (this.selectedEmployees.length === 0) {
                alert('Vui lòng chọn ít nhất 1 nhân sự để xuất file!');
                return;
            }
            try {
                const response = await axios.post('/api/export-complaints', { opsIds: this.selectedEmployees }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', 'Danh_Sach_Khieu_Nai.xlsx');
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch (err) {
                alert('Lỗi khi xuất file khiếu nại!');
                console.error(err);
            }
        },
        openComplaintForm(emp) {
            this.selectedEmp = emp;
            this.complaintForm = {
                date: '',
                type: 'NPL',
                reason: ''
            };
            this.showComplaintModal = true;
        },
        async deleteEmployee(ops_id) {
            if (!confirm('Bạn có chắc chắn muốn xóa nhân sự ' + ops_id + ' không? Thao tác này không thể hoàn tác.')) return;
            try {
                await axios.delete(`/api/employees/${ops_id}`);
                alert('Đã xóa nhân sự thành công!');
                this.fetchDashboardData();
            } catch (err) {
                alert('Lỗi khi xóa nhân sự');
            }
        },
        async submitComplaint() {
            if(!this.complaintForm.date || !this.complaintForm.reason) {
                alert('Vui lòng nhập đủ ngày và lý do!');
                return;
            }
            try {
                await axios.post('/api/complaint', {
                    employee_id: this.selectedEmp.ops_id,
                    date: this.complaintForm.date,
                    type: this.complaintForm.type,
                    reason: this.complaintForm.reason
                });
                alert('Gửi khiếu nại thành công!');
                this.showComplaintModal = false;
                await this.fetchDashboardData();
            } catch (error) {
                alert('Lỗi khi gửi khiếu nại');
            }
        },
        async resolveComplaint(id, status, note) {
            if (!note && status === 'rejected') {
                alert('Vui lòng nhập ghi chú khi từ chối!');
                return;
            }
            try {
                await axios.put(`/api/complaint/${id}`, {
                    status: status,
                    vendor_note: note || ''
                });
                alert(`Đã ${status === 'approved' ? 'duyệt' : 'từ chối'} khiếu nại! Hệ thống sẽ tự động tính lại KPI trong kỳ tính toán tiếp theo.`);
                
                // Refresh data
                await this.fetchDashboardData();
                // Optionally run KPI engine again to reflect changes
                await this.runKPIEngine();

            } catch (error) {
                alert('Lỗi xử lý khiếu nại');
            }
        },
        async uploadTimesheet(event) {
            const file = event.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await axios.post('/api/upload-timesheet', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                alert(res.data.message);
                event.target.value = '';
                await this.fetchTimesheetData();
                await this.fetchHistory();
                await this.fetchAvailableMonths();
                // Auto-set month from uploaded data
                if (res.data.dataMonth && res.data.dataYear) {
                    this.currentMonth = res.data.dataMonth;
                    this.currentYear = res.data.dataYear;
                }
                this.currentTab = 'timesheet';
            } catch (error) {
                console.error(error);
                alert('Lỗi khi upload Timesheet');
            }
        },
        async uploadSchedule(event) {
            const file = event.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await axios.post('/api/upload-schedule', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                alert(res.data.message);
                event.target.value = '';
                await this.fetchScheduleData();
                await this.fetchHistory();
                this.currentTab = 'schedule';
            } catch (error) {
                console.error(error);
                alert('Lỗi khi upload Lịch làm việc');
            }
        },
        async uploadTemplate(type, event) {
            const file = event.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await axios.post(`/api/upload-template/${type}`, formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                alert(res.data.message);
            } catch (error) {
                console.error(error);
                alert('Lỗi khi cập nhật file mẫu!');
            }
            event.target.value = ''; // reset input
        },
        async uploadLeave(event) {
            const file = event.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await axios.post('/api/upload-leave', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                alert(res.data.message);
                event.target.value = '';
                await this.fetchLeaveData();
                await this.fetchHistory();
                this.currentTab = 'leave';
            } catch (error) {
                console.error(error);
                alert('Lỗi khi upload file nghỉ phép');
            }
        },
        async fetchLeaveData() {
            try {
                const res = await axios.get('/api/leave');
                this.leaveData = res.data;
            } catch (error) {
                console.error('Error fetching leave data:', error);
            }
        },
        async fetchAbsenceData() {
            try {
                const res = await axios.get('/api/absence-check');
                const data = res.data;
                // Server now returns { records, refMonth, refYear, daysInMonth }
                const records = data.records || data; // backward compat
                this.absenceRefMonth = data.refMonth || null;
                this.absenceRefYear = data.refYear || null;
                this.absenceDaysInMonth = data.daysInMonth || 31;
                this.absenceData = (Array.isArray(records) ? records : []).map(r => ({
                    ...r,
                    day_reasons: r.day_reasons || {}
                }));
                this.selectedCalDay = null;
                // Auto-detect currentMonth from attendance data (only on first load)
                if (!this._monthAutoDetected && this.absenceRefMonth) {
                    this.currentMonth = this.absenceRefMonth;
                    this.currentYear = this.absenceRefYear;
                }
            } catch (error) {
                console.error('Error fetching absence data:', error);
            }
        },
        async updateAbsence(record) {
            try {
                // Send all day numbers from the grouped record
                const dayNums = record.days.map(d => d.day);
                await axios.post('/api/absence-update', {
                    ops_id: record.ops_id,
                    days: dayNums,
                    leave_status: record.leave_status,
                    note: record.note
                });
                alert('Cập nhật thành công!');
            } catch (error) {
                alert('Lỗi khi cập nhật!');
            }
        },
        async exportAbsence() {
            if (this.absenceData.length === 0) {
                alert('Không có dữ liệu ngày nghỉ để xuất!');
                return;
            }
            try {
                const response = await axios.post('/api/export-absence', {
                    records: this.absenceData
                }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', 'Bao_Cao_Ngay_Nghi.xlsx');
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch (err) {
                alert('Lỗi khi xuất file báo cáo ngày nghỉ!');
                console.error(err);
            }
        },
        startAbsenceResize(e) {
            e.preventDefault();
            const split = document.getElementById('absenceSplit');
            const left = document.getElementById('absenceLeft');
            if (!split || !left) return;
            const startX = e.clientX;
            const startW = left.offsetWidth;
            const onMove = (ev) => {
                const diff = ev.clientX - startX;
                const newW = Math.max(220, Math.min(startW + diff, split.offsetWidth - 308));
                left.style.width = newW + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },
        isAbsenceDay(dayNum) {
            if (this.selectedAbsenceIdx === null) return false;
            const record = this.absenceData[this.selectedAbsenceIdx];
            if (!record || !record.days) return false;
            return record.days.some(d => d.day === dayNum);
        },
        getDayReason(dayNum) {
            if (this.selectedAbsenceIdx === null) return '';
            const record = this.absenceData[this.selectedAbsenceIdx];
            if (!record || !record.day_reasons) return '';
            return record.day_reasons[dayNum] || '';
        },
        selectCalDay(dayNum) {
            if (this.selectedAbsenceIdx === null) return;
            const record = this.absenceData[this.selectedAbsenceIdx];
            if (!record) return;
            const isOff = record.days.some(d => d.day === dayNum);
            if (isOff) {
                // Day is already in the OFF list, just select it
                this.selectedCalDay = dayNum;
            } else {
                // Day is NOT in OFF list, ask to add
                if (confirm(`Ngày ${dayNum} chưa có trong danh sách OFF. Bạn có muốn thêm ngày này?`)) {
                    record.days.push({ day: dayNum, scheduled: 'ADDED', actual: 'Vắng' });
                    record.days.sort((a, b) => a.day - b.day);
                    record.total_absent = record.days.length;
                    if (!record.day_reasons) record.day_reasons = {};
                    record.day_reasons[dayNum] = '';
                    this.rebuildDatesDisplay(record);
                    this.selectedCalDay = dayNum;
                }
            }
        },
        setDayReason(reason) {
            if (this.selectedAbsenceIdx === null || this.selectedCalDay === null) return;
            const record = this.absenceData[this.selectedAbsenceIdx];
            if (!record) return;
            if (!record.day_reasons) record.day_reasons = {};
            record.day_reasons[this.selectedCalDay] = reason;
        },
        removeDayFromList(dayNum) {
            if (this.selectedAbsenceIdx === null) return;
            const record = this.absenceData[this.selectedAbsenceIdx];
            if (!record) return;
            if (!confirm(`Bạn có chắc muốn XÓA ngày ${dayNum} khỏi danh sách OFF?`)) return;
            const idx = record.days.findIndex(d => d.day === dayNum);
            if (idx >= 0) {
                record.days.splice(idx, 1);
                record.total_absent = record.days.length;
                if (record.day_reasons) delete record.day_reasons[dayNum];
                this.rebuildDatesDisplay(record);
                this.selectedCalDay = null;
            }
        },
        rebuildDatesDisplay(record) {
            // Use the reference month/year from server data, not current date
            let year = this.absenceRefYear || new Date().getFullYear();
            let month = String(this.absenceRefMonth || (new Date().getMonth() + 1)).padStart(2, '0');
            // If we have existing dates_display, parse from that as fallback
            if (!this.absenceRefMonth && record.dates_display && record.dates_display.length > 4) {
                const parts = record.dates_display.split(',');
                if (parts.length >= 2) {
                    year = parts[0].trim();
                    month = parts[1].trim();
                }
            }
            record.dates_display = record.days.map(d =>
                `${year},${month},${String(d.day).padStart(2, '0')}`
            ).join(', ');
        },
        // --- CHECK REPORT METHODS ---
        async selectCrEmployee(ops_id) {
            this.crSelectedEmpId = ops_id;
            // Ensure notes key exists for reactivity
            if (!(ops_id in this.crEmpNotes)) {
                this.crEmpNotes[ops_id] = '';
            }
            try {
                const res = await axios.get(`/api/employee-timesheet/${ops_id}`, {
                    params: { month: this.currentMonth, year: this.currentYear }
                });
                this.crEmpTimesheet = res.data.records || [];
            } catch (e) { console.error(e); }
        },
        async uploadCrTimesheet(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.crIsUploading = true;
            this.crUploadStatus = 'Đang tải file lên...';
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await axios.post('/api/upload-timesheet', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                
                if (res.data.dataMonth && res.data.dataYear) {
                    this.currentMonth = res.data.dataMonth;
                    this.currentYear = res.data.dataYear;
                }
                
                this.crUploadStatus = 'Đang tự động chạy KPI Engine...';
                await this.runKPIEngine(true);
                
                this.crUploadStatus = 'Đang làm mới dữ liệu...';
                await Promise.all([
                    this.fetchTimesheetData(),
                    this.fetchDashboardData(),
                    this.fetchHistory(),
                    this.fetchAvailableMonths()
                ]);
                if (this.crSelectedEmpId) {
                    await this.selectCrEmployee(this.crSelectedEmpId);
                }
                
                this.crIsUploading = false;
                this.crUploadStatus = '';
                event.target.value = '';
                alert('Tải lên và tính toán KPI thành công!');
            } catch (error) {
                this.crIsUploading = false;
                this.crUploadStatus = '';
                event.target.value = '';
                alert('Lỗi khi upload Timesheet');
            }
        },
        async saveCrNote(ops_id) {
            try {
                await axios.post('/api/employee-note', {
                    ops_id,
                    note: this.crEmpNotes[ops_id] || ''
                });
                alert('Đã lưu ghi chú!');
            } catch (e) { alert('Lỗi khi lưu ghi chú!'); }
        },
        async fetchCrNotes() {
            try {
                const res = await axios.get('/api/employee-notes');
                this.crEmpNotes = res.data || {};
            } catch (e) { console.error(e); }
        },
        async exportCheckReport() {
            const opsIds = this.crFilteredEmployees.map(e => e.ops_id);
            if (opsIds.length === 0) { alert('Không có dữ liệu!'); return; }
            try {
                const response = await axios.post('/api/export-check-report', {
                    opsIds, notes: this.crEmpNotes
                }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', `Check_Lich_T${this.currentMonth}_${this.currentYear}.xlsx`);
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch (err) { alert('Lỗi khi xuất báo cáo!'); }
        }
    },
    async mounted() {
        await Promise.all([
            this.fetchScheduleData(),
            this.fetchTimesheetData(),
            this.fetchLeaveData(),
            this.fetchAbsenceData(),
            this.fetchHistory(),
            this.fetchAvailableMonths(),
            this.fetchCrNotes()
        ]);
        if (this.currentMonth && this.currentYear) {
            try {
                await axios.post('/api/calculate-kpi', { month: this.currentMonth, year: this.currentYear });
            } catch (e) {
                console.error('Auto KPI run failed:', e);
            }
        }
        await this.fetchDashboardData();
        this._monthAutoDetected = true;
    }
}).mount('#app');
