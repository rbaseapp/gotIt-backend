export const privateLessonDemoHtml = `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GotIt — שיעור פרטי קולי</title>
    <link rel="stylesheet" href="/demo/private-lesson.css" />
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">GotIt Voice POC</span>
        <h1>שיעור פרטי קולי</h1>
        <p>חמש דקות של שיחה מותאמת אישית, עם מילים מהתור החכם ועזרה דקדוקית.</p>
      </section>

      <section class="panel" id="setupPanel">
        <form id="lessonForm">
          <label class="wide">
            אסימון התחברות זמני ל־GotIt
            <input id="accessToken" type="password" autocomplete="off" required />
            <small>נשמר בזיכרון הדפדפן רק לצורך יצירת הסשן ואינו נשמר בדף.</small>
          </label>
          <label>
            שפת יעד
            <input id="targetLanguage" value="en" maxlength="64" required />
          </label>
          <label>
            שפת עזרה
            <input id="supportLanguage" value="he" maxlength="64" />
          </label>
          <label>
            קול המורה
            <select id="teacherVoice">
              <option value="female">קול נשי</option>
              <option value="male">קול גברי</option>
            </select>
          </label>
          <label>
            מהירות דיבור
            <select id="speechRate">
              <option value="very_slow">איטית מאוד</option>
              <option value="slow">איטית</option>
              <option value="normal" selected>רגילה</option>
              <option value="fast">מהירה</option>
              <option value="very_fast">מהירה מאוד</option>
            </select>
          </label>
          <label>
            נושא
            <input id="topic" value="everyday conversation" maxlength="120" />
          </label>
          <label>
            מיקוד דקדוקי
            <input id="grammarFocus" placeholder="לדוגמה: past simple" maxlength="160" />
          </label>
          <button id="startButton" class="primary wide" type="submit">התחלת שיעור</button>
        </form>
      </section>

      <section class="panel session" id="sessionPanel" hidden>
        <div class="sessionHeader">
          <div>
            <span class="eyebrow">השיעור פעיל</span>
            <h2 id="lessonTopic"></h2>
          </div>
          <div class="timer" id="timer" aria-live="polite">05:00</div>
        </div>
        <div class="words" id="targetWords"></div>
        <p class="status" id="status" aria-live="polite">מתחבר למיקרופון…</p>
        <div class="transcript" id="transcript" aria-live="polite"></div>
        <button id="translateButton" class="secondary" type="button">תרגום המשפט האחרון</button>
        <button id="stopButton" class="secondary" type="button">סיום שיעור</button>
      </section>

      <audio id="remoteAudio" autoplay></audio>
    </main>
    <script src="/demo/private-lesson.js" defer></script>
  </body>
</html>`;

export const privateLessonDemoCss = `
:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #0b1020; color: #eef2ff; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 80% 0%, #263b75 0, transparent 38%), #0b1020; }
main { width: min(820px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0; }
.hero { margin-bottom: 28px; }
.hero h1 { margin: 8px 0; font-size: clamp(2.3rem, 7vw, 4.8rem); letter-spacing: -0.05em; }
.hero p { max-width: 620px; color: #bdc7e6; font-size: 1.08rem; line-height: 1.7; }
.eyebrow { color: #77e7c4; font-size: .76rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.panel { border: 1px solid #344262; background: rgba(15, 23, 43, .88); border-radius: 24px; padding: 26px; box-shadow: 0 24px 80px rgba(0, 0, 0, .32); backdrop-filter: blur(18px); }
form { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
label { display: grid; gap: 8px; font-weight: 700; }
label small { color: #8f9cbd; font-weight: 400; }
.wide { grid-column: 1 / -1; }
input, select { width: 100%; border: 1px solid #3b496b; border-radius: 12px; padding: 13px 14px; color: #fff; background: #0a1123; font: inherit; }
input { direction: ltr; }
input:focus, select:focus { outline: 2px solid #70dfbe; outline-offset: 2px; }
button { border: 0; border-radius: 14px; padding: 14px 20px; font: inherit; font-weight: 800; cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
.primary { color: #07130f; background: #77e7c4; }
.secondary { color: #eef2ff; background: #293653; }
.session { display: grid; gap: 20px; }
.sessionHeader { display: flex; align-items: start; justify-content: space-between; gap: 20px; }
.sessionHeader h2 { margin: 6px 0 0; }
.timer { min-width: 112px; text-align: center; direction: ltr; border: 1px solid #4c5b7c; border-radius: 18px; padding: 12px 16px; font-variant-numeric: tabular-nums; font-size: 1.7rem; font-weight: 800; }
.words { display: flex; flex-wrap: wrap; gap: 8px; }
.word { border: 1px solid #3d6b63; border-radius: 999px; padding: 7px 11px; color: #aef6df; background: #112c2a; direction: ltr; }
.status { margin: 0; color: #aab6d4; }
.transcript { min-height: 180px; max-height: 330px; overflow: auto; display: grid; align-content: start; gap: 10px; border-radius: 16px; padding: 16px; background: #080e1c; }
.turn { max-width: 85%; border-radius: 14px; padding: 10px 13px; line-height: 1.55; }
.turn.user { justify-self: start; color: #d9e0f5; background: #27324c; }
.turn.tutor { justify-self: end; color: #07130f; background: #8ce8cb; }
.turn.system { max-width: 100%; justify-self: center; color: #9eaccd; font-size: .9rem; }
audio { display: none; }
@media (max-width: 620px) { main { padding: 28px 0; } form { grid-template-columns: 1fr; } .wide { grid-column: auto; } .panel { padding: 19px; } }
`;

export const privateLessonDemoJs = `
'use strict';

const form = document.getElementById('lessonForm');
const setupPanel = document.getElementById('setupPanel');
const sessionPanel = document.getElementById('sessionPanel');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const translateButton = document.getElementById('translateButton');
const statusElement = document.getElementById('status');
const timerElement = document.getElementById('timer');
const transcriptElement = document.getElementById('transcript');
const audioElement = document.getElementById('remoteAudio');

let peerConnection;
let localStream;
let dataChannel;
let intervalId;
let wrapTimeoutId;
let stopTimeoutId;
let hardStopTimeoutId;
let activeResponse = false;
let wrapPending = false;
let wrapSent = false;
let closingPrepared = false;
let closingResponse = false;
let closingStartedAt = 0;
let closingTranscript = '';
let assistantBuffer = '';
let activeSession;

function setStatus(message) {
  statusElement.textContent = message;
}

function addTurn(role, text) {
  if (!text || !text.trim()) return;
  const element = document.createElement('div');
  element.className = 'turn ' + role;
  element.textContent = text.trim();
  transcriptElement.appendChild(element);
  transcriptElement.scrollTop = transcriptElement.scrollHeight;
}

function formatTime(seconds) {
  const safe = Math.max(0, seconds);
  return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
}

function sendEvent(event) {
  if (!dataChannel || dataChannel.readyState !== 'open') return false;
  dataChannel.send(JSON.stringify(event));
  return true;
}

function requestWrapUp() {
  if (wrapSent || !activeSession) return;
  stopButton.disabled = true;
  translateButton.disabled = true;
  if (!closingPrepared) {
    closingPrepared = true;
    sendEvent({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } } } });
  }
  if (activeResponse) {
    wrapPending = true;
    setStatus('הזמן כמעט הסתיים — הסיכום יתחיל בסיום התשובה הנוכחית.');
    return;
  }
  wrapSent = sendEvent(activeSession.realtime.wrapUpEvent);
  wrapPending = !wrapSent;
  if (wrapSent) setStatus('מסכמים את השיעור…');
}

function handleRealtimeEvent(event) {
  if (event.type === 'response.created') {
    activeResponse = true;
    if (wrapSent && !closingResponse) {
      closingResponse = true;
      closingStartedAt = Date.now();
    }
  }
  if (event.type === 'response.done') {
    activeResponse = false;
    if (wrapPending) requestWrapUp();
    else if (closingResponse) {
      const words = closingTranscript.trim().split(/\\s+/).filter(Boolean).length;
      const multiplier = { very_slow: .7, slow: .85, normal: 1, fast: 1.2, very_fast: 1.4 }[activeSession.lesson.speechRate];
      const estimate = Math.min(20000, Math.max(3000, words / (2.4 * multiplier) * 1000 + 1500));
      setStatus('הסיכום והפרידה מתנגנים…');
      stopTimeoutId = window.setTimeout(function () {
        addTurn('system', 'השיעור הושלם.');
        stopLesson('השיעור הסתיים.');
      }, Math.max(1000, estimate - (Date.now() - closingStartedAt)));
    } else {
      translateButton.disabled = !activeSession.realtime.translationEvent;
    }
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    addTurn('user', event.transcript || '');
  }
  if (event.type === 'response.output_audio_transcript.delta') {
    assistantBuffer += event.delta || '';
  }
  if (event.type === 'response.output_audio_transcript.done') {
    const transcript = event.transcript || assistantBuffer;
    addTurn('tutor', transcript);
    if (closingResponse) closingTranscript = transcript;
    assistantBuffer = '';
  }
  if (event.type === 'error') {
    setStatus('אירעה שגיאת תקשורת בסשן הקולי.');
  }
}

function startTimer(durationSeconds, wrapUpAfterSeconds) {
  const startedAt = Date.now();
  timerElement.textContent = formatTime(durationSeconds);
  intervalId = window.setInterval(function () {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    timerElement.textContent = formatTime(durationSeconds - elapsed);
  }, 250);
  wrapTimeoutId = window.setTimeout(requestWrapUp, wrapUpAfterSeconds * 1000);
  stopTimeoutId = window.setTimeout(requestWrapUp, durationSeconds * 1000);
  hardStopTimeoutId = window.setTimeout(function () {
    if (peerConnection) stopLesson('השיעור הסתיים.');
  }, (durationSeconds + 30) * 1000);
}

function stopLesson(message) {
  window.clearInterval(intervalId);
  window.clearTimeout(wrapTimeoutId);
  window.clearTimeout(stopTimeoutId);
  window.clearTimeout(hardStopTimeoutId);
  if (activeSession && activeSession.realtime.connectionUrl === '/api/v1/realtime/connect') {
    fetch('/api/v1/realtime/end', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + activeSession.realtime.clientSecret },
      keepalive: true,
    }).catch(function () {});
  }
  if (dataChannel) dataChannel.close();
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach(function (track) { track.stop(); });
  dataChannel = undefined;
  peerConnection = undefined;
  localStream = undefined;
  activeResponse = false;
  closingResponse = false;
  translateButton.disabled = true;
  setStatus(message || 'השיעור נעצר.');
  stopButton.disabled = true;
  activeSession = null;
}

function renderLesson(lesson) {
  document.getElementById('lessonTopic').textContent = lesson.topic;
  const words = document.getElementById('targetWords');
  words.replaceChildren();
  if (!lesson.targetWords.length) {
    const empty = document.createElement('span');
    empty.className = 'word';
    empty.textContent = 'שיחה ללא מילות תרגול שמורות';
    words.appendChild(empty);
    return;
  }
  lesson.targetWords.forEach(function (target) {
    const item = document.createElement('span');
    item.className = 'word';
    item.textContent = target.sourceText + ' — ' + target.translationText;
    words.appendChild(item);
  });
}

async function connectRealtime(session) {
  peerConnection = new RTCPeerConnection();
  peerConnection.ontrack = function (event) { audioElement.srcObject = event.streams[0]; };
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  peerConnection.addTrack(localStream.getAudioTracks()[0], localStream);

  dataChannel = peerConnection.createDataChannel('oai-events');
  dataChannel.addEventListener('message', function (message) {
    try { handleRealtimeEvent(JSON.parse(message.data)); } catch (_) { /* Ignore malformed events. */ }
  });
  dataChannel.addEventListener('open', function () {
    setStatus('מחובר. אפשר להתחיל לדבר.');
    sendEvent(session.realtime.openingEvent);
    startTimer(session.lesson.durationSeconds, session.lesson.wrapUpAfterSeconds);
  });
  dataChannel.addEventListener('close', function () {
    if (peerConnection) setStatus('החיבור הקולי נסגר.');
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  const response = await fetch(session.realtime.connectionUrl, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: 'Bearer ' + session.realtime.clientSecret,
      'Content-Type': 'application/sdp',
    },
  });
  if (!response.ok) throw new Error('OpenAI WebRTC connection failed (' + response.status + ')');
  await peerConnection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
}

form.addEventListener('submit', async function (event) {
  event.preventDefault();
  startButton.disabled = true;
  transcriptElement.replaceChildren();
  wrapPending = false;
  wrapSent = false;
  closingPrepared = false;
  closingResponse = false;
  closingStartedAt = 0;
  closingTranscript = '';
  assistantBuffer = '';
  try {
    const tokenInput = document.getElementById('accessToken');
    const body = {
      targetLanguageCode: document.getElementById('targetLanguage').value.trim(),
      teacherVoice: document.getElementById('teacherVoice').value,
      speechRate: document.getElementById('speechRate').value,
    };
    const supportLanguage = document.getElementById('supportLanguage').value.trim();
    const topic = document.getElementById('topic').value.trim();
    const grammarFocus = document.getElementById('grammarFocus').value.trim();
    if (supportLanguage) body.supportLanguageCode = supportLanguage;
    if (topic) body.topic = topic;
    if (grammarFocus) body.grammarFocus = grammarFocus;

    const response = await fetch('/api/v1/private-lessons/realtime-sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenInput.value, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    tokenInput.value = '';
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error && payload.error.message || 'Session creation failed');

    activeSession = payload;
    renderLesson(payload.lesson);
    setupPanel.hidden = true;
    sessionPanel.hidden = false;
    stopButton.disabled = false;
    translateButton.disabled = !payload.realtime.translationEvent;
    setStatus('מבקש הרשאת מיקרופון…');
    await connectRealtime(payload);
  } catch (error) {
    stopLesson(error instanceof Error ? error.message : 'לא ניתן להתחיל את השיעור.');
    setupPanel.hidden = false;
    sessionPanel.hidden = true;
  } finally {
    startButton.disabled = false;
  }
});

translateButton.addEventListener('click', function () {
  if (!activeSession || !activeSession.realtime.translationEvent || activeResponse) return;
  if (sendEvent(activeSession.realtime.translationEvent)) {
    activeResponse = true;
    translateButton.disabled = true;
    setStatus('מתרגמים לשפת העזרה…');
  }
});
stopButton.addEventListener('click', requestWrapUp);
window.addEventListener('beforeunload', function () { stopLesson(); });
`;
