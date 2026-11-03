// Reaction verdicts: prebuilt Buzz plugin API v1 module.
// Purpose: let the owner of agents answer an agent's message with one reaction.
// The owner's verdict reaction (by default 👍, 👎, ❓, 💾 or 🔍) on a message by one
// of the owner's agents posts a reply as the owner that mentions the agent with the
// matching verdict. A real mention gives the usual "working" feedback that a plugin
// wake does not show. Works for every agent, present and future, with no per-agent
// setup and no Attention watch. It publishes only that one reply per verdict reaction.
// The reaction -> verdict map is a user setting (Settings > Plugins), kept in the
// WebView's localStorage, because the host has no plugin storage API yet.

// Cordis starts apply() only after these host services exist. settingsCards is
// optional (see apply), so verdicts still work on a host without that service.
export const inject = ["react", "pages", "relay", "agents"];

const PLUGIN_ID = "sagmans.reaction-verdicts";
const LOG_PREFIX = "[reaction-verdicts]";
// Reaction kind (NIP-25) and the message kinds Buzz lets people react to.
const REACTION_KIND = 7;
const REACTABLE_KINDS = new Set([9, 40002, 40008]);
// Skin-tone modifiers U+1F3FB..U+1F3FF and variation selector-16: a 👍🏽 is still a 👍.
const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu;
const HEX64 = /^[0-9a-f]{64}$/;
// Relay can deliver one event more than once; remember this many handled ids.
const MAX_SEEN = 500;
// Rows kept for the activity page.
const MAX_LOG = 30;
// A target read that hangs must not hold work forever.
const READ_TIMEOUT_MS = 10_000;
// Characters of the judged message quoted in the fallback wake, enough to recognise it.
const EXCERPT_CHARS = 200;
// Event ids are shown shortened on the activity page.
const ID_PREVIEW_CHARS = 8;
// Marker of the fallback wake text. Like the verdict names, it is a contract with
// the agents' rules, which must say how to act on it.
const VERDICT_PREFIX = "OWNER VERDICT";
// Placeholder columns of a log row that has no agent, verdict or message.
const NONE = "-";
const UNKNOWN = "?";

// Settings. The key is namespaced by plugin id because every plugin shares one
// WebView localStorage; the version lets a later format migrate old values.
const STORAGE_KEY = `${PLUGIN_ID}.verdict-map.v1`;
const STORAGE_VERSION = 1;
const SETTINGS_CARD_ID = "verdicts";
const SETTINGS_TITLE = "Reaction verdicts";
// The host lists cards of this group under Settings > Plugins.
const SETTINGS_GROUP = "Plugins";
const SETTINGS_ROWS = 10;
// Input limits: a map is typed by hand, so these are generous but keep a hostile or
// corrupt stored value from growing the wake text or the UI without bound.
const MAX_SETTINGS_CHARS = 8_192;
const MAX_RULES = 32;
// UTF-16 units; a long zero-width-joiner emoji sequence fits, a sentence does not.
const MAX_REACTION_CHARS = 32;
const MAX_MEANING_CHARS = 280;
// Verdict names are posted after the mention; capitals, digits and _ only, so a
// verdict can never add another mention, a link or a second line.
const VERDICT_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;
// Control characters would break the one-line wake text and the settings rows.
// Tabs may separate the words of a rule, like spaces.
const CONTROL_CHARS = /(?!\t)\p{Cc}/u;
const COMMENT_PREFIX = "#";

// Default map, the plugin's original behavior: emoji and the NIP-25 short forms
// "+" and "-". The first line of a verdict that has text gives its meaning: one
// plain sentence, quoted in the fallback wake, so the agent knows what is wanted.
const DEFAULT_SETTINGS_TEXT = [
  "👍 APPROVED The owner approves the request in that message.",
  "+ APPROVED",
  "👎 REJECTED The owner rejects the request in that message.",
  "- REJECTED",
  "❓ CLARIFY The owner wants that message clarified: explain it again, simpler, with the missing context.",
  "❔ CLARIFY",
  "💾 SAVE_LEARNINGS The owner wants the learnings from this conversation saved to your memory.",
  "🔍 VERIFY The owner wants that message verified: check its claims again with evidence, then report the result.",
  "🔎 VERIFY",
].join("\n");

/** A verdict map that cannot be parsed or stored; `line` is 1-based when known. */
class VerdictSettingsError extends Error {
  constructor(message, { line, cause } = {}) {
    super(line ? `Line ${line}: ${message}` : message, cause ? { cause } : undefined);
    this.name = "VerdictSettingsError";
    this.line = line;
  }
}

/** The judged message could not be read from the relay in time. */
class TargetReadError extends Error {
  constructor(targetId, elapsedMs, cause) {
    super(`target ${targetId} not read after ${elapsedMs} ms (limit ${READ_TIMEOUT_MS} ms)`, { cause });
    this.name = "TargetReadError";
    this.targetId = targetId;
  }
}

// The same key normalisation runs on settings and on live reactions, so a rule
// typed with a skin tone still matches a plain reaction and the other way round.
function reactionKey(content) {
  return content.replace(EMOJI_MODIFIERS, "").trim();
}

function fallbackMeaning(verdict) {
  return `The owner gave the verdict ${verdict} on that message.`;
}

// One rule per line: `<reaction> <VERDICT> [meaning]`. Blank lines and lines that
// start with # are skipped, so users can keep notes in the map.
function parseRule(raw, line) {
  const [reactionText, verdict = "", ...words] = raw.trim().split(/\s+/u);
  const reaction = reactionKey(reactionText);
  const meaning = words.join(" ");
  if (!reaction || reaction.length > MAX_REACTION_CHARS)
    throw new VerdictSettingsError(`a reaction is 1 to ${MAX_REACTION_CHARS} characters`, { line });
  if (!VERDICT_NAME.test(verdict))
    throw new VerdictSettingsError("write the verdict after the reaction, in capitals (A-Z, 0-9, _)", { line });
  if (meaning.length > MAX_MEANING_CHARS)
    throw new VerdictSettingsError(`a meaning is at most ${MAX_MEANING_CHARS} characters`, { line });
  return { reaction, verdict, meaning };
}

/**
 * Parse settings text into a frozen map. Returns `{ error }` instead of throwing,
 * so the settings card can show the problem while the user types.
 */
function parseVerdictMap(text) {
  try {
    if (typeof text !== "string") throw new VerdictSettingsError("the saved map is not text");
    if (text.length > MAX_SETTINGS_CHARS)
      throw new VerdictSettingsError(`the map is longer than ${MAX_SETTINGS_CHARS} characters`);
    const verdicts = new Map();
    const meanings = new Map();
    text.split("\n").forEach((raw, index) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith(COMMENT_PREFIX)) return;
      const line = index + 1;
      if (CONTROL_CHARS.test(trimmed)) throw new VerdictSettingsError("remove control characters", { line });
      const rule = parseRule(trimmed, line);
      if (verdicts.has(rule.reaction))
        throw new VerdictSettingsError(`${rule.reaction} already has a verdict`, { line });
      if (verdicts.size >= MAX_RULES) throw new VerdictSettingsError(`use at most ${MAX_RULES} rules`, { line });
      verdicts.set(rule.reaction, rule.verdict);
      if (rule.meaning && !meanings.has(rule.verdict)) meanings.set(rule.verdict, rule.meaning);
    });
    if (verdicts.size === 0) throw new VerdictSettingsError("add at least one rule, or reset to the defaults");
    return Object.freeze({ text, verdicts, meanings });
  } catch (error) {
    if (error instanceof VerdictSettingsError) return Object.freeze({ text, error: error.message });
    throw error;
  }
}

const DEFAULT_MAP = parseVerdictMap(DEFAULT_SETTINGS_TEXT);

// localStorage can be missing or throw (for example a SecurityError); without it
// the defaults apply and saving reports the problem.
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// A stored value that fails validation is not replaced by the defaults: the user
// chose to change the map, so no reaction counts until the map is fixed (fail closed).
function loadVerdictMap(storage) {
  let raw;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch (error) {
    console.warn(`${LOG_PREFIX} verdict map not read; defaults in use`, { key: STORAGE_KEY, error });
    return { ...DEFAULT_MAP, source: "default" };
  }
  if (raw === null) return { ...DEFAULT_MAP, source: "default" };
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return { text: "", error: "the saved map is not valid JSON", source: "saved" };
  }
  if (saved?.version !== STORAGE_VERSION)
    return { text: "", error: `the saved map has an unknown format (${String(saved?.version)})`, source: "saved" };
  return { ...parseVerdictMap(saved.text), source: "saved" };
}

/** Shared verdict map: the reaction handler reads it, the settings card writes it. */
function createVerdictStore(storage) {
  let state = Object.freeze(loadVerdictMap(storage));
  const listeners = new Set();
  function publish(next) {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save(text) {
      const parsed = parseVerdictMap(text);
      if (parsed.error) throw new VerdictSettingsError(parsed.error);
      if (!storage) throw new VerdictSettingsError("this app has no local storage, so the map cannot be saved");
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, text }));
      } catch (cause) {
        throw new VerdictSettingsError("the map could not be saved to local storage", { cause });
      }
      publish({ ...parsed, source: "saved" });
    },
    reset() {
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch (cause) {
        throw new VerdictSettingsError("the saved map could not be removed from local storage", { cause });
      }
      publish({ ...DEFAULT_MAP, source: "default" });
    },
  };
}

/** In-memory activity log for the debug page; it resets when the plugin restarts. */
function createActivityLog() {
  let rows = Object.freeze([]);
  const listeners = new Set();
  return {
    snapshot: () => rows,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(entry) {
      rows = Object.freeze([{ at: Date.now(), ...entry }, ...rows].slice(0, MAX_LOG));
      listeners.forEach((listener) => listener());
    },
  };
}

// Relay can redeliver an event; Set keeps insertion order, so the oldest id goes first.
function createSeenSet() {
  const seen = new Set();
  return function firstTime(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return true;
  };
}

// Channel id from the h tag; target message id from the last e tag (NIP-25).
function tagValue(event, name, last) {
  const values = event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
  return last ? values[values.length - 1] : values[0];
}

// Thread root for the reply: the message's root when it is a reply, else the message itself.
function threadRootOf(message) {
  let root;
  let reply;
  for (const [name, value, , marker] of message.tags) {
    if (name !== "e" || !value || !HEX64.test(value)) continue;
    if (marker === "root") root = value;
    if (marker === "reply") reply = value;
  }
  return reply ? (root ?? reply) : message.id;
}

function errorText(error) {
  return error?.message ?? String(error);
}

async function readTarget(session, targetId, signal) {
  const started = Date.now();
  try {
    const events = await session.read([{ ids: [targetId], limit: 1 }], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
    });
    return events.find((e) => e.id === targetId);
  } catch (cause) {
    // A disabled plugin or a new relay session aborts on purpose; keep that error as is.
    if (signal.aborted) throw cause;
    throw new TargetReadError(targetId, Date.now() - started, cause);
  }
}

/**
 * Check the reaction itself. Returns null for events that are not reactions or
 * were handled already, `{ skip }` with a reason the activity page shows, or the
 * verdict and the ids it points at.
 */
function checkReaction({ snap, reaction, map, firstTime }) {
  // Only the signed-in owner's own signed reactions count as verdicts.
  if (reaction.kind !== REACTION_KIND) return null;
  if (!snap.viewer || reaction.pubkey !== snap.viewer) return { skip: "not the owner's reaction" };
  if (map.error) return { skip: "the verdict map in Settings is invalid" };
  const verdict = map.verdicts.get(reactionKey(reaction.content));
  if (!verdict) return { skip: "not a verdict emoji" };
  if (!firstTime(reaction.id)) return null;
  const targetId = tagValue(reaction, "e", true);
  if (!targetId || !HEX64.test(targetId)) return { skip: "no target tag" };
  // Mobile reactions carry only an e tag (no h), so the channel comes from the target later.
  return { verdict, targetId, reactionChannel: tagValue(reaction, "h", false) };
}

/** Check the judged message and its author. Returns `{ skip }` or where to deliver. */
async function checkTarget({ snap, agents, signal }, { targetId, reactionChannel }) {
  const target = await readTarget(snap.session, targetId, signal);
  if (!target || !REACTABLE_KINDS.has(target.kind)) return { skip: "target message not found" };
  // The target's own signed h tag names the conversation; a reaction that names another one is refused.
  const channel = tagValue(target, "h", false);
  if (!channel) return { skip: "target has no channel" };
  if (reactionChannel && reactionChannel !== channel) return { skip: "reaction and target channels differ" };
  const agent = agents.find(target.pubkey);
  // Not an agent, or an agent of another owner: not ours to wake.
  if (!agent) return { skip: "target author is not an agent" };
  if (agent.owner !== snap.viewer) return { skip: "agent has another owner" };
  return { target, channel, agent };
}

/** Post the verdict as the owner, or wake the agent directly when that fails. */
function deliver({ snap, reaction, agents, record }, { verdict, meaning, target, channel, agent }) {
  const row = { agent: agent.name, verdict, message: target.id };
  const solo = snap.session.channels.get?.(channel)?.channelType === "solo";
  const root = solo ? undefined : threadRootOf(target);
  // Primary path: a signed message from the owner that mentions the agent. It wakes the
  // agent through the normal mention path, so Buzz shows its usual "working" feedback.
  // In a thread the reply's NIP-10 "reply" tag names the judged message, so the text
  // stays one word. A solo chat has no threads, so there the text names the message.
  try {
    if (root) {
      snap.session.messages.reply(channel, root, `@${agent.name} ${verdict}`, [agent.pubkey], [], target.id);
    } else {
      snap.session.messages.send(channel, `@${agent.name} ${verdict} for your message ${target.id}`, [agent.pubkey]);
    }
    record({ ...row, status: "sent as your message" });
    return;
  } catch (error) {
    // For example the agent left the channel, so a mention is refused. Fall back to a direct wake.
    console.warn(`${LOG_PREFIX} verdict message not sent`, { agent: agent.pubkey, reaction: reaction.id, channel, error });
    record({ ...row, status: `message not sent: ${errorText(error)}` });
  }
  const text =
    `${VERDICT_PREFIX}: ${verdict}. ${meaning} The owner (${snap.viewer}) reacted ` +
    `"${reaction.content}" to your message ${target.id}. ` +
    `Reaction event ${reaction.id}; its signature and author were verified by the ` +
    `reaction-verdicts plugin. Message excerpt: ${JSON.stringify(target.content.slice(0, EXCERPT_CHARS))}`;
  try {
    agents.wake(agent.key, { channel, ...(root ? { root } : {}), text });
    record({ ...row, status: "woken (fallback)" });
  } catch (error) {
    // Throws when this app does not run the agent, or its queue is full.
    console.warn(`${LOG_PREFIX} wake failed`, { agent: agent.pubkey, reaction: reaction.id, channel, error });
    record({ ...row, status: `not woken: ${errorText(error)}` });
  }
}

async function handleReaction(deps, snap, reaction, signal) {
  const map = deps.store.snapshot();
  const context = { ...deps, snap, reaction, signal, map };
  const checked = checkReaction(context);
  if (!checked) return;
  const located = checked.skip ? checked : await checkTarget(context, checked);
  // Each skip of a reaction is logged, so the owner can see why no agent woke.
  if (located.skip) {
    deps.record({ agent: NONE, verdict: reaction.content, message: reaction.id, status: `skipped: ${located.skip}` });
    return;
  }
  const meaning = map.meanings.get(checked.verdict) ?? fallbackMeaning(checked.verdict);
  deliver(context, { ...located, verdict: checked.verdict, meaning });
}

// Follow the relay session: a reconnect replaces the session, so listen again on the new one.
function followRelay(relay, deps) {
  let current;
  let stopLive;
  let controller;
  function attach() {
    const snap = relay.snapshot();
    if (snap.status !== "ready" || snap.session === current) return;
    stopLive?.();
    controller?.abort();
    current = snap.session;
    deps.record({ agent: NONE, verdict: NONE, message: NONE, status: `listening (generation ${snap.generation})` });
    controller = new AbortController();
    const signal = controller.signal;
    // Live events only, never replays: an old reaction must not wake an agent again.
    stopLive = snap.session.subscribeLive((batch) => {
      if (batch.replay) return;
      for (const event of batch.events) {
        handleReaction(deps, snap, event, signal).catch((error) => {
          if (signal.aborted) return;
          console.warn(`${LOG_PREFIX} reaction not handled`, { reaction: event.id, error, cause: error?.cause });
          deps.record({ agent: UNKNOWN, verdict: UNKNOWN, message: event.id, status: `error: ${errorText(error)}` });
        });
      }
    });
  }
  attach();
  deps.record({ agent: NONE, verdict: NONE, message: NONE, status: `started; relay ${relay.snapshot().status}` });
  const stopRelay = relay.subscribe(attach);
  return () => {
    stopRelay();
    stopLive?.();
    controller?.abort();
  };
}

function mapSummary(map) {
  if (map.error) return `The verdict map is invalid, so no reaction counts: ${map.error}`;
  return [...map.verdicts].map(([reaction, verdict]) => `${reaction} = ${verdict}`).join(", ");
}

function createActivityPage(React, log, store) {
  const h = React.createElement;
  return function ActivityPage() {
    const rows = React.useSyncExternalStore(log.subscribe, log.snapshot);
    const map = React.useSyncExternalStore(store.subscribe, store.snapshot);
    return h(
      "section",
      { className: "ui-card", style: { padding: "var(--space-panel-inset)", overflow: "auto" } },
      h("h1", null, "Reaction verdicts"),
      h("p", null, `${mapSummary(map)}. Only your reactions on your agents' messages count. Log resets on restart.`),
      rows.length === 0
        ? h("p", null, "No verdicts since start.")
        : h(
            "ul",
            null,
            rows.map((r, i) =>
              h(
                "li",
                { key: `${r.at}-${i}` },
                `${new Date(r.at).toLocaleTimeString()} · ${r.agent} · ${r.verdict} · ${r.message.slice(0, ID_PREVIEW_CHARS)} · ${r.status}`,
              ),
            ),
          ),
    );
  };
}

const SETTINGS_HELP =
  "One rule per line: a reaction, a space, the verdict name in capitals, then an optional " +
  "sentence that tells the agent what the verdict means. The first sentence given for a " +
  "verdict is used. Lines that start with # are notes. Skin tones do not matter. " +
  "Your agents' rules must say how to act on each verdict name.";

function createSettingsCard(React, store) {
  const h = React.createElement;
  return function VerdictSettings({ active }) {
    const saved = React.useSyncExternalStore(store.subscribe, store.snapshot);
    const [draft, setDraft] = React.useState(saved.text);
    const [status, setStatus] = React.useState("");
    const parsed = parseVerdictMap(draft);
    function run(action, done) {
      if (!active()) return;
      try {
        action();
        setStatus(done);
      } catch (error) {
        console.warn(`${LOG_PREFIX} verdict map not changed`, { key: STORAGE_KEY, error, cause: error?.cause });
        setStatus(errorText(error));
      }
    }
    return h(
      "section",
      { "aria-label": `${SETTINGS_TITLE} settings`, style: { display: "grid", gap: "var(--space-3)" } },
      h("h2", null, SETTINGS_TITLE),
      h("p", null, SETTINGS_HELP),
      saved.error ? h("p", { role: "alert" }, `Saved map is invalid, so no reaction counts: ${saved.error}`) : null,
      h(
        "form",
        {
          "aria-label": "Verdict map",
          style: { display: "grid", gap: "var(--space-2)" },
          onSubmit(event) {
            event.preventDefault();
            run(() => store.save(draft), "Saved. New reactions use this map.");
          },
        },
        h("textarea", {
          "aria-label": "Reaction to verdict rules",
          rows: SETTINGS_ROWS,
          value: draft,
          spellCheck: false,
          autoCapitalize: "none",
          autoCorrect: "off",
          maxLength: MAX_SETTINGS_CHARS,
          onChange: (event) => {
            setDraft(event.target.value);
            setStatus("");
          },
        }),
        parsed.error ? h("p", { role: "alert" }, parsed.error) : null,
        h(
          "div",
          { style: { display: "flex", gap: "var(--space-2)" } },
          h("button", { type: "submit", disabled: Boolean(parsed.error) }, "Save"),
          h(
            "button",
            {
              type: "button",
              onClick: () =>
                run(() => {
                  store.reset();
                  setDraft(DEFAULT_SETTINGS_TEXT);
                }, "Defaults restored."),
            },
            "Reset to defaults",
          ),
        ),
        status ? h("p", { role: "status" }, status) : null,
      ),
    );
  };
}

export function apply(ctx) {
  const React = ctx.react;
  const log = createActivityLog();
  const store = createVerdictStore(browserStorage());
  const deps = { agents: ctx.agents, store, record: log.record, firstTime: createSeenSet() };

  ctx.effect(() => followRelay(ctx.relay, deps));

  // Debug log only, so it stays out of the sidebar; a plugin link still opens it when needed.
  ctx.pages.register({
    id: "activity",
    title: "Reaction verdicts",
    primary: false,
    component: createActivityPage(React, log, store),
  });

  // Optional: without a settings service the default or saved map still applies.
  ctx.inject(["settingsCards"], (scope) => {
    scope.settingsCards.register({
      id: SETTINGS_CARD_ID,
      title: SETTINGS_TITLE,
      group: SETTINGS_GROUP,
      component: createSettingsCard(React, store),
    });
  });
}
