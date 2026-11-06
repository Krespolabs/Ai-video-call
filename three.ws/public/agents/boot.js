/**
 * Agents directory page — initialization and event handling.
 */

import { AgentsDirectory } from '../../src/agents-directory.js';

// A bare `?id=<uuid>` link points at a single agent — redirect to the
// canonical detail route (`/agents/<id>`) which renders the detail view.
// Without this the directory ignores `id` and shows an empty-looking list.
const idParam = new URLSearchParams(window.location.search).get('id');
if (idParam && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idParam)) {
  window.location.replace(`/agents/${idParam}`);
  // Halt the rest of the directory boot while the browser navigates away —
  // avoids a wasted list fetch and a flash of the empty directory.
  await new Promise(() => {});
}

const directory = new AgentsDirectory('#agents');

// Decode URL params
const urlParams = new URLSearchParams(window.location.search);
const initialChain = urlParams.get('chain') || 'all';
const initialSort = urlParams.get('sort') || 'newest';
const initialPage = parseInt(urlParams.get('page') || '1', 10);
const initialSearch = urlParams.get('search') || '';

// UI elements
const searchInput = document.getElementById('search');
const filterChips = document.querySelectorAll('.filter-chip');
const sortSelect = document.getElementById('sort');
const agentsContainer = document.getElementById('agents');
const emptyState = document.getElementById('empty-state');
// Default empty-state copy, captured before any error path rewrites it so the
// "no results" message can be restored after a failed load is retried.
const emptyDefaults = {
	title: emptyState?.querySelector('h2')?.textContent || 'No agents found',
	body: emptyState?.querySelector('p')?.textContent || 'Try a different filter or search.',
};
const loadingEl = document.getElementById('loading');
const paginationEl = document.getElementById('pagination');
const pageInfo = document.getElementById('page-info');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

let currentChain = initialChain;
let currentSort = initialSort;
let currentPage = initialPage;
let currentSearch = initialSearch;

/**
 * Update URL with current state.
 */
function updateUrl() {
	const params = new URLSearchParams();
	if (currentChain !== 'all') params.set('chain', currentChain);
	if (currentSort !== 'newest') params.set('sort', currentSort);
	if (currentPage !== 1) params.set('page', currentPage);
	if (currentSearch) params.set('search', currentSearch);

	const query = params.toString();
	const path = query ? `?${query}` : '';
	window.history.replaceState({}, '', `/agents/${path}`);
}

/**
 * Skeleton cards that mirror the real card layout (avatar + name/id + three
 * description lines) so the grid keeps its shape while data loads instead of
 * collapsing to a spinner.
 */
function skeletonCards(n = 8) {
	return Array.from({ length: n }, () => `
		<div class="agent-skel" aria-hidden="true">
			<div class="skel-head">
				<div class="skel skel-avatar"></div>
				<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:0.35rem">
					<div class="skel skel-line" style="width:70%"></div>
					<div class="skel skel-line" style="width:35%;height:0.6rem"></div>
				</div>
			</div>
			<div class="skel skel-line" style="width:100%"></div>
			<div class="skel skel-line" style="width:85%"></div>
			<div class="skel skel-line" style="width:55%"></div>
		</div>`).join('');
}

/**
 * Load and render agents.
 */
async function render() {
	loadingEl.style.display = 'block';
	agentsContainer.innerHTML = skeletonCards();
	agentsContainer.setAttribute('aria-busy', 'true');
	agentsContainer.style.display = 'grid';
	emptyState.style.display = 'none';
	paginationEl.style.display = 'none';

	try {
		const result = await directory.load({
			chain: currentChain,
			search: currentSearch,
			sort: currentSort,
			page: currentPage,
		});

		hideRetry();
		agentsContainer.removeAttribute('aria-busy');
		if (result.agents.length === 0) {
			agentsContainer.innerHTML = '';
			emptyState.querySelector('h2').textContent = emptyDefaults.title;
			emptyState.querySelector('p').textContent = emptyDefaults.body;
			emptyState.style.display = 'block';
			loadingEl.style.display = 'none';
			return;
		}

		directory.render();
		loadingEl.style.display = 'none';
		agentsContainer.style.display = 'grid';

		// Update pagination
		const { hasNextPage, hasPrevPage, page, totalPages } = directory.getPaginationInfo();
		pageInfo.textContent = `Page ${page} of ${totalPages}`;
		prevBtn.disabled = !hasPrevPage;
		nextBtn.disabled = !hasNextPage;
		paginationEl.style.display = 'flex';

		// Scroll to top
		window.scrollTo({ top: 0, behavior: 'smooth' });
	} catch (err) {
		console.error('Failed to load agents:', err);
		loadingEl.style.display = 'none';
		agentsContainer.removeAttribute('aria-busy');
		agentsContainer.innerHTML = '';
		emptyState.style.display = 'block';
		emptyState.querySelector('h2').textContent = 'Error loading agents';
		emptyState.querySelector('p').textContent = err.message || 'Please try again later.';
		showRetry();
	}
}

// Actionable error recovery: a Retry button inside the empty-state that re-runs
// the load. Created once and reused; hidden on any successful render so it never
// lingers over real results.
function showRetry() {
	let btn = document.getElementById('empty-retry');
	if (!btn) {
		btn = document.createElement('button');
		btn.id = 'empty-retry';
		btn.type = 'button';
		btn.className = 'btn-primary';
		btn.textContent = 'Retry';
		btn.style.marginTop = '16px';
		btn.addEventListener('click', () => { render(); });
		emptyState.appendChild(btn);
	}
	btn.style.display = 'inline-flex';
}

function hideRetry() {
	const btn = document.getElementById('empty-retry');
	if (btn) btn.style.display = 'none';
}

/**
 * Handle card clicks.
 */
directory.onCardClick((agent) => {
	window.location.href = `/a/${agent.chainId}/${agent.id}`;
});

// Search input
searchInput.value = currentSearch;
searchInput.addEventListener('input', (e) => {
	currentSearch = e.target.value;
	currentPage = 1;
	updateUrl();
	render();
});

// Filter chips
filterChips.forEach((chip) => {
	const filter = chip.dataset.filter;
	if (filter === currentChain) {
		chip.classList.add('active');
	}
	chip.addEventListener('click', () => {
		filterChips.forEach((c) => c.classList.remove('active'));
		chip.classList.add('active');
		currentChain = filter;
		currentPage = 1;
		updateUrl();
		render();
	});
});

// Sort select
sortSelect.value = currentSort;
sortSelect.addEventListener('change', (e) => {
	currentSort = e.target.value;
	currentPage = 1;
	updateUrl();
	render();
});

// Pagination
prevBtn.addEventListener('click', () => {
	if (currentPage > 1) {
		currentPage--;
		updateUrl();
		render();
	}
});

nextBtn.addEventListener('click', () => {
	const info = directory.getPaginationInfo();
	if (currentPage < info.totalPages) {
		currentPage++;
		updateUrl();
		render();
	}
});

// Initial render
render();
