const fs = require('fs');
const src = 'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\b6dd67b0-072f-4236-85ca-76a7073e9d9e\\hr_logo_1778082874418.png';
const dest = 'C:\\Users\\ASUS\\.gemini\\antigravity\\scratch\\kpi-system\\public\\logo.png';
fs.copyFile(src, dest, (err) => {
    if (err) {
        console.error('Error copying logo:', err);
        process.exit(1);
    }
    console.log('Logo copied successfully to public/logo.png');
});
