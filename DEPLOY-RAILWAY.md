# دليل النشر على Railway — رابط ثابت دائم

> بعد النشر هتحصل على رابط زي: `https://nexus-ai-agent.up.railway.app`
> شغّال 24/7، وفيه **الترمنال والوكيل بيشتغلوا بالكامل** لأن Railway بيحاوِل حاوية Linux حقيقية (مش Workers).

## إيه اللي جهّزناه؟

| الملف | الوظيفة |
|---|---|
| `Dockerfile` | حاوية Node 20 + Python 3 + bash + git + curl، مع Healthcheck |
| `railway.json` | إعدادات النشر: بناء Dockerfile وفحص صحة على `/api/health` وإعادة تشغيل عند الفشل |
| `.dockerignore` | منع رفع `.env` و`node_modules` والملفات المؤقتة للحاوية |
| `.env.example` | نموذج المتغيرات المطلوبة |
| `.gitignore` | منع تسريب ملف `.env` للمستودع |

---

## الطريقة الأولى (الأسهل): GitHub + لوحة Railway

### 1) ارفع الكود على GitHub
من جهازك بعد ما تنزّل مجلد المشروع:

```bash
cd ai-agent
git init
git add .
git commit -m "NEXUS AI Agent — initial deploy"
# اعمل repository فاضي على github.com وبعدها:
git remote add origin https://github.com/<اسمك>/nexus-ai-agent.git
git branch -M main
git push -u origin main
```

> تأكيد مهم: ملف `.env` **مش بيترفع** (موجود في `.gitignore`)، المفتاح هيتحط جوّه Railway مباشرة.

### 2) أنشئ المشروع على Railway
1. افتح [railway.app](https://railway.app) وسجّل بحساب GitHub (محتاج كارت بنكي للتفعيل، وفيه رصيد تجريبي).
2. **New Project → Deploy from GitHub repo** واختار المستودع `nexus-ai-agent`.
3. Railway هيكتشف `Dockerfile` و`railway.json` ويبني الحاوية لوحده.

### 3) ضيف المتغيرات (Variables)
في تبويب **Variables** اضغط **+ New Variable**:

| المفتاح | القيمة |
|---|---|
| `NVIDIA_API_KEY` | مفتاح NVIDIA بتاعك (`nvapi-...`) |
| `UPSTREAM_URL` | `https://integrate.api.nvidia.com/v1/chat/completions` (اختياري، موجود افتراضياً) |
| `AGENT_WORKSPACE` | `/app/workspace` (اختياري، موجود افتراضياً في الـ Dockerfile) |

متحطش `PORT` — Railway بيحقنه أوتوماتيك والكود بيقرأه (`process.env.PORT`).

### 4) فعّل الرابط العام
- **Settings → Networking → Generate Domain**
- هيطلعلك رابط `https://....up.railway.app` — افتحه وكل حاجة هتكون شغّالة.

### 5) تأكد إن الصحة تمام
افتح: `https://<رابطك>/api/health` — لازم يطلع:
```json
{"ok":true,"keyConfigured":true,"workspace":"/app/workspace"}
```

---

## الطريقة التانية: Railway CLI من الطرفية

```bash
npm install -g @railway/cli
railway login                 # هيفتح المتصفح للتفويض
cd ai-agent
railway init                  # أنشئ مشروع جديد واختار اسمه
railway up                    # يبني الـ Dockerfile وينشر
railway variables set NVIDIA_API_KEY=nvapi-مفتاحك
railway domain                # يولّد رابط عام ثابت
railway logs                  # متابعة اللوجز
```

---

## ملاحظات مهمة

1. **الملفات مؤقتة:** أي ملف بيعمله الوكيل بيعيش طول الحاوية شغّالة، ويتمسح عند إعادة النشر. لو محتاج تخزين دائم، ضيف **Volume** من Railway واربطه على `/app/workspace`.
2. **الأمان:** اخترت تسيب الموقع من غير كود دخول — أي حد معاه الرابط يقدر ينفذ أوامر على الحاوية. الحاوية معزولة ومالهاش أي صلاحيات على حسابك، لكن لو حبيت تحميها لاحقاً أقدر أضيف بوابة Access Code في 10 دقايق.
3. **المفتاح:** يُفضّل تعمل rotate لمفتاح NVIDIA لأنه اتشارك في الشات، وتحط الجديد في Variables.
4. **إعادة التشغيل التلقائي:** `railway.json` مضبوط يعيد التشغيل عند أي فشل، والـ Healthcheck بيراقب `/api/health` كل 30 ثانية.
5. **الأدوات جوّه الحاوية:** Node 20، Python 3 مع pip، git، curl، bash — الوكيل يقدر يثبّت حزم Python بـ `pip install` أثناء الشغل.
