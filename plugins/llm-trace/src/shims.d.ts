/**
 * Type shim for the harness package this plugin imports at runtime. It resolves from the
 * profile (`$DSH_HOME/profiles/node_modules`), so the package needs no install-time dependency
 * on the harness checkout.
 */
declare module '@deepseek-ai/dsh-home-paths' {
  /**
   * Join path segments under the Harness home (`$DSH_HOME`, default `~/.dsh`).
   * @param segments - Path segments below the home.
   * @returns The absolute path.
   */
  export function dshHomePath(...segments: string[]): string
}
