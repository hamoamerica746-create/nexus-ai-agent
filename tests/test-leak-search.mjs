/**
 * اختبارات الوظائف الجديدة:
 * 1) اقتناص تسريبات MiniMax ]<]minimax[> والمصفوفات المبتورة (عينات من بلاغ حقيقي).
 * 2) تحليل أداة web_search.
 * 3) محلل نتائج البحث HTML.
 * 4) منظّف النصوص يبقي الكلام العربي ويمحو كل بقايا الأدوات.
 * التشغيل: node tests/test-leak-search.mjs
 */
import assert from 'node:assert/strict';
import { parseToolCalls, stripToolText, parseSearchHtml } from '../server.js';

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

console.log(`\nنجح ${passed} اختبار للتسريبات والبحث ✓`);
