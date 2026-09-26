import { writeFile } from 'node:fs/promises'
import { apiLimits } from '../packages/pattern-api-contracts/dist/index.js'
const string = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' }
const ref = name => ({ $ref: `#/components/schemas/${name}` })
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties })
const array = items => ({ type: 'array', items })
const envelope = schema => object({ data: schema, requestId: { type: 'string', format: 'uuid' } })
const json = schema => ({ 'application/json': { schema } })
const response = (schema, description = 'Success') => ({ description, content: json(envelope(schema)) })
const error = { description: 'Structured API error', content: json(ref('Error')) }
const schemas = {
  Error: object({ error: object({ code: string, message: string, retryable: boolean }), requestId: string }),
  Session: object({ token: string, expiresAt: { ...integer, description: 'Unix epoch milliseconds' } }),
  Image: object({ imageId: string, width: integer, height: integer, expiresAt: integer }),
  Palette: object({ id: string, name: string, brand: string, version: string, colorCount: integer, rgbKind: string, colors: array(ref('Color')) }, ['id', 'name', 'version', 'colorCount', 'colors'], true),
  Color: object({ id: string, code: string, name: string, group: string, hex: { type: 'string', pattern: '^#[A-Fa-f0-9]{6}$' }, rgb: { ...array({ type: 'integer', minimum: 0, maximum: 255 }), minItems: 3, maxItems: 3 } }, ['id', 'name', 'hex', 'rgb'], true),
  Job: object({ jobId: string, state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }, stage: string, createdAt: integer, updatedAt: integer, expiresAt: integer, pollAfterMs: integer, statusUrl: string, resultUrl: string, error: object({ code: string, message: string, retryable: boolean }) }, ['jobId', 'state', 'stage', 'createdAt', 'updatedAt', 'expiresAt', 'pollAfterMs', 'statusUrl']),
  Pattern: object({ schema: { const: 'bead-pattern-document-v1' }, width: integer, height: integer, paletteId: string, paletteVersion: string, brand: string, colors: array(ref('Color')), grid: { ...array({ type: 'integer', minimum: -1, maximum: 511 }), maxItems: 9216, description: 'Row-major palette indices; -1 means empty board space.' }, materials: array(object({ colorId: string, code: string, hex: string, count: integer })), totalBeads: integer, metadata: { type: 'object', additionalProperties: true } }),
  Candidate: object({ id: string, style: string, valid: boolean, score: { type: 'number' }, reasons: array(string), pattern: ref('Pattern') }),
  Result: object({ generationId: string, generationStatus: { type: 'string', enum: ['success', 'best-effort', 'no-valid-candidate'] }, actualRoute: { type: 'string', enum: ['deterministic', 'neural-analysis'] }, recommendedId: string, bestEffortId: string, candidates: array(ref('Candidate')), warnings: array(string) }, ['generationId', 'generationStatus', 'actualRoute', 'candidates', 'warnings']),
  CreateJob: object({ imageId: string, paletteId: { type: 'string', default: 'mard-291' }, paletteVersion: string,
    route: { type: 'string', enum: ['deterministic', 'neural-analysis'], default: 'deterministic' }, failureMode: { type: 'string', enum: ['strict', 'best-effort'], default: 'strict' }, consentToRemoteAnalysis: boolean,
    options: object({ canvas: { oneOf: [object({ mode: { const: 'auto' } }), object({ mode: { const: 'fixed' }, size: object({ width: { ...integer, enum: apiLimits.gridSizes }, height: { ...integer, enum: apiLimits.gridSizes } }) })], description: 'Fixed width and height must match.' },
      maxColors: { ...integer, minimum: 1, maximum: apiLimits.maxColors, default: 20 }, maxCandidates: { ...integer, minimum: 1, maximum: apiLimits.maxCandidates, default: 3 },
      styles: { ...array({ type: 'string', enum: ['faithful', 'simple', 'high-contrast', 'cute', 'soft'] }), minItems: 1, maxItems: 3, uniqueItems: true }, imageType: { type: 'string', enum: ['general', 'portrait', 'pet', 'illustration', 'landscape'] },
      structure: object({ occupancyMode: { type: 'string', enum: ['auto', 'full-frame', 'subject-shape'] } }, []), optimization: object({ refinementMode: { type: 'string', enum: ['fast', 'quality'] } }, []),
    }, []),
  }, ['imageId']),
}
const paths = {}
function op(path, method, id, schema, { publicRoute = false, status = '200', body, parameters = [], description = '' } = {}) {
  paths[path] ??= {}
  paths[path][method] = { operationId: id, description, ...(publicRoute ? { security: [] } : {}),
    parameters: [...(path.match(/\{[^}]+\}/g) ?? []).map(p => ({ name: p.slice(1, -1), in: 'path', required: true, schema: string })), ...parameters],
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: { [status]: response(schema), ...Object.fromEntries(['400', '401', '404', '409', '410', '413', '415', '422', '429', '500', '503'].map(code => [code, error])) },
  }
}
op('/healthz', 'get', 'health', object({ status: string }), { publicRoute: true })
op('/v1/capabilities', 'get', 'capabilities', { type: 'object', additionalProperties: true }, { publicRoute: true, description: 'Configured routes, limits, retentionMs, and analysis processing location/consent. Configuration does not guarantee model health.' })
op('/v1/auth/wechat', 'post', 'wechatLogin', ref('Session'), { publicRoute: true, body: object({ code: string }) })
op('/v1/auth/dev', 'post', 'developmentLogin', ref('Session'), { publicRoute: true, body: object({ userId: string }), description: 'Explicit opt-in development only; forbidden in production.' })
op('/v1/palettes', 'get', 'listPalettes', array(object({ id: string, name: string, version: string, colorCount: integer, brand: string }, ['id', 'name', 'version', 'colorCount'])), { publicRoute: true })
op('/v1/palettes/{paletteId}', 'get', 'getPalette', ref('Palette'), { publicRoute: true, parameters: [{ name: 'version', in: 'query', schema: string }, { name: 'If-None-Match', in: 'header', schema: string }] })
paths['/v1/palettes/{paletteId}'].get.responses['304'] = { description: 'Palette unchanged' }
op('/v1/images', 'post', 'uploadImage', ref('Image'), { status: '201', description: 'JPEG/PNG/WebP up to 5 MiB and 20 MP; normalized to at most 1024 px. A deduplicated upload returns 200.' })
paths['/v1/images'].post.requestBody = { required: true, content: { 'multipart/form-data': { schema: object({ file: { type: 'string', format: 'binary' } }) } } }
paths['/v1/images'].post.responses['200'] = response(ref('Image'))
op('/v1/images/{imageId}', 'delete', 'deleteImage', object({ deleted: boolean }))
op('/v1/pattern-jobs', 'post', 'createJob', ref('Job'), { status: '202', body: ref('CreateJob'), parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }], description: 'Same user/key/request returns the same job for 24 hours; conflicting requests return 409. Palette version is frozen on creation.' })
op('/v1/pattern-jobs/{jobId}', 'get', 'getJob', ref('Job'))
op('/v1/pattern-jobs/{jobId}/result', 'get', 'getResult', ref('Result'), { description: 'Execution success and generation quality are separate states.' })
op('/v1/pattern-jobs/{jobId}/cancel', 'post', 'cancelJob', ref('Job'), { description: 'Idempotent; terminal jobs keep their state.' })
op('/v1/pattern-jobs/{jobId}/exports/{candidateId}', 'get', 'downloadExport', {}, { parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['png', 'csv', 'json'], default: 'png' } }, { name: 'acceptBestEffort', in: 'query', schema: boolean }], description: 'Best-effort exports require explicit acceptance; no-valid-candidate has no export.' })
paths['/v1/pattern-jobs/{jobId}/exports/{candidateId}'].get.responses['200'] = { description: 'Candidate file', content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'text/csv': { schema: string }, 'application/json': { schema: ref('Pattern') } } }
await writeFile(new URL('../services/pattern-api/openapi.json', import.meta.url), JSON.stringify({ openapi: '3.1.0', info: { title: 'Bead Pattern API', version: '1.0.0' }, servers: [{ url: 'http://127.0.0.1:7105', description: 'Local development; use HTTPS in production' }], security: [{ bearerAuth: [] }], paths, components: { schemas, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } }, null, 2) + '\n')
