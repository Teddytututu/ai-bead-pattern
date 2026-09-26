import { parentPort } from 'node:worker_threads'
parentPort.postMessage({ type: 'stage', stage: 'generating' })
setTimeout(() => parentPort.postMessage({ type: 'failure', error: { code: 'FIXTURE_DONE', message: 'fixture', retryable: false } }), 10_000)
