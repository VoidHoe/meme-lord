// Region selector overlay. Shows a frozen full-screen screenshot, lets the user
// drag a rectangle, crops it at full pixel resolution, and ships the PNG bytes
// back to main (which uploads it and hands the URL to the Sender's Compose tab).

const shot    = document.getElementById('shot');
const dim     = document.getElementById('dim');
const sizeLbl = document.getElementById('size');
const ctx     = dim.getContext('2d');

let W = 0, H = 0;
let dragging = false, ready = false;
let sx = 0, sy = 0, ex = 0, ey = 0;

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  dim.width = W; dim.height = H;
  draw();
}

window.snip.onInit(({ dataURL }) => {
  shot.onload = () => { ready = true; resize(); };
  shot.src = dataURL;
});
window.addEventListener('resize', resize);

function rect() {
  return { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(0, 0, W, H);
  if (dragging) {
    const r = rect();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#1c9eff';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
  }
}

window.addEventListener('mousedown', (e) => {
  if (!ready) return;
  dragging = true; sx = ex = e.clientX; sy = ey = e.clientY;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  ex = e.clientX; ey = e.clientY;
  draw();
  const r = rect();
  sizeLbl.style.display = 'block';
  sizeLbl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  sizeLbl.style.left = r.x + 'px';
  sizeLbl.style.top  = Math.max(0, r.y - 22) + 'px';
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  const r = rect();
  if (r.w < 5 || r.h < 5) { window.snip.cancel(); return; }
  crop(r);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.snip.cancel(); });

function crop(r) {
  const scaleX = shot.naturalWidth  / W;
  const scaleY = shot.naturalHeight / H;
  const sxp = Math.round(r.x * scaleX), syp = Math.round(r.y * scaleY);
  const swp = Math.round(r.w * scaleX), shp = Math.round(r.h * scaleY);
  const c = document.createElement('canvas');
  c.width = swp; c.height = shp;
  c.getContext('2d').drawImage(shot, sxp, syp, swp, shp, 0, 0, swp, shp);
  c.toBlob(async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    window.snip.sendRegion(buf);
  }, 'image/png');
}
