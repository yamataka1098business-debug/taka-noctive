// 商談アシスタントのローカルサーバー
// - public/ の画面を配信
// - 音声チャンクを OpenAI に送って文字起こし
// - 会話から課題とツール案を抽出
// - デモツール（単一HTML）の自動生成と、Claude Code 用の指示文の作成
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const GENERATED_DIR = path.join(ROOT, 'generated');

const API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-5.5';
const REASONING_EFFORT = process.env.REASONING_EFFORT || '';
const PORT = Number(process.env.PORT || 3939);
const OPENAI = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 無音や雑音のときに文字起こしモデルが出しがちな定型文
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご清聴ありがとうございました',
  'チャンネル登録',
  'お疲れ様でした。',
  'おやすみなさい',
];

// ---------- OpenAI 呼び出し ----------

async function openaiError(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

async function transcribe(audio, mimeType, prompt) {
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), `chunk.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'ja');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt.slice(-400));
  const res = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`文字起こしに失敗: ${await openaiError(res)}`);
  const text = ((await res.json()).text || '').trim();
  if (HALLUCINATIONS.some((h) => text.includes(h)) && text.length < 30) return '';
  return text;
}

function chatBody(messages, extra = {}) {
  const body = { model: CHAT_MODEL, messages, ...extra };
  if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT;
  return body;
}

async function chat(messages, extra) {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody(messages, extra)),
  });
  if (!res.ok) throw new Error(`AIの呼び出しに失敗: ${await openaiError(res)}`);
  return (await res.json()).choices[0].message.content || '';
}

// ストリーミングで受け取り、届いた分を onDelta に渡す
async function chatStream(messages, onDelta) {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody(messages, { stream: true })),
  });
  if (!res.ok) throw new Error(`AIの呼び出しに失敗: ${await openaiError(res)}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }
  return full;
}

// ---------- プロンプト ----------

const ANALYZE_SYSTEM = `あなたはAI導入支援会社「Noctive」の営業を横で支えるアシスタントです。
オンライン商談の文字起こし（「相手」＝見込み客、「自分」＝Noctiveの営業担当）を読み、
相手が口にした業務上の困りごとを見つけて、その場でAIを使って作れる簡単なツールを提案します。

目的は「AIを使うと、こんなものもすぐ作れる」と相手に体感してもらうことです。
- 提案するのは、ブラウザで動く単一のHTMLファイルで、20分以内にデモを作れるものに限る
  （例：日程調整、問い合わせ管理、簡易CRM、見積もり計算、シフト表、日報フォーム、在庫チェック表など）
- 相手が実際に話した内容に根拠があるものだけを出す。推測で課題を作らない
- 根拠になった相手の発言を、文字起こしからそのまま短く引用する
- すでに出した提案（既出リスト）と同じものは出さない。内容が深まった場合だけ出し直してよい
- 新しい提案は最大3件。見つからなければ空の配列でよい
- 自然な日本語で、短く書く

次のJSON形式だけを返してください。
{
  "summary": "相手の会社・業務・困りごとの現時点での理解（2〜3行）",
  "suggestions": [
    {
      "title": "ツール名（例：空き日程の自動案内ツール）",
      "pain": "相手の困りごと（1文）",
      "evidence": "根拠になった相手の発言の引用",
      "features": ["デモで見せる機能", "…（3〜5個）"],
      "wow": "相手に刺さりそうなポイント（1文）",
      "minutes": 10
    }
  ]
}`;

const DEMO_SYSTEM = `あなたは腕のいいフロントエンドエンジニアです。
商談相手に画面共有で見せるデモツールを、単一のHTMLファイルで作ってください。

必ず守ること：
- 出力はHTMLのコードだけ。説明文やコードブロックの記号（\`\`\`）は付けない。<!DOCTYPE html> から始める
- CSSとJavaScriptはすべてHTMLの中に書く。外部ライブラリ・外部フォント・外部APIは使わない
- 画面の文言はすべて自然な日本語にする
- 相手の業種に合わせた、それらしいダミーデータを最初から入れておく（空っぽの画面にしない）
- 実際に操作できるようにする（追加・編集・検索・絞り込み・計算など）。見た目だけのハリボテにしない
- データの保存は localStorage を使い、try/catch で囲んで、使えない環境でも動くようにする
- 画面上部にツール名と「デモ版」の小さな表示を入れる
- 清潔感のある業務アプリらしいデザインにする。余白を広めに取り、色数は抑える
- 外部サービスとの連携（Googleカレンダー、LINE、メール送信など）が必要な機能は、ダミーで動きを再現し、「本番ではGoogleカレンダーと連携します」のように小さく注記する
- 生成時間を短くするため、コードは簡潔に。全体で600行程度までに収める`;

const PROMPT_SYSTEM = `あなたはAI導入支援会社「Noctive」の営業担当を支えるアシスタントです。
商談で出た課題をもとに、Claude Code にそのまま貼り付けて使える「開発の指示文」を書いてください。

指示文に含めること：
- 背景：相手の会社・業務と困りごと（商談での発言をもとに）
- 作るもの：ツールの目的と、最低限ほしい機能（箇条書き）
- 技術方針：まずは動くデモを最短で作る。Googleカレンダーやスプレッドシートとの連携が必要なら Google Apps Script（GAS）でWebアプリとして公開する方法を第一候補にする
- 完成の条件：何ができたら完成か
- 注意点：画面の文言は自然な日本語にすること、相手の業種に合ったダミーデータを入れること

出力は指示文の本文だけ。前置きや締めの挨拶は書かない。見出しと箇条書きで読みやすく。`;

function transcriptText(lines) {
  return (lines || [])
    .map((l) => `[${l.time || ''}] ${l.speaker === 'me' ? '自分' : '相手'}：${l.text}`)
    .join('\n');
}

function suggestionText(s, note) {
  return [
    `ツール名：${s.title}`,
    `相手の困りごと：${s.pain}`,
    `根拠の発言：${s.evidence}`,
    `見せたい機能：\n${(s.features || []).map((f) => `- ${f}`).join('\n')}`,
    s.wow ? `刺さりそうなポイント：${s.wow}` : '',
    note ? `営業担当からの追加の指示：${note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- HTTP ----------

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('リクエストが大きすぎます'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  return JSON.parse((await readBody(req)).toString('utf8') || '{}');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveFile(res, baseDir, urlPath) {
  const filePath = path.normalize(path.join(baseDir, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(baseDir)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

function slugTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stripFences(html) {
  return html.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

let modelStatus = { checked: false };

async function checkModels() {
  if (!API_KEY) {
    modelStatus = { checked: true, ok: false, message: '.env に OPENAI_API_KEY が設定されていません' };
    return;
  }
  try {
    const res = await fetch(`${OPENAI}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!res.ok) throw new Error(await openaiError(res));
    const ids = (await res.json()).data.map((m) => m.id);
    const missing = [CHAT_MODEL, TRANSCRIBE_MODEL].filter((m) => !ids.includes(m));
    if (missing.length) {
      const hints = ids.filter((id) => /^gpt-[5-9]/.test(id) || id.includes('transcribe')).sort();
      modelStatus = {
        checked: true,
        ok: false,
        message: `このAPIキーでは ${missing.join(', ')} が見つかりません。.env のモデル名を変えてください。候補：${hints.slice(-12).join(', ')}`,
      };
    } else {
      modelStatus = { checked: true, ok: true, message: `${CHAT_MODEL} / ${TRANSCRIBE_MODEL} で動作します` };
    }
  } catch (e) {
    modelStatus = { checked: true, ok: false, message: `OpenAI に接続できません：${e.message}` };
  }
  console.log(`[モデル確認] ${modelStatus.message}`);
}

const routes = {
  'GET /api/status': async (req, res) => sendJson(res, 200, modelStatus),

  'POST /api/transcribe': async (req, res) => {
    const audio = await readBody(req);
    if (audio.length < 2000) return sendJson(res, 200, { text: '' });
    const mimeType = (req.headers['content-type'] || 'audio/webm').split(';')[0];
    const prompt = decodeURIComponent(req.headers['x-context'] || '');
    sendJson(res, 200, { text: await transcribe(audio, mimeType, prompt) });
  },

  'POST /api/analyze': async (req, res) => {
    const { lines, existing } = await readJson(req);
    const content = await chat(
      [
        { role: 'system', content: ANALYZE_SYSTEM },
        {
          role: 'user',
          content: `既出リスト：${(existing || []).join(' / ') || 'なし'}\n\n文字起こし：\n${transcriptText(lines)}`,
        },
      ],
      { response_format: { type: 'json_object' } }
    );
    sendJson(res, 200, JSON.parse(content));
  },

  'POST /api/prompt': async (req, res) => {
    const { suggestion, note, lines } = await readJson(req);
    const content = await chat([
      { role: 'system', content: PROMPT_SYSTEM },
      {
        role: 'user',
        content: `${suggestionText(suggestion, note)}\n\n商談の文字起こし（参考）：\n${transcriptText(lines).slice(-6000)}`,
      },
    ]);
    sendJson(res, 200, { prompt: content.trim() });
  },

  // NDJSON で生成の進み具合を返す：{"t":"delta","d":"..."} / {"t":"done","url":"..."} / {"t":"error","message":"..."}
  'POST /api/demo': async (req, res) => {
    const { suggestion, note, summary } = await readJson(req);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    try {
      const html = await chatStream(
        [
          { role: 'system', content: DEMO_SYSTEM },
          {
            role: 'user',
            content: `商談相手について：${summary || '（情報なし）'}\n\n作るツール：\n${suggestionText(suggestion, note)}`,
          },
        ],
        (d) => send({ t: 'delta', d })
      );
      const name = `${slugTime()}.html`;
      await fs.writeFile(path.join(GENERATED_DIR, name), stripFences(html));
      send({ t: 'done', url: `/generated/${name}` });
    } catch (e) {
      send({ t: 'error', message: e.message });
    }
    res.end();
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  try {
    if (handler) {
      if (!API_KEY && url.pathname !== '/api/status') return sendJson(res, 500, { error: '.env に OPENAI_API_KEY が設定されていません' });
      return await handler(req, res);
    }
    if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found' });
    if (url.pathname.startsWith('/generated/')) {
      return await serveFile(res, GENERATED_DIR, url.pathname.slice('/generated/'.length));
    }
    return await serveFile(res, PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

await fs.mkdir(GENERATED_DIR, { recursive: true });
// 自分のPCからだけアクセスできるようにする
server.listen(PORT, '127.0.0.1', () => {
  console.log(`商談アシスタント起動：http://localhost:${PORT}`);
  checkModels();
});
