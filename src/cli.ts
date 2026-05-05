#!/usr/bin/env node
import { writeFileSync, readFileSync } from "node:fs";
import { generateSurface } from "./generate.js";

const argv = process.argv.slice(2);

function parseArgs(args: string[]) {
  const flags = new Set(args);
  const get = (prefix: string) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  return {
    dir: get("--dir=") ?? process.cwd(),
    out: get("--out="),
    entry: get("--entry="),
    srcPrefix: get("--src-prefix="),
    quiet: flags.has("--quiet"),
    noWrite: flags.has("--no-write"),
    hook: get("--hook=") ?? null,
    help: flags.has("--help") || flags.has("-h"),
    symbolNamesOnly: flags.has("--symbol-names-only"),
    format: get("--format="),
    symbol: get("--symbol="),
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emitHookEnvelope(eventName: string, context: string) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }),
  );
}

function touchesTargetSource(toolInput: unknown, targetDir: string): boolean {
  if (!toolInput) return false;
  // Heuristic: check if the tool input references any path inside targetDir
  const rel = targetDir.replace(/\\/g, "/");
  return JSON.stringify(toolInput).includes(rel);
}

const help = `
Usage: typegist [options]

Generate a bird's-eye-view .d.ts of a TypeScript project.

Options:
  --dir=<path>        Target project directory (default: cwd)
  --out=<file>        Write output to this file
  --entry=<name>      Entry module name without extension (default: auto-detected)
  --src-prefix=<str>  Prefix shown in source path comments (default: auto-detected)
  --format=<fmt>      Output format: dts (default), names, yaml
  --symbol-names-only Shorthand for --format=names
  --symbol=<name>     Emit only the full declaration for a single symbol
  --quiet             Write file only, suppress stdout
  --no-write          Print to stdout only, do not write file
  --hook=<event>      Claude Code hook mode: session-start | post-tool-use
  --help, -h          Show this help
`.trim();

const opts = parseArgs(argv);

if (opts.help) {
  console.log(help);
  process.exit(0);
}

const resolvedFormat = opts.symbolNamesOnly ? "names" : (opts.format as "dts" | "names" | "yaml" | undefined);

const generateOpts = {
  targetDir: opts.dir,
  ...(opts.entry ? { entry: opts.entry } : {}),
  ...(opts.srcPrefix ? { srcPrefix: opts.srcPrefix } : {}),
  ...(resolvedFormat ? { format: resolvedFormat } : {}),
  ...(opts.symbol ? { symbol: opts.symbol } : {}),
};

if (opts.hook === "session-start") {
  const surface = generateSurface(generateOpts);
  if (opts.out) writeFileSync(opts.out, surface);
  emitHookEnvelope(
    "SessionStart",
    `Synthesised public surface, regenerated at session start.\n\n${surface}`,
  );
} else if (opts.hook === "post-tool-use") {
  const stdin = readStdin();
  let event: { tool_input?: unknown } | null = null;
  try {
    event = JSON.parse(stdin) as { tool_input?: unknown };
  } catch {
    process.exit(0);
  }
  if (!touchesTargetSource(event?.tool_input, opts.dir)) {
    process.exit(0);
  }
  const surface = generateSurface(generateOpts);
  if (opts.out) writeFileSync(opts.out, surface);
  emitHookEnvelope("PostToolUse", `Source was edited. Refreshed public surface:\n\n${surface}`);
} else {
  const surface = generateSurface(generateOpts);
  if (!opts.noWrite && opts.out) writeFileSync(opts.out, surface);
  if (!opts.quiet) process.stdout.write(surface);
}
