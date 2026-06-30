// 빌드 후 exe에 아이콘 심기 (Windows 전용; winCodeSign 없이 rcedit로 처리)
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') process.exit(0);

const exe = path.join(__dirname, 'dist', 'win-unpacked', 'Dot.exe');
const ico = path.join(__dirname, 'icon.ico');
if (!fs.existsSync(exe) || !fs.existsSync(ico)) {
  console.log('seticon: exe 또는 icon.ico 없음 — 건너뜀');
  process.exit(0);
}
const mod = require('rcedit');
const rcedit = typeof mod === 'function' ? mod : (mod.rcedit || mod.default);
rcedit(exe, { icon: ico })
  .then(() => console.log('seticon: 아이콘 적용 완료'))
  .catch((e) => { console.error('seticon 실패:', e.message); process.exit(1); });
