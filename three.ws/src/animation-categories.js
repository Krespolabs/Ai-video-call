// Category classifier for the full motion library.
//
// The Mixamo catalog ships no category metadata (every product's `category` is
// an empty string), so the /animations gallery derives one from the clip label.
// Rules are ordered — the first match wins — because labels routinely span
// several concepts ("Zombie Walk" is a zombie clip, not locomotion; "Rifle Run"
// is a weapons clip). Curated studio clips keep their hand-assigned category
// from animation-presets.js; this module is the fallback for everything else.
//
// Used by src/animations-gallery.js (filter chips) and covered by
// tests/animation-categories.test.js.

import { categoryOf as curatedCategoryOf } from './animation-presets.js';

/** Ordered gallery categories. `key` is stable (URL state); label/icon are UI. */
export const GALLERY_CATEGORIES = [
	{ key: 'idle', label: 'Idle', icon: '🧍' },
	{ key: 'locomotion', label: 'Locomotion', icon: '🚶' },
	{ key: 'dance', label: 'Dance', icon: '💃' },
	{ key: 'combat', label: 'Combat', icon: '🥊' },
	{ key: 'weapons', label: 'Weapons', icon: '🏹' },
	{ key: 'sport', label: 'Sports', icon: '⚽' },
	{ key: 'acrobatics', label: 'Acrobatics', icon: '🤸' },
	{ key: 'gesture', label: 'Gestures', icon: '👋' },
	{ key: 'reaction', label: 'Reactions', icon: '😲' },
	{ key: 'death', label: 'Deaths & Falls', icon: '💀' },
	{ key: 'sit', label: 'Sit & Lie', icon: '🪑' },
	{ key: 'fitness', label: 'Fitness', icon: '🏋️' },
	{ key: 'interaction', label: 'Interaction', icon: '📦' },
	{ key: 'creature', label: 'Creature', icon: '🧟' },
	{ key: 'farming', label: 'Farming', icon: '🌱' },
	{ key: 'more', label: 'More', icon: '✨' },
];

// Curated studio keys that differ from gallery keys.
const CURATED_KEY_MAP = { action: 'combat' };

// First match wins. Keep creature/weapons/dance ahead of movement words so
// "Zombie Run", "Pistol Walk", "Swing Dancing" land where a human would file them.
const RULES = [
	['creature', /\bzombie|mutant|goblin|orc|monster|creature|werewolf|vampire\b/],
	[
		'weapons',
		/\brifle|pistol|gun(?!ner)|shoot|firing|reload|sword|katana|saber|blade|bow(?:\s|$)|arrow|archer|shield|axe|spear|knife|dagger|grenade|toss grenade|machine ?gun|shotgun|sniper|crossbow|great ?sword|mace|staff|halberd|musket|revolver|holster|unsheathe|sheathe?\b/,
	],
	[
		'dance',
		/\bdanc|breakdance|hip ?hop|salsa|samba|rumba|swing|twist(?!ing torso)|shuffl|twerk|ballet|bboy|b-boy|robot(?:ic)? dance|macarena|charleston|cabbage patch|gangnam|moonwalk|locking|popping|krump|house dance|tut(?:ting)?|wave dance|belly ?dance|flair|footwork|thriller|disco|cancan|can-can\b/,
	],
	[
		'sport',
		/\bsoccer|football|goalkeeper|goalie|basketball|baseball|golf|tennis|volleyball|bowling|boxing bag|dribbl|free throw|penalty|header|batting|pitch(?:ing)?\b|catcher|quarterback|touchdown|swim|ski(?:ing)?\b|skat(?:e|ing)|surf|climb(?:ing)? (?:rope|ladder|wall)|baseball/,
	],
	[
		'acrobatics',
		/\bflip|cartwheel|handstand|somersault|gymnast|aerial|backflip|front ?flip|tumbl|vault|parkour|freerun|breakfall|roll(?:ing)? (?:forward|backward|left|right)|kip[- ]?up|braced hang|hang(?:ing)? (?:from|drop)\b/,
	],
	[
		'death',
		/\bdeath|dying|die[sd]?\b|falling(?! to roll)|fall(?:s)? (?:over|down|back|flat)|knocked (?:out|down)|collaps|defeat|shot (?:to|in) |flying back|face ?plant|drop dead|ko\b|unconscious\b/,
	],
	[
		'combat',
		/\bpunch|kick|jab|hook(?:ing)?\b|uppercut|boxing|mma|martial|karate|kung ?fu|taekwondo|muay ?thai|fight|attack|combo|block(?:ing)?\b|dodge|parry|counter|elbow|knee strike|headbutt|brawl|melee|spar(?:ring)?|cross punch|roundhouse|haymaker|takedown|chokehold|wrestl|capoeira|body blow|leg sweep|spell|casting|magic\b/,
	],
	[
		'reaction',
		/\breaction|react(?:ing|s)?\b|hit (?:to|by|from)|receiving|getting (?:hit|clipped|shoved|pushed)|shoved|stagger|stumbl|stunned|dazed|shocked|surprised|scared|terrified|flinch|dodg(?:e|ing) reaction|pain|hurt|electrocut|sneez|shiver|drunk\b/,
	],
	[
		'sit',
		/\bsit(?:ting|s)?\b|laying|lying|lie (?:down|on)|sleep|nap\b|crouch(?:ed|ing)? idle|kneel|stand(?:ing)? (?:up )?from (?:ground|chair|sit)|chair\b|seated|couch|floor idle\b/,
	],
	[
		'fitness',
		/\byoga|plank|push ?up|sit ?up|pull ?up|squat|burpee|jumping jacks|exercis|workout|stretch|warm ?up|lunge|crunch|air squat|treadmill|downward dog|downdog\b/,
	],
	[
		'farming',
		/\bfarm|dig(?:ging)?\b|plant(?:ing)?\b|water(?:ing)? (?:can|plant)|harvest|milk(?:ing)?\b|hoe\b|rake|shovel|sow(?:ing)?\b|fishing\b/,
	],
	[
		'gesture',
		/\bwav(?:e|ing)|clap|point(?:ing)?\b|thumbs|salute|bow(?:ing)\b|greet|hello|goodbye|talk(?:ing)?|yell(?:ing)?|shout|argu|agree|disagree|nod|shak(?:e|ing) head|counting|whatever|shrug|taunt|cheer|celebrat|excited|happy|joy|angry|frustrat|sad\b|cry(?:ing)?|laugh|facepalm|pray(?:ing)?|kiss|blow(?:ing)? kiss|look(?:ing)? (?:around|behind|down|up|over)|listening|smoking|call(?:ing)? ?(?:me|out)?\b|whistl|hand ?signal|beckon|clapping|golf clap|air guitar|conduct(?:ing|or)|gestur|asking|shaking hands|handshake|roar|fist on table|acknowledg\b/,
	],
	[
		'idle',
		/\bidle|waiting|breath(?:ing)?|stand(?:ing)?(?: (?:w|around|by|pose|relaxed))?$|bored|impatient|lean(?:ing)?\b|chilling|relax|thinking|pondering|bashful|nervous(?:ly)?|weight shift|arms? (?:down|raised|behind|resting|slightly|spread|supporting|crossed)|pose\b/,
	],
	[
		'interaction',
		/\bcarry|lift(?:ing)?|pick(?:ing)? ?up|put(?:ting)? ?down|push(?:ing)?\b|pull(?:ing)?\b|open(?:ing)?\b|clos(?:e|ing)\b|door|button|lever|drink|eat(?:ing)?|\bphone\b|\btyp(?:e|ing)\b|keyboard|search(?:ing)?|inspect|grab(?:bing)?|throw(?:ing)?|toss(?:ing)?|catch(?:ing)?\b|hold(?:ing)?\b|torch|box(?:es)?\b|object|crate|drag(?:ging)?|hand ?off|give|take|steal|pay(?:ing)?|swipe|cpr|carried|carrying|picked up|placed|hostage|dice\b/,
	],
	[
		'locomotion',
		/\bwalk|run(?:ning|s)?\b|jog|sprint|strafe|sneak|crawl|crouch|turn(?:ing)?\b|step(?:ping)?\b|jump|hop(?:ping)?\b|leap|skip(?:ping)?\b|climb|ladder|stairs?\b|swimming|treading|dive|vault|slide|start (?:walking|running)|stop (?:walking|running)|pivot|u-turn|backpedal|march|patrol|wander|limp|injured walk|balanc(?:e|ing)|tip ?toe|zigzag|circle\b|left|right|forward|backward/,
	],
];

/**
 * Classify a clip into a gallery category key.
 *
 * @param {string} name  manifest clip name (e.g. "av-boxer-dance", "mx-…")
 * @param {string} label human label (e.g. "135 Degree Left Turn")
 * @returns {string} a GALLERY_CATEGORIES key
 */
export function galleryCategoryOf(name, label) {
	const curated = curatedCategoryOf(name);
	if (curated && curated !== 'more') return CURATED_KEY_MAP[curated] || curated;
	const text = String(label || name || '').toLowerCase();
	for (const [key, re] of RULES) {
		if (re.test(text)) return key;
	}
	return 'more';
}
