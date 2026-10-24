/**
 * اختبارات الوظائف الجديدة:
 * 1) اقتناص تسريبات MiniMax ]<]minimax[> والمصفوفات المبتورة (عينات من بلاغ حقيقي).
 * 2) تحليل أداة web_search.
 * 3) محلل نتائج البحث HTML.
 * 4) منظّف النصوص يبقي الكلام العربي ويمحو كل بقايا الأدوات.
 * التشغيل: node tests/test-leak-search.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseToolCalls, stripToolText, parseSearchHtml,
  collectSiteProject, extractTunnelUrls,
} from '../server.js';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, `فشل: ${name}`); console.log(`  ✓ ${name}`); passed++; };

/* ---------- 1) عينة مطابقة لبلاغ المستخدم الحقيقي ---------- */
const realLeak = `تمام، فهمت قصدك. أولاً أتحقق من البيئة:]<]minimax[>[
{"name":"run_command","arguments":{"command":"cd /app/workspace && ls -la && python3 -V"}}]
المتاح: البيئة سليمة. سأنشئ السكربت بشكل نظيف:]<]minimax[>[
{"name":"run_command","arguments":{"command":"cat > system_report.py << 'PYEOF'\\nprint(\\"hi\\")\\nPYEOF\\npython3 -m py_compile system_report.py"}}]
سأختبر صيغة الأمر أولاً بأمر بسيط.]<]minimax[>[
{"name":"run_command","arguments":{"command":"echo test-ok && ls"}}]`;

const calls = parseToolCalls(realLeak);
ok('اقتنص 3 أوامر من تسريبات MiniMax', calls.length === 3);
ok('كلها run_command', calls.every((c) => c.name === 'run_command'));
ok('الأمر الأول صحيح', calls[0].command === 'cd /app/workspace && ls -la && python3 -V');
ok('أمر الـ heredoc محفوظ كاملاً', calls[1].command.includes("system_report.py") && calls[1].command.includes('py_compile'));
ok('الأمر الأخير صحيح', calls[2].command === 'echo test-ok && ls');

const cleaned = stripToolText(realLeak);
ok('المنظّف أزال رموز ]<]minimax[>', !cleaned.includes('minimax') && !cleaned.includes(']<]'));
ok('المنظّف أزال JSON الخام', !cleaned.includes('"name"') && !cleaned.includes('run_command'));
ok('المنظّف أبقى الكلام العربي', cleaned.includes('أولاً أتحقق من البيئة') && cleaned.includes('سأختبر صيغة الأمر'));

/* ---------- 2) تسرب مبتور أثناء البث (مصفوفة لم تُغلق بعد) ---------- */
const truncated = 'سأختبر صيغة الأمر أولاً بأمر بسيط.]<]minimax[>[{"name":"run_command","arguments":{"command":"cd /app/workspace && echo test-ok && ls';
const tClean = stripToolText(truncated);
ok('الكتلة المبتورة تُقص أثناء البث', !tClean.includes('run_command') && !tClean.includes('minimax'));
ok('الكلام قبل التسريب يبقى ظاهراً', tClean.includes('بأمر بسيط'));
const tCalls = parseToolCalls(truncated);
ok('انتشال الأمر من JSON مبتور', tCalls.some((c) => c.command?.includes('echo test-ok')));

/* ---------- 3) web_search عبر الوسم الرسمي وعبر مصفوفة MiniMax ---------- */
const tagSearch = '<tool_call>\n{"name":"web_search","arguments":{"query":"أحدث إصدار Node.js 2026"}}\n</tool_call>';
const s1 = parseToolCalls(tagSearch);
ok('بحث عبر الوسم الرسمي', s1.length === 1 && s1[0].name === 'web_search' && s1[0].query.includes('Node.js'));
ok('منظّف النصوص يمحو وسم البحث', !stripToolText('قبل البحث\n' + tagSearch + '\nبعد النتائج').includes('web_search'));

const markerSearch = 'خليني أبحث لك عن آخر الأخبار:]<]minimax[>[{"name":"web_search","arguments":{"query":"أسعار الذهب اليوم مصر 2026"}}]';
const s2 = parseToolCalls(markerSearch);
ok('بحث عبر صيغة MiniMax', s2.length === 1 && s2[0].name === 'web_search');
ok('استعلام البحث صحيح', s2[0].query === 'أسعار الذهب اليوم مصر 2026');
const s2clean = stripToolText(markerSearch);
ok('تنظيف البحث يبقي الجملة العربية', s2clean.includes('أبسط لك') === false && s2clean.includes('خليني أبحث لك') && !s2clean.includes('minimax'));

/* ---------- 4) مصفوفة فيها أداتان مختلفتان ---------- */
const mixed = ']<]minimax[>[{"name":"web_search","arguments":{"query":"مكتبة X أحدث إصدار"}},{"name":"run_command","arguments":{"command":"npm view x version"}}]';
const mixedCalls = parseToolCalls(mixed);
ok('مصفوفة مختلطة: بحث + أمر', mixedCalls.length === 2 && mixedCalls[0].name === 'web_search' && mixedCalls[1].name === 'run_command');
ok('تنظيف المصفوفة المختلطة كاملاً', stripToolText(mixed).trim() === '');

/* ---------- 5) الكلام البشري العادي لا يُلمس ---------- */
const prose = 'لعمل ذلك استخدم الدالة run_command في كودك، وهي تقرأ وسماً مثل {"name":"demo"} — هذا شرح وليس أمراً للتنفيذ.';
const pClean = stripToolText(prose);
ok('الشرح النظري داخل النص يبقى سليماً', pClean.includes('run_command') && pClean.includes('demo'));
ok('لا أوامر تُستخرج من سياق شرحي', parseToolCalls(prose).length === 0);

/* ---------- 6) محلل HTML للبحث ---------- */
const fixture = `
<html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews&amp;rut=x">عنوان &amp; تجريبي</a>
  <a class="result__snippet" href="#">هذا <b>مقتطف</b> تجريبي &amp; مفيد</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://direct.example.org/page">رابط مباشر</a>
  <div class="result__snippet">مقتطف ثانٍ</div>
</div>
</body></html>`;
const results = parseSearchHtml(fixture);
ok('استُخرجت نتيجتا بحث', results.length === 2);
ok('فك ترميز رابط uddg', results[0].url === 'https://example.com/news');
ok('العنوان نُظف من الوسوم والكيانات', results[0].title === 'عنوان & تجريبي');
ok('المقتطف نُظف', results[0].snippet.includes('مقتطف تجريبي & مفيد'));
ok('الرابط المباشر يبقى كما هو', results[1].url === 'https://direct.example.org/page');

/* ---------- 7) منع التكرار ---------- */
const dup = '<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>' +
  ']<]minimax[>[{"name":"run_command","arguments":{"command":"ls"}}]';
ok('الأمر المكرر بصيغتين يُحسب مرة واحدة', parseToolCalls(dup).length === 1);

/* ---------- 8) v1.2: أسوار bash/sh تتحول لأوامر صامتة ---------- */
const bashFence = '```bash\nmkdir -p site && cd site\necho hi > index.html\n```';
const bf = parseToolCalls(bashFence);
ok('سوار bash يُحلل كأمر تنفيذ', bf.length === 1 && bf[0].name === 'run_command' && bf[0].command.includes('mkdir'));
ok('سوار bash يُمسح من النص الظاهر', !stripToolText(bashFence).includes('mkdir'));

const shFence = '```sh\nnpm install && npm run build\n```';
ok('سوار sh يُحلل أيضاً', parseToolChars(shFence));
function parseToolChars(s) { const c = parseToolCalls(s); return c.length === 1 && c[0].command.includes('npm run build'); }

const pyFence = '```python\ndef hello():\n    print("hi")\n```';
ok('سوار python توضيحي لا يُنفذ كأمر', parseToolCalls(pyFence).length === 0);
ok('سوار python يبقى مرئياً كنص', stripToolText(pyFence).includes('print'));

const plainFence = '```\nخطوة 1: اكتب الكود\nخطوة 2: اختبره\n```';
ok('السوار الافتراضي بلا أوامر shell لا يُنفذ', parseToolCalls(plainFence).length === 0);

/* ---------- 9) v1.2: عيّنة التسريب الحقيقية (سكربت localtunnel مهرّب HTML) ---------- */
const leakRaw = `تمت إعادة المحاولة بنجاح.

" != "200" ]; then
 nohup python3 -m http.server 8000 > /tmp/py.log 2>&1 &
 sleep 2
fi

# شغّل نفق عام عبر localtunnel باستخدام npx
nohup npx localtunnel --port 8000 > /tmp/lt.log 2>&1 &
echo $! > /tmp/lt.pid

# انتظر 12 ثانية لتوليد الرابط العام
sleep 12
cat /tmp/lt.log
"}# تأكد أن بايثون شغال
code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000 2>/dev/null || echo "000")
if [ "$code" != "200" ]; then
 nohup python3 -m http.server 8000 --directory /app/workspace > /tmp/py.log 2>&1 &
 sleep 2
fi

# جرّب localtunnel عبر npx مع انتظار أطول
nohup npx localtunnel --port 8000 > /tmp

الموقع جاهز للمعاينة الآن.`;
const leakEsc = leakRaw.replace(/&/g, '&amp;').replace(/>/g, '&gt;');
for (const [tag, sample] of [['خام', leakRaw], ['مهرب HTML', leakEsc]]) {
  const clean = stripToolText(sample);
  for (const banned of ['nohup', 'localtunnel', 'curl', '2>&1', 'http.server', 'lt.pid', '&gt;', '&amp;', 'tmp/lt.log', 'sleep 12']) {
    ok(`[${tag}] لا بقايا: ${banned}`, !clean.includes(banned));
  }
  ok(`[${tag}] الجملة العربية الافتتاحية بقيت`, clean.includes('تمت إعادة المحاولة بنجاح'));
  ok(`[${tag}] الجملة العربية الختامية بقيت`, clean.includes('الموقع جاهز للمعاينة الآن'));
}

/* ---------- 9ب) كتل الملفات المُسلسلة بشرطات هروب (عينة حية من Render) ---------- */
const escapedDump = 'أنشأت الموقع بنجاح.\n' +
  'مرحباً</title>\\n <link rel=\\"stylesheet\\" href=\\"styles.css\\">\\n</head>\\n<body>\\n <main class=\\"hero\\">\\n <button id=\\"welcomeButton\\" type=\\"button\\">ابدأ</button>\\n' +
  '\nالمعاينة جاهزة الآن في اللوحة.';
const ec = stripToolText(escapedDump);
ok('كتل HTML المُهربة حُذفت بالكامل', !ec.includes('stylesheet') && !ec.includes('welcomeButton') && !ec.includes('\\n'));
ok('الجمل العربية حول التسريب بقيت', ec.includes('أنشأت الموقع بنجاح') && ec.includes('المعاينة جاهزة الآن في اللوحة'));
const normalBackslash = 'في بايثون استخدم \\n للانتقال لسطر جديد داخل النص.';
ok('ذكر \\n تعليمياً في جملة عربية لا يُقص', stripToolText(normalBackslash).includes('للانتقال لسطر جديد'));

/* ---------- 10) عدم الحساسية الخاطئة: ذكر تقني داخل جملة عربية ---------- */
const prose2 = 'يمكنك استخدام أداة curl لجلب الصفحة، ثم شغّل npm install داخل مشروعك عندما تكون جاهزاً.';
const c2 = stripToolText(prose2);
ok('الجملة العربية التي تذكر curl/npm تبقى سليمة', c2.includes('curl') && c2.includes('npm install'));
const inlineCode = 'شغّل الأمر `npm install` في الطرفية ثم أخبرني بالنتيجة.';
ok('الكود المضمن التوضيحي لا يُقص', stripToolText(inlineCode).includes('npm install'));

/* ---------- 11) روابط الأنفاق ---------- */
const tunOut = 'your url is: https://happy-cat-12.loca.lt\nngrok: https://ab-99.ngrok-free.app/ and https://cf.tunnel.trycloudflare.com,';
const urls = extractTunnelUrls(tunOut);
ok('استخراج ثلاثة روابط أنفاق', urls.length === 3);
ok('تقليم علامة الترقيم عن الرابط', urls[2] === 'https://cf.tunnel.trycloudflare.com');
ok('إزالة التكرار', extractTunnelUrls('https://a.loca.lt\nhttps://a.loca.lt').length === 1);
ok('النص العادي بلا روابط أنفاق', extractTunnelUrls('زر https://example.com/page').length === 0);

/* ---------- 12) اكتشاف مشاريع المواقع ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-site-'));
for (const [name, body] of [['index.html', '<h1>hi</h1>'], ['styles.css', 'h1{color:red}'], ['script.js', 'console.log(1)']]) {
  fs.writeFileSync(path.join(tmp, name), body);
}
const site = collectSiteProject(tmp);
ok('الموقع ثلاثي الملفات يُكتشف', site && site.length === 3 && site[0].name === 'index.html');
fs.rmSync(path.join(tmp, 'script.js'));
ok('ملفان يكفيان للاكتشاف', collectSiteProject(tmp).length === 2);
const sub = path.join(tmp, 'web');
fs.mkdirSync(sub);
fs.rmSync(path.join(tmp, 'styles.css'));
fs.writeFileSync(path.join(sub, 'index.html'), '<x>');
fs.writeFileSync(path.join(sub, 'styles.css'), 'x{}');
ok('الرجوع للمجلد الفرعي', collectSiteProject(tmp)[0].content === '<x>');
fs.rmSync(sub, { recursive: true, force: true });
ok('ملف واحد لا يكفي', collectSiteProject(tmp) === null);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nنجح ${passed} اختبار للتسريبات والبحث ✓`);
