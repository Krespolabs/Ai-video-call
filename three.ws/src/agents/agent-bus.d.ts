// Type contract for the Living-Agents bus. This file is documentation-as-types:
// it gives tasks 02–08 autocomplete on every event payload without changing the
// runtime (the bus is plain JS). Each payload extends BaseEvent, so `agentId`
// and `ts` are always present.
//
// `ts` is an ISO-8601 string sourced from the server (a row's `created_at`, a
// chat `done` event's recall timestamp, etc.) or passed by the caller; the bus
// only stamps a fallback when none is provided.

export type Iso = string;
export type Uuid = string;

export interface BaseEvent {
	/** The agent this event is about. Null only for a signed-out guest avatar. */
	agentId: Uuid | null;
	/** ISO-8601 timestamp, server-sourced when available. */
	ts: Iso;
}

export type MemoryTier = 'working' | 'recall' | 'archival';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryRecord {
	id: Uuid;
	type: MemoryType;
	content: string;
	tags: string[];
	salience: number;
	tier: MemoryTier;
	pinned: boolean;
	isPublic: boolean;
	createdAt: number;
	updatedAt: number;
}

/** A memory was created (manual add, import, or a reflection pass). */
export interface MemoryAddedEvent extends BaseEvent {
	memory: MemoryRecord;
}

/** A memory's content / visibility / salience changed. */
export interface MemoryUpdatedEvent extends BaseEvent {
	memory: MemoryRecord;
}

/** A memory was deleted/forgotten. Only the id is guaranteed. */
export interface MemoryForgottenEvent extends BaseEvent {
	memoryId: Uuid;
}

/** One memory the server actually injected into a live chat's context. */
export interface RecalledMemory {
	id: Uuid;
	type: MemoryType;
	tier: MemoryTier;
	salience: number;
	/** Truncated content for display — never the full row. */
	snippet: string;
	/** How it surfaced: pinned/working context, semantic, or lexical match. */
	match: 'context' | 'semantic' | 'lexical';
}

/** Memories were injected into a chat's context by the server (real recall). */
export interface MemoryRecalledEvent extends BaseEvent {
	memories: RecalledMemory[];
	/** The user message that triggered the recall, if the surface knows it. */
	query?: string;
	/** Whether semantic embeddings (vs lexical fallback) drove the ranking. */
	semantic?: boolean;
}

/** Persona / trait / system-prompt change landed (Brain Studio). */
export interface BrainUpdatedEvent extends BaseEvent {
	personaPrompt?: string;
	toneTags?: string[];
	/** Free-form description of what changed, for the HUD chip. */
	change?: string;
}

/** The agent's emotional state changed (Emotion engine). */
export interface MoodChangedEvent extends BaseEvent {
	mood: string;
	valence?: number;
	arousal?: number;
}

/** A higher-order insight consolidated during idle time (Dreams). */
export interface DreamCreatedEvent extends BaseEvent {
	dreamId: Uuid;
	title?: string;
	insight: string;
	sourceMemoryIds?: Uuid[];
}

/** The agent took an autonomous action (Autopilot: alert/wallet/etc.). */
export interface ActionTakenEvent extends BaseEvent {
	actionId?: Uuid;
	kind: string;
	summary: string;
	/** Memories that motivated the action — the explainability trail. */
	motivatedBy?: Uuid[];
}

/** The active "my agent" changed. */
export interface AgentChangedEvent extends BaseEvent {
	agent: Record<string, unknown> | null;
}

export interface AgentEventMap {
	'memory:added': MemoryAddedEvent;
	'memory:recalled': MemoryRecalledEvent;
	'memory:updated': MemoryUpdatedEvent;
	'memory:forgotten': MemoryForgottenEvent;
	'brain:updated': BrainUpdatedEvent;
	'mood:changed': MoodChangedEvent;
	'dream:created': DreamCreatedEvent;
	'action:taken': ActionTakenEvent;
	'agent:changed': AgentChangedEvent;
}

export type AgentEventType = keyof AgentEventMap;

export interface OnOptions {
	replay?: boolean | 'all';
	throttleMs?: number;
	signal?: AbortSignal;
}

export interface AgentBus {
	emit<T extends AgentEventType>(type: T, detail: AgentEventMap[T]): AgentEventMap[T];
	on<T extends AgentEventType>(
		type: T,
		handler: (payload: AgentEventMap[T], type?: T) => void,
		opts?: OnOptions,
	): () => void;
	on(type: '*', handler: (payload: BaseEvent, type: AgentEventType) => void, opts?: OnOptions): () => void;
	once<T extends AgentEventType>(type: T, handler: (payload: AgentEventMap[T], type?: T) => void): () => void;
	last<T extends AgentEventType>(type: T): AgentEventMap[T] | null;
	backlog<T extends AgentEventType>(type: T): AgentEventMap[T][];
	reset(): void;
}

export declare const agentBus: AgentBus;
export declare const AGENT_EVENTS: readonly AgentEventType[];
export declare const WILDCARD: '*';
export declare const EVENTS: Record<string, AgentEventType>;
export default agentBus;
