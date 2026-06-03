// Soft password gate for the mobile /send page.
// The page calls POST /api/send-auth twice: once on load with no password (a probe to
// learn whether a gate is required) and again with the entered password to unlock.
//
//   envPassword unset            → { ok: true,  required: false }  (no gate)
//   set, password matches        → { ok: true,  required: true  }
//   set, password missing/wrong  → { ok: false, required: true  }
function checkSendAuth(password, envPassword) {
  if (!envPassword) return { ok: true, required: false };
  return { ok: password === envPassword, required: true };
}

module.exports = { checkSendAuth };
