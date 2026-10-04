export function taskWorkspace(env?: Record<string, string | undefined>, taskId?: string): string;
export function persistRawArtifact(text: string, opts?: { root?: string; kind?: string }): Promise<string>;
