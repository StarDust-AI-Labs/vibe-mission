// TaskPier core — task identity formatting/parsing (the single source for the
// `tp-` display id and the `#N` shorthand). Store derives displayId here,
// tools/board parse user input here. Zero-dependency by design.
//
// Formats:
//   displayId  tp-0007          canonical interface/board token (4-digit padded)
//   hashRef    #7 / #0007       human shorthand (chat unpadded, board padded)

const PAD_WIDTH = 4;

/** @param {number} id @returns {string} e.g. "tp-0007" */
export function formatDisplayId(id) {
  return `tp-${String(id).padStart(PAD_WIDTH, '0')}`;
}

/**
 * @param {number} id
 * @param {{padded?: boolean}} [opts] padded → "#0007" (board), else "#7" (chat)
 * @returns {string}
 */
export function formatHashRef(id, { padded = false } = {}) {
  return `#${padded ? String(id).padStart(PAD_WIDTH, '0') : String(id)}`;
}

/**
 * Parse any accepted task reference into a positive integer id.
 * Accepts: "tp-12" | "tp-0012" | "#12" | "#0012" | "12" | 12.
 * @param {string|number} ref
 * @returns {number|null} null when the input is not a task reference
 */
export function parseTaskRef(ref) {
  const m = /^(?:tp-|#)?0*(\d+)$/.exec(String(ref).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
