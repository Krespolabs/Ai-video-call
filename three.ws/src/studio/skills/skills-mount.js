/**
 * Skills Studio — mount bootstrap (P5)
 * ====================================
 * Binds the Skills Studio to the Agent Studio shell's Skills tab on
 * `studio-shell:ready`. Mirrors P1–P4 mounts: idempotent and order-independent.
 *
 * The agent-studio page loads this alongside the shell:
 *   <script type="module" src="/src/studio/skills/skills-mount.js"></script>
 */

import { studio } from '../agent-studio-store.js';
import { mountSkillsStudio } from './skills-studio.js';

const SELECTOR = '[data-studio-mount="skills"]';

function mount() {
	const panel = document.querySelector(SELECTOR);
	if (!panel || panel.dataset.skillsMounted) return false;
	mountSkillsStudio(panel, { studio });
	return true;
}

document.addEventListener('studio-shell:ready', mount, { once: false });

if (!mount()) {
	let tries = 0;
	const t = setInterval(() => {
		if (mount() || ++tries > 60) clearInterval(t); // ~6s ceiling
	}, 100);
}
