import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

export interface GenerateOptions {
  /** Target project root directory (default: process.cwd()) */
  targetDir?: string;
  /** Entry module name without extension (default: auto-detected from package.json, then "index") */
  entry?: string;
  /** Source path prefix shown in comments, e.g. "./src/" (default: auto-detected from tsconfig rootDir) */
  srcPrefix?: string;
}

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
  // Strip common output dirs
  for (const out of ["dist/", "out/", "build/", "lib/"]) {
    if (p.startsWith(out)) { p = p.slice(out.length); break; }
  }
  // Strip rootDir prefix — tsc emits relative to rootDir
  if (rootDir && rootDir !== ".") {
    const prefix = rootDir + "/";
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  // Strip extensions
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
  } catch {
    // ignore parse errors
  }
  return "index";
}

function detectSrcPrefix(targetDir: string): string {
  const rootDir = detectRootDir(targetDir);
  if (rootDir && rootDir !== ".") return `./${rootDir}/`;
  return "./";
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

export function generateSurface(options: GenerateOptions = {}): string {
  const targetDir = options.targetDir ?? process.cwd();
  const entry = options.entry ?? detectEntry(targetDir);
  const srcPrefix = options.srcPrefix ?? detectSrcPrefix(targetDir);

  const tmp = mkdtempSync(join(tmpdir(), "typegist-"));
  try {
    try {
      execSync(
        `npx --no-install tsc --emitDeclarationOnly --declaration --declarationMap false --noEmitOnError false --outDir "${tmp}"`,
        { cwd: targetDir, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch {
      // tsc exits non-zero on type errors but still emits when noEmitOnError is false
    }

    const entryPath = join(tmp, entry + ".d.ts");
    if (!existsSync(entryPath)) {
      throw new Error(
        `Could not find emitted entry at ${entryPath}. Make sure the project has a valid tsconfig.json and entry point.`,
      );
    }

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
      if (!raw.startsWith(".")) continue; // skip external re-exports
      const fromRel = raw.replace(/^\.\//, "").replace(/\.[cm]?js$/, "");
      for (const el of stmt.exportClause.elements) {
        reExports.push({ name: (el.propertyName ?? el.name).text, fromRel });
      }
    }

    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    const moduleCache = new Map<string, ts.SourceFile>();

    function loadModule(rel: string): ts.SourceFile | null {
      if (moduleCache.has(rel)) return moduleCache.get(rel)!;
      const filePath = join(tmp, rel + ".d.ts");
      if (!existsSync(filePath)) return null;
      const sf = ts.createSourceFile(
        rel + ".d.ts",
        readFileSync(filePath, "utf8"),
        ts.ScriptTarget.ES2022,
        true,
      );
      moduleCache.set(rel, sf);
      return sf;
    }

    const out: string[] = ["// Generated by typegist — do not edit manually.", ""];
    let lastFrom: string | null = null;

    for (const re of reExports) {
      if (re.fromRel !== lastFrom) {
        out.push(`// ${srcPrefix}${re.fromRel}.ts`);
        lastFrom = re.fromRel;
      }
      const sf = loadModule(re.fromRel);
      if (!sf) {
        out.push(`// (could not find module ${re.fromRel})`);
        continue;
      }
      const decl = findDecl(sf, re.name);
      if (!decl) {
        out.push(`// (could not find ${re.name} in ${re.fromRel})`);
        continue;
      }
      out.push(printer.printNode(ts.EmitHint.Unspecified, decl, sf).trim());
    }

    return out.join("\n") + "\n";
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
