declare const process: {
  argv: string[];
  cwd(): string;
  exitCode?: number;
  env: Record<string, string | undefined>;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string, options?: { withFileTypes: true }): Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}
