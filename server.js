import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '16mb' }));

const UPSTREAM_URL =
  process.env.UPSTREAM_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const API_KEY = process.env.NVIDIA_API_KEY;

/* مجلد عمل البيئة — مساحة الكمبيوتر الخاصة بالوكيل */
const WORKSPACE = process.env.AGENT_WORKSPACE || '/home/user/agent-workspace';
fs.mkdirSync(WORKSPACE, { recursive: true });

export const MODELS = [
  {
    id: 'minimaxai/minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash',
    vendor: 'MiniMax',
    badge: 'الأسرع',
    description: 'موديل تفكير خاطف — مثالي للمهام اليومية والكود والمحادثات الطويلة.',
    capabilities: ['reasoning', 'text', 'code'],
    vision: false,
    accent: ['#8b5cf6', '#22d3ee'],
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    name: 'Nemotron Super VL 120B',
    vendor: 'NVIDIA',
    badge: 'رؤية بصرية',
    description: 'عملاق متعدد الوسائط — يحلّل الصور والنصوص مع تفكير عميق متقدّم.',
    capabilities: ['reasoning', 'text', 'vision', 'code'],
    vision: true,
    accent: ['#22d3ee', '#d946ef'],
  },
];

const ALLOWED_IDS = new Set(MODELS.map((m) => m.id));
const MAX_OUTPUT = 14000;
const EXEC_TIMEOUT = 30000;
const AGENT_MAX_STEPS = 10;
const NVIDIA_MAX_RETRIES = 3;
/* حد NVIDIA ≈ 40 طلب/دقيقة — نبقي فاصلاً آمناً بين كل طلبين (≈37 طلب/دقيقة كحد أقصى) */
const MIN_UPSTREAM_INTERVAL = Number(process.env.NEXUS_MIN_INTERVAL) || 1600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* بوابة عمومية تُسلسل كل طلبات NVIDIA وتفرض حداً أدنى للفاصل الزمني بينها */
let upstreamChain = Promise.resolve();
let lastUpstreamAt = 0;
function throttleUpstream(externalSignal) {
  const run = upstreamChain.then(async () => {
    if (externalSignal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const wait = MIN_UPSTREAM_INTERVAL - (Date.now() - lastUpstreamAt);
    if (wait > 0) await sleep(wait);
    lastUpstreamAt = Date.now();
  });
  upstreamChain = run.catch(() => {}); // السلسلة لا تنكسر بسبب إلغاء مستخدم واحد
  return run;
}

/* ===================== استدعاء NVIDIA مع إعادة محاولة تلقائية ===================== */
async function fetchNvidiaWithRetry(payload, externalSignal, onRetry = null) {
  let lastFailure = null;

  for (let attempt = 0; attempt < NVIDIA_MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    await throttleUpstream(externalSignal);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });

    let res;
    try {
      res = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      externalSignal?.removeEventListener('abort', onAbort);
      if (err.name === 'AbortError' && externalSignal?.aborted) throw err;
      lastFailure = err; // اهتزاز شبكة — نعيد المحاولة
      if (attempt < NVIDIA_MAX_RETRIES - 1) {
        const waitMs = Math.min(800 * 2 ** attempt + Math.random() * 300, 6000);
        try { onRetry?.({ attempt: attempt + 1, status: 0, waitMs }); } catch { /* ignore */ }
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
    externalSignal?.removeEventListener('abort', onAbort);

    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => '');
    if (!retryable || attempt === NVIDIA_MAX_RETRIES - 1) {
      return { failed: true, status: res.status, detail };
    }

    // احترام ترويسة Retry-After، وإلا تراجع أسي مع عشوائية
    const ra = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(ra) && ra > 0
      ? Math.min(ra * 1000, 8000)
      : Math.min(900 * 2 ** attempt + Math.random() * 400, 8000);
    lastFailure = { status: res.status };
    try { onRetry?.({ attempt: attempt + 1, status: res.status, waitMs }); } catch { /* ignore */ }
    await sleep(waitMs);
  }
  throw lastFailure || new Error('فشلت كل محاولات الاتصال بـ NVIDIA.');
}

/* ===================== جلسات الكمبيوتر (shell) ===================== */
const sessions = new Map();

function capOutput(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n...[اقتُطع: تجاوز الناتج ${MAX_OUTPUT} حرف]`;
}

function runCommand(sessionId, command, timeoutMs = EXEC_TIMEOUT) {
  return new Promise((resolve) => {
    const sess = sessions.get(sessionId) || { cwd: WORKSPACE };
    if (!fs.existsSync(sess.cwd)) sess.cwd = WORKSPACE;
    const marker = `__NEXUS_CWD_${Date.now()}__`;
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;

    /* يُكتب الأمر في ملف سكربت منفصل حتى لا تبتلع heredoc غير المكتملة علامة تتبع المجلد
       وتكتبها داخل ملفات المستخدم (السبب الجذري لحلقات إعادة الكتابة) */
    const scriptPath = path.join(os.tmpdir(), `nexus-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(scriptPath, command, { mode: 0o600 });
    const quotedScript = JSON.stringify(scriptPath);
    /* source داخل نفس الصدفة حتى ينتقل cd إلى الصدفة الحالية ويُلتقط PWD بدقة،
       بينما تبقى علامة التتبع خارج ملف السكربت فلا تبتلعها heredoc */
    const child = spawn(
      'bash',
      ['-lc', `source ${quotedScript}; __nexus_rc=$?; printf '\\n%s%s' '${marker}' "$PWD"; exit $__nexus_rc`],
      { cwd: sess.cwd, env: { ...process.env, TERM: 'dumb', PYTHONUNBUFFERED: '1' } }
    );

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT * 2) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT * 2) child.kill('SIGKILL');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(scriptPath); } catch { /* انتهى */ }
      resolve({
        code: 127, stdout: '', stderr: String(err.message || err),
        cwd: sess.cwd, durationMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let cwd = sess.cwd;
      const idx = stdout.lastIndexOf(marker);
      if (idx !== -1) {
        cwd = stdout.slice(idx + marker.length).trim() || sess.cwd;
        stdout = stdout.slice(0, idx);
      }
      if (killed) stderr += `\n[انتهت المهلة: استغرق التنفيذ أكثر من ${timeoutMs / 1000} ثانية وأُوقف]`;
      sess.cwd = cwd;
      sessions.set(sessionId, sess);
      try { fs.unlinkSync(scriptPath); } catch { /* انتهى */ }
      resolve({
        code: killed ? 124 : code,
        stdout: capOutput(stdout.replace(/\r\n/g, '\n')),
        stderr: capOutput(stderr.replace(/\r\n/g, '\n')),
        cwd,
        durationMs: Date.now() - started,
      });
    });
  });
}

/* ===================== البحث في الويب ===================== */
const SEARCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function unwrapDdgUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : (href.startsWith('//') ? `https:${href}` : href);
}

/* محلل HTML لنتائج DuckDuckGo — مُصدَّر للاختبارات */
export function parseSearchHtml(html) {
  const results = [];
  const titleRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<(?:a|div|span)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
  const snippets = [];
  let sm;
  while ((sm = snipRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let tm;
  while ((tm = titleRe.exec(html)) !== null) {
    const url = unwrapDdgUrl(tm[1]);
    const title = stripTags(tm[2]);
    if (title && url.startsWith('http')) results.push({ title, url, snippet: snippets[results.length] || '' });
  }
  /* صيغة lite الاحتياطية: روابط مباشرة في جدول */
  if (results.length === 0) {
    const liteRe = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let lm;
    while ((lm = liteRe.exec(html)) !== null) {
      const url = unwrapDdgUrl(lm[1]);
      const title = stripTags(lm[2]);
      if (title && url.startsWith('http') && !results.some((r) => r.url === url)) {
        results.push({ title, url, snippet: '' });
      }
    }
  }
  return results.slice(0, 6);
}

async function ddgSearch(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': SEARCH_UA, Accept: 'text/html', 'Accept-Language': 'ar,en;q=0.8' },
    });
    if (!r.ok) throw new Error(`DDG ${r.status}`);
    const results = parseSearchHtml(await r.text());
    if (!results.length) throw new Error('نتائج فارغة');
    return { source: 'duckduckgo', query, results };
  } finally {
    clearTimeout(t);
  }
}

async function braveSearch(query) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=6&q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(9000),
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Brave ${r.status}`);
  const data = await r.json();
  return {
    source: 'brave', query,
    results: (data.web?.results || []).slice(0, 6).map((x) => ({
      title: x.title, url: x.url, snippet: x.description || '',
    })),
  };
}

async function tavilySearch(query) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(9000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 6, search_depth: 'basic' }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const data = await r.json();
  return {
    source: 'tavily', query,
    results: (data.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' })),
  };
}

async function webSearch(query) {
  if (process.env.BRAVE_API_KEY) {
    try { return await braveSearch(query); } catch { /* يسقط للتالي */ }
  }
  if (process.env.TAVILY_API_KEY) {
    try { return await tavilySearch(query); } catch { /* يسقط للتالي */ }
  }
  return ddgSearch(query);
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 300);
  if (q.length < 2) return res.status(400).json({ error: 'كلمة البحث مطلوبة.' });
  try {
    const out = await webSearch(q);
    if (!out.results.length) return res.status(502).json({ error: 'لا توجد نتائج.' });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: 'فشل البحث في الويب.', detail: String(err.message || err) });
  }
});

/* ===================== مشاريع المواقع والأنفاق ===================== */
const SITE_FILES = ['index.html', 'styles.css', 'script.js'];

function readSiteFiles(dir) {
  const files = [];
  for (const name of SITE_FILES) {
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        files.push({ name, content: fs.readFileSync(p, 'utf8').slice(0, 200000) });
      }
    } catch { /* ملف غير قابل للقراءة — نتجاهله */ }
  }
  return files;
}

/* يجمع ملفات الموقع الثلاثة من مجلد الجلسة أو مجلد فرعي واحد، ويُصدَّر للاختبارات */
export function collectSiteProject(cwd) {
  let files = readSiteFiles(cwd);
  if (files.length < 2) {
    let entries = [];
    try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sub = readSiteFiles(path.join(cwd, entry.name));
      if (sub.length >= 2) { files = sub; break; }
    }
  }
  return files.length >= 2 ? files : null;
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9.-]+\.(?:loca\.lt|ngrok(?:-free)?\.(?:io|app)|trycloudflare\.com|serveo\.net)\b[^\s)"']*/gi;
export function extractTunnelUrls(stdout) {
  const found = String(stdout || '').match(TUNNEL_URL_RE) || [];
  return [...new Set(found.map((u) => u.replace(/[.,]+$/, '')))];
}

/* ===================== Health & Models ===================== */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'NEXUS AI Agent', keyConfigured: Boolean(API_KEY), workspace: WORKSPACE, search: true });
});

app.get('/api/models', (_req, res) => {
  res.json({ models: MODELS });
});

/* ===================== تنفيذ أمر مباشر (الترمنال اليدوي) ===================== */
app.post('/api/exec', async (req, res) => {
  const { command, sessionId, timeout } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'الأمر مطلوب.' });
  }
  const sid = typeof sessionId === 'string' && sessionId.slice(0, 32) || 'manual';
  const t = Math.min(Number(timeout) || EXEC_TIMEOUT, 60000);
  const result = await runCommand(sid, command, t);
  res.json({ ...result, sessionId: sid });
});

/* ===================== المحادثة العادية (Streaming) ===================== */
app.post('/api/chat', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, systemPrompt } = req.body || {};

    if (!API_KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY غير مضبوط على الخادم.' });
    if (!model || !ALLOWED_IDS.has(model)) return res.status(400).json({ error: 'موديل غير مسموح به.' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'الرسائل مطلوبة.' });

    const payloadMessages = [];
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
      payloadMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m && (m.role === 'user' || m.role === 'assistant') && m.content != null) {
        payloadMessages.push({ role: m.role, content: m.content });
      }
    }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const upstream = await fetchNvidiaWithRetry({
      model,
      messages: payloadMessages,
      stream: true,
      temperature: typeof temperature === 'number' ? temperature : 0.6,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : 8192,
      stream_options: { include_usage: true },
    }, controller.signal);

    if (upstream.failed || !upstream.body) {
      return res.status(upstream.status || 502).json({
        error: 'خطأ من خدمة NVIDIA بعد إعادة المحاولة.',
        status: upstream.status,
        detail: upstream.detail || '',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'خطأ داخلي في الخادم.', detail: String(err.message || err) });
    } else {
      res.end();
    }
  }
});

/* ===================== الوكيل الذكي (Agent Loop) ===================== */
const AGENT_SYSTEM = (cwd) => `أنت NEXUS، وكيل ذكاء اصطناعي لديك صلاحيات وصول لجهاز كمبيوتر حقيقي يعمل بنظام Linux داخل بيئة آمنة.
لديك أداتان فقط:
• run_command — تنفذ أوامر bash في جلسة ثابتة (مجلد العمل محفوظ بين الأوامر). البيئة عليها python3 و node و npm و git و curl وأدوات Linux.
• web_search — تبحث في الويب وتعيد نتائج حقيقية (عنوان، رابط، مقتطف) لتلخّصها للمستخدم.
مجلد العمل الحالي: ${cwd}

متى تستخدم web_search (مهم جداً — ميّز نية السؤال):
• استخدمها فقط عندما يحتاج السؤال معلومات حديثة أو من الإنترنت: أخبار، أسعار، إصدارات برمجيات حديثة، أحداث جارية، مواقع رسمية، إحصائيات متغيرة، أو معلومات حالية عن شخصية أو شركة.
• لا تستخدمها في: المعرفة العامة، الشرح، البرمجة، الرياضيات، الكتابة، تلخيص نص أُرسل لك، أو المحادثة العادية — أجب عنها مباشرة بدون بحث.
• ابحث مرة واحدة بسؤال مركز، وابنِ إجابتك من النتائج مع ذكر المصادر كروابط، وإن لم تجد نتائج كافية قل ذلك بصراحة.

بروتوكول استدعاء الأدوات (التزم به حرفياً):
1. كل استدعاء يخرج كتلة مستقلة بهذا الشكل بالضبط، بدون أي نص آخر داخلها:
<tool_call>
{\"name\":\"run_command\",\"arguments\":{\"command\":\"python3 script.py\"}}
</tool_call>
   أو للبحث في الويب:
<tool_call>
{\"name\":\"web_search\",\"arguments\":{\"query\":\"أحدث إصدار Node.js 2026\"}}
</tool_call>
2. الصيغ البديلة المقبولة أيضاً: كتلة \`\`\`run_command فيها الأمر مباشرة، أو JSON خالٍ بنفس البنية، أو مصفوفة JSON من هذه الكائنات.
3. ممنوع منعاً باتاً إخراج رموز غريبة مثل ]<]minimax[> أو أي JSON خام خارج الوسوم أعلاه — الكلام العادي للبشر، والوسوم فقط للأدوات.
4. ممنوع منعاً باتاً كتابة أوامر أو سكربتات bash في النص العادي أو داخل أسوار \`\`\`bash أو \`\`\`sh أو \`\`\`shell — أي أمر تريد تشغيله لازم يكون داخل إحدى الصيغ أعلاه حصراً، ولا تكرر محتوى الملفات الطويل في ردك النصي.
5. انتظر نتيجة التنفيذ التي ستصل لك في وسم <tool_result> ثم قرر: إما استدعاء آخر، أو الإجابة النهائية.
6. لا تختلق مخرجات الأوامر أو نتائج البحث — اعتمد فقط على ما يصلك في <tool_result>.
7. اكتب إجاباتك النهائية بالعربية وبأسلوب Markdown منظم، واذكر الملفات والأوامر والروابط المهمة.

ترشيد الاستدعاءات (الخدمة محدودة بـ 40 طلباً في الدقيقة):
• اجمع كل أوامر bash المتعلقة بمهمة واحدة في استدعاء واحد طويل متعدد الأسطر (&& و heredoc) بدل تقسيمها لطلبات صغيرة.
• أنشئ الملفات كاملة في استدعاء واحد، واختبرها في استدعاء تالٍ فقط عند اللزوم — لا تكرر المحاولات إلا بعد فشل حقيقي.
• الحد الأقصى ${AGENT_MAX_STEPS} خطوات تنفيذ — أنهِ المهمة بأقل عدد ممكن منها.

بناء المواقع (التزام صارم):
• عند طلب موقع أو صفحة ويب، أنشئ الملفات بهذه الأسماء حصراً في مجلد العمل: index.html و styles.css و script.js (ثلاثة ملفات فقط، بدون مجلدات).
• اكتبها عبر heredoc في استدعاء واحد مجمّع (cat <<'EOF' > index.html ...) ثم تحقق سريعاً في استدعاء تالٍ عند اللزوم فقط.
• لا تعرض محتوى الملفات في ردك النصي إطلاقاً (لا HTML ولا CSS ولا JS، ولا نصوصاً مهربة بشرطات \n) — التطبيق يكتشفها تلقائياً ويعرض للمستخدم معاينة حية وزر تحميل. إن فشلت الكتابة صحّح الأمر وأعد المحاولة بدل لصق المحتوى في الكلام.
• إن احتجت رابطاً عاماً مؤقتاً، استخدم localtunnel عبر npx في نفس الاستدعاء وسيظهر الرابط تلقائياً للمستخدم.

مثال صحيح لطلب "أنشئ ملفاً واعرضه":
<tool_call>
{\"name\":\"run_command\",\"arguments\":{\"command\":\"printf 'مرحبا' > hello.txt && cat hello.txt\"}}
</tool_call>`;

/* محلّل مرن لاستدعاءات الأدوات يفهم عدة صيغ يلجأ إليها الموديل */
/* رموز MiniMax الخاصة التي يسرّبها الموديل أحياناً حول استدعاءات الأدوات، مثل ]<]minimax[> */
const MINIMAX_MARKER_RE = /\]\<\][A-Za-z0-9._-]*\[\>/g;
const TOOL_NAME_RE = /"(?:run_command|web_search)"/;

/* أدلة shell القوية: سطر يحوي حلقة/تحويل/متغيرات/أوامر تحكم */
const SHELL_STRONG_RE = /2>&1|nohup\b|;\s*then\b|;\s*do\b|^\s*(fi|done)\s*$|\$\(|#!\s*\/|>\s*\/|--port\b|python3?\s+-m\b|\bnpx\s|\blocaltunnel\b|\bcurl\b|\bwget\b|echo\s+\$!|\[\s*["']?\$|\|\|\s*echo|\.pid\b|&&|\|\||&\s*$|<<\s*['"]?[A-Za-z_]|^\s*(cat|cd|ls|chmod|mkdir|rm|bash|sh|echo|npm|node|git|apt|pip|sleep|nohup|python3?)\b/;
const SHELL_MILD_RE = /^\s*#|^\s*["'}]|\\$|localhost|127\.0\.0\.1|^\s*$/;

/* سطر أوامر حقيقي (وليس جملة عربية تحوي كلمة تقنية) */
function isShellLine(line) {
  const t = String(line).trim();
  if (!t) return false;
  if ((t.match(/[؀-ۿ]/g) || []).length > 3 && !/^\s*#/.test(t)) return false;
  return SHELL_STRONG_RE.test(t);
}
function isMildShellLine(line) {
  const t = String(line);
  if (!t.trim()) return true;
  if (SHELL_MILD_RE.test(t)) return true;
  /* تعليق عربي داخل سكربت (يبدأ بـ #) أو سطر قصير أغلبه رموز */
  if (/^\s*#/.test(t)) return true;
  if ((t.match(/[؀-ۿ]/g) || []).length <= 3 && /[&|>$(){};]/.test(t)) return true;
  return false;
}

/* هل جسم السوار سكربت shell يستحق التنفيذ؟ */
function looksShellScript(body) {
  if (/^#!\s*\/(bin|usr)\//.test(body.trim())) return true;
  const lines = body.split('\n');
  let strong = 0;
  for (const l of lines) if (isShellLine(l)) strong++;
  return strong >= 2 || (strong >= 1 && lines.length >= 2);
}

/* يزيل شظايا أوامر shell المتسرسبة خارج الأسوار من نص المحادثة، مع إبقاء الجمل العربية */
function stripShellFragments(text) {
  const lines = String(text).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isShellLine(decodeEntities(lines[i]))) {
      let j = i;
      let strong = 0;
      while (j < lines.length) {
        if (isShellLine(decodeEntities(lines[j]))) strong++;
        else if (!isMildShellLine(decodeEntities(lines[j]))) break;
        j++;
      }
      if (strong >= 1) { i = j; continue; }
    }
    out.push(lines[i]); i++;
  }
  /* تنظيف آثار الحواف: علامات اقتباس/أقواس يتيمة وفراغات */
  return out.join('\n')
    .replace(/^[ \t]*["'}]{1,2}[ \t]*/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/* يستخرج كل كتل JSON المتوازنة (كائنات {…} ومصفوفات […]) من نص مختلط، متجاهلاً الفواصل المبتورة */
function extractJsonBlocks(text) {
  const blocks = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) { blocks.push(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return blocks;
}

/* يحوّل كائناً واحداً لاستدعاء أداة موحّد، أو null إن لم يكن استدعاءً صالحاً */
function callFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.name === 'run_command') {
    const command = obj.arguments?.command ?? obj.command;
    if (typeof command === 'string' && command.trim()) return { name: 'run_command', command: command.trim() };
  }
  if (obj.name === 'web_search') {
    const query = obj.arguments?.query ?? obj.query ?? obj.arguments?.q;
    if (typeof query === 'string' && query.trim()) return { name: 'web_search', query: query.trim() };
  }
  return null;
}

/* انتشال يدوي لقيمة حقل نصية من JSON مكسور/مبتور — يقبل أيضاً السلسلة المفتوحة بلا علامة إغلاق */
function salvageString(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`));
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); }
  catch { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}

export function parseToolCalls(content) {
  const calls = [];
  const seen = new Set();
  const pushCall = (call) => {
    if (!call) return;
    const key = call.name === 'web_search' ? `web:${call.query}` : `cmd:${call.command}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(call);
  };
  const pushCommand = (command) => {
    const cmd = String(command || '').trim();
    if (cmd) pushCall({ name: 'run_command', command: cmd });
  };

  /* محاولة JSON مع fallback لاستخراج القيادة حتى من JSON مكسور */
  const tryJson = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of list) {
        const call = callFromObject(obj);
        if (call) pushCall(call);
      }
      if (list.some((o) => callFromObject(o))) return true;
    } catch { /* نكمل لاستخراج يدوي */ }
    const cmd = salvageString(raw, 'command');
    if (cmd) { pushCommand(cmd); return true; }
    const q = salvageString(raw, 'query');
    if (q) { pushCall({ name: 'web_search', query: q }); return true; }
    return false;
  };

  let m;
  /* 1) الوسم الرسمي <tool_call>...</tool_call> */
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = tagRe.exec(content)) !== null) tryJson(m[1]);

  /* 2) كتلة كود: أسوار أدوات معرّفة أو أسوار shell حاول الموديل تنفيذها عبرها */
  const fenceRe = /```(run_command|tool_call|bash-tool|bash|sh|shell|zsh|console)?[ \t]*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(content)) !== null) {
    const tag = m[1];
    const body = m[2].trim();
    if (!body) continue;
    if (body.startsWith('{') || body.startsWith('[')) tryJson(body);
    /* سوار مُسمّى بنية تنفيذ صريحة → ينفذ دائماً. السوار الافتراضي يحتاج دلائل shell */
    else if (tag || looksShellScript(body)) pushCommand(body);
  }

  /* 3) صيغة استدعاء دالة عارية: run_command("...") */
  const fnRe = /run_command\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\{[\s\S]*?\}))\s*\)/g;
  while ((m = fnRe.exec(content)) !== null) {
    if (m[1] || m[2]) {
      const lit = m[1] || m[2];
      try { pushCommand(JSON.parse(`"${lit}"`)); } catch { pushCommand(lit); }
    } else if (m[3]) tryJson(m[3]);
  }

  /* 4) الصيغة الخام لـ MiniMax: رموز ]<]minimax[> ومصفوفات/كائنات JSON كاملة أو مبتورة */
  const stripped = content.replace(MINIMAX_MARKER_RE, '');
  for (const block of extractJsonBlocks(stripped)) {
    if (TOOL_NAME_RE.test(block)) tryJson(block);
  }
  /* انتشال الكتل المبتورة التي لم تُغلق بعد (تسريب أثناء البث) */
  if (/[\[{]\s*"name"\s*:\s*"(?:run_command|web_search)"/.test(stripped)) {
    const danglingRe = /[\[{]\s*"name"\s*:\s*"(run_command|web_search)"[\s\S]*?(?=[؀-ۿ]{3,}|$)/g;
    while ((m = danglingRe.exec(stripped)) !== null) {
      const cmd = salvageString(m[0], 'command');
      const q = salvageString(m[0], 'query');
      if (cmd) pushCommand(cmd);
      else if (q) pushCall({ name: 'web_search', query: q });
    }
  }

  return calls;
}

/* يكشف نية استدعاء أداة فشل تحليلها حتى نطلب من الموديل التصحيح */
function looksLikeToolIntent(content) {
  return /<tool_call|run_command|web_search|tool_call|\]\<\]/.test(content);
}

/* ينظّف النص الظاهر للمستخدم من أي تسريب لصيغ استدعاء الأدوات داخل الكلام العادي */
function stripToolText(text) {
  if (!text) return '';
  let out = text
    /* رموز MiniMax الخاصة مثل ]<]minimax[> */
    .replace(MINIMAX_MARKER_RE, '')
    /* كتل الوسم الكاملة */
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    /* كتل أسوار الأدوات وshell — سكربتات تنفيذية لا تظهر للمستخدم */
    .replace(/```(?:run_command|tool_call|bash-tool|bash|sh|shell|zsh|console)[\s\S]*?```/g, '')
    /* كود مضمن (inline) يحوي JSON الأداة أو استدعاء الدالة */
    .replace(/`[^`\n]*(?:"(?:run_command|web_search)"|run_command\s*\()[^`\n]*`/g, '')
    /* صيغة استدعاء دالة عارية */
    .replace(/run_command\s*\(\s*(?:"(?:[^"\\]|\\.)*"|\{[\s\S]*?\})\s*\)/g, '')
    /* بقايا الوسوم */
    .replace(/<\/?tool_call>/g, '');

  /* كل كتل JSON المتوازنة التي تحوي استدعاءات أدوات (كائنات أو مصفوفات) */
  for (const block of extractJsonBlocks(out)) {
    if (TOOL_NAME_RE.test(block)) out = out.split(block).join('');
  }
  /* JSON أداة مكتمل بصيغة حرفية احتياطية */
  out = out
    .replace(/\{?\s*"name"\s*:\s*"(?:run_command|web_search)"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}?/g, '')
    .replace(/\[\s*\]\s*/g, '');

  /* جزء JSON أداة مبتور في المقدمة: من القوس حتى أول كلام عربي/سوار/عنوان */
  out = out.replace(/^\s*[\[{][\s\S]*?(?=[؀-ۿ]|```|#)/, '');

  /* شظايا أوامر shell المتسرسبة خارج الأسوار (nohup/curl/heredoc/أنفاق …) */
  out = stripShellFragments(out);

  /* فراغات زائدة */
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  /* كتلة/فاتحة أداة مفتوحة لم تكتمل بعد — نوقف إظهارها حتى يكتمل السياق أثناء البث */
  let cut = -1;
  for (const marker of ['<tool_call>', '```run_command', '```tool_call', '```bash-tool', '```bash', '```sh', '```shell', ']<]']) {
    const i = out.lastIndexOf(marker);
    if (i > cut) cut = i;
  }
  /* فاتحة JSON أداة مبتورة (كائن أو مصفوفة) — فقط إذا كانت تخص أداة فعلية، لا JSON توضيحياً */
  const toolHead = /[\[{]\s*"name"\s*:\s*"(?:run_command|web_search)"/g;
  let hm;
  while ((hm = toolHead.exec(out)) !== null) cut = Math.max(cut, hm.index);
  /* قوس JSON في المقدمة لم يُغلق بعد ولم يصل كلام عربي — كبح الجزء المبتور أثناء البث */
  if (/^\s*[\[{]/.test(out) && !/[}\]]/.test(out) && !/[؀-ۿ]/.test(out)) cut = Math.max(cut, 0);
  if (cut !== -1) out = out.slice(0, cut);
  /* أقواس يتيمة خلّفها قصّ الكتل المبتورة */
  out = out.replace(/[\[{]\s*$/, '').trim();
  return out;
}

app.post('/api/agent', async (req, res) => {
  const { model, messages, temperature, max_tokens, systemPrompt, sessionId } = req.body || {};

  if (!API_KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY غير مضبوط على الخادم.' });
  if (!model || !ALLOWED_IDS.has(model)) return res.status(400).json({ error: 'موديل غير مسموح به.' });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'الرسائل مطلوبة.' });

  const sid = (typeof sessionId === 'string' ? sessionId.slice(0, 40) : 'agent') || 'agent';
  if (!sessions.has(sid)) sessions.set(sid, { cwd: WORKSPACE });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const history = [];
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
      history.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m && (m.role === 'user' || m.role === 'assistant') && m.content != null) {
        history.push({ role: m.role, content: m.content });
      }
    }

    let usage = null;
    let toolSeq = 0;

    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
      if (aborted) return;
      const sess = sessions.get(sid) || { cwd: WORKSPACE };
      const loopMessages = [
        { role: 'system', content: AGENT_SYSTEM(sess.cwd) },
        ...history,
      ];

      const controller = new AbortController();
      const upstreamTimer = setTimeout(() => controller.abort(), 120000);
      const onClose = () => controller.abort();
      res.on('close', onClose);

      let upstream;
      try {
        upstream = await fetchNvidiaWithRetry({
          model,
          messages: loopMessages,
          stream: true,
          temperature: typeof temperature === 'number' ? temperature : 0.5,
          max_tokens: typeof max_tokens === 'number' ? max_tokens : 8192,
          stream_options: { include_usage: true },
        }, controller.signal, ({ attempt, status }) => {
          send({ type: 'retry', attempt, status, message: status === 429 ? 'الخدمة مشغولة، إعادة محاولة...' : 'إعادة المحاولة بعد اهتزاز الشبكة...' });
        });
      } finally {
        clearTimeout(upstreamTimer);
        res.removeListener('close', onClose);
      }

      if (upstream.failed || !upstream.body) {
        send({ type: 'error', message: `خطأ من خدمة NVIDIA (${upstream.status}) بعد إعادة المحاولة: ${String(upstream.detail || '').slice(0, 400)}` });
        return res.end();
      }

      /* تجميع الرد مع إخفاء كتل الأدوات أثناء البث بكل صيغها */
      let full = '';
      let cleanEmitted = 0;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.usage) usage = json.usage;
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) send({ type: 'reasoning', delta: delta.reasoning_content });
            if (delta.content) {
              full += delta.content;
              const clean = stripToolText(full);
              if (clean.length > cleanEmitted) {
                send({ type: 'text', delta: clean.slice(cleanEmitted) });
                cleanEmitted = clean.length;
              }
            }
          } catch { /* سطر غير صالح */ }
        }
      }

      const calls = parseToolCalls(full);
      history.push({ role: 'assistant', content: full });

      if (calls.length === 0) {
        /* نية أداة واضحة لكن الصيغة فشلت — نطلب من الموديل التصحيح بدل إنهاء المهمة */
        if (looksLikeToolIntent(full) && step < AGENT_MAX_STEPS - 1) {
          send({ type: 'tool_parse_retry' });
          history.push({
            role: 'user',
            content: '<tool_result>\n{"error":"تعذّر تحليل استدعاء الأداة. أعد إصدار الأمر فوراً بالصيغة الصحيحة فقط: <tool_call>\\n{\\"name\\":\\"run_command\\",\\"arguments\\":{\\"command\\":\\"أمرك هنا\\"}}\\n</tool_result>',
          });
          continue;
        }
        send({ type: 'done', usage });
        return res.end();
      }

      for (const call of calls) {
        if (aborted) return;
        const id = `tool_${++toolSeq}`;

        if (call.name === 'web_search') {
          send({ type: 'tool', id, tool: 'web_search', query: call.query, status: 'running' });
          try {
            const found = await webSearch(call.query);
            send({
              type: 'tool_result', id, code: 0, tool: 'web_search',
              source: found.source, results: found.results,
            });
            history.push({
              role: 'user',
              content: `<tool_result>\n${JSON.stringify({
                web_search: call.query,
                source: found.source,
                results: found.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
              })}\n</tool_result>`,
            });
          } catch (searchErr) {
            const detail = String(searchErr.message || searchErr);
            send({ type: 'tool_result', id, code: 1, tool: 'web_search', error: detail, results: [] });
            history.push({
              role: 'user',
              content: `<tool_result>\n${JSON.stringify({ web_search: call.query, error: detail })}\n</tool_result>`,
            });
          }
          continue;
        }

        send({ type: 'tool', id, command: call.command, status: 'running' });
        const result = await runCommand(sid, call.command);
        send({
          type: 'tool_result', id,
          code: result.code, stdout: result.stdout, stderr: result.stderr,
          cwd: result.cwd, durationMs: result.durationMs,
        });

        /* مواقع أنشأها الوكيل عبر shell: ندفع ملفاتها للواجهة لإظهار المعاينة الحية */
        try {
          const siteFiles = collectSiteProject(result.cwd);
          if (siteFiles) {
            const hash = crypto.createHash('md5').update(JSON.stringify(siteFiles)).digest('hex');
            if (sess.siteHash !== hash) {
              sess.siteHash = hash;
              send({ type: 'site_project', files: siteFiles });
            }
          }
        } catch { /* لا نكسر التدفق بسبب فحص الملفات */ }

        /* روابط أنفاق عامة (localtunnel/ngrok/cloudflare) ظهرت في مخرجات الأمر */
        try {
          for (const url of extractTunnelUrls(`${result.stdout}\n${result.stderr}`)) {
            if (!sess.liveUrls) sess.liveUrls = new Set();
            if (!sess.liveUrls.has(url)) {
              sess.liveUrls.add(url);
              send({ type: 'live_url', id: `live_${Date.now()}`, url });
            }
          }
        } catch { /* تجاهل */ }

        history.push({
          role: 'user',
          content: `<tool_result>\n${JSON.stringify({
            exit_code: result.code,
            stdout: result.stdout.slice(-6000),
            stderr: result.stderr.slice(-3000),
            cwd: result.cwd,
          })}\n</tool_result>`,
        });
      }
    }

    send({ type: 'error', message: `وصل الوكيل للحد الأقصى من خطوات التنفيذ (${AGENT_MAX_STEPS}).` });
    res.end();
  } catch (err) {
    if (aborted) return res.end();
    send({ type: 'error', message: String(err.message || err) });
    res.end();
  }
});

/* ===================== ملفات الواجهة ===================== */
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 4000;
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  NEXUS AI Agent running → http://0.0.0.0:${PORT}`);
    console.log(`  Agent workspace      → ${WORKSPACE}\n`);
  });
}

export { fetchNvidiaWithRetry, runCommand, capOutput, app, stripToolText };
