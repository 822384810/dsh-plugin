/**
 * Type shims for the packages this plugin resolves at run time rather than install time.
 *
 * The browser platform module comes from the harness module table; the optional document parsers
 * are deliberately not declared as dependencies so that a knowledge base still works without them,
 * and are therefore only typed to the surface actually used.
 */

/** Minimum supported host release, injected by the build from the `@deepseek-ai/dsh` peer floor. */
declare const __MINIMUM_HOST_VERSION__: string

/**
 * Minimal surface of `@deepseek-ai/dsh-client-ui-primitives` this plugin renders with.
 *
 * It is a baseline platform module resolved by the browser module table at run time, so only
 * the props this plugin actually passes are declared here. Styling comes entirely from the
 * primitive's own design tokens, which is what keeps the panel consistent with the rest of
 * the UI.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  /** Button visual family. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  /** Token-styled button atom. */
  export function Button(
    props: ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: ButtonVariant
      size?: 'md' | 'sm'
      icon?: ReactNode
      className?: string | undefined
    },
  ): ReactElement

  /** Controlled native checkbox with a caller-owned visible and accessible label. */
  export function Checkbox(props: {
    checked: boolean
    onChange: (checked: boolean) => void
    label: ReactNode
    disabled?: boolean
    title?: string
    className?: string | undefined
  }): ReactElement

  /** Single-line text input atom. */
  export function Input(
    props: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; className?: string | undefined },
  ): ReactElement

  /** Centered, body-portaled modal with a mask. */
  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel: string
    description?: string | undefined
    children?: ReactNode
    footer?: ReactNode
    className?: string | undefined
    contentClassName?: string | undefined
  }): ReactElement

  /** Labels the markdown renderer needs for its copy button and footnote section. */
  export interface MarkdownLabels {
    code: { copyLabel: string; copiedLabel: string }
    footnotes: string
  }

  /** Token-styled markdown renderer. */
  export function MarkdownText(props: {
    text: string
    streaming?: boolean
    labels: MarkdownLabels
    variant?: 'body' | 'compact'
  }): ReactElement

  export const IconPlusOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconTrashOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconRefreshOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconSearchOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconCloseOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconFolderCloseRegular: ComponentType<{ size?: number; className?: string }>
  export const IconFolderOpenRegular: ComponentType<{ size?: number; className?: string }>
  export const IconEditOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconCheckOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconDownloadOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconPaperclipOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconWarningOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconDatabaseOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconThinkOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconBrowseOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconListPenOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconLinkOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconChevronDownOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconChevronRightOutlineRegular: ComponentType<{ size?: number; className?: string }>
}

/** Minimal surface of `mammoth`, loaded only when a `.docx` is ingested. */
declare module 'mammoth' {
  export interface MammothResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  export const images: {
    imgElement(handler: (element: unknown) => Promise<{ src: string }>): unknown
  }
  export function convertToHtml(
    input: { path?: string; buffer?: ArrayBuffer | Buffer; arrayBuffer?: ArrayBuffer },
    options?: Record<string, unknown>,
  ): Promise<MammothResult>
}

/** Minimal surface of `pdfjs-dist`'s legacy build, loaded only when a `.pdf` is ingested. */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PdfTextItem {
    str: string
    transform: number[]
  }
  export interface PdfViewport {
    width: number
    height: number
  }
  export interface PdfRenderTask {
    promise: Promise<void>
  }
  export interface PdfPage {
    getTextContent(): Promise<{ items: PdfTextItem[] }>
    getViewport(params: { scale: number }): PdfViewport
    /** Present only when a canvas backend (e.g. `@napi-rs/canvas`) is available. */
    render(params: { canvasContext: unknown; viewport: PdfViewport }): PdfRenderTask
  }
  export interface PdfDocument {
    numPages: number
    getPage(index: number): Promise<PdfPage>
  }
  export interface PdfLoadingTask {
    promise: Promise<PdfDocument>
    destroy(): Promise<void>
  }
  export function getDocument(options: {
    data: Uint8Array
    isEvalSupported?: boolean
    verbosity?: number
  }): PdfLoadingTask
}

/** Minimal surface of `@napi-rs/canvas`, used to rasterize a scanned PDF for OCR. */
declare module '@napi-rs/canvas' {
  /** Pixel access, used to erase the rules a table is drawn with before OCR. */
  export interface CanvasImageData { readonly data: Uint8ClampedArray }
  export interface CanvasContext2d {
    getImageData(x: number, y: number, width: number, height: number): CanvasImageData
    putImageData(image: CanvasImageData, x: number, y: number): void
  }
  export interface Canvas {
    width: number
    height: number
    getContext(type: '2d'): CanvasContext2d
    toBuffer(mime: 'image/png'): Buffer
  }
  export function createCanvas(width: number, height: number): Canvas
}

/** Minimal surface of `tesseract.js`, loaded only to OCR a scanned PDF. */
declare module 'tesseract.js' {
  export interface TesseractBBox {
    readonly x0: number
    readonly y0: number
    readonly x1: number
    readonly y1: number
  }
  export interface TesseractWord {
    readonly text: string
    readonly bbox: TesseractBBox
  }
  export interface TesseractLine {
    readonly text: string
    readonly words: readonly TesseractWord[]
  }
  export interface TesseractParagraph { readonly lines: readonly TesseractLine[] }
  export interface TesseractBlock { readonly paragraphs: readonly TesseractParagraph[] }
  /** One recognized page; the block tree carries the layout the flat `text` has already lost. */
  export interface TesseractPage {
    readonly text: string
    readonly blocks: readonly TesseractBlock[] | null
  }
  export interface TesseractWorker {
    recognize(
      image: Buffer | Uint8Array,
      options?: Record<string, unknown>,
      output?: { readonly text?: boolean; readonly blocks?: boolean },
    ): Promise<{ data: TesseractPage }>
    terminate(): Promise<void>
  }
  export function createWorker(
    langs?: string,
    oem?: number,
    options?: Record<string, unknown>,
  ): Promise<TesseractWorker>
}

/** Minimal surface of `iconv-lite`, loaded only for non-UTF-8 sources. */
declare module 'iconv-lite' {
  export function decode(buffer: Buffer, encoding: string): string
}

/** Minimal surface of `jschardet-ultra`, loaded only for non-UTF-8 sources. */
declare module 'jschardet-ultra' {
  export function detect(buffer: Buffer): { encoding: string | null; confidence: number }
}

/** Minimal surface of `chokidar`, loaded only when directory watching is enabled. */
declare module 'chokidar' {
  export interface FSWatcher {
    on(event: string, listener: (path: string) => void): FSWatcher
    close(): Promise<void>
  }
  export function watch(paths: string, options?: Record<string, unknown>): FSWatcher
}
