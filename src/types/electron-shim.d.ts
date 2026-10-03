/**
 * Ambient declaration for the `electron` module used by the self-hosted
 * browser host (`host-main.ts`). The electron package is an optional peer
 * dependency (present in desktop-shell environments), so it is not in
 * devDependencies; this shim keeps typechecking self-contained.
 * @module dsh-browser-plus/types/electron-shim
 */

declare module 'electron' {
  export interface WebContentsDebugger {
    attach(version: string): void
    detach(): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void
  }
  export interface DownloadItem {
    setSavePath(path: string): void
  }
  export interface Cookie {
    domain: string
    path: string
    secure: boolean
    httpOnly: boolean
    name: string
    value: string
    expirationDate?: number
  }
  export interface CookieSetter {
    url: string
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    expirationDate?: number
  }
  export interface WebRequestHeadersDetails {
    requestHeaders: Record<string, string>
  }
  export interface Session {
    once(event: 'will-download', listener: (event: Event, item: DownloadItem) => void): void
    setUserAgent(userAgent: string, acceptLanguages?: string): void
    fetch(url: string, options?: { signal?: AbortSignal }): Promise<{
      readonly ok: boolean
      readonly headers: { get(name: string): string | null }
      arrayBuffer(): Promise<ArrayBuffer>
    }>
    readonly webRequest: {
      onBeforeSendHeaders(listener: (details: WebRequestHeadersDetails, callback: (response: { requestHeaders: Record<string, string> }) => void) => void): void
    }
    readonly cookies: {
      get(filter: Record<string, unknown>): Promise<Cookie[]>
      set(details: CookieSetter): Promise<void>
      remove(url: string, name: string): Promise<void>
    }
  }
  export const session: {
    readonly defaultSession: Session
    fromPartition(partition: string, options?: Record<string, unknown>): Session
  }
  export interface NativeImage {
    resize(options: { width: number }): NativeImage
    toJPEG(quality: number): Buffer
    toPNG(): Buffer
    getSize(): { width: number; height: number }
  }
  export interface WebContents {
    readonly id: number
    readonly navigationHistory: {
      back(): void
      canGoBack(): boolean
      canGoForward(): boolean
      forward(): void
    }
    isDestroyed(): boolean
    getTitle(): string
    getZoomFactor(): number
    setZoomFactor(factor: number): void
    reload(): void
    stop(): void
    readonly debugger: WebContentsDebugger
    readonly session: Session
    close(): void
    downloadURL(url: string): void
    capturePage(): Promise<NativeImage>
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
    loadURL(url: string): Promise<void>
    getURL(): string
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void
    on(event: 'did-navigate' | 'did-navigate-in-page', listener: (event: unknown, url?: string) => void): this
    on(event: 'did-finish-load' | 'did-start-loading' | 'did-stop-loading' | 'page-title-updated', listener: () => void): this
    on(event: 'page-favicon-updated', listener: (event: unknown, favicons: string[]) => void): this
  }
  export interface WebContentsView {
    readonly webContents: WebContents
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    setVisible(visible: boolean): void
    setBackgroundColor(color: string): void
    getVisible(): boolean
    getBounds(): { x: number; y: number; width: number; height: number }
  }
  export interface BrowserWindow {
    readonly contentView: {
      addChildView(view: WebContentsView): void
      removeChildView(view: WebContentsView): void
      readonly children: WebContentsView[]
    }
    getBounds(): { x: number; y: number; width: number; height: number }
    getContentSize(): [number, number]
    setMenu(menu: unknown | null): void
    isVisible(): boolean
    isMinimized(): boolean
    isFocused(): boolean
    show(): void
    restore(): void
    focus(): void
    setTitle(title: string): void
    isDestroyed(): boolean
    on(event: 'closed', listener: () => void): this
    on(event: 'resize' | 'restore' | 'show' | 'maximize' | 'unmaximize', listener: () => void): this
    off(event: 'closed', listener: () => void): this
    off(event: 'resize', listener: () => void): this
  }
  export const app: {
    whenReady(): Promise<void>
    exit(code?: number): void
    /** Electron derives each view UA from this; assigning it is how the host masks. */
    userAgentFallback: string
    getLocale(): string
    getPath(name: string): string
    setPath(name: string, path: string): void
    dock?: { setIcon(path: string): void }
  }
  export interface BrowserWindowConstructor {
    new(options?: Record<string, unknown>): BrowserWindow
  }
  export interface WebContentsViewConstructor {
    new(options?: Record<string, unknown>): WebContentsView
  }
  export const BrowserWindow: BrowserWindowConstructor
  export const WebContentsView: WebContentsViewConstructor
}
