import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
// Build only the pure checker module in a disposable directory; no Nest app or database starts.
describe('Evolution preflight CLI snapshot / DEV-only guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kalend-evolution-preflight-'));
  const fixture = join(dir, 'snapshot.json');
  const loader = join(dir, 'loader.mjs');
  beforeAll(() => {
    const checker = readFileSync(
      'src/communication/evolution-preflight.ts',
      'utf8',
    );
    const envSource = readFileSync(
      'src/communication/evolution-environment.ts',
      'utf8',
    );
    const env = envSource
      .replace(/import[\s\S]*?from ['"][^'"]+['"];\s*/g, '')
      .replace('uuid(companyId)', 'companyId');
    const pure =
      checker.replace(/import[\s\S]*?from ['"][^'"]+['"];\s*/g, '') +
      '\n' +
      env;
    const code = ts.transpileModule(pure, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const moduleFile = join(dir, 'checker.mjs');
    writeFileSync(moduleFile, code);
    // Tests the actual CLI, substituting its prebuilt checker import only. pg is never connected in snapshot mode.
    const cli = readFileSync('scripts/evolution-preflight.mjs', 'utf8')
      .replace(
        "'../dist/communication/evolution-preflight.js'",
        JSON.stringify('file://' + moduleFile),
      )
      .replace("import 'dotenv/config';", '')
      .replace(
        "import pg from 'pg';",
        "const pg = { Client: class { constructor() { throw Error('No database allowed'); } } };",
      );
    writeFileSync(loader, cli);
  });
  it('checks a snapshot without echoing embedded credentials or changing data', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      fixture,
      JSON.stringify({
        rows: [
          {
            id,
            companyId: id,
            globalKey: null,
            instanceName: 'kalend_' + id.replaceAll('-', ''),
            apiKey: 'must-not-print-this',
          },
        ],
      }),
    );
    const before = readFileSync(fixture, 'utf8');
    const out = execFileSync(
      process.execPath,
      [loader, '--snapshot', fixture, '--environment', 'DEV'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out).compatible).toBe(true);
    expect(out).not.toContain('must-not-print-this');
    expect(readFileSync(fixture, 'utf8')).toBe(before);
  });
  it('detects an incompatible line with exit 2 before any migration or database write', () => {
    writeFileSync(
      fixture,
      JSON.stringify({
        rows: [
          {
            id: 'row',
            companyId: null,
            globalKey: null,
            instanceName: 'invalid',
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [loader, '--snapshot', fixture, '--environment', 'DEV'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('GLOBAL_MIGRATION_CHECK_FAILED');
  });
  it('refuses production database mode before constructing a client and sanitizes errors', () => {
    const result = spawnSync(
      process.execPath,
      [loader, '--dev', '--environment', 'PRODUCTION'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL:
            'postgresql://user:must-not-print-this@localhost/production',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EVOLUTION_PREFLIGHT_FAILED');
    expect(result.stderr).not.toContain('must-not-print-this');
  });
});
