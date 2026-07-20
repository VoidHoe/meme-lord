const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let stream = null;
let frameTimer = null;

async function stopCapture() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

async function startCapture(options) {
  await stopCapture();
  const width = options.width || 260;
  const height = options.height || 195;
  const fps = Math.min(15, Math.max(2, Number(options.fps) || 8));
  canvas.width = width;
  canvas.height = height;

  const videoConstraints = {
    width: { ideal: width },
    height: { ideal: height },
  };
  if (options.deviceId) videoConstraints.deviceId = { exact: options.deviceId };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    video.srcObject = stream;
    await video.play();
    window.facecam.status({ ok: true });
    frameTimer = setInterval(() => {
      if (!stream || !video.videoWidth) return;
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, width, height);
      ctx.restore();
      window.facecam.frame(canvas.toDataURL('image/jpeg', 0.58));
    }, Math.round(1000 / fps));
  } catch (error) {
    window.facecam.status({ error: error.message });
    await stopCapture();
  }
}

window.facecam.onStart(startCapture);
window.facecam.onStop(stopCapture);
