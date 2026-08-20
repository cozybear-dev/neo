declare const process: { env: Record<string, string | undefined> }

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: { register: (tool: unknown) => void }
    on(event: string, listener: (...args: never[]) => unknown): () => void
    get(name: string): unknown
    logger?: { warn: (msg: string) => void }
    llm?: LlmServiceLike
    agentDefaultModel?: {
      currentSelection: () => { provider: string; model: string; reasoningEffort?: string }
    }
  }
}

interface LlmServiceLike {
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}
