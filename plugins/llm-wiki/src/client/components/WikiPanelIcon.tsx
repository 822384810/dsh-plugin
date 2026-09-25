/** Sidebar glyph for the knowledge-base panel; the sidebar owns the button and the label. */
import type { ReactElement } from 'react'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the panel icon at the size the sidebar asks for.
 * @param props - Requested square edge and whether the panel is selected.
 * @returns The glyph.
 */
export function WikiPanelIcon({ size = 18 }: { size?: number; active?: boolean }): ReactElement {
  return <IconDatabaseOutlineRegular size={size} aria-hidden="true" />
}
