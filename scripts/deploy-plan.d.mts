export function parseJsonc(text: string): Record<string, any>;
export function planDeploy(env: Record<string, string | undefined>, vars: Record<string, string> | undefined): {
  problems: string[]; secrets: Record<string, string>; names: string[]; mode: string | undefined; baseSecrets: string[];
};
