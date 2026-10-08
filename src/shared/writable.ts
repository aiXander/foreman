// What a page may write (pages plan P1b): the data files and drop directories its agent declared
// writable when it mounted the page, relative to the page's folder. Never code, so the page's
// behaviour changes only through the agent. Shared by the foreman_page check (mount time) and the
// page listener's PUT (write time).

/** Extensions a page may never write or create: they would change what the page does (SVG can carry script). */
export const CODE_EXT = /\.(html?|xhtml|svg|m?js|cjs|css|wasm)$/i;

/** A file a page creates directly inside a writable directory. */
const DROP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A path segment that is never served or written: empty, `.`/`..`, dot-prefixed, backslash or NUL. */
export const badSegment = (s: string) => s === "" || s.startsWith(".") || s.includes("\\") || s.includes("\0");

/**
 * Whether `rel` (decoded, "/"-separated, relative to the page's folder) is a declared writable file
 * or a well-named direct child of a declared writable directory (`"inbox/"`).
 */
export function writableCovers(writable: readonly string[], rel: string): boolean {
  const segs = rel.split("/");
  if (segs.some(badSegment) || CODE_EXT.test(rel)) return false;
  const parent = segs.slice(0, -1).join("/");
  return writable.some((w) => (w.endsWith("/") ? w.slice(0, -1) === parent && DROP_NAME.test(segs.at(-1)!) : w === rel));
}
