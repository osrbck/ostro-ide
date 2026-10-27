const STORAGE_KEY = 'ostro.config';

const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  baseUrl: '',
  thinking: 'off',
  maxTokens: 4096,
  temperature: 1,
  systemPrompt: '',
  enableTools: true,
  approvalMode: 'ask',
};

const THINKING_BUDGETS = { off: 0, low: 2000, medium: 8000, high: 16000 };

// Suggestions only — the model field is free text so any provider model works.
const MODEL_SUGGESTIONS = {
  anthropic: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
    'deepseek-chat',
    'deepseek-reasoner',
    'llama3.1:8b',
    'qwen2.5-coder:32b',
    'mistral-large-latest',
  ],
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function mountSettings({ modal, onSaved }) {
  const providerSel = document.getElementById('select-provider');
  const apiInput = document.getElementById('input-api-key');
  const baseUrlInput = document.getElementById('input-base-url');
  const modelInput = document.getElementById('input-model');
  const modelList = document.getElementById('model-suggestions');
  const thinkingSel = document.getElementById('select-thinking');
  const maxTokensInput = document.getElementById('input-max-tokens');
  const maxTokensValue = document.getElementById('max-tokens-value');
  const tempInput = document.getElementById('input-temperature');
  const tempValue = document.getElementById('temp-value');
  const systemPromptInput = document.getElementById('input-system-prompt');
  const enableToolsInput = document.getElementById('input-enable-tools');
  const approvalModeSel = document.getElementById('select-approval-mode');
  const approvalWarning = document.getElementById('approval-warning');
  const testBtn = document.getElementById('btn-test-connection');
  const testResultEl = document.getElementById('test-result');
  const extListEl = document.getElementById('ext-list');
  const extRootHint = document.getElementById('ext-root-hint');
  const extReloadBtn = document.getElementById('btn-reload-extensions');
  const extReloadResult = document.getElementById('ext-reload-result');
  const btnSave = document.getElementById('btn-settings-save');
  const btnCancel = document.getElementById('btn-settings-cancel');

  let config = loadConfig();

  function refreshModelSuggestions(provider) {
    const models = MODEL_SUGGESTIONS[provider] || [];
    modelList.innerHTML = models.map((m) => `<option value="${m}"></option>`).join('');
  }

  function open() { modal.classList.remove('hidden'); apply(); }
  function close() { modal.classList.add('hidden'); }

  function apply() {
    if (!MODEL_SUGGESTIONS[config.provider]) config.provider = 'anthropic';
    providerSel.value = config.provider;
    apiInput.value = '';
    baseUrlInput.value = config.baseUrl || '';
    modelInput.value = config.model || '';
    thinkingSel.value = config.thinking;
    maxTokensInput.value = config.maxTokens;
    maxTokensValue.textContent = config.maxTokens;
    tempInput.value = config.temperature;
    tempValue.textContent = Number(config.temperature).toFixed(2);
    systemPromptInput.value = config.systemPrompt || '';
    enableToolsInput.checked = config.enableTools !== false;
    approvalModeSel.value = config.approvalMode || 'ask';
    refreshApprovalWarning();
    testResultEl.textContent = '';
    testResultEl.className = 'settings-test-result';
    lastProvider = config.provider;
    refreshModelSuggestions(config.provider);
    hydrateKeyPlaceholder(config.provider);
  }

  async function hydrateKeyPlaceholder(provider) {
    try {
      const existing = await window.ostro.keychain.getApiKey(provider);
      apiInput.placeholder = existing ? '•••• key stored •••• (leave blank to keep)' : 'Paste key — stored encrypted in the OS keychain';
    } catch {
      apiInput.placeholder = 'Paste key — stored encrypted in the OS keychain';
    }
  }

  // Draft UI state only — nothing is committed to `config` until Save,
  // so Cancel discards all edits (provider included).
  let lastProvider = config.provider;
  providerSel.addEventListener('change', () => {
    const next = providerSel.value;
    const current = modelInput.value.trim();
    // Swap the model only when it is still the previous provider's default
    // (or empty) — a user-typed custom model is preserved as-is.
    if (!current || (MODEL_SUGGESTIONS[lastProvider] || []).includes(current)) {
      modelInput.value = (MODEL_SUGGESTIONS[next] || [])[0] || '';
    }
    lastProvider = next;
    // A key typed for the previous provider must never be saved under the
    // new one — clear the draft and re-hydrate the placeholder.
    apiInput.value = '';
    refreshModelSuggestions(next);
    hydrateKeyPlaceholder(next);
  });

  // Show the danger warning only while bypass is selected in the draft.
  function refreshApprovalWarning() {
    approvalWarning.hidden = approvalModeSel.value !== 'bypass';
  }
  approvalModeSel.addEventListener('change', refreshApprovalWarning);

  maxTokensInput.addEventListener('input', () => { maxTokensValue.textContent = maxTokensInput.value; });
  tempInput.addEventListener('input', () => { tempValue.textContent = Number(tempInput.value).toFixed(2); });

  btnCancel.addEventListener('click', close);

  testBtn.addEventListener('click', async () => {
    const provider = providerSel.value;
    let apiKey = apiInput.value.trim();
    if (!apiKey) {
      try { apiKey = await window.ostro.keychain.getApiKey(provider); } catch { /* ignore */ }
    }
    if (!apiKey) {
      testResultEl.textContent = '⚠ No API key set for this provider';
      testResultEl.className = 'settings-test-result err';
      return;
    }
    testBtn.disabled = true;
    testResultEl.textContent = 'Testing…';
    testResultEl.className = 'settings-test-result';
    try {
      const { models } = await window.ostro.ai.testConnection({
        provider,
        apiKey,
        baseUrl: baseUrlInput.value.trim(),
      });
      const available = Array.isArray(models) ? models : [];
      const shown = available.slice(0, 4).join(', ');
      testResultEl.textContent = `✓ Connected — ${available.length} models${shown ? ` (e.g. ${shown})` : ''}`;
      testResultEl.className = 'settings-test-result ok';
    } catch (err) {
      testResultEl.textContent = `⚠ ${err.message}`;
      testResultEl.className = 'settings-test-result err';
    } finally {
      testBtn.disabled = false;
    }
  });

  btnSave.addEventListener('click', async () => {
    const provider = providerSel.value;
    const model = modelInput.value.trim();
    if (!model) {
      testResultEl.textContent = '⚠ Model is required';
      testResultEl.className = 'settings-test-result err';
      modelInput.focus();
      return;
    }
    const key = apiInput.value.trim();
    if (key) {
      try {
        await window.ostro.keychain.setApiKey(provider, key);
      } catch (err) {
        testResultEl.textContent = `⚠ Could not store key: ${err.message}`;
        testResultEl.className = 'settings-test-result err';
        return;
      }
    }

    config = {
      provider,
      model,
      baseUrl: baseUrlInput.value.trim(),
      thinking: thinkingSel.value,
      maxTokens: Number(maxTokensInput.value),
      temperature: Number(tempInput.value),
      systemPrompt: systemPromptInput.value.trim(),
      enableTools: enableToolsInput.checked,
      approvalMode: approvalModeSel.value,
    };
    saveConfig(config);
    apiInput.value = '';
    onSaved(config);
    close();
  });

  // ---- Extensions list ----
  function renderExtensions(state) {
    if (!extListEl || !state) return;
    const list = state.list || [];
    if (state.root && extRootHint) extRootHint.textContent = `Loading from ${state.root}`;
    if (list.length === 0) {
      extListEl.innerHTML = '<div class="ext-empty">No extensions installed. Drop a folder containing index.js and package.json into the extensions directory, then reload.</div>';
      return;
    }
    extListEl.innerHTML = '';
    for (const ext of list) {
      const row = document.createElement('div');
      row.className = 'ext-row' + (ext.ok ? '' : ' ext-row-failed');
      const dot = ext.ok ? '🟢' : '🔴';
      row.innerHTML = `<span class="ext-dot">${dot}</span>
        <span class="ext-meta"><span class="ext-name"></span><span class="ext-desc"></span></span>`;
      row.querySelector('.ext-name').textContent = `${ext.name} v${ext.version}`;
      row.querySelector('.ext-desc').textContent = ext.ok ? (ext.description || '') : `Failed: ${ext.error || 'unknown error'}`;
      extListEl.appendChild(row);
    }
  }

  async function loadExtensions() {
    try {
      const state = await window.ostro.extensions.list();
      renderExtensions(state);
      return state;
    } catch {
      return null;
    }
  }

  if (extReloadBtn) {
    extReloadBtn.addEventListener('click', async () => {
      extReloadBtn.disabled = true;
      extReloadResult.textContent = 'Reloading…';
      extReloadResult.className = 'settings-test-result';
      try {
        const state = await window.ostro.extensions.activate();
        renderExtensions(state);
        const ok = (state.list || []).filter((e) => e.ok).length;
        const failed = (state.list || []).length - ok;
        extReloadResult.textContent = `✓ ${ok} active${failed ? `, ${failed} failed` : ''}`;
        extReloadResult.className = 'settings-test-result ok';
      } catch (err) {
        extReloadResult.textContent = `⚠ ${err.message}`;
        extReloadResult.className = 'settings-test-result err';
      } finally {
        extReloadBtn.disabled = false;
      }
    });
  }

  async function hydrate() {
    apply();
    onSaved(config);
    await loadExtensions();
  }

  function getConfig() {
    return { ...config, thinkingBudget: THINKING_BUDGETS[config.thinking] || 0 };
  }

  return { open, close, hydrate, getConfig };
}
