const ELEVENLABS_KEY = 'sk_699bb98a4c9010efa533de7a75548061a55ce29ae16ecc4c';
const fields      = ['serverUrl', 'discordUsername', 'duration', 'volumeSfx', 'volumeVoice', 'elevenLabsVoiceId'];
const rangeFields = ['duration', 'volumeSfx', 'volumeVoice'];

window.memedrop.getSettings().then(settings => {
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    el.value = key === 'duration'
      ? Math.round((settings[key] || 5000) / 1000)
      : (settings[key] ?? el.value);
  });
  const thEl = document.getElementById('tryhardMode');
  if (thEl) thEl.checked = !!settings.tryhardMode;
  updateRangeDisplays();
  loadElevenLabsVoices(settings.elevenLabsVoiceId || '');
});

rangeFields.forEach(key => {
  const input   = document.getElementById(key);
  const display = document.getElementById(`${key}Val`);
  if (input && display) input.addEventListener('input', () => { display.textContent = input.value; });
});

function updateRangeDisplays() {
  rangeFields.forEach(key => {
    const input   = document.getElementById(key);
    const display = document.getElementById(`${key}Val`);
    if (input && display) display.textContent = input.value;
  });
}


const updateStatus = document.getElementById('updateStatus');

// Live update status from main process
window.memedrop.onUpdateStatus((msg) => {
  updateStatus.textContent = msg;
});

async function loadElevenLabsVoices(savedId) {
  const hint = document.getElementById('elVoiceHint');
  const sel  = document.getElementById('elevenLabsVoiceId');
  try {
    const res  = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ELEVENLABS_KEY } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data = await res.json();
    sel.innerHTML = '<option value="">— choisir une voix —</option>';
    (data.voices || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voice_id; opt.textContent = v.name;
      sel.appendChild(opt);
    });
    if (savedId) sel.value = savedId;
    hint.textContent = `${data.voices?.length || 0} voix disponibles`; hint.style.color = '#555';
  } catch (e) {
    hint.textContent = '❌ ' + e.message; hint.style.color = '#f87171';
    sel.innerHTML = '<option value="">— erreur de chargement —</option>';
  }
}

document.getElementById('updateBtn').addEventListener('click', async () => {
  updateStatus.textContent = '⏳ Checking…';
  const result = await window.memedrop.checkForUpdates();
  if (result.status === 'dev') {
    updateStatus.textContent = '⚠️ Only works in the installed version (not dev mode).';
  }
  // Otherwise, autoUpdater events will update the status live
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const newSettings = {};
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = el.type === 'range' ? Number(el.value) : el.value;
    newSettings[key] = key === 'duration' ? val * 1000 : val;
  });
  const thEl = document.getElementById('tryhardMode');
  if (thEl) newSettings.tryhardMode = thEl.checked;
  await window.memedrop.saveSettings(newSettings);
  const status = document.getElementById('status');
  status.textContent = '✅ Sauvegardé !';
  setTimeout(() => { status.textContent = ''; }, 2000);
});
