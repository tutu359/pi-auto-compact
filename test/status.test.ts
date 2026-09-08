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
): {
	ctx: ExtensionContext;
	statuses: Map<string, string>;
} {
	const statuses = new Map<string, string>();
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		getContextUsage: () => ({
			tokens: percent == null ? null : 4200,
			contextWindow: 10000,
			percent,
		}),
		compact() {},
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
	return { ctx, statuses };
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

test("turn_start shows current usage vs threshold when Pi stats are available", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	const { ctx, statuses } = makeCtx(42);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "ac: 42%/70%");
});

test("falls back to self-estimated usage when Pi stats are null", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// ~4200 chars/4 = 1050 tokens = 10.5% of 10k window.
	const branch = [
		{
			id: "m1",
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "x".repeat(4200) }],
				timestamp: 1,
			},
		},
	];
	const { ctx, statuses } = makeCtx(null, branch);
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "ac: 11%/70%");
});

test("shows 压缩中… while pending, then starred estimate after onError", async () => {
	await withTempAgentDir();
	const handlers = loadExtension();
	// ~29200 chars/4 = 7300 tokens = 73% of 10k window, above the 70% threshold.
	const branch = [
		{
			id: "m1",
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "x".repeat(29200) }],
				timestamp: 1,
			},
		},
	];
	const { ctx, statuses } = makeCtx(null, branch);
	let failCompaction: (() => void) | undefined;
	(ctx as { compact: unknown }).compact = (
		options: { onError?: () => void },
	) => {
		failCompaction = options.onError;
	};
	startSession(handlers, ctx);
	handlers.get("turn_start")?.({} as never, ctx);
	assert.equal(statuses.get(STATUS_KEY), "ac: 压缩中…");
	failCompaction?.();
	assert.equal(statuses.get(STATUS_KEY), "ac: 73%/70% *");
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
