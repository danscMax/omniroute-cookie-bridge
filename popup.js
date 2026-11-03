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
// Where to send someone whose session died: the SITE. The catalog's generated loginUrls rot (perplexity.ai
// /login is a 404 since 2026-11) and a logged-in user lands on the app from the homepage anyway.
const loginTarget = (w) => (w && w.site) || "";
// One label lookup across the three registries (a slug lives in exactly one of them).
const providerLabel = (slug) => ((OMNI_WEB_MAP[slug] || OMNI_OAUTH_MAP[slug] || OMNI_APIKEY_MAP[slug] || {}).label) || slug;

// Firefox MV3 grants host_permissions on an ad-hoc basis, and NOT on an update that changed the set —
// so access to 127.0.0.1 can be missing even though the manifest declares it, and executeScript into the
// dashboard tab then fails with "Missing host permission for the tab". Chrome auto-grants, so contains()
// is true there and the banner never shows. permissions.request() must run from a user gesture (the
// button), per the MDN permissions API.
// Portless — a match pattern WITH a port matches nothing in Firefox (bugs 1362809/1468162), so a granted
// http://127.0.0.1:20128/* never authorised executeScript into the dashboard tab. http://127.0.0.1/* matches any port.
const HOST_ORIGINS = ["http://127.0.0.1/*"];
async function hasHostAccess() {
  try { return await chrome.permissions.contains({ origins: HOST_ORIGINS }); } catch { return true; } // no permissions API → assume ok
}
async function refreshHostBanner() {
  // Firefox-only problem: Chrome grants the manifest's host access itself, and its optional portless
  // pattern reads as "not granted" there — the banner would nag Chrome users about Firefox.
  const ok = !/Firefox\//.test(navigator.userAgent) || await hasHostAccess();
  $("permBanner").classList.toggle("hide", ok);
  return ok;
}
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
// Rail navigation: every section is a pane; the rail buttons are a vertical WAI-ARIA tablist.
const PANES = ["dash", "wizard", "web", "key", "oauth", "table", "chat", "set"];
const PANE_TITLE = { dash: "nav_dash", wizard: "nav_wizard", web: "nav_web", key: "nav_key", oauth: "nav_oauth", table: "nav_table", chat: "nav_chat", set: "popup_settings" };
const tabEls = [...document.querySelectorAll(".rail .tab")];
let curPane = "dash";
function selectTab(tb) {
  curPane = tb.dataset.pane;
  tabEls.forEach((x) => { const on = x === tb; x.classList.toggle("on", on); x.setAttribute("aria-selected", on ? "true" : "false"); });
  for (const pane of PANES) $("pane-" + pane).classList.toggle("hide", pane !== curPane);
  $("viewTitle").textContent = t(PANE_TITLE[curPane]);
  // The global search only means something on the catalog panes; hide it elsewhere so the view breathes.
  document.querySelector(".gsearch").classList.toggle("hide", !["web", "key", "oauth"].includes(curPane));
  if (curPane === "wizard") renderWizard();
  if (curPane === "table") renderTable();
  if (curPane === "chat") { fillChatProviders(); renderChat(); }
  if (curPane !== "set") chrome.storage.local.set({ sel_tab: curPane }); // remember across opens
  $("scroll").scrollTop = 0;
}
const goPane = (p) => { const tb = tabEls.find((x) => x.dataset.pane === p); if (tb) selectTab(tb); };
tabEls.forEach((tb, i) => {
  tb.addEventListener("click", () => selectTab(tb));
  tb.addEventListener("keydown", (e) => { // ↑/↓ roving between rail items (vertical tablist)
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
    const next = tabEls[(i + (fwd ? 1 : tabEls.length - 1)) % tabEls.length];
    next.focus(); selectTab(next);
  });
});
// Keyboard shortcuts (ignored while typing in a field): 1..6 jump to a section, "/" focuses the search.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // don't hijack Ctrl+1 etc.
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const idx = parseInt(e.key, 10) - 1;
  if (idx >= 0 && idx < 7 && tabEls[idx]) { tabEls[idx].click(); return; }
  if (e.key === "/") {
    if (!["web", "key", "oauth"].includes(curPane)) goPane("web");
    e.preventDefault(); $("globalSearch").focus();
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
  setRes(resEl, "pend", r.updated && r.connName ? t("popup_updatedProbing", [r.connName]) : t("popup_addedProbing", [r.id ? ` (${r.id.slice(0, 8)}…)` : ""]));
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
  if (cap.email) card.append(el("div", "conns", "👤 " + cap.email)); // which account this is (from the session JWT)
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
  // The SW decides which connection this session refreshes (same account id / the one this browser
  // feeds / the only one) — ask it, and SAY which one, so the user sees what gets overwritten.
  let slotConn = null;
  const asNew = el("button", "ghost sm hide", t("web_asNew")); asNew.title = t("web_asNewTitle");
  actions.insertBefore(asNew, probe);
  function sync() {
    const upd = !!slotConn;
    send.textContent = upd ? t("popup_update") : (hasOther ? t("web_addAccount") : t("web_send"));
    send.classList.toggle("upd", upd);
    asNew.classList.toggle("hide", !upd);
    predict.className = "predict " + (upd ? "upd" : "new");
    predict.textContent = upd ? t("web_predictUpdName", [slotConn.name]) : t("popup_predictNew");
  }
  sync();
  msg({ action: "slotFor", providerKey: p.key }).then((r) => { slotConn = (r && r.conn) || null; sync(); });
  asNew.onclick = async () => {
    asNew.disabled = true;
    const r = await addAndProbe(res, () => msg({ action: "send", providerKey: p.key, name: input.value.trim() || p.label, forceNew: true }), probe);
    asNew.disabled = false;
    if (r && r.ok) setTimeout(refresh, 2500);
  };
  if (probes[p.slug]) { showProbe(res, null, probes[p.slug], false); probe.onclick = () => reprobe(res, p.slug, null, probe); }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send.click(); });
  send.addEventListener("click", async () => {
    send.disabled = true;
    const r = await addAndProbe(res, () => msg({ action: "send", providerKey: p.key, name: input.value.trim() || p.label }), probe);
    if (r && r.ok) { send.textContent = "✓ " + t("web_sentDone"); setTimeout(refresh, 2500); } // sent → the card leaves "ready to send"
    else send.disabled = false;
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
  const capd = OMNI_WEB.filter((p) => caps[p.key] && !(sentAt[p.key] >= caps[p.key].at) && match(p))
    .sort((a, b) => (a.key === activeProviderKey ? -1 : b.key === activeProviderKey ? 1 : 0));
  $("bWeb").textContent = String(OMNI_WEB.filter((p) => caps[p.key]).length);
  if (capd.length) {
    const ttl = el("div", "grp-title", t("web_readyTitle")); ttl.append(el("span", "n", String(capd.length))); cap.append(ttl);
    if (capd.length > 1) {
      // Predict how many of the batch will UPDATE an existing connection vs CREATE a new one.
      const all = el("button", "bulk", t("web_sendAll", [String(capd.length)]));
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
  setTimeout(() => { lastWebSig = null; refresh(); }, 1200); // re-read sent markers → sent cards leave the list
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
    // Say what to do on that page — the user doesn't remember each console's menu.
    box.append(el("p", "hint-sm steps", p.deepLink ? t("key_stepsDeep") : t("key_stepsHome")));
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
// Global search above the tabs: mirror its value into each pane's own search input (the renderers'
// value-source) and re-render all three panes, so one box filters Web + API-key + OAuth at once.
$("globalSearch").addEventListener("input", debounce(() => {
  const v = $("globalSearch").value;
  for (const id of ["webSearch", "keySearch", "oauthSearch"]) { const e = $(id); if (e) e.value = v; }
  renderWeb(); keyPaneFill(); renderOauth();
}, 140));
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
  // Show the real reason (from runInDash: tab open / injection / timeout) instead of a bare "недоступен".
  else { serverOnline = false; dot.className = "dot bad"; txt.textContent = (r && r.detail) ? "127.0.0.1:20128 — " + r.detail : t("popup_srvDown"); }
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
    const pn = el("div", "prob-name", pr.name || label); pn.title = pr.name || label; info.append(pn);
    const pv = pr.probe || probes[pr.provider];
    info.append(el("div", "prob-sub", `🔴 ${pr.name ? label + " · " : ""}${humanErr(pv)}` + (pv && pv.detail ? " — " + String(pv.detail).slice(0, 60) : "")));
    info.classList.add("click"); info.title = t("row_open");
    info.onclick = () => { if (expanded.has("p:" + pr.provider)) expanded.delete("p:" + pr.provider); else expanded.add("p:" + pr.provider); renderProblems(); };
    row.append(info);
    if (wp) { const open = el("button", "ghost sm", t("web_loginAgain")); open.title = t("web_loginAgainTitle"); open.onclick = () => loginAgain(pr.provider, open); row.append(open); }
    else if (oa && oa.deviceFlow && !oa.broken) { const rc = el("button", "ghost sm", t("oauth_reconnect")); rc.onclick = () => { const tb = document.querySelector('.tab[data-pane="oauth"]'); if (tb) tb.click(); startOauth(oa.slug); }; row.append(rc); }
    if (pr.id) connActions(row, info, pr, renderProblems);
    else {
      // No OmniRoute connection id to delete — this is a stale local probe verdict. Give it a dismiss
      // so it can be cleared from the attention band (previously id-less items had no delete at all).
      const dis = el("button", "ghost sm danger", t("popup_delete"));
      dis.title = t("web_dismissTitle");
      dis.onclick = () => { delete probes[pr.provider]; msg({ action: "clearProbe", slug: pr.provider }); renderProblems(); };
      row.append(dis);
    }
    box.append(row);
    const lastOfProv = !merged.slice(merged.indexOf(pr) + 1).some((m) => m.provider === pr.provider);
    if (lastOfProv && expanded.has("p:" + pr.provider)) { const r = providerRows().find((x) => x.slug === pr.provider); if (r) box.append(provDetail(r)); }
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
  setFooter(); renderAll();
}
// Batch health check of every provider that has a live connection — with live progress + ETA.
let probeStart = 0;
async function runProbeAll() {
  const slugs = Object.keys(conns);
  const btn = $("probeAllBtn"), res = $("probeAllRes"), prog = $("probeProg"), bar = $("probeProgBar");
  if (!slugs.length) { res.className = "res show mut"; res.textContent = t("popup_noConns"); return; }
  btn.disabled = true; prog.classList.remove("hide"); bar.style.width = "0%"; probeStart = Date.now();
  res.className = "res show pend"; res.textContent = t("popup_probingN", ["0", String(slugs.length)]);
  msg({ action: "siteCheck", keys: slugs.filter((s) => OMNI_WEB_MAP[s]) }).then((r) => { if (r && r.sites) Object.assign(sites, r.sites); }); // site up? runs alongside
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
  await loadStats(false); renderAll();
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
let sentAt = {}; // web key → when its current capture was last pushed (a sent capture isn't "ready to send")
async function refresh() {
  const r = await msg({ action: "getAll" });
  caps = (r && r.caps) || {};
  const loc = await chrome.storage.local.get(OMNI_WEB.map((p) => "sent_" + p.key));
  sentAt = {}; for (const p of OMNI_WEB) if (loc["sent_" + p.key]) sentAt[p.key] = loc["sent_" + p.key];
  // Include accountId+timestamp so a re-capture (same provider, DIFFERENT account) also re-renders
  // (else the update-vs-new label + age stay stale until the 15s force-refresh).
  const sig = OMNI_WEB.filter((p) => caps[p.key]).map((p) => `${p.key}:${caps[p.key].accountId || ""}:${caps[p.key].at}:${sentAt[p.key] || ""}`).sort().join(",");
  if (sig !== lastWebSig) { if (renderWeb() !== false) lastWebSig = sig; } // commit sig only if a render actually ran (not bailed on focus)
  refreshAistudio();
}

// ── stats shared by Pulse / Wizard / Table ──────────────────────────────────
let hist = {};        // slug → [{at, a: alive, ms}] (7 days)
let sites = {};       // web key → {up, ms, at}
let expiry = {};      // web key → earliest session-cookie expiry (ms)
let omniVer = null;   // {current, latest, updateAvailable}
let dashFilter = "all", tableFilter = "all";
const tableSel = new Set();
let wizImport = [], wizIgnore = [], wizMode = "all";
const wizSkip = new Set();
const DAY = 24 * 60 * 60 * 1000;

// "retired" ONLY for providers OmniRoute itself removed (docs/reference/REMOVED_PROVIDERS.md). Being absent
// from this extension's catalog proves nothing: zai-web merely lost in-app cookie capture and github-models
// is a normal live connection — calling those "removed" offered to delete working connections.
const RETIRED = new Set(["qwen-web", "chatgpt-web"]);
const kindOf = (slug) => RETIRED.has(slug) ? "retired" : OMNI_WEB_MAP[slug] ? "web" : OMNI_OAUTH_MAP[slug] ? "oauth" : OMNI_APIKEY_MAP[slug] ? "key" : "other";
const KIND_LABEL = { web: () => t("kind_web"), key: () => t("kind_key"), oauth: () => t("kind_oauth"), retired: () => t("kind_retired"), other: () => t("kind_other") };
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? ms + t("unit_ms") : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + t("unit_s"));
const isBadConn = (c) => c.hasError || c.testStatus === "banned" || c.testStatus === "error";

// One row per provider that has connections — the unit Pulse/Table/Wizard reason about.
function providerRows() {
  const now = Date.now();
  return Object.keys(conns).map((slug) => {
    const c = conns[slug], pr = probes[slug], kind = kindOf(slug);
    const h = hist[slug] || [];
    const site = kind === "web" ? sites[slug] : null;
    const exp = kind === "web" ? expiry[slug] : null;
    const expDays = exp ? (exp - now) / DAY : null;
    const dead = (c.bad > 0) || (pr && pr.alive === false);
    const warns = [];
    if (expDays != null && expDays < 3) warns.push("exp");
    if (site && site.up === false) warns.push("site");
    if (pr && pr.ms > 20000) warns.push("slow");
    const status = kind === "retired" ? "retired" : dead ? "bad" : warns.length ? "warn" : pr && pr.alive === true ? "ok" : "unk";
    return { slug, kind, label: providerLabel(slug), total: c.total, good: c.good, bad: c.bad, pr, h, site, exp, expDays, warns, status, free: !!(OMNI_APIKEY_MAP[slug] && OMNI_APIKEY_MAP[slug].free) };
  });
}
const FILTERS = [
  ["all", () => t("flt_all"), () => true],
  ["bad", () => t("flt_bad"), (r) => r.status === "bad" || r.status === "retired"],
  ["warn", () => t("flt_warn"), (r) => r.status === "warn"],
  ["web", () => t("flt_web"), (r) => r.kind === "web"],
  ["key", () => t("flt_key"), (r) => r.kind === "key"],
  ["oauth", () => t("flt_oauth"), (r) => r.kind === "oauth"],
  ["free", () => t("flt_free"), (r) => r.free],
];
function renderFilters(box, cur, rows, onPick) {
  box.textContent = "";
  for (const [id, key, fn] of FILTERS) {
    const n = rows.filter(fn).length;
    if (id !== "all" && id !== cur && !n) continue; // an empty filter is noise
    const b = el("button", "chip" + (id === cur ? " on" : ""));
    b.append(document.createTextNode(key()), el("span", "cn", String(n)));
    b.setAttribute("aria-pressed", String(id === cur));
    b.onclick = () => onPick(id);
    box.append(b);
  }
}
const filterFn = (id) => (FILTERS.find((f) => f[0] === id) || FILTERS[0])[2];
function spark(h) {
  const s = el("span", "spark"); s.setAttribute("aria-hidden", "true");
  const last = h.slice(-7);
  for (let i = 0; i < 7 - last.length; i++) s.append(el("i", "u"));
  for (const x of last) s.append(el("i", x.a === false ? "x" : x.a === true ? "" : "u"));
  return s;
}
function expText(r) {
  if (r.expDays == null) return "";
  if (r.expDays < 0) return t("exp_gone");
  return r.expDays < 1 ? t("exp_hours", [String(Math.max(1, Math.round(r.expDays * 24)))]) : t("exp_days", [String(Math.round(r.expDays))]);
}
function rowMeta(r) {
  if (r.status === "retired") return [t("kind_retired"), "bad"];
  if (r.status === "bad") return [humanErr(r.pr), "bad"];
  if (r.warns.includes("site")) return [t("site_down"), "warn"];
  if (r.warns.includes("exp")) return [t("exp_soon", [expText(r)]), "warn"];
  if (r.warns.includes("slow")) return [t("probe_slow", [fmtMs(r.pr.ms)]), "warn"];
  if (r.pr && r.pr.alive === true) return [fmtMs(r.pr.ms), ""];
  return [t("probe_never"), ""];
}
// A probe verdict in words a human acts on (401 → "вход истёк", 429 → "лимит" …).
function humanErr(pr) {
  if (!pr) return t("err_flagged");
  const st = pr.status, d = String(pr.detail || "");
  if (st === 401 || st === 403 || /unauthori|forbidden|login|expired/i.test(d)) return t("err_auth");
  if (st === 429) return t("err_limit");
  if (st >= 500) return t("err_upstream");
  if (/timeout|abort/i.test(d)) return t("err_timeout");
  return d ? d.slice(0, 40) : t("err_flagged");
}

// ── Pulse ───────────────────────────────────────────────────────────────────
function renderDash() {
  const rows = providerRows();
  const live = rows.filter((r) => r.status === "ok" || r.status === "warn" || r.status === "unk").length;
  const bad = rows.filter((r) => r.status === "bad" || r.status === "retired").length;
  $("dashOk").textContent = rows.length ? `${live}/${rows.length}` : "—";
  $("dashBad").textContent = bad ? t("dash_broken", [String(bad)]) : "";
  $("dashMeter").style.width = rows.length ? Math.round((live / rows.length) * 100) + "%" : "0%";
  const sub = $("dashSub"); sub.textContent = "";
  sub.append(el("span", null, t("dash_conns", [String(connTotal)])));
  if (omniVer && omniVer.current) {
    sub.append(el("span", null, "OmniRoute v" + omniVer.current));
    if (omniVer.updateAvailable && omniVer.latest) {
      const u = el("span", "upd", t("dash_update", [omniVer.latest]));
      u.title = t("dash_updateTitle");
      u.onclick = () => chrome.tabs.create({ url: OMNI_BASE + "/dashboard/settings" });
      sub.append(u);
    }
  }
  const lastAt = Math.max(0, ...Object.values(probes).map((p) => p.at || 0));
  if (lastAt) sub.append(el("span", null, t("popup_checkedAgo", [ago(lastAt)])));
  const missing = missingWeb().length;
  $("fillMissingBtn").textContent = missing ? t("dash_fillMissingN", [String(missing)]) : t("dash_fillMissing");
  renderFilters($("dashFilters"), dashFilter, rows, (id) => { dashFilter = id; renderDash(); });
  renderCleanup();
  renderRefreshReport();
  const box = $("dashList"); box.textContent = "";
  const shown = rows.filter(filterFn(dashFilter)).filter((r) => r.status !== "bad"); // broken ones live in the attention band above
  const groups = [["warn", () => t("dash_grpWarn")], ["ok", () => t("dash_grpOk")], ["unk", () => t("dash_grpUnk")]];
  for (const [st, key] of groups) {
    const g = shown.filter((r) => r.status === st).sort((a, b) => a.label.localeCompare(b.label));
    if (!g.length) continue;
    const ttl = el("div", "grp-title", key()); ttl.append(el("span", "n", String(g.length))); box.append(ttl);
    for (const r of g) { box.append(provRow(r)); if (expanded.has(r.slug)) box.append(provDetail(r)); }
  }
  if (!rows.length && serverOnline && !connUnreachable) {
    const e = el("div", "empty"); e.append(el("b", null, t("dash_emptyTitle")), document.createElement("br"), document.createTextNode(t("dash_emptyHint")));
    box.append(e);
  }
  renderRail();
}
function provRow(r) {
  const row = el("div", "prow click " + (r.status === "warn" ? "warn" : "") + (expanded.has(r.slug) ? " open" : ""));
  row.tabIndex = 0; row.setAttribute("role", "button"); row.setAttribute("aria-expanded", String(expanded.has(r.slug)));
  row.title = t("row_open");
  const toggle = () => { if (expanded.has(r.slug)) expanded.delete(r.slug); else expanded.add(r.slug); renderAll(); };
  row.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
  row.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); toggle(); } });
  const nm = el("span", "pn", r.label); nm.title = `${r.label} · ${r.slug}`;
  row.append(nm, el("span", "pc", `${r.good || 0}/${r.total}`), spark(r.h));
  const [meta, cls] = rowMeta(r);
  row.append(el("span", "pm " + cls, meta));
  if (r.kind === "web") {
    const rf = el("button", "ibtn", "↻"); rf.title = t("row_refresh"); rf.setAttribute("aria-label", t("row_refresh"));
    rf.onclick = () => runRefresh([r.slug], rf);
    row.append(rf);
  }
  const pb = el("button", "ibtn", "🩺"); pb.title = t("row_probe"); pb.setAttribute("aria-label", t("row_probe"));
  pb.onclick = async () => { pb.disabled = true; const p = await msg({ action: "probe", slug: r.slug }); probes[r.slug] = { ...p, at: Date.now() }; await loadStats(false); renderAll(); };
  row.append(pb, el("span", "chev", expanded.has(r.slug) ? "▾" : "▸"));
  return row;
}
// Duplicates (same account twice), retired providers, connections dead for days — one cleanup card.
function cleanupInfo() {
  const dup = [], retired = [], longDead = [];
  const byAcc = {};
  for (const c of allConns) {
    const acc = (c.name || "").split(" · ").pop();
    if (acc && c.name.includes(" · ")) (byAcc[c.provider + "|" + acc] = byAcc[c.provider + "|" + acc] || []).push(c);
    if (kindOf(c.provider) === "retired") retired.push(c);
    else if (isBadConn(c)) {
      const h = hist[c.provider] || [];
      let since = null;
      for (let i = h.length - 1; i >= 0 && h[i].a === false; i--) since = h[i].at;
      if (since && Date.now() - since > 3 * DAY) longDead.push(c);
    }
  }
  for (const k in byAcc) {
    const g = byAcc[k]; if (g.length < 2) continue;
    const keep = g.find((c) => !isBadConn(c) && c.isActive !== false) || g[0];
    for (const c of g) if (c !== keep) dup.push(c);
  }
  return { dup, retired, longDead };
}
function renderCleanup() {
  const box = $("dashCleanup"); box.textContent = "";
  const { dup, retired, longDead } = cleanupInfo();
  const ids = [...new Set([...dup, ...retired, ...longDead].map((c) => c.id))];
  if (!ids.length) return;
  const card = el("div", "clean");
  const h = el("div", "clean-h", "🧹 " + t("clean_title"));
  h.append(el("span", "grow"));
  const go = el("button", "ghost sm danger", t("clean_go", [String(ids.length)]));
  armConfirm(go, t("clean_go", [String(ids.length)]), t("popup_deleteAllConfirm", [String(ids.length)]), async () => {
    for (const id of ids) await msg({ action: "deleteConn", id });
    loadConnections();
  });
  h.append(go); card.append(h);
  const ul = el("ul");
  if (dup.length) ul.append(el("li", null, t("clean_dup", [String(dup.length)])));
  if (retired.length) ul.append(el("li", null, t("clean_retired", [String(retired.length), [...new Set(retired.map((c) => c.provider))].join(", ")])));
  if (longDead.length) ul.append(el("li", null, t("clean_dead", [String(longDead.length)])));
  card.append(ul); box.append(card);
}

// ── Table ───────────────────────────────────────────────────────────────────
function renderTable() {
  const rows = providerRows();
  renderFilters($("tableFilters"), tableFilter, rows, (id) => { tableFilter = id; renderTable(); });
  const order = { bad: 0, retired: 0, warn: 1, unk: 2, ok: 3 };
  const shown = rows.filter(filterFn(tableFilter)).sort((a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label));
  for (const s of [...tableSel]) if (!rows.some((r) => r.slug === s)) tableSel.delete(s);
  const body = $("statBody"); body.textContent = "";
  for (const r of shown) {
    const tr = el("tr", (r.status === "bad" || r.status === "retired") ? "bad" : r.status === "warn" ? "warn" : "");
    if (tableSel.has(r.slug)) tr.classList.add("sel");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = tableSel.has(r.slug); cb.setAttribute("aria-label", r.label);
    const td0 = el("td", "c-sel"); td0.append(cb); tr.append(td0);
    const name = el("td", "c-name", r.label); name.title = r.slug; tr.append(name);
    tr.append(el("td", "c-wide mut", KIND_LABEL[r.kind]()));
    tr.append(el("td", r.bad ? "bad" : "", `${r.good || 0}/${r.total}`));
    tr.append(el("td", !r.site || r.site.up == null ? "mut" : r.site.up ? "ok" : "bad", !r.site || r.site.up == null ? "—" : r.site.up ? "✓" : "✗"));
    tr.append(el("td", r.expDays == null ? "mut" : r.expDays < 3 ? "warn" : "", r.expDays == null ? "—" : expText(r)));
    tr.append(el("td", r.pr && r.pr.ms > 20000 ? "warn" : "", fmtMs(r.pr && r.pr.ms)));
    const sp = el("td"); sp.append(spark(r.h)); tr.append(sp);
    tr.append(el("td", "c-wide " + (r.status === "bad" ? "bad" : "mut"), r.status === "bad" ? humanErr(r.pr) : "—"));
    const toggle = () => { if (tableSel.has(r.slug)) tableSel.delete(r.slug); else tableSel.add(r.slug); renderTable(); };
    tr.onclick = (e) => { if (e.target === cb || e.target.closest(".c-sel")) return; if (expanded.has(r.slug)) expanded.delete(r.slug); else expanded.add(r.slug); renderTable(); };
    td0.onclick = (e) => { if (e.target !== cb) toggle(); };
    cb.onchange = toggle;
    if (expanded.has(r.slug)) tr.classList.add("open");
    body.append(tr);
    if (expanded.has(r.slug)) { const dtr = el("tr", "dtr"); const dtd = el("td"); dtd.colSpan = 9; dtd.append(provDetail(r)); dtr.append(dtd); body.append(dtr); }
  }
  if (!shown.length) { const tr = el("tr"); const td = el("td", "mut", t("popup_nothingFound")); td.colSpan = 9; tr.append(td); body.append(tr); }
  $("tableSelAll").checked = shown.length > 0 && shown.every((r) => tableSel.has(r.slug));
  $("tableSelAll").onchange = () => { const on = $("tableSelAll").checked; for (const r of shown) on ? tableSel.add(r.slug) : tableSel.delete(r.slug); renderTable(); };
  $("tableSelN").textContent = tableSel.size ? t("table_selN", [String(tableSel.size)]) : t("table_hint2");
  $("tableRefreshSel").disabled = !tableSel.size;
  const badIds = allConns.filter((c) => tableSel.has(c.provider) && (isBadConn(c) || kindOf(c.provider) === "retired")).map((c) => c.id);
  const del = $("tableDelSel"); del.disabled = !badIds.length;
  del.textContent = t("table_delSel"); del.classList.remove("armed"); del.dataset.armed = "";
  armConfirm(del, t("table_delSel"), t("popup_deleteAllConfirm", [String(badIds.length)]), async () => { for (const id of badIds) await msg({ action: "deleteConn", id }); tableSel.clear(); loadConnections(); });
}
$("tableRefreshSel").addEventListener("click", async () => {
  const sel = [...tableSel];
  const web = sel.filter((s) => kindOf(s) === "web"), other = sel.filter((s) => kindOf(s) !== "web");
  if (web.length) await runRefresh(web, $("tableRefreshSel"));
  if (other.length) { const r = await msg({ action: "probeAll", slugs: other }); for (const k in ((r && r.results) || {})) probes[k] = { ...r.results[k], at: Date.now() }; }
  await loadStats(false); renderAll();
});

// ── Wizard ──────────────────────────────────────────────────────────────────
const missingWeb = () => OMNI_WEB.filter((p) => !(conns[p.slug] && conns[p.slug].total) && !wizIgnore.includes(p.slug)).map((p) => p.slug);
function buildWizQueue() {
  const q = [];
  if (wizMode !== "missing") {
    for (const r of providerRows()) {
      if (r.status === "bad") q.push({ kind: r.kind + "Fix", slug: r.slug, why: humanErr(r.pr), n: r.bad || r.total });
      else if (r.status === "retired") q.push({ kind: "retired", slug: r.slug, why: t("kind_retired"), n: r.total });
    }
    for (const s of wizImport) if (!(conns[s] && conns[s].total)) q.push({ kind: "import", slug: s, why: t("wiz_whyImport") });
  }
  if (wizMode !== "fix") for (const s of missingWeb()) q.push({ kind: "webAdd", slug: s, why: t("wiz_whyMissing") });
  return q.filter((it) => !wizSkip.has(it.kind + ":" + it.slug));
}
function renderWizard() {
  const box = $("wizBox"); box.textContent = "";
  const q = buildWizQueue();
  if (!q.length) {
    const d = el("div", "wiz-done"); d.append(el("span", "big", "🎉"), el("b", null, t("wiz_doneTitle")), document.createElement("br"), el("span", "hint-sm", t("wiz_doneHint")));
    if (wizMode !== "all") { const all = el("button", "ghost sm", t("wiz_showAll")); all.style.marginTop = "12px"; all.onclick = () => { wizMode = "all"; renderWizard(); }; d.append(document.createElement("br"), all); }
    box.append(d); renderRail(); return;
  }
  const it = q[0];
  const step = el("div", "wiz-step");
  step.append(el("span", null, t("wiz_step", [String(q.length)])), el("span", null, t("wiz_eta", [String(Math.max(1, Math.round(q.length * 0.5)))])));
  box.append(step);
  const bar = el("div", "wiz-bar"); const bi = el("i"); bi.style.width = Math.max(4, Math.round(100 / (q.length + 1))) + "%"; bar.append(bi); box.append(bar);
  const card = el("div", "wiz-card");
  const h = el("div", "wiz-h");
  const ico = { webFix: "🍪", webAdd: "➕", oauthFix: "🔐", keyFix: "🔑", retired: "🗑", import: "⬆" }[it.kind] || "•";
  const hT = el("div"); hT.style.minWidth = "0";
  hT.append(el("div", "wiz-t", providerLabel(it.slug)), el("div", "wiz-why" + (it.kind === "webAdd" || it.kind === "import" ? " mut" : ""), it.why + (it.n ? " · " + t("wiz_conns", [String(it.n)]) : "")));
  h.append(el("div", "wiz-ico", ico), hT); card.append(h);
  const txt = el("p", "wiz-txt"); card.append(txt);
  const go = el("button", "wiz-go"); card.append(go);
  const res = el("div", "res"); card.append(res);
  const sec = el("div", "wiz-sec");
  const skip = el("button", "ghost sm", t("wiz_skip"));
  skip.onclick = () => { wizSkip.add(it.kind + ":" + it.slug); renderWizard(); };
  sec.append(skip);
  const ids = allConns.filter((c) => c.provider === it.slug).map((c) => c.id);
  if (it.kind === "webAdd") {
    const never = el("button", "ghost sm", t("wiz_never"));
    never.onclick = async () => { wizIgnore.push(it.slug); await chrome.storage.local.set({ wiz_ignore: wizIgnore }); renderWizard(); renderDash(); };
    sec.append(never);
  } else if (ids.length && it.kind !== "retired") {
    const del = el("button", "ghost sm danger", t("wiz_delete"));
    armConfirm(del, t("wiz_delete"), t("popup_deleteAllConfirm", [String(ids.length)]), async () => { for (const id of ids) await msg({ action: "deleteConn", id }); await loadConnections(); renderWizard(); });
    sec.append(del);
  }
  card.append(sec); box.append(card);
  const web = OMNI_WEB_MAP[it.slug], oa = OMNI_OAUTH_MAP[it.slug], key = OMNI_APIKEY_MAP[it.slug];
  const sendToLogin = async () => {
    go.disabled = true;
    const r = await msg({ action: "loginAgain", key: it.slug }); // already logged in → pushed right away
    if (r && r.pushed) { setRes(res, r.alive === false ? "bad" : "ok", (r.alive === false ? "🔴 " + t("det_loginPushedDead") : "🟢 " + t("det_loginPushed")) + (r.connName ? " · " + r.connName : "")); await loadConnections(); setTimeout(renderWizard, 1500); return; }
    setRes(res, "pend", t("wiz_waitLogin"));
    wizSkip.add(it.kind + ":" + it.slug);
  };
  if (it.kind === "webFix") {
    txt.textContent = t("wiz_txtWebFix", [web.host]);
    go.textContent = "🔧 " + t("wiz_goFix");
    go.onclick = async () => {
      go.disabled = true; setRes(res, "pend", t("wiz_refreshing", [web.host]));
      const r = await msg({ action: "refreshSessions", keys: [it.slug] });
      const st = r && r.results && r.results[it.slug] && r.results[it.slug].state;
      await loadStats(false); await loadConnections();
      if (st === "ok") { setRes(res, "ok", "🟢 " + t("wiz_fixed")); setTimeout(renderWizard, 900); }
      else { go.disabled = false; go.textContent = "🔑 " + t("wiz_goLogin"); txt.textContent = t("wiz_txtNeedLogin", [web.host]); go.onclick = sendToLogin; setRes(res, "bad", t("wiz_needLogin")); }
    };
  } else if (it.kind === "webAdd" || (it.kind === "import" && web)) {
    txt.textContent = t("wiz_txtWebAdd", [web.host]);
    go.textContent = "🔑 " + t("wiz_goLogin");
    go.onclick = sendToLogin;
  } else if (oa) {
    txt.textContent = t("wiz_txtOauth");
    go.textContent = "🔐 " + t("oauth_reconnect");
    go.onclick = () => { goPane("oauth"); if (oa.kind === "redirect") connectOauth(oa.slug); else if (oa.deviceFlow && !oa.broken) startOauth(oa.slug); wizSkip.add(it.kind + ":" + it.slug); };
  } else if (key) {
    txt.textContent = t("wiz_txtKey");
    go.textContent = "🔑 " + t("wiz_goKey");
    go.onclick = () => { if (key.get) chrome.tabs.create({ url: key.get }); keyExpanded = key.slug; goPane("key"); renderKeyList(); wizSkip.add(it.kind + ":" + it.slug); };
  } else { // retired
    txt.textContent = t("wiz_txtRetired");
    go.textContent = "🗑 " + t("wiz_goDelete", [String(ids.length)]);
    go.classList.add("danger");
    go.onclick = async () => { go.disabled = true; for (const id of ids) await msg({ action: "deleteConn", id }); await loadConnections(); renderWizard(); };
  }
  const rest = q.slice(1, 6);
  if (rest.length) {
    box.append(el("div", "grp-title", t("wiz_next")));
    for (const n of rest) { const r = el("div", "wiz-next"); r.append(el("span", null, providerLabel(n.slug)), el("span", "pm", n.why)); box.append(r); }
    if (q.length > 6) box.append(el("p", "hint-sm", t("wiz_more", [String(q.length - 6)])));
  }
  renderRail();
}
$("fillMissingBtn").addEventListener("click", () => { wizMode = "missing"; goPane("wizard"); });

// ── rail badges ─────────────────────────────────────────────────────────────
function renderRail() {
  const rows = providerRows();
  const bad = rows.filter((r) => r.status === "bad" || r.status === "retired").length;
  const rb = $("railBad"); rb.textContent = bad ? String(bad) : ""; rb.classList.toggle("hide", !bad);
  const saved = wizMode; wizMode = "fix"; const fixN = buildWizQueue().length; wizMode = saved;
  const rw = $("railWiz"); rw.textContent = fixN ? String(fixN) : ""; rw.classList.toggle("hide", !fixN);
  const bw = $("bWeb"); bw.classList.toggle("hide", bw.textContent === "0");
}

// ── refresh-all (re-capture web sessions through background tabs) ──────────
async function runRefresh(keys, btn) {
  const res = $("probeAllRes"), prog = $("probeProg"), bar = $("probeProgBar");
  if (!serverOnline) { res.className = "res show bad"; res.textContent = "⚠ " + t("popup_omniDown"); return; }
  if (btn) btn.disabled = true;
  prog.classList.remove("hide"); bar.style.width = "0%"; probeStart = Date.now();
  res.className = "res show pend"; res.textContent = t("refresh_start");
  const r = await msg(keys ? { action: "refreshSessions", keys } : { action: "refreshSessions" });
  if (btn) btn.disabled = false;
  if (r && r.busy) { res.className = "res show mut"; res.textContent = t("refresh_busy"); prog.classList.add("hide"); return; }
  const vals = Object.values((r && r.results) || {});
  const ok = vals.filter((v) => v.state === "ok").length, need = vals.length - ok;
  bar.style.width = "100%"; setTimeout(() => prog.classList.add("hide"), 900);
  res.className = "res show " + (need ? "bad" : "ok");
  res.textContent = vals.length ? t("refresh_done", [String(ok), String(need)]) : t("refresh_none");
  const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {};
  await loadStats(false); await loadConnections();
}
function onRefreshProgress(m) {
  const bar = $("probeProgBar"), res = $("probeAllRes");
  if (m.phase === "done") { // each finished provider: repaint the live report; the last one ends the run
    loadStats(false).then(() => { renderRefreshReport(); if (m.done >= m.total) { $("refreshAllBtn").disabled = false; setTimeout(() => $("probeProg").classList.add("hide"), 900); loadConnections(); } });
  }
  $("probeProg").classList.remove("hide");
  bar.style.width = Math.round((m.done / m.total) * 100) + "%";
  res.className = "res show pend";
  res.textContent = (m.phase === "probe" ? t("refresh_probing", [String(m.done + 1), String(m.total), providerLabel(m.key)])
    : m.phase === "start" ? t("refresh_progress", [String(m.done + 1), String(m.total), providerLabel(m.key)])
    : t("refresh_progress", [String(m.done), String(m.total), providerLabel(m.key)]));
}
$("refreshAllBtn").addEventListener("click", () => runRefresh(null, $("refreshAllBtn")));
$("fullBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?full=1") }));

// Stats live in the SW's storage; site checks / cookie expiry are refreshed when stale.
async function loadStats(heavy = true) {
  const s = await msg({ action: "getStats" });
  hist = (s && s.hist) || {}; sites = (s && s.sites) || {}; lastRefresh = (s && s.lastRefresh) || lastRefresh;
  // A refresh started before this popup opened keeps running in the SW — pick its progress back up.
  if (s && s.refreshState && s.refreshState.running) { $("refreshAllBtn").disabled = true; onRefreshProgress(s.refreshState); }
  if (!heavy) return;
  const webKeys = Object.keys(conns).filter((k) => OMNI_WEB_MAP[k]);
  const stale = webKeys.filter((k) => !sites[k] || Date.now() - sites[k].at > 30 * 60 * 1000);
  const [ex, sc, v] = await Promise.all([
    webKeys.length ? msg({ action: "cookieExpiry", keys: webKeys }) : null,
    stale.length ? msg({ action: "siteCheck", keys: stale }) : null,
    serverOnline ? msg({ action: "omniVersion" }) : null,
  ]);
  expiry = (ex && ex.expiry) || expiry;
  if (sc && sc.sites) Object.assign(sites, sc.sites);
  if (v && v.ok !== false) omniVer = v;
}
function renderAll() { renderProblems(); renderDash(); if (curPane === "table") renderTable(); if (curPane === "wizard") renderWizard(); renderManage(); renderWeb(); keyPaneFill(); }

// ── provider details (Pulse row / Table row expand): models, connections, the right next action ──
let modelList = null; // [{id}] from /v1/models — loaded once per popup open, on first need
const expanded = new Set();
async function ensureModels() {
  if (modelList) return modelList;
  const r = await msg({ action: "models" });
  modelList = (r && r.ok && r.models) || [];
  return modelList;
}
const modelsOf = (slug) => (modelList || []).filter((m) => m.id.startsWith(slug + "/")).map((m) => m.id);
const connName = (c) => c.name || providerLabel(c.provider);

// Send the user to log in again; the SW finishes the add itself once the session shows up.
async function loginAgain(slug, btn) {
  if (!OMNI_WEB_MAP[slug]) return;
  if (btn) { btn.disabled = true; btn.textContent = t("det_loginWorking"); }
  const r = await msg({ action: "loginAgain", key: slug });
  if (btn) {
    btn.textContent = r && r.pushed ? (r.state === "ok" ? "✓ " + t("det_loginPushed") : r.state === "needLogin" ? "🔑 " + t("det_loginPushedDead") : "⚪ " + t("det_loginPushedUnk")) : r && r.opened ? t("det_loginOpened") : "🔴 " + t("popup_error");
    btn.title = r && r.connName ? (r.updated ? t("rs_updatedConn", [r.connName]) : t("rs_newConn", [r.connName])) + (r.detail ? " · " + r.detail : "") : (r && r.detail) || "";
    if (r && r.opened && r.detail && btn.parentElement) { const d = el("div", "rep-sub", r.detail); d.style.paddingLeft = "0"; btn.after(d); }
  }
  if (r && r.pushed) { const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {}; await loadStats(false); await loadConnections(); refresh(); }
}
function nextActionBtns(r, box) {
  const row = el("div", "dact");
  const probe = el("button", "ghost sm", t("row_probe"));
  probe.onclick = async () => { probe.disabled = true; probe.textContent = t("popup_probingLive"); const p = await msg({ action: "probe", slug: r.slug }); probes[r.slug] = { ...p, at: Date.now() }; await loadStats(false); renderAll(); };
  row.append(probe);
  if (r.kind === "web") {
    const rf = el("button", "ghost sm", t("det_refresh")); rf.title = t("row_refresh");
    rf.onclick = () => runRefresh([r.slug], rf);
    const li = el("button", "ghost sm", t("det_login")); li.title = t("det_loginTitle");
    li.onclick = () => loginAgain(r.slug, li);
    row.append(rf, li);
  } else if (r.kind === "key") {
    const k = OMNI_APIKEY_MAP[r.slug];
    const nk = el("button", "ghost sm", t("det_newKey"));
    nk.onclick = () => { if (k && k.get) chrome.tabs.create({ url: k.get }); keyExpanded = r.slug; goPane("key"); renderKeyList(); };
    row.append(nk);
  } else if (r.kind === "oauth") {
    const o = OMNI_OAUTH_MAP[r.slug];
    const rc = el("button", "ghost sm", t("oauth_reconnect"));
    rc.onclick = () => { goPane("oauth"); if (o.kind === "redirect") connectOauth(o.slug); else if (o.deviceFlow && !o.broken) startOauth(o.slug); };
    row.append(rc);
  }
  if (r.kind !== "retired") {
    const ch = el("button", "ghost sm", t("det_chat"));
    ch.onclick = () => openChat(r.slug);
    row.append(ch);
  }
  box.append(row);
}
function provDetail(r) {
  const box = el("div", "det");
  const facts = el("div", "det-facts");
  const verdict = r.status === "bad" ? "🔴 " + humanErr(r.pr) + (r.pr && r.pr.detail ? " — " + String(r.pr.detail).slice(0, 90) : "")
    : r.pr && r.pr.alive === true ? "🟢 " + t("det_works", [fmtMs(r.pr.ms)])
    : r.status === "retired" ? "🗑 " + t("kind_retired") : "⚪ " + t("probe_never");
  facts.append(el("div", null, verdict));
  if (r.pr && r.pr.at) facts.append(el("div", "mut", t("popup_checkedAgo", [ago(r.pr.at)]) + (r.pr.model ? " · " + r.pr.model : "")));
  if (r.kind === "web") {
    facts.append(el("div", "mut", (r.site ? (r.site.up === true ? "🌐 " + t("det_siteUp", [fmtMs(r.site.ms)]) : r.site.up === false ? "🌐 " + t("site_down") : "🌐 " + t("det_siteUnknown")) : "🌐 —")
      + " · " + (r.expDays != null ? "🍪 " + t("exp_soon", [expText(r)]) : "🍪 " + t("det_expUnknown"))));
  }
  box.append(facts);
  nextActionBtns(r, box);
  // Models this provider exposes through OmniRoute (what Claude Code / OpenCode can actually call).
  const mb = el("div", "det-models"); box.append(mb);
  const fill = () => {
    mb.textContent = "";
    const ids = modelsOf(r.slug);
    const ttl = el("div", "grp-title", t("det_models")); ttl.append(el("span", "n", String(ids.length))); mb.append(ttl);
    if (!ids.length) { mb.append(el("p", "hint-sm", modelList ? t("det_noModels") : t("det_loadingModels"))); return; }
    const chips = el("div", "chips");
    for (const id of ids.slice(0, 40)) {
      const c = el("button", "chip mono-chip", id.slice(r.slug.length + 1)); c.title = t("det_copyModel", [id]);
      c.onclick = () => navigator.clipboard.writeText(id).then(() => { c.textContent = "✓ " + t("popup_copied"); setTimeout(() => (c.textContent = id.slice(r.slug.length + 1)), 1200); });
      chips.append(c);
    }
    mb.append(chips);
    if (ids.length > 40) mb.append(el("p", "hint-sm", t("wiz_more", [String(ids.length - 40)])));
  };
  fill(); if (!modelList) ensureModels().then(fill);
  // Every connection of this provider, with rename / enable-disable / delete.
  const list = allConns.filter((c) => c.provider === r.slug);
  if (list.length) {
    const ttl = el("div", "grp-title", t("det_conns")); ttl.append(el("span", "n", String(list.length))); box.append(ttl);
    for (const c of list) {
      const bad = isBadConn(c);
      const row = el("div", "prob" + (bad ? "" : " okrow"));
      const info = el("div", "prob-info");
      const pn = el("div", "prob-name", connName(c)); pn.title = connName(c); info.append(pn);
      info.append(el("div", "prob-sub", c.isActive === false ? t("popup_stateOff") : bad ? t("popup_stateBad") : t("popup_stateOk")));
      row.append(info);
      connActions(row, info, c, renderAll);
      box.append(row);
    }
  }
  return box;
}

// ── refresh report: what "Обновить все сессии" actually did, with the next step per provider ──
let lastRefresh = null, refreshDismissed = 0;
const REFRESH_STATE = {
  ok: ["ok", "🟢", () => t("rs_ok")], needLogin: ["bad", "🔑", () => t("rs_needLogin")], noSession: ["bad", "🔑", () => t("rs_noSession")],
  unknown: ["mut", "⚪", () => t("rs_unknown")], error: ["bad", "🔴", () => t("rs_error")],
};
function renderRefreshReport() {
  const box = $("dashRefresh"); box.textContent = "";
  if (!lastRefresh || !lastRefresh.results || lastRefresh.at <= refreshDismissed) return;
  const entries = Object.entries(lastRefresh.results);
  if (!entries.length) return;
  const card = el("div", "rep");
  const h = el("div", "rep-h");
  const okN = entries.filter(([, v]) => v.state === "ok").length;
  h.append(el("b", null, t("rs_title", [String(okN), String(entries.length)])), el("span", "mut", " · " + (lastRefresh.running ? t("rs_running") : ago(lastRefresh.at))), el("span", "grow"));
  const x = el("button", "ibtn", "✕"); x.title = t("web_dismissTitle"); x.setAttribute("aria-label", t("web_dismissLabel"));
  x.onclick = () => { refreshDismissed = lastRefresh.at; chrome.storage.local.set({ refresh_dismissed: refreshDismissed }); renderRefreshReport(); };
  h.append(x); card.append(h);
  const order = { needLogin: 0, noSession: 0, error: 1, unknown: 2, ok: 3 };
  for (const [key, v] of entries.sort((a, b) => order[a[1].state] - order[b[1].state])) {
    const [cls, ico, msgKey] = REFRESH_STATE[v.state] || REFRESH_STATE.unknown;
    const row = el("div", "rep-row");
    const nm = el("span", "pn", providerLabel(key));
    const st = el("span", "pm " + cls, msgKey());
    if (v.connName) st.title = (v.updated ? t("rs_updatedConn", [v.connName]) : t("rs_newConn", [v.connName]));
    row.append(el("span", "rep-ico", ico), nm, st);
    if (v.detail || v.connName) {
      const sub = el("div", "rep-sub", [v.connName ? (v.updated ? t("rs_updatedConn", [v.connName]) : t("rs_newConn", [v.connName])) : "", v.detail ? String(v.detail).slice(0, 120) : ""].filter(Boolean).join(" · "));
      row.classList.add("two"); nm.after(sub);
    }
    if (v.state === "needLogin" || v.state === "noSession") {
      const go = el("button", "sm", t("det_login")); go.title = t("det_loginTitle");
      go.onclick = () => loginAgain(key, go);
      row.append(go);
    }
    card.append(row);
  }
  card.append(el("p", "hint-sm", t("rs_hint")));
  box.append(card);
}

// ── test chat: talk to any connected provider/model right here ─────────────
const chatLog = [];
async function openChat(slug) {
  goPane("chat");
  await fillChatProviders(slug);
}
async function fillChatProviders(pick) {
  await ensureModels();
  const sel = $("chatProv"), cur = pick || sel.value;
  sel.textContent = "";
  const slugs = [...new Set((modelList || []).map((m) => m.id.split("/")[0]))]
    .filter((s) => (conns[s] && conns[s].total) || s.startsWith("auto"))
    .sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  for (const s of slugs) { const o = el("option", null, `${providerLabel(s)} (${modelsOf(s).length})`); o.value = s; sel.append(o); }
  if (!slugs.length) { const o = el("option", null, t("chat_noModels")); o.value = ""; sel.append(o); }
  if (cur && slugs.includes(cur)) sel.value = cur;
  fillChatModels();
}
function fillChatModels() {
  const sel = $("chatModel"); sel.textContent = "";
  for (const id of modelsOf($("chatProv").value)) { const o = el("option", null, id.slice(id.indexOf("/") + 1)); o.value = id; sel.append(o); }
}
function renderChat() {
  const box = $("chatLogBox"); box.textContent = "";
  if (!chatLog.length) { box.append(el("p", "hint-sm", t("chat_hint"))); return; }
  for (const m of chatLog) {
    const b = el("div", "bubble " + m.role + (m.err ? " err" : ""));
    b.append(el("div", "btext", m.content));
    if (m.meta) b.append(el("div", "bmeta", m.meta));
    box.append(b);
  }
  box.scrollTop = box.scrollHeight;
  $("scroll").scrollTop = $("scroll").scrollHeight;
}
async function sendChat() {
  const model = $("chatModel").value, text = $("chatIn").value.trim();
  if (!model || !text) return;
  chatLog.push({ role: "user", content: text });
  $("chatIn").value = ""; renderChat();
  const btn = $("chatSend"); btn.disabled = true; btn.textContent = t("chat_waiting");
  const history = chatLog.filter((m) => !m.err).map((m) => ({ role: m.role, content: m.content })).slice(-12);
  const r = await msg({ action: "chat", model, messages: history });
  btn.disabled = false; btn.textContent = t("chat_send");
  if (r && r.ok) {
    const u = r.usage ? ` · ${t("chat_tokens", [String(r.usage.total_tokens || (r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0))])}` : "";
    chatLog.push({ role: "assistant", content: r.text, meta: `${r.model} · ${fmtMs(r.ms)}${u}` });
  } else {
    chatLog.push({ role: "assistant", err: true, content: "🔴 " + String((r && r.error) || t("popup_error")), meta: `${model} · ${fmtMs(r && r.ms)}` });
  }
  renderChat();
}
$("chatProv").addEventListener("change", fillChatModels);
$("chatSend").addEventListener("click", sendChat);
$("chatIn").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); } });
$("chatClear").addEventListener("click", () => { chatLog.length = 0; renderChat(); });

let stored = {};
$("openDash").addEventListener("click", () => chrome.tabs.create({ url: OMNI_BASE + "/home" }));
$("probeAllBtn").addEventListener("click", runProbeAll);
// NOT an async listener: runtime.sendMessage reaches EVERY extension page, and in Firefox a listener that
// returns a Promise answers the message — so a second open popup/full tab answered the other one's "ping"
// with undefined and it read the server as down. Broadcasts only (m.type); requests (m.action) aren't ours.
chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
  if (m.type === "probeProgress") onProbeProgress(m);
  else if (m.type === "refreshProgress") onRefreshProgress(m);
  else if (m.type === "autoAdded") { refresh(); msg({ action: "getProbes" }).then(async (pr) => { probes = (pr && pr.probes) || {}; await loadStats(false); await loadConnections(); }); }
  else if (m.type === "healthSwept") { // live-refresh verdicts after an unattended sweep
    msg({ action: "getProbes" }).then(async (pr) => { probes = (pr && pr.probes) || {}; await loadStats(false); renderAll(); });
  }
});

// ── settings panel ───────────────────────────────────────────────────────────
// Popup size (идея: "изменяемый размер"). A browser action popup can't be drag-resized and is capped at
// 800×600, so the size is a setting; the detached window and the full tab resize freely anyway.
const POPUP_SIZES = { s: [420, 560], m: [560, 600], l: [760, 600] };
function applySize(v) {
  if (full || windowed) return;
  const [w, h] = POPUP_SIZES[v] || POPUP_SIZES.s;
  document.documentElement.style.height = h + "px";
  Object.assign(document.body.style, { width: w + "px", height: h + "px" });
}
function applyTheme(t) { const r = document.documentElement; if (t === "light" || t === "dark") r.dataset.theme = t; else delete r.dataset.theme; } // "auto" → follow system
async function loadSettings() {
  const { settings } = (await msg({ action: "getSettings" })) || {};
  const s = settings || { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true };
  $("setSweep").checked = !!s.sweep;
  $("setSweepMin").value = String(s.sweepMin || 15);
  $("setNotify").checked = !!s.notify;
  $("setPersist").checked = s.persistSessions !== false; // default on
  $("setAutoRepair").checked = s.autoRepair !== false;
  $("setNightly").checked = s.nightly !== false;
  renderSweepSkip(s.sweepSkip || []);
  $("setTheme").value = s.theme || "auto"; applyTheme(s.theme);
  try { $("setSize").value = localStorage.getItem("omni_size") || "s"; } catch (e) { /* default */ }
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
  msg({ action: "setSettings", settings: { sweep: $("setSweep").checked, sweepMin: parseInt($("setSweepMin").value, 10) || 15, notify: $("setNotify").checked, theme: $("setTheme").value, persistSessions: $("setPersist").checked, autoRepair: $("setAutoRepair").checked, nightly: $("setNightly").checked } });
}
function initSettings() {
  // Firefox: request the 127.0.0.1 host permission on click (a user gesture, as permissions.request needs),
  // then re-probe. On grant the whole reachability chain (tab injection) starts working.
  // Firefox anchors the native permission doorhanger to the toolbar button — exactly where the popup PANEL
  // hangs — so its "Allow" button lands BEHIND our panel. From the detached standalone window the panel no
  // longer covers the toolbar, so the doorhanger is clickable. In panel mode, hand off to that window first.
  $("grantBtn").addEventListener("click", async () => {
    if (!windowed) {
      chrome.windows.create({ url: chrome.runtime.getURL("popup.html?window=1"), type: "popup", width: 440, height: 660 }, () => window.close());
      return;
    }
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: HOST_ORIGINS }); } catch (e) { /* not requestable */ }
    if (granted) {
      $("permBanner").classList.add("hide");
      await probeServer();
      if (serverOnline) { await fetchConnections(); renderProblems(); renderManage(); renderWeb(); keyPaneFill(); }
    }
  });
  $("settingsBtn").addEventListener("click", () => { loadSettings(); });
  $("setSize").addEventListener("change", () => { const v = $("setSize").value; try { localStorage.setItem("omni_size", v); } catch (e) { /* not persisted */ } applySize(v); });
  for (const id of ["setSweep", "setSweepMin", "setNotify", "setPersist", "setTheme", "setAutoRepair", "setNightly"]) $(id).addEventListener("change", saveSettings);
  $("sweepNowBtn").addEventListener("click", async () => {
    const b = $("sweepNowBtn"); b.disabled = true; b.textContent = t("set_sweeping");
    const r = await msg({ action: "sweepNow" });
    if (r && r.ran === false) { b.textContent = t("set_sweepBusy"); setTimeout(() => { b.disabled = false; b.textContent = t("set_sweepNow"); }, 1500); return; }
    const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {};
    await loadConnections(); await loadSettings();
    b.disabled = false; b.textContent = t("set_sweepNow");
  });
  $("clearProbesBtn").addEventListener("click", async () => { await msg({ action: "clearProbes" }); probes = {}; await loadConnections(); loadSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && curPane === "set") { goPane("dash"); $("settingsBtn").focus(); } }); // Esc leaves settings
  // Import a roster exported from another PC: providers it has and this OmniRoute lacks go into the Wizard.
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const f = $("importFile").files && $("importFile").files[0]; if (!f) return;
    let slugs = [];
    try { const d = JSON.parse(await f.text()); slugs = [...new Set((d.connections || []).map((c) => c && c.provider).filter((s) => typeof s === "string"))]; } catch (e) { slugs = []; }
    const missing = slugs.filter((s) => !(conns[s] && conns[s].total) && (OMNI_WEB_MAP[s] || OMNI_OAUTH_MAP[s] || OMNI_APIKEY_MAP[s]));
    await chrome.storage.local.set({ wiz_import: missing });
    wizImport = missing;
    $("setSummary").textContent = slugs.length ? t("set_importDone", [String(missing.length), String(slugs.length)]) : t("set_importBad");
    $("importFile").value = "";
    renderRail();
  });
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
const full = new URLSearchParams(location.search).get("full") === "1"; // the wide full-tab view (идея 20)
try { applySize(localStorage.getItem("omni_size") || "s"); } catch (e) { /* storage blocked → default size */ }
if (full) { document.documentElement.classList.add("full"); document.body.classList.add("full"); $("detachBtn").classList.add("hide"); $("fullBtn").classList.add("hide"); }
else if (windowed) {
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
  stored = await chrome.storage.local.get(["sel_apikey", "sel_tab", "wiz_ignore", "wiz_import", "refresh_dismissed"]);
  refreshDismissed = stored.refresh_dismissed || 0;
  wizIgnore = stored.wiz_ignore || []; wizImport = stored.wiz_import || [];
  const pr = await msg({ action: "getProbes" }); probes = (pr && pr.probes) || {};
  await detectActiveTab();
  initKeyPane();
  await refresh();
  await refreshHostBanner(); // Firefox: show the "grant access" banner if 127.0.0.1 isn't permitted yet
  await probeServer();
  if (serverOnline) { await fetchConnections(); $("probeAllBtn").disabled = !connTotal; }
  renderOauth();          // now conn counts are available for the device cards
  await loadStats(false);
  setFooter(); renderAll();
  // On a provider site with a capture ready the capture flow wins; the full tab opens on the table;
  // otherwise Pulse is home.
  if (activeProviderKey && caps[activeProviderKey]) goPane("web");
  else if (full) goPane("table");
  else goPane("dash");
  if (serverOnline) loadStats(true).then(renderAll); // site checks / cookie expiry / version — slower, paint after
  refreshOauth();         // pick up any device-flow left pending from a previous popup session
})();
// Push-based capture refresh: react the instant the SW writes a new session, instead of a tight 3s
// poll that re-scanned all of session storage every tick. Slow fallback keeps timestamps ("Nмин назад") fresh.
const debouncedRefresh = debounce(refresh, 150);
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith("cap_") || k === "apikey_aistudio")) debouncedRefresh();
});
setInterval(() => { lastWebSig = null; refresh(); }, 15000); // force a re-render so "N мин назад" / stale-amber advance
