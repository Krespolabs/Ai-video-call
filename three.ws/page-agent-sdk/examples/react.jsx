/**
 * @three-ws/page-agent — React integration example
 * ================================================
 * A reusable hook + component. Requires a bundler (Vite, Next, CRA) with:
 *
 *     npm install @three-ws/page-agent three
 *
 * See docs/guide-frameworks.md for Next.js (SSR), Vue, Svelte, and more.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { PageAgent } from '@three-ws/page-agent';

/**
 * Owns a single PageAgent for the component's lifetime.
 * Construct ONCE — change the avatar/narration via methods, not by re-rendering.
 */
export function usePageAgent(config = {}) {
	const ref = useRef(null);
	const [agent, setAgent] = useState(null);

	useEffect(() => {
		// PageAgent is browser-only; useEffect never runs on the server.
		const guide = new PageAgent(config);
		ref.current = guide;
		setAgent(guide);
		return () => {
			guide.dispose();      // free the WebGL context + speech queue on unmount
			ref.current = null;
		};
		// Construct once for the component's lifetime — deps intentionally empty.
		// (In a React project with the react-hooks plugin, this is the expected
		// "create on mount, dispose on unmount" pattern.)
	}, []);

	return agent;
}

/**
 * Drop-in guide. Renders nothing itself — the agent docks to <body>.
 * Exposes a few props that map to imperative calls after mount.
 */
export function Guide({ avatar = 'sol', autoNarrate = true, onSegment, onReady }) {
	const guide = usePageAgent({ agent: avatar, autoNarrate });

	useEffect(() => {
		if (!guide) return;
		if (onReady) guide.on('ready', onReady);
		if (onSegment) guide.on('segment', onSegment);
		return () => {
			if (onReady) guide.off('ready', onReady);
			if (onSegment) guide.off('segment', onSegment);
		};
	}, [guide, onReady, onSegment]);

	// Keep the live avatar in sync if the prop changes.
	useEffect(() => { guide?.setAgent(avatar); }, [guide, avatar]);

	return null;
}

/* ----------------------------------------------------------------------------
 * Example usage
 * ------------------------------------------------------------------------- */

export default function App() {
	const guide = usePageAgent({ agent: 'nova', autoNarrate: true });

	const explain = useCallback(
		(text) => () => guide?.narrate(text, { interrupt: true }),
		[guide],
	);

	return (
		<main>
			<h1 data-narrate="Welcome to the dashboard — here's where your day starts.">
				Dashboard
			</h1>

			<button onClick={explain('This button saves a draft without publishing.')}>
				What does Save do?
			</button>

			<button onClick={() => guide?.narratePage({ greet: true })}>
				Take the tour
			</button>

			<button onClick={() => guide?.openPicker()}>Change guide</button>
			<button onClick={() => guide?.stop()}>Stop</button>
		</main>
	);
}

/*
 * Or the declarative component form:
 *
 *   import { Guide } from './react.jsx';
 *   <Guide avatar="vera" autoNarrate onSegment={({ text }) => console.log(text)} />
 */
