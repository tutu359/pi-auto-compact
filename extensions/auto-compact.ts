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
const COMPACTION_ABORT_ERROR = "This operation was aborted";

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

/** Estimate current request size using same estimator Pi uses. */
function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * Do not cut inside assistant/toolResult history. A user boundary is safe:
 * tool calls and their results belong to preceding turn.
 */
function snapToUserBoundary(messages: AgentMessage[], index: number): number {
	while (index < messages.length && messages[index].role !== "user") index++;
	return index;
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
	let cutIndex = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const messageTokens = estimateTokens(messages[i]);
		if (tokens + messageTokens > keepTokens) {
			cutIndex = snapToUserBoundary(messages, i + 1);
			break;
		}
		tokens += messageTokens;
	}

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
		ctx.compact({
			customInstructions: COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				compactionPending = false;
				compactionAbortExpected = false;
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
			},
		});
	};

	const compactIfNeeded = (ctx: ExtensionContext, resumeTask = true) => {
		if (!active || compactionPending) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent <= autoCompactThreshold) return;

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
			message.errorMessage !== COMPACTION_ABORT_ERROR ||
			message.content.some((part) => part.type !== "text" || part.text !== "")
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
		if (hasToolCall(event.message)) compactIfNeeded(ctx);
	});

	// Catch threshold crossings caused by the final provider turn.
	pi.on("agent_end", (_event, ctx) => compactIfNeeded(ctx, false));

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous default compaction summarizes persisted history.
	pi.on("context", (event, ctx) => {
		if (!active || compactionPending) return;

		const contextWindow =
			ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const estimatedTokens = estimateTotalTokens(event.messages);
		if (
			contextWindow <= 0 ||
			estimatedTokens <= (contextWindow * autoCompactThreshold) / 100
		)
			return;

		const truncated = keepRecent(
			event.messages,
			Math.floor((contextWindow * KEEP_RECENT_PERCENT) / 100),
		);
		if (!truncated) return;

		// Mark pending before deferring. Another context event can fire before
		// setImmediate runs, and must not schedule a second compaction.
		compactionPending = true;
		setImmediate(() => runCompaction(ctx));
		return { messages: truncated };
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
				} else {
					settings.setCompactionEnabled(false);
					diskConfig.enabled = false;
					active = false;
					compactionPending = false;
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
			ctx.ui.notify("Restart Pi for model changes to take effect.", "info");
		},
	});

	// Pi's built-in automatic compaction competes with this extension. Refuse
	// activation unless effective global/project settings disable it.
	pi.on("session_start", (event, ctx) => {
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

		// Resume/fork can load an already-large session before first turn.
		if (event.reason === "resume" || event.reason === "fork")
			compactIfNeeded(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (
			!active ||
			!compactionPending ||
			event.customInstructions !== COMPACTION_INSTRUCTIONS
		)
			return;

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
		if (!compactionModel) return;

		const model = ctx.modelRegistry.find(
			compactionModel.provider,
			compactionModel.model,
		);
		if (!model) return;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(
					`Compaction model ${compactionModel.provider}/${compactionModel.model} has no usable auth; using session model.`,
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
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted) return;
			ctx.ui.notify(
				`Compaction with ${compactionModel.provider}/${compactionModel.model} failed; using session model. ${(error as Error).message}`,
				"error",
			);
		}
	});
}
