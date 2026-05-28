let mediaRecorder = null;
let chunks = [];
let stream = null;

// ── Énumération des micros ────────────────────────────────────────────────────
window.recorder.onEnumerate(async () => {
  try {
    // getUserMedia déclenche la permission → les labels deviennent visibles
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    // Pas de permission : on envoie quand même la liste (labels vides)
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all
    .filter(d => d.kind === 'audioinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));

  window.recorder.sendDevices(inputs);
});

// ── Enregistrement ────────────────────────────────────────────────────────────
window.recorder.onStart(async (deviceId) => {
  try {
    const audioConstraints = deviceId
      ? { deviceId: { exact: deviceId } }
      : true;

    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    chunks = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      window.recorder.sendData(Array.from(new Uint8Array(arrayBuffer)));
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
    };

    mediaRecorder.start(100);
  } catch (err) {
    window.recorder.sendError(err.message);
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }
});

window.recorder.onStop(() => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
});
