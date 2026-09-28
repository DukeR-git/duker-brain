/**
 * Pi extension entry point.
 *
 * Pi auto-discovers `<extension-dir>/index.ts`, and the repository root's `pi`
 * manifest lists this file, so `pi install` loads it. It only re-exports the
 * factory; see ./src/extension.ts.
 */

export { default } from "./src/extension.js";
