/**
 * اختبار تكامل: خادم NVIDIA وهمي يرجّع 429 مرتين ثم نجاحاً،
 * للتأكد من إعادة المحاولة الشفافة ومرونة محلّل الأدوات والتنفيذ الفعلي على القرص.
 * التشغيل: node tests/test-integration.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const MOCK_PORT = 4590 + Math.floor(Math.random() * 200);
const APP_PORT = MOCK_PORT + 1;
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-it-'));

const counters = { chat: 0, agent: 0 };

const sse = (deltas) => {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}`);
  lines.push('data: [DONE]');
  return lines.join('\n\n') + '\n\n';
};

/* خادم NVIDIA وهمي: 429 مرتين ثم نجاح — يميز الوكيل من رسالة النظام */
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const isAgent = payload.messages?.some(
      (m) => typeof m.content === 'string' && m.content.includes('بروتوكول تنفيذ الأوامر')
    );
    const flow = isAgent ? 'agent' : 'chat';
    /* نتيجة الأداة الحقيقية تكون آخر رسالة؛ الـ system prompt الأول يحوي المثال نصاً */
    const last = payload.messages.at(-1);
    const hasToolResult = typeof last?.content === 'string' && last.content.includes('<tool_result>');

    if (hasToolResult) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(sse([
        { content: 'تم تنفيذ الأمر بنجاح، والملف يحتوي على النص المتوقع.' },
        { usage: { total_tokens: 123 } },
      ]));
    }

    counters[flow]++;
    if (counters[flow] <= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      return res.end(JSON.stringify({ status: 429, title: 'Too Many Requests' }));
    }

    if (isAgent) {
      /* رد بصيغة كتلة كود بديلة لاختبار مرونة المحلّل */
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(sse([
        { reasoning_content: 'سأنفذ الأمر عبر صيغة بديلة' },
        { content: 'سأتحقق من البيئة:\n```run_command\necho integration-ok > marker.txt && cat marker.txt\n```' },
      ]));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse([{ content: 'pong' }]));
  });
});

await new Promise((r) => mock.listen(MOCK_PORT, r));
console.log('✓ خادم NVIDIA الوهمي شغّال');

const app = spawn('node', [SERVER], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NVIDIA_API_KEY: 'fake-test-key',
    UPSTREAM_URL: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
    AGENT_WORKSPACE: WORKSPACE,
    PORT: String(APP_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appDied = false;
let stopped = false;
app.on('exit', (code) => {
  appDied = true;
  if (!stopped) console.error('✗ الخادم خرج مبكراً بكود', code);
});
app.stderr.on('data', (d) => process.stdout.write('[app] ' + d));

/* انتظار صحة الإقلاع فعلياً */
let healthy = false;
for (let i = 0; i < 30; i++) {
  if (appDied) break;
  try {
    const h = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
    if (h.ok) { healthy = true; break; }
  } catch { /* لسه بيقلع */ }
  await sleep(200);
}
assert.ok(healthy, 'الخادم فشل في الإقلاع (منفذ مشغول أو خطأ)');
console.log('✓ خادم التطبيق قلع و /api/health يرد');

const post = (p, b) => fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});

try {
  /* [1] /api/chat يصمد أمام 429 وينجح في المحاولة الثالثة */
  console.log('\n[1] إعادة المحاولة في /api/chat ...');
  const t0 = Date.now();
  const r1 = await post('/api/chat', {
    model: 'minimaxai/minimax-m3.1-flash',
    messages: [{ role: 'user', content: 'اختبر' }],
  });
  assert.equal(r1.status, 200, 'المفروض ينجح بعد إعادة المحاولة');
  const txt1 = await r1.text();
  assert.ok(txt1.includes('pong'), 'المحتوى النهائي وصل');
  assert.ok(txt1.includes('[DONE]'), 'بث SSE مكتمل');
  console.log(`  ✓ نجا من 429 ×2 ورد في ${Date.now() - t0}ms`);

  /* [2] /api/agent يفهم الصيغة البديلة وينفذ الأمر فعلاً */
  console.log('\n[2] الوكيل مع صيغة كتلة الكود البديلة ...');
  const r2 = await post('/api/agent', {
    model: 'minimaxai/minimax-m3.1-flash',
    messages: [{ role: 'user', content: 'اعمل ملف marker.txt' }],
    sessionId: 'integration-test',
  });
  assert.equal(r2.status, 200);
  const events = (await r2.text())
    .split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()));
  const types = events.map((e) => e.type);
  console.log('  أنواع الأحداث:', types.join(', '));
  assert.ok(types.includes('retry'), 'حدث إعادة محاولة لازم يتبعت للعميل');
  assert.ok(types.includes('tool'), 'لازم يكتشف الأمر وينفذه');
  const toolRes = events.find((e) => e.type === 'tool_result');
  assert.equal(toolRes.code, 0, 'الأمر لازم ينجح بـ exit 0');
  assert.ok(toolRes.stdout.includes('integration-ok'));
  assert.ok(types.includes('done'), 'الوكيل ينهي بإجابة');
  assert.ok(fs.existsSync(path.join(WORKSPACE, 'marker.txt')), 'الملف اتخلق على القرص فعلاً');
  assert.equal(fs.readFileSync(path.join(WORKSPACE, 'marker.txt'), 'utf8').trim(), 'integration-ok');
  console.log('  ✓ الصيغة البديلة اتفسّرت، والأمر اتنفذ، والملف موجود على القرص');

  /* [3] الترمنال المباشر */
  console.log('\n[3] /api/exec ...');
  const r3 = await post('/api/exec', { command: 'node -v', sessionId: 't' });
  const j3 = await r3.json();
  assert.equal(j3.code, 0);
  assert.match(j3.stdout, /v\d+/);
  console.log('  ✓ الترمنال المباشر شغّال:', j3.stdout.trim());

  console.log('\n🎉 كل اختبارات التكامل نجحت');
} catch (e) {
  console.error('\n✗ فشل الاختبار:', e.message);
  process.exitCode = 1;
} finally {
  stopped = true;
  app.kill('SIGKILL');
  mock.close();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
}
