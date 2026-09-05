/** Promise facade for the pattern Worker protocol. Heavy generation stays off the UI thread. */
export function createPatternWorkerClient(worker, { timeoutMs = 120_000 } = {}) {
  let sequence = 0
  const pending = new Map()
  worker.onmessage = (event) => {
    const message = event.data
    const entry = pending.get(message?.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.type === 'error') entry.reject(Object.assign(new Error(message.error.message), { name: message.error.name }))
    else entry.resolve(message.result)
  }
  const call = (type, request) => new Promise((resolve, reject) => {
    const id = `request-${++sequence}`
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Pattern Worker timeout after ${timeoutMs}ms`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ id, type, request })
  })
  return {
    generate: (request) => call('generate', request),
    adapt: (request) => call('adapt', request),
    dispose: () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Pattern Worker disposed')) }; pending.clear(); worker.terminate?.() },
  }
}
