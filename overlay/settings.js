const fields      = ['serverUrl', 'discordUsername', 'positionX', 'positionY', 'duration', 'volumeSfx', 'volumeVoice'];
const rangeFields = ['positionX', 'positionY', 'duration', 'volumeSfx', 'volumeVoice'];

window.memedrop.getSettings().then(settings => {
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    el.value = key === 'duration'
      ? Math.round((settings[key] || 5000) / 1000)
      : (settings[key] ?? el.value);
  });
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
  await window.memedrop.saveSettings(newSettings);
  const status = document.getElementById('status');
  status.textContent = '✅ Sauvegardé !';
  setTimeout(() => { status.textContent = ''; }, 2000);
});
