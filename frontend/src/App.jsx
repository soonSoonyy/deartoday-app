import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Heart, Calendar as CalendarIcon, MessageCircle, Send,
  ChevronLeft, ChevronRight, X, Moon, Loader2, Pencil, Sparkles,
  ShieldCheck, Trash2, RotateCcw
} from 'lucide-react';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function pad(n) { return String(n).padStart(2, '0'); }
function formatKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatNice(d) { return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`; }

// Checks whether a Korean name's last syllable has a batchim (final consonant),
// e.g. "하늘" -> true, "콩이" -> false. Used to pick the right topic particle.
function hasBatchim(str) {
  const lastChar = (str || '').trim().slice(-1);
  const code = lastChar.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return false;
  return (code - 0xAC00) % 28 !== 0;
}

// 은/는 topic particle: names ending in a batchim get "이는" (e.g. "하늘이는"),
// names ending in a vowel just get "는" (e.g. "콩이는").
function withTopicParticle(name) {
  return hasBatchim(name) ? `${name}이는` : `${name}는`;
}
function buildMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// Builds a valid alternating-role message list for the backend/API, merging any
// consecutive same-role messages (e.g. a few quick texts sent before the reply
// was requested) into a single turn.
function buildApiMessages(msgs) {
  const firstUserIdx = msgs.findIndex(m => m.role === 'user');
  if (firstUserIdx === -1) return [];
  const merged = [];
  msgs.slice(firstUserIdx).forEach(m => {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + (m.content || '');
    else merged.push({ role: m.role, content: m.content || '' });
  });
  return merged;
}

// ---- Backend calls (the Groq API key lives only on the server) ----
async function fetchData() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error('데이터를 불러오지 못했어요.');
  return res.json();
}

async function saveData(babyName, entries) {
  const res = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ babyName, entries })
  });
  if (!res.ok) throw new Error('데이터를 저장하지 못했어요.');
  return res.json();
}

async function requestChatReply(babyName, messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ babyName, messages })
  });
  if (!res.ok) throw new Error('답장을 받아오지 못했어요.');
  const data = await res.json();
  return data.reply;
}

async function requestDiary(babyName, content) {
  const res = await fetch('/api/diary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ babyName, content })
  });
  if (!res.ok) throw new Error('일기를 완성하지 못했어요.');
  const data = await res.json();
  return data.diaryText;
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState({ babyName: '', entries: {} });
  const [view, setView] = useState('chat');
  const [nameInput, setNameInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedEntryKey, setSelectedEntryKey] = useState(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  const today = new Date();
  const todayKey = formatKey(today);

  useEffect(() => {
    (async () => {
      try {
        const parsed = await fetchData();
        setData({ babyName: parsed.babyName || '', entries: parsed.entries || {} });
      } catch (e) {
        console.error(e);
      }
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    try {
      await saveData(next.babyName, next.entries);
    } catch (e) {
      console.error('저장 실패', e);
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data, view, sending]);

  // 모바일에서 키보드가 올라오면 보이는 영역(visualViewport)이 줄어드는데,
  // vh 기준 레이아웃은 그대로라 입력창이 키보드에 가려지고 화면이 위로 밀림.
  // 실제 보이는 높이를 CSS 변수(--pd-vvh)로 전달해 앱 높이를 그만큼으로 줄이고,
  // 브라우저가 페이지를 밀어올린 스크롤을 되돌린 뒤 대화는 맨 아래로 맞춰줌.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const syncHeight = () => {
      document.documentElement.style.setProperty('--pd-vvh', `${Math.round(vv.height)}px`);
      window.scrollTo(0, 0);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };
    vv.addEventListener('resize', syncHeight);
    syncHeight();
    return () => vv.removeEventListener('resize', syncHeight);
  }, []);

  const todayEntry = data.entries[todayKey] || { messages: [], diaryText: '' };

  // 오늘 대화가 비어 있으면 인사말을 자동으로 넣는 대신 선택 카드를 보여주고,
  // 사용자가 고른(또는 직접 쓴) 문구를 친구의 첫 질문으로 넣어 대화를 시작함.
  const startWithGreeting = (content) => {
    const greeting = { role: 'assistant', content };
    persist({
      ...data,
      entries: { ...data.entries, [todayKey]: { ...todayEntry, messages: [greeting] } }
    });
  };

  const handleNameSubmit = () => {
    const name = nameInput.trim();
    if (!name) return;
    persist({ ...data, babyName: name });
  };

  const handleRenameSubmit = () => {
    const name = nameInput.trim();
    if (!name) { setEditingName(false); return; }
    persist({ ...data, babyName: name });
    setEditingName(false);
  };

  // Sending only appends the message locally — it does NOT call the AI.
  // This lets the parent fix a typo or split one thought across a few messages
  // before anything gets sent off for a reply.
  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;
    setError('');
    const userMsg = { role: 'user', content: text };
    const updatedMessages = [...(todayEntry.messages || []), userMsg];
    const next = { ...data, entries: { ...data.entries, [todayKey]: { ...todayEntry, messages: updatedMessages } } };
    await persist(next);
    setInput('');
    setTimeout(() => { if (textareaRef.current) textareaRef.current.focus(); }, 0);
  };

  // Triggered by the "답장 받기" button — sends everything since the last reply in one go.
  const requestReply = async () => {
    const msgs = todayEntry.messages || [];
    if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user' || sending) return;
    setError('');
    setSending(true);
    try {
      const apiMessages = buildApiMessages(msgs);
      const reply = await requestChatReply(data.babyName, apiMessages);
      const withReply = [...msgs, { role: 'assistant', content: reply || '...' }];
      await persist({ ...data, entries: { ...data.entries, [todayKey]: { ...todayEntry, messages: withReply } } });
    } catch (e) {
      setError('지금은 답장을 받아올 수 없어. 잠시 후 다시 시도해줘.');
    } finally {
      setSending(false);
    }
  };

  const generateDiary = async () => {
    const msgs = todayEntry.messages || [];
    if (msgs.filter(m => m.role === 'user').length === 0 || generating) return;
    setGenerating(true);
    setError('');
    try {
      const transcript = msgs.map(m => {
        const who = m.role === 'user' ? '부모: ' : '친구: ';
        return who + (m.content || '');
      }).join('\n');
      const diaryText = await requestDiary(data.babyName, transcript);
      const next = { ...data, entries: { ...data.entries, [todayKey]: { ...todayEntry, diaryText, createdAt: new Date().toISOString() } } };
      await persist(next);
    } catch (e) {
      setError('일기를 완성하지 못했어. 잠시 후 다시 시도해줘.');
    } finally {
      setGenerating(false);
    }
  };

  const backToChat = () => {
    persist({ ...data, entries: { ...data.entries, [todayKey]: { ...todayEntry, diaryText: '' } } });
  };

  const deleteAllEntries = async () => {
    await persist({ ...data, entries: {} });
    setConfirmDelete(false);
    setShowPrivacy(false);
  };

  // Testing helper: wipes the backend data blob AND any browser-side storage,
  // then reloads so the app re-mounts fresh at the onboarding screen.
  const resetAppForTesting = async () => {
    try {
      await saveData('', {});
    } catch (e) {
      console.error('초기화 실패', e);
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      console.error('브라우저 저장소 초기화 실패', e);
    }
    window.location.reload();
  };

  if (loaded && !data.babyName) {
    return (
      <div className="pd-root">
        <div className="pd-onboard">
          <div className="pd-onboard-moon"><Moon size={28} /></div>
          <h1 className="pd-title">Dear, Today</h1>
          <p className="pd-sub">아가에게 쓰는 하루 이야기</p>
          <div className="pd-onboard-card">
            <p className="pd-onboard-label">아기 이름을 알려줘</p>
            <input
              className="pd-input"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              placeholder="예: 하늘이"
              onKeyDown={e => { if (e.key === 'Enter') handleNameSubmit(); }}
            />
            <button className="pd-btn-primary" onClick={handleNameSubmit}>시작하기</button>
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="pd-root">
        <div className="pd-loading"><Loader2 className="pd-spin" size={22} /></div>
      </div>
    );
  }

  const monthCells = buildMonthGrid(calYear, calMonth);
  const selectedEntry = selectedEntryKey ? data.entries[selectedEntryKey] : null;
  const entryCount = Object.keys(data.entries).filter(k => data.entries[k].diaryText).length;
  const msgsToday = todayEntry.messages || [];
  const hasPendingUserMsg = msgsToday.length > 0 && msgsToday[msgsToday.length - 1].role === 'user';

  return (
    <div className="pd-root">
      <div className="pd-phone">
        <header className="pd-header">
          <div className="pd-header-left">
            <Moon size={18} className="pd-moon-icon" />
            <div>
              <div className="pd-app-title">Dear, Today</div>
              {!editingName ? (
                <button className="pd-baby-name" onClick={() => { setNameInput(data.babyName); setEditingName(true); }}>
                  {data.babyName} <Pencil size={11} />
                </button>
              ) : (
                <input
                  className="pd-name-edit"
                  autoFocus
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(); }}
                />
              )}
            </div>
          </div>
          <div className="pd-header-right">
            <div className="pd-header-date">{formatNice(today)}</div>
            <button className="pd-privacy-btn" onClick={() => setShowPrivacy(true)}>
              <ShieldCheck size={12} /> 개인정보
            </button>
          </div>
        </header>

        <main className="pd-main" ref={scrollRef}>
          {view === 'chat' && (
            todayEntry.diaryText ? (
              <LetterCard babyName={data.babyName} dateLabel={formatNice(today)} text={todayEntry.diaryText} onBack={backToChat} />
            ) : (
              <div className="pd-chat">
                {msgsToday.length === 0 && (
                  <GreetingPicker babyName={data.babyName} onPick={startWithGreeting} />
                )}
                {(todayEntry.messages || []).map((m, i) => (
                  <div key={i} className={`pd-bubble-row ${m.role}`}>
                    <div className={`pd-bubble ${m.role}`}>
                      {m.content && <div>{m.content}</div>}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="pd-bubble-row assistant">
                    <div className="pd-bubble assistant pd-typing"><span></span><span></span><span></span></div>
                  </div>
                )}
                {error && <div className="pd-error">{error}</div>}
              </div>
            )
          )}

          {view === 'calendar' && (
            <div className="pd-calendar">
              <div className="pd-cal-nav">
                <button className="pd-icon-btn" onClick={() => {
                  const m = calMonth - 1;
                  if (m < 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m);
                }}><ChevronLeft size={18} /></button>
                <div className="pd-cal-title">{calYear}년 {calMonth + 1}월</div>
                <button className="pd-icon-btn" onClick={() => {
                  const m = calMonth + 1;
                  if (m > 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m);
                }}><ChevronRight size={18} /></button>
              </div>
              <div className="pd-cal-grid pd-cal-weekdays">
                {WEEKDAYS.map(w => <div key={w} className="pd-cal-weekday">{w}</div>)}
              </div>
              <div className="pd-cal-grid">
                {monthCells.map((d, i) => {
                  if (!d) return <div key={i} className="pd-cal-cell empty" />;
                  const key = formatKey(d);
                  const hasEntry = !!(data.entries[key] && data.entries[key].diaryText);
                  const isToday = key === todayKey;
                  return (
                    <button
                      key={i}
                      className={`pd-cal-cell ${isToday ? 'today' : ''} ${hasEntry ? 'has-entry' : ''}`}
                      onClick={() => { if (hasEntry) setSelectedEntryKey(key); else if (isToday) setView('chat'); }}
                    >
                      <span className="pd-cal-daynum">{d.getDate()}</span>
                      {hasEntry && <Heart size={11} className="pd-cal-heart" fill="currentColor" />}
                    </button>
                  );
                })}
              </div>
              {entryCount === 0 && (
                <p className="pd-cal-empty">아직 쓴 편지가 없어.<br />오늘의 대화를 시작해볼까?</p>
              )}
            </div>
          )}
        </main>

        {view === 'chat' && !todayEntry.diaryText && (
          <div className="pd-composer">
            <textarea
              ref={textareaRef}
              className="pd-textarea"
              value={input}
              placeholder="오늘 있었던 일을 편하게 얘기해줘..."
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              rows={1}
            />
            <button className="pd-send-btn" onClick={sendMessage} disabled={sending || !input.trim()}>
              <Send size={16} />
            </button>
          </div>
        )}

        {view === 'chat' && !todayEntry.diaryText && hasPendingUserMsg && (
          <button
            className="pd-reply-btn"
            onClick={() => { if (textareaRef.current) textareaRef.current.blur(); requestReply(); }}
            disabled={sending}
          >
            {sending ? (<><Loader2 size={14} className="pd-spin" /> 답장 기다리는 중...</>) : (<><MessageCircle size={14} /> 답장 받기</>)}
          </button>
        )}

        {view === 'chat' && !todayEntry.diaryText && (todayEntry.messages || []).some(m => m.role === 'user') && (
          <button className="pd-finish-btn" onClick={generateDiary} disabled={generating}>
            {generating ? (<><Loader2 size={14} className="pd-spin" /> 편지를 쓰는 중...</>) : (<><Sparkles size={14} /> 오늘 편지 완성하기</>)}
          </button>
        )}

        <nav className="pd-nav">
          <button className={`pd-nav-btn ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>
            <MessageCircle size={18} /><span>대화</span>
          </button>
          <button className={`pd-nav-btn ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}>
            <CalendarIcon size={18} /><span>캘린더</span>
          </button>
        </nav>
      </div>

      {selectedEntry && (
        <div className="pd-modal-backdrop" onClick={() => setSelectedEntryKey(null)}>
          <div className="pd-modal" onClick={e => e.stopPropagation()}>
            <button className="pd-modal-close" onClick={() => setSelectedEntryKey(null)}><X size={16} /></button>
            <LetterCard babyName={data.babyName} dateLabel={formatNice(parseKey(selectedEntryKey))} text={selectedEntry.diaryText} />
          </div>
        </div>
      )}

      {showPrivacy && (
        <div className="pd-modal-backdrop" onClick={() => { setShowPrivacy(false); setConfirmDelete(false); }}>
          <div className="pd-modal" onClick={e => e.stopPropagation()}>
            <button className="pd-modal-close" onClick={() => { setShowPrivacy(false); setConfirmDelete(false); }}><X size={16} /></button>
            <div className="pd-privacy-panel">
              <div className="pd-privacy-icon"><ShieldCheck size={20} /></div>
              <h2 className="pd-privacy-title">개인정보 안내</h2>
              <ul className="pd-privacy-text">
                <li>AI API 키는 백엔드 서버에만 저장돼. 브라우저(프론트엔드)로는 절대 전달되지 않아.</li>
                <li>대화·일기는 백엔드 서버의 로컬 파일(backend/data/diary-data.json)에 저장돼.</li>
                <li>일기를 쓰기 위해 대화 내용이 서버를 거쳐 AI 모델로 전송돼. 민감한 정보는 되도록 적게 남기는 걸 추천해.</li>
                <li>실제 서비스로 배포할 땐 이 JSON 파일 저장 방식을 암호화된 DB로 바꾸고, HTTPS·로그인 등 접근 제어를 추가하는 걸 추천해.</li>
              </ul>
              {!confirmDelete ? (
                <button className="pd-btn-danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={13} /> 저장된 모든 일기 삭제
                </button>
              ) : (
                <div className="pd-privacy-confirm">
                  <p>정말 모든 일기와 사진을 삭제할까? 되돌릴 수 없어.</p>
                  <div className="pd-privacy-actions">
                    <button className="pd-btn-secondary" onClick={() => setConfirmDelete(false)}>취소</button>
                    <button className="pd-btn-danger" onClick={deleteAllEntries}>삭제할게</button>
                  </div>
                </div>
              )}

              <div className="pd-privacy-testing">
                <p className="pd-privacy-testing-label">테스트용</p>
                {!confirmReset ? (
                  <button className="pd-btn-danger" onClick={() => setConfirmReset(true)}>
                    <RotateCcw size={13} /> 캐시·저장소 전체 초기화 후 처음 화면으로
                  </button>
                ) : (
                  <div className="pd-privacy-confirm">
                    <p>아기 이름, 모든 일기·사진, 브라우저 저장소까지 전부 지우고 처음 화면으로 돌아갈까?</p>
                    <div className="pd-privacy-actions">
                      <button className="pd-btn-secondary" onClick={() => setConfirmReset(false)}>취소</button>
                      <button className="pd-btn-danger" onClick={resetAppForTesting}>초기화할게</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function GreetingPicker({ babyName, onPick }) {
  const [custom, setCustom] = useState('');
  const name = babyName || '아기';
  const options = [
    `${withTopicParticle(name)} 오늘 하루 어땠어?`,
    '아침부터 차근차근 얘기해볼까? 오늘 잘 잤어?',
    '오늘 제일 기억에 남는 순간 있었어?',
    '오늘 좀 힘들었지? 무슨 일 있었어?'
  ];
  const submitCustom = () => {
    const text = custom.trim();
    if (text) onPick(text);
  };
  return (
    <div className="pd-greeting-picker">
      <p className="pd-greeting-label">오늘은 어떤 얘기부터 할까? 친구의 첫 질문을 골라줘</p>
      {options.map(opt => (
        <button key={opt} className="pd-greeting-card" onClick={() => onPick(opt)}>{opt}</button>
      ))}
      <div className="pd-greeting-custom">
        <input
          className="pd-input"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          placeholder="원하는 첫 질문을 직접 써도 돼"
          onKeyDown={e => { if (e.key === 'Enter') submitCustom(); }}
        />
        <button className="pd-greeting-custom-btn" onClick={submitCustom} disabled={!custom.trim()}>시작</button>
      </div>
    </div>
  );
}

function LetterCard({ babyName, dateLabel, text, onBack }) {
  return (
    <div className="pd-letter">
      <div className="pd-letter-seal"><Heart size={14} fill="currentColor" /></div>
      <div className="pd-letter-date">{dateLabel}</div>
      <div className="pd-letter-body">{text}</div>
      {onBack && <button className="pd-letter-back" onClick={onBack}>다시 대화하기</button>}
    </div>
  );
}
