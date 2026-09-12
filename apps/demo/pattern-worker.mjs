import { createPatternAlgorithm, createPatternWorkerHandler } from '@ai-bead-pattern/pattern-core'

const algorithm = createPatternAlgorithm({ version: '0.7.0-worker' })
const handle = createPatternWorkerHandler(algorithm, { postMessage: (message) => globalThis.postMessage(message) })
globalThis.onmessage = (event) => {
  void handle(event.data)
}
