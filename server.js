import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
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
const AGENT_MAX_STEPS = 6;
const NVIDIA_MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================== استدعاء NVIDIA مع إعادة محاولة تلقائية ===================== */
async function fetchNvidiaWithRetry(payload, externalSignal, onRetry = null) {
  let lastFailure = null;

  for (let attempt = 0; attempt < NVIDIA_MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

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

    const child = spawn(
      'bash',
      ['-lc', `${command}\nprintf '\\n%s%s' '${marker}' "$PWD"`],
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

/* ===================== Health & Models ===================== */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'NEXUS AI Agent', keyConfigured: Boolean(API_KEY), workspace: WORKSPACE });
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
لديك أداة واحدة اسمها run_command تنفذ أوامر bash في جلسة ثابتة (مجلد العمل الحالي محفوظ بين الأوامر).
البيئة مثبت عليها: python3 و node و npm و git و curl وأدوات Linux الأساسية.
مجلد العمل الحالي: ${cwd}

بروتوكول تنفيذ الأوامر (التزم به حرفياً):
1. عندما تحتاج لتنفيذ أمر، أخرج كتلة مستقلة بهذا الشكل بالضبط، بدون أي نص آخر داخلها:
<tool_call>
{"name":"run_command","arguments":{"command":"python3 script.py"}}
</tool_call>
2. الصيغ البديلة المقبولة أيضاً إذا تعذّرت الصيغة الأولى:
   أ) كتلة كود بهذا الشكل (ثلاث علامات اقتباس ثم run_command ثم الأمر):
   \`\`\`run_command
   ls -la
   \`\`\`
   ب) JSON خالٍ: {"name":"run_command","arguments":{"command":"pwd"}}
3. لا تكتب أوامر bash خام في النص العادي إذا كنت تريد تنفيذها — كل أمر تريد تشغيله لازم يكون داخل إحدى الصيغ أعلاه.
4. انتظر نتيجة التنفيذ التي ستصل لك في وسم <tool_result> ثم قرر: إما أمر آخر، أو الإجابة النهائية.
5. نظّم الحل: أنشئ ملفات بالـ heredoc أو python3، نفذ، اختبر، ثم لخّص النتيجة للمستخدم.
6. لا تختلق مخرجات الأوامر — اعتمد فقط على ما يصلك في <tool_result>.
7. اكتب إجاباتك النهائية بالعربية وبأسلوب Markdown منظم، واذكر الملفات والأوامر المهمة.
8. الحد الأقصى ${AGENT_MAX_STEPS} خطوات تنفيذ — أنهِ المهمة بكفاءة.

مثال صحيح لطلب "أنشئ ملفاً واعرضه":
<tool_call>
{"name":"run_command","arguments":{"command":"printf 'مرحبا' > hello.txt && cat hello.txt"}}
</tool_call>`;

/* محلّل مرن لاستدعاءات الأدوات يفهم عدة صيغ يلجأ إليها الموديل */
export function parseToolCalls(content) {
  const calls = [];
  const seen = new Set();
  const push = (command) => {
    const cmd = String(command || '').trim();
    if (!cmd || seen.has(cmd)) return;
    seen.add(cmd);
    calls.push({ name: 'run_command', command: cmd });
  };

  /* محاولة JSON مع fallback لاستخراج قيادة command حتى من JSON مكسور */
  const tryJson = (raw) => {
    try {
      const obj = JSON.parse(raw);
      if (obj?.name === 'run_command' && typeof obj.arguments?.command === 'string') return obj.arguments.command;
      if (obj?.name === 'run_command' && typeof obj.command === 'string') return obj.command;
    } catch { /* نكمل لاستخراج يدوي */ }
    const m = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try { return JSON.parse(`"${m[1]}"`); }
      catch { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
    }
    return null;
  };

  let m;
  /* 1) الوسم الرسمي <tool_call>...</tool_call> */
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = tagRe.exec(content)) !== null) {
    const cmd = tryJson(m[1]);
    if (cmd) push(cmd);
  }

  /* 2) كتلة كود مخصصة: ```run_command أو ```tool_call */
  const fenceRe = /```(?:run_command|tool_call|bash-tool)\s*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(content)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    if (body.startsWith('{')) {
      const cmd = tryJson(body);
      if (cmd) push(cmd);
    } else {
      push(body);
    }
  }

  /* 3) JSON خالٍ بدون الوسم */
  if (calls.length === 0) {
    const bareRe = /\{\s*"name"\s*:\s*"run_command"[\s\S]*?\}/g;
    while ((m = bareRe.exec(content)) !== null) {
      const cmd = tryJson(m[0]);
      if (cmd) push(cmd);
    }
  }

  /* 4) صيغة استدعاء دالة: run_command("...") أو run_command({...}) */
  if (calls.length === 0) {
    const fnRe = /run_command\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\{[\s\S]*?\}))\s*\)/g;
    while ((m = fnRe.exec(content)) !== null) {
      if (m[1] || m[2]) {
        const lit = m[1] || m[2];
        try { push(JSON.parse(`"${lit}"`)); } catch { push(lit); }
      } else if (m[3]) {
        const cmd = tryJson(m[3]);
        if (cmd) push(cmd);
      }
    }
  }

  return calls;
}

/* يكشف نية استدعاء أداة فشل تحليلها حتى نطلب من الموديل التصحيح */
function looksLikeToolIntent(content) {
  return /<tool_call|run_command|tool_call>/.test(content);
}

/* ينظّف النص الظاهر للمستخدم من أي تسريب لصيغ استدعاء الأداة داخل الكلام العادي */
function stripToolText(text) {
  if (!text) return '';
  let out = text
    /* كتل الوسم الكاملة */
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    /* كتل الأسوار المعرّفة */
    .replace(/```(?:run_command|tool_call|bash-tool)[\s\S]*?```/g, '')
    /* كود مضمن (inline) يحوي JSON الأداة أو استدعاء الدالة */
    .replace(/`[^`\n]*(?:"run_command"|run_command\s*\()[^`\n]*`/g, '')
    /* JSON خالٍ مكتمل للأداة في أي موضع */
    .replace(/\{?\s*"name"\s*:\s*"run_command"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}?/g, '')
    /* صيغة استدعاء دالة عارية */
    .replace(/run_command\s*\(\s*(?:"(?:[^"\\]|\\.)*"|\{[\s\S]*?\})\s*\)/g, '')
    /* بقايا الوسوم */
    .replace(/<\/?tool_call>/g, '');

  /* جزء JSON أداة مبتور في المقدمة (تسريب البث دائماً في البداية): من القوس حتى أول كلام عربي/سوار/عنوان */
  out = out.replace(/^\s*\{[\s\S]*?(?=[؀-ۿ]|```|#)/, '');

  /* فراغات زائدة */
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  /* كتلة/فاتحة أداة مفتوحة لم تكتمل بعد — نوقف إظهارها حتى يكتمل السياق أثناء البث */
  let cut = -1;
  for (const marker of ['<tool_call>', '```run_command', '```tool_call', '```bash-tool']) {
    const i = out.lastIndexOf(marker);
    if (i > cut) cut = i;
  }
  /* قوس JSON في المقدمة لم يُغلق بعد ولم يصل كلام عربي — كبح الجزء المبتور أثناء البث */
  if (/^\s*\{/.test(out) && !/\}/.test(out) && !/[؀-ۿ]/.test(out)) cut = Math.max(cut, 0);
  if (cut !== -1) out = out.slice(0, cut);
  return out.trim();
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
        send({ type: 'tool', id, command: call.command, status: 'running' });
        const result = await runCommand(sid, call.command);
        send({
          type: 'tool_result', id,
          code: result.code, stdout: result.stdout, stderr: result.stderr,
          cwd: result.cwd, durationMs: result.durationMs,
        });
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
