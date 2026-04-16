// FastClaw WebChat - Client App (single session, no sidebar)
(function () {
  'use strict';

  const SHARED_SESSION = 'webchat-shared';
  let polling = false;
  let pollTimer = null;
  let lastMessageCount = 0;
  let showTools = false;

  function getToken() { return localStorage.getItem('oc_token') || ''; }
  function authHeaders() {
    const t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function showLogin() {
    const overlay = document.createElement('div');
    overlay.id = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-logo">🐾</div>
        <h2>FastClaw</h2>
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
          } else { overlay.remove(); startApp(); }
        });
    });
    document.getElementById('login-pw').focus();
  }

  function init() {
    const saved = localStorage.getItem('oc_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
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
        else startApp();
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

    // ---- Tools Toggle ----
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

    // ---- Refresh ----
    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      loadHistory().finally(() => setTimeout(() => refreshBtn.classList.remove('spinning'), 300));
    });

    // ---- Input ----
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
        body: JSON.stringify({ message: text }),
      }).then(r => r.json()).then(data => {
        if (data.error) throw new Error(data.error);
        startPolling();
      }).catch(err => {
        appendMessage('error', [{ type: 'text', text: 'Send failed: ' + err.message }]);
        sendBtn.disabled = false; chatStatus.style.display = 'none';
      });
    });

    loadHistory();
    msgInput.focus();

    // ---- History ----
    async function loadHistory() {
      try {
        const data = await (await fetch('/api/history', { headers: authHeaders() })).json();
        if (data.messages && data.messages.length > 0) {
          const welcome = msgContainer.querySelector('.welcome-msg');
          if (welcome) welcome.remove();
          const newMsgs = data.messages.slice(lastMessageCount);
          if (newMsgs.length > 0) {
            newMsgs.forEach(m => appendMessage(m.role, m.content, m.timestamp));
            lastMessageCount = data.messages.length;
          }
        }
      } catch (_) {}
    }

    // ---- Polling ----
    function startPolling() { if (polling) return; polling = true; pollLoop(); }
    let lastRepliesJson = '';
    function pollLoop() {
      if (!polling) return;
      fetch(`/api/poll?sessionId=${SHARED_SESSION}`, { headers: authHeaders() })
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
            if (polling) pollTimer = setTimeout(pollLoop, 1000);
          } else {
            pollTimer = setTimeout(pollLoop, 1500);
          }
        })
        .catch(err => { appendMessage('error', [{ type: 'text', text: 'Poll error: ' + err.message }]); stopPolling(); });
    }
    function stopPolling() {
      polling = false; clearTimeout(pollTimer);
      sendBtn.disabled = false; chatStatus.style.display = 'none';
      lastRepliesJson = ''; loadHistory();
    }
  }

  // ---- Render ----
  // Simple rule:
  //   - user/assistant messages with text/image: ALWAYS visible
  //   - assistant messages with only toolCall (no text/image): hidden by default
  //   - toolResult messages: hidden by default
  //   - All hidden content goes into a .tool-block, toggled by the tools button

  function appendMessage(role, content, ts) {
    const msgContainer = document.getElementById('messages');
    const welcome = msgContainer.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    let parts;
    if (typeof content === 'string') parts = [{ type: 'text', text: content }];
    else if (Array.isArray(content)) parts = content;
    else parts = [{ type: 'text', text: String(content) }];

    // Separate visible content from tool/process content
    const visibleParts = [];  // text + image (always shown)
    const toolParts = [];     // toolCall + toolResult (hidden by default)

    for (const p of parts) {
      if (p.type === 'toolCall' || p.type === 'toolResult') {
        toolParts.push(p);
      } else {
        visibleParts.push(p);
      }
    }

    // Nothing to show at all (e.g. assistant with only toolCalls, no text/image)
    // Only render if there's visible content, OR hidden tool parts to toggle
    if (visibleParts.length === 0 && toolParts.length === 0) return;

    // If only tool parts (no visible text/image), skip the bubble row entirely
    // Tool content only shows inside a visible bubble's .tool-block
    if (visibleParts.length === 0) {
      // Don't render — these are pure tool calls with no text output
      // They'll be attached to the next text message's tool-block
      return;
    }

    // Build the bubble HTML
    let html = '';
    let textAccum = '';
    let images = [];
    for (const part of visibleParts) {
      if (part.type === 'text') {
        textAccum += (textAccum ? '\n' : '') + (part.text || '');
      } else if (part.type === 'image' && part.url) {
        if (textAccum) { html += renderMarkdown(textAccum); textAccum = ''; }
        images.push(part.url);
      }
    }
    if (textAccum) html += renderMarkdown(textAccum);
    for (const url of images) {
      html += `<img class="msg-image" src="${url}" alt="image" loading="lazy" onclick="window.open(this.src,'_blank')" />`;
    }

    // Append hidden tool blocks if any (inside the same bubble)
    if (toolParts.length > 0) {
      html += '<div class="tool-block" style="display:' + (showTools ? 'block' : 'none') + '">';
      for (const tp of toolParts) {
        if (tp.type === 'toolCall') {
          const args = formatToolArgs(tp.arguments);
          html += `<div class="tool-call"><span class="tool-name">⚡ ${escapeHtml(tp.name)}</span><pre class="tool-args">${escapeHtml(args)}</pre></div>`;
        } else if (tp.type === 'toolResult' && tp.text) {
          html += `<div class="tool-result"><span class="tool-label">📤 结果</span><pre>${escapeHtml(tp.text.slice(0, 500))}</pre></div>`;
        }
      }
      html += '</div>';
    }

    // Build DOM
    const row = document.createElement('div');
    row.className = `msg-row ${role === 'error' ? 'error' : role}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'U' : role === 'error' ? '!' : 'FC';

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble${role === 'error' ? ' error' : ''}`;
    bubble.innerHTML = html;

    const wrapper = document.createElement('div');
    wrapper.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'msg-time';
    const d = ts ? new Date(ts) : new Date();
    time.textContent = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    wrapper.appendChild(time);

    row.appendChild(avatar);
    row.appendChild(wrapper);
    msgContainer.appendChild(row);
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
    // 1. Extract images BEFORE escaping (URLs must stay raw)
    const images = [];
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      images.push({ alt, url });
      return '';
    });
    // 2. Escape the rest
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    // Append extracted images (URLs kept raw, not escaped)
    for (const img of images) {
      html += `<img class="msg-image" src="${img.url}" alt="${escapeAttr(img.alt || '')}" loading="lazy" onclick="window.open(this.src,'_blank')" />`;
    }
    html = html.replace(/<p>\s*<\/p>/g, '');
    return html;
  }

  function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return s.replace(/[&<>"']/g, c => map[c]);
  }

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
