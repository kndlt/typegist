import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";

export interface GenerateOptions {
  /** Target project root directory (default: process.cwd()) */
  targetDir?: string;
  /** Entry module name without extension (default: auto-detected from package.json, then "index") */
  entry?: string;
  /** Source path prefix shown in comments, e.g. "./src/" (default: auto-detected from tsconfig rootDir) */
  srcPrefix?: string;
  /** Emit only the full declaration for this symbol name */
  symbol?: string;
  /** Output format: full declarations (default), names-only, or YAML tree */
  format?: "dts" | "names" | "yaml";
}

export interface FileExport {
  name: string;
  text: string;
}

export interface FileSymbols {
  /** Relative path without leading "./" and without ".ts" — e.g. "src/state/contracts/index" */
  file: string;
  exports: FileExport[];
}

// ---- workspace detection ----

function parsePnpmWorkspaceYaml(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (line.trim() === "packages:") { inPackages = true; continue; }
    if (inPackages) {
      const match = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/);
      if (match) patterns.push(match[1]);
      else if (line.trim() && !line.match(/^\s/)) inPackages = false;
    }
  }
  return patterns;
}

function expandWorkspacePatterns(rootDir: string, patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const dir = join(rootDir, pattern.slice(0, -2));
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = join(dir, entry.name);
        if (existsSync(join(pkgDir, "package.json"))) results.push(pkgDir);
      }
    } else {
      const dir = join(rootDir, pattern);
      if (existsSync(dir) && existsSync(join(dir, "package.json"))) results.push(dir);
    }
  }
  return results;
}

function detectWorkspacePackages(rootDir: string): string[] | null {
  const pnpmYaml = join(rootDir, "pnpm-workspace.yaml");
  if (existsSync(pnpmYaml)) {
    const patterns = parsePnpmWorkspaceYaml(readFileSync(pnpmYaml, "utf8"));
    const pkgs = expandWorkspacePatterns(rootDir, patterns);
    if (pkgs.length > 0) return pkgs;
  }
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const workspaces = pkg["workspaces"];
      if (Array.isArray(workspaces)) {
        const pkgs = expandWorkspacePatterns(rootDir, workspaces as string[]);
        if (pkgs.length > 0) return pkgs;
      }
    } catch { /* ignore */ }
  }
  return null;
}

function getPackageName(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
    return (pkg["name"] as string) ?? null;
  } catch { return null; }
}

// ---- tsconfig / entry detection ----

function detectRootDir(targetDir: string): string {
  const tsconfigPath = join(targetDir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!result.error) {
      const rootDir = (result.config as { compilerOptions?: { rootDir?: string } })
        ?.compilerOptions?.rootDir;
      if (rootDir) return rootDir.replace(/^\.\//, "").replace(/\/$/, "");
    }
  }
  return existsSync(join(targetDir, "src")) ? "src" : ".";
}

function pathToEntry(filePath: string, rootDir: string): string {
  let p = filePath.replace(/^\.\//, "");
  for (const out of ["dist/", "out/", "build/", "lib/"]) {
    if (p.startsWith(out)) { p = p.slice(out.length); break; }
  }
  if (rootDir && rootDir !== ".") {
    const prefix = rootDir + "/";
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  return p.replace(/\.d\.ts$/, "").replace(/\.[cm]?tsx?$/, "") || "index";
}

function detectEntry(targetDir: string): string {
  const rootDir = detectRootDir(targetDir);
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return "index";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const types = (pkg["types"] ?? pkg["typings"]) as string | undefined;
    if (types) return pathToEntry(types, rootDir);
    const main = pkg["main"] as string | undefined;
    if (main) return pathToEntry(main, rootDir);
  } catch { /* ignore */ }
  return "index";
}

function detectSrcPrefix(targetDir: string): string {
  const rootDir = detectRootDir(targetDir);
  return rootDir && rootDir !== "." ? `./${rootDir}/` : "./";
}

// After tsc emits, infer the actual srcPrefix by checking whether the
// emitted files are flat (rootDir=src) or nested (rootDir=.).
function inferSrcPrefix(targetDir: string, tmp: string): string {
  const srcDir = join(targetDir, "src");
  if (!existsSync(srcDir)) return "./";
  try {
    const entries = readdirSync(tmp, { withFileTypes: true });
    const hasSrcSubdir = entries.some((e) => e.isDirectory() && e.name === "src");
    return hasSrcSubdir ? "./" : "./src/";
  } catch {
    return detectSrcPrefix(targetDir);
  }
}

// ---- AST helpers ----

function getDeclName(stmt: ts.Statement): string | null {
  if (ts.isFunctionDeclaration(stmt)) return stmt.name?.text ?? null;
  if (ts.isClassDeclaration(stmt)) return stmt.name?.text ?? null;
  if (ts.isInterfaceDeclaration(stmt)) return stmt.name.text;
  if (ts.isTypeAliasDeclaration(stmt)) return stmt.name.text;
  if (ts.isEnumDeclaration(stmt)) return stmt.name.text;
  if (ts.isVariableStatement(stmt)) {
    const names = stmt.declarationList.declarations
      .map((d) => (ts.isIdentifier(d.name) ? d.name.text : null))
      .filter((n): n is string => n !== null);
    return names.join(", ");
  }
  return null;
}

function findDecl(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return stmt;
    if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) return stmt;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return stmt;
      }
    }
  }
  return null;
}

function isExported(stmt: ts.Statement): boolean {
  return !!(
    ts.canHaveModifiers(stmt) &&
    ts.getModifiers(stmt)?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

const SKIP_DIRS = new Set(["node_modules", "e2e", "__tests__", "test", "tests", "fixtures", "mocks"]);

function stripImportPaths(src: string): string {
  return src.replace(/import\([^)]+\)\./g, "");
}

function collectDtsFiles(dir: string, root = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectDtsFiles(full, root));
    } else if (
      entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.d.ts") &&
      !entry.name.endsWith(".spec.d.ts")
    ) {
      results.push(full);
    }
  }
  return results.sort();
}

// ---- core collection ----

function collectPackageSymbols(targetDir: string, options: GenerateOptions): FileSymbols[] {
  const results: FileSymbols[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "typegist-"));
  try {
    try {
      execSync(
        `npx --no-install tsc --emitDeclarationOnly --declaration --declarationMap false --noEmit false --noEmitOnError false --outDir "${tmp}"`,
        { cwd: targetDir, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch { /* tsc exits non-zero on type errors but still emits */ }

    const srcPrefix = options.srcPrefix ?? inferSrcPrefix(targetDir, tmp);
    const normalizedPrefix = srcPrefix.replace(/^\.\//, ""); // "" or "src/"
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

    // Library mode: follow re-exports from a single entry point
    const entry = options.entry ?? detectEntry(targetDir);
    const entryPath = join(tmp, entry + ".d.ts");

    if (existsSync(entryPath)) {
      const indexSf = ts.createSourceFile(
        entry + ".d.ts",
        readFileSync(entryPath, "utf8"),
        ts.ScriptTarget.ES2022,
        true,
      );

      const reExports: { name: string; fromRel: string }[] = [];
      for (const stmt of indexSf.statements) {
        if (!ts.isExportDeclaration(stmt)) continue;
        if (!stmt.moduleSpecifier || !stmt.exportClause) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        if (!ts.isNamedExports(stmt.exportClause)) continue;
        const raw = stmt.moduleSpecifier.text;
        if (!raw.startsWith(".")) continue;
        const fromRel = raw.replace(/^\.\//, "").replace(/\.[cm]?js$/, "");
        for (const el of stmt.exportClause.elements) {
          reExports.push({ name: (el.propertyName ?? el.name).text, fromRel });
        }
      }

      if (reExports.length > 0) {
        const moduleCache = new Map<string, ts.SourceFile>();
        function loadModule(rel: string): ts.SourceFile | null {
          if (moduleCache.has(rel)) return moduleCache.get(rel)!;
          const fp = join(tmp, rel + ".d.ts");
          if (!existsSync(fp)) return null;
          const sf = ts.createSourceFile(
            rel + ".d.ts", readFileSync(fp, "utf8"), ts.ScriptTarget.ES2022, true,
          );
          moduleCache.set(rel, sf);
          return sf;
        }

        const filtered = options.symbol
          ? reExports.filter((re) => re.name === options.symbol)
          : reExports;

        // Group by file, preserving order
        const fileOrder: string[] = [];
        const byFile = new Map<string, FileExport[]>();
        for (const re of filtered) {
          const file = normalizedPrefix + re.fromRel;
          if (!byFile.has(file)) { byFile.set(file, []); fileOrder.push(file); }
          const sf = loadModule(re.fromRel);
          let text = `// (could not find ${re.name})`;
          if (sf) {
            const decl = findDecl(sf, re.name);
            if (decl) text = stripImportPaths(printer.printNode(ts.EmitHint.Unspecified, decl, sf).trim());
          }
          byFile.get(file)!.push({ name: re.name, text });
        }

        for (const file of fileOrder) {
          results.push({ file, exports: byFile.get(file)! });
        }
        return results;
      }
    }

    // App/fallback mode: scan all emitted .d.ts files for exported declarations
    for (const filePath of collectDtsFiles(tmp)) {
      const rel = relative(tmp, filePath).replace(/\.d\.ts$/, "");
      const sf = ts.createSourceFile(
        rel + ".d.ts", readFileSync(filePath, "utf8"), ts.ScriptTarget.ES2022, true,
      );
      let exported = sf.statements.filter(isExported);
      if (options.symbol) {
        exported = exported.filter((stmt) => getDeclName(stmt) === options.symbol);
      }
      if (exported.length === 0) continue;

      const file = normalizedPrefix + rel;
      const exports: FileExport[] = exported.map((stmt) => ({
        name: getDeclName(stmt) ?? "",
        text: stripImportPaths(printer.printNode(ts.EmitHint.Unspecified, stmt, sf).trim()),
      }));
      results.push({ file, exports });
    }

    return results;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- serializers ----

function toFlat(files: FileSymbols[], namesOnly: boolean): string[] {
  const lines: string[] = [];
  for (const { file, exports } of files) {
    lines.push("", `// ./${file}.ts`);
    for (const { name, text } of exports) {
      lines.push(namesOnly ? name : text);
    }
  }
  return lines;
}

type YamlTree = { [key: string]: YamlTree | string[] };

function buildYamlTree(files: FileSymbols[]): YamlTree {
  const root: YamlTree = {};
  for (const { file, exports } of files) {
    const parts = file.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in node) || Array.isArray(node[part])) node[part] = {};
      node = node[part] as YamlTree;
    }
    const leaf = parts[parts.length - 1] + ".ts";
    node[leaf] = exports.map((e) => e.name);
  }
  return root;
}

function serializeYamlTree(tree: YamlTree, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      for (const name of value) lines.push(`${pad}  - ${name}`);
    } else {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYamlTree(value, indent + 1));
    }
  }
  return lines.join("\n");
}

// ---- public API ----

export function generateSurface(options: GenerateOptions = {}): string {
  const targetDir = options.targetDir ?? process.cwd();
  const format = options.format ?? "dts";
  const workspacePkgs = detectWorkspacePackages(targetDir);

  if (format === "yaml") {
    if (workspacePkgs) {
      const sections: string[] = [];
      for (const pkgDir of workspacePkgs) {
        const name = getPackageName(pkgDir) ?? relative(targetDir, pkgDir);
        const files = collectPackageSymbols(pkgDir, options);
        sections.push(`${name}:\n${serializeYamlTree(buildYamlTree(files), 1)}`);
      }
      return sections.join("\n") + "\n";
    }
    const files = collectPackageSymbols(targetDir, options);
    return serializeYamlTree(buildYamlTree(files)) + "\n";
  }

  const namesOnly = format === "names";
  const out: string[] = ["// Generated by typegist — do not edit manually."];

  if (workspacePkgs) {
    for (const pkgDir of workspacePkgs) {
      const name = getPackageName(pkgDir) ?? relative(targetDir, pkgDir);
      const files = collectPackageSymbols(pkgDir, options);
      const lines = toFlat(files, namesOnly);
      if (namesOnly) {
        out.push("", `// module: ${name}`);
        out.push(...lines);
      } else {
        out.push("", `declare module "${name}" {`);
        out.push(...lines.map((l) =>
          l === "" ? "" : l.split("\n").map((sub) => (sub === "" ? "" : `  ${sub}`)).join("\n")
        ));
        out.push("}");
      }
    }
  } else {
    out.push(...toFlat(collectPackageSymbols(targetDir, options), namesOnly));
  }

  return out.join("\n") + "\n";
}
