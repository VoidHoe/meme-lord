// Decide when a drop's attached voice note / SFX starts relative to its visual.
// Every mode starts the sound with the picture, including a full-length video.
// That path used to wait for the video `ended` event first, so a GIF or video
// plus a sound played the sound only after the clip had finished — and the
// overlay was about to move on.
function playbackPlan(event = {}, { isVideo = false, isEmbed = false } = {}) {
  const hasTrim = isVideo && event.trimEnd != null && event.trimEnd > (event.trimStart || 0);
  let mode = 'still';
  if (hasTrim) mode = 'trim';
  else if (event.loop === true) mode = 'loop';
  else if (isVideo) mode = 'video';
  else if (isEmbed) mode = 'embed';
  return { mode, audioStart: 'with-media' };
}

// Runs the visual wait and the attached-audio call in the order `playbackPlan`
// describes. `playAudio` is invoked for its side effect and is not awaited:
// voice notes are allowed to keep playing after a short clip ends, matching
// image and GIF drops.
async function runDropTimeline(event, context, hooks) {
  const plan = playbackPlan(event, context);
  if (event && event.audio && plan.audioStart === 'with-media') hooks.playAudio();
  await hooks.wait(plan.mode);
  if (event && event.audio && plan.audioStart === 'after-media') hooks.playAudio();
  return plan;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { playbackPlan, runDropTimeline };
}
