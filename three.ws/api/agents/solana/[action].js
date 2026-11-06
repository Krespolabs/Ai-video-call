import { wrap, error } from '../../_lib/http.js';
import {
	handleAttestations,
	handleAttestEvent,
	handleCard,
	handleCollectionMetadata,
	handleEdit,
	handleMetadata,
	handlePriceHistory,
	handleRegistrationCard,
	handleRegisterPrep,
	handleRegisterConfirm,
	handleReputation,
	handleReputationHistory,
	handleSkillCollectionMetadata,
	handleSkillNftMetadata,
	handleValidate,
	handleValidation,
} from './_handlers.js';

export {
	taskHash,
	buildPayload,
	verifyPumpkitSignature,
} from './_handlers.js';

const DISPATCH = {
	attestations:        handleAttestations,
	'attest-event':      handleAttestEvent,
	card:                handleCard,
	'collection-metadata': handleCollectionMetadata,
	edit:                handleEdit,
	metadata:            handleMetadata,
	'price-history':     handlePriceHistory,
	'registration-card': handleRegistrationCard,
	'register-prep':     handleRegisterPrep,
	'register-confirm':  handleRegisterConfirm,
	reputation:          handleReputation,
	'reputation-history': handleReputationHistory,
	'skill-collection-metadata': handleSkillCollectionMetadata,
	'skill-nft-metadata': handleSkillNftMetadata,
	validate:            handleValidate,
	validation:          handleValidation,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').searchParams.get('action');
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown action: ${action}`);
	return fn(req, res);
});
