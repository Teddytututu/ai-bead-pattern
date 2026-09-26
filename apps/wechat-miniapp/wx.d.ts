import type { WxTransport } from '../../packages/wechat-client/dist/index.js'
declare global {
  function App(options: object): void
  function Page<T>(options: T & ThisType<T & { setData(value: Record<string, unknown>, callback?: () => void): void }>): void
  function setTimeout(callback: () => void, milliseconds: number): number
  function clearTimeout(id: number): void
  interface CanvasContext {
    clearRect(x: number, y: number, width: number, height: number): void
    setFillStyle(color: string): void
    fillRect(x: number, y: number, width: number, height: number): void
    draw(): void
  }
  const wx: WxTransport & {
    getStorageSync(key: string): unknown
    setStorageSync(key: string, value: unknown): void
    removeStorageSync(key: string): void
    chooseMedia(options: { count: number; mediaType: string[]; sizeType: string[]; success: (value: { tempFiles: { tempFilePath: string }[] }) => void; fail: () => void }): void
    showToast(options: { title: string; icon: string }): void
    showModal(options: { title: string; content: string; success: (value: { confirm: boolean }) => void }): void
    createCanvasContext(id: string, page: unknown): CanvasContext
    saveImageToPhotosAlbum(options: { filePath: string; success: () => void; fail: () => void }): void
    shareFileMessage(options: { filePath: string; fileName: string; fail: () => void }): void
  }
}
export {}
