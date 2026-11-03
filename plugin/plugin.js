// Reaction verdicts: prebuilt Buzz plugin API v1 module.
// Purpose: let the owner answer an agent's message with one reaction.
// The owner's 👍, 👎, ❓, 💾 or 🔍 on a message by one of the owner's agents posts a
// reply as the owner that mentions the agent with the matching verdict. A real
// mention gives the usual "working" feedback that a plugin wake does not show.
// Works for every agent, present and future, with no per-agent setup and no
// Attention watch. It publishes only that one reply per verdict reaction.

// Cordis starts apply() only after these host services exist.
export const inject = ["react", "pages", "relay", "agents"];

// Reaction kind (NIP-25) and the message kinds Buzz lets people react to.
const REACTION_KIND = 7;
const REACTABLE_KINDS = new Set([9, 40002, 40008]);
// Emoji (after skin-tone and variation selectors are removed) and NIP-25 short forms.
// The verdict names are a contract with the rules of each agent: they must say how to act on one.
const APPROVED = "APPROVED";
const REJECTED = "REJECTED";
const CLARIFY = "CLARIFY";
const SAVE_LEARNINGS = "SAVE_LEARNINGS";
const VERIFY = "VERIFY";
const VERDICTS = new Map([
  ["👍", APPROVED],
  ["+", APPROVED],
  ["👎", REJECTED],
  ["-", REJECTED],
  ["❓", CLARIFY],
  ["❔", CLARIFY],
  ["💾", SAVE_LEARNINGS],
  ["🔍", VERIFY],
  ["🔎", VERIFY],
]);
// One plain sentence per verdict, so the agent knows what the owner wants.
const MEANINGS = new Map([
  [APPROVED, "The owner approves the request in that message."],
  [REJECTED, "The owner rejects the request in that message."],
  [CLARIFY, "The owner wants that message clarified: explain it again, simpler, with the missing context."],
  [SAVE_LEARNINGS, "The owner wants the learnings from this conversation saved to your memory."],
  [VERIFY, "The owner wants that message verified: check its claims again with evidence, then report the result."],
]);
// Skin-tone modifiers U+1F3FB..U+1F3FF and variation selector-16.
const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu;
const HEX64 = /^[0-9a-f]{64}$/;
// Relay can deliver one event more than once; remember this many handled ids.
const MAX_SEEN = 500;
// Rows kept for the activity page.
const MAX_LOG = 30;
// A target read that hangs must not hold work forever.
const READ_TIMEOUT_MS = 10_000;
const LOG_PREFIX = "[reaction-verdicts]";
// Marker of the fallback wake text; part of the agent rules contract like the verdict names.
const VERDICT_PREFIX = "OWNER VERDICT";

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const relay = ctx.relay;
  const agents = ctx.agents;

  // In-memory activity log for the page; the host has no plugin storage yet.
  let log = Object.freeze([]);
  const logListeners = new Set();
  function record(entry) {
    log = Object.freeze([{ at: Date.now(), ...entry }, ...log].slice(0, MAX_LOG));
    logListeners.forEach((listener) => listener());
  }

  const seen = new Set();
  function firstTime(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    // Set keeps insertion order, so the oldest id is dropped first.
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return true;
  }

  // Channel id from the reaction's h tag, target message id from its last e tag (NIP-25).
  function tagValue(event, name, last) {
    const values = event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
    return last ? values[values.length - 1] : values[0];
  }

  // Thread root for the wake: the message's root when it is a reply, else the message itself.
  function threadRootOf(message) {
    let root;
    let reply;
    for (const [name, value, , marker] of message.tags) {
      if (name !== "e" || !value || !HEX64.test(value)) continue;
      if (marker === "root") root = value;
      if (marker === "reply") reply = value;
    }
    return reply ? root ?? reply : message.id;
  }

  async function handle(snap, reaction, signal) {
    // Only the signed-in owner's own signed reactions count as verdicts.
    if (reaction.kind !== REACTION_KIND) return;
    // Each skip of a reaction is logged, so the owner can see why no agent woke.
    const skip = (reason) => record({ agent: "-", verdict: reaction.content, message: reaction.id, status: `skipped: ${reason}` });
    if (!snap.viewer || reaction.pubkey !== snap.viewer) return skip("not the owner's reaction");
    const verdict = VERDICTS.get(reaction.content.replace(EMOJI_MODIFIERS, "").trim());
    if (!verdict) return skip("not a verdict emoji");
    if (!firstTime(reaction.id)) return;
    // Mobile reactions carry only an e tag (no h), so the channel comes from the target below.
    const reactionChannel = tagValue(reaction, "h", false);
    const targetId = tagValue(reaction, "e", true);
    if (!targetId || !HEX64.test(targetId)) return skip("no target tag");

    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
    const events = await snap.session.read([{ ids: [targetId], limit: 1 }], {
      signal: AbortSignal.any([signal, timeout]),
    });
    const target = events.find((e) => e.id === targetId);
    if (!target || !REACTABLE_KINDS.has(target.kind)) return skip("target message not found");
    // The target's own signed h tag names the conversation; a reaction that names another one is refused.
    const channel = tagValue(target, "h", false);
    if (!channel) return skip("target has no channel");
    if (reactionChannel && reactionChannel !== channel) return skip("reaction and target channels differ");
    const agent = agents.find(target.pubkey);
    // Not an agent, or an agent of another owner: not ours to wake.
    if (!agent) return skip("target author is not an agent");
    if (agent.owner !== snap.viewer) return skip("agent has another owner");

    const channelInfo = snap.session.channels.get?.(channel);
    const solo = channelInfo?.channelType === "solo";
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
      record({ agent: agent.name, verdict, message: target.id, status: "sent as your message" });
      return;
    } catch (error) {
      // For example the agent left the channel, so a mention is refused. Fall back to a direct wake.
      console.warn(`${LOG_PREFIX} verdict message not sent`, { agent: agent.pubkey, reaction: reaction.id, error });
      record({ agent: agent.name, verdict, message: target.id, status: `message not sent: ${error?.message ?? error}` });
    }
    const text =
      `${VERDICT_PREFIX}: ${verdict}. ${MEANINGS.get(verdict)} The owner (${snap.viewer}) reacted ` +
      `"${reaction.content}" to your message ${target.id}. ` +
      `Reaction event ${reaction.id}; its signature and author were verified by the ` +
      `reaction-verdicts plugin. Message excerpt: ${JSON.stringify(target.content.slice(0, 200))}`;
    try {
      agents.wake(agent.key, { channel, ...(root ? { root } : {}), text });
      record({ agent: agent.name, verdict, message: target.id, status: "woken (fallback)" });
    } catch (error) {
      // Throws when this app does not run the agent, or its queue is full.
      console.warn(`${LOG_PREFIX} wake failed`, { agent: agent.pubkey, reaction: reaction.id, error });
      record({ agent: agent.name, verdict, message: target.id, status: `not woken: ${error?.message ?? error}` });
    }
  }

  // Follow the relay session: a reconnect replaces the session, so listen again on the new one.
  ctx.effect(() => {
    let current;
    let stopLive;
    let controller;
    function attach() {
      const snap = relay.snapshot();
      if (snap.status !== "ready" || snap.session === current) return;
      stopLive?.();
      controller?.abort();
      current = snap.session;
      record({ agent: "-", verdict: "-", message: "-", status: `listening (generation ${snap.generation})` });
      controller = new AbortController();
      const signal = controller.signal;
      // Live events only, never replays: an old reaction must not wake an agent again.
      stopLive = snap.session.subscribeLive((batch) => {
        if (batch.replay) return;
        for (const event of batch.events) {
          handle(snap, event, signal).catch((error) => {
            if (signal.aborted) return;
            console.warn(`${LOG_PREFIX} reaction not handled`, { reaction: event.id, error });
            record({ agent: "?", verdict: "?", message: event.id, status: `error: ${error?.message ?? error}` });
          });
        }
      });
    }
    attach();
    record({ agent: "-", verdict: "-", message: "-", status: `started; relay ${relay.snapshot().status}` });
    const stopRelay = relay.subscribe(attach);
    return () => {
      stopRelay();
      stopLive?.();
      controller?.abort();
    };
  });

  function ActivityPage() {
    const rows = React.useSyncExternalStore(
      (listener) => {
        logListeners.add(listener);
        return () => logListeners.delete(listener);
      },
      () => log,
    );
    return h(
      "section",
      { className: "ui-card", style: { padding: "var(--space-panel-inset)", overflow: "auto" } },
      h("h1", null, "Reaction verdicts"),
      h("p", null, "👍 = APPROVED, 👎 = REJECTED, ❓ = CLARIFY, 💾 = SAVE_LEARNINGS, 🔍 = VERIFY. Only your reactions on your agents' messages count. Log resets on restart."),
      rows.length === 0
        ? h("p", null, "No verdicts since start.")
        : h(
            "ul",
            null,
            rows.map((r, i) =>
              h("li", { key: `${r.at}-${i}` }, `${new Date(r.at).toLocaleTimeString()} · ${r.agent} · ${r.verdict} · ${r.message.slice(0, 8)} · ${r.status}`),
            ),
          ),
    );
  }

  // Debug log only, so it stays out of the sidebar; a plugin link still opens it when needed.
  ctx.pages.register({ id: "activity", title: "Reaction verdicts", primary: false, component: ActivityPage });
}
