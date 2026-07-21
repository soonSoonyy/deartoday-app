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

## 프로덕션으로 가기 전에 고려할 것

이 스캐폴드는 로컬 실행 기준의 프로토타입이에요. 실제 서비스로 배포하려면:

- `backend/data/diary-data.json` → 암호화된 실제 DB(PostgreSQL 등)로 교체
- 사용자 인증/로그인 추가 (지금은 기기 구분 없이 데이터가 하나로 합쳐져요)
- HTTPS, 배포 환경의 환경변수 관리(예: Groq API 키를 시크릿 매니저에 보관)
- Groq API의 데이터 사용/보관 정책 검토 (기업용 계약 시 옵션 확인)
