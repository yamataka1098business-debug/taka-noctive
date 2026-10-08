import { SegmentRecorder } from './recorder.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'meeting-assistant:v1';
const AUTO_ANALYZE_MS = 90_000;

const state = {
  lines: [], // { id, speaker: 'them' | 'me', text, ts, pending }
  suggestions: [], // { id, title, pain, evidence, features, wow, minutes, dismissed }
  summary: '',
  demos: [], // { title, url }
  analyzedUpTo: 0,
};

let recorders = [];
let streams = [];
let paused = false;
let analyzing = false;
let autoTimer = null;

// ---------- 保存（ページを再読み込みしても消えないように） ----------

function save() {
  try {
    const { lines, suggestions, summary, demos } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ lines: lines.filter((l) => !l.pending), suggestions, summary, demos }));
  } catch {}
}

function load() {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
  } catch {}
}

// ---------- 表示 ----------

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function showStatus(message, ok = false) {
  const el = $('status');
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('ok', ok);
}

function renderTranscript() {
  const box = $('transcript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = '';
  if (!state.lines.length) {
    box.innerHTML = '<p class="empty">「録音を開始」を押すと、ここに会話が流れます。</p>';
    return;
  }
  for (const l of state.lines) {
    const row = document.createElement('div');
    row.className = `line ${l.speaker}${l.pending ? ' pending' : ''}`;
    row.innerHTML = '<span class="time"></span><span class="who"></span><span class="text"></span>';
    row.querySelector('.time').textContent = fmtTime(l.ts);
    row.querySelector('.who').textContent = l.speaker === 'me' ? '自分' : '相手';
    row.querySelector('.text').textContent = l.pending ? '聞き取り中…' : l.text;
    box.appendChild(row);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderSuggestions(freshIds = []) {
  const box = $('suggestions');
  const visible = state.suggestions.filter((s) => !s.dismissed);
  $('summary').hidden = !state.summary;
  $('summary').textContent = state.summary ? `いまの理解：${state.summary}` : '';
  box.innerHTML = '';
  if (!visible.length) {
    box.innerHTML = '<p class="empty">相手が困りごとを話すと、ここにツール案が出ます。</p>';
    return;
  }
  for (const s of [...visible].reverse()) {
    const card = $('cardTpl').content.firstElementChild.cloneNode(true);
    if (freshIds.includes(s.id)) card.classList.add('fresh');
    card.querySelector('.card-title').textContent = s.title;
    card.querySelector('.minutes').textContent = s.minutes ? `デモ目安 ${s.minutes}分` : '';
    card.querySelector('.pain').textContent = s.pain;
    card.querySelector('.evidence').textContent = s.evidence ? `「${s.evidence}」` : '';
    card.querySelector('.wow').textContent = s.wow || '';
    const ul = card.querySelector('.features');
    for (const f of s.features || []) {
      const li = document.createElement('li');
      li.textContent = f;
      ul.appendChild(li);
    }
    const note = card.querySelector('.note');
    note.value = s.note || '';
    note.addEventListener('input', () => {
      s.note = note.value;
      save();
    });
    card.querySelector('.act-demo').addEventListener('click', (e) => buildDemo(s, e.currentTarget));
    card.querySelector('.act-prompt').addEventListener('click', (e) => makePrompt(s, e.currentTarget));
    card.querySelector('.act-dismiss').addEventListener('click', () => {
      s.dismissed = true;
      save();
      renderSuggestions();
    });
    box.appendChild(card);
  }
}

function renderDemos() {
  $('demos').hidden = !state.demos.length;
  const ul = $('demoList');
  ul.innerHTML = '';
  for (const d of [...state.demos].reverse()) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = d.url;
    a.target = '_blank';
    a.textContent = `${d.title}（${fmtTime(d.ts)}）`;
    li.appendChild(a);
    ul.appendChild(li);
  }
}

// ---------- API ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
}

function contextFor(speaker) {
  return state.lines
    .filter((l) => l.speaker === speaker && !l.pending)
    .slice(-5)
    .map((l) => l.text)
    .join(' ');
}

function addLine(speaker, ts, text, pending = false) {
  const line = { id: crypto.randomUUID(), speaker, ts, text, pending };
  const i = state.lines.findIndex((l) => l.ts > ts);
  if (i === -1) state.lines.push(line);
  else state.lines.splice(i, 0, line);
  renderTranscript();
  return line;
}

async function handleSegment(speaker, blob, startedAt) {
  const line = addLine(speaker, startedAt, '', true);
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Context': encodeURIComponent(contextFor(speaker)) },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.text) {
      line.text = data.text;
      line.pending = false;
    } else {
      state.lines.splice(state.lines.indexOf(line), 1);
    }
  } catch (e) {
    state.lines.splice(state.lines.indexOf(line), 1);
    showStatus(e.message);
  }
  save();
  renderTranscript();
}

// ---------- 録音 ----------

async function startRecording() {
  showStatus('');
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(mic);

    // 相手の声：Zoom の音声を「システム音声」として取り込む
    let display = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
      streams.push(display);
    } catch {
      display = null;
    }
    const sysTrack = display?.getAudioTracks()[0];
    if (!sysTrack) {
      showStatus(
        '相手の音声を取り込めていません。自分の声だけ文字起こしします。\n' +
          '相手の声も拾うには、一度「終了」してから録音を開始し、共有画面の選択で「画面全体」を選び、「システム音声も共有する」をオンにしてください。'
      );
    }

    recorders.push(
      new SegmentRecorder(mic.getAudioTracks()[0], {
        onSegment: (b, t) => handleSegment('me', b, t),
        onLevel: (v) => ($('levelMe').style.width = `${Math.min(100, v * 600)}%`),
      })
    );
    if (sysTrack) {
      recorders.push(
        new SegmentRecorder(sysTrack, {
          onSegment: (b, t) => handleSegment('them', b, t),
          onLevel: (v) => ($('levelThem').style.width = `${Math.min(100, v * 600)}%`),
          threshold: 0.008,
        })
      );
      // 画面共有を Chrome 側で止められたら録音も止める
      sysTrack.addEventListener('ended', stopRecording);
    }
    recorders.forEach((r) => r.start());

    $('startBtn').disabled = true;
    $('pauseBtn').disabled = false;
    $('stopBtn').disabled = false;
    scheduleAuto();
  } catch (e) {
    stopRecording();
    showStatus(`マイクを使えません：${e.message}\nChrome のアドレスバー左のアイコンから、マイクを許可してください。`);
  }
}

function stopRecording() {
  recorders.forEach((r) => r.stop());
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  recorders = [];
  streams = [];
  paused = false;
  clearInterval(autoTimer);
  $('startBtn').disabled = false;
  $('pauseBtn').disabled = true;
  $('pauseBtn').textContent = '一時停止';
  $('stopBtn').disabled = true;
  $('levelMe').style.width = $('levelThem').style.width = '0';
}

function togglePause() {
  paused = !paused;
  recorders.forEach((r) => r.setPaused(paused));
  $('pauseBtn').textContent = paused ? '再開' : '一時停止';
}

// ---------- 課題の分析 ----------

function scheduleAuto() {
  clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    if ($('autoAnalyze').checked && !paused) analyze(false);
  }, AUTO_ANALYZE_MS);
}

function notify(titles) {
  document.title = `【新しい提案】商談アシスタント`;
  setTimeout(() => (document.title = '商談アシスタント'), 8000);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('新しいツール案', { body: titles.join('\n') });
  }
}

async function analyze(manual = true) {
  const done = state.lines.filter((l) => !l.pending);
  if (analyzing) return;
  if (!done.length) {
    if (manual) showStatus('まだ会話がありません。');
    return;
  }
  if (!manual && done.length === state.analyzedUpTo) return;
  analyzing = true;
  $('analyzeBtn').disabled = true;
  $('analyzeBtn').textContent = '分析中…';
  try {
    const existing = state.suggestions.map((s) => s.title);
    const data = await api('/api/analyze', { lines: done, existing });
    state.analyzedUpTo = done.length;
    if (data.summary) state.summary = data.summary;
    const fresh = (data.suggestions || []).map((s) => ({ ...s, id: crypto.randomUUID() }));
    state.suggestions.push(...fresh);
    save();
    renderSuggestions(fresh.map((s) => s.id));
    if (fresh.length) notify(fresh.map((s) => s.title));
    else if (manual) showStatus('新しいツール案は見つかりませんでした。相手の困りごとがもう少し出てから試してください。', true);
  } catch (e) {
    showStatus(e.message);
  } finally {
    analyzing = false;
    $('analyzeBtn').disabled = false;
    $('analyzeBtn').textContent = '今すぐ分析';
  }
}

// ---------- デモの自動生成 ----------

async function buildDemo(s, btn) {
  // ポップアップブロックを避けるため、クリックした瞬間にタブを開いておく
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      `<meta charset="utf-8"><title>作成中…</title><body style="font-family:sans-serif;display:grid;place-items:center;height:90vh;color:#6b7684">「${s.title.replace(/[<&]/g, '')}」をAIが作成中です…</body>`
    );
  }
  btn.disabled = true;
  btn.textContent = '作成中…';
  $('builder').hidden = false;
  $('builderTitle').textContent = `「${s.title}」を作成中…`;
  $('builderCode').textContent = '';
  const started = Date.now();
  const tick = setInterval(() => {
    $('builderStat').textContent = `${Math.round((Date.now() - started) / 1000)}秒 / ${$('builderCode').textContent.length.toLocaleString()}文字`;
  }, 500);

  try {
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion: s, note: s.note, summary: state.summary }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let url = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const p of parts) {
        if (!p) continue;
        const ev = JSON.parse(p);
        if (ev.t === 'delta') {
          const code = $('builderCode');
          code.textContent += ev.d;
          code.scrollTop = code.scrollHeight;
        } else if (ev.t === 'done') url = ev.url;
        else if (ev.t === 'error') throw new Error(ev.message);
      }
    }
    if (!url) throw new Error('デモの作成が途中で止まりました。もう一度お試しください。');
    $('builderTitle').textContent = `「${s.title}」ができました`;
    state.demos.push({ title: s.title, url, ts: Date.now() });
    save();
    renderDemos();
    if (tab && !tab.closed) tab.location.href = url;
    else window.open(url, '_blank');
  } catch (e) {
    $('builderTitle').textContent = '作成に失敗しました';
    showStatus(e.message);
    if (tab && !tab.closed) tab.close();
  } finally {
    clearInterval(tick);
    btn.disabled = false;
    btn.textContent = 'デモを自動生成';
  }
}

// ---------- Claude Code 用の指示文 ----------

function showPromptDialog(text) {
  let dlg = document.getElementById('promptDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'promptDialog';
    dlg.style.cssText = 'width:min(720px,92vw);border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);padding:16px';
    dlg.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>Claude Code 用の指示文</strong><span class="muted" id="promptCopied"></span>
      </div>
      <textarea id="promptText" style="width:100%;height:50vh;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--bg);font-size:13px"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
        <button id="promptCopy" class="primary">コピー</button><button id="promptClose">閉じる</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#promptClose').addEventListener('click', () => dlg.close());
    dlg.querySelector('#promptCopy').addEventListener('click', () => copyPrompt());
  }
  dlg.querySelector('#promptText').value = text;
  dlg.showModal();
  copyPrompt();
}

async function copyPrompt() {
  const text = $('promptText').value;
  try {
    await navigator.clipboard.writeText(text);
    $('promptCopied').textContent = 'コピーしました';
  } catch {
    $('promptText').select();
    $('promptCopied').textContent = '選択しました。⌘C でコピーしてください';
  }
}

async function makePrompt(s, btn) {
  btn.disabled = true;
  btn.textContent = '作成中…';
  try {
    const { prompt } = await api('/api/prompt', {
      suggestion: s,
      note: s.note,
      lines: state.lines.filter((l) => !l.pending),
    });
    showPromptDialog(prompt);
  } catch (e) {
    showStatus(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Code用の指示文をコピー';
  }
}

// ---------- その他 ----------

function exportMarkdown() {
  const d = new Date();
  const md = [
    `# 商談メモ ${d.toLocaleString('ja-JP')}`,
    '',
    state.summary ? `## 相手の状況\n${state.summary}\n` : '',
    '## ツール案',
    ...state.suggestions.map(
      (s) => `### ${s.title}${s.dismissed ? '（却下）' : ''}\n- 困りごと：${s.pain}\n- 根拠：「${s.evidence}」\n- 機能：${(s.features || []).join('、')}`
    ),
    '',
    '## 作ったデモ',
    ...state.demos.map((x) => `- ${x.title}：http://localhost:${location.port}${x.url}`),
    '',
    '## 文字起こし',
    ...state.lines.filter((l) => !l.pending).map((l) => `[${fmtTime(l.ts)}] ${l.speaker === 'me' ? '自分' : '相手'}：${l.text}`),
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `商談メモ_${d.toISOString().slice(0, 10)}.md`;
  a.click();
}

const SAMPLE = [
  ['me', '本日はお時間いただきありがとうございます。まずは今の業務で困っていることを伺えますか。'],
  ['them', 'うちは地域で美容室を3店舗やっているんですけど、一番大変なのが予約の調整なんですよね。'],
  ['them', 'インスタのDMとか電話で予約が来るんですけど、空いてる日をスタッフが毎回カレンダー見て返していて、1件決まるまでに何往復もしちゃうんです。'],
  ['me', 'なるほど。1件あたり、どれくらい時間がかかっていますか。'],
  ['them', '多いと5往復くらいですね。営業中だと返信が遅れて、その間に他のお店に取られちゃうこともあります。'],
  ['them', 'あと、どのお客さんが前回いつ来て何をしたかも、紙のカルテなので探すのに時間がかかってます。'],
];

function loadSample() {
  const base = Date.now() - SAMPLE.length * 20_000;
  SAMPLE.forEach(([speaker, text], i) => addLine(speaker, base + i * 20_000, text));
  save();
}

$('startBtn').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  startRecording();
});
$('pauseBtn').addEventListener('click', togglePause);
$('stopBtn').addEventListener('click', stopRecording);
$('analyzeBtn').addEventListener('click', () => analyze(true));
$('exportBtn').addEventListener('click', exportMarkdown);
$('sampleBtn').addEventListener('click', loadSample);
$('clearBtn').addEventListener('click', () => {
  if (!confirm('文字起こし・ツール案・デモの履歴をすべて消します。よろしいですか？')) return;
  Object.assign(state, { lines: [], suggestions: [], summary: '', demos: [], analyzedUpTo: 0 });
  save();
  renderTranscript();
  renderSuggestions();
  renderDemos();
});
$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('manualText').value.trim();
  if (!text) return;
  addLine($('manualSpeaker').value, Date.now(), text);
  $('manualText').value = '';
  save();
});

load();
renderTranscript();
renderSuggestions();
renderDemos();
// サーバー起動直後はモデル確認が終わっていないことがあるので、少し待って再確認する
async function checkStatus(retry = 5) {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s.checked && retry > 0) return setTimeout(() => checkStatus(retry - 1), 1500);
    if (s.checked && !s.ok) showStatus(s.message);
  } catch {}
}
checkStatus();
