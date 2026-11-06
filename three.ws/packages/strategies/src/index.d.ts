// Type definitions for @three-ws/strategies

export declare class ThreeWsError extends Error {
	name: string;
	code: string;
	status: number | null;
	detail?: string;
	retryAfter?: number;
	body: unknown;
}

export declare class PaymentRequiredError extends ThreeWsError {
	accepts: unknown | null;
}

/** Alias of {@link ThreeWsError} — the package's typed error. */
export declare class StrategyError extends ThreeWsError {}

export declare const DEFAULT_BASE_URL: string;

export type Network = 'mainnet' | 'devnet';
export type DcaInterval = 'daily' | 'weekly';
export type CopySizingRule = 'fixed' | 'multiplier' | 'pct_balance';
export type MirrorSizingMode = 'fixed' | 'proportional' | 'pct_balance';
export type StrategyScope = 'mine' | 'published';
export type StrategySort = 'recent' | 'forks' | 'equips' | 'performance';
export type CopyExecutionStatus = 'pending' | 'acted' | 'dismissed' | 'skipped' | 'expired' | 'all';

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface StrategiesClientOptions {
	/** Bearer token. Omit to rely on the three.ws session cookie. */
	token?: string;
	/** Alias of `token`. */
	apiKey?: string;
	/** API origin (default https://three.ws). */
	baseUrl?: string;
	/** fetch implementation. Pass a payment-aware fetch to auto-settle 402s. */
	fetch?: typeof fetch;
	/** Default network for copy/mirror calls. */
	network?: Network;
	/** Required for cookie-session writes (bearer clients are exempt). */
	csrfToken?: string;
	/** Extra default headers on every request. */
	headers?: Record<string, string>;
}

// ── DCA ──────────────────────────────────────────────────────────────────────

export interface DcaInput {
	agentId: string;
	delegationId: string;
	tokenIn: string;
	tokenOut: string;
	tokenOutSymbol: string;
	/** Amount in wei (decimal integer string). */
	amountPerExecution: string;
	interval: DcaInterval;
	/** Falls back to the operator's DCA_CHAIN_ID when omitted. */
	chainId?: number;
	/** 1–500, default 50. */
	slippageBps?: number;
}

export interface DcaExecution {
	tx_hash: string | null;
	amount_in: string | null;
	amount_out: string | null;
	status: string | null;
	executed_at: string | null;
}

export interface DcaStrategy {
	id: string | null;
	status: string | null;
	chainId: number | null;
	tokenIn: string | null;
	tokenOut: string | null;
	tokenOutSymbol: string | null;
	amountPerExecution: string | null;
	periodSeconds: number | null;
	slippageBps: number | null;
	nextExecutionAt: string | null;
	lastExecutionAt: string | null;
	lastExecution: DcaExecution | null;
	createdAt: string | null;
	raw: unknown;
}

export interface OkResult {
	ok: boolean;
	raw: unknown;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export interface CopyInput {
	copierWallet: string;
	sizingRule?: CopySizingRule;
	fixedSol?: number;
	multiplier?: number;
	pctBalance?: number;
	perTradeCapSol?: number;
	minOrderSol?: number;
	dailyBudgetSol?: number;
	maxOpenCopies?: number;
	mcapFloorUsd?: number;
	mcapCeilingUsd?: number;
	copySells?: boolean;
	requireSafetyPass?: boolean;
	minOracleScore?: number;
	perfFeeBps?: number;
	telegramChatId?: string;
	network?: Network;
}

export interface Subscription {
	id: string | null;
	status: string | null;
	leaderAgentId: string | null;
	leaderName: string | null;
	leaderWallet: string | null;
	copierWallet: string | null;
	network: string | null;
	sizingRule: string | null;
	fixedSol: number | null;
	multiplier: number | null;
	pctBalance: number | null;
	perTradeCapSol: number | null;
	minOrderSol: number | null;
	dailyBudgetSol: number | null;
	maxOpenCopies: number | null;
	mcapFloorUsd: number | null;
	mcapCeilingUsd: number | null;
	copySells: boolean | null;
	requireSafetyPass: boolean | null;
	minOracleScore: number | null;
	perfFeeBps: number | null;
	pendingCount: number | null;
	actedCount: number | null;
	createdAt: string | null;
	updatedAt: string | null;
	raw: unknown;
}

export interface CopyExecution {
	id: string | null;
	subscriptionId: string | null;
	leaderAgentId: string | null;
	leaderName: string | null;
	status: string | null;
	direction: string | null;
	mint: string | null;
	orderSol: number | null;
	reason: string | null;
	txSignature: string | null;
	expiresAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	raw: unknown;
}

export interface CopyExecutionsResult {
	executions: CopyExecution[];
	raw: unknown;
}

// ── Mirror ───────────────────────────────────────────────────────────────────

export interface MirrorInput {
	sizingMode?: MirrorSizingMode;
	fixedSol?: number;
	proportionPct?: number;
	pctBalance?: number;
	maxPerTradeSol?: number;
	dailyBudgetSol?: number;
	minLeaderSol?: number;
	copySells?: boolean;
	mintAllowlist?: string[];
	mintDenylist?: string[];
	enabled?: boolean;
	network?: Network;
}

export interface Follow {
	id: number | null;
	leaderAgentId: string | null;
	leaderName: string | null;
	network: string | null;
	enabled: boolean | null;
	sizingMode: string | null;
	fixedSol: number | null;
	proportionPct: number | null;
	pctBalance: number | null;
	maxPerTradeSol: number | null;
	dailyBudgetSol: number | null;
	minLeaderSol: number | null;
	copySells: boolean | null;
	mintAllowlist: string[];
	mintDenylist: string[];
	createdAt: string | null;
	updatedAt: string | null;
	raw: unknown;
}

export interface MirrorFill {
	id: number | null;
	leaderAgentId: string | null;
	leaderName: string | null;
	side: string | null;
	mint: string | null;
	leaderSol: number | null;
	plannedSol: number | null;
	status: string | null;
	skipReason: string | null;
	skipLabel: string | null;
	signature: string | null;
	usd: number | null;
	priceImpactPct: number | null;
	at: string | null;
	raw: unknown;
}

export interface MirrorState {
	isOwner: boolean;
	killed: boolean;
	following: Follow[];
	followingCount: number;
	followersCount: number;
	activeFollowers: number;
	recent: MirrorFill[];
	raw: unknown;
}

export interface KillResult {
	killed: boolean;
	raw: unknown;
}

export interface SweepResult {
	synced: unknown[];
	raw: unknown;
}

export interface RemoveResult {
	removed: boolean;
	raw: unknown;
}

// ── Strategy Objects ─────────────────────────────────────────────────────────

export interface StrategyPerformance {
	proven: boolean;
	trades: number;
	open: number;
	wins: number | null;
	losses: number | null;
	pnlSol: number | null;
	roiPct: number | null;
	winRate: number | null;
	worstSol: number | null;
	lastClosedAt: string | null;
}

export interface Strategy {
	id: string | null;
	name: string | null;
	slug: string | null;
	description: string | null;
	config: unknown;
	version: number | null;
	published: boolean | null;
	publishedAt: string | null;
	ownerId: string | null;
	ownerName: string | null;
	forkOf: string | null;
	forkedFrom: unknown;
	forksCount: number | null;
	equipsCount: number | null;
	isOwner?: boolean;
	equipped?: { total: number; active: number };
	performance: StrategyPerformance | null;
	rank?: number;
	createdAt: string | null;
	updatedAt: string | null;
	raw: unknown;
}

export interface StrategyConfig {
	network?: Network;
	entry?: Record<string, unknown>;
	sizing?: Record<string, unknown>;
	exits?: Record<string, unknown>;
	risk?: Record<string, unknown>;
}

export interface CreateStrategyInput {
	name: string;
	description?: string;
	config?: StrategyConfig;
}

export interface ListStrategiesQuery {
	scope?: StrategyScope;
	sort?: StrategySort;
	q?: string;
	limit?: number;
	author?: string;
	agent?: string;
}

export interface ListStrategiesResult {
	scope: string | null;
	sort: string | null;
	strategies: Strategy[];
	raw: unknown;
}

export interface LeaderboardResult {
	leaders: Strategy[];
	count: number;
	raw: unknown;
}

export interface DeleteStrategyResult {
	deleted: boolean;
	raw: unknown;
}

export interface UpdateStrategyPatch {
	name?: string;
	description?: string | null;
	config?: StrategyConfig;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface StrategiesClient {
	dca(input: DcaInput, opts?: RequestOptions): Promise<DcaStrategy>;
	listDca(agentId: string, opts?: RequestOptions): Promise<DcaStrategy[]>;
	cancelDca(strategyId: string, opts?: RequestOptions): Promise<OkResult>;

	copy(leaderAgentId: string, input: CopyInput, opts?: RequestOptions): Promise<Subscription>;
	listSubscriptions(opts?: RequestOptions): Promise<Subscription[]>;
	copyExecutions(query?: { status?: CopyExecutionStatus; limit?: number }, opts?: RequestOptions): Promise<CopyExecutionsResult>;
	actCopy(executionId: string, txSignature?: string, opts?: RequestOptions): Promise<CopyExecution>;
	dismissCopy(executionId: string, opts?: RequestOptions): Promise<CopyExecution>;
	pauseCopy(subscriptionId: string, opts?: RequestOptions): Promise<Subscription>;
	stopCopy(subscriptionId: string, opts?: RequestOptions): Promise<Subscription>;

	mirror(agentId: string, leaderAgentId: string, input?: MirrorInput, opts?: RequestOptions): Promise<Follow>;
	unmirror(agentId: string, leaderAgentId: string, opts?: RequestOptions): Promise<RemoveResult>;
	killSwitch(agentId: string, engaged: boolean, opts?: RequestOptions): Promise<KillResult>;
	sweep(agentId: string, opts?: RequestOptions): Promise<SweepResult>;
	equipped(agentId: string, opts?: RequestOptions): Promise<MirrorState>;

	createStrategy(input: CreateStrategyInput, opts?: RequestOptions): Promise<Strategy>;
	listStrategies(query?: ListStrategiesQuery, opts?: RequestOptions): Promise<ListStrategiesResult>;
	getStrategy(strategyId: string, opts?: RequestOptions): Promise<Strategy>;
	leaderboard(query?: { limit?: number }, opts?: RequestOptions): Promise<LeaderboardResult>;
	forkStrategy(strategyId: string, opts?: RequestOptions): Promise<Strategy>;
	publishStrategy(strategyId: string, published?: boolean, opts?: RequestOptions): Promise<Strategy>;
	updateStrategy(strategyId: string, patch: UpdateStrategyPatch, opts?: RequestOptions): Promise<Strategy>;
	deleteStrategy(strategyId: string, opts?: RequestOptions): Promise<DeleteStrategyResult>;
}

export declare function createStrategies(options?: StrategiesClientOptions): StrategiesClient;
/** README headline alias of {@link createStrategies}. */
export declare function strategies(options?: StrategiesClientOptions): StrategiesClient;

export declare function dca(input: DcaInput, opts?: RequestOptions): Promise<DcaStrategy>;
export declare function listDca(agentId: string, opts?: RequestOptions): Promise<DcaStrategy[]>;
export declare function cancelDca(strategyId: string, opts?: RequestOptions): Promise<OkResult>;
export declare function copy(leaderAgentId: string, input: CopyInput, opts?: RequestOptions): Promise<Subscription>;
export declare function listSubscriptions(opts?: RequestOptions): Promise<Subscription[]>;
export declare function copyExecutions(query?: { status?: CopyExecutionStatus; limit?: number }, opts?: RequestOptions): Promise<CopyExecutionsResult>;
export declare function actCopy(executionId: string, txSignature?: string, opts?: RequestOptions): Promise<CopyExecution>;
export declare function dismissCopy(executionId: string, opts?: RequestOptions): Promise<CopyExecution>;
export declare function pauseCopy(subscriptionId: string, opts?: RequestOptions): Promise<Subscription>;
export declare function stopCopy(subscriptionId: string, opts?: RequestOptions): Promise<Subscription>;
export declare function mirror(agentId: string, leaderAgentId: string, input?: MirrorInput, opts?: RequestOptions): Promise<Follow>;
export declare function unmirror(agentId: string, leaderAgentId: string, opts?: RequestOptions): Promise<RemoveResult>;
export declare function killSwitch(agentId: string, engaged: boolean, opts?: RequestOptions): Promise<KillResult>;
export declare function sweep(agentId: string, opts?: RequestOptions): Promise<SweepResult>;
export declare function equipped(agentId: string, opts?: RequestOptions): Promise<MirrorState>;
export declare function createStrategy(input: CreateStrategyInput, opts?: RequestOptions): Promise<Strategy>;
export declare function listStrategies(query?: ListStrategiesQuery, opts?: RequestOptions): Promise<ListStrategiesResult>;
export declare function getStrategy(strategyId: string, opts?: RequestOptions): Promise<Strategy>;
export declare function leaderboard(query?: { limit?: number }, opts?: RequestOptions): Promise<LeaderboardResult>;
export declare function forkStrategy(strategyId: string, opts?: RequestOptions): Promise<Strategy>;
export declare function publishStrategy(strategyId: string, published?: boolean, opts?: RequestOptions): Promise<Strategy>;
export declare function updateStrategy(strategyId: string, patch: UpdateStrategyPatch, opts?: RequestOptions): Promise<Strategy>;
export declare function deleteStrategy(strategyId: string, opts?: RequestOptions): Promise<DeleteStrategyResult>;
