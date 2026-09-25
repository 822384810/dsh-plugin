/**
 * Typography shared by every browser-side view of the plugin.
 *
 * The harness sets `body { font-family: var(--dsw-font-family, …) }` and exposes a fixed
 * size scale (`--dsw-font-xs-13-font-size` = 13px is the dense-panel step). Pinning our
 * sizes to those tokens instead of ad-hoc 11/12px keeps the panel reading as one surface
 * with the rest of DeepSeek Harness, across both light and dark themes.
 */

/** Harness UI typeface; falls back to the same stack the shell uses. */
export const FONT_FAMILY = 'var(--dsw-font-family)'

/** Monospace stack for code, schemas and the raw source viewer. */
export const FONT_CODE_FAMILY = 'var(--ds-font-family-code, monospace)'

/** Body and primary text; the harness `xs` step (13px). */
export const FONT_SIZE_BODY = 'var(--dsw-font-xs-13-font-size, 13px)'

/** Secondary and caption text; the harness `xxs` step (12px), pinned to the same token. */
export const FONT_SIZE_SMALL = 'var(--dsw-font-xxs-12-font-size, 12px)'

/**
 * Line heights that pair with the sizes above, taken from the harness type scale
 * (`--dsw-font-xs-13-line-height` = 20px at 13px, `--dsw-font-xxs-12-line-height` = 18px at 12px).
 * The harness applies these via the `font:` shorthand token; we set them explicitly because the
 * panel is hand-styled with inline `fontSize`, and without a line height text inherits the UA
 * default (~1.15), which reads visibly tighter than the rest of DeepSeek Harness.
 */
export const LINE_HEIGHT_BODY = 'var(--dsw-font-xs-13-line-height, 20px)'
export const LINE_HEIGHT_SMALL = 'var(--dsw-font-xxs-12-line-height, 18px)'

/**
 * Vertical rhythm for dense one-line list rows, matching the harness
 * `sessionRow` / `projectRow` (~32px tall: 20px line box + 6px above/below).
 * Harness ships no spacing-scale token, so we pin the same 6px/8px values it
 * uses directly in its `Rows.module.css` to keep the rows reading as one surface
 * with the rest of DeepSeek Harness. `ROW_PADDING_X12` keeps the wider 12px
 * horizontal gutter used by the Wiki/Schema header strips.
 */
export const ROW_PADDING = '6px 8px'
export const ROW_PADDING_X12 = '6px 12px'
