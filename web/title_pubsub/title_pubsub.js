import { app } from "/scripts/app.js";

// Frontend half of the Title Publisher / Title Subscriber pair (see
// title_pubsub.py).
//
// Nothing is sent while the workflow runs. Instead, the prompt ComfyUI builds
// when queueing (or exporting API JSON) is rewritten: each publisher walks
// back from its "text" input to the furthest TextEditorMinimax node, and every
// subscriber set to that publisher's name gets the editor's title as its
// "title" input. Reroutes, bypassed nodes and subgraphs are already flattened
// out of that prompt, so the walk never has to deal with them.

// Must match node_id in title_pubsub.py and text_editor_minimax.py.
const PUBLISHER_TYPE = "CherryTitlePublisher";
const SUBSCRIBER_TYPE = "CherryTitleSubscriber";
const EDITOR_TYPE = "TextEditorMinimax";

const NAME_WIDGET = "name"; // publisher's name
const CHANNEL_WIDGET = "channel"; // subscriber's chosen publisher name
const TEXT_INPUT = "text"; // publisher input the walk starts from
const TITLE_INPUT = "title"; // added to subscribers in the queued prompt
const DEFAULT_NAME = "prompt";

// A publisher's name is settled (numbered if taken, followed by its
// subscribers) this long after the last edit, in case the widget reports
// every keystroke rather than the finished name.
const NAME_COMMIT_DELAY_MS = 300;

// class_type -> { inputOrder, outputTypes } for every node definition, so the
// walk knows which input comes first and which links carry text.
const nodeDefs = new Map();

// Publisher node -> { timer, followRename } for names waiting to be settled.
const pendingCommits = new Map();

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

// Every node in the workflow, including those inside subgraphs. A subgraph
// used by several nodes is only visited once.
function allNodes() {
  const nodes = [];
  const seen = new Set();
  const visit = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph.nodes ?? graph._nodes ?? []) {
      nodes.push(node);
      if (node.isSubgraphNode?.()) visit(node.subgraph);
    }
  };
  visit(app.rootGraph ?? app.graph);
  return nodes;
}

function publisherName(node) {
  const value = getWidget(node, NAME_WIDGET)?.value;
  return typeof value === "string" ? value : "";
}

// Adds (or bumps) a trailing number until the name is free:
// "prompt" -> "prompt 1" -> "prompt 2", and "take3" -> "take4".
function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const match = name.match(/^(.*?)(\s*)(\d+)$/);
  const base = match ? match[1] : name;
  const separator = match ? match[2] : " ";
  let n = match ? Number(match[3]) + 1 : 1;
  while (taken.has(`${base}${separator}${n}`)) n++;
  return `${base}${separator}${n}`;
}

// Points every subscriber's dropdown at the current publisher names.
function refreshSubscriberOptions(nodes = allNodes()) {
  const names = [
    ...new Set(nodes.filter((n) => n.type === PUBLISHER_TYPE).map(publisherName).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const node of nodes) {
    if (node.type !== SUBSCRIBER_TYPE) continue;
    const channel = getWidget(node, CHANNEL_WIDGET);
    // A new array per widget: the node definition's (empty) options array
    // can be shared between nodes, and some frontend code pushes into it.
    if (channel?.options) channel.options.values = [...names];
  }
  app.canvas?.setDirty?.(true, true);
}

// Settles a publisher's name: trimmed, restored if it was cleared, and
// numbered if another publisher already has it. With followRename,
// subscribers set to the old name move to the new one.
function commitPublisherName(node, followRename) {
  clearTimeout(pendingCommits.get(node)?.timer);
  pendingCommits.delete(node);
  const widget = getWidget(node, NAME_WIDGET);
  if (!widget || !node.graph) return; // removed before the timer fired

  const nodes = allNodes();
  // Publishers still waiting to settle don't hold their name yet, so when
  // several arrive at once the first ones keep theirs.
  const others = new Set(
    nodes
      .filter((n) => n.type === PUBLISHER_TYPE && n !== node && !pendingCommits.has(n))
      .map(publisherName)
  );
  const previous = node._titlePubsubName;
  const name = uniqueName(publisherName(node).trim() || previous || DEFAULT_NAME, others);
  widget.value = name;
  node._titlePubsubName = name;

  // If another publisher still has the old name (only possible in a
  // workflow saved with duplicates), its subscribers can't be told apart
  // from ours, so leave them all alone.
  if (followRename && previous && previous !== name && !others.has(previous)) {
    for (const sub of nodes) {
      if (sub.type !== SUBSCRIBER_TYPE) continue;
      const channel = getWidget(sub, CHANNEL_WIDGET);
      if (channel?.value === previous) channel.value = name;
    }
  }
  refreshSubscriberOptions(nodes);
}

function scheduleCommit(node, followRename, delay) {
  clearTimeout(pendingCommits.get(node)?.timer);
  const timer = setTimeout(() => commitPublisherName(node, followRename), delay);
  pendingCommits.set(node, { timer, followRename });
}

// Settles names still waiting on their timer, e.g. when queueing right after
// typing one.
function flushPendingCommits() {
  for (const [node, { followRename }] of [...pendingCommits]) {
    commitPublisherName(node, followRename);
  }
}

// In the queued prompt a linked input is [source node id, output slot];
// array widget values are wrapped in { __value__ }, so they never look like
// this.
function isLink(value) {
  return Array.isArray(value) && value.length === 2;
}

// "*" and unknown types might be text, so they count.
function carriesText(output, [sourceId, slot]) {
  const type = nodeDefs.get(output[sourceId]?.class_type)?.outputTypes?.[slot];
  if (type === undefined) return true;
  return typeof type === "string" && (type === "*" || type.split(",").includes("STRING"));
}

// The link to follow backwards from a node: its last linked input (in the
// node's declared input order) that carries text. A node with no text links,
// e.g. one fed only by an image, falls back to its last link.
function upstreamLink(output, node) {
  const inputs = node.inputs ?? {};
  const declared = nodeDefs.get(node.class_type)?.inputOrder ?? [];
  const links = [...new Set([...declared, ...Object.keys(inputs)])]
    .map((key) => inputs[key])
    .filter(isLink);
  return links.findLast((link) => carriesText(output, link)) ?? links.at(-1);
}

// Title of the furthest TextEditorMinimax behind a publisher, or "" if the
// walk never reaches one.
function findEditorTitle(output, publisherId) {
  let title = "";
  const visited = new Set([publisherId]);
  let link = output[publisherId]?.inputs?.[TEXT_INPUT];
  while (isLink(link)) {
    const id = String(link[0]);
    const node = output[id];
    if (!node || visited.has(id)) break;
    visited.add(id);
    if (node.class_type === EDITOR_TYPE) title = node._meta?.title ?? "";
    link = upstreamLink(output, node);
  }
  return title;
}

// Rewrites the queued prompt in place: each subscriber gets the title for its
// channel, and the names used to match them are removed so they don't affect
// caching.
function resolveSubscriberTitles(output) {
  const titles = new Map(); // publisher name -> editor title
  for (const [id, node] of Object.entries(output)) {
    if (node.class_type !== PUBLISHER_TYPE || !node.inputs) continue;
    const name = node.inputs[NAME_WIDGET];
    delete node.inputs[NAME_WIDGET];
    // Names are unique in the editor, but a subgraph used twice puts two
    // copies of its publisher here. The first one wins.
    if (typeof name === "string" && !titles.has(name)) {
      titles.set(name, findEditorTitle(output, id));
    }
  }
  for (const node of Object.values(output)) {
    if (node.class_type !== SUBSCRIBER_TYPE) continue;
    node.inputs ??= {};
    const channel = node.inputs[CHANNEL_WIDGET];
    delete node.inputs[CHANNEL_WIDGET];
    node.inputs[TITLE_INPUT] = titles.get(channel) ?? "";
  }
}

function setupPublisher(nodeType) {
  // Loaded or pasted: the saved name is the settled one. Pasted copies are
  // then numbered by onAdded below.
  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const result = onConfigure?.apply(this, arguments);
    this._titlePubsubName = publisherName(this);
    return result;
  };

  // New, pasted and cloned publishers get a free name. Deferred so a paste
  // has applied the copied name first. Skipped while a workflow is loading,
  // so opening a file never renames anything.
  const onAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const result = onAdded?.apply(this, arguments);
    if (!app.configuringGraph) scheduleCommit(this, false, 0);
    return result;
  };

  // Hooked at node level rather than on the widget's callback: widget
  // setValue reports every edit here, and the frontend's own error clearing
  // listens here too.
  const onWidgetChanged = nodeType.prototype.onWidgetChanged;
  nodeType.prototype.onWidgetChanged = function (name) {
    const result = onWidgetChanged?.apply(this, arguments);
    if (name === NAME_WIDGET) scheduleCommit(this, true, NAME_COMMIT_DELAY_MS);
    return result;
  };

  const onRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    const result = onRemoved?.apply(this, arguments);
    clearTimeout(pendingCommits.get(this)?.timer);
    pendingCommits.delete(this);
    // Deferred: the node may still be listed in its graph at this point.
    setTimeout(() => refreshSubscriberOptions(), 0);
    return result;
  };
}

function setupSubscriber(nodeType) {
  // Loaded subscribers are covered by afterConfigureGraph below.
  const onAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const result = onAdded?.apply(this, arguments);
    if (!app.configuringGraph) setTimeout(() => refreshSubscriberOptions(), 0);
    return result;
  };
}

app.registerExtension({
  name: "cherry.TitlePubSub",

  async setup() {
    const graphToPrompt = app.graphToPrompt;
    app.graphToPrompt = async function () {
      flushPendingCommits();
      const result = await graphToPrompt.apply(this, arguments);
      try {
        if (result?.output) resolveSubscriberTitles(result.output);
      } catch (err) {
        // Subscribers then output "", which beats a prompt that can't queue.
        console.error("[title_pubsub] failed to resolve subscriber titles:", err);
      }
      return result;
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const order = nodeData.input_order ?? {
      required: Object.keys(nodeData.input?.required ?? {}),
      optional: Object.keys(nodeData.input?.optional ?? {}),
    };
    nodeDefs.set(nodeData.name, {
      inputOrder: [...(order.required ?? []), ...(order.optional ?? [])],
      outputTypes: nodeData.output ?? [],
    });

    if (nodeData.name === PUBLISHER_TYPE) setupPublisher(nodeType);
    if (nodeData.name === SUBSCRIBER_TYPE) setupSubscriber(nodeType);
  },

  // A workflow was opened (or undo/redo restored one), so every publisher
  // name may have changed.
  async afterConfigureGraph() {
    refreshSubscriberOptions();
  },

  // "Refresh node definitions" resets combo options to the server's (empty)
  // list, so put the publisher names back.
  async refreshComboInNodes() {
    refreshSubscriberOptions();
  },
});
