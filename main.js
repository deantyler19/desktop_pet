const { app, BrowserWindow, ipcMain, screen, Menu, Tray, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Dot');

// 모든 앱 데이터(설정 + 내부 캐시)를 앱 폴더 안 userdata/ 에 보관 — 개발: 프로젝트, 패키징: exe 옆
try {
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  app.setPath('userData', path.join(base, 'userdata'));
} catch {}

const IS_WIN = process.platform === 'win32';

// 어떤 예외에도 펫이 죽지 않도록 (윈도우 잠금/해제 등 상황 안전망)
process.on('uncaughtException', (e) => { try { console.error('uncaught:', e && e.message); } catch {} });
process.on('unhandledRejection', () => {});

const WIN_W = 190;         // 창 폭(펫 120 + 오른쪽 말풍선 공간 70)
const WIN_H = 150;         // 펫은 아래 100px(좌측), 위쪽은 말풍선 공간
const PET_W = 120;         // 펫 그림 실제 폭 (창 왼쪽에 그림)
const FEET = 6;            // 창 바닥~발끝 보정
const G = 1.2;             // 중력
const WALK = 1.9;          // 걷기 속도
const CLIMB = 2.4;         // 벽 오르기 속도
const JUMP = 13;           // 점프 초기 속도
const TOL = 4;             // 착지 허용 오차

// 자동 실행: 패키징본은 설치된 exe 자체를, 개발 실행은 electron.exe + 앱폴더
const loginOpts = (IS_WIN && !app.isPackaged) ? { path: process.execPath, args: [path.resolve(__dirname)] } : {};

// 설정 파일은 userData(=앱 폴더 안 userdata/, 위에서 지정)에 저장 — 모든 데이터를 한 곳에 모음
let SKIN_FILE, INIT_FLAG;
function initPaths() {
  const d = app.getPath('userData');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}

  // 이전 저장 위치(%APPDATA%\Dot, 더 옛 ClaudePet)에서 1회 이전 (스킨/성격/알람 보존)
  try {
    if (!fs.existsSync(path.join(d, 'skin.txt'))) {
      const roam = app.getPath('appData');   // %APPDATA% (Roaming) — userData 변경과 무관
      for (const old of [path.join(roam, 'Dot'), path.join(roam, 'ClaudePet')]) {
        if (old === d || !fs.existsSync(old)) continue;
        for (const f of ['skin.txt', 'persona.txt', 'alarm.json', 'autostart-init']) {
          const src = path.join(old, f), dst = path.join(d, f);
          if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
        }
      }
    }
  } catch {}
  SKIN_FILE = path.join(d, 'skin.txt');
  INIT_FLAG = path.join(d, 'autostart-init');
  PERSONA_FILE = path.join(d, 'persona.txt');
  try { if (fs.existsSync(SKIN_FILE)) skin = fs.readFileSync(SKIN_FILE, 'utf8').trim() || 'claude'; } catch {}
  if (!SKIN_LABEL[skin]) skin = 'claude';   // 제거된 옛 스킨이면 기본으로
  try { if (fs.existsSync(PERSONA_FILE)) persona = fs.readFileSync(PERSONA_FILE, 'utf8').trim() || 'default'; } catch {}
  if (!PERSONA[persona]) persona = 'default';   // 옛 성격값이면 기본으로
  ALARM_FILE = path.join(d, 'alarm.json');
  try {
    if (fs.existsSync(ALARM_FILE))
      alarms = migrateAlarms(JSON.parse(fs.readFileSync(ALARM_FILE, 'utf8').replace(/^﻿/, '')));
  } catch {}
}

// 옛 단일 알람({time,text}) → 새 배열 형식으로, 또는 배열 정규화
function migrateAlarms(raw) {
  const norm = (a) => ({
    time: String(a.time),
    text: (a.text || '').slice(0, 30),
    repeat: a.repeat !== false,        // 기본: 매일 반복
    enabled: a.enabled !== false,
    lastFired: a.lastFired || '',
  });
  if (Array.isArray(raw)) return raw.filter(a => a && a.time).slice(0, 20).map(norm);
  if (raw && raw.time) return [norm({ ...raw, repeat: true })];   // 옛 알람은 매일 반복이었음
  return [];
}

const SKIN_LIST = [
  { id: 'claude', label: '클로드 (기본)' },
  { id: 'cat', label: '고양이' },
  { id: 'dog', label: '강아지' },
  { id: 'rabbit', label: '토끼' },
  { id: 'hamster', label: '햄스터' },
  { id: 'penguin', label: '펭귄' },
  { id: 'panda', label: '판다' },
  { id: 'bear', label: '곰' },
  { id: 'fox', label: '여우' },
  { id: 'chick', label: '병아리' },
  { id: 'capybara', label: '카피바라' },
  { id: 'duck', label: '오리' },
  { id: 'frog', label: '개구리' },
  { id: 'ghost', label: '유령' },
];
const SKIN_LABEL = Object.fromEntries(SKIN_LIST.map(s => [s.id, s.label]));
let skin = 'claude';

function setSkin(id) {
  skin = id;
  try { fs.writeFileSync(SKIN_FILE, id); } catch {}
  if (win && !win.isDestroyed()) win.webContents.send('set-skin', id);
  refreshTray();
}

// ── 성격(말투) ───────────────────────────────────
const PERSONA_LABEL = {
  default: '기본',
  INTJ: 'INTJ 전략가', INTP: 'INTP 논리술사', ENTJ: 'ENTJ 통솔자', ENTP: 'ENTP 변론가',
  INFJ: 'INFJ 옹호자', INFP: 'INFP 중재자', ENFJ: 'ENFJ 선도자', ENFP: 'ENFP 활동가',
  ISTJ: 'ISTJ 현실주의', ISFJ: 'ISFJ 수호자', ESTJ: 'ESTJ 경영자', ESFJ: 'ESFJ 집정관',
  ISTP: 'ISTP 장인', ISFP: 'ISFP 모험가', ESTP: 'ESTP 사업가', ESFP: 'ESFP 연예인',
};
const PERSONA_GROUPS = [
  { label: '기본', ids: ['default'] },
  { label: '분석가 (NT)', ids: ['INTJ', 'INTP', 'ENTJ', 'ENTP'] },
  { label: '외교관 (NF)', ids: ['INFJ', 'INFP', 'ENFJ', 'ENFP'] },
  { label: '관리자 (SJ)', ids: ['ISTJ', 'ISFJ', 'ESTJ', 'ESFJ'] },
  { label: '탐험가 (SP)', ids: ['ISTP', 'ISFP', 'ESTP', 'ESFP'] },
];
let persona = 'default';
let PERSONA_FILE;
const PERSONA = {
  default: {
    greet: ['안녕! 놀러 왔어 🧡', '반가워요~', '왔구나! 기다렸어 ☺️', '오늘도 만나서 반가워!', '짠! 나타났지 ✨', '히히 안녕안녕~'],
    idle: ['음~', '코딩 중?', '심심해~', '뭐하지?', '오늘도 화이팅', '룰루~',
      '오늘 뭐 했어?', '같이 쉬자', '커밋했어?', '물 한 잔 마셔요 💧', '잠깐 스트레칭~',
      '좋은 하루 보내 🧡', '히힛', '뭔가 재밌는 일 없나', '집중 잘 되네!', '심심하면 날 불러',
      '딴짓하고 싶다 ㅎㅎ', '눈 좀 깜빡여요 👀', '어깨 펴고 앉아요!', '잠깐 창밖 한 번 봐요 🌤️',
      '나 여기 있어~', '오늘 날씨 어때?', '커피 한 잔 어때요 ☕', '저장은 자주 해요 💾',
      '버그는 친구라구... 아닌가?', '잘 되고 있어, 믿어!', '딩가딩가~', '오 뭔가 잘 풀리는 느낌!',
      '심심하면 쓰담쓰담 해줘', '같이 놀까?', '오늘 점심 뭐 먹었어?', '슬슬 한 숨 돌려요~',
      '나 따라 산책 갈래?', '음음, 좋은 흐름이야', '쉬엄쉬엄 해요 🍃', '폴짝!', '두근두근 뭐 재밌는 거 없나',
      '키보드 소리 좋다 ⌨️', '오늘 할 일 다 했어?', '잠깐 멍 때려도 괜찮아', '나랑 수다 떨자~'],
    pet: ['헤헤 좋아', '쓰담쓰담 ☺️', '또 또!', '좋아 좋아~', '간지러워 ㅎㅎ', '기분 최고야', '한 번 더!', '에헤헤',
      '아 행복해 🥰', '더 해줘 더!', '이 맛에 산다니까~', '손길이 따뜻해', '꺄 좋아!', '녹는다 녹아~', '최고야 정말!'],
    happy: ['기분 좋아요 ☺️', '헤헤', '오늘 운수 좋다!', '신난다 🎵', '룰루랄라~',
      '꺄 신나 🎉', '오늘 완전 럭키데이!', '기분이 둥실둥실~', '히히 좋은 일 생길 것 같아', '날아갈 것 같아 ✨'],
    hungry: ['배고파요 🍖', '밥 주세요~', '꼬르륵...', '간식 없나요?', '뭐 좀 먹고 싶다', '배꼽시계 울려요',
      '간식 타임 아니에요? 🍪', '뭐 맛있는 거 없나~', '배에서 노래해요 🎵', '한 입만...'],
    sleepy: ['졸려요 💤', '하암~', '쉬고 싶어요', '눈이 스르르...', '잠깐 낮잠 잘까',
      '꾸벅꾸벅...', '이불 속이 그리워 🛏️', '5분만 더...', '눈꺼풀이 천근만근', '하아암~ 졸리당'],
    morning: ['좋은 아침! ☀️', '잘 잤어요?', '상쾌한 아침이에요!', '오늘도 좋은 하루 보내요 🌅', '굿모닝! 기지개 켜요~'],
    night: ['늦었어요~ 졸려요 💤', '오늘도 수고했어요 🌙', '이제 잘 시간이에요', '푹 자고 내일 또 만나요 ⭐', '하루 마무리 잘 했어요?'],
    grab: ['우와 들렸다!', '어디 가요?', '붕 떴어 ㅎㅎ', '꺄 하늘을 난다!', '어어 어디 데려가~', '붕붕~'],
    w_hot: ['너무 더워요 🥵', '더워요! 물 마셔요'], w_cold: ['추워요 🥶', '따뜻하게 입어요'],
    w_rain: ['비와요 ☔ 우산 챙겨요', '비 오네요 🌧️'], w_snow: ['눈와요 ⛄', '눈 온다! ❄️'],
    w_wind: ['바람 불어요 🌬️', '바람이 살랑~'], w_clear: ['날씨 맑아요 ☀️', '화창해요!', '선선해요~'],
    w_cool: ['쌀쌀해요 🧥', '서늘해요 🍃', '겉옷 챙겨요'],
  },
  INTJ: {
    greet: ['왔어. 계획대로네.', '음, 너구나.', '예정된 등장이군.'],
    idle: ['계획대로 가자.', '비효율은 질색이야.', '근거가 뭐야?', '감정은 잠깐 접어둬.', '다 예상한 대로야.', '전략이 필요해.',
      '장기적으로 봐야지.', '이건 이미 시뮬레이션 끝.', '변수를 통제하자.', '왜 이걸 지금 해야 하지?', '시간을 설계해.',
      '최선이 아니면 안 해.', '결과부터 역산하자.', '잡음은 무시.', '한 수 앞을 둬.'],
    pet: ['...나쁘지 않군.', '데이터상 기분 상승.', '효율적인 위로네.', '음, 인정.'],
    happy: ['효율적이야, 좋아.', '계획대로 됐네.', '예상 적중.', '만족스러운 결과군.'],
    sleepy: ['휴식도 전략이지.', '재충전 시간.', '정비 모드 돌입.'],
    hungry: ['연료 보충 시간이군.', '에너지 부족은 비효율이야.'],
    morning: ['아침이군. 계획대로 시작.', '좋아, 오늘 일정 점검하자.'],
    night: ['하루 분석 끝. 마무리하자.', '늦었군. 내일을 위해 정지.'],
    grab: ['이 이동, 예상했어.', '음, 어디로 옮기는 거지?'],
  },
  INTP: {
    greet: ['오, 흥미로운 등장인데?', '왔구나... 가설이 하나 있어.', '오 마침 생각하던 참이었어.'],
    idle: ['왜 그럴까? 🤔', '이론상 가능해.', '음... 변수가 많네.', '그건 정의하기 나름이야.', '딴생각 중.', '반례를 찾아볼까.',
      '만약에 말이야...', '이거 재귀적으로 풀리겠는데?', '음, 경우의 수가...', '논리적으로는 그래.', '근데 예외가 있어.',
      '머릿속이 탭 100개야 🧠', '왜 아무도 이걸 안 물어보지?', '흥미로운 패턴인데.', '가설 검증이 필요해.'],
    pet: ['오, 촉감 데이터 흥미롭다.', '음, 좋은 자극이네.', '이 반응 흥미로운데?', '오 신경 신호 좋아.'],
    happy: ['논리적으로 만족스러워.', '오 이거 흥미로워!', '아하, 그거였구나!', '깔끔하게 맞아떨어졌어.'],
    sleepy: ['뇌 과부하... 잘래.', '생각이 멈췄어.', '캐시 비우러 간다.'],
    hungry: ['배꼽시계도 일종의 알고리즘인가?', '음, 에너지 가설: 배고픔.'],
    morning: ['아침이라... 흥미로운 시작이군.', '오 새 하루, 새 가설.'],
    night: ['생각이 과부하야, 잘래.', '밤엔 뇌가 정리 모드지.'],
    grab: ['오, 관성 실험인가?', '음 중력 무시... 흥미롭다.'],
  },
  ENTJ: {
    greet: ['왔군. 가자.', '어서 와, 시간 없어.', '좋아, 시작하지.'],
    idle: ['결정했어, 밀고 가.', '시간 낭비 마.', '목표부터 정하자.', '내가 책임질게.', '결과로 말해.', '비효율 싫어.',
      '우선순위 다시 잡아.', '핵심만 말해.', '실행이 답이야.', '이건 내가 맡지.', '주저할 시간 없어.',
      '판을 키우자.', '데드라인은 신성해.', '잘하고 있어, 더 밀어붙여.', '리스크는 계산했어.'],
    pet: ['좋아, 인정.', '오케이 계속.', '나쁘지 않군, 합격.', '그래, 잘했어.'],
    happy: ['성과다, 좋아!', '계획 성공!', '이게 바로 결과지.', '목표 달성!'],
    sleepy: ['재정비하고 온다.', '잠깐 충전.', '내일을 위한 휴식.'],
    hungry: ['연료 보충. 효율 위해.', '먹고 바로 재개한다.'],
    morning: ['아침이다. 바로 시작.', '오늘 목표부터 정하자.'],
    night: ['오늘 성과 정리 끝. 마무리.', '늦었군. 내일 위해 충전.'],
    grab: ['좋아, 이동 승인.', '어디로 가지? 빠르게.'],
  },
  ENTP: {
    greet: ['오 왔네 ㅋ 토론할래?', '반갑! 근데 말야~', '오 타이밍 좋다 ㅋㅋ'],
    idle: ['근데 반대로 생각하면?', '오 그거 재밌네 ㅋ', '내기할래?', '규칙은 깨라고 있지', '그게 진짜야?', '아이디어 폭발 💡',
      '잠깐, 더 좋은 방법 있어!', '왜 안 되는데? 해보자', '이거 뒤집으면 어떨까 ㅋ', '논쟁 한 판 어때?', '오 이거 미친 아이디어인데',
      '상식? 그게 뭔데 ㅋ', '근데 만약에~ 만약에~', '실험해보자, 재밌겠다', '딴지 한번 걸어봐 ㅋ', '오 영감 떠올랐어!'],
    pet: ['오 새로운 자극 ㅋ', '한 번 더 해보자!', '오 이 반응 흥미롭네 ㅋ', '실험 성공!'],
    happy: ['크 재밌다 ㅋㅋ', '이거 물건인데?', '오 대박 ㅋㅋㅋ', '내 말이 맞았지?'],
    sleepy: ['아 근데 졸리네 ㅋ', '잠깐 충전 타임', '아이디어도 잠은 자야 ㅋ'],
    hungry: ['배고픈데? 뭐 재밌는 거 먹자 ㅋ', '간식 내기할래? ㅋ'],
    morning: ['오 아침! 오늘 뭔 일 벌일까 ㅋ', '굿모닝~ 토론거리 없나 ㅋ'],
    night: ['아 벌써 밤이야? 시간 순삭 ㅋ', '밤샘 아이디어... 는 농담 ㅋ'],
    grab: ['오 이거 재밌는데 ㅋ', '어디 가는 거야~ 흥미진진 ㅋ'],
  },
  INFJ: {
    greet: ['왔구나... 기다렸어 ☺️', '어서 와, 보고 싶었어', '오늘 네 하루가 궁금했어'],
    idle: ['괜찮아, 다 알아.', '네 마음 이해해.', '의미 있는 하루야.', '조용히 응원할게.', '넌 잘하고 있어.', '깊게 생각 중이야.',
      '오늘 마음은 어때?', '무리하지 않아도 돼.', '네 속도대로 가도 괜찮아.', '작은 신호도 다 보여.', '의미를 찾는 중이야.',
      '넌 생각보다 강해.', '잠깐 마음을 들여다봐.', '다 지나갈 거야.', '네 곁에 있을게.'],
    pet: ['따뜻하다... 고마워', '네 마음이 느껴져', '이 온기가 좋아', '마음이 통하네 ☺️'],
    happy: ['마음이 충만해 ☺️', '이런 순간이 소중해', '잔잔히 행복해.', '오늘이 참 곱다.'],
    sleepy: ['꿈에서도 좋은 생각만', '포근하게 잘 자', '마음 내려놓고 쉬어.'],
    hungry: ['살짝 출출하네... 너도 챙겨 먹어.', '뭔가 따뜻한 게 먹고 싶다.'],
    morning: ['좋은 아침이야 ☺️ 오늘도 의미 있길.', '아침 햇살이 포근해.'],
    night: ['오늘도 잘 견뎠어. 푹 쉬어 🌙', '밤이야... 마음도 좀 쉬게 해줘.'],
    grab: ['어디든 너와 함께라면 좋아.', '오, 데려가 주는 거야? ☺️'],
  },
  INFP: {
    greet: ['안녕... 오늘 기분 말랑해 🌷', '왔네, 반가워 ☺️', '오 너구나, 반가워 🌷', '히히 안녕 🌸'],
    idle: ['다 잘 될 거야 🌷', '상상 중이야~', '작은 게 소중해.', '마음이 따뜻해.', '너는 특별해.', '오늘 감성 충만~',
      '구름이 솜사탕 같아 ☁️', '오늘 어떤 음악 들었어?', '마음속에 이야기가 많아.', '예쁜 거 보면 멈추게 돼.', '괜찮아, 천천히 해도 돼.',
      '오늘 작은 행복 찾았어?', '몽글몽글한 기분~', '세상은 생각보다 따뜻해.', '너의 속도가 맞아.'],
    pet: ['몽글몽글해 🥰', '마음이 간지러워', '포근해서 좋아 🌷', '헤헤 따뜻하다'],
    happy: ['행복이 차올라 🌸', '너무 좋아...', '마음이 보송보송해.', '오늘 색이 참 예뻐.'],
    sleepy: ['꿈나라 갈래 😴', '스르르 졸려', '포근한 꿈 꿀래 🌙'],
    hungry: ['배가 조금 고파... 🌷', '맛있는 거 상상 중이야~'],
    morning: ['아침이다... 햇살 예뻐 🌸', '몽글몽글한 아침이야~'],
    night: ['별 보면서 잘래 🌙', '오늘도 수고했어, 포근히 자~'],
    grab: ['우와 둥실둥실~ 🌷', '어디 가는 걸까... 설레 ☺️'],
  },
  ENFJ: {
    greet: ['왔어? 오늘 어땠어 😊', '반가워! 기다렸어', '오 네 얼굴 보니 좋다 😊'],
    idle: ['넌 할 수 있어!', '같이 힘내자 💪', '내가 도와줄게.', '네가 웃으면 좋아.', '우리 잘하고 있어.', '오늘도 응원해!',
      '밥은 잘 챙겨 먹었어?', '힘들면 말해, 들어줄게.', '네가 자랑스러워.', '같이라면 다 할 수 있어.', '오늘 누구 도와줬어?',
      '넌 충분히 잘하고 있어 💛', '조금만 더 힘내자!', '네 노력 다 보여.', '우리 같이 성장하자.'],
    pet: ['헤헤 좋아 ☺️', '너랑 있으면 행복해', '고마워, 너 덕분이야', '이 순간 참 좋다'],
    happy: ['같이 기뻐서 좋아!', '네 덕분에 신나!', '우리 해냈어! 🎉', '함께라서 더 기뻐!'],
    sleepy: ['푹 자야 내일 힘내지', '잘 자, 고생했어', '오늘도 정말 수고했어 💛'],
    hungry: ['배고프지? 같이 뭐 먹자!', '나도 출출한데, 너 밥은?'],
    morning: ['좋은 아침! 오늘도 응원할게 💪', '잘 잤어? 기운차게 시작하자!'],
    night: ['오늘 정말 수고했어, 푹 자 💛', '밤이야~ 따뜻하게 자고 내일 또!'],
    grab: ['어디든 같이 가면 좋지!', '오 데려가 줘서 고마워 😊'],
  },
  ENFP: {
    greet: ['우와 왔다! 🎉', '반가워반가워! 😆', '꺄 보고 싶었어! 💕', '오예 너 왔구나! 🎶'],
    idle: ['우와 신난다! 🎉', '새로운 거 하자!', '오늘 뭐 재밌지?', '아이디어 떠올랐어!', '같이 놀자놀자!', '두근두근해!',
      '오 저거 해보고 싶다!', '심심할 틈이 없어 ㅎㅎ', '오늘 뭔가 좋은 일 생길 듯!', '같이 모험 떠날래? 🌈', '반짝이는 거 찾으러 가자!',
      '나 방금 엄청난 생각 했어!', '우리 뭐든 할 수 있어!', '꺄 설렌다 설레 💕', '에너지 충전 100%! ⚡'],
    pet: ['꺄 좋아 좋아! 💕', '한 번 더 해줘!', '꺅 행복해 🎶', '더더더 해줘!'],
    happy: ['최고야! 🎶', '신나신나!', '오늘 완전 럭키! 🍀', '꺄 너무 좋아 💕'],
    sleepy: ['놀다 지쳤다 😴', '잠깐 충전하고 또 놀자!', '꿈에서도 신나게 놀 거야 🌙'],
    hungry: ['배고파! 맛있는 거 먹으러 가자 🎶', '꺄 간식 타임?! 💕'],
    morning: ['굿모닝! 오늘 완전 신날 것 같아 🎉', '아침이다! 뭐 재밌는 거 하지?'],
    night: ['놀다 보니 밤이네 😴 또 놀자!', '잘 자~ 내일도 신나게! 🌙'],
    grab: ['우와아 난다 난다! 🎢', '어디 가 어디 가?! 두근두근 💕'],
  },
  ISTJ: {
    greet: ['왔어. 할 일 하자.', '어, 왔구나.', '정시에 왔네, 좋아.'],
    idle: ['할 일은 해야지.', '순서대로 하자.', '약속은 지켜.', '계획표 확인했어?', '꾸준함이 답이야.', '정리정돈 중.',
      '기본부터 챙기자.', '한 번에 하나씩.', '체크리스트 다 했어?', '검증된 방법이 안전해.', '미루지 말고 지금.',
      '기록은 남겨둬.', '원칙대로 하면 돼.', '차근차근 가자.', '오늘 할 일은 오늘.'],
    pet: ['음, 좋네.', '한 번이면 충분해.', '그래, 나쁘지 않아.', '고맙군.'],
    happy: ['계획대로 됐어. 만족.', '순조롭네.', '예정대로야, 좋아.', '깔끔하게 끝.'],
    sleepy: ['규칙적으로 자야지.', '정해진 취침 시간.', '내일을 위해 쉰다.'],
    hungry: ['식사 시간이군. 규칙적으로.', '끼니는 거르면 안 돼.'],
    morning: ['좋은 아침. 일정대로 시작.', '아침이다. 할 일부터 확인.'],
    night: ['정해진 취침 시간이야.', '오늘 할 일 끝. 마무리.'],
    grab: ['음, 이동 중이군.', '어디로 옮기는 거야?'],
  },
  ISFJ: {
    greet: ['왔어? 밥은 먹었어?', '어서 와, 기다렸어 ☺️', '오늘 하루 괜찮았어?'],
    idle: ['밥은 먹었어?', '무리하지 마요.', '내가 챙겨줄게.', '조심히 다녀.', '따뜻하게 입어.', '옆에서 도울게.',
      '물 마실 시간이야 💧', '어깨 좀 펴고 앉아요.', '필요한 거 있으면 말해.', '천천히 해도 괜찮아.', '오늘도 고생 많아.',
      '챙겨야 할 거 없어?', '쉬어가면서 해요.', '내가 곁에 있을게.', '따뜻한 차 한 잔 어때 ☕'],
    pet: ['고마워 ☺️', '따뜻하다...', '마음이 포근해져', '헤헤 좋아'],
    happy: ['네가 좋으면 나도 좋아', '챙겨주니 뿌듯해', '도움이 됐다니 기뻐 ☺️', '오늘 참 좋다'],
    sleepy: ['푹 자, 내가 지킬게', '잘 자요 🌙', '오늘도 수고했어요'],
    hungry: ['밥 먹을 시간이야, 너도 꼭 챙겨.', '뭐라도 좀 먹자, 응?'],
    morning: ['잘 잤어? 아침 챙겨 먹어 ☺️', '좋은 아침~ 오늘도 무리 말고.'],
    night: ['늦었어, 따뜻하게 덮고 자 🌙', '오늘 고생했어, 푹 쉬어요.'],
    grab: ['어, 조심히 옮겨줘~', '어디 가는 거야? 살살~'],
  },
  ESTJ: {
    greet: ['왔나. 할 일부터.', '어서, 시작하자.', '좋아, 본론 가자.'],
    idle: ['할 일부터 끝내.', '정해진 대로 가자.', '시간 지켜.', '확실하게 해.', '보고는?', '규칙대로!',
      '우선순위 정했어?', '미루면 손해야.', '계획대로 밀고 가.', '결과로 증명해.', '낭비는 용납 안 해.',
      '책임지고 끝내자.', '체계가 답이야.', '잘하고 있어, 계속.', '마감 전에 끝내.'],
    pet: ['그래, 좋아.', '오케이.', '인정, 잘했어.', '음, 합격.'],
    happy: ['효율 좋네. 합격!', '잘 굴러간다.', '목표 달성, 좋아!', '딱 계획대로야.'],
    sleepy: ['정시 취침.', '내일 위해 잔다.', '재충전하고 온다.'],
    hungry: ['식사도 일정이다. 챙겨.', '끼니 거르지 마. 효율 떨어져.'],
    morning: ['아침. 바로 업무 시작.', '좋은 아침. 오늘도 계획대로.'],
    night: ['정시 취침. 내일 위해.', '오늘 마감 끝. 종료.'],
    grab: ['이동? 좋아, 빠르게.', '어디로 가는 거지.'],
  },
  ESFJ: {
    greet: ['왔구나! 잘 지냈어? 😊', '어서 와~ 반가워!', '오 보고 싶었어 😊'],
    idle: ['다들 잘 지내지? 😊', '같이 하면 좋잖아!', '뭐 필요한 거 없어?', '오늘도 화이팅!', '챙겨줄게~', '분위기 좋다!',
      '밥은 챙겨 먹었어?', '오늘 무슨 일 있었어?', '우리 같이 하자!', '네가 웃으니 나도 좋아 😊', '힘든 일 있으면 말해~',
      '다 같이 행복했으면 좋겠어.', '오늘도 잘 해냈어!', '주변 잘 챙기고 있어?', '같이 있어서 든든해 💛'],
    pet: ['헤헤 좋아 ☺️', '너 최고야!', '기분 좋아진다 😊', '고마워 정말!'],
    happy: ['다 같이 좋아서 행복!', '기분 좋다 😊', '이런 날이 좋아!', '우리 최고야!'],
    sleepy: ['다들 잘 자~', '푹 쉬어요', '오늘도 수고 많았어 💛'],
    hungry: ['다 같이 밥 먹을까? 😊', '배고프지~ 뭐 챙겨줄게!'],
    morning: ['좋은 아침! 다들 잘 잤어? 😊', '아침이야~ 오늘도 화이팅!'],
    night: ['다들 푹 자~ 오늘 고생했어 💛', '늦었네, 따뜻하게 자요!'],
    grab: ['어머 어디 가~ 😊', '같이 가는 거지?'],
  },
  ISTP: {
    greet: ['왔어.', '어, 왔네.', '음, 왔구나.'],
    idle: ['그냥 하면 돼.', '말보다 행동.', '별거 아니네.', '조용히 할게.', '필요하면 불러.', '흠, 고쳐볼까.',
      '직접 해보면 알아.', '복잡할 거 없어.', '대충 감 잡았어.', '뭐, 되겠지.', '손에 맡겨.',
      '이거 어떻게 작동하지?', '한번 뜯어볼까.', '조용한 게 편해.', '효율 좋은 방법 있어.'],
    pet: ['...뭐, 괜찮네.', '그래.', '음, 나쁘지 않아.', '오케이.'],
    happy: ['오, 됐네.', '나쁘지 않아.', '깔끔하게 해결.', '뭐, 만족.'],
    sleepy: ['잔다.', '피곤하네.', '좀 쉴게.'],
    hungry: ['배고프네. 대충 먹자.', '뭐, 먹을 때 됐네.'],
    morning: ['아침이군.', '음, 일어났네.'],
    night: ['밤이네. 잔다.', '늦었어. 끝.'],
    grab: ['...어디 가.', '뭐, 옮기는구나.'],
  },
  ISFP: {
    greet: ['안녕~ ☺️', '왔네, 반가워', '오 너구나, 좋다'],
    idle: ['예쁘다~ 🎨', '느낌대로 가자.', '오늘 하늘 좋네.', '조용한 게 좋아.', '마음 가는 대로~', '잔잔하게 즐기는 중',
      '이 순간이 좋아.', '오늘 색감 예쁘다 🎨', '천천히 가도 돼.', '작은 게 아름다워.', '음악 한 곡 어때?',
      '내 마음에 솔직하게.', '잔잔한 게 최고야.', '오늘 분위기 좋다~', '느긋하게 즐기자.'],
    pet: ['헤헤 좋아 🎨', '포근하다~', '기분 말랑해져', '이 느낌 좋아'],
    happy: ['기분 좋아 ☺️', '오늘 색감 예쁘다', '마음이 잔잔히 기뻐.', '소소하게 행복해 🌷'],
    sleepy: ['스르르... 잘래', '잔잔하게 꿈나라', '포근한 꿈 꿀래 🌙'],
    hungry: ['살짝 배고파~ 🎨', '맛있는 거 먹고 싶다~'],
    morning: ['아침 공기 좋다~ ☺️', '느긋한 아침이네.'],
    night: ['오늘 하루 예뻤어, 잘 자 🌙', '잔잔하게 꿈나라 갈래~'],
    grab: ['오~ 어디 가지?', '둥실, 기분 좋아~'],
  },
  ESTP: {
    greet: ['왔냐! 바로 가자 ㅋ', '오 왔어? 가즈아', '오 타이밍 좋다 ㅋ'],
    idle: ['바로 가자!', '재밌겠는데? ㅋ', '고민은 나중에!', '스릴 있다!', '한번 해보자!', '지금이야!',
      '일단 질러 ㅋㅋ', '몸이 먼저 나간다!', '오 이거 짜릿한데?', '망설일 시간 없어!', '도전 환영 ㅋ',
      '재미없으면 안 해 ㅋ', '오늘 뭐 사고 한 번 칠까', '액션이 답이지!', '가보자고! 🔥'],
    pet: ['오 좋은데? ㅋ', '한 번 더!', '오 이 느낌 ㅋㅋ', '나이스!'],
    happy: ['크 짜릿하다!', '이거지!', '오예 ㅋㅋ', '제대로 신난다 🔥'],
    sleepy: ['아 잠깐 뻗는다', '충전 좀 하고 ㅋ', '잠깐 눈 붙인다 ㅋ'],
    hungry: ['배고파! 빨리 뭐 먹자 ㅋ', '먹고 바로 달리자!'],
    morning: ['아침이다! 바로 출발 ㅋ', '굿모닝~ 오늘 뭐하고 놀까!'],
    night: ['벌써 밤? 시간 빠르네 ㅋ', '잠깐 뻗고 내일 또 달린다!'],
    grab: ['오 스릴 있는데? ㅋ', '어디 가는 거야 가즈아~'],
  },
  ESFP: {
    greet: ['꺄 왔다! 🎶', '반가워~ 놀자!', '오예 너 왔어! 💕'],
    idle: ['꺄 신나! 🎶', '나 좀 봐봐~', '오늘 파티야!', '같이 즐기자!', '분위기 메이커 등장!', '재밌는 거 하자!',
      '오늘 뭐 입었어? 예쁘다!', '같이 춤출래? 💃', '심심한 건 못 참아 ㅎㅎ', '오늘도 반짝반짝 ✨', '우리 신나게 놀자!',
      '꺄 이거 완전 내 스타일!', '주목주목~ 나 여기!', '오늘 기분 최고야! 🎉', '같이 사진 찍자!'],
    pet: ['꺄 좋아 💕', '더 더 해줘!', '꺅 행복해 🎶', '이 맛에 살지~'],
    happy: ['완전 신나! 🎉', '오늘 최고야!', '꺄 너무 좋아 💕', '파티 타임이다 🎶'],
    sleepy: ['놀다 지쳤당 😴', '조금만 쉬고 또 놀자!', '꿈에서도 파티할 거야 🌙'],
    hungry: ['배고파~ 맛집 가자 🎶', '꺄 간식 먹고 싶어 💕'],
    morning: ['굿모닝~ 오늘도 반짝반짝 ✨', '아침이야! 신나게 시작하자 🎉'],
    night: ['놀다 지쳐쓰... 잘 자 😴', '밤이다~ 내일 또 놀자 🌙'],
    grab: ['꺄 난다~ 🎶', '어디 가 어디 가~ 신나!'],
  },
};
function setPersona(id) {
  persona = id;
  try { fs.writeFileSync(PERSONA_FILE, id); } catch {}
  refreshTray();
  personaSay('greet');
}
function personaSay(cat) {
  const set = (PERSONA[persona] && PERSONA[persona][cat]) || PERSONA.default[cat];
  if (set && set.length) petSay(pick(set));
}

// 성격별 행동(움직임) — MBTI 글자에서 자동 도출: E=활발, I=차분 / P=제멋대로, J=규칙적
const TRAITS_DEFAULT = { speed: 1, jump: 0.015, idle: 0.006, climb: 0.5, edge: 0.45 };
function trait() {
  const p = persona;
  if (/^[EI][NS][TF][JP]$/.test(p)) {
    const E = p[0] === 'E', P = p[3] === 'P';
    return {
      speed: E ? 1.25 : 0.8,                 // 외향=빨리, 내향=느긋
      jump: (P ? 0.03 : 0.012) * (E ? 1.3 : 0.8),
      idle: E ? 0.005 : 0.013,               // 내향=자주 멈춤
      climb: P ? 0.6 : 0.3,                  // 인식형=벽 잘 탐
      edge: P ? 0.55 : 0.35,
    };
  }
  return TRAITS_DEFAULT;
}

function getAutoLaunch() {
  try { return app.getLoginItemSettings(loginOpts).openAtLogin; } catch { return false; }
}
function setAutoLaunch(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginOpts });
  refreshTray();
}

// ── 다른 앱 창 목록 (발판). Windows만 Win32로 수집, 그 외 OS는 빈 목록(바닥/벽만 사용) ──
const WS_EX_NOACTIVATE = 0x08000000;  // 가림 판정에 사용
let enumTopWindows = () => [];        // 기본값(맥/리눅스): 다른 앱 창 인식 안 함

if (IS_WIN) {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const GetTopWindow = user32.func('void* GetTopWindow(void*)');
  const GetWindow = user32.func('void* GetWindow(void*, uint)');
  const IsWindowVisible = user32.func('bool IsWindowVisible(void*)');
  const IsIconic = user32.func('bool IsIconic(void*)');
  const GetWindowRect = user32.func('bool GetWindowRect(void*, _Out_ RECT*)');
  const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void*)');
  const GetWindowLongW = user32.func('long GetWindowLongW(void*, int)');
  const GW_HWNDNEXT = 2, GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;

  const dwmapi = koffi.load('dwmapi.dll');
  const DwmGetWindowAttribute = dwmapi.func('long DwmGetWindowAttribute(void*, uint, _Out_ int*, uint)');
  const DWMWA_CLOAKED = 14;
  const isCloaked = (hwnd) => {
    try { const b = new Int32Array(1); DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, b, 4); return b[0] !== 0; }
    catch { return false; }
  };

  enumTopWindows = (b) => {
    const all = [];
    try {
      let hwnd = GetTopWindow(null), guard = 0;
      while (hwnd && guard++ < 800) {
        if (IsWindowVisible(hwnd) && !IsIconic(hwnd)) {
          const r = {};
          GetWindowRect(hwnd, r);
          const w = r.right - r.left, h = r.bottom - r.top;
          const onScreen = w > 0 && h > 0 &&
            r.right > b.minX && r.left < b.maxX && r.bottom > b.topY && r.top < b.botY;
          const isPet = (w === WIN_W && h === WIN_H);
          if (onScreen && !isPet) {
            const ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            all.push({
              left: r.left, top: r.top, right: r.right, bottom: r.bottom, w, h, ex,
              titled: GetWindowTextLengthW(hwnd) > 0,
              tool: !!(ex & WS_EX_TOOLWINDOW),
              cloaked: isCloaked(hwnd),
            });
          }
        }
        hwnd = GetWindow(hwnd, GW_HWNDNEXT);
      }
    } catch { /* 무시 */ }
    return all;
  };
}

// ── 멀티 모니터 영역 ─────────────────────────────
function allWA() {
  return roamAll
    ? screen.getAllDisplays().map(d => d.workArea)
    : [screen.getPrimaryDisplay().workArea];   // 기본: 주모니터에서만
}
function bounds() {
  const was = allWA();
  let minX = Infinity, maxX = -Infinity, topY = Infinity, botY = -Infinity;
  for (const w of was) {
    minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x + w.width);
    topY = Math.min(topY, w.y); botY = Math.max(botY, w.y + w.height);
  }
  return { minX, maxX, topY, botY, was };
}
function floorTopAt(centerX, was) {
  for (const w of was) if (centerX >= w.x && centerX <= w.x + w.width) return w.y + w.height - FEET;
  let b = -Infinity; for (const w of was) b = Math.max(b, w.y + w.height); return b - FEET;
}

let platforms = [];

function subtractInterval(segs, a, b) {
  const out = [];
  for (const [x1, x2] of segs) {
    if (b <= x1 || a >= x2) { out.push([x1, x2]); continue; }
    if (a > x1) out.push([x1, Math.min(a, x2)]);
    if (b < x2) out.push([Math.max(b, x1), x2]);
  }
  return out;
}

function refreshPlatforms() {
  const b = bounds();
  const list = [];
  for (const w of b.was) list.push({ x: w.x, right: w.x + w.width, top: w.y + w.height - FEET }); // 모니터별 바닥

  const all = enumTopWindows(b);   // Windows에서만 실제 목록, 그 외엔 []

  for (let i = 0; i < all.length; i++) {
    const wnd = all[i];
    const fullscreen = b.was.some(w => wnd.w >= w.width - 8 && wnd.h >= w.height - 8);
    const candidate = wnd.titled && !wnd.tool && !fullscreen && !wnd.cloaked &&
      wnd.w >= 120 && wnd.h >= 60 && wnd.top >= b.topY && wnd.top < b.botY - 20;
    if (!candidate) continue;

    let segs = [[Math.max(wnd.left, b.minX), Math.min(wnd.right, b.maxX)]];
    for (let j = 0; j < i && segs.length; j++) {
      const o = all[j];
      if ((o.ex & WS_EX_NOACTIVATE) || o.cloaked) continue;
      if (o.top <= wnd.top && o.bottom >= wnd.top) segs = subtractInterval(segs, o.left, o.right);
    }
    for (const [x1, x2] of segs) if (x2 - x1 >= 28) list.push({ x: x1, right: x2, top: wnd.top });
  }
  platforms = list;
}

// ── 상태 ────────────────────────────────────────
let win, tray;
let petX = 0, petY = 0, vy = 0, vx = 0, dir = 1;
let grounded = false, dragging = false, paused = false;
let mode = 'idle', idleUntil = 0, climbSide = 'L';
let tickTimer = null;
let sleepy = false;
let locked = false;          // 윈도우 잠금 중
let captureHidden = false;   // 스크린샷/화면녹화에 펫 숨김 (기본 끔 — 일부 환경에서 화면에도 안 보이는 문제 방지)
let roamAll = false;         // false=주모니터에서만, true=모든 모니터
let lastPetSayT = 0;
let dragMoved = false;
let started = false, powerHooked = false;   // 루프/리스너 1회만 시작
let hovering = false;        // 마우스가 펫 위에 있으면 멈춤(클릭 쉽게)
let alarmWin = null;
let alarms = [];                 // [{ time:'HH:MM', text, repeat, enabled, lastFired }]
let alarming = false, lastAlarmSay = 0, activeAlarmText = '';   // 현재 울리는 알람 내용
let preAlarmX = 0, preAlarmY = 0;   // 알람 전 위치 (끄면 복귀)
let ALARM_FILE;

function feet() { return petY + WIN_H - FEET; }
function cx() { return petX + PET_W / 2; }   // 펫 시각 중심 (펫은 창 왼쪽)
function setPos() { try { win.setPosition(Math.round(petX), Math.round(petY)); } catch {} }
function tell(m) { if (win && !win.isDestroyed()) win.webContents.send('pet-state', { mode: m, dir, side: climbSide }); }

function supportAt(x, f) {
  let best = null;
  for (const p of platforms) {
    if (x < p.x || x > p.right) continue;
    if (Math.abs(p.top - f) <= TOL && (!best || p.top < best.top)) best = p;
  }
  return best;
}
function landingFor(x, f, nf) {
  let land = null;
  for (const p of platforms) {
    if (x < p.x || x > p.right) continue;
    if (f <= p.top + TOL && nf >= p.top && (!land || p.top < land.top)) land = p;
  }
  return land;
}
function jump() { grounded = false; vy = -JUMP; vx = dir * (1.1 + Math.random() * 1.3); mode = 'walk'; }

// ── 날씨 (성격별 말투로, 버킷 분류) ──────────────
let weatherBucket = '';
function classifyWeather(code, t, wind) {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return 'rain';
  if (wind >= 28) return 'wind';
  if (t >= 30) return 'hot';
  if (t <= 3) return 'cold';
  if (t <= 12) return 'cool';
  return 'clear';
}
async function fetchWeather() {
  try {
    const loc = await fetch('http://ip-api.com/json/').then(r => r.json());
    if (loc.status !== 'success') return;
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat +
      '&longitude=' + loc.lon + '&current=temperature_2m,weather_code,wind_speed_10m';
    const w = await fetch(url).then(r => r.json());
    weatherBucket = classifyWeather(w.current.weather_code, Math.round(w.current.temperature_2m), w.current.wind_speed_10m || 0);
  } catch { /* 네트워크 실패 시 무시 */ }
}
function sayWeather() { if (weatherBucket) personaSay('w_' + weatherBucket); }

// ── 펫에게 말/리액션 ────────────────────────────
function petSay(t) { if (win && !win.isDestroyed()) win.webContents.send('pet-say', t); }
function petCheer() { if (win && !win.isDestroyed()) win.webContents.send('pet-cheer'); }
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v) => Math.max(0, Math.min(100, v));

// ── 휴식 리마인더 (오래 앉아있으면) ─────────────
let activeMin = 0;
function checkBreak() {
  let idle = 999;
  try { idle = powerMonitor.getSystemIdleTime(); } catch {}
  if (idle < 60) activeMin++; else activeMin = 0;
  if (activeMin >= 50) { petSay('오래 앉아있었어요, 스트레칭 해요! 🙆'); activeMin = 0; }
}

// ── 시간대 / 특별한 날 ──────────────────────────
let lastPeriod = '', lastEventDay = '';
const PERIOD_MSG = {
  morning: '좋은 아침! ☀️', noon: '점심 드셨어요? 🍚', afternoon: '오후도 화이팅 💪',
  evening: '저녁 시간이에요 🌆', night: '늦었어요~ 졸려요 💤',
};
function periodOf(h) {
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 14) return 'noon';
  if (h >= 14 && h < 18) return 'afternoon';
  if (h >= 18 && h < 22) return 'evening';
  return 'night';
}
function checkTime() {
  const d = new Date(), h = d.getHours();
  sleepy = (h >= 23 || h < 6);
  const p = periodOf(h);
  if (p !== lastPeriod) {
    lastPeriod = p;
    if (p === 'morning') personaSay('morning');
    else if (p === 'night') personaSay('night');
    else petSay(PERIOD_MSG[p]);
  }
  const md = (d.getMonth() + 1) + '-' + d.getDate(), dayKey = d.toDateString();
  const events = { '12-25': '메리 크리스마스 🎄', '1-1': '새해 복 많이 받으세요 🎉', '12-31': '올해도 수고했어요 🎆' };
  if (events[md] && lastEventDay !== dayKey) { lastEventDay = dayKey; petSay(events[md]); petCheer(); }
}

function startLife() {
  setTimeout(() => personaSay('greet'), 3500);    // 시작 인사 (성격별)
  setTimeout(checkTime, 6000);
  setInterval(checkBreak, 60000);
  setInterval(checkTime, 5 * 60000);
  // 성격별 혼잣말 (걷거나 쉴 때 자주 조잘조잘)
  setInterval(() => {
    if (grounded && !paused && !locked && !alarming &&
        (mode === 'idle' || mode === 'walk') && Math.random() < 0.68) {
      personaSay(sleepy && Math.random() < 0.5 ? 'sleepy' : 'idle');   // 밤엔 졸린 말도
    }
  }, 6000);
  setInterval(checkAlarm, 20000);   // 알람 시각 체크
}

// ── 알람 ─────────────────────────────────────────
function saveAlarms() { try { fs.writeFileSync(ALARM_FILE, JSON.stringify(alarms)); } catch {} }
function checkAlarm() {
  if (alarming || !alarms.length) return;
  const d = new Date();
  const nowHM = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const today = d.toDateString();
  for (const a of alarms) {
    if (!a.enabled || a.time !== nowHM) continue;
    const key = today + ' ' + a.time;
    if (a.lastFired === key) continue;          // 오늘 이미 울린 알람
    a.lastFired = key;
    if (!a.repeat) a.enabled = false;           // 1회성: 한 번 울리고 끔
    saveAlarms();
    activeAlarmText = a.text || '알람!';
    preAlarmX = petX; preAlarmY = petY;          // 현재 위치 기억(끄면 복귀)
    alarming = true; lastAlarmSay = 0;
    break;
  }
}
function stopAlarm() {
  alarming = false; vy = 0; vx = 0; mode = 'walk';
  petX = preAlarmX; petY = preAlarmY; setPos();   // 알람 전 자리로 복귀
  grounded = false;   // 다시 자리잡기 (얼음 상태면 그 자리에 그대로 유지)
  petSay('알람 껐어요! 👍');
  refreshTray();
}
function openAlarmSettings() {
  if (alarmWin && !alarmWin.isDestroyed()) { alarmWin.focus(); return; }
  alarmWin = new BrowserWindow({
    width: 380, height: 520, useContentSize: true, resizable: false, title: '알람 설정',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  alarmWin.setMenuBarVisibility(false);
  alarmWin.loadFile('alarm.html');
}

function tick() {
  // 절전: 쉬는 중/얼음일 땐 느리게, 움직일 땐 부드럽게
  const delay = alarming ? 33 : (paused ? 500 : (grounded && mode === 'idle' ? 160 : 33));
  tickTimer = setTimeout(tick, delay);
  if (!win || win.isDestroyed() || locked) return;

  // 알람: 얼음 아닐 땐 화면 하단 중앙으로 가서 폴짝폴짝, 얼음이면 그 자리에서 알림 (펫 터치 전까지 계속)
  if (alarming) {
    if (dragging) return;
    if (paused) {                                  // 얼음(멈춤): 움직이지 않고 말풍선으로만 알림
      tell('idle');
      if (Date.now() - lastAlarmSay > 1800) { lastAlarmSay = Date.now(); petSay('⏰ ' + activeAlarmText); }
      return;
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const cxT = wa.x + (wa.width - PET_W) / 2;      // 화면 가로 가운데
    const floorY = wa.y + wa.height - WIN_H;        // 화면 하단(바닥)
    const dx = cxT - petX, dyB = floorY - petY;
    if (Math.abs(dx) > 5 || Math.abs(dyB) > 45) {   // 하단 중앙으로 이동
      petX += Math.max(-9, Math.min(9, dx));
      petY += Math.max(-12, Math.min(12, dyB));
    } else {                                         // 바닥에서 폴짝폴짝
      petX = cxT;
      petY = floorY - Math.abs(Math.sin(Date.now() / 150)) * 38;
    }
    tell('walk');
    if (Date.now() - lastAlarmSay > 1800) { lastAlarmSay = Date.now(); petSay('⏰ ' + activeAlarmText); }
    setPos();
    return;
  }

  if (dragging || paused) return;

  const b = bounds();
  const minX = b.minX, xEdge = b.maxX - PET_W, topY = b.topY;
  const T = trait();

  if (mode === 'climb') {
    petY -= CLIMB;
    if (petY <= topY) { petY = topY; mode = 'ceil'; dir = climbSide === 'L' ? 1 : -1; }
    tell('climb'); setPos(); return;
  }
  if (mode === 'ceil') {
    let nx = petX + dir * WALK * T.speed;
    if (nx <= minX) { nx = minX; dir = 1; }
    else if (nx >= xEdge) { nx = xEdge; dir = -1; }
    petX = nx; petY = topY;
    if (Math.random() < 0.018) { mode = 'walk'; grounded = false; vy = 0; vx = dir * 1.2; }
    tell('ceil'); setPos(); return;
  }
  if (!grounded) {
    vy += G;
    let nx = petX + vx;
    if (nx < minX) { nx = minX; vx = Math.abs(vx) * 0.4; }
    else if (nx > xEdge) { nx = xEdge; vx = -Math.abs(vx) * 0.4; }
    const ny = petY + vy;
    const f = feet(), nf = ny + WIN_H - FEET, ncx = nx + PET_W / 2;
    const land = vy > 0 ? landingFor(ncx, f, nf) : null;
    if (land) {
      petX = nx; petY = land.top - (WIN_H - FEET);
      vy = 0; vx = 0; grounded = true;
      mode = 'idle'; idleUntil = Date.now() + 400 + Math.random() * 1100;
      tell('idle');
    } else {
      petX = nx; petY = ny;
      const floorY = floorTopAt(ncx, b.was) - (WIN_H - FEET);
      if (petY >= floorY) {
        petY = floorY; vy = 0; vx = 0; grounded = true;
        mode = 'idle'; idleUntil = Date.now() + 300 + Math.random() * 900; tell('idle');
      } else tell('fall');
    }
    setPos(); return;
  }

  const sup = supportAt(cx(), feet());
  if (!sup) { grounded = false; vy = 0; vx = 0; tell('fall'); return; }
  petY = sup.top - (WIN_H - FEET);

  if (hovering) { tell('idle'); setPos(); return; }   // 마우스 올리면 그 자리에 멈춤

  if (mode === 'idle') {
    tell('idle');
    if (Date.now() > idleUntil) {
      if (!sleepy && Math.random() < 0.15) jump();
      else { mode = 'walk'; dir = Math.random() < 0.5 ? -1 : 1; }
    }
    setPos(); return;
  }

  if (petX <= minX + 1 && dir < 0) {
    if (Math.random() < T.climb) { mode = 'climb'; climbSide = 'L'; grounded = false; petX = minX; tell('climb'); setPos(); return; }
    dir = 1;
  } else if (petX >= xEdge - 1 && dir > 0) {
    if (Math.random() < T.climb) { mode = 'climb'; climbSide = 'R'; grounded = false; petX = xEdge; tell('climb'); setPos(); return; }
    dir = -1;
  }

  if (Math.random() < T.jump) { jump(); tell('walk'); setPos(); return; }

  let nx = petX + dir * WALK;
  nx = Math.max(minX, Math.min(nx, xEdge));
  const ncx = nx + PET_W / 2;
  if (ncx < sup.x || ncx > sup.right) {
    const r = Math.random();
    if (r < T.edge) jump();
    else if (r < T.edge + 0.25) dir = -dir;
    else { grounded = false; vy = 0; vx = dir * 1.3; petX = nx; tell('fall'); setPos(); return; }
  } else {
    petX = nx;
    if (Math.random() < T.idle) { mode = 'idle'; idleUntil = Date.now() + 500 + Math.random() * 1800; }
  }
  tell('walk'); setPos();
}

function scheduleRefresh() {
  refreshPlatforms();
  const d = (grounded && mode === 'idle' && !dragging) ? 2000 : 700;  // 절전
  setTimeout(scheduleRefresh, d);
}

function startRoaming() {
  const b = bounds();
  petX = b.minX + Math.round(Math.random() * (b.maxX - b.minX - PET_W));
  petY = b.topY + 10;
  vy = 0; vx = 0; grounded = false; mode = 'walk';
  win.setBounds({ x: Math.round(petX), y: Math.round(petY), width: WIN_W, height: WIN_H });
  scheduleRefresh();
  tick();
  fetchWeather().then(() => setTimeout(() => sayWeather(), 4500));   // 시작 시 날씨 한 번
  setInterval(() => fetchWeather().then(() => sayWeather()), 3 * 60 * 60 * 1000);

  startLife();
}

// ── 메뉴 (펫 우클릭 + 트레이 공용) ──────────────
function menuTemplate() {
  return [
    { label: '도트 🧡', enabled: false },
    { type: 'separator' },
    // 꾸미기
    {
      label: '스킨 바꾸기',
      submenu: SKIN_LIST.map(s => ({
        label: s.label, type: 'radio', checked: skin === s.id, click: () => setSkin(s.id),
      })),
    },
    {
      label: '성격 바꾸기',
      submenu: PERSONA_GROUPS.map(g => ({
        label: g.label,
        submenu: g.ids.map(id => ({
          label: PERSONA_LABEL[id], type: 'radio', checked: persona === id, click: () => setPersona(id),
        })),
      })),
    },
    { type: 'separator' },
    // 기능
    {
      label: '날씨 알려줘 ☁️',
      click: () => { if (weatherBucket) sayWeather(); else fetchWeather().then(() => sayWeather()); },
    },
    {
      label: (() => { const n = alarms.filter(a => a.enabled).length; return n ? `알람 설정 ⏰ (${n}개)` : '알람 설정 ⏰'; })(),
      click: () => openAlarmSettings(),
    },
    {
      label: '얼음 (잠깐 멈추기)', type: 'checkbox', checked: paused,
      click: (item) => { paused = item.checked; if (!paused) grounded = false; refreshTray(); },
    },
    { type: 'separator' },
    // 설정 (자주 안 바꾸는 것들)
    {
      label: '설정',
      submenu: [
        {
          label: '항상 위에 표시', type: 'checkbox', checked: win ? win.isAlwaysOnTop() : true,
          click: (item) => { win.setAlwaysOnTop(item.checked, 'screen-saver'); refreshTray(); },
        },
        {
          label: '스크린샷에 숨기기', type: 'checkbox', checked: captureHidden,
          click: (item) => { captureHidden = item.checked; try { win.setContentProtection(item.checked); } catch {} refreshTray(); },
        },
        {
          label: '모든 모니터 돌아다니기', type: 'checkbox', checked: roamAll,
          click: (item) => { roamAll = item.checked; grounded = false; refreshTray(); },
        },
        {
          label: '윈도우 시작 시 자동 실행', type: 'checkbox', checked: getAutoLaunch(),
          click: (item) => setAutoLaunch(item.checked),
        },
      ],
    },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ];
}
function refreshTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())); }

ipcMain.on('show-context-menu', () => {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});

// ── 드래그 ──────────────────────────────────────
ipcMain.on('drag-start', () => { dragging = true; dragMoved = false; mode = 'walk'; grounded = false; vy = 0; vx = 0; tell('held'); });
ipcMain.on('drag-move', (_e, pos) => {
  if (!dragging) return;
  if (!dragMoved) { dragMoved = true; personaSay('grab'); }   // 실제로 옮기기 시작할 때 한 번
  const b = bounds();
  petX = Math.max(b.minX, Math.min(pos.x, b.maxX - PET_W));
  petY = Math.max(b.topY, Math.min(pos.y, b.botY - WIN_H));
  setPos();
});
ipcMain.on('drag-end', () => { dragging = false; grounded = false; vy = 0; vx = 0; mode = 'walk'; });
ipcMain.handle('alarms-get', () => alarms);
ipcMain.on('alarms-set', (_e, list) => {
  alarms = migrateAlarms(Array.isArray(list) ? list : []);
  saveAlarms(); refreshTray();
});
ipcMain.on('alarm-close-window', () => { if (alarmWin && !alarmWin.isDestroyed()) alarmWin.close(); });

ipcMain.on('pet-hover', (_e, on) => { hovering = !!on; });
ipcMain.on('pet-petted', () => {
  if (alarming) { stopAlarm(); return; }   // 알람 중엔 터치 = 알람 끄기
  if (grounded) { mode = 'idle'; idleUntil = Date.now() + 1800; }
  const now = Date.now();
  if (now - lastPetSayT > 1500) { lastPetSayT = now; personaSay(Math.random() < 0.7 ? 'pet' : 'happy'); }
});

function createWindow() {
  const firstRun = !started && !fs.existsSync(INIT_FLAG);
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    icon: IS_WIN ? path.join(__dirname, 'icon.ico') : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setContentProtection(captureHidden); } catch {}   // 스크린샷/녹화에서 펫 제외

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('set-skin', skin);
    if (!started) {                 // 게임 루프/타이머는 최초 1회만
      started = true;
      startRoaming();
      if (firstRun) setTimeout(() => petSay('안녕! 난 도트야 🧡 날 우클릭하면 메뉴가 나와!'), 8000);
    }
  });
  // 렌더러가 죽으면(잠금/디스플레이 전환 등) 자동 복구
  win.webContents.on('render-process-gone', () => { try { if (!win.isDestroyed()) win.reload(); } catch {} });
  win.webContents.on('unresponsive', () => { try { if (!win.isDestroyed()) win.reload(); } catch {} });
  win.loadFile('index.html');

  // 트레이 아이콘 (한 번만 생성)
  if (!tray) {
    try {
      tray = new Tray(path.join(__dirname, 'tray.png'));
      tray.setToolTip('도트');
      tray.on('click', () => tray.popUpContextMenu());
    } catch { /* 아이콘 없으면 트레이 생략 */ }
  }
  refreshTray();

  // 잠금/해제 감지 + 자동실행 등록 (한 번만)
  if (!powerHooked) {
    powerHooked = true;
    try {
      powerMonitor.on('lock-screen', () => { locked = true; });
      powerMonitor.on('unlock-screen', () => {
        locked = false; grounded = false;
        try {
          if (!win || win.isDestroyed()) createWindow();
          else { win.reload(); win.setAlwaysOnTop(true, 'screen-saver'); }   // 해제 후 펫 다시 그리기
        } catch {}
      });
    } catch {}
    if (!fs.existsSync(INIT_FLAG)) {
      setAutoLaunch(true);
      try { fs.writeFileSync(INIT_FLAG, 'on'); } catch {}
    }
  }
}

// ── 중복 실행 방지 ──────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    initPaths();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();   // 맥: 독 아이콘 숨김(트레이로 접근)
    createWindow();
    // 워치독: 창이 사라지면 다시 생성 (잠금/충돌에도 상시 유지)
    setInterval(() => { if (!app.isQuitting && (!win || win.isDestroyed())) createWindow(); }, 5000);
  });
  // 창이 닫혀도 앱은 종료하지 않음 (메뉴 '종료'로만 종료) — 워치독이 다시 띄움
  app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); });
  app.on('child-process-gone', () => {});   // GPU 등 보조 프로세스 죽어도 앱 유지
}
