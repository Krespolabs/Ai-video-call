// Type definitions for @three-ws/tour

export declare const VERSION: string;

/** A selectable view over the curriculum's stops. */
export interface TourTrack {
	id: string;
	title: string;
	description?: string;
	stopCount?: number;
	estimatedMinutes?: number;
}

/** A chapter header; stops reference it by `id`. */
export interface TourSection {
	id: string;
	title: string;
	/** Spoken bridge said when the guide first enters this chapter. */
	intro?: string;
}

/** One feature the guide visits. */
export interface TourStop {
	id?: string;
	/** Route the stop lives on, e.g. "/pricing". */
	path: string;
	/** Section id this stop belongs to. */
	section?: string;
	/** Short feature name shown in the chapter map. */
	title?: string;
	/** The line the guide speaks at this stop. */
	narration: string;
	/** Whether this stop is part of the Quick-highlights track. */
	highlight?: boolean;
	/** Spoken once before this stop as the chapter's bridge. */
	sectionIntro?: string;
	/** Ordered CSS selectors for the element to spotlight; first visible wins. */
	targets?: string[];
}

/** The document that drives a tour. See curriculum.schema.json. */
export interface TourCurriculum {
	version?: number;
	generatedAt?: string;
	generatedBy?: string;
	title?: string;
	tagline?: string;
	estimatedMinutes?: number;
	stopCount?: number;
	tracks?: TourTrack[];
	sections?: TourSection[];
	stops: TourStop[];
}

/** A narration voice offered in the chapter panel's picker. */
export interface TourVoice {
	id: string;
	name: string;
}

/** Closing/recovery copy. Every field is overridable. */
export interface TourCopy {
	outro?: string;
	offRoute?: string;
	completion?: {
		title?: string;
		body?: string;
		primary?: { label: string; href: string } | null;
		restartLabel?: string;
		closeLabel?: string;
	};
}

/** Walk-companion de-dupe integration. */
export interface CompanionConfig {
	/** Global object the companion is exposed through (default "__walkCompanion"). */
	global?: string;
	/** Event the companion dispatches on mount/unmount (default "walk-companion:change"). */
	changeEvent?: string;
}

/** Options accepted by createFeatureTour / resolveTourConfig. */
export interface TourOptions {
	/** URL to fetch the curriculum from, or an already-loaded curriculum object. */
	curriculum?: string | TourCurriculum;
	/**
	 * POST endpoint that turns `{ text, voice, speed, format }` into an audio
	 * response. When omitted, narration plays as silent captions paced to the text.
	 */
	ttsEndpoint?: string | null;
	defaultVoice?: string;
	voices?: TourVoice[];
	/**
	 * 'guided' (default) — the avatar walks itself and narrates.
	 * 'explore' — the visitor drives the avatar to glowing checkpoints.
	 * 'platformer' — explore with gravity and jumping: the page's real DOM is
	 * solid ground. Visitors can switch explore/platformer live with the M key.
	 */
	mode?: 'guided' | 'explore' | 'platformer';
	guideAvatarId?: string;
	assetBase?: string;
	apiBase?: string;
	manifestUrl?: string;
	avatarStorageKey?: string;
	/** How to move to another route (default: location.assign). */
	navigate?: (path: string) => void;
	/** Query param that opens the tour (default "tour"). */
	deepLinkParam?: string;
	/** Walk-companion integration. `false` disables it. */
	companion?: boolean | CompanionConfig;
	/** Prefix for tour state storage keys (default "tws:tour"). */
	storagePrefix?: string;
	copy?: TourCopy;
}

/** The fully-resolved config the engine runs on. */
export interface ResolvedTourConfig {
	curriculum: string | TourCurriculum;
	ttsEndpoint: string | null;
	defaultVoice: string;
	voices: TourVoice[];
	mode: 'guided' | 'explore' | 'platformer';
	guideAvatarId: string;
	assetBase: string;
	apiBase: string;
	manifestUrl: string;
	avatarStorageKey: string;
	navigate: (path: string) => void;
	deepLinkParam: string;
	companion: { global: string; changeEvent: string } | null;
	copy: Required<TourCopy>;
	keys: { state: string; resume: string };
}

/** The controller returned by createFeatureTour. */
export interface FeatureTour {
	readonly director: TourDirector | null;
	readonly config: ResolvedTourConfig;
	/** True if a tour is currently active (persisted in sessionStorage). */
	isActive(): boolean;
	/** Begin a fresh tour. `track` defaults to "full". */
	start(track?: string): Promise<void>;
	/** Re-hydrate an in-progress tour after a page navigation. */
	resume(): Promise<void>;
	/** Tear everything down. */
	exit(): void;
	/** Honour the deep-link query param and rehydrate. Safe to call once on load. */
	bootstrap(): void;
}

/** Cross-page tour state bound to a config's storage keys. */
export interface TourState {
	readState(): Record<string, unknown>;
	writeState(patch: Record<string, unknown>): Record<string, unknown>;
	clearState(): void;
	readResume(): Record<string, unknown>;
	writeResume(patch: Record<string, unknown>): Record<string, unknown>;
	markCompleted(): void;
}

/** Create a tour controller. */
export declare function createFeatureTour(options?: TourOptions): FeatureTour;

/** The tour engine. createFeatureTour wraps this; use directly for full control. */
export declare class TourDirector {
	constructor(config?: TourOptions | ResolvedTourConfig);
	readonly config: ResolvedTourConfig;
	start(track?: string): Promise<void>;
	resume(): Promise<void>;
	exit(): void;
}

export declare function resolveTourConfig(opts?: TourOptions): ResolvedTourConfig;
export declare const DEFAULT_VOICES: TourVoice[];
export declare const DEFAULT_COPY: Required<TourCopy>;

export declare function loadCurriculum(config: { curriculum?: string | TourCurriculum }): Promise<TourCurriculum>;
export declare function createTourState(config: ResolvedTourConfig): TourState;
export declare function buildPlaylist(curriculum: TourCurriculum, track?: string): number[];
export declare function trackMeta(curriculum: TourCurriculum, track?: string): TourTrack | null;
export declare function stopIndexForPath(curriculum: TourCurriculum, pathname?: string): number;
export declare function sectionTitle(curriculum: TourCurriculum, id: string): string;
export declare function normalizePath(pathname?: string): string;

/** Options for buildCurriculum. */
export interface BuildCurriculumOptions {
	sectionOrder?: string[];
	sectionIntros?: Record<string, string>;
	sectionHeroes?: Record<string, string[]>;
	targets?: Record<string, string[]>;
	deny?: string[];
	denyPrefix?: string[];
	skipAuthRequired?: boolean;
	quickPerSection?: number;
	connectors?: string[];
	title?: string;
	tagline?: string;
	wpm?: number;
	stopOverheadS?: number;
}

/** A page in the input document buildCurriculum consumes. */
export interface PageEntry {
	path: string;
	title?: string;
	description?: string;
	added?: string;
	auth?: string;
	[key: string]: unknown;
}

/** The input document buildCurriculum consumes. */
export interface PagesDocument {
	sections: Array<{ id: string; title?: string; pages: PageEntry[] }>;
}

/** Turn a pages document into a tour curriculum. */
export declare function buildCurriculum(
	pagesDoc: PagesDocument,
	opts?: BuildCurriculumOptions,
): TourCurriculum;
