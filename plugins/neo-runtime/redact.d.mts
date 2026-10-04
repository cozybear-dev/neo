export function redactText(text: string, secrets?: string[]): string;
export function redactSecrets(value: unknown, secrets?: string[]): unknown;
export function environmentSecrets(env?: Record<string, string | undefined>): string[];
export function renderSafe(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
