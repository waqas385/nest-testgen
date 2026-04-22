import { Command } from 'commander';
import { generateTests } from './generator';

const program = new Command();

program
  .name('nest-testgen')
  .description('Generate Jest/Supertest tests from NestJS controllers and DTOs.')
  .option('-p, --project <path>', 'Path to the NestJS project root', '.')
  .option('-o, --output <path>', 'Output directory for generated tests', 'generated-tests')
  .option('-c, --controllers <glob>', 'Controller glob pattern', 'src/**/*.controller.ts')
  .option('-t, --test-file <name>', 'Generated test file name', 'generated.e2e-spec.ts')
  .option('--overwrite', 'Overwrite existing output file', false)
  .action(async (options) => {
    try {
      await generateTests({
        projectRoot: options.project,
        outputDir: options.output,
        controllerGlob: options.controllers,
        testFileName: options.testFile,
        overwrite: options.overwrite,
      });
    } catch (error) {
      console.error('Error generating tests:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse(process.argv);

