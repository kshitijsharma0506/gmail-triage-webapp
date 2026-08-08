let currentConfig = null;
let aiConfigured = false;
let lastRows = [];

async function init() {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) { location.href = '/'; return; }
  const me = await meRes.json();
  document.getElementById('userEmail').textContent = me.email;

  const aiStatus = await (await fetch('/api/ai-status')).json();
  aiConfigured = !!aiStatus.configured;

  currentConfig = await (await fetch('/api/config')).json();
  renderCategories();
  document.getElementById('baseQuery').value = currentConfig.baseQuery || 'in:inbox is:unread';
  document.getElementById('scanDays').value = String(currentConfig.scanDays || 3);
  document.getElementById('dryRun').checked = currentConfig.dryRun !== false;
  updateDryBanner();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------

function renderCategories() {
  const container = document.getElementById('categories');
  container.innerHTML = '';
  (currentConfig.categories || []).forEach(cat => container.appendChild(buildCategoryEl(cat)));
}

function replyBoxLabel(mode) {
  return mode === 'ai' ? 'Instructions for the AI' : 'Draft reply template';
}

function defaultTextFor(mode) {
  return mode === 'ai'
    ? 'Write a brief, polite, professional reply based on the email content.'
    : "Hi,\n\nThanks for your email — I'll get back to you soon.\n\nBest";
}

function buildCategoryEl(cat) {
  const el = document.createElement('div');
  el.className = 'cat';

  const mode = cat.replyMode === 'ai' ? 'ai' : 'static';
  // Backward compat: older saved configs only had one `replyTemplate` field
  // shared by both modes. Seed each mode's stored text from whatever's
  // actually relevant, so switching modes doesn't silently lose content.
  const staticText = mode === 'static' ? (cat.replyTemplate || '') : '';
  const aiText = mode === 'ai' ? (cat.aiInstructions || cat.replyTemplate || '') : (cat.aiInstructions || '');
  el.dataset.staticText = staticText;
  el.dataset.aiText = aiText;
  el.dataset.currentMode = mode;

  const keywordsStr = (cat.keywords || []).join(', ');
  const aiDisabledAttr = aiConfigured ? '' : 'disabled';
  const aiHint = aiConfigured ? '' : ' (needs an API key set up)';

  el.innerHTML = `
    <div class="cat-head">
      <input type="text" class="name" value="${escapeHtml(cat.name)}" placeholder="Category name">
      <button class="icon-btn" title="Remove category" onclick="this.closest('.cat').remove()">&times;</button>
    </div>

    <div class="cat-field">
      <label class="small">Keywords (comma-separated)</label>
      <input type="text" class="keywords" value="${escapeHtml(keywordsStr)}" placeholder="e.g. invoice, payment, receipt">
    </div>

    <label class="switch-line">
      <input type="checkbox" class="reply-enabled toggle" ${cat.replyEnabled ? 'checked' : ''} onchange="this.closest('.cat').querySelector('.reply-box').style.display = this.checked ? '' : 'none'">
      <span>Create a draft reply for matches</span>
    </label>

    <div class="reply-box" style="${cat.replyEnabled ? '' : 'display:none;'}">
      <div class="reply-mode-row">
        <select class="reply-mode" onchange="onReplyModeChange(this)">
          <option value="static" ${mode === 'static' ? 'selected' : ''}>Fixed template</option>
          <option value="ai" ${mode === 'ai' ? 'selected' : ''} ${aiDisabledAttr}>AI-written (Claude)${aiHint}</option>
        </select>
      </div>
      <label class="small reply-template-label">${replyBoxLabel(mode)}</label>
      <textarea class="reply-template" placeholder="${mode === 'ai' ? 'Instructions for the AI...' : 'Reply text...'}">${escapeHtml(mode === 'ai' ? aiText : staticText)}</textarea>
    </div>
  `;
  return el;
}

function onReplyModeChange(selectEl) {
  const catEl = selectEl.closest('.cat');
  const textarea = catEl.querySelector('.reply-template');
  const labelEl = catEl.querySelector('.reply-template-label');
  const prevMode = catEl.dataset.currentMode || 'static';

  // Stash whatever's currently typed under the mode it belongs to.
  if (prevMode === 'ai') catEl.dataset.aiText = textarea.value;
  else catEl.dataset.staticText = textarea.value;

  const newMode = selectEl.value === 'ai' ? 'ai' : 'static';
  const stored = newMode === 'ai' ? catEl.dataset.aiText : catEl.dataset.staticText;
  textarea.value = stored || defaultTextFor(newMode);
  textarea.placeholder = newMode === 'ai' ? 'Instructions for the AI...' : 'Reply text...';
  labelEl.textContent = replyBoxLabel(newMode);
  catEl.dataset.currentMode = newMode;
}

function addCategory() {
  document.getElementById('categories').appendChild(
    buildCategoryEl({ name: '', keywords: [], replyEnabled: false, replyMode: 'static', replyTemplate: '', aiInstructions: '' })
  );
}

function collectConfig() {
  const categories = Array.from(document.querySelectorAll('.cat')).map(el => {
    const mode = el.querySelector('.reply-mode').value === 'ai' ? 'ai' : 'static';
    // Make sure any text currently on-screen is captured under the right slot.
    if (mode === 'ai') el.dataset.aiText = el.querySelector('.reply-template').value;
    else el.dataset.staticText = el.querySelector('.reply-template').value;

    return {
      name: el.querySelector('.name').value.trim(),
      keywords: el.querySelector('.keywords').value.split(',').map(k => k.trim()).filter(Boolean),
      replyEnabled: el.querySelector('.reply-enabled').checked,
      replyMode: mode,
      replyTemplate: el.dataset.staticText || '',
      aiInstructions: el.dataset.aiText || ''
    };
  }).filter(c => c.name);

  return {
    categories,
    baseQuery: document.getElementById('baseQuery').value.trim() || 'in:inbox is:unread',
    scanDays: parseInt(document.getElementById('scanDays').value, 10) || 3,
    dryRun: document.getElementById('dryRun').checked
  };
}

async function saveConfig(showStatus) {
  const config = collectConfig();
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  currentConfig = config;
  if (showStatus) {
    setStatus('Settings saved.');
    setTimeout(() => { if (document.getElementById('status').textContent === 'Settings saved.') setStatus(''); }, 2000);
  }
  return config;
}

// ---------------------------------------------------------------------
// Scan settings / run
// ---------------------------------------------------------------------

document.getElementById('dryRun').addEventListener('change', updateDryBanner);

function updateDryBanner() {
  document.getElementById('dryBanner').style.display = document.getElementById('dryRun').checked ? '' : 'none';
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

async function runTriage() {
  const config = await saveConfig(false);
  if (config.categories.length === 0) {
    setStatus('Add at least one category first.');
    return;
  }
  const runBtn = document.getElementById('runBtn');
  runBtn.disabled = true;
  document.getElementById('results').innerHTML = '';
  setStatus('Running triage...');

  try {
    const res = await fetch('/api/run-triage', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');

    renderResults(data.rows);
    const matched = data.rows.filter(r => r.category).length;
    let msg = data.dryRun
      ? `Preview complete — ${matched} of ${data.rows.length} matched a category. Turn off dry run and re-run to apply.`
      : `Done — ${data.rows.filter(r => r.labeled === true).length} labeled, ${data.rows.filter(r => r.drafted === true).length} drafted, out of ${data.rows.length} scanned.`;
    if (data.labelingError) msg += ` (Labeling error: ${data.labelingError})`;
    setStatus(msg);
  } catch (e) {
    setStatus('Error: ' + e.message);
  } finally {
    runBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Results + draft edit / save / send
// ---------------------------------------------------------------------

function badgeFor(v) {
  if (v === true) return '<span class="badge badge-yes">yes</span>';
  if (v === 'preview') return '<span class="badge badge-cat">would apply</span>';
  if (v === 'unavailable') return '<span class="badge badge-err">error</span>';
  return '<span class="badge badge-no">no</span>';
}

function renderResults(rows) {
  lastRows = rows || [];
  const container = document.getElementById('results');
  if (!rows || rows.length === 0) {
    container.innerHTML = '<p class="empty-note">No emails matched your scan settings.</p>';
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Subject</th><th>From</th><th>Category</th><th>Labeled</th><th>Draft</th><th>Error</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  rows.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.subject)}</td>
      <td>${escapeHtml(r.from)}</td>
      <td>${r.category ? `<span class="badge badge-cat">${escapeHtml(r.category)}</span>` : `<span class="badge badge-none">none</span>`}</td>
      <td>${badgeFor(r.labeled)}</td>
      <td>${badgeFor(r.drafted)}${r.draftId ? ` <button class="link-btn" onclick="toggleDraftEditor(${idx})">view / edit</button>` : ''}</td>
      <td class="error-cell">${r.error ? escapeHtml(r.error) : ''}</td>
    `;
    tbody.appendChild(tr);

    if (r.draftId) {
      tbody.appendChild(buildDraftEditorRow(r, idx));
    }
  });

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function buildDraftEditorRow(row, idx) {
  const tr = document.createElement('tr');
  tr.id = `draft-row-${idx}`;
  tr.style.display = 'none';
  tr.className = 'draft-editor-row';

  const td = document.createElement('td');
  td.colSpan = 6;

  const wrap = document.createElement('div');
  wrap.className = 'draft-editor';

  const meta = document.createElement('div');
  meta.className = 'draft-meta';
  meta.textContent = `To: ${row.draftTo || ''}   ·   Subject: ${row.draftSubject || ''}`;

  const textarea = document.createElement('textarea');
  textarea.className = 'draft-body-input';
  textarea.value = row.draftBody || '';

  const statusSpan = document.createElement('span');
  statusSpan.className = 'draft-status';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-secondary';
  saveBtn.textContent = 'Save as draft';
  saveBtn.onclick = () => saveDraftEdit(idx, textarea, statusSpan, saveBtn, sendBtn);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn-run';
  sendBtn.textContent = 'Send';
  sendBtn.onclick = () => sendDraftNow(idx, textarea, statusSpan, saveBtn, sendBtn);

  const btnRow = document.createElement('div');
  btnRow.className = 'actions-row';
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(sendBtn);
  btnRow.appendChild(statusSpan);

  wrap.appendChild(meta);
  wrap.appendChild(textarea);
  wrap.appendChild(btnRow);
  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

function toggleDraftEditor(idx) {
  const row = document.getElementById(`draft-row-${idx}`);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function updateDraftOnServer(row, newBody) {
  const res = await fetch(`/api/drafts/${row.draftId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: row.draftTo,
      subject: row.draftSubject,
      body: newBody,
      threadId: row.threadId,
      rfc822MessageId: row.rfc822MessageId
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed');
  row.draftBody = newBody;
}

// Locks a draft's editor permanently once it's been sent (or once we
// discover it no longer exists as a draft because it was already sent) so
// a stray extra click can't retry against a draft Gmail has already
// converted into a sent message.
function lockDraftEditor(textarea, saveBtn, sendBtn, label) {
  textarea.disabled = true;
  saveBtn.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = label || 'Sent';
}

function isMissingDraftError(message) {
  return /not found|requested entity was not found|invalid.*id/i.test(message || '');
}

async function saveDraftEdit(idx, textarea, statusEl, saveBtn, sendBtn) {
  const row = lastRows[idx];
  saveBtn.disabled = true;
  sendBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.style.color = '';
  try {
    await updateDraftOnServer(row, textarea.value);
    statusEl.textContent = 'Saved.';
    statusEl.style.color = '#0b7a41';
  } catch (e) {
    if (isMissingDraftError(e.message)) {
      statusEl.textContent = 'This draft no longer exists in Gmail (probably already sent or deleted).';
      statusEl.style.color = '#b3261e';
      lockDraftEditor(textarea, saveBtn, sendBtn, 'Unavailable');
      return;
    }
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = '#b3261e';
  } finally {
    saveBtn.disabled = false;
    sendBtn.disabled = false;
  }
}

async function sendDraftNow(idx, textarea, statusEl, saveBtn, sendBtn) {
  const row = lastRows[idx];
  if (!confirm(`Send this email to ${row.draftTo}? This can't be undone.`)) return;

  saveBtn.disabled = true;
  sendBtn.disabled = true;
  try {
    statusEl.textContent = 'Saving edits...';
    statusEl.style.color = '';
    await updateDraftOnServer(row, textarea.value);

    statusEl.textContent = 'Sending...';
    const res = await fetch(`/api/drafts/${row.draftId}/send`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');

    statusEl.textContent = 'Sent.';
    statusEl.style.color = '#0b7a41';
    lockDraftEditor(textarea, saveBtn, sendBtn, 'Sent');
  } catch (e) {
    if (isMissingDraftError(e.message)) {
      // Most likely: this draft was already sent by an earlier click.
      statusEl.textContent = 'Already sent (or removed) — nothing more to do here.';
      statusEl.style.color = '#0b7a41';
      lockDraftEditor(textarea, saveBtn, sendBtn, 'Sent');
      return;
    }
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = '#b3261e';
    saveBtn.disabled = false;
    sendBtn.disabled = false;
  }
}

init();
