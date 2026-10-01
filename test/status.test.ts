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
		sessionManager: { getBranch: () => branch },
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
	const { ctx, statuses } = makeCtx(42);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "ac: 42%/70%");
});

test("shows ? instead of self-estimating when Pi reports unknown usage", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// Pi returns null right after compaction, before the next LLM response.
	const { ctx, statuses, compactions } = makeCtx(null);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	// Mirrors the footer's "?" — no self-computed estimate, and no compaction
	// decision without a real number.
	assert.equal(statuses.get(STATUS_KEY), "ac: ?/70%");
	assert.equal(compactions.length, 0);
});

test("shows compacting… while pending, real usage after onError", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	const { ctx, statuses, compactions } = makeCtx(80);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "ac: compacting…");
	compactions[0]?.onError?.();
	// Compaction failed, context unchanged: Pi still reports 80%.
	assert.equal(statuses.get(STATUS_KEY), "ac: 80%/70% *");
});

test("context event guards request size with Pi's usage, not a self-estimate", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	const { ctx, statuses, compactions } = makeCtx(80, [], 8000);
	startSession(handlers, ctx);
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
	assert.equal(statuses.get(STATUS_KEY), "ac: compacting…");
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
