import type { GenerationJob, JobStatus } from "../src/types"

let n = 0
export function job(overrides: Partial<GenerationJob> & { status?: JobStatus } = {}): GenerationJob {
  n += 1
  return {
    id: `job-${n}`,
    provider: "replicate",
    modelId: "replicate:test/video",
    modelName: "Test Video",
    workflow: "text-to-video",
    output: "video",
    providerRequestId: `req-${n}`,
    status: "completed",
    prompt: "a test",
    negativePrompt: null,
    params: {},
    requestedDurationSec: 5,
    estimatedCostUsd: 1,
    estimateSource: "provider",
    confirmedCostUsd: null,
    errorCode: null,
    errorMessage: null,
    promptId: null,
    projectId: null,
    createdAt: new Date(2026, 9, 10, 12).getTime(),
    updatedAt: new Date(2026, 9, 10, 12).getTime(),
    completedAt: null,
    ...overrides,
  }
}
