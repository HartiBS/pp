/* ===== INTERAKTIVER STYLEGUIDE ===== */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const SG_TOKENS = [
    '--bg', '--bg-elevated', '--bg-card', '--border', '--border-hover',
    '--text', '--text-muted', '--text-faint', '--accent', '--accent-hover',
    '--accent-light', '--danger', '--success', '--input-bg', '--shadow',
    '--badge-todo-bg', '--badge-todo-text',
    '--badge-progress-bg', '--badge-progress-text',
    '--badge-review-bg', '--badge-review-text',
    '--badge-done-bg', '--badge-done-text',
    '--badge-active-bg', '--badge-active-text',
    '--badge-planning-bg', '--badge-planning-text',
    '--badge-prio-low-bg', '--badge-prio-low-text',
    '--badge-prio-normal-bg', '--badge-prio-normal-text',
    '--badge-prio-high-bg', '--badge-prio-high-text',
    '--badge-prio-critical-bg', '--badge-prio-critical-text',
  ];

  const SG_COLOR_TOKENS = {
    'sg-token-accent': '--accent',
    'sg-token-accent-hover': '--accent-hover',
    'sg-token-danger': '--danger',
  };

  const SG_NUMBER_FIELDS = ['sg-radius', 'sg-btn-padding', 'sg-font-size'];

  const sgOverrideStyle = document.createElement('style');
  sgOverrideStyle.id = 'sg-overrides';
  document.head.appendChild(sgOverrideStyle);

  function effectiveVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function toHex(color) {
    const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return '#000000';
    return '#' + [Number(m[1]), Number(m[2]), Number(m[3])]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  function renderSwatches() {
    const wrap = $('#sg-swatches');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const token of SG_TOKENS) {
      const value = effectiveVar(token);
      const el = document.createElement('div');
      el.className = 'sg-swatch';
      const color = document.createElement('span');
      color.className = 'sg-swatch-color';
      color.style.background = value;
      const name = document.createElement('span');
      name.className = 'sg-swatch-name';
      name.textContent = token;
      name.title = token;
      const val = document.createElement('span');
      val.className = 'sg-swatch-value';
      val.textContent = value;
      el.append(color, name, val);
      wrap.appendChild(el);
    }
  }

  function syncInputs() {
    for (const [inputId, token] of Object.entries(SG_COLOR_TOKENS)) {
      const input = $('#' + inputId);
      if (input) input.value = toHex(effectiveVar(token));
    }
    const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const btn = document.querySelector('#styleguide-view button');
    if (btn) {
      const cs = getComputedStyle(btn);
      $('#sg-radius').value = parseFloat(cs.borderRadius) || 6;
      $('#sg-btn-padding').value = (parseFloat(cs.paddingTop) / rootFont || 0.6).toFixed(2);
    }
    $('#sg-font-size').value = rootFont;
  }

  function applyOverrides() {
    const radius = $('#sg-radius').value || 6;
    const pad = $('#sg-btn-padding').value || 0.6;
    const font = $('#sg-font-size').value || 16;
    sgOverrideStyle.textContent =
      'html { font-size: ' + font + 'px; }\n' +
      'button, input, textarea, select { border-radius: ' + radius + 'px; }\n' +
      'button { padding: ' + pad + 'rem 1.3rem; }';
  }

  function updateOutput() {
    const out = $('#sg-token-output');
    if (!out) return;
    const lines = Object.values(SG_COLOR_TOKENS).map((token) => {
      const v = document.body.style.getPropertyValue(token) || effectiveVar(token);
      return '  ' + token + ': ' + v + ';';
    });
    out.textContent = ':root {\n' + lines.join('\n') + '\n}';
  }

  function resetTokens() {
    for (const token of Object.values(SG_COLOR_TOKENS)) {
      document.body.style.removeProperty(token);
    }
    sgOverrideStyle.textContent = '';
    syncInputs();
    applyOverrides();
    updateOutput();
  }

  async function copyCss() {
    const out = $('#sg-token-output');
    const msg = $('#sg-copy-msg');
    const text = out ? out.textContent : '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (msg) {
      msg.hidden = false;
      setTimeout(() => { msg.hidden = true; }, 2000);
    }
  }

  function initStyleguide() {
    const view = $('#styleguide-view');
    if (!view) return;

    renderSwatches();
    syncInputs();
    updateOutput();

    for (const [inputId, token] of Object.entries(SG_COLOR_TOKENS)) {
      $('#' + inputId).addEventListener('input', (e) => {
        document.body.style.setProperty(token, e.target.value);
        renderSwatches();
        updateOutput();
      });
    }
    for (const id of SG_NUMBER_FIELDS) {
      $('#' + id).addEventListener('input', applyOverrides);
    }
    $('#sg-reset-tokens').addEventListener('click', resetTokens);
    $('#sg-copy-css').addEventListener('click', copyCss);

    new MutationObserver(() => { renderSwatches(); syncInputs(); updateOutput(); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });

    view.querySelectorAll('.label-pill').forEach((pill) => {
      pill.addEventListener('click', () => pill.classList.toggle('selected'));
    });
    view.querySelectorAll('#sg-tabs .view-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        view.querySelectorAll('#sg-tabs .view-tab').forEach((t) => t.classList.toggle('active', t === tab));
      });
    });
    const demoForm = $('#sg-form-demo');
    if (demoForm) demoForm.addEventListener('submit', (e) => e.preventDefault());

    const link = $('#styleguide-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); show('styleguide-view'); });
    $('#styleguide-back-btn').addEventListener('click', () => {
      show(state.user ? 'dashboard-view' : 'auth-view');
    });
  }

  initStyleguide();
})();
