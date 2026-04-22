# nest-testgen

Generate Jest/Supertest endpoint test scaffolding from NestJS controllers and DTOs.

## What it does

This package scans a NestJS project for controller classes, discovers routes and body DTOs, and generates a scaffolded `.spec.ts` file with request templates and example payloads.

It is intended for projects where DTOs are properly defined and the NestJS controllers use decorator metadata such as `@Controller`, `@Get`, `@Post`, `@Patch`, and `@Body()`.

## Usage

1. Install dependencies:

```bash
cd packages/nest-testgen
npm install
```

2. Install test dependencies in the NestJS project where you will run generated e2e tests:

```bash
npm install --save-dev @nestjs/testing jest ts-jest @types/jest supertest
```

3. Generate tests for your NestJS project:

```bash
npm run dev -- --project ../../ --output generated-tests
```

4. Add a script in your NestJS project's `package.json` to run the generated e2e file:

```json
{
  "scripts": {
    "test:e2e:generated": "jest generated-tests/generated.e2e-spec.ts --runInBand"
  }
}
```

5. Run the generated tests:

```bash
npm run test:e2e:generated
```

6. The scaffolded test file will be written to the configured output directory.

## CLI Options

- `--project <path>`: NestJS project root (default: `.`)
- `--output <path>`: Output directory for generated tests (default: `generated-tests`)
- `--controllers <glob>`: Controller glob pattern (default: `src/**/*.controller.ts`)
- `--test-file <name>`: Output file name (default: `generated.e2e-spec.ts`)
- `--overwrite`: Overwrite existing generated test file

## Example

```bash
npm run dev -- --project ../../ --output ../../test/generated-tests --test-file generated.e2e-spec.ts --overwrite
```

## Notes

- The package uses `ts-morph` to analyze TypeScript AST and extract route and DTO metadata.
- Generated payload values are best-effort examples and may need manual adjustment for application-specific business logic.
