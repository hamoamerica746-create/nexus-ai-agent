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

    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages: payloadMessages,
        stream: true,
        temperature: typeof temperature === 'number' ? temperature : 0.6,
        max_tokens: typeof max_tokens === 'number' ? max_tokens : 8192,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return res.status(upstream.status || 502).json({ error: 'خطأ من خدمة NVIDIA.', status: upstream.status, detail });
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
2. انتظر نتيجة التنفيذ التي ستصل لك في وسم <tool_result> ثم قرر: إما أمر آخر، أو الإجابة النهائية.
3. نظّم الحل: أنشئ ملفات بالـ heredoc أو python3، نفذ، اختبر، ثم لخّص النتيجة للمستخدم.
4. لا تختلق مخرجات الأوامر — اعتمد فقط على ما يصلك في <tool_result>.
5. اكتب إجاباتك النهائية بالعربية وبأسلوب Markdown منظم، واذكر الملفات والأوامر المهمة.
6. الحد الأقصى ${AGENT_MAX_STEPS} خطوات تنفيذ — أنهِ المهمة بكفاءة.`;

function parseToolCalls(content) {
  const calls = [];
  const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj?.name === 'run_command' && typeof obj.arguments?.command === 'string') {
        calls.push({ name: 'run_command', command: obj.arguments.command.trim() });
      }
    } catch { /* كتلة غير صالحة نتجاهلها */ }
  }
  return calls;
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
        upstream = await fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model,
            messages: loopMessages,
            stream: true,
            temperature: typeof temperature === 'number' ? temperature : 0.5,
            max_tokens: typeof max_tokens === 'number' ? max_tokens : 8192,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(upstreamTimer);
        res.removeListener('close', onClose);
      }

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        send({ type: 'error', message: `خطأ من خدمة NVIDIA (${upstream.status}): ${detail.slice(0, 500)}` });
        return res.end();
      }

      /* تجميع الرد مع إخفاء كتل الأدوات أثناء البث */
      let full = '';
      let cleanEmitted = 0;
      const stripToolBlocks = (text) => {
        let out = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
        const open = out.lastIndexOf('<tool_call>');
        if (open !== -1) out = out.slice(0, open); // كتلة مفتوحة لم تكتمل بعد
        return out;
      };
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
              const clean = stripToolBlocks(full);
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NEXUS AI Agent running → http://0.0.0.0:${PORT}`);
  console.log(`  Agent workspace      → ${WORKSPACE}\n`);
});
