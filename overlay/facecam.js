const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let stream = null;
let frameTimer = null;
let encodingFrame = false;

const MAX_FRAME_CHARS = 260000;

function canvasToDataUrl() {
  return new Promise(resolve => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.46);
  });
}

async function stopCapture() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  encodingFrame = false;
  video.srcObject = null;
}

async function startCapture(options) {
  await stopCapture();
  const width = options.width || 220;
  const height = options.height || 195;
  const fps = Math.min(10, Math.max(2, Number(options.fps) || 6));
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
    frameTimer = setInterval(async () => {
      if (!stream || !video.videoWidth || encodingFrame) return;
      encodingFrame = true;
      try {
        ctx.save();
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, width, height);
        ctx.restore();
        const image = await canvasToDataUrl();
        if (!stream || !image || image.length > MAX_FRAME_CHARS) return;
        window.facecam.frame(image);
      } finally {
        encodingFrame = false;
      }
    }, Math.round(1000 / fps));
  } catch (error) {
    window.facecam.status({ error: error.message });
    await stopCapture();
  }
}

window.facecam.onStart(startCapture);
window.facecam.onStop(stopCapture);
