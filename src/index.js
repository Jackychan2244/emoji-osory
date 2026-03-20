export {
  analyzeFingerprint,
  buildSentinelProfile,
  detectUnicodeVersion,
} from "./core/analysis.js";
export { inferOsFamilyHints, getVendorFamily } from "./core/environment.js";
export {
  createEmojiIdentifier,
  materializeCodepoints,
} from "./core/materialize.js";
