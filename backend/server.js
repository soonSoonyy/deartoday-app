import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'diary-data.json');
const PORT = process.env.PORT || 4000;

// 어떤 LLM 제공자를 쓸지는 코드가 아니라 .env의 LLM_PROVIDER 값으로 결정함 ('groq' | 'gemini').
// 두 제공자 구현을 모두 코드에 남겨두고, 여기서 하나만 골라 쓰는 스위치 역할만 함.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 검수용 2차 LLM 호출(자연스러움/한국어 교정)을 건너뛰는 모드. API 호출 수와
// 응답 시간이 절반으로 줄어서, 무료 등급 한도가 빠듯할 때 특히 중요함.
// 기본으로 켜두고, 검수까지 되살리고 싶으면 환경변수 FAST_MODE=false 로 끄면 됨.
// 문자 오염을 걸러내는 결정적 필터(stripNonKorean 등)는 모드와 무관하게 항상 동작함.
const FAST_MODE = !/^(0|false|no)$/i.test(process.env.FAST_MODE || '');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ babyName: '', entries: {} }, null, 2));
}

if (LLM_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  console.warn('\n⚠️  LLM_PROVIDER=gemini인데 GEMINI_API_KEY가 설정되어 있지 않아요.');
  console.warn('   backend/.env 에 GEMINI_API_KEY를 채워넣어줘.\n');
} else if (LLM_PROVIDER !== 'gemini' && !GROQ_API_KEY) {
  console.warn('\n⚠️  GROQ_API_KEY가 설정되어 있지 않아요.');
  console.warn('   backend/.env.example 을 backend/.env 로 복사하고 키를 채워넣어줘.\n');
}

const app = express();
app.use(cors());
app.use(express.json());

function chatSystemPrompt(babyName) {
  const name = babyName || '아기';
  return `너는 사용자의 절친한 친구야. 사용자는 ${name}를 키우는 부모이고, 아기를 재운 뒤 밤에 하루를 돌아보며 너랑 카톡하듯 편하게 대화하는 중이야.
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

function diarySystemPrompt(babyName) {
  const name = babyName || '아가';
  return `다음은 부모와 나눈, 오늘 하루 ${name}에 대한 대화 내용이야. 이 내용을 바탕으로 엄마가 ${name}에게 쓰는 편지 형식의 하루 일기를 작성해줘.

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

async function callGemini(systemPrompt, messages, temperature) {
  if (!GEMINI_API_KEY) {
    throw new Error('서버에 GEMINI_API_KEY가 설정되어 있지 않아요.');
  }
  while (true) {
    const generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...GEMINI_THINKING_CONFIGS[geminiThinkingIndex]
    };
    const response = await fetchWithRetry(() => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
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
      throw new Error(`Gemini API 오류 (${response.status}): ${errText}`);
    }
    const data = await response.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
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

// ---- 데이터 저장/조회 (다이어리 텍스트, 대화 전부 포함된 하나의 JSON 블롭) ----
app.get('/api/data', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: '데이터를 불러오지 못했어요.' });
  }
});

app.post('/api/data', (req, res) => {
  try {
    const { babyName, entries } = req.body || {};
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ babyName: babyName || '', entries: entries || {} }, null, 2)
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '데이터를 저장하지 못했어요.' });
  }
});

// ---- 채팅 답장 ----
app.post('/api/chat', async (req, res) => {
  try {
    const { babyName, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages가 비어있어요.' });
    }
    const draft = await callModelKorean(chatSystemPrompt(babyName), messages, { babyName });
    const reply = await naturalizeReply(draft, messages, babyName);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 일기(편지) 생성 ----
app.post('/api/diary', async (req, res) => {
  try {
    const { babyName, content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content가 비어있어요.' });
    const draft = await callModelKorean(diarySystemPrompt(babyName), [{ role: 'user', content }], { babyName });
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

app.listen(PORT, () => {
  console.log(`✅ 백엔드 서버 실행 중: http://localhost:${PORT}`);
});
