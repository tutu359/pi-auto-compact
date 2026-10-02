import {
	compact,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type AgentMessage = Parameters<typeof estimateTokens>[0];

/**
 * Proactive compaction runs at four points:
 * - turn_start: catch sessions already over threshold before next request.
 * - turn_end: catch growth caused by tool results before next LLM turn.
 * - agent_end: catch growth from the final provider turn.
 * - context: last-resort guard with a temporary keep-recent context.
 *
 * Pi's ctx.compact() aborts active low-level run internally. Mid-task
 * compaction sends a custom continuation message after summary.
 */
const DEFAULT_COMPACT_THRESHOLD_PERCENT = 70;
const MIN_COMPACT_THRESHOLD_PERCENT = 25;
const KEEP_RECENT_PERCENT = 15;
const COMPACTION_INSTRUCTIONS =
	"Preserve current task to be resumed after compaction.";
const RESUME_MESSAGE_TYPE = "pi-auto-compact/resume";
const RESUME_MESSAGE = "Auto-compact ran. Continue the current task.";
const STATUS_KEY = "ac";
/** Nerd Font recycle icon (uf1b8) prefixing the status. */
const STATUS_ICON = "";

type AutoCompactConfig = {
	/** When false, this plugin stays inactive (built-in or no compaction in use). */
	enabled: boolean;
	autoCompactThreshold: number;
	/** Optional dedicated compaction model; falls back to the session model. */
	compactionModel?: CompactionModelConfig;
};

type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

type CompactionModelConfig = {
	provider: string;
	model: string;
	/** Optional thinking level for the compaction call (default: model default). */
	thinkingLevel?: ThinkingLevel;
};

function parseCompactionModelConfig(value: unknown): CompactionModelConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("compactionModel must be an object with provider and model.");
	}
	const { provider, model, thinkingLevel } = value as Record<string, unknown>;
	if (
		typeof provider !== "string" ||
		!provider.trim() ||
		typeof model !== "string" ||
		!model.trim()
	) {
		throw new Error(
			"compactionModel.provider and compactionModel.model must be non-empty strings.",
		);
	}
	if (
		thinkingLevel !== undefined &&
		!"off,minimal,low,medium,high,xhigh,max"
			.split(",")
			.includes(thinkingLevel as string)
	) {
		throw new Error(
			`compactionModel.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max; got ${JSON.stringify(thinkingLevel)}.`,
		);
	}
	return {
		provider: provider.trim(),
		model: model.trim(),
		...(thinkingLevel === undefined
			? {}
			: { thinkingLevel: thinkingLevel as ThinkingLevel }),
	};
}

function isValidThreshold(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_COMPACT_THRESHOLD_PERCENT &&
		value < 100
	);
}

function parseAutoCompactConfig(value: unknown): AutoCompactConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Config must be an object.");
	}
	const raw = value as Record<string, unknown>;
	const threshold =
		raw.autoCompactThreshold ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;
	if (!isValidThreshold(threshold)) {
		throw new Error(
			`autoCompactThreshold must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`,
		);
	}
	const enabled = raw.enabled ?? true;
	if (typeof enabled !== "boolean") {
		throw new Error("enabled must be a boolean.");
	}
	return {
		enabled,
		autoCompactThreshold: threshold,
		...(raw.compactionModel !== undefined && raw.compactionModel !== null
			? { compactionModel: parseCompactionModelConfig(raw.compactionModel) }
			: {}),
	};
}

/**
 * Abort error texts seen on aborted assistant messages: undici's fetch abort
 * (DOMException) says "This operation was aborted", Pi's own utils/abort.js
 * Error says "The operation was aborted". Match both, loosely, so the
 * rewrite below does not depend on which layer produced the error.
 */
function isAbortErrorMessage(errorMessage: unknown): boolean {
	return (
		typeof errorMessage === "string" &&
		errorMessage.includes("operation was aborted")
	);
}

/**
 * Content worth keeping visible: non-empty text, tool calls, or any other
 * payload. Thinking blocks and empty text parts are not — an abort that
 * streamed only partial thinking should still be rewritten into a quiet
 * stop instead of surfacing as an error.
 */
function hasVisibleContent(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content !== "";
	if (!Array.isArray(content)) return true; // unknown shape: don't touch
	return content.some(
		(part) =>
			(part.type === "text" && part.text !== "") ||
			(part.type !== "text" && part.type !== "thinking"),
	);
}

/** Rough size of a message list; only used for keepRecent's notice text. */
function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

// ============================================================================
// Fallback estimate — a faithful port of Pi's own estimator
// (core/compaction/compaction.js: estimateContextTokens +
// estimateProjectedContextTokens). Used ONLY when ctx.getContextUsage()
// returns null, which happens after a compaction when no post-compaction
// assistant usage exists — e.g. providers that never report usage.
// ============================================================================

/** Port of Pi's getAssistantUsage: skip aborted/error/all-zero usage. */
function getAssistantUsage(msg: AgentMessage) {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as {
			stopReason?: string;
			usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		const usage = assistantMsg.usage;
		const total =
			usage?.totalTokens ||
			(usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && usage && total > 0) {
			return usage;
		}
	}
	return undefined;
}

/**
 * Port of Pi's estimateContextTokens: real usage from the last valid
 * assistant message + chars/4 estimate for messages after it.
 */
function estimateContextTokensPort(messages: AgentMessage[]) {
	let lastUsageIndex = -1;
	let usageTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) {
			lastUsageIndex = i;
			usageTokens =
				(usage as { totalTokens?: number }).totalTokens ||
				((usage as { input?: number }).input ?? 0) +
				((usage as { output?: number }).output ?? 0) +
				((usage as { cacheRead?: number }).cacheRead ?? 0) +
				((usage as { cacheWrite?: number }).cacheWrite ?? 0);
			break;
		}
	}
	if (lastUsageIndex === -1) {
		const estimated = estimateTotalTokens(messages);
		return { tokens: estimated, usageTokens: 0, lastUsageIndex: -1 };
	}
	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}
	return { tokens: usageTokens + trailingTokens, usageTokens, lastUsageIndex };
}

/**
 * Port of Pi's estimateProjectedContextTokens: trust usage only if it is
 * newer than the latest compaction/context_edit entry; otherwise fall back
 * to a full chars/4 pass over the projected messages.
 *
 * Returns whether the number is backed by real provider usage — the `~`
 * marker in the status bar is derived from this, not from which code path
 * produced the number.
 */
function estimateProjectedContextTokensPort(
	ctx: ExtensionContext,
): { tokens: number; fromRealUsage: boolean; usageExists: boolean } {
	// SAFETY: runtime pi (v0.99.x dist/session-manager.js) exposes
	// buildSessionProjection on the object passed as ctx.sessionManager;
	// the local type stubs just omit it from ReadonlySessionManager.
	const sessionManager = ctx.sessionManager as unknown as {
		buildSessionProjection(): {
			messages: AgentMessage[];
			entries: { messages: AgentMessage[]; sourceEntry: { id: string } }[];
		};
		getBranch(): { id: string; type: string }[];
	};
	const projection = sessionManager.buildSessionProjection();
	const branch = ctx.sessionManager.getBranch();
	const estimate = estimateContextTokensPort(projection.messages);

	if (estimate.lastUsageIndex !== -1) {
		// Locate the entry that carries the last usage.
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = (entry.sourceEntry as { id: string }).id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}
		const usageEntryIndex = usageEntryId
			? branch.findIndex((entry) => entry.id === usageEntryId)
			: -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			const entryType = entry.type as string;
			if (entryType === "context_edit" || entryType === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) {
			return { tokens: estimate.tokens, fromRealUsage: true, usageExists: true };
		}
	}

	// Usage is stale or absent: full chars/4 pass (Pi's fallback branch).
	// usageExists distinguishes "usage exists but predates the latest
	// compaction" (wait for the next response — see holdOff below) from
	// "this provider never reports usage" (the estimate is the only signal).
	return {
		tokens: estimateTotalTokens(projection.messages),
		fromRealUsage: false,
		usageExists: estimate.lastUsageIndex !== -1,
	};
}

/**
 * Do not cut inside assistant/toolResult history. A user boundary is safe:
 * tool calls and their results belong to the preceding turn. Prefer the next
 * user boundary at or after `index` (drops the orphan head of a turn); when
 * the keep window lands inside the current (latest) turn there is no later
 * user message, so fall back to that turn's opening user message — keeping
 * a valid, meaningful request beats collapsing it to a bare notice. Returns
 * -1 when no safe cut exists.
 */
function snapToUserBoundary(messages: AgentMessage[], index: number): number {
	let forward = index;
	while (forward < messages.length && messages[forward].role !== "user") forward++;
	if (forward < messages.length) return forward;
	let backward = Math.min(index, messages.length - 1);
	while (backward >= 0 && messages[backward].role !== "user") backward--;
	return backward;
}

/**
 * Return temporary context containing newest messages plus notice.
 * This changes only request context; session history remains intact.
 */
function keepRecent(
	messages: AgentMessage[],
	keepTokens: number,
): AgentMessage[] | null {
	let tokens = 0;
	let cutIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		const messageTokens = estimateTokens(messages[i]);
		if (tokens + messageTokens > keepTokens) {
			cutIndex = snapToUserBoundary(messages, i + 1);
			break;
		}
		tokens += messageTokens;
	}

	// -1: everything fits inside the keep window. 0 or -1 from the snap: no
	// messages can be removed at a safe boundary (single oversized turn) —
	// leave the request untruncated; the scheduled compaction still protects
	// the session.
	if (cutIndex <= 0) return null;

	const removed = messages.slice(0, cutIndex);
	return [
		{
			role: "user",
			content: `[Context compacted: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) were summarized. Continue with the current task.]`,
			timestamp: Date.now(),
		},
		...messages.slice(cutIndex),
	];
}

/** Final assistant turns need no automatic follow-up; tool turns do. */
function hasToolCall(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "toolCall")
	);
}

type CompactionDetails = { readFiles?: unknown; modifiedFiles?: unknown };

export default function (pi: ExtensionAPI) {
	let active = false;
	let autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
	let compactionModel: CompactionModelConfig | null = null;
	let configPath: string | null = null;
	// Prevent lifecycle hooks from starting duplicate summaries.
	let compactionPending = false;
	let compactionAbortExpected = false;

	const runCompaction = (ctx: ExtensionContext, resumeTask = true) => {
		compactionAbortExpected = Boolean(ctx.signal && !ctx.signal.aborted);
		setCompactingStatus(ctx);
		ctx.compact({
			customInstructions: COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				compactionPending = false;
				compactionAbortExpected = false;
				updateStatus(ctx, ctx.getContextUsage()?.percent ?? null);
				if (!resumeTask) return;
				// Pi may flush queued input during compaction_end. Wait one macrotask
				// before checking idle, otherwise follow-up can race that flush.
				setImmediate(() => {
					if (!ctx.isIdle()) return;
					pi.sendMessage(
						{
							customType: RESUME_MESSAGE_TYPE,
							content: RESUME_MESSAGE,
							display: false,
						},
						{ triggerTurn: true },
					);
				});
			},
			onError: () => {
				compactionPending = false;
				compactionAbortExpected = false;
				updateStatus(ctx, ctx.getContextUsage()?.percent ?? null);
			},
		});
	};

	/**
	 * Status bar display, single source: ctx.getContextUsage() — the same value
	 * Pi's footer renders. No self-computed estimates: when Pi reports unknown
	 * (e.g. right after compaction, before the next LLM response) the footer
	 * shows "?" and this mirrors it instead of guessing.
	 */
	const updateStatus = (
		ctx: ExtensionContext,
		percent: number | null,
		fromRealUsage = true,
	) => {
		if (!active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const shown = percent == null ? "?" : `${fromRealUsage ? "" : "~"}${Math.round(percent)}%`;
		const star = percent != null && percent > autoCompactThreshold ? " *" : "";
		ctx.ui.setStatus(
			STATUS_KEY,
			`${STATUS_ICON} ac: ${shown}/${autoCompactThreshold}%${star}`,
		);
	};

	/** Compaction-in-progress status; model name shown only here. */
	const setCompactingStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			STATUS_KEY,
			compactionModel
				? `${STATUS_ICON} ac: compacting… @${compactionModel.model}`
				: `${STATUS_ICON} ac: compacting…`,
		);
	};

	const compactIfNeeded = (ctx: ExtensionContext, resumeTask = true) => {
		if (!active || compactionPending) return;

		// Single source for the number: Pi's usage, with the ported estimator
		// as fallback. Single source for the `~` marker: whether the number is
		// backed by real provider usage (checked via the same port) — so a
		// value pi itself estimated pre-compaction is marked too.
		let percent = ctx.getContextUsage()?.percent ?? null;
		let fromRealUsage = percent != null;
		// Post-compaction hold-off (mirrors Pi's own semantics): when the only
		// usage data predates the latest compaction, wait for the next response
		// instead of acting on a rough estimate — otherwise a kept tail that is
		// still above threshold would retrigger compaction in a loop. Providers
		// that never report usage have no usage at all and still act on the
		// estimate.
		let holdOff = false;
		if (percent == null) {
			const contextWindow = ctx.model?.contextWindow ?? 0;
			if (contextWindow > 0) {
				const est = estimateProjectedContextTokensPort(ctx);
				percent = (est.tokens / contextWindow) * 100;
				fromRealUsage = est.fromRealUsage;
				holdOff = !est.fromRealUsage && est.usageExists;
			}
		} else {
			// Pi returned a number, but verify it is usage-backed; pi's own
			// pre-compaction estimate path needs the `~` marker as well.
			fromRealUsage = estimateProjectedContextTokensPort(ctx).fromRealUsage;
		}
		updateStatus(ctx, percent, fromRealUsage);
		if (percent == null || holdOff || percent <= autoCompactThreshold) return;

		compactionPending = true;
		runCompaction(ctx, resumeTask);
	};

	// Hide only empty abort produced when ctx.compact() cancels active run.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (
			!compactionPending ||
			!compactionAbortExpected ||
			!ctx.signal?.aborted ||
			message.role !== "assistant" ||
			message.stopReason !== "error" ||
			!isAbortErrorMessage(message.errorMessage) ||
			hasVisibleContent(message)
		)
			return;

		compactionAbortExpected = false;
		return {
			message: { ...message, stopReason: "stop", errorMessage: undefined },
		};
	});

	// Do not use agent_settled here: long tool loops may cross threshold before
	// the full run settles. These hooks inspect every provider-turn boundary.
	// Pre-turn catches resumed/queued work before provider request starts.
	pi.on("turn_start", (_event, ctx) => compactIfNeeded(ctx));

	// Only tool-call turns need mid-run compaction.
	pi.on("turn_end", (event, ctx) => {
		if (!hasToolCall(event.message)) return;
		// Defer one macrotask: Pi persists the turn's messages after emitting
		// this event, so an immediate read can still miss the fresh usage.
		setImmediate(() => compactIfNeeded(ctx));
	});

	// Catch threshold crossings caused by the final provider turn.
	pi.on("agent_end", (_event, ctx) => {
		// Same deferral as turn_end: at the moment agent_end fires, the final
		// assistant message (with usage) is not persisted yet, so
		// getContextUsage() reports unknown ("?") right after a compaction.
		setImmediate(() => compactIfNeeded(ctx, false));
	});

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous compaction summarizes persisted history.
	pi.on("context", (event, ctx) => {
		if (!active || compactionPending) return;

		// Same source as the footer and the threshold check: Pi's usage estimate,
		// with the ported estimator as fallback when Pi reports unknown. The
		// `~` marker uses the same usage-backed check as compactIfNeeded.
		let usage = ctx.getContextUsage();
		let fromRealUsage = usage != null;
		// Same post-compaction hold-off as compactIfNeeded: stale usage means
		// wait for the next response; never-reporting providers still act.
		let holdOff = false;
		if (!usage) {
			const contextWindow = ctx.model?.contextWindow ?? 0;
			if (contextWindow > 0) {
				const est = estimateProjectedContextTokensPort(ctx);
				usage = { tokens: est.tokens, contextWindow, percent: (est.tokens / contextWindow) * 100 };
				fromRealUsage = est.fromRealUsage;
				holdOff = !est.fromRealUsage && est.usageExists;
			}
		} else {
			fromRealUsage = estimateProjectedContextTokensPort(ctx).fromRealUsage;
		}
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		updateStatus(ctx, usage?.percent ?? null, fromRealUsage);
		if (
			!usage ||
			usage.tokens == null ||
			contextWindow <= 0 ||
			holdOff ||
			usage.tokens <= (contextWindow * autoCompactThreshold) / 100
		)
			return;

		// Mark pending before deferring. Another context event can fire before
		// setImmediate runs, and must not schedule a second compaction.
		compactionPending = true;
		setImmediate(() => runCompaction(ctx));
		// Best-effort request guard: truncate to the keep window when a safe
		// user boundary exists. When no safe cut exists (single oversized turn)
		// the request goes out untruncated — the compaction scheduled above
		// still protects the session.
		const truncated = keepRecent(
			event.messages,
			Math.floor((contextWindow * KEEP_RECENT_PERCENT) / 100),
		);
		return truncated ? { messages: truncated } : undefined;
	});

	pi.registerCommand("auto-compact", {
		description: "configure automatic compaction threshold and model",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /auto-compact", "error");
				return;
			}
			if (!configPath) {
				ctx.ui.notify("pi-auto-compact is not active.", "error");
				return;
			}

			// Read current on-disk config to preserve fields this menu doesn't touch.
			let diskConfig: AutoCompactConfig;
			try {
				diskConfig = parseAutoCompactConfig(
					JSON.parse(readFileSync(configPath, "utf8")),
				);
			} catch {
				diskConfig = { enabled: true, autoCompactThreshold: autoCompactThreshold };
			}

			const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const builtInOn = settings.getCompactionEnabled();
			const ownerValue = active ? "thisPlugin" : builtInOn ? "builtIn" : "off";
			const modelValue = compactionModel
				? `${compactionModel.provider}/${compactionModel.model}`
				: "sessionModel";

			const action = await ctx.ui.select("/auto-compact", [
				`compactionOwner → ${ownerValue}`,
				`threshold → ${autoCompactThreshold}%`,
				`compactionModel → ${modelValue}`,
			]);
			if (action === undefined) return;

			if (action.startsWith("compactionOwner")) {
				const OWNER_OPTIONS = ["thisPlugin", "builtIn", "off"] as const;
				const owner = await ctx.ui.select(
					"compactionOwner",
					OWNER_OPTIONS.map((o) => (o === ownerValue ? `→ ${o}` : o)),
				);
				if (owner === undefined) return;
				const chosen = owner.replace("→ ", "");

				if (chosen === "thisPlugin") {
					settings.setCompactionEnabled(false);
					diskConfig.enabled = true;
					active = true;
				} else if (chosen === "builtIn") {
					settings.setCompactionEnabled(true);
					diskConfig.enabled = false;
					active = false;
					compactionPending = false;
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} else {
					settings.setCompactionEnabled(false);
					diskConfig.enabled = false;
					active = false;
					compactionPending = false;
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
				await settings.flush();
			} else if (action.startsWith("threshold")) {
				const input = await ctx.ui.input(
					`threshold (%) · current: ${autoCompactThreshold}`,
					"Enter a number at least 25 and below 100",
				);
				if (input === undefined) return;

				const threshold = Number(input.trim());
				if (!isValidThreshold(threshold)) {
					ctx.ui.notify("Threshold must be at least 25% and below 100%.", "error");
					return;
				}
				diskConfig.autoCompactThreshold = threshold;
				autoCompactThreshold = threshold;
			} else if (action.startsWith("compactionModel")) {
				const available = ctx.modelRegistry.getAvailable();
				if (!available.length) {
					ctx.ui.notify("No available models found.", "error");
					return;
				}

				const sessionOption = "sessionModel";
				const options = [
					sessionOption,
					...available.map((m) => `${m.provider}/${m.id}`),
				];
				const choice = await ctx.ui.select(
					"compactionModel",
					options.map((o) => (o === modelValue ? `→ ${o}` : o)),
				);
				if (choice === undefined) return;
				const picked = choice.replace("→ ", "");

				if (picked === sessionOption) {
					compactionModel = null;
					delete (diskConfig as { compactionModel?: unknown }).compactionModel;
				} else {
					const [provider, ...rest] = picked.split("/");
					const modelId = rest.join("/");

					// Ask for the compaction thinking level explicitly so the saved
					// config fully determines compaction behavior.
					const level = await ctx.ui.select(
						`Thinking level for compaction with ${provider}/${modelId}`,
						[
							"Model default (don't override)",
							"off",
							"minimal",
							"low",
							"medium",
							"high",
							"xhigh",
							"max",
						],
					);
					if (level === undefined) return;

					const next =
						level === "Model default (don't override)"
							? { provider, model: modelId }
							: { provider, model: modelId, thinkingLevel: level as ThinkingLevel };
					compactionModel = next;
					diskConfig.compactionModel = next;
				}
			} else return;

			try {
				await mkdir(join(configPath, ".."), { recursive: true });
				await writeFileSync(configPath, JSON.stringify(diskConfig, null, "\t"));
			} catch {
				ctx.ui.notify("Couldn't save pi-auto-compact config.", "error");
				return;
			}
			ctx.ui.notify(
				compactionModel
					? `Auto-compact: threshold ${autoCompactThreshold}%, model ${compactionModel.provider}/${compactionModel.model}.`
					: `Auto-compact: threshold ${autoCompactThreshold}%, session model.`,
				"info",
			);
		},
	});

	// Pi's built-in automatic compaction competes with this extension. Refuse
	// activation unless effective global/project settings disable it.
	pi.on("session_start", (_event, ctx) => {
		configPath = join(getAgentDir(), "config", "pi-auto-compact", "config.json");
		let parsed: AutoCompactConfig | null = null;
		try {
			parsed = parseAutoCompactConfig(
				JSON.parse(readFileSync(configPath, "utf8")),
			);
			autoCompactThreshold = parsed.autoCompactThreshold;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
			} else {
				autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
				ctx.ui.notify(
					`Couldn't read pi-auto-compact config; using ${DEFAULT_COMPACT_THRESHOLD_PERCENT}%.`,
					"error",
				);
			}
		}

		const configuredModel = parsed?.compactionModel ?? null;
		if (configuredModel) {
			const model = ctx.modelRegistry.find(
				configuredModel.provider,
				configuredModel.model,
			);
			if (model) {
				compactionModel = configuredModel;
			} else {
				ctx.ui.notify(
					`Compaction model ${configuredModel.provider}/${configuredModel.model} not found; using session model.`,
					"error",
				);
			}
		} else {
			compactionModel = null;
		}

		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const builtInCompaction = settings.getCompactionEnabled();
		if (parsed && !parsed.enabled) {
			// User chose built-in compaction or off via the menu; stay inactive.
			active = false;
		} else if (builtInCompaction) {
			// Built-in compaction still enabled: stay inactive instead of failing.
			// The user can pick this plugin via /auto-compact, which disables built-in.
			active = false;
			ctx.ui.notify(
				"pi-auto-compact is inactive: Pi built-in auto-compaction is enabled. " +
					"Run /auto-compact to choose the compaction owner.",
				"warning",
			);
		} else {
			active = true;
		}

		// Show the status bar immediately on every session start; large
		// resumed/forked sessions may already be near the threshold.
		compactIfNeeded(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Intercept every compaction while this plugin owns compaction: the
		// plugin's own automatic triggers, manual /compact, and any recovery
		// path — all use the configured compaction model (and the details
		// continuity restore below).
		if (!active) return;

		// Show "compacting…" from the moment the LLM call is about to start.
		// For plugin-triggered compactions runCompaction already set the same
		// status (idempotent); for manual /compact this is the only start hook
		// extensions get (pi's compaction_start is TUI-internal).
		setCompactingStatus(ctx);

		// Pi omits details from prior extension compactions when preparing next run.
		const previous = [...event.branchEntries]
			.reverse()
			.find((entry) => entry.type === "compaction");
		if (previous?.details && typeof previous.details === "object") {
			const details = previous.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const path of details.readFiles) {
					if (typeof path === "string") event.preparation.fileOps.read.add(path);
				}
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const path of details.modifiedFiles) {
					if (typeof path === "string") event.preparation.fileOps.edited.add(path);
				}
			}
		}
		// No dedicated model configured: compaction uses the current session model.
		if (!compactionModel) {
			const sessionModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "session model";
			ctx.ui.notify(`Compacting with session model (${sessionModel}).`, "info");
			return;
		}

		const model = ctx.modelRegistry.find(
			compactionModel.provider,
			compactionModel.model,
		);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${compactionModel.provider}/${compactionModel.model} not found; compacting with session model.`,
				"error",
			);
			return;
		}

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(
					`Compaction model ${compactionModel.provider}/${compactionModel.model} has no usable auth; compacting with session model.`,
					"error",
				);
				return;
			}

			const requestModel = auth.baseUrl
				? { ...model, baseUrl: auth.baseUrl }
				: model;
			const result = await compact(
				event.preparation,
				requestModel,
				auth.apiKey,
				auth.headers
					? (Object.fromEntries(
							Object.entries(auth.headers).filter(
								(entry): entry is [string, string] => entry[1] !== null,
							),
						) as Record<string, string>)
					: undefined,
				event.customInstructions,
				event.signal,
				compactionModel.thinkingLevel,
				undefined,
				auth.env,
			);
			ctx.ui.notify(
				`Compacted with ${compactionModel.provider}/${compactionModel.model}.`,
				"info",
			);
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted) return;
			// Restore a live status reading; pi falls back to the session model.
			updateStatus(ctx, ctx.getContextUsage()?.percent ?? null);
			ctx.ui.notify(
				`Compaction with ${compactionModel.provider}/${compactionModel.model} failed; using session model. ${(error as Error).message}`,
				"error",
			);
		}
	});

	// Compaction completion: refresh the status bar for manual compactions
	// (the plugin's own triggers reset it via ctx.compact's onComplete/onError)
	// and append a persistent transcript notice naming the model — toasts are
	// transient and easy to miss, and pi's native "Compacted from N tokens"
	// line carries no model info. display:true renders it in the transcript
	// ([pi-auto-compact] Compacted …); like the resume message it also reaches
	// the model as a tiny user-role note.
	pi.on("session_compact", (event, ctx) => {
		if (!active) return;
		if (!compactionPending) {
			updateStatus(ctx, ctx.getContextUsage()?.percent ?? null);
		}
		const model = compactionModel
			? `${compactionModel.provider}/${compactionModel.model}`
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id} (session model)`
				: "session model";
		const tokensBefore = event.compactionEntry?.tokensBefore;
		const from =
			typeof tokensBefore === "number"
				? ` from ${tokensBefore.toLocaleString()} tokens`
				: "";
		void pi.sendMessage({
			customType: "pi-auto-compact",
			content: `Compacted${from} with ${model}.`,
			display: true,
		});
	});

	// Manual /compact failed or was cancelled: refresh so "compacting…"
	// does not linger until the next turn boundary.
	pi.on("session_compact_failed", (_event, ctx) => {
		if (!active || compactionPending) return;
		updateStatus(ctx, ctx.getContextUsage()?.percent ?? null);
	});
}
