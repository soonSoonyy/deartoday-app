import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'diary-data.json');
const PORT = process.env.PORT || 4000;

// 저장소 선택: DATABASE_URL(예: Supabase 연결 문자열)이 있으면 Postgres에 저장하고,
// 없으면 로컬 JSON 파일에 저장함. 둘 다 사용자별 계정/일기를 지원함.
const DATABASE_URL = process.env.DATABASE_URL;
const USE_DB = !!DATABASE_URL;

// ---- 인증 관련 설정 ----
// JWT 서명 키. 운영에서는 반드시 환경변수로 지정해야 하고, 없으면 임시 키로 동작하되 경고함.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const JWT_TTL = '30d'; // 로그인 유지 기간
const COOKIE_NAME = 'deartoday_token';
// OAuth 콜백 주소를 만들 때 쓰는 앱의 공개 베이스 URL (예: https://deartoday-xxx.onrender.com).
// 로컬에서는 http://localhost:4000. 뒤 슬래시는 떼서 보관.
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// 구글/카카오 OAuth 앱 자격증명(각 개발자 콘솔에서 발급). 없으면 해당 버튼만 비활성화됨.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET; // 카카오는 선택(보안 강화용)
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const KAKAO_ENABLED = !!KAKAO_REST_API_KEY;

// 어떤 LLM 제공자를 쓸지는 코드가 아니라 .env의 LLM_PROVIDER 값으로 결정함 ('groq' | 'gemini').
// 두 제공자 구현을 모두 코드에 남겨두고, 여기서 하나만 골라 쓰는 스위치 역할만 함.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// 무료 한도는 모델별로 따로 계산되므로, 주 모델이 한도(429)에 걸리면 아직 한도가
// 남아있는 다른 Gemini 모델로 자동 전환함. Groq로 넘어가지 않아 한국어 품질이 유지됨.
// 주 모델과 같은 값이면 폴백을 끔(무의미한 중복 호출 방지).
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 검수용 2차 LLM 호출(자연스러움/한국어 교정)을 건너뛰는 모드. API 호출 수와
// 응답 시간이 절반으로 줄어서, 무료 등급 한도가 빠듯할 때 특히 중요함.
// 기본으로 켜두고, 검수까지 되살리고 싶으면 환경변수 FAST_MODE=false 로 끄면 됨.
// 문자 오염을 걸러내는 결정적 필터(stripNonKorean 등)는 모드와 무관하게 항상 동작함.
const FAST_MODE = !/^(0|false|no)$/i.test(process.env.FAST_MODE || '');

const EMPTY_DATA = { babyName: '', babyGender: '', entries: {} };

// ---- 저장소 계층: 사용자(users) + 사용자별 일기(diaries) ----
// DB 모드(Postgres/Supabase)와 파일 모드(JSON) 둘 다 지원함.
// 파일 모드 구조: { users: [ {id, email, passwordHash, provider, providerId, displayName, createdAt} ],
//                   diaries: { [userId]: { babyName, babyGender, entries } } }

let pool = null;
let fileDb = null; // 파일 모드일 때 메모리에 올려두는 전체 데이터

function readFileDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { users: parsed.users || [], diaries: parsed.diaries || {} };
  } catch {
    return { users: [], diaries: {} };
  }
}
function writeFileDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(fileDb, null, 2));
}

async function initStorage() {
  if (USE_DB) {
    // Supabase 같은 관리형 DB는 SSL 연결을 요구함(관리형 인증서라 체인 검증 없이 암호화만 사용).
    // 로컬/사설 Postgres는 보통 SSL이 없어 연결이 실패하므로, localhost 연결에서만 SSL을 끔.
    const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false }
    });
    // 서버가 켜질 때 테이블을 자동으로 만들어, 사용자가 SQL을 따로 실행할 필요 없음.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        provider TEXT NOT NULL DEFAULT 'local',
        provider_id TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // 같은 소셜 제공자+계정ID 조합은 유일해야 함(중복 가입 방지).
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_provider_uidx ON users (provider, provider_id) WHERE provider_id IS NOT NULL;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diaries (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        baby_name TEXT NOT NULL DEFAULT '',
        baby_gender TEXT NOT NULL DEFAULT '',
        entries JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log('✅ 저장소: Postgres(DB) 연결됨 — 계정/일기가 사용자별로 영구 보존돼요.');
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fileDb = readFileDb();
    writeFileDb();
    console.log('ℹ️  저장소: 로컬 파일(diary-data.json) — DATABASE_URL이 없어 파일에 저장해요.');
  }
}

// ---- 사용자 조회/생성 ----
function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email || '', passwordHash: r.password_hash || null,
    provider: r.provider, providerId: r.provider_id || null,
    displayName: r.display_name || '', createdAt: r.created_at
  };
}

async function findUserByEmail(email) {
  const key = (email || '').trim().toLowerCase();
  if (!key) return null;
  if (USE_DB) {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1;', [key]);
    return rowToUser(rows[0]);
  }
  return fileDb.users.find(u => (u.email || '').toLowerCase() === key) || null;
}

async function findUserByProvider(provider, providerId) {
  if (USE_DB) {
    const { rows } = await pool.query('SELECT * FROM users WHERE provider = $1 AND provider_id = $2 LIMIT 1;', [provider, String(providerId)]);
    return rowToUser(rows[0]);
  }
  return fileDb.users.find(u => u.provider === provider && String(u.providerId) === String(providerId)) || null;
}

async function getUserById(id) {
  if (USE_DB) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1;', [id]);
    return rowToUser(rows[0]);
  }
  return fileDb.users.find(u => String(u.id) === String(id)) || null;
}

async function createUser({ email = null, passwordHash = null, provider = 'local', providerId = null, displayName = '' }) {
  const mail = email ? email.trim().toLowerCase() : null;
  if (USE_DB) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, provider, provider_id, display_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING *;`,
      [mail, passwordHash, provider, providerId ? String(providerId) : null, displayName || '']
    );
    return rowToUser(rows[0]);
  }
  const user = {
    id: (fileDb.users.reduce((m, u) => Math.max(m, u.id), 0) || 0) + 1,
    email: mail, passwordHash, provider, providerId: providerId ? String(providerId) : null,
    displayName: displayName || '', createdAt: new Date().toISOString()
  };
  fileDb.users.push(user);
  writeFileDb();
  return user;
}

// ---- 사용자별 일기 조회/저장 ----
async function loadData(userId) {
  if (USE_DB) {
    const { rows } = await pool.query('SELECT baby_name, baby_gender, entries FROM diaries WHERE user_id = $1;', [userId]);
    if (rows.length === 0) return { ...EMPTY_DATA };
    return { babyName: rows[0].baby_name || '', babyGender: rows[0].baby_gender || '', entries: rows[0].entries || {} };
  }
  return { ...EMPTY_DATA, ...(fileDb.diaries[userId] || {}) };
}

async function saveDataStore(userId, babyName, babyGender, entries) {
  const name = babyName || '';
  const gender = babyGender || '';
  const items = entries || {};
  if (USE_DB) {
    await pool.query(
      `INSERT INTO diaries (user_id, baby_name, baby_gender, entries, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (user_id) DO UPDATE SET baby_name = $2, baby_gender = $3, entries = $4, updated_at = now();`,
      [userId, name, gender, JSON.stringify(items)]
    );
    return;
  }
  fileDb.diaries[userId] = { babyName: name, babyGender: gender, entries: items };
  writeFileDb();
}

if (LLM_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  console.warn('\n⚠️  LLM_PROVIDER=gemini인데 GEMINI_API_KEY가 설정되어 있지 않아요.');
  console.warn('   backend/.env 에 GEMINI_API_KEY를 채워넣어줘.\n');
} else if (LLM_PROVIDER !== 'gemini' && !GROQ_API_KEY) {
  console.warn('\n⚠️  GROQ_API_KEY가 설정되어 있지 않아요.');
  console.warn('   backend/.env.example 을 backend/.env 로 복사하고 키를 채워넣어줘.\n');
}

if (JWT_SECRET === 'dev-insecure-secret-change-me') {
  console.warn('\n⚠️  JWT_SECRET이 설정되지 않아 임시 키로 동작해요. 운영에서는 반드시 .env에 JWT_SECRET을 지정해줘.\n');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ---- 인증 유틸 ----
// 로그인 상태는 서명된 JWT를 httpOnly 쿠키에 담아 유지함(자바스크립트로 토큰을 훔칠 수 없음).
function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: JWT_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: APP_BASE_URL.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: APP_BASE_URL.startsWith('https://') });
}

function publicUser(user) {
  // 비밀번호 해시 등 민감 정보는 빼고 프론트에 내려줌.
  return { id: user.id, email: user.email, displayName: user.displayName, provider: user.provider };
}

// 요청 쿠키의 JWT를 검증해 req.userId를 채움. 없거나 유효하지 않으면 401.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: '로그인이 필요해요.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.uid);
    if (!user) return res.status(401).json({ error: '로그인이 필요해요.' });
    req.user = user;
    req.userId = user.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: '로그인이 필요해요.' });
  }
}

// 성별 값('boy'|'girl'|'')을 프롬프트에 넣을 한 줄 안내로 바꿈. 값이 없으면 빈 문자열.
function genderNote(name, babyGender) {
  if (babyGender === 'boy') return `\n- ${name}는 남자아이(아들)야. 필요하면 자연스럽게 아들로 지칭해도 좋아.`;
  if (babyGender === 'girl') return `\n- ${name}는 여자아이(딸)야. 필요하면 자연스럽게 딸로 지칭해도 좋아.`;
  return '';
}

function chatSystemPrompt(babyName, babyGender) {
  const name = babyName || '아기';
  return `너는 사용자의 절친한 친구야. 사용자는 ${name}를 키우는 부모이고, 아기를 재운 뒤 밤에 하루를 돌아보며 너랑 카톡하듯 편하게 대화하는 중이야.${genderNote(name, babyGender)}
- 반드시 한국어로만 답해. 다른 언어나 문자는 섞지 마
- 친구 같은 어투로 완전 반말을 사용해
- 욕설, 비속어, 과격한 말은 절대 사용하지 마
- 말동무처럼, 진짜 사람이 대화하듯 자연스럽게 반응해
- 길게 설명하지 말고 짧게 1~2문장으로 답해. 먼저 간단히 공감해주고, 다음 말을 자연스럽게 이어갈 수 있게 짧은 질문이나 리액션으로 유도해줘
- 이미 하루가 끝난 시점이니 "지금 뭐 해?", "지금은 좀 어때?"처럼 현재 상태를 묻지 말고, 오늘 있었던 일을 돌아보는 질문을 해
- 질문은 하루의 시간 흐름을 따라가: 아침(잘 잤는지, 아침밥) → 낮(놀이, 낮잠, 외출) → 저녁(저녁밥, 목욕, 재우기) 순서로 자연스럽게 이어가
- 부모가 이미 얘기한 시간대는 다시 묻지 말고, 그 얘기에 공감한 뒤 다음 시간대로 자연스럽게 넘어가
- 재우기 얘기까지 나왔으면 하루를 마친 부모의 기분을 물어보며 대화를 부드럽게 마무리해도 좋아
- 부모가 주어를 생략하고 말하면(예: "오늘 신나게 놀았어"), 문맥상 명백히 부모 얘기가 아닌 이상 그 문장의 주어를 ${name}로 우선 이해하고 반응해`;
}

function diarySystemPrompt(babyName, babyGender) {
  const name = babyName || '아가';
  return `다음은 부모와 나눈, 오늘 하루 ${name}에 대한 대화 내용이야. 이 내용을 바탕으로 엄마가 ${name}에게 쓰는 편지 형식의 하루 일기를 작성해줘.${genderNote(name, babyGender)}

규칙:
- 반드시 한국어로만 쓸 것. 일본어, 영어, 한자 등 다른 언어나 문자는 단 한 글자도 섞지 말 것
- "${name}에게,"로 시작할 것
- 대화에서 언급된 구체적인 사건과 감정을 자연스럽게 녹여 쓸 것
- 존댓말이 아니라, 엄마가 아이에게 다정하게 말하듯 완전 반말로 쓸 것 (예: "오늘 낮잠을 푹 잤다며~", "엄마는 그 얘기 듣고 너무 웃겼어")
- 딱딱하거나 격식 있는 편지체 표현은 쓰지 말고, 다정하고 포근한 말투를 유지할 것
- 욕설, 비속어, 거친 표현은 절대 쓰지 말 것
- "죽는다", "때린다" 같은 폭력적·과격한 표현은 절대 쓰지 말 것
- 400자 내외로 작성할 것
- 마지막 줄은 "사랑을 담아, 엄마가"로 끝맺을 것
- 다른 설명이나 코멘트 없이 편지 본문만 출력할 것`;
}

function diaryLanguageCheckSystemPrompt() {
  return `너는 한국어 교정가야. 아래 글은 엄마가 아기에게 쓴 편지 형식의 일기 초안이야.
- 결과는 반드시 한국어로만 써. 일본어, 영어, 한자 등 다른 언어나 문자가 섞여 있으면 전부 자연스러운 한국어 표현으로 바꿔
- 욕설, 비속어나 "죽는다", "때린다" 같은 폭력적·과격한 표현이 있으면 순하고 따뜻한 표현으로 고쳐 써
- 편지의 문장 구조, 다정한 반말 어투, 줄바꿈은 최대한 그대로 유지하고 내용을 새로 창작하지 마
- 이미 한국어로만 되어 있고 순화된 표현이라면 그대로 둬
- 결과로 편지 본문만 바로 써. 설명이나 코멘트는 절대 붙이지 마
- 절대로 "원문 -> 수정본"처럼 교정 과정이나 화살표(->, →)를 보여주지 마
- "답장:", "편지:", "결과:" 같은 라벨이나 접두사를 앞에 붙이지 말고, 편지 본문 텍스트로 바로 시작해`;
}

function naturalCheckSystemPrompt() {
  return `너는 한국어 구어체 감수자야. 아래에 지금까지의 대화 흐름과, 그 다음에 친구가 보내려는 답장 초안이 주어져.
- 결과는 반드시 한국어로만 써. 초안에 일본어, 영어, 한자 등 다른 언어나 문자가 섞여 있으면 전부 자연스러운 한국어로 바꿔
- 실제 한국 사람이 친구끼리 문자할 때 정말 쓰는 자연스러운 표현인지 검토해
- 번역체, 어색한 표현, AI가 쓸 법한 딱딱한 말투, 실제로는 잘 안 쓰는 단어가 있으면 진짜 사람이 쓸 법한 자연스러운 구어체로 고쳐 써
- 욕설, 비속어나 "죽는다", "때린다" 같은 폭력적·과격한 표현이 있으면(농담·과장 포함) 순한 표현으로 고쳐 써
- 초안이 대화 흐름과 안 맞거나, 방금 나온 얘기와 동떨어진 뜬금없는 반응이면 대화 흐름에 맞게 자연스럽게 고쳐 써
- 초안이 공감 + 일반론(속담, "다들 그렇대" 같은 남 얘기) + 바람 등 여러 생각을 한 문장에 욱여넣어서 장황하거나 문법이 꼬여 있으면, 그중 가장 자연스러운 생각 하나만 남기고 나머지는 과감히 쳐내
- 이미 자연스럽고 한국어로만 되어 있고, 순화된 표현이고, 대화 흐름에도 맞다면 그대로 둬
- 결과로 답장 문장만 바로 써. 설명·따옴표·코멘트는 절대 붙이지 마
- 절대로 "초안 -> 수정본"처럼 교정 과정이나 화살표(->, →)를 보여주지 마
- "답장:", "최종답장:", "결과:" 같은 라벨이나 접두사를 앞에 붙이지 말고, 답장 텍스트로 바로 시작해`;
}

// 모델 혼잡("high demand", 503 등)은 보통 몇 초 안에 풀리는 일시 현상이라,
// 바로 실패로 돌려주지 않고 짧게 기다렸다가 두 번 더 시도함.
// 429(한도 초과)는 재시도하지 않음 — 몇 초 기다려도 풀리지 않는 데다,
// 재시도 요청 자체가 무료 한도를 더 깎아먹는 역효과만 있음.
const RETRYABLE_STATUS = new Set([500, 502, 503]);
const RETRY_DELAYS_MS = [2000, 5000];

async function fetchWithRetry(doFetch) {
  let response = await doFetch();
  for (const delay of RETRY_DELAYS_MS) {
    if (!RETRYABLE_STATUS.has(response.status)) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    response = await doFetch();
  }
  return response;
}

function toGroqMessages(systemPrompt, messages) {
  return [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content || '' }))
  ];
}

async function callGroq(systemPrompt, messages, temperature) {
  if (!GROQ_API_KEY) {
    throw new Error('서버에 GROQ_API_KEY가 설정되어 있지 않아요.');
  }
  const response = await fetchWithRetry(() => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1000,
      ...(temperature !== undefined ? { temperature } : {}),
      messages: toGroqMessages(systemPrompt, messages)
    })
  }));
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API 오류 (${response.status}): ${errText}`);
  }
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Gemini는 system 메시지가 따로 없이 system_instruction으로 받고, 대화 role도
// 'assistant'가 아니라 'model'이라 형식이 달라서 별도로 변환해서 호출함.
function toGeminiContents(messages) {
  return (messages || []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }]
  }));
}

// Gemini 2.5부터는 답을 내기 전에 내부 추론('생각')을 먼저 하는 게 기본이라
// 짧은 답장에도 수십 초씩 걸릴 수 있음. 이 앱은 카톡처럼 빠른 반응이 중요해서
// 생각 기능을 최소로 낮춤. 다만 설정 필드가 모델 세대마다 달라서
// (3.x: thinkingLevel, 2.5: thinkingBudget) 순서대로 시도하고,
// 모델이 거부(400)하면 다음 후보로 넘어간 뒤 성공한 설정을 기억해둠.
const GEMINI_THINKING_CONFIGS = [
  { thinkingConfig: { thinkingLevel: 'low' } },
  { thinkingConfig: { thinkingBudget: 0 } },
  {}
];
let geminiThinkingIndex = 0;

async function callGeminiModel(model, systemPrompt, messages, temperature) {
  if (!GEMINI_API_KEY) {
    throw new Error('서버에 GEMINI_API_KEY가 설정되어 있지 않아요.');
  }
  while (true) {
    const generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...GEMINI_THINKING_CONFIGS[geminiThinkingIndex]
    };
    const response = await fetchWithRetry(() => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: toGeminiContents(messages),
          ...(Object.keys(generationConfig).length ? { generationConfig } : {})
        })
      }
    ));
    if (response.status === 400 && geminiThinkingIndex < GEMINI_THINKING_CONFIGS.length - 1) {
      geminiThinkingIndex++;
      continue;
    }
    if (!response.ok) {
      const errText = await response.text();
      // 상태 코드를 에러에 실어, 상위(callGemini)에서 429(한도 초과)를 구분해 폴백 판단.
      const err = new Error(`Gemini API 오류 (${response.status}): ${errText}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  }
}

// 주 Gemini 모델을 먼저 쓰고, 한도 초과(429)일 때만 예비 Gemini 모델로 전환함.
// 예비 모델도 무료 등급이라 결국 같은 종류의 답을 주니 한국어 품질은 유지됨.
async function callGemini(systemPrompt, messages, temperature) {
  try {
    return await callGeminiModel(GEMINI_MODEL, systemPrompt, messages, temperature);
  } catch (e) {
    const canFallback = e.status === 429 && GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL;
    if (!canFallback) throw e;
    console.warn(`Gemini 주 모델(${GEMINI_MODEL}) 한도 초과, 예비 모델(${GEMINI_FALLBACK_MODEL})로 전환함`);
    return callGeminiModel(GEMINI_FALLBACK_MODEL, systemPrompt, messages, temperature);
  }
}

// LLM_PROVIDER 설정값에 따라 Groq/Gemini 중 실제로 호출할 제공자를 고름.
// 나머지 코드는 어떤 제공자를 쓰는지 몰라도 되게 이 함수 하나만 거쳐서 호출함.
// 주 제공자가 재시도까지 하고도 실패했을 때(혼잡, 한도 소진 등), 다른 제공자의
// 키가 설정되어 있으면 그쪽으로 한 번 더 시도해서 앱이 아예 멈추는 걸 막음.
async function callModel(systemPrompt, messages, temperature) {
  const useGemini = LLM_PROVIDER === 'gemini';
  const primary = useGemini ? callGemini : callGroq;
  const fallback = useGemini ? callGroq : callGemini;
  const fallbackKey = useGemini ? GROQ_API_KEY : GEMINI_API_KEY;
  try {
    return await primary(systemPrompt, messages, temperature);
  } catch (e) {
    if (!fallbackKey) throw e;
    console.warn(`주 제공자(${LLM_PROVIDER}) 호출 실패, 예비 제공자로 재시도함: ${e.message}`);
    return fallback(systemPrompt, messages, temperature);
  }
}

// 모델이 확률적으로 답장/일기 초안 자체에 한자·일본어·러시아어 등 엉뚱한 문자나,
// 키보드 배열이 꼬인 듯한 라틴 문자 토막(예: "eoq", "帯", "отдых")을 섞어 넣을 때가 있음.
// "한국어만, 영어 한 글자도 섞지 마"가 원칙이라 아기 이름을 뺀 나머지 부분에 라틴 문자가
// 남아있으면 그것도 오염으로 보고, 문자열을 잘라내는 대신 아예 다시 생성해서 받음
// (잘라내면 단어가 끊겨 더 어색해짐).
function hasForeignScript(text, babyName) {
  const t = text || '';
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Arabic}\p{Script=Hebrew}]/u.test(t)) {
    return true;
  }
  const withoutName = babyName ? t.split(babyName).join('') : t;
  return /[A-Za-z]{2,}/.test(withoutName);
}

// maxRetries 기본값을 1로 둠: 외국 문자 오염은 드문 편이고, 재생성 한 번이면
// 대부분 해결되는데 두 번씩 다시 만들면 무료 API 한도를 너무 빨리 소모함.
// (그래도 남는 오염은 stripNonKorean 등 결정적 필터가 마지막에 걸러냄)
async function callModelKorean(systemPrompt, messages, { temperature, maxRetries = 1, babyName = '' } = {}) {
  let result = await callModel(systemPrompt, messages, temperature);
  let attempts = 0;
  while (hasForeignScript(result, babyName) && attempts < maxRetries) {
    attempts++;
    result = await callModel(systemPrompt, messages, temperature);
  }
  return result;
}

// 재시도로도 못 걸러낸 극단적인 경우를 위한 최후의 안전망: 아기 이름이 아닌
// 라틴 문자 토큰(단어)이 남아있으면 글자만 지우지 않고 그 토큰 전체를 통째로 제거함
// (글자만 지우면 "eoq" -> "" 처럼 단어 일부만 사라져 문장이 더 이상해짐).
function stripStrayLatinWords(text, babyName) {
  return (text || '')
    .split(/(\s+)/)
    .map(token => {
      if (/^\s*$/.test(token)) return token;
      const withoutName = babyName ? token.split(babyName).join('') : token;
      return /[A-Za-z]{2,}/.test(withoutName) ? '' : token;
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// 검수 LLM이 프롬프트로 지시한 문구를 그대로 라벨처럼 앞에 붙여버릴 때가 있어서
// (예: "최종답장: 그랬구나 힘들었겠다"), 흔한 라벨 패턴은 맨 앞에서만 걷어냄.
// (본문 중간에 우연히 같은 글자가 나올 수 있으니 첫 줄에만 적용)
function stripLabelPrefix(text) {
  return (text || '').replace(/^["'“”]*\s*(최종\s*답장|답장|최종\s*편지|편지|최종|결과)\s*[:：]\s*/u, '').trim();
}

// 검수 LLM이 프롬프트 지시를 어기고 "원문 -> 수정본"을 여러 줄에 걸쳐 후보를 바꿔가며
// 나열하거나, 화살표 없이 설명을 덧붙인 뒤 마지막 줄에만 진짜 결과를 낼 때가 있어서
// (예: "...휴식을 뜻하는 일본어를 사용하였으므로 다음과 같이 고칠 수 있다.\n그럼 오늘은 충분히 쉬었겠네!"),
// 마지막 줄을 취하고, 그 줄에 화살표가 남아있으면 마지막 화살표 뒤의 최종본만 취함.
// 카톡 답장처럼 원래 한 줄짜리 짧은 발화에만 써야 함 — 여러 줄인 일기 본문에 쓰면
// 마지막 줄("사랑을 담아, 엄마가")만 남고 본문이 통째로 날아가버림.
function takeFinalCorrection(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : (text || '');
  const parts = lastLine.split(/->|→/);
  return stripLabelPrefix(parts[parts.length - 1].trim());
}

// LLM 교정 프롬프트만으로는 한자/일본어/힌디 등 엉뚱한 문자가 확률적으로 새어나올 때가 있어서
// (예: "엄마的心にある", "브로콜리 कड"), 마지막 안전망으로 한글·기본 라틴 문자·공용 기호·이모지만
// 남기고 그 외 문자는 결정적으로 걸러냄.
function stripNonKorean(text) {
  return (text || '')
    .replace(/[^\p{Script=Hangul}\p{Script=Latin}\p{Script=Common}\p{Emoji}\s]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// 답장 초안을 한 번 더 검토해서, 실제로 사람들이 쓰는 자연스러운 말투인지 + 대화 흐름에 맞는지 확인·교정한 뒤 보냄.
// 대화 맥락 없이 답장 문장만 따로 떼어 검토하면 흐름과 동떨어진 결과로 고쳐버릴 수 있어서, 대화 기록도 함께 넘겨줌.
async function naturalizeReply(draft, messages, babyName) {
  if (!draft) return draft;
  if (FAST_MODE) return stripStrayLatinWords(stripNonKorean(draft), babyName);
  const transcript = (messages || [])
    .map(m => `${m.role === 'user' ? '부모' : '친구'}: ${m.content || ''}`)
    .join('\n');
  const checkInput = `[지금까지의 대화]\n${transcript}\n\n[친구의 답장 초안]\n${draft}`;
  const checked = await callModelKorean(naturalCheckSystemPrompt(), [{ role: 'user', content: checkInput }], { temperature: 0.3, babyName });
  const result = stripStrayLatinWords(stripNonKorean(takeFinalCorrection(checked) || draft), babyName);
  // 카톡 답장은 원래 1~2문장으로 짧아야 하는데, 검수 모델이 후보를 여러 개 늘어놓다가
  // 마지막 줄 추출로도 못 걸러낼 만큼 길어지는 극단적인 경우엔 그냥 원래 초안을 씀.
  if (result.length > 120 && result.length > draft.length * 3) return stripStrayLatinWords(stripNonKorean(draft), babyName);
  return result || draft;
}

// 일기 초안도 한 번 더 검토해서, 다른 언어/문자가 섞여 나오지 않았는지 확인·교정한 뒤 보냄.
async function ensureKoreanDiary(draft, babyName) {
  if (!draft) return draft;
  if (FAST_MODE) return stripStrayLatinWords(stripNonKorean(draft), babyName);
  const checked = await callModelKorean(diaryLanguageCheckSystemPrompt(), [{ role: 'user', content: draft }], { temperature: 0.3, babyName });
  return stripStrayLatinWords(stripNonKorean(stripLabelPrefix(checked) || draft), babyName);
}

// ====== 인증(Authentication) 라우트 ======
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 프론트가 어떤 로그인 버튼을 보여줄지 결정하도록 활성화된 제공자 알려줌.
app.get('/api/auth/providers', (req, res) => {
  res.json({ google: GOOGLE_ENABLED, kakao: KAKAO_ENABLED, email: true });
});

// 현재 로그인한 사용자 (없으면 user: null)
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ user: null });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.uid);
    res.json({ user: user ? publicUser(user) : null });
  } catch {
    res.json({ user: null });
  }
});

// 이메일 회원가입
app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    const displayName = (req.body?.displayName || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '이메일 형식이 올바르지 않아요.' });
    if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 해요.' });
    if (await findUserByEmail(email)) return res.status(409).json({ error: '이미 가입된 이메일이에요.' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({ email, passwordHash, provider: 'local', displayName: displayName || email.split('@')[0] });
    issueSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '가입에 실패했어요.' });
  }
});

// 이메일 로그인
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    const user = await findUserByEmail(email);
    if (!user || !user.passwordHash) return res.status(401).json({ error: '이메일 또는 비밀번호가 맞지 않아요.' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: '이메일 또는 비밀번호가 맞지 않아요.' });
    issueSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '로그인에 실패했어요.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// 소셜 로그인으로 들어온 사용자를 찾거나 새로 만듦.
async function upsertOAuthUser(provider, providerId, email, displayName) {
  const existing = await findUserByProvider(provider, providerId);
  if (existing) return existing;
  // 같은 이메일을 쓰는 다른 계정이 이미 있으면 유니크 제약 충돌을 피하려고 이메일 없이 저장.
  let mail = email || null;
  if (mail && await findUserByEmail(mail)) mail = null;
  return createUser({ email: mail, provider, providerId, displayName: displayName || '' });
}

// CSRF 방지용 state를 만들어 짧은 쿠키에 저장하고, 콜백에서 대조함.
function setOAuthState(res, name) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  res.cookie(`oauth_state_${name}`, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: APP_BASE_URL.startsWith('https://') });
  return state;
}
function checkOAuthState(req, name) {
  const expected = req.cookies?.[`oauth_state_${name}`];
  return expected && req.query.state && expected === req.query.state;
}

// ---- 구글 OAuth ----
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(404).send('구글 로그인이 설정되지 않았어요.');
  const state = setOAuthState(res, 'google');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_ENABLED) return res.redirect('/?auth_error=google');
    if (!checkOAuthState(req, 'google')) return res.redirect('/?auth_error=state');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_BASE_URL}/api/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('구글 토큰 교환 실패');
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const info = await infoRes.json();
    const user = await upsertOAuthUser('google', info.id, info.email, info.name);
    issueSession(res, user);
    res.redirect('/');
  } catch (e) {
    console.error('구글 로그인 오류', e);
    res.redirect('/?auth_error=google');
  }
});

// ---- 카카오 OAuth ----
app.get('/api/auth/kakao', (req, res) => {
  if (!KAKAO_ENABLED) return res.status(404).send('카카오 로그인이 설정되지 않았어요.');
  const state = setOAuthState(res, 'kakao');
  const params = new URLSearchParams({
    client_id: KAKAO_REST_API_KEY,
    redirect_uri: `${APP_BASE_URL}/api/auth/kakao/callback`,
    response_type: 'code',
    state
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params}`);
});

app.get('/api/auth/kakao/callback', async (req, res) => {
  try {
    if (!KAKAO_ENABLED) return res.redirect('/?auth_error=kakao');
    if (!checkOAuthState(req, 'kakao')) return res.redirect('/?auth_error=state');
    const body = {
      grant_type: 'authorization_code',
      client_id: KAKAO_REST_API_KEY,
      redirect_uri: `${APP_BASE_URL}/api/auth/kakao/callback`,
      code: req.query.code
    };
    if (KAKAO_CLIENT_SECRET) body.client_secret = KAKAO_CLIENT_SECRET;
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('카카오 토큰 교환 실패');
    const infoRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const info = await infoRes.json();
    const account = info.kakao_account || {};
    const displayName = account.profile?.nickname || '카카오 사용자';
    const user = await upsertOAuthUser('kakao', info.id, account.email, displayName);
    issueSession(res, user);
    res.redirect('/');
  } catch (e) {
    console.error('카카오 로그인 오류', e);
    res.redirect('/?auth_error=kakao');
  }
});

// ---- 데이터 저장/조회 (로그인한 사용자 본인의 일기만) ----
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    res.json(await loadData(req.userId));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '데이터를 불러오지 못했어요.' });
  }
});

app.post('/api/data', requireAuth, async (req, res) => {
  try {
    const { babyName, babyGender, entries } = req.body || {};
    await saveDataStore(req.userId, babyName, babyGender, entries);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '데이터를 저장하지 못했어요.' });
  }
});

// ---- 채팅 답장 ----
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { babyName, babyGender, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages가 비어있어요.' });
    }
    const draft = await callModelKorean(chatSystemPrompt(babyName, babyGender), messages, { babyName });
    const reply = await naturalizeReply(draft, messages, babyName);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 일기(편지) 생성 ----
app.post('/api/diary', requireAuth, async (req, res) => {
  try {
    const { babyName, babyGender, content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content가 비어있어요.' });
    const draft = await callModelKorean(diarySystemPrompt(babyName, babyGender), [{ role: 'user', content }], { babyName });
    const diaryText = await ensureKoreanDiary(draft, babyName);
    res.json({ diaryText });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- 프론트엔드 정적 파일 서빙 (배포용) ----
// frontend/dist 가 빌드되어 있으면 백엔드 서버 하나로 화면 + API를 함께 제공함.
// 로컬 개발 때는 dist가 없으니 이 블록은 건너뛰고, Vite 개발 서버(5173)를 그대로 쓰면 됨.
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ 백엔드 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('❌ 저장소 초기화 실패로 서버를 시작하지 못했어요:', e.message);
    process.exit(1);
  });
