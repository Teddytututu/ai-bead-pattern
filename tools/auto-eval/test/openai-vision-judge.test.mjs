import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OpenAIResponsesVisionJudge } from '../src/openai-vision-judge.mjs'

describe('OpenAI Responses vision judge', () => {
  it('sends source and candidate images with a strict JSON schema', async () => {
    let request
    const judge = new OpenAIResponsesVisionJudge({
      apiKey: 'test-key', model: 'gpt-5.6-vision',
      fetch: async (_url, init) => {
        request = JSON.parse(init.body)
        return new Response(JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: JSON.stringify({
            candidateScores: {}, issues: [], ranking: ['a', 'b'], bestCandidateId: 'a', eliminations: [], confidence: 0.8,
          }) }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await judge.score({
      generationId: 'generation-1', sourceId: 'pet-1', subjectKind: 'pet',
      sourceImage: { mimeType: 'image/png', base64: 'AAAA' },
      candidates: [
        { id: 'a', grid: { width: 48, height: 48 }, image: { mimeType: 'image/png', base64: 'BBBB' } },
        { id: 'b', grid: { width: 48, height: 48 }, image: { mimeType: 'image/png', base64: 'CCCC' } },
      ],
    })

    assert.equal(request.model, 'gpt-5.6-vision')
    assert.equal(request.input[0].content.filter((entry) => entry.type === 'input_image').length, 3)
    assert.equal(request.text.format.type, 'json_schema')
    assert.equal(request.text.format.strict, true)
  })

  it('rejects oversized responses', async () => {
    const judge = new OpenAIResponsesVisionJudge({
      apiKey: 'test-key', model: 'gpt-5.6-vision', maximumResponseBytes: 32,
      fetch: async () => new Response(JSON.stringify({ output: 'x'.repeat(100) }), { status: 200 }),
    })
    await assert.rejects(() => judge.score({
      generationId: 'generation-1', sourceId: 'pet-1', subjectKind: 'pet',
      sourceImage: { mimeType: 'image/png', base64: 'AAAA' },
      candidates: [
        { id: 'a', grid: { width: 48, height: 48 }, image: { mimeType: 'image/png', base64: 'BBBB' } },
        { id: 'b', grid: { width: 48, height: 48 }, image: { mimeType: 'image/png', base64: 'CCCC' } },
      ],
    }), /response.*limit/i)
  })

  it('sends a complete twelve-candidate internal evaluation batch', async () => {
    let request
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      grid: { width: [32, 48, 64][index % 3], height: [32, 48, 64][index % 3] },
      image: { mimeType: 'image/png', base64: 'AAAA' },
    }))
    const judge = new OpenAIResponsesVisionJudge({
      apiKey: 'test-key', model: 'gpt-5.6-vision',
      fetch: async (_url, init) => {
        request = JSON.parse(init.body)
        return new Response(JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: JSON.stringify({
            candidateScores: {}, issues: [], ranking: candidates.map((candidate) => candidate.id),
            bestCandidateId: candidates[0].id, eliminations: [], confidence: 0.8,
          }) }] }],
        }), { status: 200 })
      },
    })

    await judge.score({
      generationId: 'generation-1', sourceId: 'pet-1', subjectKind: 'pet',
      sourceImage: { mimeType: 'image/png', base64: 'AAAA' },
      candidates,
    })

    assert.equal(request.input[0].content.filter((entry) => entry.type === 'input_image').length, 13)
  })
})
