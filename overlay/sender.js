const activeEffects = new Set();
let mediaUrl = null;
let mediaPreviewUrl = null;
let mediaIsVideo = false;
let stagePreviewVideo = null;
let trimScrubbable = false;
let videoDuration = 0;
let trimStart = 0;
let trimEnd = 0;
let trimRepeat = 1;
let trimDragging = null;
let previewStop = null;
let selectedAnchor = 'center';
let selectedSize = 'm';
let selectedCaptionStyle = 'overlay';
let libraryCache = [];
let librarySearch = '';

const ANCHOR_MAP = {
  'top-left': { positionX: 15, positionY: 15 },
  top: { positionX: 50, positionY: 15 },
  'top-right': { positionX: 85, positionY: 15 },
  left: { positionX: 15, positionY: 50 },
  center: { positionX: 50, positionY: 50 },
  right: { positionX: 85, positionY: 50 },
  'bottom-left': { positionX: 15, positionY: 85 },
  bottom: { positionX: 50, positionY: 85 },
  'bottom-right': { positionX: 85, positionY: 85 },
};

const $ = (id) => document.getElementById(id);
const composePanel = $('compose-panel');
const dropZone = $('drop-zone');
const stageMedia = $('stage-media');
const stagePrompt = $('stage-prompt');
const urlText = $('url-text');
const clearUrlBtn = $('clear-url');
const urlPaste = $('url-paste');
const targetSel = $('target');
const refreshBtn = $('refresh-btn');
const capInput = $('caption');
const capBottomInput = $('caption-bottom');
const previewTop = $('preview-top');
const previewBottom = $('preview-bottom');
const sendBtn = $('send-btn');
const statusEl = $('status');
const trimRow = $('trim-row');
const trimEmpty = $('trim-empty');
const trimEditor = $('trim-editor');
const trimVideo = $('trim-video');
const trimTrack = $('trim-track');
const trimRange = $('trim-range');
const trimHStart = $('trim-h-start');
const trimHEnd = $('trim-h-end');
const trimPlayhead = $('trim-playhead');
const trimReadout = $('trim-readout');
const trimRepVal = $('trim-rep-val');
const trimPreviewBtn = $('trim-preview-btn');
const historyList = $('history-list');
const historyEmpty = $('history-empty');
const libraryGrid = $('library-grid');
const libraryEmpty = $('library-empty');
const saveClipBtn = $('save-clip-btn');
const fadeInEnabled = $('fade-in-enabled');
const fadeOutEnabled = $('fade-out-enabled');
const fadeInDuration = $('fade-in-duration');
const fadeOutDuration = $('fade-out-duration');
const chaseEnabled = $('chase-enabled');
const chaseBtn = $('chase-btn');
const chaseModeBtns = [...document.querySelectorAll('[data-chase-mode]')];
const chaseDuration = $('chase-duration');
const chaseHotkey = $('chase-hotkey');
const chaseMusic = $('chase-music');
const chaseMusicStart = $('chase-music-start');
const chaseImport = $('chase-import');
const chaseCheckpoint = $('chase-checkpoint');
const chaseSfxImport = $('chase-sfx-import');
const chaseSfxStatus = $('chase-sfx-status');
const chaseStatus = $('chase-status');
const facecamEnabled = $('facecam-enabled');
const facecamHotkey = $('facecam-hotkey');
const facecamFps = $('facecam-fps');
const facecamWidth = $('facecam-width');
const facecamBtn = $('facecam-btn');
const facecamStatus = $('facecam-status');
const facecamPlacementPad = $('facecam-placement-pad');
const facecamPlacementBox = $('facecam-placement-box');
const facecamPosX = $('facecam-pos-x');
const facecamPosY = $('facecam-pos-y');
let facecamPlacement = { x: 78, y: 8 };

const PANELS = {
  compose: 'compose-panel',
  library: 'library-panel',
  history: 'history-panel',
  chase: 'chase-panel',
  facecam: 'facecam-panel',
  settings: 'settings-panel',
};

function showTab(name) {
  if (!PANELS[name]) name = 'compose';
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  Object.entries(PANELS).forEach(([key, id]) => $(id).classList.toggle('active', key === name));
  if (name === 'library') renderLibrary();
  if (name === 'history') loadHistory();
  if (name === 'chase') window.sender.getSettings().then(loadChaseSettings);
  if (name === 'facecam') window.sender.getSettings().then(loadFacecamSettings);
  if (name === 'settings') loadSettingsForm();
}

function isPanelActive(name) {
  return !!PANELS[name] && $(PANELS[name]).classList.contains('active');
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
if (window.sender.onShowTab) window.sender.onShowTab((tab) => showTab(tab));

$('close-btn').addEventListener('click', () => window.sender.close());
$('min-btn').addEventListener('click', () => window.sender.minimize());
$('snip-btn').addEventListener('click', async () => {
  setStatus('Opening screen snip…');
  try { await window.sender.openSnipTool(); } catch (error) { setStatus(error.message, 'err'); }
});

if (window.sender.onSnipResult) {
  window.sender.onSnipResult((result) => {
    showTab('compose');
    if (result?.url) {
      setMediaUrl(result.url, 'Screen snip', false);
      setStatus('Snip ready — add the punchline', 'ok');
    } else {
      setStatus(`Snip failed: ${result?.error || 'unknown error'}`, 'err');
    }
  });
}

window.sender.getSettings().then((settings) => {
  setAnchor(settings.anchorPosition || 'center', false);
  setSize(settings.dropSize || 'm', false);
  loadChaseSettings(settings);
  loadFacecamSettings(settings);
});
loadUsers();

async function loadUsers() {
  refreshBtn.classList.add('spinning');
  const connection = document.querySelector('.connection');
  try {
    const result = await window.sender.getUsers();
    if (result.error) throw new Error(result.error);
    while (targetSel.options.length > 1) targetSel.remove(1);
    const users = [...new Set(result.users || [])];
    users.forEach((username) => {
      const option = document.createElement('option');
      option.value = username;
      option.textContent = `@${username}`;
      targetSel.appendChild(option);
    });
    connection.classList.add('online');
    $('connection-state').textContent = 'Connected';
    $('friend-count').textContent = `${users.length} ${users.length === 1 ? 'friend' : 'friends'} online`;
  } catch {
    connection.classList.remove('online');
    $('connection-state').textContent = 'Offline';
    $('friend-count').textContent = 'Could not reach server';
  } finally {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 350);
  }
}
refreshBtn.addEventListener('click', loadUsers);

let chaseHoldId = null;
let chaseTriggerMode = 'hold';
let chaseToggleId = null;
let chaseToggleAutoTimer = null;

chaseBtn.addEventListener('pointerdown', handleChaseButtonDown);
chaseBtn.addEventListener('pointerup', stopChaseHold);
chaseBtn.addEventListener('pointercancel', stopChaseHold);
chaseBtn.addEventListener('pointerleave', (event) => {
  if (chaseTriggerMode === 'hold' && event.buttons === 1) stopChaseHold(event);
});
chaseImport.addEventListener('click', importChaseAudio);
chaseSfxImport.addEventListener('click', importChaseSfxFolder);
[chaseEnabled, chaseDuration, chaseHotkey, chaseMusic, chaseMusicStart, chaseCheckpoint].forEach((input) => {
  input.addEventListener('change', saveChaseSettings);
  input.addEventListener('blur', saveChaseSettings);
});
chaseModeBtns.forEach((button) => {
  button.addEventListener('click', () => {
    setChaseTriggerMode(button.dataset.chaseMode || 'hold');
    saveChaseSettings();
  });
});

function loadChaseSettings(settings) {
  chaseEnabled.checked = !!settings.chaseEnabled;
  setChaseTriggerMode(settings.chaseTriggerMode || 'hold', false);
  chaseDuration.value = settings.chaseDuration ?? 60;
  chaseHotkey.value = settings.chaseHotkey ?? '6';
  chaseMusic.value = settings.chaseMusicUrl || 'https://youtu.be/N_og7Lok8j8';
  chaseMusicStart.value = settings.chaseMusicStart ?? 10;
  chaseCheckpoint.value = settings.chaseCheckpointSeconds ?? 30;
  chaseSfxStatus.textContent = settings.chaseSfxDir ? `SFX: ${settings.chaseSfxDir}` : 'No SFX folder';
  syncChaseEnabledState();
}

let chaseSaveTimer = null;
function saveChaseSettings() {
  if (chaseSaveTimer) clearTimeout(chaseSaveTimer);
  chaseSaveTimer = setTimeout(() => {
    window.sender.saveSettings({
      chaseEnabled: chaseEnabled.checked,
      chaseTriggerMode,
      chaseDuration: chaseSeconds(),
      chaseHotkey: chaseHotkey.value.trim(),
      chaseMusicUrl: chaseMusic.value.trim(),
      chaseMusicStart: chaseMusicStartSeconds(),
      chaseCheckpointSeconds: chaseCheckpointSeconds(),
    }).then(() => {
      syncChaseEnabledState();
      setChaseStatus(chaseEnabled.checked ? 'Chase mode enabled' : 'Chase mode disabled', chaseEnabled.checked ? 'ok' : '');
    });
  }, 150);
}

function syncChaseEnabledState() {
  chaseBtn.disabled = !chaseEnabled.checked;
  $('chase-panel').classList.toggle('chase-off', !chaseEnabled.checked);
  chaseBtn.textContent = chaseTriggerMode === 'toggle'
    ? (chaseToggleId ? 'Stop chase' : 'Toggle chase')
    : 'Hold chase';
}

function setChaseTriggerMode(mode, updateStatus = true) {
  chaseTriggerMode = mode === 'toggle' ? 'toggle' : 'hold';
  chaseModeBtns.forEach((button) => {
    button.classList.toggle('active', button.dataset.chaseMode === chaseTriggerMode);
  });
  syncChaseEnabledState();
  if (updateStatus) setChaseStatus(`Chase trigger: ${chaseTriggerMode}`, 'ok');
}

async function importChaseAudio() {
  try {
    const result = await window.sender.chooseChaseAudio();
    if (result?.url) {
      chaseMusic.value = result.url;
      chaseMusicStart.value = 0;
      saveChaseSettings();
      setChaseStatus('Chase audio imported', 'ok');
    }
  } catch (error) {
    setChaseStatus(`Could not import audio: ${error.message}`, 'err');
  }
}

async function importChaseSfxFolder() {
  try {
    const result = await window.sender.chooseChaseSfxFolder();
    if (result?.dir) {
      const count = (result.sfx?.checkpoints?.length || 0) + (result.sfx?.start ? 1 : 0);
      chaseSfxStatus.textContent = `SFX: ${result.dir} (${count} files)`;
      await window.sender.saveSettings({ chaseSfxDir: result.dir });
      setChaseStatus(count ? 'Chase SFX folder imported' : 'No audio files found in that folder', count ? 'ok' : 'err');
    }
  } catch (error) {
    setChaseStatus(`Could not import SFX: ${error.message}`, 'err');
  }
}

function chaseSeconds() {
  const value = Number(chaseDuration.value);
  return Math.min(180, Math.max(5, Number.isFinite(value) ? value : 60));
}

function chaseMusicStartSeconds() {
  const value = Number(chaseMusicStart.value);
  return Math.min(600, Math.max(0, Number.isFinite(value) ? value : 10));
}

function chaseCheckpointSeconds() {
  const value = Number(chaseCheckpoint.value);
  return Math.min(180, Math.max(5, Number.isFinite(value) ? value : 30));
}

function chasePayload(command, id) {
  const musicUrl = chaseMusic.value.trim();
  return {
    target: targetSel.value || null,
    action: {
      type: 'chase-control',
      command,
      id,
      durationSeconds: chaseSeconds(),
      label: 'CHASE',
      sound: 'hype',
      music: musicUrl ? { url: musicUrl, startSeconds: chaseMusicStartSeconds() } : null,
      checkpointSeconds: chaseCheckpointSeconds(),
    },
  };
}

async function sendChaseAction(payload) {
  const result = await window.sender.previewDrop(payload);
  if (!result.ok) throw new Error(result.error || 'overlay unavailable');
  return result;
}

async function startChaseHold(event) {
  if (!chaseEnabled.checked) return;
  if (chaseHoldId) return;
  event.preventDefault();
  chaseHoldId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try { chaseBtn.setPointerCapture(event.pointerId); } catch {}
  chaseBtn.classList.add('holding');
  setChaseStatus('Holding chase timer...');
  const payload = chasePayload('start', chaseHoldId);
  saveChaseSettings();
  try {
    const result = await sendChaseAction(payload);
    setChaseStatus(result.local ? 'Local chase preview' : 'Chase timer live!', 'ok');
    window.sender.saveHistory({
      ...payload,
      id: Date.now(),
      timestamp: Date.now(),
      caption: 'Held chase timer',
    });
  } catch (error) {
    setChaseStatus(`Could not start timer: ${error.message}`, 'err');
  }
}

async function stopChaseHold(event) {
  if (chaseTriggerMode !== 'hold') return;
  if (!chaseHoldId) return;
  event.preventDefault();
  const id = chaseHoldId;
  chaseHoldId = null;
  chaseBtn.classList.remove('holding');
  try { chaseBtn.releasePointerCapture(event.pointerId); } catch {}
  try {
    await sendChaseAction(chasePayload('stop', id));
    setChaseStatus('Chase stopped', 'ok');
  } catch (error) {
    setChaseStatus(`Could not stop timer: ${error.message}`, 'err');
  }
}

async function handleChaseButtonDown(event) {
  if (chaseTriggerMode === 'toggle') {
    await toggleChase(event);
    return;
  }
  await startChaseHold(event);
}

async function toggleChase(event) {
  if (!chaseEnabled.checked) return;
  event.preventDefault();
  if (chaseToggleId) {
    const id = chaseToggleId;
    chaseToggleId = null;
    if (chaseToggleAutoTimer) clearTimeout(chaseToggleAutoTimer);
    chaseToggleAutoTimer = null;
    chaseBtn.classList.remove('holding');
    syncChaseEnabledState();
    try {
      await sendChaseAction(chasePayload('stop', id));
      setChaseStatus('Chase stopped', 'ok');
    } catch (error) {
      setChaseStatus(`Could not stop timer: ${error.message}`, 'err');
    }
    return;
  }
  chaseToggleId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  chaseBtn.classList.add('holding');
  syncChaseEnabledState();
  setChaseStatus('Chase toggled on...');
  const payload = chasePayload('start', chaseToggleId);
  saveChaseSettings();
  try {
    const result = await sendChaseAction(payload);
    setChaseStatus(result.local ? 'Local chase preview' : 'Chase timer live!', 'ok');
    if (chaseToggleAutoTimer) clearTimeout(chaseToggleAutoTimer);
    chaseToggleAutoTimer = setTimeout(() => {
      if (chaseToggleId === payload.action.id) {
        chaseToggleId = null;
        chaseToggleAutoTimer = null;
        chaseBtn.classList.remove('holding');
        syncChaseEnabledState();
        setChaseStatus('Chase completed', 'ok');
      }
    }, chaseSeconds() * 1000 + 1000);
    window.sender.saveHistory({
      ...payload,
      id: Date.now(),
      timestamp: Date.now(),
      caption: 'Toggled chase timer',
    });
  } catch (error) {
    chaseToggleId = null;
    if (chaseToggleAutoTimer) clearTimeout(chaseToggleAutoTimer);
    chaseToggleAutoTimer = null;
    chaseBtn.classList.remove('holding');
    syncChaseEnabledState();
    setChaseStatus(`Could not start timer: ${error.message}`, 'err');
  }
}

function setChaseStatus(message, type = '') {
  chaseStatus.textContent = message;
  chaseStatus.className = type;
}

let facecamHolding = false;

facecamBtn.addEventListener('pointerdown', startFacecamHold);
facecamBtn.addEventListener('pointerup', stopFacecamHold);
facecamBtn.addEventListener('pointercancel', stopFacecamHold);
facecamBtn.addEventListener('pointerleave', (event) => {
  if (event.buttons === 1) stopFacecamHold(event);
});
[facecamEnabled, facecamHotkey, facecamFps, facecamWidth].forEach((input) => {
  input.addEventListener('change', saveFacecamSettings);
  input.addEventListener('blur', saveFacecamSettings);
});
facecamPlacementBox.addEventListener('pointerdown', startFacecamPlacementDrag);
if (window.sender.onFacecamStatus) {
  window.sender.onFacecamStatus((status) => {
    if (status?.error) setFacecamStatus(`Camera error: ${status.error}`, 'err');
    else if (status?.ok) setFacecamStatus('Camera live', 'ok');
  });
}

function loadFacecamSettings(settings) {
  facecamEnabled.checked = !!settings.facecamEnabled;
  facecamHotkey.value = settings.facecamHotkey ?? '5';
  facecamFps.value = settings.facecamFps ?? 8;
  facecamWidth.value = settings.facecamWidth ?? 260;
  facecamPlacement = {
    x: Math.min(100, Math.max(0, Number(settings.facecamPositionX) || 78)),
    y: Math.min(100, Math.max(0, Number(settings.facecamPositionY) || 8)),
  };
  renderFacecamPlacement();
  syncFacecamEnabledState();
}

let facecamSaveTimer = null;
function saveFacecamSettings() {
  if (facecamSaveTimer) clearTimeout(facecamSaveTimer);
  facecamSaveTimer = setTimeout(() => {
    window.sender.saveSettings({
      facecamEnabled: facecamEnabled.checked,
      facecamHotkey: facecamHotkey.value.trim(),
      facecamFps: Math.min(15, Math.max(2, Number(facecamFps.value) || 8)),
      facecamWidth: Math.min(520, Math.max(120, Number(facecamWidth.value) || 260)),
      facecamPositionX: +facecamPlacement.x.toFixed(1),
      facecamPositionY: +facecamPlacement.y.toFixed(1),
    }).then(() => {
      syncFacecamEnabledState();
      setFacecamStatus(facecamEnabled.checked ? 'Facecam mode enabled' : 'Facecam mode disabled', facecamEnabled.checked ? 'ok' : '');
    });
  }, 150);
}

function renderFacecamPlacement() {
  facecamPlacementBox.style.left = `calc(${facecamPlacement.x}% - ${facecamPlacement.x * 0.82}px)`;
  facecamPlacementBox.style.top = `calc(${facecamPlacement.y}% - ${facecamPlacement.y * 0.62}px)`;
  facecamPosX.textContent = facecamPlacement.x.toFixed(1);
  facecamPosY.textContent = facecamPlacement.y.toFixed(1);
}

function startFacecamPlacementDrag(event) {
  event.preventDefault();
  facecamPlacementBox.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const pad = facecamPlacementPad.getBoundingClientRect();
    const box = facecamPlacementBox.getBoundingClientRect();
    const maxX = Math.max(1, pad.width - box.width);
    const maxY = Math.max(1, pad.height - box.height);
    const x = Math.min(maxX, Math.max(0, moveEvent.clientX - pad.left - box.width / 2));
    const y = Math.min(maxY, Math.max(0, moveEvent.clientY - pad.top - box.height / 2));
    facecamPlacement.x = (x / maxX) * 100;
    facecamPlacement.y = (y / maxY) * 100;
    renderFacecamPlacement();
  };
  const up = () => {
    facecamPlacementBox.removeEventListener('pointermove', move);
    saveFacecamSettings();
  };
  facecamPlacementBox.addEventListener('pointermove', move);
  facecamPlacementBox.addEventListener('pointerup', up, { once: true });
  facecamPlacementBox.addEventListener('pointercancel', up, { once: true });
  move(event);
}

function syncFacecamEnabledState() {
  facecamBtn.disabled = !facecamEnabled.checked;
  $('facecam-panel').classList.toggle('facecam-off', !facecamEnabled.checked);
}

async function startFacecamHold(event) {
  if (!facecamEnabled.checked || facecamHolding) return;
  event.preventDefault();
  facecamHolding = true;
  try { facecamBtn.setPointerCapture(event.pointerId); } catch {}
  facecamBtn.classList.add('holding');
  saveFacecamSettings();
  setFacecamStatus('Starting camera...');
  try {
    await window.sender.previewFacecamStart();
  } catch (error) {
    setFacecamStatus(`Could not start camera: ${error.message}`, 'err');
  }
}

async function stopFacecamHold(event) {
  if (!facecamHolding) return;
  event.preventDefault();
  facecamHolding = false;
  facecamBtn.classList.remove('holding');
  try { facecamBtn.releasePointerCapture(event.pointerId); } catch {}
  try {
    await window.sender.previewFacecamStop();
    setFacecamStatus('Facecam stopped', 'ok');
  } catch (error) {
    setFacecamStatus(`Could not stop camera: ${error.message}`, 'err');
  }
}

function setFacecamStatus(message, type = '') {
  facecamStatus.textContent = message;
  facecamStatus.className = type;
}

document.querySelectorAll('.anchor-btn').forEach((button) => button.addEventListener('click', () => setAnchor(button.dataset.anchor, true)));
function setAnchor(anchor, persist) {
  selectedAnchor = ANCHOR_MAP[anchor] ? anchor : 'center';
  document.querySelectorAll('.anchor-btn').forEach((button) => button.classList.toggle('active', button.dataset.anchor === selectedAnchor));
  if (persist) {
    const position = ANCHOR_MAP[selectedAnchor];
    window.sender.saveSettings({ anchorPosition: selectedAnchor, ...position });
  }
}

document.querySelectorAll('.size-chip').forEach((button) => button.addEventListener('click', () => setSize(button.dataset.size, true)));
function setSize(size, persist) {
  selectedSize = ['s', 'm', 'l', 'xl'].includes(size) ? size : 'm';
  document.querySelectorAll('.size-chip').forEach((button) => button.classList.toggle('active', button.dataset.size === selectedSize));
  if (persist) window.sender.saveSettings({ dropSize: selectedSize });
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const effect = chip.dataset.fx;
    if (activeEffects.has(effect)) activeEffects.delete(effect);
    else activeEffects.add(effect);
    chip.classList.toggle('active', activeEffects.has(effect));
  });
});

function bindFadeToggle(toggle, input) {
  toggle.addEventListener('change', () => { input.disabled = !toggle.checked; });
}
bindFadeToggle(fadeInEnabled, fadeInDuration);
bindFadeToggle(fadeOutEnabled, fadeOutDuration);

function fadeValue(toggle, input) {
  if (!toggle.checked) return null;
  const value = Number(input.value);
  return Math.min(5, Math.max(0.1, Number.isFinite(value) ? value : 0.8));
}

function updatePreviewCaptions() {
  const top = capInput.value.trim();
  const bottom = capBottomInput.value.trim();
  dropZone.classList.toggle('caption-card', selectedCaptionStyle === 'card');
  if (selectedCaptionStyle === 'card') {
    const card = stageMedia.querySelector('.stage-card-caption');
    if (card) card.textContent = [top, bottom].filter(Boolean).join(' ');
    previewTop.textContent = '';
    previewBottom.textContent = '';
    return;
  }
  previewTop.textContent = top;
  previewBottom.textContent = bottom;
}
capInput.addEventListener('input', updatePreviewCaptions);
capBottomInput.addEventListener('input', updatePreviewCaptions);

document.querySelectorAll('.style-chip').forEach((button) => button.addEventListener('click', () => {
  selectedCaptionStyle = button.dataset.captionStyle === 'card' ? 'card' : 'overlay';
  document.querySelectorAll('.style-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  if (mediaUrl) renderStagePreview(mediaPreviewUrl || mediaUrl, urlText.textContent, mediaIsVideo);
  updatePreviewCaptions();
}));

function formatClock(seconds) {
  const value = Math.max(0, seconds || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

function setTrimEnabled(scrubbable, url) {
  stopPreview();
  trimScrubbable = !!scrubbable;
  videoDuration = 0;
  trimStart = 0;
  trimEnd = 0;
  setRepeat(1);
  trimRow.classList.toggle('disabled', !trimScrubbable);
  trimEmpty.style.display = trimScrubbable ? 'none' : '';
  trimEditor.style.display = trimScrubbable ? '' : 'none';
  trimVideo.removeAttribute('src');
  trimVideo.load();
  syncStagePreviewSegment();
  if (!trimScrubbable || !url) return;
  trimVideo.src = url;
  trimVideo.onloadedmetadata = () => {
    videoDuration = Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0;
    trimEnd = videoDuration;
    renderTrim();
  };
  trimVideo.onerror = () => setTrimEnabled(false, null);
}

function renderTrim() {
  const startPct = videoDuration ? (trimStart / videoDuration) * 100 : 0;
  const endPct = videoDuration ? (trimEnd / videoDuration) * 100 : 100;
  trimHStart.style.left = `${startPct}%`;
  trimHEnd.style.left = `${endPct}%`;
  trimRange.style.left = `${startPct}%`;
  trimRange.style.width = `${Math.max(0, endPct - startPct)}%`;
  trimReadout.textContent = `${formatClock(trimStart)} → ${formatClock(trimEnd)} · ${(trimEnd - trimStart).toFixed(1)}s`;
  syncStagePreviewSegment();
}

function syncStagePreviewSegment() {
  if (!stagePreviewVideo) return;
  const hasSegment = trimScrubbable && videoDuration > 0 && trimEnd > trimStart;
  stagePreviewVideo.loop = !hasSegment;
  if (!hasSegment) {
    stagePreviewVideo.ontimeupdate = null;
    return;
  }
  stagePreviewVideo.ontimeupdate = () => {
    if (stagePreviewVideo.currentTime >= trimEnd || stagePreviewVideo.currentTime < trimStart - 0.25) {
      try { stagePreviewVideo.currentTime = trimStart; } catch {}
      stagePreviewVideo.play().catch(() => {});
    }
  };
  if (stagePreviewVideo.currentTime < trimStart || stagePreviewVideo.currentTime >= trimEnd) {
    try { stagePreviewVideo.currentTime = trimStart; } catch {}
  }
}

function trackToTime(clientX) {
  const bounds = trimTrack.getBoundingClientRect();
  return Math.min(videoDuration, Math.max(0, ((clientX - bounds.left) / bounds.width) * videoDuration));
}
function startDrag(which, event) {
  if (!videoDuration) return;
  event.preventDefault();
  trimDragging = which;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag, { once: true });
}
function onDragMove(event) {
  const time = trackToTime(event.clientX);
  if (trimDragging === 'start') trimStart = Math.min(time, trimEnd - 0.1);
  if (trimDragging === 'end') trimEnd = Math.max(time, trimStart + 0.1);
  renderTrim();
}
function endDrag() {
  trimDragging = null;
  window.removeEventListener('pointermove', onDragMove);
}
trimHStart.addEventListener('pointerdown', (event) => startDrag('start', event));
trimHEnd.addEventListener('pointerdown', (event) => startDrag('end', event));

function stopPreview() {
  if (previewStop) { previewStop(); previewStop = null; }
  try { trimVideo.pause(); } catch {}
  trimPlayhead.style.display = 'none';
  trimPreviewBtn.textContent = '▶ Preview segment';
}
function previewSegment() {
  if (!trimScrubbable || !videoDuration) return;
  if (previewStop) { stopPreview(); return; }
  trimPlayhead.style.display = 'block';
  trimVideo.currentTime = trimStart;
  trimVideo.play().catch(() => {});
  trimPreviewBtn.textContent = '■ Stop preview';
  const onTime = () => {
    trimPlayhead.style.left = `${(trimVideo.currentTime / videoDuration) * 100}%`;
    if (trimVideo.currentTime >= trimEnd) stopPreview();
  };
  previewStop = () => trimVideo.removeEventListener('timeupdate', onTime);
  trimVideo.addEventListener('timeupdate', onTime);
}
trimPreviewBtn.addEventListener('click', previewSegment);
function setRepeat(count) {
  trimRepeat = Math.min(10, Math.max(1, count));
  trimRepVal.textContent = `${trimRepeat}×`;
}
$('trim-rep-dn').addEventListener('click', () => setRepeat(trimRepeat - 1));
$('trim-rep-up').addEventListener('click', () => setRepeat(trimRepeat + 1));

let dragCounter = 0;
composePanel.addEventListener('dragenter', (event) => { event.preventDefault(); dragCounter += 1; dropZone.classList.add('drag-over'); });
composePanel.addEventListener('dragleave', () => { dragCounter -= 1; if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove('drag-over'); } });
composePanel.addEventListener('dragover', (event) => event.preventDefault());
composePanel.addEventListener('drop', async (event) => {
  event.preventDefault(); dragCounter = 0; dropZone.classList.remove('drag-over');
  const file = [...(event.dataTransfer?.files || [])][0];
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return setStatus('Only images and videos are supported', 'err');
  await uploadFile(file);
});

dropZone.addEventListener('click', (event) => {
  if (event.target.closest('button') || mediaUrl) return;
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*,video/*';
  picker.addEventListener('change', () => { if (picker.files?.[0]) uploadFile(picker.files[0]); });
  picker.click();
});

document.addEventListener('paste', async (event) => {
  if (isPanelActive('library')) {
    if (['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) return;
    const video = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('video/'));
    const text = (event.clipboardData?.getData('text') || '').trim();
    if (video) { event.preventDefault(); const file = video.getAsFile(); if (file) await saveFileToLibrary(file); }
    else if (text.startsWith('http')) { event.preventDefault(); await saveLinkToLibrary(text); }
    return;
  }
  const image = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'));
  if (!image) return;
  event.preventDefault();
  const file = image.getAsFile();
  if (file) { showTab('compose'); await uploadFile(file, 'Pasted image'); }
});

async function uploadFile(file, label) {
  setStatus('Uploading…');
  try {
    const response = await window.sender.uploadMedia(await file.arrayBuffer(), file.type || 'image/png');
    if (response.error || !response.url) throw new Error(response.error || 'Upload failed');
    const isVideo = (file.type || '').startsWith('video/');
    setMediaUrl(response.url, label || file.name || 'Uploaded media', isVideo);
    setStatus('Ready for the punchline', 'ok');
  } catch (error) {
    clearMedia();
    setStatus(`Upload failed: ${error.message}`, 'err');
  }
}

function isEmbedUrl(url) {
  return /tiktok\.com|(?:twitter\.com|x\.com)|youtube\.com|youtu\.be/.test(url || '');
}
function renderStagePreview(url, label, isVideo) {
  stagePrompt.style.display = 'none';
  stageMedia.style.display = 'flex';
  stageMedia.innerHTML = '';
  stagePreviewVideo = null;
  const appendPreview = (node) => {
    if (selectedCaptionStyle !== 'card') {
      stageMedia.appendChild(node);
      return;
    }
    const frame = document.createElement('div');
    frame.className = 'stage-card-frame';
    const card = document.createElement('div');
    card.className = 'stage-card-caption';
    card.textContent = [capInput.value.trim(), capBottomInput.value.trim()].filter(Boolean).join(' ');
    frame.append(card, node);
    stageMedia.appendChild(frame);
  };
  const fallback = (icon) => {
    const fallbackEl = document.createElement('div');
    fallbackEl.innerHTML = `<div class="embed-ic">${icon}</div><span class="embed-label">${label || ''}</span>`;
    appendPreview(fallbackEl);
  };
  if (isEmbedUrl(url)) return fallback('▶');
  if (isVideo) {
    const video = document.createElement('video');
    video.src = url; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
    video.onerror = () => fallback('▶');
    video.onloadedmetadata = syncStagePreviewSegment;
    stagePreviewVideo = video;
    appendPreview(video);
    syncStagePreviewSegment();
    video.play().catch(() => {});
  } else {
    const image = document.createElement('img');
    image.src = url; image.alt = label || 'Meme preview'; image.onerror = () => fallback('▧');
    appendPreview(image);
  }
}
function setMediaUrl(url, label, isVideo = false, options = {}) {
  mediaUrl = url;
  mediaPreviewUrl = options.previewUrl || url;
  mediaIsVideo = isVideo;
  urlPaste.value = '';
  dropZone.classList.add('has-media');
  urlText.textContent = label || url;
  clearUrlBtn.style.display = 'block';
  saveClipBtn.style.display = isVideo ? 'block' : 'none';
  renderStagePreview(mediaPreviewUrl, label, isVideo);
  const scrubbable = options.scrubbable ?? (isVideo && !isEmbedUrl(url));
  setTrimEnabled(scrubbable, scrubbable ? (options.previewUrl || url) : null);
}
function clearMedia() {
  mediaUrl = null; mediaPreviewUrl = null; mediaIsVideo = false; stagePreviewVideo = null;
  dropZone.classList.remove('has-media');
  stageMedia.style.display = 'none'; stageMedia.innerHTML = '';
  stagePrompt.style.display = '';
  urlText.textContent = 'Drop a file or paste a link';
  clearUrlBtn.style.display = 'none';
  saveClipBtn.style.display = 'none';
  setTrimEnabled(false, null);
}
clearUrlBtn.addEventListener('click', (event) => { event.stopPropagation(); clearMedia(); });

urlPaste.addEventListener('keydown', async (event) => { if (event.key === 'Enter') { event.preventDefault(); await applyPastedUrl(); } });
urlPaste.addEventListener('blur', applyPastedUrl);
async function applyPastedUrl() {
  const value = urlPaste.value.trim();
  if (!value.startsWith('http')) return;
  const isMedal = /^https?:\/\/(?:www\.)?medal\.tv\/(?:games\/[^/?#]+\/)?clips?\/[\w-]+/i.test(value);
  const socialVideo = isMedal || /tiktok\.com\/@[\w.]+\/video\/\d+/.test(value) || /(?:twitter\.com|x\.com)\/\w+\/status\/\d+/.test(value);
  if (socialVideo) {
    setStatus('Resolving video…');
    try {
      const result = await window.sender.resolveLink(value);
      if (result?.error) throw new Error(result.error);
      if (result?.type === 'video' && result.url) {
        setMediaUrl(value, isMedal ? 'Medal clip' : 'Social video', true, { scrubbable: true, previewUrl: result.url });
        return setStatus('Ready to trim', 'ok');
      }
    } catch (error) {
      if (isMedal) {
        clearMedia();
        return setStatus(error.message || 'Could not load this Medal clip', 'err');
      }
    }
    setMediaUrl(value, isMedal ? 'Medal clip' : 'Social video', true, { scrubbable: false });
    return setStatus('This clip will play in full');
  }
  if (/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[\w-]+/.test(value)) {
    setMediaUrl(value, 'YouTube video', true, { scrubbable: false });
    return;
  }
  const extension = value.split('.').pop().split('?')[0].toLowerCase();
  setMediaUrl(value, value, ['mp4', 'webm'].includes(extension));
}

sendBtn.addEventListener('click', send);
capInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') send(); });
capBottomInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') send(); });

async function send() {
  await applyPastedUrl();
  if (!mediaUrl) return setStatus('Add a meme, video or link first', 'err');
  const captionTop = capInput.value.trim() || null;
  const captionBottom = capBottomInput.value.trim() || null;
  const caption = [captionTop, captionBottom].filter(Boolean).join(' ') || null;
  const shouldTrim = trimScrubbable && videoDuration > 0 && (trimStart > 0.05 || trimEnd < videoDuration - 0.05 || trimRepeat > 1);
  const position = ANCHOR_MAP[selectedAnchor];
  const payload = {
    url: mediaUrl,
    target: targetSel.value || null,
    caption, captionTop, captionBottom,
    captionStyle: selectedCaptionStyle,
    effects: [...activeEffects],
    audioUrl: null,
    fadeInDuration: fadeValue(fadeInEnabled, fadeInDuration),
    fadeOutDuration: fadeValue(fadeOutEnabled, fadeOutDuration),
    loop: false,
    loopDuration: null,
    loopTimes: shouldTrim ? trimRepeat : null,
    trimStart: shouldTrim ? +trimStart.toFixed(2) : null,
    trimEnd: shouldTrim ? +trimEnd.toFixed(2) : null,
    size: selectedSize,
    ...position,
  };
  sendBtn.disabled = true;
  setStatus('Sending…');
  try {
    const result = await window.sender.sendDrop(payload);
    if (!result.ok) throw new Error(result.error || 'Server error');
    setStatus('Dropped!', 'ok');
    window.sender.saveHistory({
      ...payload,
      id: Date.now(),
      timestamp: Date.now(),
      media: { type: mediaIsVideo ? 'video' : 'image', url: mediaUrl },
    });
    resetForm();
  } catch (error) {
    setStatus(`Could not drop: ${error.message}`, 'err');
  } finally {
    sendBtn.disabled = false;
  }
}

function resetForm() {
  clearMedia();
  urlPaste.value = '';
  capInput.value = '';
  capBottomInput.value = '';
  updatePreviewCaptions();
  activeEffects.clear();
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('active'));
  fadeInEnabled.checked = false; fadeInDuration.disabled = true;
  fadeOutEnabled.checked = false; fadeOutDuration.disabled = true;
  selectedCaptionStyle = 'overlay';
  document.querySelectorAll('.style-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.captionStyle === 'overlay'));
  updatePreviewCaptions();
}
function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = type;
}

async function loadHistory() {
  historyList.innerHTML = '';
  const entries = await window.sender.getHistory();
  historyEmpty.style.display = entries.length ? 'none' : 'block';
  entries.forEach((entry) => historyList.appendChild(renderHistoryEntry(entry)));
}
function renderHistoryEntry(entry) {
  const row = document.createElement('article'); row.className = 'history-entry';
  const thumb = document.createElement('div'); thumb.className = 'history-thumb';
  if (entry.media?.url) {
    const media = entry.media.type === 'video' ? document.createElement('video') : document.createElement('img');
    media.src = entry.media.url; if (media.tagName === 'VIDEO') media.muted = true;
    thumb.appendChild(media);
  } else thumb.textContent = '♪';
  const info = document.createElement('div'); info.className = 'history-info';
  const title = document.createElement('div'); title.className = 'history-caption'; title.textContent = entry.caption || 'Untitled drop';
  const meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = `${entry.target ? `@${entry.target}` : 'Everyone'} · ${new Date(entry.timestamp).toLocaleString()}`;
  info.append(title, meta);
  const resend = document.createElement('button'); resend.className = 'history-resend'; resend.textContent = 'Resend';
  resend.addEventListener('click', async () => {
    resend.disabled = true; resend.textContent = 'Sending…';
    const result = await window.sender.sendDrop({ ...entry, url: entry.media?.url || entry.url });
    resend.textContent = result.ok ? 'Sent!' : 'Failed';
    setTimeout(() => { resend.disabled = false; resend.textContent = 'Resend'; }, 1300);
  });
  row.append(thumb, info, resend);
  return row;
}
$('history-clear-btn').addEventListener('click', async () => { await window.sender.clearHistory(); loadHistory(); });

function autoClipName(source, fallback) {
  if (!source) return fallback || 'Clip';
  if (/tiktok\.com/.test(source)) return 'TikTok clip';
  if (/(?:twitter|x)\.com/.test(source)) return 'X clip';
  if (/youtu/.test(source)) return 'YouTube clip';
  try {
    const last = source.split('?')[0].split('/').filter(Boolean).pop() || '';
    const name = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    if (name) return name.slice(0, 40);
  } catch {}
  return fallback || 'Clip';
}
const libSearchInput = $('lib-search');
libSearchInput.addEventListener('input', () => { librarySearch = libSearchInput.value.trim().toLowerCase(); renderLibrary(); });
async function renderLibrary() {
  libraryCache = await window.sender.libraryList();
  const visible = librarySearch ? libraryCache.filter((clip) => (clip.name || '').toLowerCase().includes(librarySearch)) : libraryCache;
  libraryGrid.innerHTML = '';
  libraryEmpty.style.display = visible.length ? 'none' : 'block';
  libraryEmpty.textContent = libraryCache.length ? 'No clips match your search' : 'No saved clips yet';
  visible.forEach((entry) => libraryGrid.appendChild(renderClipTile(entry)));
}
function renderClipTile(entry) {
  const tile = document.createElement('article'); tile.className = 'clip-tile';
  const video = document.createElement('video'); video.src = `clip://clips/${entry.file}`; video.muted = true; video.preload = 'metadata'; video.playsInline = true;
  tile.addEventListener('mouseenter', () => video.play().catch(() => {}));
  tile.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
  const name = document.createElement('div'); name.className = 'clip-name'; name.textContent = entry.name; name.title = 'Click to rename';
  name.addEventListener('click', (event) => { event.stopPropagation(); beginRename(entry, name); });
  const remove = document.createElement('button'); remove.className = 'clip-del'; remove.textContent = '×';
  remove.addEventListener('click', async (event) => { event.stopPropagation(); await window.sender.libraryDelete(entry.id); renderLibrary(); });
  tile.addEventListener('click', () => loadLibraryClip(entry, tile));
  tile.append(video, remove, name);
  return tile;
}
function beginRename(entry, nameElement) {
  const input = document.createElement('input'); input.className = 'clip-name-input'; input.value = entry.name; input.maxLength = 60;
  nameElement.replaceWith(input); input.focus(); input.select();
  let completed = false;
  const finish = async (save) => {
    if (completed) return; completed = true;
    const value = input.value.trim();
    if (save && value && value !== entry.name) await window.sender.libraryRename(entry.id, value);
    renderLibrary();
  };
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}
async function loadLibraryClip(entry, tile) {
  const busy = document.createElement('div'); busy.className = 'clip-sending'; busy.textContent = 'Loading…'; tile.appendChild(busy);
  try {
    const upload = await window.sender.libraryUpload(entry.id);
    if (upload.error || !upload.url) throw new Error(upload.error || 'Upload failed');
    setMediaUrl(upload.url, entry.name, true);
    showTab('compose'); capInput.focus(); setStatus('Clip loaded — make it funny', 'ok');
  } catch (error) { setStatus(error.message, 'err'); }
  finally { busy.remove(); }
}
async function saveLinkToLibrary(url) {
  setStatus('Saving to Library…');
  const result = await window.sender.librarySave({ url, name: autoClipName(url) });
  if (result.error) return setStatus(result.error, 'err');
  setStatus('Saved to Library', 'ok');
  if (isPanelActive('library')) renderLibrary();
}
async function saveFileToLibrary(file) {
  if (!file.type.startsWith('video/')) return setStatus('Library currently saves videos only', 'err');
  const result = await window.sender.librarySaveBuffer(await file.arrayBuffer(), autoClipName(file.name, 'Clip'));
  if (result.error) return setStatus(result.error, 'err');
  setStatus('Saved to Library', 'ok');
  if (isPanelActive('library')) renderLibrary();
}
saveClipBtn.addEventListener('click', async () => {
  if (!mediaUrl) return;
  saveClipBtn.disabled = true;
  await saveLinkToLibrary(mediaUrl);
  saveClipBtn.disabled = false;
});
const libraryPanel = $('library-panel');
let libraryDragCount = 0;
libraryPanel.addEventListener('dragenter', (event) => { event.preventDefault(); libraryDragCount += 1; libraryPanel.classList.add('lib-drag'); });
libraryPanel.addEventListener('dragleave', () => { libraryDragCount -= 1; if (libraryDragCount <= 0) { libraryDragCount = 0; libraryPanel.classList.remove('lib-drag'); } });
libraryPanel.addEventListener('dragover', (event) => event.preventDefault());
libraryPanel.addEventListener('drop', async (event) => {
  event.preventDefault(); libraryDragCount = 0; libraryPanel.classList.remove('lib-drag');
  const file = [...(event.dataTransfer?.files || [])][0];
  const text = (event.dataTransfer?.getData('text') || '').trim();
  if (file) await saveFileToLibrary(file); else if (text.startsWith('http')) await saveLinkToLibrary(text);
});

const SET_RANGES = [['duration', 'durationVal'], ['masterVolume', 'masterVolumeVal'], ['volumeSfx', 'volumeSfxVal'], ['volumeVoice', 'volumeVoiceVal']];
SET_RANGES.forEach(([inputId, outputId]) => $(inputId).addEventListener('input', () => { $(outputId).textContent = $(inputId).value; }));
async function loadSettingsForm() {
  const settings = await window.sender.getSettings();
  $('serverUrl').value = settings.serverUrl || '';
  $('discordUsername').value = settings.discordUsername || '';
  $('duration').value = Math.round((settings.duration || 5000) / 1000);
  $('masterVolume').value = settings.masterVolume ?? 100;
  $('volumeSfx').value = settings.volumeSfx ?? 80;
  $('volumeVoice').value = settings.volumeVoice ?? 100;
  $('tryhardMode').checked = !!settings.tryhardMode;
  $('snipHotkey').value = settings.snipHotkey ?? 'CommandOrControl+Shift+S';
  $('ttsVoice').value = ['g-en', 'g-fr', 'sam', 'mike', 'mary'].includes(settings.ttsVoice) ? settings.ttsVoice : '';
  SET_RANGES.forEach(([inputId, outputId]) => { $(outputId).textContent = $(inputId).value; });
}
$('settings-save-btn').addEventListener('click', async () => {
  await window.sender.saveSettings({
    serverUrl: $('serverUrl').value.trim(),
    discordUsername: $('discordUsername').value.trim(),
    duration: Number($('duration').value) * 1000,
    masterVolume: Number($('masterVolume').value),
    volumeSfx: Number($('volumeSfx').value),
    volumeVoice: Number($('volumeVoice').value),
    tryhardMode: $('tryhardMode').checked,
    snipHotkey: $('snipHotkey').value,
    ttsVoice: $('ttsVoice').value,
  });
  $('settings-status').textContent = 'Saved';
  setTimeout(() => { $('settings-status').textContent = ''; }, 1800);
  loadUsers();
});
$('settings-update-btn').addEventListener('click', async () => {
  $('settings-update-status').textContent = 'Checking…';
  const result = await window.sender.checkForUpdates();
  if (result.status === 'dev') $('settings-update-status').textContent = 'Available in the installed app';
});
if (window.sender.onUpdateStatus) window.sender.onUpdateStatus((message) => { $('settings-update-status').textContent = message; });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!isPanelActive('compose')) showTab('compose'); else window.sender.close();
});
