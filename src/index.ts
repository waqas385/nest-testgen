#!/usr/bin/env node
import { Command } from 'commander';
import { generateTests } from './generator';

const program = new Command();

program
  .name('nestjs-testgen')
  .description('Generate and wire Jest/Supertest endpoint tests for NestJS projects.')
  .option('-p, --project <path>', 'Path to the NestJS project root', '.')
  .option('-o, --output <path>', 'Output directory for generated tests', 'generated-tests')
  .option('-c, --controllers <glob>', 'Controller glob pattern', 'src/**/*.controller.ts')
  .option('-t, --test-file <name>', 'Generated test file name', 'generated.e2e-spec.ts')
  .option('--overwrite', 'Overwrite existing output file', false)
  .option('--no-setup', 'Skip updating Jest e2e config and package scripts')
  .option('--install-test-deps', 'Install missing Nest e2e test devDependencies', false)
  .option('--run-generated-tests', 'Run generated test suite after generation', false)
  .option('-y, --yes', 'Auto-approve project setup changes', false)
  .option('--dry-run', 'Preview planned changes without writing files', false)
  .option('--json', 'Emit machine-readable JSON output', false)
  .action(async (options) => {
    try {
      const result = await generateTests({
        projectRoot: options.project,
        outputDir: options.output,
        controllerGlob: options.controllers,
        testFileName: options.testFile,
        overwrite: options.overwrite,
        setup: options.setup,
        installTestDeps: options.installTestDeps,
        runGeneratedTests: options.runGeneratedTests,
        autoApprove: options.yes,
        dryRun: options.dryRun,
        jsonOutput: options.json,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } catch (error) {
      if (options.json) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
      } else {
        console.error('Error generating tests:', error instanceof Error ? error.message : error);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);

