import { app } from "/scripts/app.js";

// Frontend half of Modular Timeline (see modular_timeline.py).
//
// The node's "timeline" input is drawn as a row of blocks whose edges are the
// "at <time>" markers in the node's input text. Reset reads the text and lays
// its markers out; dragging a marker (or nudging the selection with the arrow
// keys) changes its time in 0.1s steps. Shift+drag boxes several markers into
// the selection, and dragging any selected marker moves them all by the same
// amount. Only the marker times are sent to the backend, which rewrites the
// text's markers to them in order. The
// timeline's length and the text its blocks are labelled from are saved with
// the workflow but never sent, so changing them doesn't re-run anything.

// Must match node_id and the timeline input's type in modular_timeline.py.
const NODE_TYPE = "CherryModularTimeline";
const TIMELINE_TYPE = "CHERRY_TIMELINE";
const TEXT_INPUT = "text";
// Key the backend sends the node's input text back under after each run.
const RUN_TEXT_KEY = "timeline_text";

// "at", spaces, then a time as seconds ("6.4") or minutes:seconds
// ("00:03.400"). Must match MARKER_RE in modular_timeline.py.
const MARKER_RE = /\b(at[ \t]+)(\d+:\d+\.\d+|\d+\.\d+)/gi;

// Times are whole tenths of a second throughout, so 0.1s steps never drift.
const DEFAULT_LENGTH = 88; // 8.8s
const MIN_LENGTH = 1; // 0.1s
// When Reset finds a marker past the end, the timeline grows to this far past
// the last marker, rounded up to a whole second: 10.3s -> 11s.
const END_PADDING = 2;

// Upstream nodes that output one of their inputs unchanged, by that input's
// name. Reset follows these back to the text; any other node's text can only
// be read from this node's last run.
const TEXT_SOURCES = {
  TextEditorMinimax: "text",
  CherryTitlePublisher: "text",
  PrimitiveString: "value",
  PrimitiveStringMultiline: "value",
};

const MIN_HEIGHT = 185;
// Ruler tick spacing options, in tenths of a second.
// Ruler ticks are every 0.5s, or every 0.2s or 0.1s when those are at least
// FINE_TICK_SPACING_PX apart.
const TICK_STEP = 5;
const FINE_TICK_STEPS = [1, 2];
const FINE_TICK_SPACING_PX = 54;
// When ticks crowd together (a narrow node or a long timeline), lines and
// labels thin out to the first of these intervals that leaves room, in
// tenths of a second. Each divides the next, so the thinned-out marks are
// still evenly spaced.
const THINNED_TICK_STEPS = [10, 50, 100, 300, 600, 3000, 6000];
const MIN_LINE_SPACING_PX = 6;
const MIN_LABEL_GAP_PX = 4;
// How far a Shift+press has to move before it draws a selection box rather
// than counting as a Shift+click.
const BOX_THRESHOLD_PX = 4;
// Block hues, repeating along the timeline.
const BLOCK_HUES = [205, 330, 145, 35, 265, 175];

// "00:03.450" -> 35. Rounds half up on the hundredths digit.
function parseTime(time) {
  const [whole, decimals] = time.split(".");
  const [minutes, seconds] = whole.includes(":") ? whole.split(":").map(Number) : [0, Number(whole)];
  const roundUp = (decimals[1] ?? "0") >= "5" ? 1 : 0;
  return (minutes * 60 + seconds) * 10 + Number(decimals[0]) + roundUp;
}

// The markers' times in order, and the text around them: segments[k] is the
// text before marker k, and the last segment the text after the last marker.
function readMarkers(text) {
  const times = [];
  const segments = [];
  let end = 0;
  for (const match of text.matchAll(MARKER_RE)) {
    times.push(parseTime(match[2]));
    segments.push(text.slice(end, match.index));
    end = match.index + match[0].length;
  }
  segments.push(text.slice(end));
  return { times, segments };
}

// 34 -> "3.4"
function formatTime(tenths) {
  return (tenths / 10).toFixed(1);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A block's label: its text on one line, without the punctuation left over
// from the marker before it ("at 6.4, he jumps" -> "he jumps").
function blockLabel(segment) {
  return segment.replace(/\s+/g, " ").replace(/^[\s,.;:!?-]+/, "").trim();
}

// times with every selected marker moved by delta, all by the same amount, as
// far as the unselected markers and the ends (0 and length) allow. Selected
// markers keep their spacing, and no marker passes another.
function shiftSelected(times, selected, delta, length) {
  let min = -Infinity;
  let max = Infinity;
  for (const i of selected) {
    if (!selected.has(i - 1)) min = Math.max(min, (i > 0 ? times[i - 1] : 0) - times[i]);
    if (!selected.has(i + 1)) max = Math.min(max, (i < times.length - 1 ? times[i + 1] : length) - times[i]);
  }
  const shift = Math.min(max, Math.max(min, delta));
  return times.map((t, i) => (selected.has(i) ? t + shift : t));
}

// A saved value, cleaned up: times in order and within the length.
function normalizeState(value) {
  const times = Array.isArray(value?.times)
    ? value.times.map((t) => Math.max(0, Math.round(Number(t)) || 0))
    : [];
  for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1]);
  const length = Math.max(MIN_LENGTH, Math.round(Number(value?.length)) || DEFAULT_LENGTH, times.at(-1) ?? 0);
  return { times, length, text: typeof value?.text === "string" ? value.text : "" };
}

// In the queued prompt a linked input is [source node id, output slot].
function isLink(value) {
  return Array.isArray(value) && value.length === 2;
}

// A node's id in the queued prompt: its own id after the ids of the subgraph
// nodes it's inside ("12:5"). For a subgraph used by several nodes, the first
// one found.
function executionId(node) {
  const seen = new Set();
  const search = (graph, path) => {
    if (graph === node.graph) return [...path, node.id].join(":");
    seen.add(graph);
    for (const n of graph.nodes ?? graph._nodes ?? []) {
      if (!n.isSubgraphNode?.() || seen.has(n.subgraph)) continue;
      const id = search(n.subgraph, [...path, n.id]);
      if (id) return id;
    }
    return null;
  };
  return search(app.rootGraph ?? app.graph, []);
}

// The text the node would receive if queued now, worked out from the prompt
// without running anything. Reroutes, bypassed nodes and subgraphs are
// already flattened out of the prompt. Returns { text, from } with the title
// of the node holding the text, or { blockedBy } with the title of the first
// node whose output can't be known before it runs.
async function readQueuedText(node) {
  const id = executionId(node);
  if (!id) return {};
  const { output } = await app.graphToPrompt();
  let value = output[id]?.inputs?.[TEXT_INPUT];
  let from = null;
  // Bounded in case of a cycle, which the backend would reject anyway.
  for (let step = 0; step < 100 && isLink(value); step++) {
    const source = output[value[0]];
    const title = source?._meta?.title || source?.class_type;
    const key = TEXT_SOURCES[source?.class_type];
    if (!key) return { blockedBy: title };
    from = title;
    value = source.inputs?.[key];
  }
  return typeof value === "string" ? { text: value, from } : {};
}

// Reset changes the value after awaiting the prompt, which is after the
// mouseup the frontend records undo steps on, so record one here.
function captureUndoState() {
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

// Injected once; scoped with cmt- prefixed classes so it won't collide with
// ComfyUI's own styles.
function injectStyles() {
  if (document.getElementById("modular-timeline-style")) return;
  const style = document.createElement("style");
  style.id = "modular-timeline-style";
  style.textContent = `
    .cmt-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      padding: 6px 0;
      background: var(--comfy-input-bg, #1e1e1e);
      border: 1px solid var(--border-color, #333);
      border-radius: 6px;
      color: var(--input-text, #d4d4d4);
      font-size: 12px;
      user-select: none;
      overflow: hidden;
    }
    .cmt-toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding: 0 8px;
      flex: 0 0 auto;
    }
    .cmt-toolbar button {
      background: var(--comfy-menu-bg, #3a3a3a);
      color: inherit;
      border: 1px solid var(--border-color, #444);
      border-radius: 4px;
      padding: 2px 12px;
      font: inherit;
      cursor: pointer;
    }
    .cmt-toolbar button:hover:not(:disabled) {
      border-color: #d19a66;
    }
    .cmt-toolbar button:disabled {
      opacity: 0.6;
      cursor: progress;
    }
    .cmt-length {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--descrip-text, #9d9d9d);
    }
    .cmt-length input {
      width: 60px;
      background: var(--comfy-menu-bg, #2d2d2d);
      color: var(--input-text, #d4d4d4);
      border: 1px solid var(--border-color, #444);
      border-radius: 4px;
      padding: 1px 4px;
      font: inherit;
    }
    /* Ticks and blocks share the lane's coordinates: a time t sits at
       t / length of its width. Side margins leave room for the end labels.
       From top to bottom the lane holds the ruler's labels, the blocks, and
       the markers' time labels; the sizes below set all three. */
    .cmt-lane {
      --cmt-ruler-height: 14px;
      --cmt-ruler-font: 11px;
      --cmt-label-height: 22px;
      --cmt-label-font: 14px;
      --cmt-grab-width: 24px;
      --cmt-line-width: 6px;
      --cmt-block-time: 14px;
      position: relative;
      flex: 1 1 auto;
      min-height: 100px;
      margin: 0 22px;
      outline: none;
    }
    .cmt-ticks, .cmt-items {
      position: absolute;
      inset: 0;
    }
    .cmt-tick {
      position: absolute;
      top: 0;
      bottom: calc(var(--cmt-label-height) + 2px);
      border-left: 1px solid rgba(128, 128, 128, 0.32);
    }
    /* Between whole seconds. */
    .cmt-tick.minor {
      border-left-color: rgba(128, 128, 128, 0.16);
    }
    .cmt-tick span {
      position: absolute;
      top: 0;
      left: 0;
      transform: translateX(-50%);
      font-size: var(--cmt-ruler-font);
      line-height: var(--cmt-ruler-height);
      color: var(--descrip-text, #888);
      white-space: nowrap;
    }
    .cmt-block {
      position: absolute;
      top: calc(var(--cmt-ruler-height) + 3px);
      bottom: calc(var(--cmt-label-height) + 4px);
      display: flex;
      flex-direction: column;
      gap: 2px;
      box-sizing: border-box;
      padding: 3px 5px;
      overflow: hidden;
      border-radius: 4px;
      background: hsl(var(--cmt-hue) 55% 50% / 0.22);
      border: 1px solid hsl(var(--cmt-hue) 55% 60% / 0.55);
      font-size: 11px;
      line-height: 1.25;
    }
    .cmt-block[hidden] {
      display: none;
    }
    .cmt-block-time {
      font-size: var(--cmt-block-time);
      padding-bottom: 8px;
      flex: 0 0 auto;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cmt-block-text {
      flex: 1 1 auto;
      overflow: hidden;
      word-break: break-word;
      opacity: 0.85;
    }
    /* A wide, invisible grab area centred on the time, with the line and a
       label showing the time drawn inside it. */
    .cmt-marker {
      position: absolute;
      top: calc(var(--cmt-ruler-height) + 1px);
      bottom: 0;
      width: var(--cmt-grab-width);
      margin-left: calc(var(--cmt-grab-width) / -2);
      cursor: ew-resize;
      touch-action: none;
      z-index: 1;
    }
    .cmt-marker::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 0;
      bottom: var(--cmt-label-height);
      width: var(--cmt-line-width);
      transform: translateX(-50%);
      border-radius: 2px;
      background: #d19a66;
    }
    .cmt-marker-label {
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      padding: 0 6px;
      border-radius: 4px;
      background: #d19a66;
      color: #1e1e1e;
      font-size: var(--cmt-label-font);
      font-weight: 600;
      line-height: var(--cmt-label-height);
      white-space: nowrap;
    }
    .cmt-marker:hover, .cmt-marker.selected {
      z-index: 2;
    }
    .cmt-marker:hover::before, .cmt-marker.selected::before,
    .cmt-marker:hover .cmt-marker-label, .cmt-marker.selected .cmt-marker-label {
      background: #f0c38e;
    }
    .cmt-marker.selected .cmt-marker-label {
      box-shadow: 0 0 0 1px #fff;
    }
    .cmt-lane.dragging, .cmt-lane.dragging * {
      cursor: ew-resize;
    }
    .cmt-lane.boxing, .cmt-lane.boxing * {
      cursor: crosshair;
    }
    .cmt-box {
      position: absolute;
      z-index: 3;
      pointer-events: none;
      border: 1px dashed #f0c38e;
      border-radius: 2px;
      background: rgba(240, 195, 142, 0.12);
    }
    .cmt-status {
      flex: 0 0 auto;
      min-height: 14px;
      padding: 0 8px;
      font-size: 11px;
      color: var(--descrip-text, #999);
    }
    .cmt-status.warn {
      color: #e5c07b;
    }
  `;
  document.head.appendChild(style);
}

function createTimeline(node) {
  injectStyles();

  const root = document.createElement("div");
  root.className = "cmt-wrap";
  root.innerHTML = `
    <div class="cmt-toolbar">
      <button class="cmt-reset" type="button" title="Read the markers from the input text">Reset</button>
      <label class="cmt-length" title="Length of the timeline, in seconds">
        Length <input type="number" min="0.1" step="0.1" /> s
      </label>
    </div>
    <div class="cmt-lane" tabindex="0">
      <div class="cmt-ticks"></div>
      <div class="cmt-items"></div>
      <div class="cmt-box" hidden></div>
    </div>
    <div class="cmt-status"></div>
  `;
  const resetBtn = root.querySelector(".cmt-reset");
  const lengthInput = root.querySelector(".cmt-length input");
  const lane = root.querySelector(".cmt-lane");
  const ticks = root.querySelector(".cmt-ticks");
  const items = root.querySelector(".cmt-items");
  const box = root.querySelector(".cmt-box");
  const statusEl = root.querySelector(".cmt-status");

  let state = normalizeState(null);
  let labels = [];
  let blockEls = [];
  let markerEls = [];
  let ticksKey = "";
  // Indices of the selected markers, which drags and arrow keys move.
  let selected = new Set();
  // Text the node received on its last run, for when Reset can't read it.
  let lastRunText = null;
  // While the pointer is down: { mode: "move", pointerId, index, startTime,
  // origins } for dragging the selection, origins being every marker's time
  // when it started moving; or { mode: "box", pointerId, index, startX,
  // startY, before, boxing } for a Shift+press, before being the selection it
  // adds to.
  let drag = null;

  function setStatus(message, warn = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("warn", warn);
  }

  function showIdleStatus() {
    if (!state.times.length && !state.text) {
      setStatus("Press Reset to read the markers from the input text.");
    } else {
      setStatus(`${plural(state.times.length, "marker")}. Drag one to retime it.`);
    }
  }

  // Recreates the blocks and markers; only needed when their number changes.
  function build() {
    blockEls = [];
    markerEls = [];
    selected = new Set();
    items.replaceChildren();
    for (let k = 0; k <= state.times.length; k++) {
      const block = document.createElement("div");
      block.className = "cmt-block";
      block.style.setProperty("--cmt-hue", BLOCK_HUES[k % BLOCK_HUES.length]);
      const time = document.createElement("div");
      time.className = "cmt-block-time";
      const text = document.createElement("div");
      text.className = "cmt-block-text";
      block.append(time, text);
      items.appendChild(block);
      blockEls.push(block);
    }
    for (let i = 0; i < state.times.length; i++) {
      const marker = document.createElement("div");
      marker.className = "cmt-marker";
      marker.dataset.index = i;
      marker.title =
        "Drag to move. Shift+drag to box several, then drag one to move them together. " +
        "Shift+click adds or removes one. ← → nudge by 0.1s, with Shift by 1s.";
      const label = document.createElement("span");
      label.className = "cmt-marker-label";
      marker.appendChild(label);
      items.appendChild(marker);
      markerEls.push(marker);
    }
    relabel();
  }

  // Labels each block with the text it covers.
  function relabel() {
    const { segments } = readMarkers(state.text);
    labels = segments.length === blockEls.length ? segments.map(blockLabel) : [];
    blockEls.forEach((block, k) => {
      block.lastChild.textContent = labels[k] ?? "";
    });
    layout();
  }

  // Positions the blocks and markers for the current times and length.
  function layout() {
    const edges = [0, ...state.times, state.length];
    const percent = (t) => `${(t / state.length) * 100}%`;
    blockEls.forEach((block, k) => {
      const start = edges[k];
      const end = edges[k + 1];
      const duration = `${formatTime(end - start)}s`;
      block.style.left = percent(start);
      block.style.width = percent(end - start);
      block.hidden = end <= start;
      block.firstChild.textContent = duration;
      block.title = `${formatTime(start)}s – ${formatTime(end)}s (${duration})${labels[k] ? `\n\n${labels[k]}` : ""}`;
    });
    markerEls.forEach((marker, i) => {
      marker.style.left = percent(state.times[i]);
      marker.firstChild.textContent = formatTime(state.times[i]);
    });
    // Leave the field alone while it's being typed in.
    if (document.activeElement !== lengthInput) lengthInput.value = formatTime(state.length);
    drawTicks();
  }

  // Time marks along the top: a line and label every 0.5s or finer, thinned
  // out evenly only where they'd crowd together.
  function drawTicks() {
    const width = lane.clientWidth;
    const key = `${state.length}/${width}`;
    if (key === ticksKey) return;
    ticksKey = key;

    const pxPerTenth = width / state.length;
    const step = FINE_TICK_STEPS.find((s) => s * pxPerTenth >= FINE_TICK_SPACING_PX) ?? TICK_STEP;
    const intervals = [step, ...THINNED_TICK_STEPS];
    const lineEvery = intervals.find((i) => i * pxPerTenth >= MIN_LINE_SPACING_PX) ?? intervals.at(-1);

    ticks.replaceChildren();
    const marks = [];
    for (let t = 0; t <= state.length; t += lineEvery) {
      const tick = document.createElement("div");
      tick.className = "cmt-tick";
      tick.classList.toggle("minor", t % 10 !== 0);
      tick.style.left = `${(t / state.length) * 100}%`;
      const label = document.createElement("span");
      label.textContent = formatTime(t);
      tick.appendChild(label);
      ticks.appendChild(tick);
      marks.push({ t, label });
    }

    // Labels go on every line if the widest one fits between them.
    const widest = Math.max(...marks.map(({ label }) => label.offsetWidth));
    const labelEvery =
      intervals.find((i) => i >= lineEvery && i * pxPerTenth >= widest + MIN_LABEL_GAP_PX) ?? intervals.at(-1);
    for (const { t, label } of marks) {
      label.hidden = t % labelEvery !== 0;
      if (labelEvery % 10 === 0) label.textContent = String(t / 10);
    }
  }

  function select(indices) {
    selected = new Set(indices);
    markerEls.forEach((marker, i) => marker.classList.toggle("selected", selected.has(i)));
  }

  function toggleSelected(i) {
    const next = new Set(selected);
    if (!next.delete(i)) next.add(i);
    select(next);
  }

  // Moves the selected markers by delta from their times in origins.
  function moveSelected(delta, origins = state.times) {
    const times = shiftSelected(origins, selected, delta, state.length);
    if (times.every((t, i) => t === state.times[i])) return;
    state.times = times;
    layout();
  }

  // The markers at the same time as marker i, as [first, last] indices.
  function stackAt(i) {
    let first = i;
    let last = i;
    while (first > 0 && state.times[first - 1] === state.times[i]) first--;
    while (last < state.times.length - 1 && state.times[last + 1] === state.times[i]) last++;
    return [first, last];
  }

  // Markers at the same time are drawn on top of each other, and only the
  // one at the end of the pile can move away from it. So when a lone
  // selected marker is in a pile, the selection switches to the end it's
  // being moved towards.
  function settleStack(direction) {
    if (selected.size !== 1) return;
    const [first, last] = stackAt([...selected][0]);
    select([direction < 0 ? first : last]);
  }

  // Draws the Shift+drag box up to the pointer, and selects the markers
  // inside it on top of the ones selected before it started.
  function updateBox(e) {
    if (!drag.boxing) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < BOX_THRESHOLD_PX) return;
      drag.boxing = true;
      box.hidden = false;
      lane.classList.add("boxing");
    }
    // As fractions of the lane, which hold at any canvas zoom.
    const rect = lane.getBoundingClientRect();
    const fraction = (offset, size) => Math.min(1, Math.max(0, offset / size));
    const left = fraction(Math.min(drag.startX, e.clientX) - rect.left, rect.width);
    const right = fraction(Math.max(drag.startX, e.clientX) - rect.left, rect.width);
    const top = fraction(Math.min(drag.startY, e.clientY) - rect.top, rect.height);
    const bottom = fraction(Math.max(drag.startY, e.clientY) - rect.top, rect.height);
    box.style.left = `${left * 100}%`;
    box.style.width = `${(right - left) * 100}%`;
    box.style.top = `${top * 100}%`;
    box.style.height = `${(bottom - top) * 100}%`;
    const inBox = state.times.flatMap((t, i) =>
      t >= left * state.length && t <= right * state.length ? [i] : []
    );
    select([...drag.before, ...inBox]);
  }

  // Time under the pointer, in tenths.
  function timeAt(clientX) {
    const rect = lane.getBoundingClientRect();
    return Math.round(((clientX - rect.left) / rect.width) * state.length);
  }

  async function reset() {
    resetBtn.disabled = true;
    try {
      const input = node.inputs?.find((slot) => slot.name === TEXT_INPUT);
      if (input?.link == null) {
        setStatus("Connect a text to the input first.", true);
        return;
      }

      let queued = {};
      try {
        queued = await readQueuedText(node);
      } catch (err) {
        console.error("[modular_timeline] couldn't read the input text from the prompt:", err);
      }
      let text = queued.text;
      let from = queued.from ? `"${queued.from}"` : "the input";
      if (text == null && lastRunText != null) {
        text = lastRunText;
        from = "the last run";
      }
      if (text == null) {
        const source = queued.blockedBy ? `"${queued.blockedBy}"` : "the input";
        setStatus(`Can't read the text from ${source} before it runs. Run the workflow once, then press Reset.`, true);
        return;
      }

      const { times } = readMarkers(text);
      let reordered = 0;
      for (let i = 1; i < times.length; i++) {
        if (times[i] < times[i - 1]) {
          times[i] = times[i - 1];
          reordered++;
        }
      }
      const lastTime = times.at(-1) ?? 0;
      const length = lastTime > state.length ? Math.ceil((lastTime + END_PADDING) / 10) * 10 : state.length;
      state = { times, length, text };
      build();
      captureUndoState();

      if (!times.length) {
        setStatus(`No markers in the text from ${from}. They look like "at 3.4" or "at 00:03.400".`, true);
      } else if (reordered) {
        setStatus(
          `Read ${plural(times.length, "marker")} from ${from} (${reordered} out of order, moved up to the one before).`,
          true
        );
      } else {
        setStatus(`Read ${plural(times.length, "marker")} from ${from}.`);
      }
    } finally {
      resetBtn.disabled = false;
    }
  }

  resetBtn.addEventListener("click", reset);

  lengthInput.addEventListener("change", () => {
    const requested = Math.round(Number(lengthInput.value) * 10);
    if (lengthInput.value.trim() === "" || !Number.isFinite(requested)) {
      lengthInput.value = formatTime(state.length);
      return;
    }
    const lastTime = state.times.at(-1) ?? 0;
    state.length = Math.max(MIN_LENGTH, lastTime, requested);
    lengthInput.value = formatTime(state.length);
    layout();
    if (requested < MIN_LENGTH) {
      setStatus(`The length can't be less than ${formatTime(MIN_LENGTH)}s.`, true);
    } else if (requested < lastTime) {
      setStatus(`The length can't be shorter than the last marker (${formatTime(lastTime)}s).`, true);
    } else {
      showIdleStatus();
    }
  });

  // Pointer handling lives on the lane, which holds the pointer capture, so
  // drags and boxes keep going when the pointer leaves the marker or lane.
  lane.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // No preventDefault: that would also cancel the mouseup the frontend
    // records undo steps on. user-select: none stops text selection instead.
    e.stopPropagation();
    // Focused so the arrow keys and Escape reach it.
    lane.focus({ preventScroll: true });
    const marker = e.target.closest(".cmt-marker");
    const index = marker ? Number(marker.dataset.index) : null;

    if (e.shiftKey) {
      drag = {
        mode: "box",
        pointerId: e.pointerId,
        index,
        startX: e.clientX,
        startY: e.clientY,
        before: new Set(selected),
        boxing: false,
      };
    } else if (marker) {
      // Grabbing a selected marker (or a pile with one in it) moves the whole
      // selection; grabbing any other selects just that one.
      const [first, last] = stackAt(index);
      let inSelection = false;
      for (let i = first; i <= last; i++) inSelection ||= selected.has(i);
      if (!inSelection) select([index]);
      drag = { mode: "move", pointerId: e.pointerId, index, startTime: timeAt(e.clientX), origins: null };
    } else {
      select([]);
      return;
    }
    lane.setPointerCapture(e.pointerId);
  });

  lane.addEventListener("pointermove", (e) => {
    if (drag?.pointerId !== e.pointerId) return;
    if (drag.mode === "box") {
      updateBox(e);
      return;
    }
    const delta = timeAt(e.clientX) - drag.startTime;
    if (!drag.origins) {
      if (delta === 0) return;
      settleStack(delta);
      drag.origins = state.times.slice();
      lane.classList.add("dragging");
    }
    moveSelected(delta, drag.origins);
  });

  function endDrag(e) {
    if (drag?.pointerId !== e.pointerId) return;
    const clicked = e.type === "pointerup";
    if (clicked && drag.mode === "box" && !drag.boxing && drag.index !== null) {
      toggleSelected(drag.index);
    } else if (clicked && drag.mode === "move" && !drag.origins) {
      // A plain click on one marker of a selection narrows it to that one.
      select([drag.index]);
    }
    drag = null;
    box.hidden = true;
    lane.classList.remove("dragging", "boxing");
  }
  lane.addEventListener("pointerup", endDrag);
  lane.addEventListener("pointercancel", endDrag);

  lane.addEventListener("keydown", (e) => {
    if (!selected.size) return;
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (e.key === "Escape") {
      select([]);
    } else if (direction) {
      settleStack(direction);
      moveSelected(direction * (e.shiftKey ? 10 : 1));
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  // The lane's width sets how many ticks fit.
  const resizeObserver = new ResizeObserver(() => drawTicks());
  resizeObserver.observe(lane);

  build();
  showIdleStatus();

  return {
    root,
    getValue: () => state,
    setValue: (value) => {
      state = normalizeState(value);
      build();
      showIdleStatus();
    },
    // What the backend gets: the marker times in seconds, e.g. "[3.4,6.4]".
    serializeValue: () => JSON.stringify(state.times.map((t) => t / 10)),
    // Called with the text the node received, after each run.
    onRun: (text) => {
      if (typeof text !== "string") return;
      lastRunText = text;
      const found = readMarkers(text).times.length;
      if (!state.times.length && !state.text) {
        if (found) setStatus(`Press Reset to lay out the ${plural(found, "marker")} in the input.`);
      } else if (found !== state.times.length) {
        setStatus(
          `The input now has ${plural(found, "marker")} but the timeline has ${state.times.length}. Press Reset to rebuild it.`,
          true
        );
      } else {
        // Same markers, maybe different words around them: keep the times,
        // update the labels.
        if (text !== state.text) {
          state.text = text;
          relabel();
        }
        showIdleStatus();
      }
    },
    // Detaches what's registered outside root, so a deleted node can be
    // garbage-collected.
    destroy: () => resizeObserver.disconnect(),
  };
}

app.registerExtension({
  name: "cherry.ModularTimeline",

  getCustomWidgets() {
    return {
      [TIMELINE_TYPE](node, inputName) {
        const timeline = createTimeline(node);
        const widget = node.addDOMWidget(inputName, TIMELINE_TYPE, timeline.root, {
          getValue: timeline.getValue,
          setValue: timeline.setValue,
          getMinHeight: () => MIN_HEIGHT,
          // Set by dragging, never by a link.
          socketless: true,
        });
        // The workflow saves the whole value; the prompt only gets the times.
        widget.serializeValue = timeline.serializeValue;

        // ComfyUI calls widget.onRemove when the node is deleted.
        const onRemove = widget.onRemove;
        widget.onRemove = function () {
          timeline.destroy();
          return onRemove?.apply(this, arguments);
        };

        node._modularTimeline = timeline;
        return { widget };
      },
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output) {
      const result = onExecuted?.apply(this, arguments);
      this._modularTimeline?.onRun(output?.[RUN_TEXT_KEY]?.[0]);
      return result;
    };
  },

  // New nodes start wide enough to read the blocks. Loaded ones get their
  // saved size right after this.
  nodeCreated(node) {
    if (node.comfyClass !== NODE_TYPE) return;
    node.setSize([Math.max(node.size[0], 640), Math.max(node.size[1], 240)]);
  },
});
