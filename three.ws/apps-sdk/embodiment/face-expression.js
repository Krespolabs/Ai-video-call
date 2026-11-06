// Re-export from the canonical implementation in src/embodiment so there is one
// FaceExpression class in the codebase, not two.  Any file that used to import
// from this path continues to work unchanged.
export { FaceExpression } from '../../src/embodiment/face-expression.js';
