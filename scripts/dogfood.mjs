#!/usr/bin/env node
// Dogfood run of the plugin outside Buzz: loads plugin/plugin.js with a fake
// Cordis ctx (React, relay session, agents, pages, settings cards) and plays the
// reactions a real owner sends from desktop and mobile. It proves the
// reaction -> verdict path end to end, with the default map, a saved custom map,
// and a map changed in the settings card, without a relay or the desktop app.
// The pre-push hook runs it on every pushed commit (.githooks/pre-push.d).
//
// Usage: node scripts/dogfood.mjs [--plugin PATH] [--defaults-only] [--transcript]
//   --plugin PATH    plugin module to load (default: plugin/plugin.js)
//   --defaults-only  only the default-map scenarios, which any revision must pass
//   --transcript     print what the plugin posted and logged as JSON, so two
//                    revisions can be compared with diff
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PLUGIN = "plugin/plugin.js";
const STORAGE_KEY = "sagmans.reaction-verdicts.verdict-map.v1";
// Fake keys built at run time, so no real-looking key is ever committed.
const OWNER = "1".repeat(64);
const STRANGER = "2".repeat(64);
const AGENT = "3".repeat(64);
const OTHER_AGENT = "4".repeat(64);
const AGENT_NAME = "Helper";
const STREAM = "stream-channel";
const SOLO = "solo-channel";
const ROOT_ID = "5".repeat(64);
// Rounds of the event loop to wait for the plugin's async relay read.
const SETTLE_ROUNDS = 5;
// Manifest rules from the Buzz plugin API v1 (docs/plugin-architecture.md).
const MANIFEST_ID = /^[a-z][a-z0-9.-]{0,79}$/;
const MAX_DESCRIPTION_BYTES = 280;
const API_VERSION = 1;

let nextId = 0;
function eventId() {
  nextId += 1;
  return nextId.toString(16).padStart(64, "a");
}

/** Minimal React: elements as plain objects, hooks kept per mounted component. */
function createFakeReact() {
  let hooks = [];
  let index = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const slot = hooks;
      const i = index++;
      if (!(i in slot)) slot[i] = typeof initial === "function" ? initial() : initial;
      return [slot[i], (value) => (slot[i] = value)];
    },
    useSyncExternalStore(_subscribe, snapshot) {
      index++;
      return snapshot();
    },
  };
  function mount(Component, props) {
    const own = [];
    return () => {
      hooks = own;
      index = 0;
      return Component(props);
    };
  }
  return { React, mount };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node !== "object") return String(node);
  return node.children.map(textOf).join(" ");
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function createStorage(initial = {}, { failRead = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) {
      if (failRead) throw new Error("storage blocked");
      return data.has(key) ? data.get(key) : null;
    },
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function createSession(generation, messages, posts, failPosts) {
  const live = new Set();
  const post = (kind, args) => {
    if (failPosts.value) throw new Error("mention refused");
    posts.push({ kind, args });
  };
  return {
    generation,
    live,
    channels: new Map([
      [STREAM, { channelType: "stream" }],
      [SOLO, { channelType: "solo" }],
    ]),
    read: async ([filter]) => filter.ids.map((id) => messages.get(id)).filter(Boolean),
    subscribeLive(listener) {
      live.add(listener);
      return () => live.delete(listener);
    },
    messages: {
      reply: (...args) => post("reply", args),
      send: (...args) => post("send", args),
    },
  };
}

/** A running plugin with a fake host, plus helpers to play events into it. */
async function startPlugin(pluginPath, storage) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  const plugin = await import(pathToFileURL(resolve(pluginPath)).href);
  const posts = [];
  const wakes = [];
  const pages = [];
  const cards = [];
  const cleanups = [];
  const messages = new Map();
  const failPosts = { value: false };
  const relayListeners = new Set();
  let snap = { status: "ready", generation: 1, viewer: OWNER, session: createSession(1, messages, posts, failPosts) };
  const agentsById = new Map([
    [AGENT, { key: `key-${AGENT_NAME}`, pubkey: AGENT, name: AGENT_NAME, owner: OWNER }],
    [OTHER_AGENT, { key: "key-other", pubkey: OTHER_AGENT, name: "Other", owner: STRANGER }],
  ]);
  const fake = createFakeReact();
  const ctx = {
    react: fake.React,
    relay: {
      snapshot: () => snap,
      subscribe(listener) {
        relayListeners.add(listener);
        return () => relayListeners.delete(listener);
      },
    },
    agents: {
      find: (pubkey) => agentsById.get(pubkey),
      wake: (key, options) => wakes.push({ key, ...options }),
    },
    pages: { register: (page) => pages.push(page) },
    effect: (setup) => cleanups.push(setup()),
    inject: (_deps, callback) => callback({ settingsCards: { register: (card) => cards.push(card) } }),
  };
  assert.deepEqual(plugin.inject, ["react", "pages", "relay", "agents"]);
  plugin.apply(ctx);
  return {
    posts,
    wakes,
    pages,
    cards,
    messages,
    failPosts,
    fake,
    session: () => snap.session,
    reconnect() {
      snap = { ...snap, generation: snap.generation + 1, session: createSession(snap.generation + 1, messages, posts, failPosts) };
      relayListeners.forEach((listener) => listener());
    },
    stop: () => cleanups.forEach((cleanup) => cleanup()),
    activityText: () => textOf(fake.mount(pages[0].component, {})()),
  };
}

function agentMessage(running, { channel = STREAM, author = AGENT, threaded = true } = {}) {
  const tags = [["h", channel]];
  if (threaded) tags.push(["e", ROOT_ID, "", "root"], ["e", ROOT_ID, "", "reply"]);
  const message = { id: eventId(), kind: 9, pubkey: author, content: "May I deploy the change?", tags };
  running.messages.set(message.id, message);
  return message;
}

function reaction(target, content, { from = OWNER, channel = target.tags[0][1], mobile = false } = {}) {
  const tags = mobile ? [["e", target.id]] : [["h", channel], ["e", target.id], ["p", target.pubkey]];
  return { id: eventId(), kind: 7, pubkey: from, content, tags };
}

async function play(running, events, { replay = false } = {}) {
  running.session().live.forEach((listener) => listener({ replay, events }));
  for (let i = 0; i < SETTLE_ROUNDS; i++) await new Promise((done) => setImmediate(done));
}

function lastPost(running) {
  return running.posts[running.posts.length - 1];
}

function expectReply(running, target, verdict) {
  assert.deepEqual(lastPost(running), {
    kind: "reply",
    args: [STREAM, ROOT_ID, `@${AGENT_NAME} ${verdict}`, [AGENT], [], target.id],
  });
}

const DEFAULT_PAIRS = [
  ["👍", "APPROVED"],
  ["+", "APPROVED"],
  ["👎", "REJECTED"],
  ["-", "REJECTED"],
  ["❓", "CLARIFY"],
  ["❔", "CLARIFY"],
  ["💾", "SAVE_LEARNINGS"],
  ["🔍", "VERIFY"],
  ["🔎", "VERIFY"],
];

async function defaultDeliveryScenarios(run) {
  await run("default map: every verdict emoji posts a mention reply in the thread", async (p) => {
    for (const [emoji, verdict] of DEFAULT_PAIRS) {
      const target = agentMessage(p);
      await play(p, [reaction(target, emoji)]);
      expectReply(p, target, verdict);
    }
  });
  await run("mobile reaction without h tag and with a skin tone still counts", async (p) => {
    const target = agentMessage(p);
    await play(p, [reaction(target, "👎🏽", { mobile: true })]);
    expectReply(p, target, "REJECTED");
  });
  await run("solo chat names the judged message in a plain send", async (p) => {
    const target = agentMessage(p, { channel: SOLO, threaded: false });
    await play(p, [reaction(target, "👍")]);
    assert.deepEqual(lastPost(p), {
      kind: "send",
      args: [SOLO, `@${AGENT_NAME} APPROVED for your message ${target.id}`, [AGENT]],
    });
  });
  await run("unthreaded stream message becomes the thread root", async (p) => {
    const target = agentMessage(p, { threaded: false });
    await play(p, [reaction(target, "🔍")]);
    assert.deepEqual(lastPost(p).args.slice(0, 3), [STREAM, target.id, `@${AGENT_NAME} VERIFY`]);
  });
  await run("failed mention falls back to a direct wake with the verdict meaning", async (p) => {
    const target = agentMessage(p);
    p.failPosts.value = true;
    const event = reaction(target, "👎");
    await play(p, [event]);
    assert.equal(p.posts.length, 0);
    assert.equal(p.wakes.length, 1);
    assert.equal(p.wakes[0].key, `key-${AGENT_NAME}`);
    assert.equal(p.wakes[0].root, ROOT_ID);
    assert.ok(
      p.wakes[0].text.startsWith(
        `OWNER VERDICT: REJECTED. The owner rejects the request in that message. The owner (${OWNER}) reacted "👎" to your message ${target.id}.`,
      ),
    );
    assert.ok(p.wakes[0].text.includes(`Reaction event ${event.id}`));
  });
}

async function defaultSkipScenarios(run) {
  await run("skips: stranger, other emoji, other owner, channel mismatch, replay, duplicate", async (p) => {
    const target = agentMessage(p);
    await play(p, [reaction(target, "👍", { from: STRANGER })]);
    await play(p, [reaction(target, "🎉")]);
    await play(p, [reaction(agentMessage(p, { author: OTHER_AGENT }), "👍")]);
    await play(p, [reaction(target, "👍", { channel: "another-channel" })]);
    await play(p, [reaction(target, "👍")], { replay: true });
    assert.equal(p.posts.length, 0);
    const twice = reaction(target, "👍");
    await play(p, [twice, twice]);
    assert.equal(p.posts.length, 1);
    const page = p.activityText();
    for (const reason of [
      "not the owner's reaction",
      "not a verdict emoji",
      "agent has another owner",
      "reaction and target channels differ",
    ])
      assert.ok(page.includes(`skipped: ${reason}`), reason);
    assert.ok(page.includes("👍 = APPROVED"));
  });
  await run("reconnect listens on the new session; cleanup stops listening", async (p) => {
    const first = p.session();
    p.reconnect();
    assert.equal(first.live.size, 0);
    const target = agentMessage(p);
    await play(p, [reaction(target, "👍")]);
    expectReply(p, target, "APPROVED");
    assert.ok(p.activityText().includes("listening (generation 2)"));
    p.stop();
    assert.equal(p.session().live.size, 0);
  });
}

async function savedMapScenarios(run) {
  const custom = JSON.stringify({ version: 1, text: "# team map\n🚀 SHIP Ship the change now.\n👍\tLGTM" });
  await run("saved custom map replaces the defaults", async (p) => {
    const ship = agentMessage(p);
    await play(p, [reaction(ship, "🚀")]);
    expectReply(p, ship, "SHIP");
    const lgtm = agentMessage(p);
    await play(p, [reaction(lgtm, "👍🏻")]);
    expectReply(p, lgtm, "LGTM");
    await play(p, [reaction(agentMessage(p), "👎")]);
    assert.equal(p.posts.length, 2);
    assert.ok(p.activityText().includes("🚀 = SHIP, 👍 = LGTM"));
    p.failPosts.value = true;
    await play(p, [reaction(agentMessage(p), "🚀"), reaction(agentMessage(p), "👍")]);
    assert.ok(p.wakes[0].text.startsWith("OWNER VERDICT: SHIP. Ship the change now. The owner"));
    assert.ok(p.wakes[1].text.startsWith("OWNER VERDICT: LGTM. The owner gave the verdict LGTM on that message."));
  }, { [STORAGE_KEY]: custom });
  await run("corrupt saved map fails closed: no reaction counts", async (p) => {
    await play(p, [reaction(agentMessage(p), "👍")]);
    assert.equal(p.posts.length, 0);
    assert.ok(p.activityText().includes("skipped: the verdict map in Settings is invalid"));
  }, { [STORAGE_KEY]: "{not json" });
  await run("unreadable storage keeps the defaults", async (p) => {
    const target = agentMessage(p);
    await play(p, [reaction(target, "👍")]);
    expectReply(p, target, "APPROVED");
  }, {}, { failRead: true });
}

function cardControls(render) {
  const tree = render();
  return {
    tree,
    text: textOf(tree),
    textarea: findNode(tree, (n) => n.type === "textarea"),
    form: findNode(tree, (n) => n.type === "form"),
    reset: findNode(tree, (n) => n.type === "button" && textOf(n) === "Reset to defaults"),
  };
}

async function settingsCardScenarios(run) {
  await run("settings card validates, saves live, and resets", async (p, storage) => {
    assert.equal(p.cards.length, 1);
    assert.equal(p.cards[0].group, "Plugins");
    let isActive = true;
    const render = p.fake.mount(p.cards[0].component, { active: () => isActive });
    const submit = () => cardControls(render).form.props.onSubmit({ preventDefault() {} });
    assert.ok(cardControls(render).textarea.props.value.startsWith("👍 APPROVED The owner approves"));
    cardControls(render).textarea.props.onChange({ target: { value: "👍 approved" } });
    assert.ok(cardControls(render).text.includes("Line 1: write the verdict after the reaction"));
    submit();
    assert.equal(storage.data.has(STORAGE_KEY), false);
    for (const bad of ["👍 OK\n👍🏽 NO", "👍 OK\u0007", "x".repeat(40) + " OK"]) {
      cardControls(render).textarea.props.onChange({ target: { value: bad } });
      submit();
      assert.equal(storage.data.has(STORAGE_KEY), false, bad);
    }
    cardControls(render).textarea.props.onChange({ target: { value: "✅ DONE Done, close it." } });
    isActive = false;
    submit();
    assert.equal(storage.data.has(STORAGE_KEY), false);
    isActive = true;
    submit();
    assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)), { version: 1, text: "✅ DONE Done, close it." });
    assert.ok(cardControls(render).text.includes("Saved."));
    const done = agentMessage(p);
    await play(p, [reaction(done, "✅"), reaction(agentMessage(p), "👍")]);
    assert.equal(p.posts.length, 1);
    expectReply(p, done, "DONE");
    cardControls(render).reset.props.onClick();
    assert.equal(storage.data.has(STORAGE_KEY), false);
    const approved = agentMessage(p);
    await play(p, [reaction(approved, "👍")]);
    expectReply(p, approved, "APPROVED");
  });
}

// The plugin needs no native access: a `host` block would let it run commands
// or reach the network, so adding one must be a deliberate, reviewed change.
function checkManifest(pluginPath) {
  const manifest = JSON.parse(readFileSync(join(dirname(resolve(pluginPath)), "manifest.json"), "utf8"));
  assert.match(manifest.id, MANIFEST_ID);
  assert.equal(manifest.apiVersion, API_VERSION);
  assert.ok(manifest.name?.trim(), "manifest name");
  const bytes = Buffer.byteLength(manifest.description ?? "");
  assert.ok(bytes >= 1 && bytes <= MAX_DESCRIPTION_BYTES, `description is ${bytes} bytes`);
  assert.equal(manifest.host, undefined, "the plugin must not request host access");
}

function parseArgs(argv) {
  const options = { plugin: DEFAULT_PLUGIN, defaultsOnly: false, transcript: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plugin" && argv[i + 1]) options.plugin = argv[++i];
    else if (argv[i] === "--defaults-only") options.defaultsOnly = true;
    else if (argv[i] === "--transcript") options.transcript = true;
    else throw new Error(`unknown argument: ${argv[i]} (see the usage at the top of this file)`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  checkManifest(options.plugin);
  const transcript = [];
  let failures = 0;
  // Each scenario gets a fresh plugin, host and storage, so none leaks into another.
  async function run(name, scenario, stored = {}, storageOptions = {}) {
    nextId = 0;
    const storage = createStorage(stored, storageOptions);
    const running = await startPlugin(options.plugin, storage);
    try {
      await scenario(running, storage);
      if (!options.transcript) console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
    transcript.push({ name, posts: running.posts, wakes: running.wakes });
  }
  const warn = console.warn;
  // The plugin warns on purpose in failure scenarios; keep the output readable.
  console.warn = () => {};
  try {
    await defaultDeliveryScenarios(run);
    await defaultSkipScenarios(run);
    if (!options.defaultsOnly) {
      await savedMapScenarios(run);
      await settingsCardScenarios(run);
    }
  } finally {
    console.warn = warn;
  }
  if (options.transcript) console.log(JSON.stringify(transcript, null, 2));
  if (failures > 0) {
    console.error(`dogfood: ${failures} scenario(s) failed in ${options.plugin}`);
    process.exit(1);
  }
  console.error(`dogfood: all scenarios passed in ${options.plugin}`);
}

await main();
