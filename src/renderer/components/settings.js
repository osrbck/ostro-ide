const STORAGE_KEY = 'ostro.config';

const DEFAULTS = {
  model: 'claude-sonnet-4-6',
  thinking: 'off',
  maxTokens: 4096,
  temperature: 1,
  systemPrompt: '',
  enableTools: true,
};

const THINKING_BUDGETS = { off: 0, low: 2000, medium: 8000, high: 16000 };

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
  const apiInput = document.getElementById('input-api-key');
  const modelSel = document.getElementById('select-model');
  const thinkingSel = document.getElementById('select-thinking');
  const maxTokensInput = document.getElementById('input-max-tokens');
  const maxTokensValue = document.getElementById('max-tokens-value');
  const tempInput = document.getElementById('input-temperature');
  const tempValue = document.getElementById('temp-value');
  const systemPromptInput = document.getElementById('input-system-prompt');
  const enableToolsInput = document.getElementById('input-enable-tools');
  const btnSave = document.getElementById('btn-settings-save');
  const btnCancel = document.getElementById('btn-settings-cancel');

  let config = loadConfig();

  function open() { modal.classList.remove('hidden'); apply(); }
  function close() { modal.classList.add('hidden'); }

  function apply() {
    modelSel.value = config.model;
    thinkingSel.value = config.thinking;
    maxTokensInput.value = config.maxTokens;
    maxTokensValue.textContent = config.maxTokens;
    tempInput.value = config.temperature;
    tempValue.textContent = Number(config.temperature).toFixed(2);
    systemPromptInput.value = config.systemPrompt || '';
    enableToolsInput.checked = config.enableTools !== false;
  }

  maxTokensInput.addEventListener('input', () => { maxTokensValue.textContent = maxTokensInput.value; });
  tempInput.addEventListener('input', () => { tempValue.textContent = Number(tempInput.value).toFixed(2); });

  btnCancel.addEventListener('click', close);

  btnSave.addEventListener('click', async () => {
    const key = apiInput.value.trim();
    if (key) await window.ostro.keychain.setApiKey('anthropic', key);

    config = {
      model: modelSel.value,
      thinking: thinkingSel.value,
      maxTokens: Number(maxTokensInput.value),
      temperature: Number(tempInput.value),
      systemPrompt: systemPromptInput.value.trim(),
      enableTools: enableToolsInput.checked,
    };
    saveConfig(config);
    apiInput.value = '';
    onSaved(config);
    close();
  });

  async function hydrate() {
    apply();
    const existing = await window.ostro.keychain.getApiKey('anthropic');
    if (existing) apiInput.placeholder = '•••• key stored ••••';
    onSaved(config);
  }

  function getConfig() { return { ...config, thinkingBudget: THINKING_BUDGETS[config.thinking] || 0 }; }

  return { open, close, hydrate, getConfig };
}
