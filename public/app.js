/* ============================================================
   NEXUS AI Agent — Frontend Logic
   ============================================================ */
'use strict';

/* ---------------------------- أدوات ---------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + Math.random().toString(16).slice(2));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FALLBACK_MODELS = [
  {
    id: 'minimaxai/minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', vendor: 'MiniMax', badge: 'الأسرع',
    description: 'موديل تفكير خاطف — مثالي للمهام اليومية والكود والمحادثات الطويلة.',
    capabilities: ['reasoning', 'text', 'code'], vision: false, accent: ['#8b5cf6', '#22d3ee'],
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', name: 'Nemotron Super VL 120B', vendor: 'NVIDIA', badge: 'رؤية بصرية',
    description: 'عملاق متعدد الوسائط — يحلّل الصور والنصوص مع تفكير عميق متقدّم.',
    capabilities: ['reasoning', 'text', 'vision', 'code'], vision: true, accent: ['#22d3ee', '#d946ef'],
  },
];
const CAP_LABELS = { reasoning: 'تفكير عميق', text: 'نصوص', code: 'برمجة', vision: 'رؤية بصرية' };
const STORE = { convs: 'nexus.conversations.v1', settings: 'nexus.settings.v1', model: 'nexus.model.v1', agent: 'nexus.agentmode.v1' };
const DEFAULT_SETTINGS = { temperature: 0.6, maxTokens: 8192, systemPrompt: '' };

/* ---------------------------- الحالة ---------------------------- */
const state = {
  models: FALLBACK_MODELS,
  modelId: localStorage.getItem(STORE.model) || FALLBACK_MODELS[0].id,
  convs: [],
  currentId: null,
  search: '',
  settings: { ...DEFAULT_SETTINGS, ...safeParse(localStorage.getItem(STORE.settings), {}) },
  attachments: [],
  agentMode: localStorage.getItem(STORE.agent) === '1',
  stream: null,
  term: { history: [], histIdx: -1, busy: false, cwd: '/home/user/agent-workspace' },
};

function safeParse(str, fb) { try { return str ? JSON.parse(str) : fb; } catch { return fb; } }
const currentModel = () => state.models.find((m) => m.id === state.modelId) || state.models[0];
const currentConv = () => state.convs.find((c) => c.id === state.currentId) || null;

/* ---------------------------- التهيئة ---------------------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  configureMarkdown();
  loadConvs();
  await loadModels();
  renderModelPicker();
  updateModelUI();
  renderSidebar();
  bindEvents();
  applySettingsToForm();
  updateAgentUI();
  checkHealth();
  setInterval(checkHealth, 60000);
  renderView();
  updateSendState();
}

function configureMarkdown() {
  if (window.marked) marked.setOptions({ gfm: true, breaks: true });
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length) state.models = data.models;
    }
  } catch { /* احتياطي */ }
  if (!state.models.some((m) => m.id === state.modelId)) state.modelId = state.models[0].id;
}

async function checkHealth() {
  const pill = $('#statusPill');
  const txt = $('#statusText');
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.ok && data.keyConfigured) {
      pill.className = 'status-pill online';
      txt.textContent = 'متصل بـ NVIDIA NIM';
      if (data.workspace) state.term.cwd = data.workspace;
    } else {
      pill.className = 'status-pill offline';
      txt.textContent = 'المفتاح غير مضبوط';
    }
  } catch {
    pill.className = 'status-pill offline';
    txt.textContent = 'غير متصل';
  }
}

/* ---------------------------- التخزين ---------------------------- */
function loadConvs() {
  state.convs = safeParse(localStorage.getItem(STORE.convs), []);
  if (!Array.isArray(state.convs)) state.convs = [];
}
function saveConvs() {
  try {
    localStorage.setItem(STORE.convs, JSON.stringify(state.convs));
  } catch {
    toast('مساحة التخزين ممتلئة — احذف بعض المحادثات أو الصور.', 'error');
  }
}

/* ---------------------------- اختيار الموديل ---------------------------- */
function renderModelPicker() {
  const menu = $('#modelMenu');
  menu.innerHTML = '';
  state.models.forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'model-option' + (m.id === state.modelId ? ' selected' : '');
    btn.setAttribute('role', 'option');
    btn.dataset.id = m.id;
    btn.innerHTML = `
      <span class="model-option-ico" style="background:linear-gradient(135deg,${m.accent[0]},${m.accent[1]})">${escapeHtml(m.name.charAt(0))}</span>
      <span class="model-option-body">
        <span class="model-option-head">
          <strong>${escapeHtml(m.name)}</strong>
          <span class="model-tag">${escapeHtml(m.badge)}</span>
        </span>
        <p>${escapeHtml(m.description)}</p>
        <span class="model-caps">
          ${m.capabilities.map((c) => `<span class="model-cap">${CAP_LABELS[c] || c}</span>`).join('')}
        </span>
      </span>
      <span class="model-check">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/></svg>
      </span>`;
    btn.addEventListener('click', () => selectModel(m.id));
    menu.appendChild(btn);
  });
}

function selectModel(id) {
  const target = state.models.find((m) => m.id === id);
  if (!target) return;
  if (!target.vision && state.attachments.length) {
    state.attachments = [];
    renderAttachChips();
    toast('هذا الموديل لا يدعم الصور — تم مسح المرفقات.', 'warn');
  }
  state.modelId = id;
  localStorage.setItem(STORE.model, id);
  updateModelUI();
  renderModelPicker();
  closePopovers();
  toast(`تم التحويل إلى ${target.name}`, 'success');
}

function updateModelUI() {
  const m = currentModel();
  $('#modelName').textContent = m.name;
  $('#modelSub').textContent = `${m.vendor} • ${m.badge}`;
  $('#modelHintMini').textContent = `النموذج: ${m.name}`;
  $('#modelDot').style.background = `linear-gradient(135deg, ${m.accent[0]}, ${m.accent[1]})`;
  const attachBtn = $('#attachBtn');
  attachBtn.disabled = !m.vision;
  attachBtn.title = m.vision ? 'إرفاق صورة' : 'الصور مدعومة فقط في موديل Nemotron VL';
}

/* ---------------------------- وضع الوكيل ---------------------------- */
function toggleAgentMode(force) {
  state.agentMode = typeof force === 'boolean' ? force : !state.agentMode;
  localStorage.setItem(STORE.agent, state.agentMode ? '1' : '0');
  updateAgentUI();
  if (state.agentMode) toast('وضع الوكيل مفعّل — الكمبيوتر جاهز لتنفيذ الأوامر.', 'success');
}
function updateAgentUI() {
  const btn = $('#agentToggle');
  btn.classList.toggle('active', state.agentMode);
  $('#agentHint').textContent = state.agentMode
    ? 'وضع الوكيل: كمبيوتر Linux حقيقي ينفذ الأوامر'
    : 'وضع المحادثة العادية';
  $('#agentHint').classList.toggle('on', state.agentMode);
}

/* ---------------------------- الشريط الجانبي ---------------------------- */
function renderSidebar() {
  const list = $('#convList');
  const q = state.search.trim().toLowerCase();
  const convs = [...state.convs]
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (!convs.length) {
    list.innerHTML = `<div class="conv-empty">${state.convs.length ? 'لا توجد نتائج مطابقة' : 'لا توجد محادثات بعد.<br>ابدأ أول محادثة وستظهر هنا.'}</div>`;
    return;
  }

  list.innerHTML = '';
  convs.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentId ? ' active' : '');
    item.dataset.id = c.id;
    item.innerHTML = `
      <span class="conv-ico">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
      </span>
      <span class="conv-info">
        <span class="conv-title">${escapeHtml(c.title)}</span>
        <span class="conv-date">${relativeDate(c.updatedAt)}</span>
      </span>
      <span class="conv-actions">
        <button class="conv-action" data-act="rename" title="إعادة تسمية">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="conv-action danger" data-act="delete" title="حذف">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </span>`;
    item.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'rename') return startRename(c.id, item);
      if (act === 'delete') return deleteConv(c.id);
      openConv(c.id);
    });
    list.appendChild(item);
  });
}

function startRename(id, item) {
  const conv = state.convs.find((c) => c.id === id);
  if (!conv) return;
  const titleEl = $('.conv-title', item);
  const input = document.createElement('input');
  input.value = conv.title;
  input.className = 'conv-title';
  input.style.cssText = 'background:rgba(255,255,255,.08);border:1px solid var(--border-strong);border-radius:8px;padding:4px 8px;color:var(--text);font-family:var(--font);font-size:13px;width:100%;outline:none';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) conv.title = v.slice(0, 70);
    saveConvs();
    renderSidebar();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') renderSidebar();
  });
}

function deleteConv(id) {
  const conv = state.convs.find((c) => c.id === id);
  if (!conv) return;
  if (!confirm(`حذف المحادثة «${conv.title}» نهائياً؟`)) return;
  state.convs = state.convs.filter((c) => c.id !== id);
  if (state.currentId === id) state.currentId = null;
  saveConvs();
  renderSidebar();
  renderView();
  toast('تم حذف المحادثة.', 'success');
}

function newChat() {
  if (state.stream) stopStreaming();
  state.currentId = null;
  state.attachments = [];
  renderAttachChips();
  renderView();
  renderSidebar();
  $('#composerInput').focus();
}

function openConv(id) {
  if (state.stream) stopStreaming();
  state.currentId = id;
  closeSidebar();
  renderSidebar();
  renderView();
}

function relativeDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `اليوم ${hh}:${mm}`;
  if (isYest) return `أمس ${hh}:${mm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()}/${d.getMonth() + 1}`;
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

/* ---------------------------- عرض المحادثة ---------------------------- */
function renderView() {
  const conv = currentConv();
  const welcome = $('#welcome');
  const messages = $('#messages');

  $$('.msg', messages).forEach((n) => n.remove());
  if (!conv || conv.messages.length === 0) {
    welcome.hidden = false;
    return;
  }
  welcome.hidden = true;
  conv.messages.forEach((m) => messages.appendChild(renderMessage(m, conv)));
  requestAnimationFrame(() => scrollToBottom(false));
}

function renderMessage(m, conv) {
  const wrap = document.createElement('article');
  wrap.className = `msg ${m.role}` + (m.error ? ' error' : '');
  wrap.id = 'msg-' + m.id;

  if (m.role === 'user') {
    wrap.innerHTML = `
      <div class="msg-body">
        <div class="msg-author">
          <strong>أنت</strong>
          <time>${new Date(m.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        ${m.images?.length ? `<div class="msg-images">${m.images.map((src) => `<img src="${src}" alt="مرفق" loading="lazy">`).join('')}</div>` : ''}
        <div class="bubble"><div class="md" style="white-space:pre-wrap">${escapeHtml(m.text)}</div></div>
      </div>
      <div class="msg-avatar">
        <svg viewBox="0 0 24 24" width="19" height="19"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/></svg>
      </div>`;
  } else {
    const model = state.models.find((x) => x.id === (m.modelId || state.modelId));
    wrap.innerHTML = `
      <div class="msg-avatar">
        <svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M12 2l2.2 6.2L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-1.8z"/></svg>
      </div>
      <div class="msg-body">
        <div class="msg-author">
          <strong>NEXUS</strong>
          <span class="msg-model-tag">${escapeHtml(model ? model.name : 'AI')}</span>
          <time>${new Date(m.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        <div class="reasoning-slot"></div>
        <div class="tools-slot"></div>
        <div class="bubble">
          <div class="md md-content"></div>
        </div>
        <div class="msg-actions">
          <button class="msg-action" data-act="copy">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2M9 2h6a2 2 0 012 2v2H7V4a2 2 0 012-2z"/></svg>
            نسخ
          </button>
          ${isLastAssistant(m, conv) ? `<button class="msg-action" data-act="regenerate">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            إعادة توليد
          </button>` : ''}
          <span class="msg-usage usage-slot"></span>
        </div>
      </div>`;
  }
  updateAssistantNode(wrap, m, conv);
  return wrap;
}

function isLastAssistant(m, conv) {
  const assistants = conv.messages.filter((x) => x.role === 'assistant');
  return assistants.length && assistants[assistants.length - 1].id === m.id;
}

function renderTools(wrap, m) {
  const slot = $('.tools-slot', wrap);
  if (!slot) return;
  const tools = m.tools || [];
  if (!tools.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = tools.map((t, idx) => {
    const running = t.status === 'running';
    const ok = !running && t.code === 0;
    const state = running ? 'running' : ok ? 'ok' : 'fail';
    const badge = running
      ? '<span class="exec-badge run"><span class="mini-spin"></span> ينفّذ...</span>'
      : `<span class="exec-badge ${ok ? 'ok' : 'fail'}">${ok ? 'نجح' : 'فشل'} · exit ${t.code}</span>`;
    const out = (t.stdout || '').trim();
    const err = (t.stderr || '').trim();
    /* مفتوح أثناء التنفيذ أو عند الفشل؛ يُطوى تلقائياً بعد النجاح */
    const open = running || (!running && t.code !== 0) ? 'open' : '';
    const seq = String(idx + 1).padStart(2, '0');
    const screen = (out || err)
      ? `<div class="exec-screen">
           <div class="exec-screen-bar">
             <span>bash · output</span>
             <button class="exec-copy" type="button">
               <svg viewBox="0 0 24 24" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2M9 2h6a2 2 0 012 2v2H7V4a2 2 0 012-2z"/></svg>
               نسخ المخرجات
             </button>
           </div>
           ${out ? `<pre class="exec-out">${escapeHtml(out)}</pre>` : ''}
           ${err ? `<pre class="exec-err">${escapeHtml(err)}</pre>` : ''}
         </div>`
      : running ? '<div class="exec-wait"><span class="mini-spin"></span> جارٍ التنفيذ على كمبيوتر الوكيل...</div>' : '';
    return `
      <div class="term-exec ${state} ${open}" data-id="${t.id}">
        <button class="term-exec-head" type="button">
          <span class="exec-dots"><i></i><i></i><i></i></span>
          <span class="exec-tool">run_command · ${seq}</span>
          <code class="exec-cmd"><span class="exec-prompt">❯</span>${escapeHtml(t.command)}</code>
          ${badge}
          <svg class="exec-chev" viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="term-exec-body">
          ${screen}
          <div class="exec-foot">
            ${t.cwd ? `<span class="exec-chip">📁 <code>${escapeHtml(t.cwd)}</code></span>` : ''}
            ${t.durationMs ? `<span class="exec-chip">⏱ <b>${(t.durationMs / 1000).toFixed(2)}s</b></span>` : ''}
            ${!running ? `<span class="exec-chip ${ok ? 'status-ok' : 'status-fail'}">↳ <b>exit ${t.code}</b></span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
  $$('.term-exec-head', slot).forEach((head) => {
    head.addEventListener('click', () => head.closest('.term-exec').classList.toggle('open'));
  });
  $$('.exec-copy', slot).forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.term-exec');
      const outEl = $('.exec-out', card);
      const errEl = $('.exec-err', card);
      const text = [outEl?.textContent, errEl?.textContent].filter(Boolean).join('\n');
      navigator.clipboard.writeText(text);
      toast('تم نسخ مخرجات الأمر.', 'success');
    });
  });
}

function updateAssistantNode(wrap, m, conv) {
  if (m.role !== 'assistant') return;

  /* لوحة التفكير */
  const rSlot = $('.reasoning-slot', wrap);
  if (m.reasoning) {
    if (!$('.reasoning', rSlot)) {
      rSlot.innerHTML = `
        <div class="reasoning${m.streaming && !m.content && (!m.tools || !m.tools.length) ? ' open' : ''} ${m.streaming ? '' : 'done'}">
          <button class="reasoning-head" type="button">
            <span class="think-spin"></span>
            <svg class="think-ico" viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2l2.2 6.2L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-1.8z"/></svg>
            <span class="think-label">${m.streaming ? 'جارٍ التفكير...' : 'عملية التفكير'}</span>
            <svg class="chev" viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="reasoning-body"></div>
        </div>`;
      $('.reasoning-head', rSlot).addEventListener('click', () => $('.reasoning', rSlot).classList.toggle('open'));
    }
    $('.reasoning-body', rSlot).textContent = m.reasoning;
    const panel = $('.reasoning', rSlot);
    $('.think-label', panel).textContent = m.streaming ? 'جارٍ التفكير...' : 'عملية التفكير';
    if (!m.streaming) panel.classList.add('done');
  }

  /* كتل الأوامر المنفذة */
  renderTools(wrap, m);

  /* المحتوى */
  const content = $('.md-content', wrap);
  if (m.error) {
    content.innerHTML = `<div class="error-text">⚠️ ${escapeHtml(m.content || 'حدث خطأ غير متوقع.')}</div>
      <button class="retry-btn" data-act="retry">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        إعادة المحاولة
      </button>`;
  } else if (m.content) {
    renderMarkdownInto(content, m.content + (m.streaming ? '<span class="stream-caret"></span>' : ''));
  } else if (m.streaming && (!m.tools || !m.tools.length)) {
    content.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
  } else if (m.streaming) {
    content.innerHTML = '';
  }

  /* الاستخدام */
  const usage = $('.usage-slot', wrap);
  if (usage && m.usage) {
    usage.textContent = `الرموز: ${m.usage.total_tokens || (m.usage.prompt_tokens + m.usage.completion_tokens)}`;
  }

  /* الأزرار */
  const regen = $('[data-act="regenerate"]', wrap);
  if (regen) regen.addEventListener('click', () => regenerate(conv));
  const retry = $('[data-act="retry"]', wrap);
  if (retry) retry.addEventListener('click', () => regenerate(conv));
  const copyBtn = $('[data-act="copy"]', wrap);
  if (copyBtn) copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(m.content || '');
    toast('تم نسخ الرد.', 'success');
  });
}

/* خط دفاع ثانٍ: إزالة أي تسريب لصيغ الأداة من النص المعروض */
function cleanToolLeak(text) {
  let out = String(text ?? '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/```(?:run_command|tool_call|bash-tool)[\s\S]*?```/g, '')
    .replace(/`[^`\n]*(?:"run_command"|run_command\s*\()[^`\n]*`/g, '')
    .replace(/\{?\s*"name"\s*:\s*"run_command"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}?/g, '')
    .replace(/run_command\s*\(\s*(?:"(?:[^"\\]|\\.)*"|\{[\s\S]*?\})\s*\)/g, '')
    .replace(/<\/?tool_call>/g, '');

  /* جزء JSON أداة مبتور في المقدمة: من القوس حتى أول كلام عربي/سوار/عنوان */
  out = out.replace(/^\s*\{[\s\S]*?(?=[؀-ۿ]|```|#)/, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  /* قوس JSON في المقدمة لم يُغلق بعد ولم يصل كلام عربي — كبح الجزء المبتور أثناء البث */
  if (/^\s*\{/.test(out) && !/\}/.test(out) && !/[؀-ۿ]/.test(out)) out = out.slice(0, 0);
  return out.trim();
}

function renderMarkdownInto(el, md) {
  const caret = md.endsWith('</span>') && md.includes('stream-caret');
  const source = cleanToolLeak(md.replace(/<span class="stream-caret"><\/span>$/, ''));
  let html;
  if (window.marked) {
    try { html = marked.parse(source); } catch { html = escapeHtml(source); }
  } else {
    html = escapeHtml(source).replace(/\n/g, '<br>');
  }
  if (window.DOMPurify) html = DOMPurify.sanitize(html);
  const caretHtml = caret ? '<span class="stream-caret"></span>' : '';
  el.innerHTML = html + caretHtml;

  $$('pre code', el).forEach((code) => {
    try { window.hljs && hljs.highlightElement(code); } catch { /* noop */ }
    const pre = code.closest('pre');
    if (pre && !$('.code-head', pre)) {
      let lang = (code.className.match(/language-([\w-]+)/) || [])[1];
      if (!lang || lang === 'undefined') lang = 'نص';
      const head = document.createElement('div');
      head.className = 'code-head';
      head.innerHTML = `<span>${escapeHtml(lang)}</span><button class="copy-code" type="button">نسخ الكود</button>`;
      head.querySelector('.copy-code').addEventListener('click', () => {
        navigator.clipboard.writeText(code.textContent);
        toast('تم نسخ الكود.', 'success');
      });
      pre.prepend(head);
    }
  });
}

/* ---------------------------- الإرسال ---------------------------- */
async function handleSend() {
  const input = $('#composerInput');
  const text = input.value.trim();
  if (state.stream) return;
  if (!text && state.attachments.length === 0) return;

  /* تفعيل الوكيل تلقائياً لو طلب المستخدم صراحة */
  if (!state.agentMode && /وضع الوكيل|الوكيل|نفذ.*أمر|على الكمبيوتر/.test(text)) {
    toggleAgentMode(true);
  }

  let conv = currentConv();
  if (!conv) {
    conv = { id: uuid(), title: text ? text.slice(0, 42) : 'محادثة جديدة', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.convs.unshift(conv);
    state.currentId = conv.id;
  }

  const userMsg = { id: uuid(), role: 'user', text, images: [...state.attachments], ts: Date.now() };
  const aiMsg = {
    id: uuid(), role: 'assistant', modelId: state.modelId,
    content: '', reasoning: '', tools: [], usage: null,
    error: false, streaming: true, ts: Date.now(),
  };
  conv.messages.push(userMsg, aiMsg);
  conv.updatedAt = Date.now();

  input.value = '';
  autoGrow(input);
  state.attachments = [];
  renderAttachChips();
  renderSidebar();
  renderView();
  saveConvs();

  if (state.agentMode) await runAgentStream(conv, aiMsg);
  else await runChatStream(conv, aiMsg);
}

function buildApiMessages(conv, excludeId = null) {
  return conv.messages
    .filter((m) => !m.error && m.id !== excludeId)
    .map((m) => {
      if (m.role === 'user') {
        if (m.images?.length) {
          const parts = [{ type: 'text', text: m.text || 'حلّل الصورة المرفقة بالتفصيل.' }];
          m.images.forEach((url) => parts.push({ type: 'image_url', image_url: { url } }));
          return { role: 'user', content: parts };
        }
        return { role: 'user', content: m.text };
      }
      return { role: 'assistant', content: m.content || '' };
    });
}

/* ---- بث المحادثة العادية ---- */
async function runChatStream(conv, aiMsg) {
  const controller = new AbortController();
  state.stream = { controller, convId: conv.id, msgId: aiMsg.id, raf: null };
  toggleStreamingUI(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: aiMsg.modelId,
        messages: buildApiMessages(conv, aiMsg.id),
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens,
        systemPrompt: state.settings.systemPrompt,
      }),
    });

    if (!res.ok || !res.body) {
      let detail = `خطأ ${res.status}`;
      try { const e = await res.json(); detail = e.detail || e.error || detail; if (typeof detail !== 'string') detail = JSON.stringify(detail); } catch { /* noop */ }
      throw new Error(detail);
    }

    await consumeSSE(res, aiMsg, (data) => {
      const delta = data.choices?.[0]?.delta;
      if (delta) {
        if (delta.reasoning_content) aiMsg.reasoning += delta.reasoning_content;
        if (delta.content) aiMsg.content += delta.content;
      }
      if (data.usage) aiMsg.usage = data.usage;
    });

    if (!aiMsg.content && !aiMsg.reasoning) throw new Error('لم يصل أي رد من الخدمة. حاول مرة أخرى.');
    aiMsg.streaming = false;
  } catch (err) {
    finishWithError(aiMsg, err);
  } finally {
    finalizeStream(conv, aiMsg);
  }
}

/* ---- بث الوكيل الذكي مع تنفيذ الأوامر ---- */
async function runAgentStream(conv, aiMsg) {
  const controller = new AbortController();
  state.stream = { controller, convId: conv.id, msgId: aiMsg.id, raf: null };
  toggleStreamingUI(true);

  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: aiMsg.modelId,
        messages: buildApiMessages(conv, aiMsg.id),
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens,
        systemPrompt: state.settings.systemPrompt,
        sessionId: 'sess_' + conv.id,
      }),
    });

    if (!res.ok || !res.body) {
      let detail = `خطأ ${res.status}`;
      try { const e = await res.json(); detail = e.detail || e.error || detail; if (typeof detail !== 'string') detail = JSON.stringify(detail); } catch { /* noop */ }
      throw new Error(detail);
    }

    await consumeSSE(res, aiMsg, (data) => {
      switch (data.type) {
        case 'reasoning':
          aiMsg.reasoning += data.delta;
          break;
        case 'text':
          aiMsg.content += data.delta;
          break;
        case 'tool':
          aiMsg.tools.push({ id: data.id, command: data.command, status: 'running' });
          break;
        case 'tool_result': {
          const t = aiMsg.tools.find((x) => x.id === data.id);
          if (t) Object.assign(t, {
            status: 'done', code: data.code, stdout: data.stdout,
            stderr: data.stderr, cwd: data.cwd, durationMs: data.durationMs,
          });
          break;
        }
        case 'usage':
          aiMsg.usage = data.usage;
          break;
        case 'retry':
          toast(`${data.message || 'إعادة المحاولة'} (${data.attempt}/${3})`, 'warn');
          break;
        case 'tool_parse_retry':
          toast('تصحيح تلقائي لصيغة الأمر...', 'info');
          break;
        case 'error':
          throw new Error(data.message || 'خطأ من الوكيل');
        case 'done':
          if (data.usage) aiMsg.usage = data.usage;
          break;
      }
    });

    if (!aiMsg.content && !aiMsg.tools.length) throw new Error('لم يصل أي رد من الوكيل. حاول مرة أخرى.');
    aiMsg.streaming = false;
  } catch (err) {
    finishWithError(aiMsg, err);
  } finally {
    finalizeStream(conv, aiMsg);
  }
}

async function consumeSSE(res, aiMsg, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json.error && typeof json.error === 'object' && json.error.message) {
          throw new Error(json.error.message);
        }
        onEvent(json);
        scheduleNodeUpdate(aiMsg);
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) continue;
        throw parseErr;
      }
    }
  }
}

function finishWithError(aiMsg, err) {
  aiMsg.streaming = false;
  if (err.name === 'AbortError') {
    if (!aiMsg.content && !aiMsg.tools.length) {
      aiMsg.error = true;
      aiMsg.content = 'تم إيقاف التوليد قبل بدء الرد.';
    }
  } else {
    aiMsg.error = true;
    aiMsg.content = err.message || 'فشل الاتصال بالخادم.';
  }
}

function finalizeStream(conv, aiMsg) {
  state.stream = null;
  toggleStreamingUI(false);
  conv.updatedAt = Date.now();
  const node = $('#msg-' + aiMsg.id);
  if (node) updateAssistantNode(node, aiMsg, conv);
  saveConvs();
  renderSidebar();
  scrollToBottom(true);
}

function scheduleNodeUpdate(aiMsg) {
  const s = state.stream;
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = null;
    const node = $('#msg-' + aiMsg.id);
    const conv = currentConv();
    if (node && conv) updateAssistantNode(node, aiMsg, conv);
    const scroll = $('#chatScroll');
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 220) scrollToBottom(false);
  });
}

function stopStreaming() {
  if (state.stream?.controller) state.stream.controller.abort();
}

async function regenerate(conv) {
  if (state.stream) return;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'assistant') { conv.messages.splice(i, 1); break; }
  }
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) { renderView(); return; }
  const aiMsg = {
    id: uuid(), role: 'assistant', modelId: state.modelId,
    content: '', reasoning: '', tools: [], usage: null,
    error: false, streaming: true, ts: Date.now(),
  };
  conv.messages.push(aiMsg);
  renderView();
  if (state.agentMode) await runAgentStream(conv, aiMsg);
  else await runChatStream(conv, aiMsg);
}

function toggleStreamingUI(on) {
  $('#sendBtn').hidden = on;
  $('#stopBtn').hidden = !on;
  updateSendState();
}

/* ---------------------------- المرفقات ---------------------------- */
async function handleFiles(files) {
  if (!currentModel().vision) {
    toast('الصور مدعومة فقط في موديل Nemotron Super VL.', 'warn');
    return;
  }
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 9 * 1024 * 1024) { toast(`الملف ${file.name} أكبر من 9MB.`, 'error'); continue; }
    try {
      const dataUrl = await downscaleImage(file, 1280, 0.85);
      if (state.attachments.length >= 4) { toast('الحد الأقصى 4 صور في الرسالة.', 'warn'); break; }
      state.attachments.push(dataUrl);
    } catch {
      toast(`تعذّرت معالجة ${file.name}.`, 'error');
    }
  }
  renderAttachChips();
}

function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachChips() {
  const box = $('#attachChips');
  box.innerHTML = '';
  state.attachments.forEach((src, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<img src="${src}" alt="مرفق"><button type="button" aria-label="حذف">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachChips();
    });
    box.appendChild(chip);
  });
  updateSendState();
}

/* ---------------------------- الترمنال اليدوي ---------------------------- */
function termAppend(html, cls = '') {
  const body = $('#termBody');
  const line = document.createElement('div');
  line.className = 'term-line ' + cls;
  line.innerHTML = html;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  return line;
}

async function termRun(command) {
  if (state.term.busy || !command.trim()) return;
  state.term.busy = true;
  state.term.history.unshift(command);
  state.term.histIdx = -1;
  termAppend(`<span class="term-prompt-text">user@nexus ${escapeHtml(state.term.cwd)}$</span> <span class="term-cmd-text">${escapeHtml(command)}</span>`, 'term-cmd-line');
  const waiting = termAppend('<span class="mini-spin"></span> جارٍ التنفيذ...', 'term-sys');

  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, sessionId: 'manual' }),
    });
    const data = await res.json();
    waiting.remove();
    if (data.error) {
      termAppend(escapeHtml(data.error), 'term-err-line');
    } else {
      if (data.stdout?.trim()) termAppend(`<pre>${escapeHtml(data.stdout)}</pre>`, 'term-out-line');
      if (data.stderr?.trim()) termAppend(`<pre>${escapeHtml(data.stderr)}</pre>`, 'term-err-line');
      if (!data.stdout?.trim() && !data.stderr?.trim()) termAppend('<em>(لا توجد مخرجات)</em>', 'term-sys');
      termAppend(`اكتمل — exit ${data.code} في ${(data.durationMs / 1000).toFixed(2)}s`, data.code === 0 ? 'term-ok-line' : 'term-err-line');
      if (data.cwd) {
        state.term.cwd = data.cwd;
        $('#termCwd').textContent = data.cwd;
        $('#termPrompt').textContent = `user@nexus:${data.cwd.replace('/home/user', '~')}$`;
      }
    }
  } catch (err) {
    waiting.remove();
    termAppend(escapeHtml(String(err.message || err)), 'term-err-line');
  } finally {
    state.term.busy = false;
    $('#termInput').focus();
  }
}

function openTerminal() {
  $('#termPanel').hidden = false;
  setTimeout(() => $('#termInput').focus(), 80);
}
function closeTerminal() { $('#termPanel').hidden = true; }

/* ---------------------------- الإعدادات ---------------------------- */
function applySettingsToForm() {
  $('#tempRange').value = state.settings.temperature;
  $('#tempVal').textContent = Number(state.settings.temperature).toFixed(2);
  $('#tokensRange').value = state.settings.maxTokens;
  $('#tokensVal').textContent = state.settings.maxTokens;
  $('#systemPrompt').value = state.settings.systemPrompt || '';
  updateRangeFill($('#tempRange'));
  updateRangeFill($('#tokensRange'));
}

/* امتلاء شريط التمرير بتدرج الهوية */
function updateRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

/* زر الإرسال لا ينشط إلا مع نص أو مرفق */
function updateSendState() {
  const btn = $('#sendBtn');
  if (!btn) return;
  const hasText = $('#composerInput').value.trim().length > 0;
  btn.disabled = !(hasText || state.attachments.length) || !!state.stream;
}
function openSettings() {
  applySettingsToForm();
  $('#settingsPopover').hidden = false;
  $('#popoverBackdrop').hidden = false;
}
function closeSettings() {
  $('#settingsPopover').hidden = true;
  $('#popoverBackdrop').hidden = true;
}
function saveSettings() {
  state.settings = {
    temperature: parseFloat($('#tempRange').value),
    maxTokens: parseInt($('#tokensRange').value, 10),
    systemPrompt: $('#systemPrompt').value.trim(),
  };
  localStorage.setItem(STORE.settings, JSON.stringify(state.settings));
  closeSettings();
  toast('تم حفظ الإعدادات.', 'success');
}

/* ---------------------------- عناصر عامة ---------------------------- */
function closePopovers() {
  $('#modelPicker').classList.remove('open');
  closeSettings();
}

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 2l2.2 6.2L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-1.8z"/></svg>',
};

function toast(message, type = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
  el.innerHTML = `<span class="toast-ico">${icon}</span><span>${escapeHtml(message)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, 3400);
}

function scrollToBottom(smooth = true) {
  const sc = $('#chatScroll');
  sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebarOverlay').classList.add('show');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.remove('show');
}

/* ---------------------------- ربط الأحداث ---------------------------- */
function bindEvents() {
  $('#newChatBtn').addEventListener('click', newChat);
  $('#convSearch').addEventListener('input', (e) => { state.search = e.target.value; renderSidebar(); });
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#sidebarClose').addEventListener('click', closeSidebar);
  $('#sidebarOverlay').addEventListener('click', closeSidebar);

  /* الموديل */
  $('#modelTrigger').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#modelPicker').classList.toggle('open');
    $('#settingsPopover').hidden = true;
    $('#popoverBackdrop').hidden = $('#modelPicker').classList.contains('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#modelPicker')) $('#modelPicker').classList.remove('open');
  });

  /* وضع الوكيل */
  $('#agentToggle').addEventListener('click', () => toggleAgentMode());

  /* الترمنال */
  $('#terminalToggle').addEventListener('click', () => {
    $('#termPanel').hidden ? openTerminal() : closeTerminal();
  });
  $('#termClose').addEventListener('click', closeTerminal);
  $('#termClear').addEventListener('click', () => {
    $('#termBody').innerHTML = '<div class="term-line term-sys">تم مسح الشاشة.</div>';
  });
  $('#termForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#termInput');
    const cmd = input.value;
    input.value = '';
    termRun(cmd);
  });
  $('#termInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.term.histIdx < state.term.history.length - 1) {
        state.term.histIdx++;
        e.target.value = state.term.history[state.term.histIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.term.histIdx > 0) {
        state.term.histIdx--;
        e.target.value = state.term.history[state.term.histIdx];
      } else {
        state.term.histIdx = -1;
        e.target.value = '';
      }
    }
  });

  /* الإعدادات */
  $('#settingsBtnTop').addEventListener('click', openSettings);
  $('#settingsBtnSide').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#popoverBackdrop').addEventListener('click', closePopovers);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#resetSettings').addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    localStorage.removeItem(STORE.settings);
    applySettingsToForm();
    toast('تمت استعادة الإعدادات الافتراضية.', 'success');
  });
  $('#tempRange').addEventListener('input', (e) => {
    $('#tempVal').textContent = Number(e.target.value).toFixed(2);
    updateRangeFill(e.target);
  });
  $('#tokensRange').addEventListener('input', (e) => {
    $('#tokensVal').textContent = e.target.value;
    updateRangeFill(e.target);
  });

  /* الكتابة والإرسال */
  const input = $('#composerInput');
  input.addEventListener('input', () => { autoGrow(input); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  $('#composerForm').addEventListener('submit', (e) => { e.preventDefault(); handleSend(); });
  $('#stopBtn').addEventListener('click', stopStreaming);

  /* المرفقات */
  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  /* الاقتراحات */
  $('#suggestGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.suggest-card');
    if (!card) return;
    input.value = card.dataset.prompt;
    autoGrow(input);
    input.focus();
  });

  /* زر النزول + Lightbox */
  const scroller = $('#chatScroll');
  const fab = $('#scrollFab');
  scroller.addEventListener('scroll', () => {
    fab.classList.toggle('show', scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 320);
  });
  fab.addEventListener('click', () => scrollToBottom(true));

  document.addEventListener('click', (e) => {
    const img = e.target.closest('.msg-images img');
    if (!img) return;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${img.src}" alt="عرض كامل">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  });

  /* اختصارات */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') { closePopovers(); closeSidebar(); closeTerminal(); }
  });
}
