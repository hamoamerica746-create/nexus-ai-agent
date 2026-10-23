/**
 * اختبارات وحدة لمحلّل استدعاءات الأدوات — يغطي كل الصيغ المدعومة وحالات الانحراف.
 * التشغيل: node tests/test-parser.mjs
 */
import assert from 'node:assert/strict';
import { parseToolCalls, stripToolText } from '../server.js';

let passed = 0;
const check = (name, content, expectedCommands) => {
  const calls = parseToolCalls(content);
  assert.deepEqual(calls.map((c) => c.command), expectedCommands, `فشل: ${name}`);
  assert.ok(calls.every((c) => c.name === 'run_command'), `كل الاستدعاءات لازم تكون run_command — ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

/* 1) الوسم الرسمي */
check('وسم tool_call رسمي',
  '<tool_call>\n{"name":"run_command","arguments":{"command":"ls -la"}}\n</tool_call>',
  ['ls -la']);

/* 2) JSON مكسور جزئياً — استخراج يدوي للقيادة */
check('JSON مكسور بفاصلة زائدة',
  '<tool_call>{"name":"run_command","arguments":{"command":"python3 fib.py",}}</tool_call>',
  ['python3 fib.py']);

/* 3) وسمان متتاليان */
check('وسمان متتاليان',
  '<tool_call>{"name":"run_command","arguments":{"command":"mkdir app"}}</tool_call>' +
  '<tool_call>{"name":"run_command","arguments":{"command":"ls app"}}</tool_call>',
  ['mkdir app', 'ls app']);

/* 4) كتلة كود run_command */
check('كتلة كود run_command',
  '```run_command\nuname -a\n```',
  ['uname -a']);

/* 5) كتلة كود tool_call */
check('كتلة كود tool_call',
  '```tool_call\n{"name":"run_command","arguments":{"command":"df -h"}}\n```',
  ['df -h']);

/* 6) JSON خالٍ بدون وسم */
check('JSON خالٍ بدون وسم',
  'تفضل:\n{"name":"run_command","arguments":{"command":"pwd"}}',
  ['pwd']);

/* 7) صيغة استدعاء دالة */
check('صيغة run_command("...")',
  'run_command("cat /etc/os-release")',
  ['cat /etc/os-release']);

/* 8) أوامر متعددة الأسطر مع heredoc */
check('أمر به أسطر heredoc',
  '<tool_call>\n{"name":"run_command","arguments":{"command":"cat > a.py <<\'PY\'\\nprint(1)\\nPY\\npython3 a.py"}}\n</tool_call>',
  ["cat > a.py <<'PY'\nprint(1)\nPY\npython3 a.py"]);

/* 9) نص عادي بدون أي أداة */
check('إجابة عادية بدون أدوات',
  'المعالج عندك سريع، مش محتاج أي أوامر.',
  []);

/* 10) بلوك bash توضيحي في إجابة نهائية لازم ما يتنفذش */
check('بلوك bash توضيحي لا يُنفذ',
  'تقدر تشغّل:\n```bash\nnpm install\n```\nولما تخلص قولي.',
  []);

/* 11) أمر مكرر يتشال */
check('إزالة الأوامر المكررة',
  '<tool_call>{"name":"run_command","arguments":{"command":"echo hi"}}</tool_call>' +
  '<tool_call>{"name":"run_command","arguments":{"command":"echo hi"}}</tool_call>',
  ['echo hi']);

/* 12) محتوى فارغ */
check('محتوى فارغ', '', []);

console.log(`\nنجح ${passed} اختبار للـ parser ✓`);

/* ================ اختبارات منظّف تسريبات الأدوات ================ */
let cleanPassed = 0;
const checkClean = (name, input, expected) => {
  const out = stripToolText(input);
  assert.equal(out, expected, `فشل التنظيف: ${name}`);
  console.log(`  ✓ ${name}`);
  cleanPassed++;
};

checkClean('وسم كامل يُزال',
  'قبل <tool_call>\n{"name":"run_command","arguments":{"command":"ls"}}\n</tool_call> بعد',
  'قبل بعد');

checkClean('كتلة سوار run_command تُزال',
  'سأنفذ الآن:\n```run_command\nls -la\n```\nثم ألخص.',
  'سأنفذ الآن:\n\nثم ألخص.');

checkClean('JSON الأداة المسرب داخل كود مضمن (حالة حية)',
  'تم إنشاء الملف `name":"run_command","arguments":{"command":"printf \'NEXUS\\n\' > hello.txt && cat hello.txt` باستخدام الأمر.',
  'تم إنشاء الملف باستخدام الأمر.');

checkClean('JSON خالٍ للأداة وسط الكلام',
  'النتيجة جاهزة. {"name":"run_command","arguments":{"command":"pwd"}} انتهى.',
  'النتيجة جاهزة. انتهى.');

checkClean('صيغة استدعاء دالة عارية',
  'سأشغل run_command("uname -a") الآن',
  'سأشغل الآن');

checkClean('بقايا وسم يتيم',
  'نص عادي <tool_call> يستمر',
  'نص عادي يستمر');

checkClean('إجابة عادية لا تتأثر',
  'استخدم الأمر `ls -la` لعرض الملفات، و `cat` لقراءتها.',
  'استخدم الأمر `ls -la` لعرض الملفات، و `cat` لقراءتها.');

checkClean('بلوك bash توضيحي يبقى كما هو',
  'مثال:\n```bash\nnpm install\n```\nوبعدين شغل.',
  'مثال:\n```bash\nnpm install\n```\nوبعدين شغل.');

/* حالات الانحراف الحقيقية المرصودة من الموديل */
checkClean('جزء JSON مفتوح بلا إغلاق يلتصق بالعربي (حالة حية)',
  '{"name":"run_command","arguments":{"command":"printf \'NEXUS\\n\' > hello.txt && cat hello.txtتم إنشاء الملف `hello.txt` في المسار.',
  'تم إنشاء الملف `hello.txt` في المسار.');

checkClean('جزء JSON مفتوح أثناء البث قبل وصول أي كلام — يُقص بالكامل',
  '{"name":"run_command","arguments":{"command":"printf \'NEXUS',
  '');

checkClean('JSON مكتمل ثم إجابة عربية',
  '{"name":"run_command","arguments":{"command":"pwd"}} تم بنجاح',
  'تم بنجاح');

checkClean('جزء مفتوح بعده سوار كود',
  '{"name":"run_command","arguments":{"command":"ls\n```bash\nls\n```',
  '```bash\nls\n```');

checkClean('رأس JSON ناقص علامة الإغلاق ملتصق بالعربي (حالة بث حية)',
  '{"name":"run_commandتم إنشاء الملف بنجاح',
  'تم إنشاء الملف بنجاح');

checkClean('رأس مبتور أثناء البث بلا أي كلام بعده',
  '{"name":"run_command',
  '');

checkClean('رأس أكثر ابتساراً run ملتصق بعنوان Markdown',
  '{"name":"run## ✅ تم إنشاء الملف',
  '## ✅ تم إنشاء الملف');

checkClean('رأس مبتور جداً أثناء البث',
  '{"name":"run',
  '');

checkClean('فاتحة شبه فارغة ملتصقة بالعربي',
  '{"name":"تم إنشاء الملف',
  'تم إنشاء الملف');

checkClean('رأس {"name ملتصق مباشرة بالعربي بلا علامات',
  '{"nameتم إنشاء الملف بنجاح',
  'تم إنشاء الملف بنجاح');

checkClean('مثال JSON شرعي داخل سوار كود لا يُمَس',
  'مثال للبنية:\n```json\n{"name":"Alice","age":30}\n```\nكده واضح؟',
  'مثال للبنية:\n```json\n{"name":"Alice","age":30}\n```\nكده واضح؟');

console.log(`\nنجح ${cleanPassed} اختبار لمنظّف التسريبات ✓`);
