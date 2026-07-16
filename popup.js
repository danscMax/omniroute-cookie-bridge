// OmniRoute Bridge — popup. DOM-API only (no innerHTML). Feedback is honest:
// 201 = "Добавлено" (really in OmniRoute); a REAL probe = "работает / не работает / не проверено";
// live connection counts (read from /api/providers) show what's actually there right now.
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// i18n lookup. Falls back to the KEY itself, never "": chrome.i18n.getMessage returns an empty string
// for a missing key, which turns a button into a silent blank instead of a visible bug.
const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
// One pass over the static markup: [data-i18n] → text, [data-i18n-title|placeholder|label] → attribute.
// getAttribute, not dataset: linkedom (the render smoke's DOM) returns null for `dataset.i18n` while
// honouring the suffixed ones, which blanked every static label under test while looking fine in Chrome.
// Same semantics in a real browser, and it keeps the smoke able to see what a user sees.
function applyI18n() {
  const at = (e, a) => t(e.getAttribute(a));
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = at(e, "data-i18n");
  for (const e of document.querySelectorAll("[data-i18n-title]")) e.title = at(e, "data-i18n-title");
  for (const e of document.querySelectorAll("[data-i18n-placeholder]")) e.placeholder = at(e, "data-i18n-placeholder");
  for (const e of document.querySelectorAll("[data-i18n-label]")) e.setAttribute("aria-label", at(e, "data-i18n-label"));
  const loc = chrome.i18n.getMessage("@@ui_locale"); // "ru", "en_US" → the <html lang> screen readers read
  if (loc) document.documentElement.lang = loc.replace("_", "-");
}
applyI18n();
function ago(ms) { const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return t("popup_agoSec", [String(s)]); const m = Math.round(s / 60); if (m < 60) return t("popup_agoMin", [String(m)]); return t("popup_agoHour", [String(Math.round(m / 60))]); }
const msg = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
// Where to send someone whose session died. The catalog carries a real login URL per web provider
// (e.g. chatgpt.com/auth/login) — it was generated for all 23 and used by nothing; the homepage is one
// extra click away from the thing they actually came to do. Falls back to the site if a slug lacks one.
const loginTarget = (w) => (w && (w.loginUrl || w.site)) || "";
// One label lookup across the three registries (a slug lives in exactly one of them).
const providerLabel = (slug) => ((OMNI_WEB_MAP[slug] || OMNI_OAUTH_MAP[slug] || OMNI_APIKEY_MAP[slug] || {}).label) || slug;
function setRes(elm, kind, text) { elm.setAttribute("aria-live", "polite"); elm.className = "res show " + kind; elm.textContent = text; } // announce results to screen readers
function maskKey(k) { return k.length > 12 ? k.slice(0, 6) + "…" + k.slice(-4) : k; }
const $ = (id) => document.getElementById(id);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let caps = {};              // captured web sessions (cap_<key>)
let conns = {};             // live OmniRoute connections grouped by provider {slug:{total,good,bad,names}}
let connTotal = 0;
let problems = [];          // bad/banned connections [{provider,id,name}]
let allConns = [];          // EVERY live connection [{provider,id,name,testStatus,hasError,isActive}] — for the manager
let connUnreachable = false; // true = couldn't READ connections (outage) vs genuinely 0 — surfaced honestly
let probes = {};            // persisted last probe verdict per slug
let activeProviderKey = null;
let serverOnline = false;
let lastWebSig = null;

// ── tabs ────────────────────────────────────────────────────────────────────
const tabEls = [...document.querySelectorAll(".tab")];
function selectTab(t) {
  tabEls.forEach((x) => { const on = x === t; x.classList.toggle("on", on); x.setAttribute("aria-selected", on ? "true" : "false"); });
  for (const pane of ["web", "key", "oauth"]) $("pane-" + pane).classList.toggle("hide", pane !== t.dataset.pane);
  $("settingsPanel").classList.add("hide"); // tab switch closes the settings panel
  chrome.storage.local.set({ sel_tab: t.dataset.pane }); // remember across opens
}
tabEls.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => { // ←/→ roving between tabs (WAI-ARIA tablist)
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tabEls[(i + (e.key === "ArrowRight" ? 1 : tabEls.length - 1)) % tabEls.length];
    next.focus(); selectTab(next);
  });
});
// Keyboard shortcuts (ignored while typing in a field): 1/2/3 jump to a tab, "/" focuses its search.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // don't hijack Ctrl+1 etc.
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const idx = { "1": 0, "2": 1, "3": 2 }[e.key];
  if (idx != null && tabEls[idx]) { tabEls[idx].click(); return; }
  if (e.key === "/") {
    const on = document.querySelector(".tab.on");
    const id = { web: "webSearch", key: "keySearch", oauth: "oauthSearch" }[on && on.dataset.pane];
    if (id && $(id)) { e.preventDefault(); $(id).focus(); }
  }
});

// ── shared rendering helpers ────────────────────────────────────────────────
function connLine(slug) {
  const c = conns[slug];
  if (!c || !c.total) return null;
  const parts = [t("popup_inOmni", [String(c.total)])];
  if (c.good) parts.push(`🟢 ${c.good}`);
  if (c.bad) parts.push(`🔴 ${c.bad}`);
  const div = el("div", "conns", parts.join("  ·  "));
  if (c.names && c.names.length) div.title = c.names.join("\n"); // hover → the actual connection names
  return div;
}
const PROBE_TTL = 10 * 60 * 1000; // a verdict older than 10 min is "was", not "is now"
function showProbe(resEl, id, p, added) {
  if (!p) { resEl.className = "res"; return; }
  const idt = id ? ` (${id.slice(0, 8)}…)` : "";
  const pre = added ? t("popup_added") + idt : t("popup_probe");
  const stale = p.at && (Date.now() - p.at > PROBE_TTL);
  const age = stale ? " · " + t("popup_checkedAgo", [ago(p.at)]) : "";
  // A stale green verdict is demoted to neutral ⚪ (we no longer vouch it's live); red/unknown keep their icon + age.
  if (p.alive === true) setRes(resEl, stale ? "mut" : "ok", stale ? `⚪ ${t("popup_probeWorked", [pre])}${age}` : `🟢 ${t("popup_probeWorks", [pre, p.detail || "200"])}`);
  else if (p.alive === false) setRes(resEl, "bad", `🔴 ${t("popup_probeFailed", [pre, String(p.detail)])}${age}`);
  else setRes(resEl, "mut", `⚪ ${t("popup_probeUnknown", [pre, (p && p.detail) || t("popup_noAnswer")])}`);
}
// honest add → probe flow (shared by web + apikey)
async function addAndProbe(resEl, doAdd, probeBtn) {
  if (!serverOnline) { setRes(resEl, "bad", "⚠ " + t("popup_omniDown")); return null; }
  setRes(resEl, "pend", t("popup_adding"));
  const r = await doAdd();
  if (!r || !r.ok) { setRes(resEl, "bad", "🔴 " + ((r && r.error) || t("popup_error"))); return r; }
  setRes(resEl, "pend", t("popup_addedProbing", [r.id ? ` (${r.id.slice(0, 8)}…)` : ""]));
  const p = await msg({ action: "probe", slug: r.slug });
  probes[r.slug] = { ...p, at: Date.now() };
  showProbe(resEl, r.id, p, true);
  if (probeBtn) { probeBtn.classList.remove("hide"); probeBtn.onclick = () => reprobe(resEl, r.slug, r.id, probeBtn); }
  loadConnections();
  return r;
}
async function reprobe(resEl, slug, id, btn) {
  if (btn) btn.disabled = true;
  setRes(resEl, "pend", t("popup_probingLive"));
  const p = await msg({ action: "probe", slug });
  probes[slug] = { ...p, at: Date.now() };
  showProbe(resEl, id, p, false);
  if (btn) btn.disabled = false;
}

// ── WEB pane ────────────────────────────────────────────────────────────────
// Will POSTing `<base> · <accountId>` update an existing connection (same name) or create a new one?
function willUpdate(slug, base, accountId) {
  const names = (conns[slug] && conns[slug].names) || [];
  return accountId ? names.includes(`${base} · ${accountId}`) : false;
}
function webCard(p, cap) {
  const card = el("div", "card" + (p.key === activeProviderKey ? " live" : ""));
  const h = el("div", "card-h");
  h.append(el("span", "ico", "🍪"), el("b", null, p.label), el("span", "tag", p.slug));
  if (p.key === activeProviderKey) h.append(el("span", "tag", t("web_thisTab")));
  const cc = conns[p.slug];
  if (cc && cc.bad) { card.classList.add("bad"); h.append(el("span", "warnbadge", `⚠ ${cc.bad}`)); }
  card.append(h);
  // Web sessions rot in hours — warn (amber) once a capture is old enough to likely be dead.
  const capStale = Date.now() - cap.at > 6 * 60 * 60 * 1000;
  card.append(el("div", "sub" + (capStale ? " stale" : ""),
    `${capStale ? "⚠️" : "✅"} ${t("web_capturedN", [String(cap.cookieCount), ago(cap.at)])}${capStale ? " — " + t("web_captureStale") : ""}`));
  const cl = connLine(p.slug); if (cl) card.append(cl);
  const input = el("input"); input.type = "text"; input.value = p.label; input.placeholder = t("web_accountNamePh");
  card.append(input);
  const predict = el("div", "predict"); card.append(predict);
  const actions = el("div", "actions");
  const send = el("button", "grow sm", "");
  const probe = el("button", "ghost sm" + (probes[p.slug] ? "" : " hide"), t("popup_check"));
  const dismiss = el("button", "ghost sm", "✕");
  dismiss.title = t("web_dismissTitle");
  dismiss.setAttribute("aria-label", t("web_dismissLabel"));
  dismiss.onclick = async () => { await msg({ action: "clear", providerKey: p.key }); await refresh(); };
  actions.append(send, probe, dismiss); card.append(actions);
  const res = el("div", "res"); card.append(res);
  const hasOther = conns[p.slug] && conns[p.slug].total;
  function sync() {
    const upd = willUpdate(p.slug, input.value.trim() || p.label, cap.accountId);
    // Button carries the single "Обновить"; the hint explains — no duplicated word.
    send.textContent = upd ? t("popup_update") : (hasOther ? t("web_addAccount") : t("web_send"));
    send.classList.toggle("upd", upd);
    predict.className = "predict " + (upd ? "upd" : "new");
    predict.textContent = upd ? t("web_predictUpd") : t("popup_predictNew");
  }
  sync();
  input.addEventListener("input", sync);
  if (probes[p.slug]) { showProbe(res, null, probes[p.slug], false); probe.onclick = () => reprobe(res, p.slug, null, probe); }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send.click(); });
  send.addEventListener("click", async () => {
    send.disabled = true;
    await addAndProbe(res, () => msg({ action: "send", providerKey: p.key, name: input.value.trim() || p.label }), probe);
    send.disabled = false;
  });
  return card;
}
function renderWeb() {
  // Don't rebuild while a card's name field is focused — a concurrent probe/add/refresh must not
  // wipe what's being typed. Return false so callers know NO render happened (don't advance lastWebSig).
  if (document.activeElement && $("webCaptured").contains(document.activeElement)) return false;
  const q = $("webSearch").value.trim().toLowerCase();
  const match = (p) => !q || p.label.toLowerCase().includes(q) || p.slug.includes(q);
  const cap = $("webCaptured"); cap.textContent = "";
  const capd = OMNI_WEB.filter((p) => caps[p.key] && match(p))
    .sort((a, b) => (a.key === activeProviderKey ? -1 : b.key === activeProviderKey ? 1 : 0));
  $("bWeb").textContent = String(OMNI_WEB.filter((p) => caps[p.key]).length);
  if (capd.length) {
    const ttl = el("div", "grp-title", t("web_readyTitle")); ttl.append(el("span", "n", String(capd.length))); cap.append(ttl);
    if (capd.length > 1) {
      // Predict how many of the batch will UPDATE an existing connection vs CREATE a new one.
      const upd = capd.filter((p) => willUpdate(p.slug, p.label, caps[p.key].accountId)).length;
      const all = el("button", "bulk", t("web_sendAll", [String(capd.length)]) + (upd ? " — " + t("web_sendAllSplit", [String(upd), String(capd.length - upd)]) : ""));
      all.addEventListener("click", () => sendAll(capd, all));
      cap.append(all);
    }
    // Re-send only the captures whose connection is currently dead (banned / failed live probe) —
    // fast recovery without re-pushing every healthy session.
    const dead = capd.filter((p) => (conns[p.slug] && conns[p.slug].bad) || (probes[p.slug] && probes[p.slug].alive === false));
    if (dead.length) {
      const fix = el("button", "bulk upd", t("web_fixDead", [String(dead.length)]));
      fix.addEventListener("click", () => sendAll(dead, fix));
      cap.append(fix);
    }
    if (capd.length > 1) { // bulk-dismiss all captured sessions (doesn't touch OmniRoute)
      const clearAll = el("button", "bulk ghost", t("web_clearAll", [String(capd.length)]));
      clearAll.addEventListener("click", async () => { clearAll.disabled = true; for (const p of capd) await msg({ action: "clear", providerKey: p.key }); await refresh(); });
      cap.append(clearAll);
    }
    for (const p of capd) cap.append(webCard(p, caps[p.key]));
  } else if (!Object.values(caps).some(Boolean)) {
    const e = el("div", "empty");
    e.append(el("b", null, t("web_emptyTitle"))); e.append(document.createElement("br"));
    e.append(document.createTextNode(t("web_emptyHint")));
    cap.append(e);
  }
  const chips = $("webChips"); chips.textContent = "";
  // Providers with a live connection float to the top of the chip list (the ones you actually use).
  const all = OMNI_WEB.filter(match).sort((a, b) => (conns[b.slug] && conns[b.slug].total ? 1 : 0) - (conns[a.slug] && conns[a.slug].total ? 1 : 0));
  $("webAllN").textContent = q ? `${all.length}/${OMNI_WEB.length}` : String(OMNI_WEB.length);
  if (!all.length) chips.append(el("div", "empty", t("popup_nothingFound")));
  for (const p of all) {
    const chip = el("button", "chip" + (caps[p.key] ? " has" : "")); // <button> = focusable + Enter/Space
    if (caps[p.key]) chip.append(el("span", "g"));
    chip.append(document.createTextNode(p.label));
    const c = conns[p.slug]; if (c && c.total) chip.append(el("span", "cn", String(c.total)));
    chip.title = t("web_openSite", [p.site]);
    chip.addEventListener("click", () => chrome.tabs.create({ url: p.site }));
    chips.append(chip);
  }
}
async function sendAll(list, btn) {
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    btn.textContent = t("web_sending", [String(i + 1), String(list.length)]);
    const r = await msg({ action: "send", providerKey: list[i].key, name: list[i].label });
    if (r && r.ok) ok++;
  }
  btn.textContent = t("web_sendDone", [String(ok), String(list.length)]);
  await loadConnections();
  setTimeout(() => { btn.disabled = false; renderWeb(); }, 1200);
}
$("webSearch").addEventListener("input", debounce(renderWeb, 140));

// ── API-KEY pane ────────────────────────────────────────────────────────────
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
let keyExpanded = null; // slug of the currently expanded api-key provider

// Inline add-form shown when a provider row is expanded.
function keyForm(p) {
  const box = el("div", "keyform");
  if (p.get) {
    const get = el("button", "ghost sm getkey", t("key_getKey", [hostOf(p.get)]));
    get.onclick = () => chrome.tabs.create({ url: p.get });
    box.append(get);
  }
  const name = el("input"); name.type = "text"; name.placeholder = t("key_namePh");
  const key = el("input"); key.type = "password"; key.placeholder = t("key_keyPh"); key.autocomplete = "off";
  box.append(name, key);
  // Provider-specific extra fields (e.g. `cx` for google-pse-search) → providerSpecificData on add.
  const extraInputs = {};
  if (p.extra) for (const ef of p.extra) {
    const inp = el("input"); inp.type = "text"; inp.placeholder = ef.label + " " + (ef.required ? t("key_required") : t("key_optional"));
    if (ef.hint) inp.title = ef.hint;
    extraInputs[ef.key] = inp; box.append(inp);
  }
  // Collapsible advanced add-options (parity with the dashboard): custom endpoint + routing tag.
  const advWrap = el("div", "hide");
  const advBase = el("input"); advBase.type = "text"; advBase.placeholder = t("key_advBasePh"); advBase.title = t("key_advBaseTitle");
  const advTag = el("input"); advTag.type = "text"; advTag.placeholder = t("key_advTagPh");
  advWrap.append(advBase, advTag);
  const advToggle = el("button", "ghost sm", t("key_advToggle"));
  advToggle.onclick = () => advWrap.classList.toggle("hide");
  box.append(advToggle, advWrap);
  // Bulk mode: paste several keys of this provider (one per line) → /api/providers/bulk.
  const bulkArea = el("textarea", "hide"); bulkArea.placeholder = t("key_bulkPh"); bulkArea.rows = 4;
  const bulkToggle = el("button", "ghost sm", t("key_bulkOn"));
  bulkToggle.onclick = () => { const on = !bulkArea.classList.toggle("hide"); key.classList.toggle("hide", on); name.classList.toggle("hide", on); bulkToggle.textContent = on ? t("key_bulkOff") : t("key_bulkOn"); };
  box.append(bulkToggle, bulkArea);
  const predict = el("div", "predict"); box.append(predict);
  const actions = el("div", "actions");
  const add = el("button", "grow sm", t("popup_add"));
  const probe = el("button", "ghost sm" + (probes[p.slug] ? "" : " hide"), t("popup_check"));
  actions.append(add, probe); box.append(actions);
  const res = el("div", "res"); box.append(res);
  if (probes[p.slug]) { showProbe(res, null, probes[p.slug], false); probe.onclick = () => reprobe(res, p.slug, null, probe); }
  function sync() {
    const k = key.value.trim();
    if (!k) { predict.className = "predict"; predict.textContent = ""; add.textContent = t("popup_add"); add.classList.remove("upd"); return; }
    const upd = willUpdate(p.slug, name.value.trim() || p.slug, omniAccountId(k));
    predict.className = "predict " + (upd ? "upd" : "new");
    predict.textContent = upd ? t("key_predictUpd") : t("popup_predictNew");
    add.textContent = upd ? t("popup_update") : t("popup_add"); add.classList.toggle("upd", upd);
  }
  key.addEventListener("input", sync);
  name.addEventListener("input", sync);
  key.addEventListener("keydown", (e) => { if (e.key === "Enter") add.click(); });
  add.onclick = async () => {
    if (!bulkArea.classList.contains("hide")) { // bulk mode: several keys at once
      const keys = bulkArea.value.split("\n").map((k) => k.trim()).filter(Boolean);
      if (!keys.length) { setRes(res, "bad", t("key_pasteKeys")); return; }
      add.disabled = true;
      const r = await addAndProbe(res, () => msg({ action: "bulkAddApiKey", slug: p.slug, keys }), probe);
      add.disabled = false;
      if (r && r.ok) bulkArea.value = "";
      return;
    }
    const apiKey = key.value.trim();
    if (!apiKey) { setRes(res, "bad", t("key_pasteKey")); return; }
    const psd = {};
    for (const ef of (p.extra || [])) {
      const v = extraInputs[ef.key].value.trim();
      if (ef.required && !v) { setRes(res, "bad", t("key_fillField", [ef.label])); return; }
      if (v) psd[ef.key] = v;
    }
    if (advBase.value.trim()) psd.baseUrl = advBase.value.trim(); // custom endpoint override
    if (advTag.value.trim()) psd.tag = advTag.value.trim();       // routing group tag
    add.disabled = true;
    const r = await addAndProbe(res, () => msg({ action: "addApiKey", slug: p.slug, name: name.value.trim(), apiKey, psd }), probe);
    add.disabled = false;
    if (r && r.ok) { key.value = ""; sync(); }
  };
  setTimeout(() => key.focus(), 0);
  return box;
}
function keyRow(p) {
  const open = p.slug === keyExpanded;
  const row = el("div", "keyrow" + (open ? " open" : ""));
  const head = el("div", "keyrow-h");
  const kn = el("span", "kname", p.label); kn.title = p.label; head.append(kn);
  if (p.free) head.append(el("span", "freebadge", "free"));
  const c = conns[p.slug]; if (c && c.total) head.append(el("span", "cn" + (c.bad ? " bad" : " has"), String(c.total)));
  const pr = probes[p.slug]; if (pr) head.append(el("span", "kdot " + (pr.alive === true ? "ok" : pr.alive === false ? "bad" : "mut")));
  head.append(el("span", "chev", open ? "▾" : "▸"));
  head.onclick = () => { keyExpanded = open ? null : p.slug; chrome.storage.local.set({ sel_apikey: keyExpanded }); renderKeyList(); };
  head.tabIndex = 0; head.setAttribute("role", "button"); head.setAttribute("aria-expanded", open ? "true" : "false");
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); } });
  row.append(head);
  if (open) row.append(keyForm(p));
  return row;
}
function renderKeyList() {
  if (document.activeElement && $("keyList").contains(document.activeElement)) return; // don't wipe a key being typed
  const q = $("keySearch").value.trim().toLowerCase();
  const box = $("keyList"); box.textContent = "";
  const match = (p) => !q || p.label.toLowerCase().includes(q) || p.slug.includes(q);
  // Search-first: the catalog is too long to scroll. With no query show only the working set
  // (providers that already have a connection); everything else is one keystroke away.
  // Count comes from the catalog, never a literal — the badge two lines down already said 167 while
  // this prose still claimed 171, contradicting itself inside one function.
  if (!q) {
    const total = OMNI_APIKEY.length;
    $("bKey").textContent = String(total);
    const have = OMNI_APIKEY.filter((p) => conns[p.slug] && conns[p.slug].total);
    if (!have.length) { box.append(el("div", "empty", t("key_emptyHint", [String(total)]))); return; }
    const ttl = el("div", "grp-title", t("key_withConns")); ttl.append(el("span", "n", String(have.length))); box.append(ttl);
    for (const p of have) box.append(keyRow(p));
    box.append(el("p", "hint-sm", t("key_restHint", [String(total)])));
    return;
  }
  const list = OMNI_APIKEY.filter(match);
  $("bKey").textContent = `${list.length}/${OMNI_APIKEY.length}`; // honest filtered count (mirrors the Web tab)
  if (!list.length) { box.append(el("div", "empty", t("popup_nothingFound"))); return; }
  const byFam = {};
  for (const p of list) (byFam[p.family] = byFam[p.family] || []).push(p);
  for (const fam of Object.keys(byFam)) {
    const ttl = el("div", "grp-title", fam); ttl.append(el("span", "n", String(byFam[fam].length))); box.append(ttl);
    for (const p of byFam[fam]) box.append(keyRow(p));
  }
}
function initKeyPane() {
  keyExpanded = stored.sel_apikey || null;
  $("keySearch").addEventListener("input", debounce(renderKeyList, 140));
  renderKeyList();
  keyPaneFill = renderKeyList;
}
let keyPaneFill = () => {};

// AI Studio detected key
async function refreshAistudio() {
  const { apikey_aistudio: cap } = await chrome.storage.session.get("apikey_aistudio");
  const card = $("aistudioCard");
  if (!cap || !cap.key) { card.classList.add("hide"); return; }
  card.classList.remove("hide");
  $("aistudioVal").textContent = "🔑 " + maskKey(cap.key) + " · " + ago(cap.at);
  const add = $("aistudioAdd"), res = $("aistudioRes");
  add.onclick = async () => { add.disabled = true; await addAndProbe(res, () => msg({ action: "addApiKey", slug: "gemini", name: "AI Studio", apiKey: cap.key })); add.disabled = false; };
  $("aistudioDismiss").onclick = () => { chrome.storage.session.remove("apikey_aistudio"); card.classList.add("hide"); };
}

// ── OAUTH pane (per-provider state; concurrent flows never clobber) ──────────
let oauthStates = {};
let oauthTimer = null;

const KIND_TAG = { device: t("oauth_kindDevice"), redirect: t("oauth_kindRedirect"), import: t("oauth_kindImport") };
function oauthCancelBtn(o) {
  const cancel = el("button", "ghost sm cancel", t("popup_cancel"));
  cancel.onclick = async () => { await msg({ action: "oauthCancel", provider: o.slug }); delete oauthStates[o.slug]; renderOauth(); };
  return cancel;
}
// Bulk ZIP import row for providers that support it (claude/codex/antigravity) — a .zip of exported
// accounts → base64 (File can't cross the SW message intact) → zipImport → probe result.
function zipImportRow(o) {
  const wrap = el("div");
  const zres = el("div", "res");
  const fileBtn = el("button", "ghost sm grow", t("oauth_zipImport"));
  const file = el("input", "hide"); file.type = "file"; file.accept = ".zip";
  fileBtn.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0]; if (!f) return;
    setRes(zres, "pend", t("oauth_zipReading"));
    const b64 = await new Promise((r) => { const rd = new FileReader(); rd.onload = () => r(String(rd.result).split(",")[1] || ""); rd.onerror = () => r(""); rd.readAsDataURL(f); });
    if (!b64) { setRes(zres, "bad", t("oauth_zipReadFail")); return; }
    setRes(zres, "pend", t("oauth_zipImporting"));
    const res = await msg({ action: "zipImport", provider: o.slug, b64 });
    if (res && res.ok) { setRes(zres, "ok", t("oauth_zipDone", [String(res.added)])); loadConnections(); }
    else setRes(zres, "bad", "🔴 " + ((res && res.error) || t("popup_error")));
    file.value = "";
  };
  wrap.append(fileBtn, file, zres);
  return wrap;
}
function oauthCard(o) {
  const st = oauthStates[o.slug];
  const bad = st && (st.status === "error" || st.status === "expired");
  const card = el("div", "card" + (bad ? " bad" : "")); card.dataset.slug = o.slug;
  const h = el("div", "card-h");
  h.append(el("span", "ico", "🔐"), el("b", null, o.label), el("span", "tag", KIND_TAG[o.kind] || o.slug));
  card.append(h);
  const cl = connLine(o.slug); if (cl) card.append(cl);

  if (o.broken) { card.append(el("div", "res show bad", t("oauth_broken"))); return card; }

  if (st && st.status === "pending") {
    if (o.kind === "device") {
      const box = el("div", "codebox");
      box.append(el("div", "code", st.userCode || "…"));
      const copy = el("button", "ghost sm", t("popup_copy"));
      copy.onclick = () => navigator.clipboard.writeText(st.userCode).then(() => { copy.textContent = t("popup_copied"); setTimeout(() => (copy.textContent = t("popup_copy")), 1200); });
      box.append(copy); card.append(box);
      const open = el("button", "grow", t("oauth_openAuth"));
      open.onclick = () => { if (st.verifyUrl) chrome.tabs.create({ url: st.verifyUrl }); };
      card.append(open);
      const mins = st.expiresAt ? Math.max(0, Math.round((st.expiresAt - Date.now()) / 60000)) : 0;
      card.append(el("div", "res show pend", t("oauth_devicePending", [String(st.interval || 5)]) + (mins ? " · " + t("oauth_deviceExpiry", [String(mins)]) : "") + "…"));
    } else { // redirect: browser login, completed by OmniRoute's callback server
      const open = el("button", "grow", t("oauth_openLogin"));
      open.onclick = () => { if (st.verifyUrl) chrome.tabs.create({ url: st.verifyUrl }); };
      card.append(open);
      card.append(el("div", "res show pend", t("oauth_redirectPending")));
    }
    card.append(oauthCancelBtn(o));
  } else if (st && st.status === "success") {
    const res = el("div", "res"); card.append(res);
    showProbe(res, st.connId, probes[o.slug], true);
  } else if (bad) {
    card.append(el("div", "res show bad", "🔴 " + (st.detail || t("popup_error"))));
    const retry = el("button", "sm", t("popup_retry"));
    retry.onclick = () => { delete oauthStates[o.slug]; if (o.kind === "redirect") connectOauth(o.slug); else if (o.kind === "device") startOauth(o.slug); else renderOauth(); };
    card.append(retry);
  } else if (o.kind === "import") {
    if (o.tokenHint) {
      if (/^https?:/.test(o.tokenHint)) { const g = el("button", "ghost sm getkey", t("oauth_whereToken")); g.onclick = () => chrome.tabs.create({ url: o.tokenHint }); card.append(g); }
      else card.append(el("div", "hint-sm", "💡 " + o.tokenHint));
    }
    const input = el("input"); input.type = "password"; input.placeholder = t("oauth_tokenPh"); input.autocomplete = "off";
    card.append(input);
    const actions = el("div", "actions");
    const imp = el("button", "grow sm", t("oauth_import"));
    const probe = el("button", "ghost sm" + (probes[o.slug] ? "" : " hide"), t("popup_check"));
    actions.append(imp, probe); card.append(actions);
    const res = el("div", "res"); card.append(res);
    // Auto-detect local CLI creds first (only where OmniRoute has an auto-import endpoint); else manual paste.
    if (o.autoImport) {
      const auto = el("button", "ghost sm grow", t("oauth_findLocal"));
      auto.title = t("oauth_findLocalTitle");
      auto.onclick = async () => { auto.disabled = true; await autoImportOauth(o.slug, res, probe); auto.disabled = false; };
      card.insertBefore(auto, input); // primary path: place it above the manual paste field
    }
    if (probes[o.slug]) { showProbe(res, null, probes[o.slug], false); probe.onclick = () => reprobe(res, o.slug, null, probe); }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") imp.click(); });
    imp.onclick = async () => { const tok = input.value.trim(); if (!tok) { setRes(res, "bad", t("oauth_pasteToken")); return; } imp.disabled = true; const r = await importOauth(o.slug, tok, res, probe); imp.disabled = false; if (r && r.ok) input.value = ""; };
  } else if (o.kind === "redirect") {
    const row = el("div", "actions");
    const btn = el("button", "sm", t("oauth_connectBrowser")); btn.onclick = () => connectOauth(o.slug); row.append(btn);
    const dash = el("button", "ghost sm", t("oauth_inDashboard")); dash.title = t("oauth_inDashboardTitle");
    dash.onclick = () => chrome.tabs.create({ url: OMNI_BASE + "/dashboard/providers/" + o.slug }); row.append(dash);
    card.append(row);
    if (o.zipAuth) card.append(zipImportRow(o)); // bulk import of many exported accounts from a .zip
  } else {
    const btn = el("button", "sm", t("oauth_connect")); btn.onclick = () => startOauth(o.slug); card.append(btn);
  }
  return card;
}

function renderOauth() {
  if (document.activeElement && $("oauthList") && $("oauthList").contains(document.activeElement)) return; // don't wipe a token being typed
  $("bOauth").textContent = String(OMNI_OAUTH.length);
  const q = ($("oauthSearch").value || "").trim().toLowerCase();
  const match = (o) => !q || o.label.toLowerCase().includes(q) || o.slug.includes(q);
  const list = OMNI_OAUTH.filter(match);
  const box = $("oauthList"); box.textContent = "";
  if (!list.length) { box.append(el("div", "empty", t("popup_nothingFound"))); return; }
  const titles = { device: t("oauth_grpDevice"), redirect: t("oauth_grpRedirect"), import: t("oauth_grpImport") };
  for (const k of ["device", "redirect", "import"]) {
    const grp = list.filter((o) => o.kind === k);
    if (!grp.length) continue;
    const ttl = el("div", "grp-title", titles[k]); ttl.append(el("span", "n", String(grp.length))); box.append(ttl);
    for (const o of grp) box.append(oauthCard(o));
  }
}
$("oauthSearch").addEventListener("input", debounce(renderOauth, 140));
async function startOauth(slug) {
  if (!serverOnline) { oauthStates[slug] = { status: "error", detail: t("popup_omniDown") }; renderOauth(); return; }
  oauthStates[slug] = { status: "pending", userCode: "…", verifyUrl: "" }; renderOauth();
  const r = await msg({ action: "oauthStart", provider: slug });
  if (!r || !r.ok) { oauthStates[slug] = { status: "error", detail: (r && r.error) || t("popup_error") }; renderOauth(); return; }
  await refreshOauth();
}
// Redirect/PKCE: kick off the browser login; OmniRoute's callback server completes it, we poll.
async function connectOauth(slug) {
  if (!serverOnline) { oauthStates[slug] = { status: "error", detail: t("popup_omniDown") }; renderOauth(); return; }
  oauthStates[slug] = { status: "pending", kind: "redirect", verifyUrl: "" }; renderOauth();
  const r = await msg({ action: "oauthConnect", provider: slug });
  if (!r || !r.ok) { oauthStates[slug] = { status: "error", detail: (r && r.error) || t("popup_error") }; renderOauth(); return; }
  await refreshOauth();
}
// Import-token: paste → add → honest probe (shares the web/apikey add-flow).
async function importOauth(slug, token, resEl, probeBtn) {
  return addAndProbe(resEl, () => msg({ action: "oauthImport", provider: slug, token }), probeBtn);
}
async function autoImportOauth(slug, resEl, probeBtn) {
  return addAndProbe(resEl, () => msg({ action: "oauthAutoImport", provider: slug }), probeBtn);
}
async function refreshOauth() {
  const { states } = (await msg({ action: "oauthState" })) || {};
  const prev = oauthStates; oauthStates = states || {};
  for (const slug in oauthStates) {
    const s = oauthStates[slug];
    if (s.status === "success" && (!prev[slug] || prev[slug].status !== "success")) {
      const p = await msg({ action: "probe", slug }); probes[slug] = { ...p, at: Date.now() };
      loadConnections();
      setTimeout(async () => { await msg({ action: "oauthCancel", provider: slug }); delete oauthStates[slug]; renderOauth(); }, 3000);
    }
  }
  renderOauth();
  clearInterval(oauthTimer); oauthTimer = null;
  if (Object.values(oauthStates).some((s) => s.status === "pending")) oauthTimer = setInterval(refreshOauth, 3000);
}

// ── server status + state loading ───────────────────────────────────────────
function setFooter() {
  let g = 0, b = 0; for (const k in conns) { g += conns[k].good || 0; b += conns[k].bad || 0; }
  const health = `🔗 ${connTotal}${g ? ` · 🟢 ${g}` : ""}${b ? ` · 🔴 ${b}` : ""} · 127.0.0.1:20128`;
  $("ftrHint").textContent = !serverOnline ? t("popup_footerDown")
    : connUnreachable ? t("popup_footerUnreadable")
    : connTotal ? health
    : t("popup_footerLogin");
  document.body.classList.toggle("offline", !serverOnline);
}
async function probeServer() {
  const dot = $("srvDot"), txt = $("srvTxt");
  // Reachability MUST go through the dashboard tab (runInDash via the background "ping"), NOT a direct
  // fetch: Firefox blocks a direct http fetch from the extension's secure moz-extension context to the
  // http loopback server as mixed content (Chrome exempts loopback). The tab path is http→http.
  const r = await msg({ action: "ping" }).catch(() => null);
  if (r && r.ok) { serverOnline = true; dot.className = "dot ok"; txt.textContent = "127.0.0.1:20128"; }
  else { serverOnline = false; dot.className = "dot bad"; txt.textContent = t("popup_srvDown"); }
  setFooter();
}
async function detectActiveTab() {
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) { const p = OMNI_WEB.find((x) => x.hostRe.test(tab.url)); activeProviderKey = p ? p.key : null; }
  } catch {}
}
async function fetchConnections() {
  const c = await msg({ action: "connections" });
  conns = (c && c.byProvider) || {};
  connTotal = (c && c.total) || 0;
  problems = (c && c.problems) || [];
  allConns = (c && c.all) || [];
  connUnreachable = !!(c && c.unreachable);
}
// Dead/banned connections that need attention — with re-capture (open site) and delete.
function renderProblems() {
  const box = $("webProblems"); box.textContent = "";
  // Merge OmniRoute's testStatus-based problems with our OWN honest probe verdicts: /test can report
  // "active" on a connection that fails a real completion, so a 🔴 probe on a provider that isn't
  // already flagged joins the attention list too (prefer the honest signal).
  const merged = problems.map((p) => ({ ...p }));
  const seen = new Set(problems.map((p) => p.provider));
  for (const slug in probes) {
    if (probes[slug] && probes[slug].alive === false && conns[slug] && conns[slug].total && !seen.has(slug)) {
      merged.push({ provider: slug, id: null, name: null, probe: probes[slug] });
      seen.add(slug);
    }
  }
  if (!merged.length) return;
  const ttl = el("div", "grp-title bad", t("web_attention")); ttl.append(el("span", "n", String(merged.length)));
  let pushed = false;
  const webProbs = merged.filter((m) => OMNI_WEB_MAP[m.provider]);
  if (webProbs.length > 1) {
    const openAll = el("button", "ghost sm", t("web_loginAll")); openAll.style.marginLeft = "auto"; pushed = true;
    openAll.title = t("web_loginAllTitle");
    openAll.onclick = () => { for (const m of webProbs) chrome.tabs.create({ url: loginTarget(OMNI_WEB_MAP[m.provider]) }); };
    ttl.append(openAll);
  }
  const withId = merged.filter((m) => m.id);
  if (withId.length > 1) { const delAll = el("button", "ghost sm danger", t("popup_deleteAll")); if (!pushed) delAll.style.marginLeft = "auto"; wireDeleteAll(delAll, withId); ttl.append(delAll); }
  box.append(ttl);
  for (const pr of merged) {
    const wp = OMNI_WEB_MAP[pr.provider];
    const oa = OMNI_OAUTH_MAP[pr.provider];
    const label = providerLabel(pr.provider);
    const row = el("div", "prob");
    const info = el("div", "prob-info");
    const pn = el("div", "prob-name", pr.name || t("popup_noName")); if (pr.name) pn.title = pr.name; info.append(pn);
    info.append(el("div", "prob-sub", `🔴 ${label} · ${pr.provider}` + (pr.probe && pr.probe.detail ? " · " + String(pr.probe.detail).slice(0, 50) : "")));
    row.append(info);
    if (wp) { const open = el("button", "ghost sm", t("web_loginAgain")); open.title = t("web_loginAgainTitle"); open.onclick = () => chrome.tabs.create({ url: loginTarget(wp) }); row.append(open); }
    else if (oa && oa.deviceFlow && !oa.broken) { const rc = el("button", "ghost sm", t("oauth_reconnect")); rc.onclick = () => { const tb = document.querySelector('.tab[data-pane="oauth"]'); if (tb) tb.click(); startOauth(oa.slug); }; row.append(rc); }
    if (pr.id) connActions(row, info, pr, renderProblems);
    box.append(row);
  }
}
// Shared per-connection management actions — rename inline (no blocking prompt), enable/disable,
// delete. Used by BOTH the attention band and the full connections manager. `conn` = {id,name,isActive};
// `rerender` re-runs the caller's own render (to restore the row when a rename is cancelled).
function connActions(row, info, conn, rerender) {
  const ren = el("button", "ghost sm", "✎"); ren.title = t("popup_renameTitle"); ren.setAttribute("aria-label", t("popup_rename"));
  ren.onclick = () => {
    const inp = el("input"); inp.type = "text"; inp.value = conn.name || ""; inp.style.margin = "0";
    const save = el("button", "sm", "✓"); save.title = t("popup_saveName");
    save.onclick = async () => { const nn = inp.value.trim(); if (nn && nn !== conn.name) { const r = await msg({ action: "updateConn", id: conn.id, patch: { name: nn } }); if (r && r.ok) { loadConnections(); return; } } rerender(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); if (e.key === "Escape") rerender(); });
    info.textContent = ""; info.append(inp, save); inp.focus();
  };
  // Enable/disable this connection (OmniRoute stops routing to a disabled one — keep it without deleting).
  const tog = el("button", "ghost sm", conn.isActive === false ? t("popup_enable") : t("popup_disable"));
  tog.title = t("popup_toggleTitle");
  tog.onclick = async () => { tog.disabled = true; const r = await msg({ action: "updateConn", id: conn.id, patch: { isActive: conn.isActive === false } }); if (r && r.ok) loadConnections(); else { tog.disabled = false; tog.textContent = t("popup_error"); } };
  const del = el("button", "ghost sm danger", t("popup_delete")); wireDelete(del, conn.id, row);
  row.append(ren, tog, del);
}
// Full connections manager (collapsible, in the global band): rename/enable-disable/delete ANY
// connection, not just the broken ones the attention band surfaces. Bulk management of 50+ stays in
// the dashboard — this is quick edits without leaving the popup. Reuses connActions (same plumbing).
let manageOpen = false;
function renderManage() {
  const box = $("manageSection"); if (!box) return;
  box.textContent = "";
  if (!allConns.length) return; // nothing to manage (or connections unreadable — footer already says so)
  const head = el("button", "manage-head", t("popup_manageAll"));
  head.append(el("span", "n", String(allConns.length)), el("span", "chev", manageOpen ? "▾" : "▸"));
  head.setAttribute("aria-expanded", manageOpen ? "true" : "false");
  head.onclick = () => { manageOpen = !manageOpen; renderManage(); };
  box.append(head);
  if (!manageOpen) return;
  const byProv = {};
  for (const c of allConns) (byProv[c.provider] = byProv[c.provider] || []).push(c);
  for (const slug of Object.keys(byProv).sort()) {
    const label = providerLabel(slug);
    const ttl = el("div", "grp-title", label); ttl.append(el("span", "n", String(byProv[slug].length))); box.append(ttl);
    for (const c of byProv[slug]) {
      const bad = c.hasError || c.testStatus === "banned" || c.testStatus === "error";
      const row = el("div", "prob" + (bad ? "" : " okrow"));
      const info = el("div", "prob-info");
      const pn = el("div", "prob-name", c.name || t("popup_noName")); if (c.name) pn.title = c.name; info.append(pn);
      const state = c.isActive === false ? t("popup_stateOff") : bad ? t("popup_stateBad") : t("popup_stateOk");
      info.append(el("div", "prob-sub", `${state} · ${c.provider}`));
      row.append(info);
      connActions(row, info, c, renderManage);
      box.append(row);
    }
  }
}
// Two-step inline confirm (no blocking dialog): first click arms, a second within 3s runs onConfirm.
function armConfirm(btn, idleLabel, armedLabel, onConfirm) {
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (btn.dataset.armed) { btn.textContent = t("popup_deleting"); btn.disabled = true; await onConfirm(); return; }
    btn.dataset.armed = "1"; btn.textContent = armedLabel; btn.classList.add("armed");
    setTimeout(() => { if (btn.dataset.armed) { btn.dataset.armed = ""; btn.textContent = idleLabel; btn.classList.remove("armed"); } }, 3000);
  };
}
function wireDelete(btn, id, row) {
  armConfirm(btn, t("popup_delete"), t("popup_deleteConfirm"), async () => {
    const r = await msg({ action: "deleteConn", id });
    if (r && r.ok) { row.remove(); loadConnections(); }
    else { btn.disabled = false; btn.textContent = t("popup_error"); }
  });
}
function wireDeleteAll(btn, items) {
  armConfirm(btn, t("popup_deleteAll"), t("popup_deleteAllConfirm", [String(items.length)]), async () => {
    for (const it of items) await msg({ action: "deleteConn", id: it.id });
    loadConnections();
  });
}
// After an add/probe — refresh live counts on the web + api-key views (oauth keeps its own state).
async function loadConnections() {
  await fetchConnections();
  $("probeAllBtn").disabled = !connTotal;
  setFooter(); renderProblems(); renderManage(); renderWeb(); keyPaneFill();
}
// Batch health check of every provider that has a live connection — with live progress + ETA.
let probeStart = 0;
async function runProbeAll() {
  const slugs = Object.keys(conns);
  const btn = $("probeAllBtn"), res = $("probeAllRes"), prog = $("probeProg"), bar = $("probeProgBar");
  if (!slugs.length) { res.className = "res show mut"; res.textContent = t("popup_noConns"); return; }
  btn.disabled = true; prog.classList.remove("hide"); bar.style.width = "0%"; probeStart = Date.now();
  res.className = "res show pend"; res.textContent = t("popup_probingN", ["0", String(slugs.length)]);
  const r = await msg({ action: "probeAll", slugs });
  const results = (r && r.results) || {};
  for (const k in results) probes[k] = { ...results[k], at: Date.now() };
  const vals = Object.values(results);
  const good = vals.filter((v) => v.alive === true).length;
  const bad = vals.filter((v) => v.alive === false).length;
  bar.style.width = "100%";
  res.className = "res show " + (bad ? "bad" : "ok");
  res.textContent = t("popup_probeAllDone", [String(good), String(bad), String(slugs.length - good - bad)]);
  setTimeout(() => prog.classList.add("hide"), 900);
  btn.disabled = false;
  renderWeb(); keyPaneFill(); renderProblems();
}
function onProbeProgress(m) {
  const bar = $("probeProgBar"), res = $("probeAllRes");
  bar.style.width = Math.round((m.done / m.total) * 100) + "%";
  const el2 = m.done ? (Date.now() - probeStart) / 1000 : 0;
  const eta = m.done && m.done < m.total ? Math.max(1, Math.round((el2 / m.done) * (m.total - m.done))) : 0;
  const label = providerLabel(m.slug);
  res.className = "res show pend";
  res.textContent = t("popup_probingWith", [String(m.done), String(m.total), label]) + (eta ? " · " + t("popup_probeEta", [String(eta)]) : "");
}
async function refresh() {
  const r = await msg({ action: "getAll" });
  caps = (r && r.caps) || {};
  // Include accountId+timestamp so a re-capture (same provider, DIFFERENT account) also re-renders
  // (else the update-vs-new label + age stay stale until the 15s force-refresh).
  const sig = OMNI_WEB.filter((p) => caps[p.key]).map((p) => `${p.key}:${caps[p.key].accountId || ""}:${caps[p.key].at}`).sort().join(",");
  if (sig !== lastWebSig) { if (renderWeb() !== false) lastWebSig = sig; } // commit sig only if a render actually ran (not bailed on focus)
  refreshAistudio();
}

let stored = {};
$("openDash").addEventListener("click", () => chrome.tabs.create({ url: OMNI_BASE + "/home" }));
$("probeAllBtn").addEventListener("click", runProbeAll);
chrome.runtime.onMessage.addListener(async (m) => {
  if (!m) return;
  if (m.type === "probeProgress") onProbeProgress(m);
  else if (m.type === "healthSwept") { const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {}; renderProblems(); renderWeb(); keyPaneFill(); } // live-refresh verdicts after an unattended sweep
});

// ── settings panel ───────────────────────────────────────────────────────────
function applyTheme(t) { const r = document.documentElement; if (t === "light" || t === "dark") r.dataset.theme = t; else delete r.dataset.theme; } // "auto" → follow system
async function loadSettings() {
  const { settings } = (await msg({ action: "getSettings" })) || {};
  const s = settings || { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true };
  $("setSweep").checked = !!s.sweep;
  $("setSweepMin").value = String(s.sweepMin || 15);
  $("setNotify").checked = !!s.notify;
  $("setPersist").checked = s.persistSessions !== false; // default on
  renderSweepSkip(s.sweepSkip || []);
  $("setTheme").value = s.theme || "auto"; applyTheme(s.theme);
  try { $("setVer").textContent = "v" + chrome.runtime.getManifest().version; } catch (e) {}
  $("setSummary").textContent = connTotal
    ? t("set_summaryConns", [String(connTotal), String(Object.keys(conns).length)])
    : t("set_summaryCatalog", [String(OMNI_WEB.length), String(OMNI_APIKEY.length), String(OMNI_OAUTH.length)]);
  const { last_sweep, last_recovery: rec } = await chrome.storage.local.get(["last_sweep", "last_recovery"]);
  $("lastSweep").textContent = last_sweep ? t("set_lastSweep", [ago(last_sweep)]) : t("set_noSweep");
  // restartRecovery runs unattended at browser launch — say what it did, or you can't tell it ran.
  $("lastRecovery").textContent = !rec
    ? t("set_noRecovery")
    : rec.unreachable
      ? t("set_recoveryUnreachable", [ago(rec.at)])
      : t("set_recoveryDone", [String(rec.restored), ago(rec.at)]) + (rec.purged ? " · " + t("set_recoveryPurged", [String(rec.purged)]) : "");
}
// One chip per provider the background sweep would probe (i.e. the ones with connections — exactly
// what conn_slugs feeds it). Struck-through = opted out. Toggling saves only sweepSkip; applySettings
// merges it into the rest, so this can't clobber the checkboxes above.
function renderSweepSkip(skip) {
  const box = $("sweepSkipChips"); box.textContent = "";
  const slugs = Object.keys(conns).sort();
  if (!slugs.length) { box.append(el("span", "hint-sm", t("set_skipEmpty"))); return; }
  const set = new Set(skip);
  for (const slug of slugs) {
    const off = set.has(slug);
    const c = el("button", "chip" + (off ? " off" : ""), providerLabel(slug));
    c.title = off ? t("set_skipOffTitle") : t("set_skipOnTitle");
    c.setAttribute("aria-pressed", String(off));
    c.onclick = async () => {
      const next = off ? [...set].filter((x) => x !== slug) : [...set, slug];
      const r = await msg({ action: "setSettings", settings: { sweepSkip: next } });
      renderSweepSkip((r && r.settings && r.settings.sweepSkip) || next);
    };
    box.append(c);
  }
}
function saveSettings() {
  applyTheme($("setTheme").value);
  msg({ action: "setSettings", settings: { sweep: $("setSweep").checked, sweepMin: parseInt($("setSweepMin").value, 10) || 15, notify: $("setNotify").checked, theme: $("setTheme").value, persistSessions: $("setPersist").checked } });
}
function initSettings() {
  $("settingsBtn").addEventListener("click", () => { const p = $("settingsPanel"); p.classList.toggle("hide"); if (!p.classList.contains("hide")) { loadSettings(); $("setSweep").focus(); } });
  for (const id of ["setSweep", "setSweepMin", "setNotify", "setPersist", "setTheme"]) $(id).addEventListener("change", saveSettings);
  $("sweepNowBtn").addEventListener("click", async () => {
    const b = $("sweepNowBtn"); b.disabled = true; b.textContent = t("set_sweeping");
    const r = await msg({ action: "sweepNow" });
    if (r && r.ran === false) { b.textContent = t("set_sweepBusy"); setTimeout(() => { b.disabled = false; b.textContent = t("set_sweepNow"); }, 1500); return; }
    const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {};
    await loadConnections(); await loadSettings();
    b.disabled = false; b.textContent = t("set_sweepNow");
  });
  $("clearProbesBtn").addEventListener("click", async () => { await msg({ action: "clearProbes" }); probes = {}; await loadConnections(); loadSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settingsPanel").classList.contains("hide")) { $("settingsPanel").classList.add("hide"); $("settingsBtn").focus(); } }); // Esc closes settings, focus back to gear
  // Backup: download the connection roster as JSON. Names only (which carry a hashed accountId) —
  // no cookies/tokens/keys ever leave (those never reach the popup in the first place).
  $("exportBtn").addEventListener("click", () => {
    const rows = [];
    for (const slug in conns) for (const name of (conns[slug].names || [])) rows.push({ provider: slug, name });
    const data = { exportedFrom: "OmniRoute Bridge", version: chrome.runtime.getManifest().version, total: connTotal, byProvider: conns, connections: rows };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "omniroute-connections.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}
initSettings();

// Detach into a standalone window so the popup stays open while you switch tabs.
const windowed = new URLSearchParams(location.search).get("window") === "1";
if (windowed) {
  $("detachBtn").classList.add("hide");
  document.documentElement.style.height = "100vh";
  Object.assign(document.body.style, { height: "100vh", width: "100%", maxWidth: "none" }); // fill + follow resize
} else {
  $("detachBtn").addEventListener("click", () => {
    chrome.windows.create({ url: chrome.runtime.getURL("popup.html?window=1"), type: "popup", width: 440, height: 660 }, () => window.close());
  });
}

(async () => {
  chrome.storage.local.set({ last_active: Date.now() }); // gate the unattended health sweep to recent use
  msg({ action: "getSettings" }).then((r) => applyTheme(r && r.settings && r.settings.theme)); // apply saved theme ASAP
  stored = await chrome.storage.local.get(["sel_apikey", "sel_tab"]);
  const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {};
  await detectActiveTab();
  initKeyPane();
  await refresh();
  await probeServer();
  if (serverOnline) { await fetchConnections(); $("probeAllBtn").disabled = !connTotal; }
  renderOauth();          // now conn counts are available for the device cards
  setFooter(); renderProblems(); renderManage(); renderWeb(); keyPaneFill();
  // Restore last tab UNLESS we're on a provider site with a capture ready (then the web/capture flow wins).
  if (stored.sel_tab && stored.sel_tab !== "web" && !(activeProviderKey && caps[activeProviderKey])) {
    const tb = document.querySelector('.tab[data-pane="' + stored.sel_tab + '"]'); if (tb) selectTab(tb);
  }
  refreshOauth();         // pick up any device-flow left pending from a previous popup session
})();
// Push-based capture refresh: react the instant the SW writes a new session, instead of a tight 3s
// poll that re-scanned all of session storage every tick. Slow fallback keeps timestamps ("Nмин назад") fresh.
const debouncedRefresh = debounce(refresh, 150);
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith("cap_") || k === "apikey_aistudio")) debouncedRefresh();
});
setInterval(() => { lastWebSig = null; refresh(); }, 15000); // force a re-render so "N мин назад" / stale-amber advance
