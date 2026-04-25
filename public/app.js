// FastClaw WebChat - Client App (single session, configurable)
(function () {
  'use strict';

  const DEFAULT_APP_CONFIG = {
    branding: {
      name: 'FastClaw',
      emoji: '🐾',
      avatarBot: 'FC',
      avatarUser: 'U',
      welcomeTitle: 'Welcome to FastClaw',
      welcomeSubtitle: 'Send a message to start chatting.',
      documentTitle: 'FastClaw Chat'
    },
    session: {
      key: 'webchat-shared',
      historyLimit: 100,
      pollLimit: 20,
      historyPageSize: 100
    },
    polling: {
      clientStreamingIntervalMs: 1000,
      clientProcessingIntervalMs: 1500
    },
    ui: {
      toolResultPreviewChars: 500
    }
  };

  let appConfig = structuredClone(DEFAULT_APP_CONFIG);
  let currentSessionId = appConfig.session.key;
  let polling = false;
  let pollTimer = null;
  let lastMessageCount = 0;
  let showTools = false;
  let availableModels = [];
  let currentModel = localStorage.getItem('oc_model') || '';

  function getToken() { return localStorage.getItem('oc_token') || ''; }
  function authHeaders() {
    const t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function mergeConfig(input) {
    const cfg = input || {};
    appConfig = {
      branding: { ...DEFAULT_APP_CONFIG.branding, ...(cfg.branding || {}) },
      session: { ...DEFAULT_APP_CONFIG.session, ...(cfg.session || {}) },
      polling: { ...DEFAULT_APP_CONFIG.polling, ...(cfg.polling || {}) },
      ui: { ...DEFAULT_APP_CONFIG.ui, ...(cfg.ui || {}) }
    };
    currentSessionId = appConfig.session.key || DEFAULT_APP_CONFIG.session.key;
  }

  async function loadAppConfig() {
    try {
      const res = await fetch('/api/config', { headers: authHeaders(), cache: 'no-store' });
      if (res.ok) mergeConfig(await res.json());
    } catch (_) {
      mergeConfig(DEFAULT_APP_CONFIG);
    }
    applyBranding();
  }

  function applyBranding() {
    const b = appConfig.branding;
    document.title = b.documentTitle || `${b.name} Chat`;
    setText('#brand-name', b.name);
    setText('#welcome-icon', b.emoji);
    setText('#welcome-title', b.welcomeTitle || `Welcome to ${b.name}`);
    setText('#welcome-subtitle', b.welcomeSubtitle);
  }

  function setText(selector, text) {
    const el = document.querySelector(selector);
    if (el) el.textContent = text || '';
  }

  function showLogin() {
    const b = appConfig.branding;
    const overlay = document.createElement('div');
    overlay.id = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-logo">${escapeHtml(b.emoji || '🐾')}</div>
        <h2>${escapeHtml(b.name || 'FastClaw')}</h2>
        <form id="login-form">
          <input type="password" id="login-pw" placeholder="输入访问密码" autocomplete="off" />
          <button type="submit" id="login-btn">进入</button>
        </form>
        <div id="login-error"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('login-form').addEventListener('submit', e => {
      e.preventDefault();
      const pw = document.getElementById('login-pw').value.trim();
      if (!pw) return;
      localStorage.setItem('oc_token', pw);
      fetch('/api/status', { headers: authHeaders() })
        .then(r => {
          if (r.status === 401) {
            localStorage.removeItem('oc_token');
            document.getElementById('login-error').textContent = '密码错误';
            document.getElementById('login-pw').value = '';
          } else {
            overlay.remove();
            loadAppConfig().finally(startApp);
          }
        });
    });
    document.getElementById('login-pw').focus();
  }

  async function init() {
    const saved = localStorage.getItem('oc_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    await loadAppConfig();

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('oc_theme', next);
      });
    }
    if (getToken()) {
      fetch('/api/status', { headers: authHeaders() }).then(r => {
        if (r.status === 401) { localStorage.removeItem('oc_token'); showLogin(); }
        else loadAppConfig().finally(startApp);
      }).catch(() => startApp());
    } else { showLogin(); }
  }

  function startApp() {
    const msgContainer = document.getElementById('messages');
    const msgInput = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const chatStatus = document.getElementById('chat-status');
    const refreshBtn = document.getElementById('refresh-btn');
    const toolsBtn = document.getElementById('tools-toggle');
    const modelSelect = document.getElementById('model-select');

    loadModels();
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        currentModel = modelSelect.value;
        localStorage.setItem('oc_model', currentModel);
      });
    }

    if (toolsBtn) {
      updateToolsBtn();
      toolsBtn.addEventListener('click', () => {
        showTools = !showTools;
        updateToolsBtn();
        msgContainer.querySelectorAll('.tool-block').forEach(el => {
          el.style.display = showTools ? 'block' : 'none';
        });
      });
    }
    function updateToolsBtn() {
      if (!toolsBtn) return;
      toolsBtn.textContent = showTools ? '🔧 隐藏调用' : '🔧 显示调用';
      toolsBtn.classList.toggle('active', showTools);
    }

    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      loadHistory().finally(() => setTimeout(() => refreshBtn.classList.remove('spinning'), 300));
    });

    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 150) + 'px';
    });
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('chat-form').dispatchEvent(new Event('submit'));
      }
    });
    document.getElementById('chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const text = msgInput.value.trim();
      if (!text) return;
      appendMessage('user', [{ type: 'text', text: text }]);
      msgInput.value = '';
      msgInput.style.height = 'auto';
      sendBtn.disabled = true;
      chatStatus.style.display = 'inline';
      fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ message: text, model: currentModel }),
      }).then(r => r.json()).then(data => {
        if (data.error) throw new Error(data.error);
        currentSessionId = data.sessionId || appConfig.session.key || currentSessionId;
        startPolling();
      }).catch(err => {
        appendMessage('error', [{ type: 'text', text: 'Send failed: ' + err.message }]);
        sendBtn.disabled = false; chatStatus.style.display = 'none';
      });
    });

    let earliestTimestamp = null;
    let loadingMore = false;

    loadHistory();
    msgInput.focus();

    async function loadHistory() {
      try {
        const limit = Number(appConfig.session.historyLimit) || DEFAULT_APP_CONFIG.session.historyLimit;
        const data = await (await fetch(`/api/history?limit=${encodeURIComponent(limit)}`, { headers: authHeaders() })).json();
        if (data.messages && data.messages.length > 0) {
          const welcome = msgContainer.querySelector('.welcome-msg');
          if (welcome) welcome.remove();
          msgContainer.innerHTML = '';
          data.messages.forEach(m => appendMessage(m.role, m.content, m.timestamp));
          const firstRow = msgContainer.querySelector('.msg-row');
          if (firstRow && firstRow.dataset.ts) earliestTimestamp = firstRow.dataset.ts;
          if (data.messages.length >= getHistoryPageSize()) showLoadMoreBtn();
        }
      } catch (_) {}
    }

    function getHistoryPageSize() {
      return Number(appConfig.session.historyPageSize) || Number(appConfig.session.historyLimit) || DEFAULT_APP_CONFIG.session.historyPageSize;
    }

    function showLoadMoreBtn() {
      let btn = document.getElementById('load-more-btn');
      if (btn) return;
      btn = document.createElement('button');
      btn.id = 'load-more-btn';
      btn.textContent = '⬆️ 加载更早的消息';
      btn.style.cssText = 'display:block;margin:8px auto;padding:6px 16px;border:1px solid #ccc;border-radius:16px;background:var(--bg-secondary,#f0f0f0);color:var(--text-primary,#333);cursor:pointer;font-size:13px;';
      btn.addEventListener('click', loadMoreHistory);
      msgContainer.insertBefore(btn, msgContainer.firstChild);
    }

    function hideLoadMoreBtn() {
      const btn = document.getElementById('load-more-btn');
      if (btn) btn.remove();
    }

    async function loadMoreHistory() {
      if (loadingMore) return;
      const btn = document.getElementById('load-more-btn');
      if (!btn || !earliestTimestamp) return;
      loadingMore = true;
      btn.textContent = '⏳ 加载中...';
      btn.disabled = true;
      const prevScrollHeight = msgContainer.scrollHeight;
      const pageSize = getHistoryPageSize();
      try {
        const data = await (await fetch(`/api/history/before?before=${encodeURIComponent(earliestTimestamp)}&limit=${encodeURIComponent(pageSize)}`, { headers: authHeaders() })).json();
        if (data.messages && data.messages.length > 0) {
          const loadMoreBtn = document.getElementById('load-more-btn');
          const tempDiv = document.createElement('div');
          for (const m of data.messages) appendMessageTo(m.role, m.content, m.timestamp, tempDiv);
          while (tempDiv.lastChild) msgContainer.insertBefore(tempDiv.lastChild, loadMoreBtn);
          const firstRow = msgContainer.querySelector('.msg-row');
          if (firstRow && firstRow.dataset.ts) earliestTimestamp = firstRow.dataset.ts;
          msgContainer.scrollTop = msgContainer.scrollHeight - prevScrollHeight;
          if (data.messages.length < pageSize) hideLoadMoreBtn();
        } else {
          hideLoadMoreBtn();
        }
      } catch (_) {}
      loadingMore = false;
      if (document.getElementById('load-more-btn')) {
        const b = document.getElementById('load-more-btn');
        b.textContent = '⬆️ 加载更早的消息';
        b.disabled = false;
      }
    }

    function startPolling() { if (polling) return; polling = true; pollLoop(); }
    let lastRepliesJson = '';
    function pollLoop() {
      if (!polling) return;
      fetch(`/api/poll?sessionId=${encodeURIComponent(currentSessionId || appConfig.session.key)}`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
          if (data.status === 'error') {
            appendMessage('error', [{ type: 'text', text: data.error }]); stopPolling();
          } else if (data.status === 'streaming' || data.status === 'done') {
            const replies = data.replies || [];
            const json = JSON.stringify(replies);
            if (replies.length > 0 && json !== lastRepliesJson) {
              for (const reply of replies) appendMessage(reply.role || 'assistant', reply.content, null);
              lastRepliesJson = json;
            }
            if (data.status === 'done') stopPolling();
            if (polling) pollTimer = setTimeout(pollLoop, Number(appConfig.polling.clientStreamingIntervalMs) || 1000);
          } else {
            pollTimer = setTimeout(pollLoop, Number(appConfig.polling.clientProcessingIntervalMs) || 1500);
          }
        })
        .catch(err => { appendMessage('error', [{ type: 'text', text: 'Poll error: ' + err.message }]); stopPolling(); });
    }
    function stopPolling() {
      polling = false; clearTimeout(pollTimer);
      sendBtn.disabled = false; chatStatus.style.display = 'none';
      lastRepliesJson = ''; loadHistory();
    }

    async function loadModels() {
      if (!modelSelect) return;
      try {
        const data = await (await fetch('/api/models', { headers: authHeaders() })).json();
        availableModels = Array.isArray(data.models) ? data.models : [];
        const fallbackModel = data.defaultModel || availableModels[0]?.id || '';
        if (!availableModels.some(m => m.id === currentModel)) currentModel = fallbackModel;
        modelSelect.innerHTML = availableModels.map(m => {
          const selected = m.id === currentModel ? ' selected' : '';
          return `<option value="${escapeAttr(m.id)}"${selected}>${escapeHtml(m.label || m.id)}</option>`;
        }).join('');
        if (currentModel) localStorage.setItem('oc_model', currentModel);
        modelSelect.disabled = availableModels.length === 0;
      } catch (_) {
        modelSelect.innerHTML = '<option value="">模型加载失败</option>';
        modelSelect.disabled = true;
      }
    }
  }

  function appendMessageTo(role, content, ts, container) {
    const welcome = container.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    let parts;
    if (typeof content === 'string') parts = [{ type: 'text', text: content }];
    else if (Array.isArray(content)) parts = content;
    else parts = [{ type: 'text', text: String(content) }];

    const visibleParts = [];
    const toolParts = [];
    for (const p of parts) {
      if (p.type === 'toolCall' || p.type === 'toolResult') toolParts.push(p);
      else visibleParts.push(p);
    }
    if (visibleParts.length === 0 && toolParts.length === 0) return;
    if (visibleParts.length === 0) return;

    let html = '';
    let textAccum = '';
    const images = [];
    for (const part of visibleParts) {
      if (part.type === 'text') {
        textAccum += (textAccum ? '\n' : '') + (part.text || '');
      } else if (part.type === 'image' && part.url) {
        if (textAccum) { html += renderMarkdown(textAccum); textAccum = ''; }
        images.push(part.url);
      }
    }
    if (textAccum) html += renderMarkdown(textAccum);
    for (const url of images) html += `<img class="msg-image" src="${escapeAttr(url)}" alt="image" loading="lazy" onclick="window.open(this.src,'_blank')" />`;

    if (toolParts.length > 0) {
      html += '<div class="tool-block" style="display:' + (showTools ? 'block' : 'none') + '">';
      for (const tp of toolParts) {
        if (tp.type === 'toolCall') {
          const args = formatToolArgs(tp.arguments);
          html += `<div class="tool-call"><span class="tool-name">⚡ ${escapeHtml(tp.name)}</span><pre class="tool-args">${escapeHtml(args)}</pre></div>`;
        } else if (tp.type === 'toolResult' && tp.text) {
          const maxChars = Number(appConfig.ui.toolResultPreviewChars) || DEFAULT_APP_CONFIG.ui.toolResultPreviewChars;
          html += `<div class="tool-result"><span class="tool-label">📤 结果</span><pre>${escapeHtml(tp.text.slice(0, maxChars))}</pre></div>`;
        }
      }
      html += '</div>';
    }

    const row = document.createElement('div');
    row.className = `msg-row ${role === 'error' ? 'error' : role}`;
    const d = ts ? new Date(ts) : new Date();
    row.dataset.ts = ts || d.toISOString();

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? appConfig.branding.avatarUser : role === 'error' ? '!' : appConfig.branding.avatarBot;

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble${role === 'error' ? ' error' : ''}`;
    bubble.innerHTML = html;

    const wrapper = document.createElement('div');
    wrapper.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    wrapper.appendChild(time);

    row.appendChild(avatar);
    row.appendChild(wrapper);
    container.appendChild(row);
  }

  function appendMessage(role, content, ts) {
    const msgContainer = document.getElementById('messages');
    appendMessageTo(role, content, ts, msgContainer);
    msgContainer.scrollTop = msgContainer.scrollHeight;
    lastMessageCount = msgContainer.querySelectorAll('.msg-row').length;
  }

  function formatToolArgs(args) {
    if (!args) return '';
    if (typeof args === 'string') return args;
    if (args.command) return args.command;
    if (args.paths && Array.isArray(args.paths)) return args.paths.join('\n');
    return JSON.stringify(args, null, 0);
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const images = [];
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      images.push({ alt, url });
      return '';
    });
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    for (const img of images) html += `<img class="msg-image" src="${escapeAttr(img.url)}" alt="${escapeAttr(img.alt || '')}" loading="lazy" onclick="window.open(this.src,'_blank')" />`;
    html = html.replace(/<p>\s*<\/p>/g, '');
    return html;
  }

  function escapeHtml(s) {
    s = String(s ?? '');
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return s.replace(/[&<>"']/g, c => map[c]);
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
