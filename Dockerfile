# ============================================================
# NEXUS AI Agent — حاوية إنتاج كاملة (Node + Python + Bash)
# ============================================================
FROM node:20-bookworm-slim AS base

ENV NODE_ENV=production \
    TERM=dumb \
    PYTHONUNBUFFERED=1 \
    AGENT_WORKSPACE=/app/workspace

WORKDIR /app

# أدوات النظام: bash (موجود افتراضياً) + python3 + pip + git + curl
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      python3 \
      python3-pip \
      python3-venv \
      git \
      curl \
      procps \
      iproute2 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

# الج dependency أولاً لتحسين كاش الطبقات
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# كود التطبيق
COPY . .

# مجلد عمل الوكيل (ملفات الحاوية مؤقتة — تُمحى عند إعادة النشر)
RUN mkdir -p /app/workspace && chown -R node:node /app

USER node

# Railway يحقن متغير PORT تلقائياً
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
