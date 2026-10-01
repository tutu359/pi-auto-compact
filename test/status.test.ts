import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
): {
	ctx: ExtensionContext;
	statuses: Map<string, string>;
	compactions: Array<{ onComplete?: () => void; onError?: () => void }>;
} {
	const statuses = new Map<string, string>();
	const compactions: Array<{
		onComplete?: () => void;
		onError?: () => void;
	}> = [];
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
		ui: {
			notify() {},
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
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
	} as unknown as ExtensionContext;
	return { ctx, statuses, compactions };
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
