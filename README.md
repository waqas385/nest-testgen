# @waqas385/nestjs-testgen

**NestJS e2e testing CLI** — generate **Jest** and **Supertest** endpoint tests from **controllers** and **DTOs**, with optional wiring of `test:e2e`, Jest config, and npm scripts. Use this when you want **API / HTTP integration tests** or **automated test scaffolding** for a **TypeScript NestJS** backend.

**Related searches:** NestJS test generator, generate NestJS e2e tests, Jest e2e NestJS, Supertest scaffold, DTO-based API tests.

## What it does

This package scans a NestJS project for controller classes, discovers routes and body DTOs, and generates a scaffolded `.spec.ts` file with request templates and example payloads.

It is intended for projects where DTOs are properly defined and the NestJS controllers use decorator metadata such as `@Controller`, `@Get`, `@Post`, `@Patch`, and `@Body()`.

## Usage

1. Install in your NestJS project:

```bash
npm install --save-dev @waqas385/nestjs-testgen
```

2. Generate and auto-setup tests for your NestJS project:

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite
```

Quick start in one block:

```bash
npm i -D @waqas385/nestjs-testgen
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite
npm run test:e2e:generated
```

This command now does all of the following by default:

- Generates the e2e test file.
- Detects missing test setup and initializes it (after confirmation prompt).
- Adds missing test scripts in `package.json` (`test`, `test:watch`, `test:cov`, `test:e2e`, `test:e2e:generated`).
- Adds a generator script in `package.json`: `test:generate`.
- Adds default `jest` config in `package.json` if missing.
- Adds `@waqas385/nestjs-testgen` to target project `devDependencies` if missing.
- Updates Jest e2e config (`test/jest-e2e.json` or the `--config` path from `test:e2e` script) with:
  - `"moduleNameMapper": { "^src/(.*)$": "<rootDir>/../src/$1" }`
- Adds/updates `test:e2e:generated` in the target project's `package.json`.
- Writes generated tests to `<output>/<test-file>` (for example: `test/generated.e2e-spec.ts`).

3. Run generated tests:

```bash
npm run test:e2e:generated
```

To regenerate from inside the target project later:

```bash
npm run test:generate
```

4. Optional: include dependency installation and immediate test execution:

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite --install-test-deps --run-generated-tests
```

If you want to skip prompts and auto-approve setup changes, add `--yes`.
If you want to preview all changes without modifying files, add `--dry-run`.
If you need machine-readable output for CI, add `--json`.

## FAQ

### How do I generate NestJS e2e tests with Jest and Supertest?

Install `@waqas385/nestjs-testgen`, then run `npx @waqas385/nestjs-testgen` with `--project`, `--output`, and `--test-file`. See the [Usage](#usage) section and `--install-test-deps` if your project is missing test dependencies.

### Is this for unit tests or end-to-end (e2e) tests?

It targets **e2e / integration-style** HTTP tests against your Nest app (Supertest + Jest), not isolated unit tests of single functions.

### Why does Bundlephobia show a build error?

This is a **Node.js CLI**; browser bundlers fail on built-ins like `fs` and `path`. See [Bundlephobia note](#bundlephobia-note).

### How do I run the CLI in CI?

Use `--yes` to skip prompts and optionally `--json` for machine-readable output. See the CI examples in [Example](#example).

## CLI Options

- `--project <path>`: NestJS project root (default: `.`)
- `--output <path>`: Output directory for generated tests (default: `generated-tests`)
- `--controllers <glob>`: Controller glob pattern (default: `src/**/*.controller.ts`)
- `--test-file <name>`: Output file name (default: `generated.e2e-spec.ts`)
- `--overwrite`: Overwrite existing generated test file
- `--no-setup`: Skip Jest/package.json auto-setup changes
- `--install-test-deps`: Install missing e2e test dependencies in target project
- `--run-generated-tests`: Run `npm run test:e2e:generated` after generation
- `--yes`: Auto-approve setup/init changes when project test config is missing
- `--dry-run`: Preview generated/updated files, scripts, config, deps, and test run command without writing anything
- `--json`: Print machine-readable JSON result (and JSON errors)

## Example

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite --install-test-deps --run-generated-tests
```

Dry run preview:

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite --install-test-deps --run-generated-tests --dry-run
```

CI-friendly preview:

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite --dry-run --yes --json
```

CI-friendly apply:

```bash
npx @waqas385/nestjs-testgen --project . --output test --test-file generated.e2e-spec.ts --overwrite --install-test-deps --yes --json
```

Run via npm script (optional):

```json
{
  "scripts": {
    "nestjs-testgen": "nestjs-testgen"
  }
}
```

Then:

```bash
npm run nestjs-testgen -- --project . --output test --test-file generated.e2e-spec.ts --overwrite
```

## Cross-platform support

- Works on Linux, macOS, and Windows.
- Generated npm scripts and Jest paths use forward slashes for compatibility.
- Uses Node APIs (`path`, `fs`) for file handling rather than shell-specific path logic.
- For non-interactive environments (CI), use `--yes` to bypass prompts.

## Bundlephobia note

- This package is a Node.js CLI tool for NestJS projects and is not intended for browser bundling.
- Bundlephobia may report a build error because it attempts a browser-focused bundle and this package uses Node built-ins like `fs`, `path`, `readline`, and `child_process`.
- Use `npm install`, `npm run build`, and CLI execution in a Node environment as the source of truth for package health.

## Notes

- The package uses `ts-morph` to analyze TypeScript AST and extract route and DTO metadata.
- Generated payload values are best-effort examples and may need manual adjustment for application-specific business logic.

## Discoverability and migration

- Package name: `@waqas385/nestjs-testgen`
- CLI command: `nestjs-testgen`
- If you used older package names, migrate with:

```bash
npm uninstall nest-testgen
npm i -D @waqas385/nestjs-testgen
```

Deprecated legacy package (if you published it): point users to this package with `npm deprecate <old-name> "Use @waqas385/nestjs-testgen"` after you publish the replacement.

Repository: [github.com/waqas385/nest-testgen](https://github.com/waqas385/nest-testgen).

## Support

If you run into problems while configuring or running this package, feel free to reach out by email at [waqas385@gmail.com](mailto:waqas385@gmail.com).
