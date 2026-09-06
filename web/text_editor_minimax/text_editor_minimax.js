import { app } from "/scripts/app.js";

// Matches node_id in TextEditorMinimax.define_schema() (text_editor_minimax.py)
const NODE_NAME = "TextEditorMinimax";
const WIDGET_NAME = "text"; // must match the INPUT_TYPES key

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DEFAULT_FONT_FAMILY = '"SF Mono", "Fira Code", Menlo, Consolas, monospace';

// Common code-editor-friendly fonts likely already installed on the user's
// system. value === "" is the built-in default stack above.
const BUILTIN_CODE_FONTS = [
  { label: "Default", value: "" },
  { label: "Consolas", value: `Consolas, ${DEFAULT_FONT_FAMILY}` },
  { label: "Cascadia Code", value: `"Cascadia Code", ${DEFAULT_FONT_FAMILY}` },
  { label: "JetBrains Mono", value: `"JetBrains Mono", ${DEFAULT_FONT_FAMILY}` },
  { label: "Courier New", value: `"Courier New", ${DEFAULT_FONT_FAMILY}` },
];

// CSS generic family keywords. Unlike named fonts (which differ wildly
// between Windows and Linux, with no overlap), these always resolve to
// *some* installed font on any OS/browser, so they're a safe way to offer
// non-monospace styles (serif, cursive, etc.) without guessing.
const GENERIC_FONT_FAMILIES = [
  { label: "Serif", value: "serif" },
  { label: "Sans-serif", value: "sans-serif" },
  { label: "Cursive", value: "cursive" },
  { label: "Fantasy", value: "fantasy" },
  { label: "System UI", value: "system-ui" },
];

const BUILTIN_FONT_GROUPS = [
  { label: "Code fonts", fonts: BUILTIN_CODE_FONTS },
  { label: "Generic families", fonts: GENERIC_FONT_FAMILIES },
];

// Pulls the first family=... param out of a Google Fonts css2 stylesheet URL
// (e.g. "https://fonts.googleapis.com/css2?family=Doppio+One&display=swap")
// and decodes it into the plain family name Google would use in font-family.
// Returns null if the URL isn't a recognizable Google Fonts link.
function parseGoogleFontUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)fonts\.googleapis\.com$/i.test(parsed.hostname)) return null;

  const family = parsed.searchParams.get("family");
  if (!family) return null;

  // Strip any weight/style spec after ':' (e.g. "Doppio+One:ital,wght@0,400")
  // and turn URL "+"/"%20" encoding of spaces into real spaces.
  const name = family.split(":")[0].replace(/\+/g, " ").trim();
  return name || null;
}

const COMMENT_LINE_RE = /^\s*#.*$/;

// Drops comment lines from the text sent downstream (execute()), while the
// textarea itself keeps them so the user can still see/edit them.
function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => !COMMENT_LINE_RE.test(line))
    .join("\n");
}

function highlightLine(line) {
  // Comment lines: only when the (unescaped) line starts with optional
  // whitespace then '#'. Checked against the raw line so mid-line '#'
  // (e.g. "1girl with a # on her thigh") never qualifies.
  const commentMatch = line.match(/^(\s*)(#.*)$/);
  if (commentMatch) {
    const [, leading, comment] = commentMatch;
    return `${escapeHtml(leading)}<span class="tem-comment">${escapeHtml(comment)}</span>`;
  }

  let escaped = escapeHtml(line);

  // Highlight text actually wrapped in "quotes" first, using the real
  // quote characters from the source (never invent quotes that aren't
  // in the underlying text, or the highlight layer desyncs from the
  // textarea and selection/copy will drop characters the user can see).
  escaped = escaped.replace(/"([^"]*)"/g, '<span class="tem-quote">"$1"</span>');

  escaped = escaped.replace(/\[([^\]]+)\]/g, '<span class="tem-keyword">[$1]</span>');
  escaped = escaped.replace(/\[[^\]]*\]|\b(camera|shot|off-screen voiceover)\b/gi, (m, word) =>
    word ? `<span class="tem-camera">${word}</span>` : m
  );

  // Now the rest, which are safe because [] and ** etc. won't collide with quotes
  escaped = escaped.replace(/&lt;d&gt;(.*?)&lt;\/d&gt;/g, '<span class="tem-tag">&lt;d&gt;$1&lt;/d&gt;</span>');
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<span class="tem-bold">**$1**</span>');
  escaped = escaped.replace(/\b(\d+:\d+\.\d+|\d+:\d+|\d+\.\d+)\b/g, '<span class="tem-time">$1</span>');
  escaped = escaped.replace(/\b(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|diegetic_music|integrated_multimodal_description)\b/gi, '<span class="tem-field">$1</span>');
  escaped = escaped.replace(/\b(fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference(?= -))\b/gi, '<span class="tem-quote">$1</span>');
  escaped = escaped.replace(/&lt;((?:subject|picture|video|audio|cutoff|scenetrans)\s*\d+)&gt;/gi, '<span class="tem-ref">&lt;$1&gt;</span>');
  escaped = escaped.replace(/\(s\d+(?:\s*,\s*s\d+)*\)/gi, '<span class="tem-subj">$&</span>');

  return escaped;
}

// Injected once; scoped with tem- prefixed classes so it won't collide with
// ComfyUI's own styles.
function injectStyles() {
  if (document.getElementById("text-editor-minimax-style")) return;
  const style = document.createElement("style");
  style.id = "text-editor-minimax-style";
  style.textContent = `
    .tem-wrap {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: #1e1e1e;
      border: 1px solid #333;
      border-radius: 6px;
      overflow: hidden;
      font-family: var(--tem-font-family, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
    }
    .tem-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 4px 6px;
      background: #2d2d2d;
      border-bottom: 1px solid #333;
      flex: 0 0 auto;
    }
    .tem-toolbar button {
      background: #3a3a3a;
      color: #d4d4d4;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tem-toolbar button.active {
      background: #0e639c;
      border-color: #0e639c;
    }
    .tem-copy-btn, .tem-settings-btn {
      padding: 2px 6px;
      font-size: 13px;
      line-height: 1.3;
    }
    .tem-settings-wrap {
      position: relative;
    }
    .tem-settings-popup {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 10;
      min-width: 260px;
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      padding: 8px;
      font-size: 12px;
      color: #d4d4d4;
    }
    .tem-settings-popup.open {
      display: block;
    }
    .tem-settings-popup h4 {
      margin: 0 0 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #9d9d9d;
      font-weight: 600;
    }
    .tem-settings-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .tem-settings-label {
      color: #d4d4d4;
      font-size: 11px;
    }
    .tem-settings-control {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tem-settings-control button {
      background: #3a3a3a;
      color: #d4d4d4;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tem-lineheight-label {
      color: #9d9d9d;
      font-size: 11px;
      min-width: 24px;
      text-align: right;
      user-select: none;
    }
    .tem-settings-popup select,
    .tem-settings-popup input[type="text"] {
      background: #1e1e1e;
      color: #d4d4d4;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 3px 5px;
      font-size: 11px;
      font-family: inherit;
      width: 100%;
      box-sizing: border-box;
    }
    .tem-settings-divider {
      height: 1px;
      background: #444;
      margin: 8px 0;
      border: none;
    }
    .tem-font-status {
      color: #7a7a7a;
      font-size: 10px;
      min-height: 12px;
    }
    .tem-font-status.error {
      color: #e06c75;
    }
    .tem-google-fonts-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tem-google-font-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tem-google-font-row input[type="text"] {
      flex: 1 1 auto;
      min-width: 0;
    }
    .tem-google-font-row button {
      flex: 0 0 auto;
      background: #3a3a3a;
      color: #d4d4d4;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tem-google-font-add {
      align-self: flex-start;
      background: #3a3a3a;
      color: #d4d4d4;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 1px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .tem-font-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .tem-font-group button {
      padding: 2px 7px;
      line-height: 1;
    }
    .tem-font-size-label {
      color: #9d9d9d;
      font-size: 11px;
      min-width: 26px;
      text-align: center;
      user-select: none;
    }
    .tem-editor {
      position: relative;
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }
    .tem-wrap {
      --tem-font-size: 12px;
      --tem-line-height: 1.3;
    }
    .tem-body {
      position: relative;
      flex: 1 1 auto;
      display: flex;
      align-items: stretch;
      overflow: auto;
    }
    .tem-gutter {
      flex: 0 0 auto;
      position: sticky;
      left: 0;
      z-index: 1;
      padding: 6px 8px 6px 0;
      text-align: right;
      color: #6e7681;
      background: #252526;
      border-right: 1px solid #333;
      user-select: none;
      font-size: var(--tem-font-size);
      line-height: var(--tem-line-height);
    }
    .tem-gutter div { white-space: pre; }
    .tem-text {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
    }
    .tem-highlight, .tem-input {
      margin: 0;
      padding: 6px 8px;
      font-size: var(--tem-font-size);
      line-height: var(--tem-line-height);
      font-family: inherit;
      min-height: 100%;
      width: max-content;
      min-width: 100%;
      box-sizing: border-box;
    }
    .tem-highlight { color: #d4d4d4; pointer-events: none; }
    .tem-highlight > div { white-space: inherit; }
    .tem-input {
      position: absolute;
      top: 0; left: 0;
      min-height: 100%;
      background: transparent;
      color: transparent;
      caret-color: #fff;
      border: none;
      outline: none;
      resize: none;
      overflow: hidden;
    }
    .tem-body.wrap .tem-highlight, .tem-body.wrap .tem-input {
      white-space: pre-wrap;
      word-break: break-word;
      width: 100%;
    }
    .tem-body.nowrap .tem-highlight, .tem-body.nowrap .tem-input {
      white-space: pre;
    }
    .tem-keyword { color: #ec6091; font-weight: 600; }
    .tem-tag     { color: #4fc1ff; }
    .tem-bold    { color: #6bcf6b; font-weight: 600; }
    .tem-time    { color: #d19a66; }
    .tem-field   { color: #c586c0; font-weight: 600; }
    .tem-ref     { color: #4ec9b0; }
    .tem-subj    { color: #e5c07b; }
    .tem-quote   { color: #98c379; }
    .tem-camera  { color: #56b6c2; font-weight: 600; }
    .tem-comment { color: #6a9955; font-style: italic; }
  `;
  document.head.appendChild(style);
}

// Injects (or reuses) a <link rel="stylesheet"> for a Google Fonts URL.
// Tags are cached by href on document.head so switching between a few fonts
// during a session doesn't pile up duplicate <link> elements.
function ensureGoogleFontLink(url) {
  const existing = document.head.querySelector(`link[data-tem-font-url="${CSS.escape(url)}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.dataset.temFontUrl = url;
  document.head.appendChild(link);
}

function buildEditorElement(
  initialValue,
  onChange,
  initialFontSize,
  onFontSizeChange,
  initialLineHeight,
  onLineHeightChange,
  initialFontFamily,
  initialGoogleFonts,
  onFontFamilyChange,
  onGoogleFontsChange
) {
  injectStyles();

  const root = document.createElement("div");
  root.className = "tem-wrap";
  root.innerHTML = `
    <div class="tem-toolbar">
      <div class="tem-font-group">
        <button class="tem-font-minus" type="button" title="Decrease font size">A-</button>
        <span class="tem-font-size-label">12px</span>
        <button class="tem-font-plus" type="button" title="Increase font size">A+</button>
      </div>
      <button class="tem-wrap-btn active" type="button">Wrap: On</button>
      <button class="tem-copy-btn" type="button" title="Copy text">📋</button>
      <div class="tem-settings-wrap">
        <button class="tem-settings-btn" type="button" title="Advanced settings">⚙️</button>
        <div class="tem-settings-popup">
          <h4>Advanced Settings</h4>
          <div class="tem-settings-row">
            <span class="tem-settings-label">Line height</span>
            <div class="tem-settings-control">
              <button class="tem-lineheight-minus" type="button" title="Decrease line height">-</button>
              <span class="tem-lineheight-label">1.3</span>
              <button class="tem-lineheight-plus" type="button" title="Increase line height">+</button>
            </div>
          </div>
          <hr class="tem-settings-divider" />
          <div class="tem-settings-row">
            <span class="tem-settings-label">Font family</span>
            <select class="tem-font-select"></select>
          </div>
          <div class="tem-settings-row">
            <span class="tem-settings-label">(not working atm, comfyui CSP) Google Fonts URLs</span>
            <div class="tem-google-fonts-list"></div>
            <button class="tem-google-font-add" type="button" title="Add another Google Font">+ Add font</button>
          </div>
        </div>
      </div>
    </div>
    <div class="tem-editor">
      <div class="tem-body wrap">
        <div class="tem-gutter"></div>
        <div class="tem-text">
          <div class="tem-highlight"></div>
          <textarea class="tem-input" spellcheck="true"></textarea>
        </div>
      </div>
    </div>
  `;

  const gutter = root.querySelector(".tem-gutter");
  const highlight = root.querySelector(".tem-highlight");
  const input = root.querySelector(".tem-input");
  const body = root.querySelector(".tem-body");
  const wrapBtn = root.querySelector(".tem-wrap-btn");
  const copyBtn = root.querySelector(".tem-copy-btn");
  const settingsBtn = root.querySelector(".tem-settings-btn");
  const settingsPopup = root.querySelector(".tem-settings-popup");
  const fontMinusBtn = root.querySelector(".tem-font-minus");
  const fontPlusBtn = root.querySelector(".tem-font-plus");
  const fontSizeLabel = root.querySelector(".tem-font-size-label");
  const lineHeightMinusBtn = root.querySelector(".tem-lineheight-minus");
  const lineHeightPlusBtn = root.querySelector(".tem-lineheight-plus");
  const lineHeightLabel = root.querySelector(".tem-lineheight-label");
  const fontSelect = root.querySelector(".tem-font-select");
  const googleFontsList = root.querySelector(".tem-google-fonts-list");
  const googleFontAddBtn = root.querySelector(".tem-google-font-add");

  let wrapEnabled = true;
  const FONT_MIN = 4;
  const FONT_MAX = 500;
  let fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, initialFontSize || 12));
  const LINE_HEIGHT_MIN = 1;
  const LINE_HEIGHT_MAX = 3;
  const LINE_HEIGHT_STEP = 0.1;
  let lineHeightMultiplier = Math.min(
    LINE_HEIGHT_MAX,
    Math.max(LINE_HEIGHT_MIN, initialLineHeight || 1.3)
  );
  // Google Font <option> values are namespaced "google:<name>" so they
  // can't collide with a built-in's plain CSS value and are self-describing.
  const GOOGLE_OPTION_PREFIX = "google:";
  const googleFontFamilyValue = (name) => `"${name}", ${DEFAULT_FONT_FAMILY}`;
  let fontFamily = initialFontFamily || "";
  // Each entry: { url, name }. name is the parsed Google font-family name,
  // kept alongside the url so re-injecting the <link> on reload never needs
  // to re-parse it.
  let googleFonts = Array.isArray(initialGoogleFonts) ? initialGoogleFonts.slice() : [];
  input.value = initialValue || "";

  for (const group of BUILTIN_FONT_GROUPS) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const font of group.fonts) {
      const option = document.createElement("option");
      option.value = font.value;
      option.textContent = font.label;
      optgroup.appendChild(option);
    }
    fontSelect.appendChild(optgroup);
  }

  const googleOptgroup = document.createElement("optgroup");
  googleOptgroup.label = "Google Fonts";
  fontSelect.appendChild(googleOptgroup);

  // Rebuilds the "Google Fonts" <optgroup> options from the googleFonts
  // array. Called whenever a row is added, edited, or removed.
  function renderGoogleFontOptions() {
    googleOptgroup.innerHTML = "";
    for (const font of googleFonts) {
      const option = document.createElement("option");
      option.value = GOOGLE_OPTION_PREFIX + font.name;
      option.textContent = font.name;
      googleOptgroup.appendChild(option);
    }
    googleOptgroup.hidden = googleFonts.length === 0;
  }
  renderGoogleFontOptions();

  // Re-inject each saved font's <link> (lost on page refresh) without
  // re-parsing — the name was already resolved and persisted previously.
  for (const font of googleFonts) ensureGoogleFontLink(font.url);

  // If the persisted fontFamily matches one of the saved Google fonts,
  // select that option; otherwise treat it as a built-in value (falls back
  // to "Default" automatically if it matches nothing, e.g. after a removal).
  const activeGoogleFont = googleFonts.find((f) => googleFontFamilyValue(f.name) === fontFamily);
  fontSelect.value = activeGoogleFont ? GOOGLE_OPTION_PREFIX + activeGoogleFont.name : fontFamily;

  // One row per saved font, plus a trailing empty row to type a new one into.
  for (const font of googleFonts) createGoogleFontRow(font);
  addGoogleFontRow();

  // Renders one wrapper <div> per source line in the highlight layer so each
  // line's actual rendered height (after real word-wrapping) can be measured
  // from the DOM, instead of estimating wrapped-row counts from char widths.
  function renderHighlight() {
    const lines = input.value.split("\n");
    highlight.innerHTML = lines
      .map((line) => `<div>${highlightLine(line) || "&nbsp;"}</div>`)
      .join("");
  }

  function updateGutter() {
    const lineEls = highlight.children;
    const singleLineHeight = lineEls[0]?.getBoundingClientRect().height || 0;
    const rows = [];
    for (let i = 0; i < lineEls.length; i++) {
      rows.push(String(i + 1));
      if (wrapEnabled && singleLineHeight > 0) {
        const lineHeight = lineEls[i].getBoundingClientRect().height;
        const visualRows = Math.max(1, Math.round(lineHeight / singleLineHeight));
        for (let r = 1; r < visualRows; r++) rows.push("");
      }
    }
    gutter.innerHTML = rows.map((r) => `<div>${r || "&nbsp;"}</div>`).join("");
  }

  // Grows the textarea to its full content height so `.tem-body` is the only
  // scroll container; gutter and text then scroll together natively instead
  // of relying on mirrored scrollTop, which drifted once scrollbars appeared.
  function syncInputHeight() {
    input.style.height = "0px";
    input.style.height = `${Math.max(input.scrollHeight, highlight.offsetHeight)}px`;
  }

  function update() {
    renderHighlight();
    syncInputHeight();
    updateGutter();
    onChange?.(input.value);
  }

  function applyFontSize() {
    root.style.setProperty("--tem-font-size", `${fontSize}px`);
    fontSizeLabel.textContent = `${fontSize}px`;
    fontMinusBtn.disabled = fontSize <= FONT_MIN;
    fontPlusBtn.disabled = fontSize >= FONT_MAX;
    onFontSizeChange?.(fontSize);
    update(); // line heights depend on font size
  }

  function applyLineHeight() {
    // Rounds off floating point drift from repeated +/- 0.1 steps (e.g. 1.7999999999999998).
    lineHeightMultiplier = Math.round(lineHeightMultiplier * 10) / 10;
    root.style.setProperty("--tem-line-height", `${lineHeightMultiplier}`);
    lineHeightLabel.textContent = lineHeightMultiplier.toFixed(1);
    lineHeightMinusBtn.disabled = lineHeightMultiplier <= LINE_HEIGHT_MIN;
    lineHeightPlusBtn.disabled = lineHeightMultiplier >= LINE_HEIGHT_MAX;
    onLineHeightChange?.(lineHeightMultiplier);
    update(); // line heights depend on line-height
  }

  function applyFontFamily() {
    if (fontFamily) {
      root.style.setProperty("--tem-font-family", fontFamily);
    } else {
      root.style.removeProperty("--tem-font-family");
    }
    onFontFamilyChange?.(fontFamily);
    update(); // line/char widths depend on font family
  }

  function persistGoogleFonts() {
    onGoogleFontsChange?.(googleFonts.slice());
  }

  // Applies a built-in or previously-added Google font selection based on
  // the <select>'s current value.
  function applySelectedFont() {
    const value = fontSelect.value;
    if (value.startsWith(GOOGLE_OPTION_PREFIX)) {
      const name = value.slice(GOOGLE_OPTION_PREFIX.length);
      fontFamily = googleFontFamilyValue(name);
    } else {
      fontFamily = value;
    }
    applyFontFamily();
  }

  // Parses+applies one row's pasted Google Fonts URL, adding/updating its
  // entry in googleFonts and the dropdown. Leaves prior state (including
  // that row's own status) untouched if the URL isn't a recognizable
  // Google Fonts link, other than reporting the error in that row.
  function applyGoogleFontRow(row) {
    const trimmed = row.input.value.trim();
    const previousName = row.entry?.name;
    if (!trimmed) {
      row.setStatus("");
      return;
    }
    const name = parseGoogleFontUrl(trimmed);
    if (!name) {
      row.setStatus("Not a recognizable Google Fonts URL.", true);
      return;
    }
    ensureGoogleFontLink(trimmed);

    // Renaming an already-added row (URL edited to a different family)
    // replaces its old entry instead of appending a duplicate.
    if (previousName && previousName !== name) {
      googleFonts = googleFonts.filter((f) => f.name !== previousName);
    }
    const existingIndex = googleFonts.findIndex((f) => f.name === name);
    const entry = { url: trimmed, name };
    if (existingIndex >= 0) {
      googleFonts[existingIndex] = entry;
    } else {
      googleFonts.push(entry);
    }
    row.entry = entry;
    row.setStatus("");
    renderGoogleFontOptions();
    persistGoogleFonts();

    // Adding/confirming a font immediately makes it the active one, same
    // as picking it from the dropdown would.
    fontSelect.value = GOOGLE_OPTION_PREFIX + name;
    applySelectedFont();
  }

  // Creates one URL-input row in the popup for a (possibly empty, possibly
  // already-applied) Google Font entry.
  function createGoogleFontRow(entry) {
    const rowEl = document.createElement("div");
    rowEl.className = "tem-google-font-row";
    rowEl.innerHTML = `
      <input type="text" placeholder="https://fonts.googleapis.com/css2?family=..." spellcheck="false" />
      <button type="button" title="Remove this font">-</button>
    `;
    const rowInput = rowEl.querySelector("input");
    const removeBtn = rowEl.querySelector("button");
    const statusEl = document.createElement("span");
    statusEl.className = "tem-font-status";
    const statusWrap = document.createElement("div");
    statusWrap.appendChild(statusEl);

    const row = {
      entry: entry || null,
      input: rowInput,
      setStatus(text, isError) {
        statusEl.textContent = text;
        statusEl.classList.toggle("error", !!isError);
      },
    };

    if (entry) {
      rowInput.value = entry.url;
    }

    rowInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyGoogleFontRow(row);
      }
    });
    rowInput.addEventListener("blur", () => applyGoogleFontRow(row));

    removeBtn.addEventListener("click", () => {
      if (row.entry) {
        const wasSelected = fontFamily === googleFontFamilyValue(row.entry.name);
        googleFonts = googleFonts.filter((f) => f.name !== row.entry.name);
        renderGoogleFontOptions();
        persistGoogleFonts();
        if (wasSelected) {
          fontSelect.value = "";
          applySelectedFont();
        }
      }
      rowEl.remove();
      statusWrap.remove();
      // Always leave at least one (possibly empty) row so there's somewhere to type a new URL.
      if (!googleFontsList.querySelector(".tem-google-font-row")) addGoogleFontRow();
    });

    googleFontsList.appendChild(rowEl);
    googleFontsList.appendChild(statusWrap);
  }

  function addGoogleFontRow() {
    createGoogleFontRow(null);
  }

  input.addEventListener("input", update);
  // Stop ComfyUI's canvas from also handling drag/zoom while typing/scrolling.
  // Middle-click (button 1) is left alone so canvas panning still works over the textarea.
  // MIDDLE: 
  // input.addEventListener("pointerdown", (e) => {
  //   if (e.button !== 1) e.stopPropagation();
  // });
  // Scroll by a fixed number of lines per wheel click instead of the
  // browser's default (which varies by OS/pixel-vs-line delta mode).
  const SCROLL_LINES_PER_WHEEL = 3;
  input.addEventListener("wheel", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const lineHeight = fontSize * lineHeightMultiplier;
    body.scrollTop += Math.sign(e.deltaY) * SCROLL_LINES_PER_WHEEL * lineHeight;
  });

  fontMinusBtn.addEventListener("click", () => {
    fontSize = Math.max(FONT_MIN, fontSize - 1);
    applyFontSize();
  });

  fontPlusBtn.addEventListener("click", () => {
    fontSize = Math.min(FONT_MAX, fontSize + 1);
    applyFontSize();
  });

  lineHeightMinusBtn.addEventListener("click", () => {
    lineHeightMultiplier = Math.max(LINE_HEIGHT_MIN, lineHeightMultiplier - LINE_HEIGHT_STEP);
    applyLineHeight();
  });

  lineHeightPlusBtn.addEventListener("click", () => {
    lineHeightMultiplier = Math.min(LINE_HEIGHT_MAX, lineHeightMultiplier + LINE_HEIGHT_STEP);
    applyLineHeight();
  });

  fontSelect.addEventListener("change", applySelectedFont);

  googleFontAddBtn.addEventListener("click", addGoogleFontRow);

  wrapBtn.addEventListener("click", () => {
    wrapEnabled = !wrapEnabled;
    body.classList.toggle("wrap", wrapEnabled);
    body.classList.toggle("nowrap", !wrapEnabled);
    wrapBtn.textContent = `Wrap: ${wrapEnabled ? "On" : "Off"}`;
    wrapBtn.classList.toggle("active", wrapEnabled);
    update();
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
      input.setSelectionRange(0, 0);
    }
    copyBtn.textContent = "✅";
    copyBtn.classList.add("active");
    setTimeout(() => {
      copyBtn.textContent = "📋";
      copyBtn.classList.remove("active");
    }, 900);
  });

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPopup.classList.toggle("open");
  });

  // Stop scroll/drag inside the popup from reaching ComfyUI's canvas,
  // same reasoning as the wheel handler on the textarea above.
  settingsPopup.addEventListener("wheel", (e) => e.stopPropagation());
  settingsPopup.addEventListener("pointerdown", (e) => e.stopPropagation());

  function closeSettingsPopup() {
    settingsPopup.classList.remove("open");
  }

  document.addEventListener("pointerdown", (e) => {
    if (!settingsPopup.classList.contains("open")) return;
    if (!root.contains(e.target)) closeSettingsPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettingsPopup();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (wrapEnabled) {
      // Container width changed, so wrapped line heights may have too.
      syncInputHeight();
      updateGutter();
    }
  });
  resizeObserver.observe(body);

  applyFontSize();
  applyLineHeight();
  applyFontFamily();
  update();

  return {
    root,
    getValue: () => input.value,
    setValue: (v) => {
      input.value = v ?? "";
      update();
    },
  };
}

console.log("[text_editor_minimax] extension script loaded"); // confirms the JS file itself was fetched and executed

app.registerExtension({
  name: "minimax.TextEditorMinimax",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    console.log("[text_editor_minimax] starting........ 0 ");

    // Workflow restore calls node.configure(data) with the saved size/
    // properties. Whether that happens before or after the
    // requestAnimationFrame below is NOT guaranteed — it's usually fast
    // enough locally, but on a slow/remote/cloud machine the frame can fire
    // first, so node.size at that point is still the constructor's default
    // guess (computed from the original default STRING widget), not the
    // saved value. Hooking onConfigure directly instead of racing it tells
    // us for certain whether (and with what size) a restore happened.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const result = onConfigure?.apply(this, arguments);
      this._temConfigured = true;
      this._temConfiguredSize = Array.isArray(data?.size) ? data.size.slice() : null;
      return result;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      // Some ComfyUI frontend versions finish attaching the default
      // "text" STRING widget AFTER onNodeCreated returns (e.g. on the
      // next frame), so removing it synchronously here can be a no-op
      // and leave both the default textarea and our editor on the node.
      // Deferring one frame guarantees the default widget already exists.
      requestAnimationFrame(() => {
        // LiteGraph swallows exceptions thrown inside these callbacks
        // without printing anything to console, so we catch and log
        // ourselves — otherwise a failure here is invisible.
        try {
          if (node.widgets?.some((w) => w.name === WIDGET_NAME && w.type === "TEM_EDITOR")) {
            return; // already attached (e.g. re-entrant call)
          }

          // Remove any default widget(s) ComfyUI auto-created for the
          // "text" STRING input, so we can replace them with our editor.
          let initialValue = "";
          if (node.widgets) {
            for (let i = node.widgets.length - 1; i >= 0; i--) {
              const w = node.widgets[i];
              if (w.name === WIDGET_NAME) {
                initialValue = w.value ?? initialValue;
                w.onRemove?.();
                node.widgets.splice(i, 1);
              }
            }
          }

          // Stored on node.properties so it round-trips through the saved
          // workflow JSON (like size/position), surviving a page refresh.
          node.properties = node.properties || {};
          const editor = buildEditorElement(
            initialValue,
            () => {
              node.setDirtyCanvas(true, false);
            },
            node.properties.fontSize,
            (fontSize) => {
              node.properties.fontSize = fontSize;
            },
            node.properties.lineHeight,
            (lineHeight) => {
              node.properties.lineHeight = lineHeight;
            },
            node.properties.fontFamily,
            node.properties.googleFonts,
            (fontFamily) => {
              node.properties.fontFamily = fontFamily;
            },
            (googleFonts) => {
              node.properties.googleFonts = googleFonts;
            }
          );
          editor.root.style.minHeight = "220px";
          editor.root.style.minWidth = "340px";

          if (typeof node.addDOMWidget !== "function") {
            console.error(
              "[text_editor_minimax] node.addDOMWidget is not available on this ComfyUI frontend version."
            );
            return;
          }

          const widget = node.addDOMWidget(WIDGET_NAME, "TEM_EDITOR", editor.root, {
            getValue: editor.getValue,
            setValue: editor.setValue,
            getMinHeight: () => 220,
            getMinWidth: () => 340,
          });
          widget.serializeValue = () => stripComments(editor.getValue());

          // getMinWidth/getMinHeight above only influence computeSize() (used
          // for the initial auto-size below). LiteGraph does not otherwise
          // stop the node itself from being resized (or laid out, e.g. right
          // after selecting it) below that size — and once the node's actual
          // graph-space width drops under 340, the DOM widget's rendered box
          // shrinks with it. The inner CSS min-width/min-height on
          // editor.root can't fix that from the inside: it just overflows
          // its now-too-small container, which looks like the editor being
          // "locked" at 340 (or snapping smaller still) instead of actually
          // resizing. So clamp the node's own size directly on every resize.
          const MIN_NODE_WIDTH = 340;
          const MIN_NODE_HEIGHT = 220;
          // LiteGraph's own drag-resize handler clamps against node.min_size
          // before onResize ever runs, so setting this stops the user from
          // dragging the node below the editor's minimum in the first place.
          node.min_size = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
          const onResize = node.onResize;
          node.onResize = function (size) {
            const result = onResize?.apply(this, arguments);
            if (size) {
              size[0] = Math.max(size[0], MIN_NODE_WIDTH);
              size[1] = Math.max(size[1], MIN_NODE_HEIGHT);
            }
            return result;
          };

          // Only auto-size brand-new nodes; a restored node keeps its saved
          // size. We used to infer "was this restored?" from node.size
          // being non-zero here, but a brand-new node already gets a
          // non-zero default size from its own constructor-time
          // computeSize(), before configure() ever runs — so that check
          // almost never caught the "not restored" case. On a slow/remote
          // machine where this rAF could fire before configure() finishes,
          // that let a restored node settle on the stale default (then get
          // clamped to the 340x220 minimum) instead of its real saved size
          // — the "shrunk to 1/2 or 1/3" bug. _temConfigured is set
          // synchronously by configure() itself (see onConfigure above), so
          // it isn't a guess.
          if (!node._temConfigured) {
            const computed = node.computeSize();
            computed[0] = Math.max(computed[0], 400);
            computed[1] = Math.max(computed[1], 300);
            node.setSize?.(computed);
          } else {
            // A restored node's saved size might itself be smaller than the
            // editor's real minimum (e.g. from before this widget existed,
            // or saved while the bug was clipping it). Re-clamp now so it
            // doesn't render clipped until the next manual resize. Use the
            // size configure() actually applied rather than node.size read
            // fresh here, in case other deferred work has mutated it since.
            node.onResize(node._temConfiguredSize || node.size);
          }
        } catch (err) {
          console.error("[text_editor_minimax] failed to build custom widget:", err);
        }
      });

      return result;
    };
  },
});
