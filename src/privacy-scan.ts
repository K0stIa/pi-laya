import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PRIVATE_DEPLOYMENT_PATTERNS = [
  /\b10(?:\.\d{1,3}){3}\b/,
  /\b192\.168(?:\.\d{1,3}){2}\b/,
  /\b172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}\b/,
  /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan)\b/i,
  /\/home\/(?!user(?:\/|$)|USER(?:\/|$))[^/\s]+/,
  /\b(?:api[_-]?(?:token|key)|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
];

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".superpowers"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function scanPrivacy(directory: string = process.cwd()): Promise<void> {
  let matches = 0;
  for (const path of filesUnder(directory)) {
    const content = readFileSync(path, "utf8");
    if (PRIVATE_DEPLOYMENT_PATTERNS.some((pattern) => pattern.test(content))) matches += 1;
  }
  if (matches > 0) throw new Error(`Privacy scan failed: private deployment data detected in ${matches} file(s)`);
}

if (process.argv[1]?.endsWith("privacy-scan.js")) {
  scanPrivacy().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Privacy scan failed");
    process.exitCode = 1;
  });
}
