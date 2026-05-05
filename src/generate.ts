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
  // If a known source file appears flat in tmp, rootDir was src.
  // If it appears nested under src/, rootDir was the project root.
  const srcDir = join(targetDir, "src");
  if (!existsSync(srcDir)) return "./";
  // Look for any .d.ts at tmp/src/*.d.ts — means rootDir was "."
  try {
    const entries = readdirSync(tmp, { withFileTypes: true });
    const hasSrcSubdir = entries.some((e) => e.isDirectory() && e.name === "src");
    return hasSrcSubdir ? "./" : "./src/";
  } catch {
    return detectSrcPrefix(targetDir);
  }
}

// ---- AST helpers ----

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
    if (entry.name.startsWith(".")) continue; // skip hidden dirs (.next, .git, etc.)
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

// ---- core generation (single package, returns lines without header) ----

function generatePackageLines(targetDir: string, options: GenerateOptions): string[] {
  const out: string[] = [];

  const tmp = mkdtempSync(join(tmpdir(), "typegist-"));
  try {
    try {
      execSync(
        `npx --no-install tsc --emitDeclarationOnly --declaration --declarationMap false --noEmit false --noEmitOnError false --outDir "${tmp}"`,
        { cwd: targetDir, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch { /* tsc exits non-zero on type errors but still emits */ }

    const srcPrefix = options.srcPrefix ?? inferSrcPrefix(targetDir, tmp);
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

        let lastFrom: string | null = null;
        for (const re of reExports) {
          if (re.fromRel !== lastFrom) {
            out.push("", `// ${srcPrefix}${re.fromRel}.ts`);
            lastFrom = re.fromRel;
          }
          const sf = loadModule(re.fromRel);
          if (!sf) { out.push(`// (could not find module ${re.fromRel})`); continue; }
          const decl = findDecl(sf, re.name);
          if (!decl) { out.push(`// (could not find ${re.name} in ${re.fromRel})`); continue; }
          out.push(stripImportPaths(printer.printNode(ts.EmitHint.Unspecified, decl, sf).trim()));
        }
        return out;
      }
    }

    // App/fallback mode: scan all emitted .d.ts files for exported declarations
    for (const filePath of collectDtsFiles(tmp)) {
      const rel = relative(tmp, filePath).replace(/\.d\.ts$/, "");
      const sf = ts.createSourceFile(
        rel + ".d.ts", readFileSync(filePath, "utf8"), ts.ScriptTarget.ES2022, true,
      );
      const exported = sf.statements.filter(isExported);
      if (exported.length === 0) continue;
      out.push("", `// ${srcPrefix}${rel}.ts`);
      for (const stmt of exported) {
        out.push(stripImportPaths(printer.printNode(ts.EmitHint.Unspecified, stmt, sf).trim()));
      }
    }

    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- public API ----

export function generateSurface(options: GenerateOptions = {}): string {
  const targetDir = options.targetDir ?? process.cwd();
  const out: string[] = ["// Generated by typegist — do not edit manually."];

  const workspacePkgs = detectWorkspacePackages(targetDir);
  if (workspacePkgs) {
    for (const pkgDir of workspacePkgs) {
      const name = getPackageName(pkgDir) ?? relative(targetDir, pkgDir);
      const lines = generatePackageLines(pkgDir, options);
      out.push("", `declare module "${name}" {`);
      out.push(...lines.map((l) =>
        l === "" ? "" : l.split("\n").map((sub) => (sub === "" ? "" : `  ${sub}`)).join("\n")
      ));
      out.push("}");
    }
  } else {
    out.push(...generatePackageLines(targetDir, options));
  }

  return out.join("\n") + "\n";
}
