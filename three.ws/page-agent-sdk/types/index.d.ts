// Type definitions for @three-ws/page-agent

export type AgentId = string;
export type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type LipsyncMode = 'viseme' | 'jaw' | 'animation';
export type Presents = 'female' | 'male' | 'neutral' | 'robot';
export type AvatarStyle = 'realistic' | 'stylized' | 'robot';
export type Framing = 'bust' | 'upper' | 'full';

export interface VoiceProfile {
	lang?: string;
	pitch?: number;
	rate?: number;
	match?: string[];
}

/** A skeleton-rigged, lipsync-capable agent in the catalog. */
export interface RiggedAgent {
	id: AgentId;
	name: string;
	tagline: string;
	persona: string;
	file: string;
	url?: string;
	rig: 'rpm' | 'mixamo' | 'studio';
	lipsync: LipsyncMode;
	presents: Presents;
	style: AvatarStyle;
	framing: Framing;
	voice: VoiceProfile;
	accent: string;
}

export const AGENTS: RiggedAgent[];
export const DEFAULT_AGENT_ID: AgentId;
export const DEFAULT_ASSET_BASE: string;
export function getAgent(id: AgentId): RiggedAgent | undefined;
export function agentUrl(agent: RiggedAgent, assetBase?: string): string;
export function filterAgents(q?: {
	style?: AvatarStyle;
	presents?: Presents;
	lipsync?: LipsyncMode;
	ids?: AgentId[];
}): RiggedAgent[];

/** Persona preset id — see `PRESETS` / `PRESET_IDS`. */
export type PresetId = 'guide' | 'shop-assistant' | 'defi-advisor' | 'onboarding-coach' | 'support';

export interface SuggestedPrompt {
	/** Chip label — what the visitor taps. */
	prompt: string;
	/** Spoken via `narrate()` when tapped. */
	response: string;
	/** 'narrate' (default) speaks `response`; 'tour' calls `narratePage()` instead. */
	action?: 'narrate' | 'tour';
}

/** A persona resolved from `preset="…"` — see `src/presets.js`. */
export interface PagePersonaPreset {
	id: PresetId;
	name: string;
	description: string;
	greeting: string;
	systemRole: string;
	suggestedPrompts: SuggestedPrompt[];
	/** Capability allowlist — metadata for a paired chat backend; not enforced by this package. */
	tools: string[];
}

export const PRESETS: Record<PresetId, PagePersonaPreset>;
export const PRESET_IDS: readonly PresetId[];
export function resolvePreset(id?: string): PagePersonaPreset | undefined;
export function sanitizeContext(input: unknown): Record<string, string>;
export function buildSystemPrompt(preset: PagePersonaPreset | undefined, context: Record<string, string> | undefined): string;

export interface PageAgentConfig {
	/** Element is not used as a mount; the agent docks itself to the page. */
	mount?: HTMLElement;
	agent?: AgentId;
	/** Allow-list of agent ids shown in the picker. */
	agents?: AgentId[];
	assetBase?: string;
	position?: Position;
	muted?: boolean;
	collapsed?: boolean;
	/** Hide the "change agent" affordance + picker. Default true (shown). */
	picker?: boolean;
	/** Show the control bar. Default true. */
	controls?: boolean;
	/** Spoken once on load (ignored when autoNarrate is set). Overrides the preset's greeting. */
	greeting?: string;
	/** true → tour the page; string → CSS selector of segments to narrate. */
	autoNarrate?: boolean | string;
	/** Persist the visitor's chosen agent in localStorage. Default true. */
	persistAgent?: boolean;
	/** Persona preset id — resolves greeting/systemRole/suggestedPrompts/tools defaults. */
	preset?: PresetId | string;
	/** Host-page state, sanitized and folded into `.systemPrompt`. */
	context?: Record<string, unknown>;
	/** Overrides the preset's suggested-prompt chips. */
	suggestedPrompts?: (string | SuggestedPrompt)[];
	/** Overrides the preset's tool allowlist (metadata; see `PagePersonaPreset.tools`). */
	tools?: string[];
}

export type PageAgentEvent =
	| 'ready' | 'agentchange' | 'state' | 'caption' | 'segment' | 'error';

export class PageAgent {
	constructor(config?: PageAgentConfig);
	readonly currentAgent: RiggedAgent | null;
	readonly currentPreset: PagePersonaPreset | undefined;
	readonly context: Record<string, string>;
	readonly systemPrompt: string;
	readonly suggestedPrompts: SuggestedPrompt[];
	readonly tools: string[];
	setContext(context: Record<string, unknown>): void;
	narrate(text: string, opts?: { interrupt?: boolean }): Promise<void>;
	narratePage(opts?: { selector?: string; greet?: boolean }): Promise<void>;
	stop(): void;
	setAgent(id: AgentId): Promise<void>;
	mute(on?: boolean): void;
	collapse(on?: boolean): void;
	openPicker(): void;
	closePicker(): void;
	on(event: PageAgentEvent, cb: (payload: any) => void): this;
	off(event: PageAgentEvent, cb: (payload: any) => void): this;
	dispose(): void;
}

export function mount(config?: PageAgentConfig): PageAgent;
export function collectSegments(selector?: string): { el: Element; text: string }[];

export class PageAgentElement extends HTMLElement {
	readonly controller: PageAgent | null;
	readonly currentAgent: RiggedAgent | null;
	readonly currentPreset: PagePersonaPreset | undefined;
	readonly systemPrompt: string | undefined;
	readonly tools: string[] | undefined;
	narrate(text: string, opts?: { interrupt?: boolean }): Promise<void> | undefined;
	narratePage(opts?: { selector?: string; greet?: boolean }): Promise<void> | undefined;
	stop(): void;
	setAgent(id: AgentId): Promise<void> | undefined;
	mute(on?: boolean): void;
	collapse(on?: boolean): void;
	openPicker(): void;
	setContext(context: Record<string, unknown>): void;
}
export function registerElement(tag?: string): string;

export class AvatarStage {
	constructor(container: HTMLElement, opts?: { background?: string });
	morph: unknown;
	onFrame(fn: (dt: number, nowMs: number) => void): () => void;
	load(url: string, opts?: { framing?: Framing }): Promise<unknown>;
	setSpeaking(on: boolean): void;
	dispose(): void;
}

export class SpeechNarrator {
	constructor(stage: AvatarStage, opts?: {
		muted?: boolean;
		onState?: (s: 'idle' | 'speaking') => void;
		onCaption?: (text: string | null) => void;
		onError?: (e: Error) => void;
	});
	readonly speaking: boolean;
	setAgent(agent: RiggedAgent): void;
	setMuted(muted: boolean): void;
	speak(text: string, opts?: { interrupt?: boolean }): Promise<void>;
	cancel(): void;
	dispose(): void;
}

export class AvatarPicker {
	constructor(agents: RiggedAgent[], opts: {
		onSelect: (id: AgentId) => void;
		getCurrent: () => AgentId | undefined;
		title?: string;
		subtitle?: string;
	});
	static restore(): AgentId | null;
	static persist(id: AgentId): void;
	readonly isOpen: boolean;
	mount(parent?: HTMLElement): void;
	open(): void;
	close(): void;
	dispose(): void;
}

export function createLipsync(
	text: string,
	morph: unknown,
	opts?: { rate?: number },
): { tick(nowMs: number): void; stop(): void; readonly done: boolean; readonly totalMs: number };
export function buildMorphMap(root: unknown): { mode: 'arkit' | 'jaw'; map: Map<string, any[]> } | null;
export function estimateDurationMs(text: string): number;

export default PageAgent;
