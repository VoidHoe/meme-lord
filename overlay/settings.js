const fields      = ['serverUrl', 'discordUsername', 'duration', 'volumeSfx', 'volumeVoice', 'giphyApiKey', 'micDeviceId'];
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

async function populateMicDevices() {
  const sel = document.getElementById('micDeviceId');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch(e) {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const saved   = sel.value;
  sel.innerHTML = '<option value="">Microphone par défaut</option>';
  devices.filter(d => d.kind === 'audioinput').forEach(d => {
    const opt = document.createElement('option');
    opt.value       = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`;
    sel.appendChild(opt);
  });
  if (saved) sel.value = saved;
}
populateMicDevices();

const updateStatus = document.getElementById('updateStatus');

// Live update status from main process
window.memedrop.onUpdateStatus((msg) => {
  updateStatus.textContent = msg;
});

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
