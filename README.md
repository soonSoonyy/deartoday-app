# 오늘의 편지 — 육아 일기장

친구와 대화하듯 오늘 하루를 이야기하면, 그 대화를 바탕으로 엄마가 아기에게 쓰는 편지 형식의 일기를 자동으로 완성해주는 앱이에요.
캘린더로 지난 편지들을 모아볼 수 있어요.

이 프로젝트는 Claude 아티팩트 프로토타입을 **백엔드 + 프론트엔드가 분리된 실제 웹앱 구조**로 옮긴 버전이에요.

## 왜 이렇게 나눴나요

프로토타입(아티팩트) 단계의 한계였던 API 키 노출 문제 때문이에요.
브라우저에서 직접 Groq API를 호출하면 키가 클라이언트 코드에 그대로 보여요.
→ 이제는 `backend/`에서만 키를 쓰고, 프론트엔드는 `/api/chat`, `/api/diary`를 통해서만 호출해요.

## 프로젝트 구조

```
parenting-diary-app/
├── backend/          Node.js + Express API 서버
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── data/          diary-data.json 이 저장되는 곳 (자동 생성)
└── frontend/         React + Vite 앱
    ├── src/
    │   ├── App.jsx
    │   ├── main.jsx
    │   └── styles.css
    ├── index.html
    └── package.json
```

## 실행 방법

### 1. 백엔드 (API 서버)

```bash
cd backend
npm install
cp .env.example .env
```

`.env` 파일을 열어서 `GROQ_API_KEY`에 본인의 Groq API 키를 넣어주세요.
(키는 https://console.groq.com/keys 에서 발급받을 수 있어요.)

```bash
npm start
```

`http://localhost:4000` 에서 서버가 실행돼요.

### 2. 프론트엔드 (React 앱)

새 터미널을 열고:

```bash
cd frontend
npm install
npm run dev
```

`http://localhost:5173` 에서 앱이 열려요. 개발 서버가 `/api/*` 요청을 자동으로 백엔드(4000번 포트)로 전달해줘요 (`vite.config.js`의 proxy 설정).

## 주요 기능

- **대화형 일기 작성**: 친구처럼 반말로 오늘 하루를 물어보고, 답변을 모아 한 번에 AI 답장을 받아요 ("답장 받기" 버튼).
- **캘린더**: 하트가 있는 날짜를 누르면 그날의 편지를 다시 볼 수 있어요.
- **개인정보 패널**: 데이터가 어떻게 저장/전송되는지 안내하고, 전체 삭제 기능을 제공해요.

## 모바일에서 보기 (Render 배포)

이 저장소에는 `render.yaml` 배포 설정이 포함되어 있어서, 계정 연결만 하면 바로 배포돼요.

1. https://render.com 에 가입/로그인하고 GitHub 계정을 연결해요.
2. 대시보드에서 **New → Blueprint** 를 누르고 이 저장소(`deartoday-app`)를 선택해요.
3. 브랜치를 고르라고 하면 배포하려는 브랜치를 선택해요.
4. `GROQ_API_KEY` 값을 입력하라고 나오면 본인의 Groq API 키를 넣어요. (https://console.groq.com/keys)
5. **Apply** 를 누르면 몇 분 뒤 `https://deartoday-xxxx.onrender.com` 같은 주소가 생겨요. 이 주소를 폰 브라우저에서 열면 돼요.

배포된 서버는 백엔드 하나가 API와 빌드된 프론트엔드 화면을 함께 제공해요 (`backend/server.js`가 `frontend/dist`를 서빙).

무료 플랜 참고사항:

- 15분간 접속이 없으면 서버가 잠들었다가 다시 깨어나요. 첫 접속이 30초~1분 정도 느릴 수 있어요.
- 디스크가 영구 보존되지 않아서, 서버가 재시작되면 `diary-data.json`에 저장된 일기 데이터가 초기화될 수 있어요. 오래 쓰려면 아래 "프로덕션으로 가기 전에" 항목처럼 실제 DB로 바꾸는 게 좋아요.

## 프로덕션으로 가기 전에 고려할 것

이 스캐폴드는 로컬 실행 기준의 프로토타입이에요. 실제 서비스로 배포하려면:

- `backend/data/diary-data.json` → 암호화된 실제 DB(PostgreSQL 등)로 교체
- 사용자 인증/로그인 추가 (지금은 기기 구분 없이 데이터가 하나로 합쳐져요)
- HTTPS, 배포 환경의 환경변수 관리(예: Groq API 키를 시크릿 매니저에 보관)
- Groq API의 데이터 사용/보관 정책 검토 (기업용 계약 시 옵션 확인)
