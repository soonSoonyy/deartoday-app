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
- 아래 "일기 데이터 영구 보존(Supabase)"을 설정하지 않으면, 서버가 재시작될 때 로컬 파일에 저장된 일기가 초기화될 수 있어요.

## 일기 데이터 영구 보존 (Supabase)

기본적으로 일기는 서버의 로컬 JSON 파일에 저장되는데, Render 무료 플랜은 재배포·재시작 때 디스크가 초기화돼서 데이터가 사라질 수 있어요. `DATABASE_URL` 환경변수에 PostgreSQL 연결 문자열을 넣으면, 파일 대신 **DB에 저장되어 재배포해도 데이터가 그대로 유지**돼요. (Supabase 무료 등급이면 충분해요.)

1. https://supabase.com 에 가입하고 **New project** 로 프로젝트를 하나 만들어요. (DB 비밀번호는 따로 적어둬요.)
2. 프로젝트의 **Project Settings → Database → Connection string** 에서 **URI** 형식을 복사해요. (`postgresql://postgres:...@...supabase.co:5432/postgres` 형태)
   - 문자열 안의 `[YOUR-PASSWORD]` 부분을 1번에서 정한 실제 비밀번호로 바꿔요.
   - 서버리스가 아닌 상시 실행 서버라 직접 연결(5432)로 충분하지만, 연결 수 제한이 걱정되면 같은 화면의 **Connection pooling** URI를 써도 돼요.
3. Render 서비스의 **Environment** 탭에 `DATABASE_URL` 키로 이 문자열을 넣고 저장해요.
4. 재배포되면 서버가 **테이블(`deartoday_state`)을 자동으로 만들어요.** SQL을 직접 실행할 필요는 없어요. 로그에 `저장소: Postgres(DB) 연결됨` 이 보이면 성공이에요.

> 로컬 개발에서는 `DATABASE_URL` 을 설정하지 않으면 예전처럼 `backend/data/diary-data.json` 파일에 저장돼요. DB 없이도 그대로 돌아가요.

## 프로덕션으로 가기 전에 고려할 것

이 스캐폴드는 로컬 실행 기준의 프로토타입이에요. 실제 서비스로 배포하려면:

- 일기 데이터는 위 "Supabase" 방식으로 DB에 저장 (민감 정보라면 저장 시 암호화도 검토)
- 사용자 인증/로그인 추가 (지금은 기기 구분 없이 데이터가 하나로 합쳐져요)
- HTTPS, 배포 환경의 환경변수 관리(예: API 키를 시크릿 매니저에 보관)
- LLM API의 데이터 사용/보관 정책 검토 (기업용 계약 시 옵션 확인)
