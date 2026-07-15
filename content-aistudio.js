// AI Studio helper — runs on aistudio.google.com. Google's key page shows the key as `AIza…`
// (masked or, once revealed/copied, full). We scan the DOM text for a full Gemini API key and
// hand it to the background, which stashes it so the popup can one-click add it as the `gemini`
// provider. Best-effort: if the key stays masked, the user still pastes it manually in the popup.
(function () {
  const KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/;
  let lastSent = '';

  function scan() {
    // Scope to the API-key surface only — NOT the whole page. Scanning document.body.innerText +
    // every input would capture an AIza-shaped string that isn't the user's own key (a key rendered
    // in docs/examples/shared content). Look in the key table/dialog and its inputs specifically.
    const zones = document.querySelectorAll(
      '[data-test-id*="key" i], [class*="apikey" i], [class*="api-key" i], table, [role="dialog"], code'
    );
    let hay = '';
    for (const z of zones) {
      hay += ' ' + (z.innerText || '');
      for (const el of z.querySelectorAll('input, textarea')) hay += ' ' + (el.value || '');
    }
    const m = hay.match(KEY_RE);
    if (m && m[0] !== lastSent) {
      lastSent = m[0];
      try { chrome.runtime.sendMessage({ action: 'aistudioKey', key: m[0] }); } catch (e) { /* worker asleep */ }
    }
  }

  // Event-driven (debounced) instead of a fixed 2.5s poll — react when the key surface actually
  // changes (key revealed/generated), not on a timer. Stops after 5 min so an idle tab isn't watched forever.
  let t = null;
  const debounced = () => { clearTimeout(t); t = setTimeout(scan, 400); };
  const obs = new MutationObserver(debounced);
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scan();
  const iv = setInterval(scan, 3000); // floor: a heavy SPA may never let the 400ms debounce settle — guarantee firing
  setTimeout(() => { obs.disconnect(); clearTimeout(t); clearInterval(iv); }, 300000);
})();
