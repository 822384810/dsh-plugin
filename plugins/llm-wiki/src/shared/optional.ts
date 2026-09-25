/**
 * Loading packages the plugin treats as optional.
 *
 * Document parsing (PDF, DOCX), OCR, embedding models and directory watching all pull in
 * large — sometimes native — packages. None of them is required: a library built from
 * Markdown and text files works without any of them, and a missing one degrades one
 * capability instead of taking the plugin down. They are therefore not declared as
 * dependencies, and are resolved from wherever the running profile keeps them.
 *
 * The specifier is passed through `new Function` so that bundlers leave the import alone:
 * these modules must stay external, and a literal `import()` would either be inlined or fail
 * the build when the package is absent.
 */

/** Import a specifier the bundler must not try to resolve or inline. */
const importExternal = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

/**
 * Load an optional package.
 * @param specifier - Package or entry point to load.
 * @returns The module namespace (or its CJS `default`), or null when it cannot be loaded.
 */
export async function importOptional<T>(specifier: string): Promise<T | null> {
  try {
    const loaded = await importExternal(specifier) as { default?: T } & T
    return loaded.default === undefined ? loaded : loaded.default
  } catch {
    return null
  }
}
