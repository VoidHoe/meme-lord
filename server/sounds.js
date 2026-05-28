const SOUNDS = [
  'airhorn', 'bruh', 'vine_boom', 'sad_violin', 'gg',
  'myname', 'nani', 'mlg_hit', 'wow', 'bonk'
];

function isValidSound(name) {
  return SOUNDS.includes(name.toLowerCase());
}

module.exports = { SOUNDS, isValidSound };
