import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoCompact from "../extensions/auto-compact.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

const STATUS_KEY = "ac";

async function withTempAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-ac-status-"));
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ compaction: { enabled: false } }),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

/** Temp agent dir carrying a pi-auto-compact plugin config. */
async function withPluginConfig(config: unknown): Promise<string> {
	const dir = await withTempAgentDir();
	await mkdir(join(dir, "config", "pi-auto-compact"), { recursive: true });
	await writeFile(
		join(dir, "config", "pi-auto-compact", "config.json"),
		JSON.stringify(config),
	);
	return dir;
}

function loadExtension(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	autoCompact({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		sendMessage() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return handlers;
}

function makeCtx(
	percent: number | null,
	branch: unknown[] = [],
	tokens = percent == null ? null : 4200,
	projectionMessages: unknown[] = [],
	modelRegistry?: unknown,
): {
	ctx: ExtensionContext;
	statuses: Map<string, string>;
	compactions: Array<{ onComplete?: () => void; onError?: () => void }>;
	notifies: Array<{ text: string; level: string }>;
	signal: { aborted: boolean };
} {
	const statuses = new Map<string, string>();
	const compactions: Array<{
		onComplete?: () => void;
		onError?: () => void;
	}> = [];
	const notifies: Array<{ text: string; level: string }> = [];
	const signal = { aborted: false };
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		getContextUsage: () => ({
			tokens,
			contextWindow: 10000,
			percent,
		}),
		compact(options: { onComplete?: () => void; onError?: () => void }) {
			compactions.push(options);
		},
		isIdle: () => false,
		signal,
		ui: {
			notify(text: string, level: string) {
				notifies.push({ text, level });
			},
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
		model: { contextWindow: 10000 },
		sessionManager: {
			getBranch: () => branch,
			// Matches pi's runtime ReadonlySessionManager (v0.99.x), which
			// exposes the projection used by its own estimator. Entries mirror
			// the messages one-to-one so usage-entry lookups resolve.
			buildSessionProjection: () => ({
				messages: projectionMessages,
				entries: projectionMessages.map((m, i) => ({
					messages: [m],
					sourceEntry: { id: `entry-${i}` },
				})),
			}),
		},
		modelRegistry: modelRegistry ?? { find: () => undefined, getAvailable: () => [] },
	} as unknown as ExtensionContext;
	return { ctx, statuses, compactions, notifies, signal };
}

function startSession(handlers: Map<string, Handler>, ctx: ExtensionContext) {
	handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" } as never,
		ctx,
	);
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

test.afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

test("turn_start shows current usage vs threshold", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Real usage-backed projection: pi's 42% is trusted verbatim.
	const projectionMessages = [
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 4200, input: 0, output: 0, cacheRead: 4200, cacheWrite: 0 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, statuses } = makeCtx(42, branch, 4200, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), " ac: 42%/70%");
});

test("falls back to the ported Pi estimator when Pi reports unknown usage", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Pi returns null right after compaction when no post-compaction usage
	// exists (e.g. providers that never report usage). The plugin then mirrors
	// Pi's pre-compaction estimator instead of going blind.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(4000), timestamp: 1 },
	];
	const { ctx, statuses, compactions } = makeCtx(null, [], null, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	// 4000 chars / 4 = 1000 tokens = 10% of the 10k window: below threshold.
	// No real usage backs the number, so the value is marked with `~`.
	assert.equal(statuses.get(STATUS_KEY), " ac: ~10%/70%");
	assert.equal(compactions.length, 0);
});

test("marks pi's own pre-compaction estimate with ~ when no usage backs it", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// New session, no compaction: pi still returns a number (its own internal
	// estimate) because zero usage is not "unknown" to it. The plugin detects
	// that no real usage backs the value and marks it with `~`.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(4000), timestamp: 1 },
	];
	const { ctx, statuses } = makeCtx(10, [], 1000, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), " ac: ~10%/70%");
});

test("shows a plain value when real usage backs the number", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Projection carries a valid assistant usage newer than any compaction:
	// pi's number is real, no `~` marker.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(4000), timestamp: 1 },
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 4200, input: 0, output: 0, cacheRead: 4200, cacheWrite: 0 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, statuses } = makeCtx(42, branch, 4200, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), " ac: 42%/70%");
});

test("shows compacting… while pending, real usage after onError", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	const { ctx, statuses, compactions } = makeCtx(80);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), " ac: compacting…");
	compactions[0]?.onError?.();
	// Compaction failed, context unchanged: Pi still reports 80%.
	assert.equal(statuses.get(STATUS_KEY), " ac: 80%/70% *");
});

test("context event guards request size with Pi's usage, not a self-estimate", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Session starts below threshold; the request crosses it (8000 > 70% of 10k).
	const projectionMessages = [
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 1000, input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, statuses, compactions } = makeCtx(10, branch, 1000, projectionMessages);
	const mutable = ctx as unknown as {
		getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null };
	};
	startSession(handlers, ctx);
	mutable.getContextUsage = () => ({ tokens: 8000, contextWindow: 10000, percent: 80 });
	const messages = [
		{
			role: "user",
			content: [{ type: "text", text: "x".repeat(6000) }],
			timestamp: 1,
		},
		{ role: "user", content: "latest", timestamp: 2 },
	];
	const returned = (handlers.get("context")?.({ messages } as never, ctx) ??
		{}) as { messages?: unknown[] };
	assert.equal(Array.isArray(returned.messages), true);
	// 8000 tokens > 70% of the 10k window: keepRecent keeps the notice plus
	// the newest user message only.
	assert.equal((returned.messages as unknown[]).length, 2);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(compactions.length, 1);
	assert.equal(statuses.get(STATUS_KEY), " ac: compacting…");
});

test("hides status when plugin is inactive (owner is built-in or off)", async () => {
	// settings.json enables built-in compaction -> plugin stays inactive.
	const dir = await mkdtemp(join(tmpdir(), "pi-ac-status-"));
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ compaction: { enabled: true } }),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers = loadExtension();
	const { ctx, statuses } = makeCtx(80);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), undefined);
});

// ==========================================================================
// keepRecent: long tool turns must not collapse the request to a bare
// notice (forward user-boundary scan used to run off the end).
// ==========================================================================

test("context guard keeps the whole current turn when the window lands mid-turn", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Usage-backed projection so the status marker resolves cleanly.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(400), timestamp: 1 },
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 1000, input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, compactions } = makeCtx(10, branch, 1000, projectionMessages);
	const mutable = ctx as unknown as {
		getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null };
	};
	startSession(handlers, ctx);
	mutable.getContextUsage = () => ({ tokens: 8000, contextWindow: 10000, percent: 80 });
	// Turn structure: an earlier turn, then a current turn far larger than the
	// 15% keep window (1500 tokens of a 10k window).
	const text = (n: number) => [{ type: "text", text: "x".repeat(n) }];
	const messages = [
		{ role: "user", content: text(2000), timestamp: 1 }, // earlier turn
		{ role: "assistant", content: text(40), timestamp: 2 },
		{ role: "user", content: text(40), timestamp: 3 }, // current turn start
		{ role: "assistant", content: text(40), timestamp: 4 },
		{ role: "assistant", content: text(8000), timestamp: 5 }, // oversized turn body
		{ role: "assistant", content: text(40), timestamp: 6 },
		{ role: "assistant", content: text(40), timestamp: 7 },
	];
	const returned = (handlers.get("context")?.({ messages } as never, ctx) ??
		{}) as { messages?: Array<{ role: string }> };
	assert.equal(Array.isArray(returned.messages), true);
	// Notice + the current turn from its user message — not a bare notice.
	assert.equal(returned.messages?.length, 6);
	assert.equal(returned.messages?.[1]?.role, "user");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(compactions.length, 1);
});

test("context guard leaves a single oversized turn untruncated but still compacts", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	const projectionMessages = [
		{ role: "user", content: "h".repeat(400), timestamp: 1 },
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 1000, input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, compactions } = makeCtx(10, branch, 1000, projectionMessages);
	const mutable = ctx as unknown as {
		getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null };
	};
	startSession(handlers, ctx);
	mutable.getContextUsage = () => ({ tokens: 8000, contextWindow: 10000, percent: 80 });
	// One giant turn is the whole session: no safe cut exists.
	const messages = [
		{ role: "user", content: [{ type: "text", text: "x".repeat(32000) }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "x".repeat(40) }], timestamp: 2 },
	];
	const returned = (handlers.get("context")?.({ messages } as never, ctx) ??
		{}) as { messages?: unknown };
	assert.equal(returned.messages, undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(compactions.length, 1);
});

// ==========================================================================
// message_end: aborted assistant messages are rewritten into a quiet stop.
// ==========================================================================

function abortedMessage(content: unknown[], errorMessage: string) {
	return { role: "assistant", content, stopReason: "error", errorMessage };
}

async function primeCompactionAbort() {
	await withTempAgentDir();
	const handlers = loadExtension();
	const made = makeCtx(80);
	startSession(handlers, made.ctx);
	assert.equal(made.compactions.length, 1);
	return { handlers, ...made };
}

test("message_end rewrites thinking-only aborts carrying pi's abort text", async () => {
	const { handlers, ctx, signal } = await primeCompactionAbort();
	signal.aborted = true;
	const result = handlers.get("message_end")?.(
		{ message: abortedMessage([{ type: "thinking", thinking: "partial" }], "The operation was aborted") } as never,
		ctx,
	) as { message?: { stopReason?: string; errorMessage?: string } } | undefined;
	assert.equal(result?.message?.stopReason, "stop");
	assert.equal(result?.message?.errorMessage, undefined);
});

test("message_end rewrites empty-text aborts carrying undici's abort text", async () => {
	const { handlers, ctx, signal } = await primeCompactionAbort();
	signal.aborted = true;
	const result = handlers.get("message_end")?.(
		{ message: abortedMessage([{ type: "text", text: "" }], "This operation was aborted") } as never,
		ctx,
	) as { message?: { stopReason?: string; errorMessage?: string } } | undefined;
	assert.equal(result?.message?.stopReason, "stop");
});

test("message_end leaves aborted messages with real content alone", async () => {
	const { handlers, ctx, signal } = await primeCompactionAbort();
	signal.aborted = true;
	const result = handlers.get("message_end")?.(
		{ message: abortedMessage([{ type: "text", text: "partial real output" }], "This operation was aborted") } as never,
		ctx,
	) as { message?: unknown } | undefined;
	assert.equal(result, undefined);
});

// ==========================================================================
// session_before_compact: manual /compact also uses the configured model.
// ==========================================================================

function manualCompactEvent() {
	return {
		preparation: { fileOps: { read: new Set<string>(), edited: new Set<string>() } },
		branchEntries: [],
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: { aborted: false },
	};
}

test("manual /compact runs the configured compaction model override", async () => {
	await withPluginConfig({
		enabled: true,
		autoCompactThreshold: 70,
		compactionModel: { provider: "testprov", model: "testmodel" },
	});
	const handlers = loadExtension();
	const findCalls: Array<[string, string]> = [];
	const authCalls: Array<[string, string]> = [];
	const registry = {
		find(provider: string, model: string) {
			findCalls.push([provider, model]);
			return { provider, id: model, contextWindow: 10000 };
		},
		getAvailable: () => [],
		async getApiKeyAndHeaders(model: { provider: string; id: string }) {
			authCalls.push([model.provider, model.id]);
			return { ok: false, error: "no auth" };
		},
	};
	const projectionMessages = [
		{ role: "user", content: "h".repeat(400), timestamp: 1 },
	];
	const { ctx, notifies } = makeCtx(10, [], 100, projectionMessages, registry);
	startSession(handlers, ctx);
	const findsAfterStart = findCalls.length;
	const authsAfterStart = authCalls.length;
	await handlers.get("session_before_compact")?.(manualCompactEvent() as never, ctx);
	// The old guard returned before any model work for manual compactions.
	assert.equal(findCalls.length, findsAfterStart + 1);
	assert.equal(authCalls.length, authsAfterStart + 1);
	assert.ok(
		notifies.some((n) => n.text.includes("has no usable auth")),
		`expected auth-failure notify, got: ${JSON.stringify(notifies)}`,
	);
});

test("manual /compact without a configured model announces the session model", async () => {
	await withPluginConfig({ enabled: true, autoCompactThreshold: 70 });
	const handlers = loadExtension();
	const { ctx, notifies } = makeCtx(10);
	startSession(handlers, ctx);
	await handlers.get("session_before_compact")?.(manualCompactEvent() as never, ctx);
	assert.ok(notifies.some((n) => n.text.includes("Compacting with session model")));
});

// ==========================================================================
// Estimator robustness and post-compaction hold-off.
// ==========================================================================

test("partial usage without input fields no longer yields NaN", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// cacheRead-only usage (no input/output/totalTokens) used to produce NaN,
	// a "NaN%" status, and a spurious compaction (NaN <= threshold is false).
	const projectionMessages = [
		{ role: "user", content: "h".repeat(400), timestamp: 1 },
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { cacheRead: 4200 },
			timestamp: 2,
		},
	];
	const branch = projectionMessages.map((_, i) => ({ id: `entry-${i}`, type: "message" }));
	const { ctx, statuses, compactions } = makeCtx(null, branch, null, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "\uf1b8 ac: 42%/70%");
	assert.equal(compactions.length, 0);
});

test("stale pre-compaction usage holds off instead of retriggering", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Usage exists but a compaction entry is newer: the estimate (chars/4)
	// sits above threshold, yet the plugin must wait for the next response.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(16000), timestamp: 1 },
		{
			role: "assistant",
			content: [],
			stopReason: "stop",
			usage: { totalTokens: 8000, input: 8000, output: 0, cacheRead: 0, cacheWrite: 0 },
			timestamp: 2,
		},
		{ role: "user", content: "h".repeat(16000), timestamp: 3 },
	];
	const branch = [
		{ id: "entry-0", type: "message" },
		{ id: "entry-1", type: "message" },
		{ id: "entry-2", type: "compaction" },
	];
	const { ctx, statuses, compactions } = makeCtx(null, branch, null, projectionMessages);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(compactions.length, 0);
	assert.equal(statuses.get(STATUS_KEY), "\uf1b8 ac: ~80%/70% *");
});

test("providers that never report usage still compact on the estimate", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// No usage at all: the hold-off must not block — chars/4 is the only signal.
	const projectionMessages = [
		{ role: "user", content: "h".repeat(12000), timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "y".repeat(12000) }], timestamp: 2 },
		{ role: "user", content: "h".repeat(12000), timestamp: 3 },
	];
	const { ctx, compactions } = makeCtx(null, [], null, projectionMessages);
	startSession(handlers, ctx);
	assert.equal(compactions.length, 1);
});
