const titleEl = document.getElementById('title');
const buttons = Array.from(document.querySelectorAll('.react-btn'));

let lastDropper = null;

function render() {
  const has = !!(lastDropper && String(lastDropper).trim());
  if (has) {
    titleEl.textContent = `React to ${lastDropper}`;
    titleEl.classList.remove('empty');
    document.body.classList.remove('disabled');
  } else {
    titleEl.textContent = 'No one to react to yet';
    titleEl.classList.add('empty');
    document.body.classList.add('disabled');
  }
}

window.react.onInit(({ lastDropper: dropper } = {}) => {
  lastDropper = dropper || null;
  render();
});

buttons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!lastDropper) return;   // nothing to react to → no-op
    window.react.pick(btn.dataset.emoji);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.react.cancel();
});

render();
