import { performance } from 'node:perf_hooks'

import { visionJudgmentJsonSchema } from './schema.mjs'

const endpoint = 'https://api.openai.com/v1/responses'

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  throw new RangeError('OpenAI response must contain output text')
}

function imagePart(image) {
  return {
    type: 'input_image',
    image_url: `data:${image.mimeType};base64,${image.base64}`,
    detail: 'high',
  }
}

export class OpenAIResponsesVisionJudge {
  constructor(options) {
    if (typeof options?.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new RangeError('OpenAI API key is required')
    }
    if (typeof options?.model !== 'string' || options.model.length === 0) {
      throw new RangeError('OpenAI vision model is required')
    }
    this.apiKey = options.apiKey
    this.model = options.model
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maximumResponseBytes = options.maximumResponseBytes ?? 2 * 1024 * 1024
    this.url = options.url ?? endpoint
  }

  async score(input) {
    if (input.candidates.length < 2 || input.candidates.length > 12) {
      throw new RangeError('Vision scoring requires 2..12 candidates')
    }
    const candidateIds = input.candidates.map((candidate) => candidate.id)
    const prompt = [
      'Evaluate fuse-bead pixel-art candidates against the source image.',
      `Subject kind: ${input.subjectKind}.`,
      `Candidate order after the source image: ${candidateIds.join(', ')}.`,
      'Prioritize recognizable subject identity, silhouette, facial or object landmarks, proportion, value hierarchy, clean pixel clusters, contour rhythm, physical bead feasibility, and style fit.',
      'Use scores from 1 to 5. Add issue tags only when visually supported. Rank every candidate.',
    ].join(' ')
    const body = {
      model: this.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          imagePart(input.sourceImage),
          ...input.candidates.flatMap((candidate) => [
            { type: 'input_text', text: `Candidate ${candidate.id}, grid ${candidate.grid.width}x${candidate.grid.height}` },
            imagePart(candidate.image),
          ]),
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'fuse_bead_vision_judgment',
          strict: true,
          schema: visionJudgmentJsonSchema(candidateIds),
        },
      },
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('OpenAI vision scoring timed out')), this.timeoutMs)
    const started = performance.now()
    try {
      const response = await this.fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]),
      })
      const responseText = await response.text()
      if (Buffer.byteLength(responseText) > this.maximumResponseBytes) {
        throw new RangeError('OpenAI response exceeds the response limit')
      }
      if (response.ok === false) throw new Error(`OpenAI response failed with status ${response.status}`)
      const parsed = JSON.parse(responseText)
      return {
        ...JSON.parse(outputText(parsed)),
        elapsedMs: performance.now() - started,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
