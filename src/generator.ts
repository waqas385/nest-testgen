import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { sync as globSync } from 'glob';
import { Project, SourceFile, ClassDeclaration, SyntaxKind, Type, Node } from 'ts-morph';

interface GenerateOptions {
  projectRoot: string;
  outputDir: string;
  controllerGlob: string;
  testFileName: string;
  overwrite: boolean;
  setup: boolean;
  installTestDeps: boolean;
  runGeneratedTests: boolean;
  autoApprove: boolean;
  dryRun: boolean;
  jsonOutput: boolean;
}

interface EndpointInfo {
  controllerName: string;
  verb: string;
  route: string;
  fullPath: string;
  bodyExample: Record<string, unknown> | null;
}

interface GenerateResult {
  dryRun: boolean;
  projectRoot: string;
  outputFile: string;
  endpointCount: number;
  setupApplied: boolean;
  installedDependencies: string[];
  ranGeneratedTests: boolean;
  notes: string[];
}

type Logger = (message: string) => void;

export async function generateTests(options: GenerateOptions): Promise<GenerateResult> {
  const log: Logger = options.jsonOutput ? () => undefined : (message) => console.log(message);
  const projectRoot = path.resolve(options.projectRoot);
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }

  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  const controllerPattern = path.join(projectRoot, options.controllerGlob).replace(/\\/g, '/');
  const controllerPaths = globSync(controllerPattern, { nodir: true });

  if (controllerPaths.length === 0) {
    throw new Error(`No controller files found for pattern: ${controllerPattern}`);
  }

  const normalizedPaths = controllerPaths.map((controllerPath) => controllerPath.replace(/\\/g, '/'));
  project.addSourceFilesAtPaths(normalizedPaths);
  project.resolveSourceFileDependencies();

  const controllerFiles = project
    .getSourceFiles()
    .filter((sourceFile) => sourceFile.getFilePath().endsWith('.controller.ts'));

  if (controllerFiles.length === 0) {
    throw new Error(`No controller files loaded in the project.`);
  }

  const endpoints = controllerFiles.flatMap((file) => parseControllerFile(file, project));
  if (endpoints.length === 0) {
    throw new Error(`No endpoints parsed from controllers in ${controllerPattern}`);
  }

  const outputDirectory = path.resolve(projectRoot, options.outputDir);
  const outputFile = path.join(outputDirectory, options.testFileName);
  if (fs.existsSync(outputFile) && !options.overwrite) {
    throw new Error(`Output file already exists. Use --overwrite to replace it: ${outputFile}`);
  }

  if (options.dryRun) {
    const notes = await previewPlannedChanges({
      projectRoot,
      outputDirectory,
      outputFile,
      testFileName: options.testFileName,
      endpointCount: endpoints.length,
      setup: options.setup,
      installTestDeps: options.installTestDeps,
      runGeneratedTests: options.runGeneratedTests,
      logger: log,
    });
    return {
      dryRun: true,
      projectRoot,
      outputFile,
      endpointCount: endpoints.length,
      setupApplied: false,
      installedDependencies: [],
      ranGeneratedTests: false,
      notes,
    };
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const contents = buildTestFile(projectRoot, outputFile, endpoints);
  fs.writeFileSync(outputFile, contents, 'utf8');
  log(`Generated ${outputFile} with ${endpoints.length} endpoint templates.`);
  const notes: string[] = [];

  if (options.setup) {
    const setupResult = await setupTestingProject({
      projectRoot,
      outputDirectory,
      testFileName: options.testFileName,
      autoApprove: options.autoApprove,
    });
    const scriptName = upsertGeneratedTestScript(projectRoot, outputDirectory, options.testFileName, setupResult.jestConfigPath);
    log(`Updated Jest e2e config: ${path.relative(projectRoot, setupResult.jestConfigPath)}`);
    log(`Updated package script: ${scriptName}`);
    notes.push(`updated_jest_config:${path.relative(projectRoot, setupResult.jestConfigPath)}`);
    notes.push(`updated_script:${scriptName}`);
    if (setupResult.createdJestE2EConfig) {
      log(`Created missing Jest e2e config: ${path.relative(projectRoot, setupResult.jestConfigPath)}`);
      notes.push(`created_jest_e2e_config:${path.relative(projectRoot, setupResult.jestConfigPath)}`);
    }
    if (setupResult.addedScripts.length > 0) {
      log(`Added missing package scripts: ${setupResult.addedScripts.join(', ')}`);
      notes.push(`added_scripts:${setupResult.addedScripts.join(',')}`);
    }
    if (setupResult.addedPackageJestConfig) {
      log('Added missing package.json Jest configuration.');
      notes.push('added_package_jest_config');
    }
    if (setupResult.addedNestTestgenDependency) {
      log('Added nest-testgen to target project devDependencies.');
      notes.push('added_dev_dependency:nest-testgen');
    }
  }

  let installedDependencies: string[] = [];
  if (options.installTestDeps) {
    installedDependencies = installMissingTestDependencies(projectRoot, log);
  }

  if (options.runGeneratedTests) {
    runGeneratedTests(projectRoot, log);
  }

  return {
    dryRun: false,
    projectRoot,
    outputFile,
    endpointCount: endpoints.length,
    setupApplied: options.setup,
    installedDependencies,
    ranGeneratedTests: options.runGeneratedTests,
    notes,
  };
}

interface SetupResult {
  jestConfigPath: string;
  createdJestE2EConfig: boolean;
  addedScripts: string[];
  addedPackageJestConfig: boolean;
  addedNestTestgenDependency: boolean;
}

interface SetupOptions {
  projectRoot: string;
  outputDirectory: string;
  testFileName: string;
  autoApprove: boolean;
}

interface PreviewOptions {
  projectRoot: string;
  outputDirectory: string;
  outputFile: string;
  testFileName: string;
  endpointCount: number;
  setup: boolean;
  installTestDeps: boolean;
  runGeneratedTests: boolean;
  logger: Logger;
}

async function previewPlannedChanges(options: PreviewOptions): Promise<string[]> {
  const notes: string[] = [];
  options.logger('Dry run mode enabled. No files will be written.');
  options.logger(`Would generate ${options.outputFile} with ${options.endpointCount} endpoint templates.`);
  notes.push('dry_run');
  notes.push(`would_generate:${options.outputFile}`);

  if (options.setup) {
    const packageJsonPath = path.join(options.projectRoot, 'package.json');
    const packageJson = readJsonFile<Record<string, unknown>>(packageJsonPath);
    const scripts = ensureObjectRecord(packageJson.scripts);
    const devDependencies = ensureObjectRecord(packageJson.devDependencies);
    const dependencies = ensureObjectRecord(packageJson.dependencies);
    const desiredScripts = buildDefaultScripts(options.projectRoot, options.outputDirectory, options.testFileName);
    const missingScripts = Object.keys(desiredScripts).filter((name) => !scripts[name]);
    const jestConfigPath = resolveJestE2EConfigPath(options.projectRoot, scripts);
    const jestConfigExists = fs.existsSync(jestConfigPath);

    options.logger(`Would ensure Jest e2e config: ${jestConfigPath}`);
    notes.push(`would_ensure_jest_e2e_config:${jestConfigPath}`);
    if (!jestConfigExists) {
      options.logger(`- Would create ${path.relative(options.projectRoot, jestConfigPath)}`);
      notes.push(`would_create:${path.relative(options.projectRoot, jestConfigPath)}`);
    }
    options.logger('- Would ensure moduleNameMapper "^src/(.*)$" -> "<rootDir>/../src/$1"');
    notes.push('would_ensure_moduleNameMapper');

    if (missingScripts.length > 0) {
      options.logger(`- Would add missing package scripts: ${missingScripts.join(', ')}`);
      notes.push(`would_add_scripts:${missingScripts.join(',')}`);
    }
    if (!packageJson.jest) {
      options.logger('- Would add default Jest config in package.json');
      notes.push('would_add_package_jest_config');
    }
    if (!devDependencies['nest-testgen'] && !dependencies['nest-testgen']) {
      options.logger(`- Would add devDependency nest-testgen@^${getSelfVersion()}`);
      notes.push(`would_add_dev_dependency:nest-testgen@^${getSelfVersion()}`);
    }

    const generatedScript = `jest ${toPosix(path.relative(options.projectRoot, path.join(options.outputDirectory, options.testFileName)))} --config ./${toPosix(path.relative(options.projectRoot, jestConfigPath))} --runInBand`;
    options.logger(`- Would set test:e2e:generated = ${generatedScript}`);
    notes.push(`would_set_script:test:e2e:generated=${generatedScript}`);
  }

  if (options.installTestDeps) {
    const missingDeps = getMissingTestDependencies(options.projectRoot);
    if (missingDeps.length === 0) {
      options.logger('All required test dependencies are already installed.');
      notes.push('deps_already_installed');
    } else {
      options.logger(`Would install missing devDependencies: ${missingDeps.join(', ')}`);
      notes.push(`would_install_deps:${missingDeps.join(',')}`);
    }
  }

  if (options.runGeneratedTests) {
    options.logger('Would run: npm run test:e2e:generated');
    notes.push('would_run:npm run test:e2e:generated');
  }

  return notes;
}

async function setupTestingProject(options: SetupOptions): Promise<SetupResult> {
  const packageJsonPath = path.join(options.projectRoot, 'package.json');
  const packageJson = readJsonFile<Record<string, unknown>>(packageJsonPath);
  const scripts = ensureObjectRecord(packageJson.scripts);
  const desiredScripts = buildDefaultScripts(options.projectRoot, options.outputDirectory, options.testFileName);
  const devDependencies = ensureObjectRecord(packageJson.devDependencies);
  const dependencies = ensureObjectRecord(packageJson.dependencies);
  const hasNestTestgenDependency = Boolean(devDependencies['nest-testgen'] || dependencies['nest-testgen']);
  const shouldAddNestTestgenDependency = !hasNestTestgenDependency;
  const nestTestgenVersion = getSelfVersion();

  const missingScripts = Object.keys(desiredScripts).filter((name) => !scripts[name]);
  const shouldAddPackageJestConfig = !packageJson.jest;
  const jestConfigPath = resolveJestE2EConfigPath(options.projectRoot, scripts);
  const shouldCreateJestE2EConfig = !fs.existsSync(jestConfigPath);

  const plannedChanges: string[] = [];
  if (missingScripts.length > 0) {
    plannedChanges.push(`add package.json scripts: ${missingScripts.join(', ')}`);
  }
  if (shouldAddPackageJestConfig) {
    plannedChanges.push('add package.json Jest config');
  }
  if (shouldCreateJestE2EConfig) {
    plannedChanges.push(`create ${path.relative(options.projectRoot, jestConfigPath)}`);
  }
  if (shouldAddNestTestgenDependency) {
    plannedChanges.push(`add devDependency nest-testgen@^${nestTestgenVersion}`);
  }

  if (plannedChanges.length > 0) {
    const approved = await confirmSetupChanges(plannedChanges, options.autoApprove);
    if (!approved) {
      throw new Error('Setup changes were not approved. Re-run with --yes to auto-approve.');
    }
  }

  for (const scriptName of missingScripts) {
    scripts[scriptName] = desiredScripts[scriptName];
  }
  packageJson.scripts = scripts;

  if (shouldAddPackageJestConfig) {
    packageJson.jest = defaultPackageJestConfig();
  }
  if (shouldAddNestTestgenDependency) {
    devDependencies['nest-testgen'] = `^${nestTestgenVersion}`;
    packageJson.devDependencies = sortObjectByKey(devDependencies);
  }

  writeJsonFile(packageJsonPath, packageJson);
  upsertJestE2EConfig(jestConfigPath);

  return {
    jestConfigPath,
    createdJestE2EConfig: shouldCreateJestE2EConfig,
    addedScripts: missingScripts,
    addedPackageJestConfig: shouldAddPackageJestConfig,
    addedNestTestgenDependency: shouldAddNestTestgenDependency,
  };
}

function resolveJestE2EConfigPath(projectRoot: string, scripts: Record<string, string>): string {
  const configuredPath = extractJestConfigPathFromScript(scripts['test:e2e']);
  const fallbackPath = path.join(projectRoot, 'test', 'jest-e2e.json');
  return configuredPath ? path.resolve(projectRoot, configuredPath) : fallbackPath;
}

function buildDefaultScripts(projectRoot: string, outputDirectory: string, testFileName: string): Record<string, string> {
  const generatedSpecPath = toPosix(path.relative(projectRoot, path.join(outputDirectory, testFileName)));
  const outputDirArg = toPosix(path.relative(projectRoot, outputDirectory)) || '.';
  return {
    test: 'jest',
    'test:watch': 'jest --watch',
    'test:cov': 'jest --coverage',
    'test:e2e': 'jest --config ./test/jest-e2e.json',
    'test:e2e:generated': `jest ${generatedSpecPath} --config ./test/jest-e2e.json --runInBand`,
    'test:generate': `nest-testgen --project . --output ${outputDirArg} --test-file ${testFileName} --overwrite`,
  };
}

function defaultPackageJestConfig(): Record<string, unknown> {
  return {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
      '^.+\\.(t|j)s$': 'ts-jest',
    },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
  };
}

async function confirmSetupChanges(plannedChanges: string[], autoApprove: boolean): Promise<boolean> {
  if (autoApprove) {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `Setup changes need confirmation: ${plannedChanges.join('; ')}. ` +
        `Re-run with --yes to auto-approve these changes.`,
    );
  }

  console.log('The target project is missing test setup. Proposed changes:');
  for (const change of plannedChanges) {
    console.log(`- ${change}`);
  }

  const answer = await askQuestion('Apply these setup changes? (y/N): ');
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function upsertJestE2EConfig(jestConfigPath: string): void {
  if (!fs.existsSync(jestConfigPath)) {
    fs.mkdirSync(path.dirname(jestConfigPath), { recursive: true });
    writeJsonFile(jestConfigPath, defaultJestE2EConfig());
  }

  const jestConfig = readJsonFile<Record<string, unknown>>(jestConfigPath);
  const moduleNameMapper = ensureObjectRecord(jestConfig.moduleNameMapper);
  const srcMapperKey = '^src/(.*)$';
  const srcMapperValue = '<rootDir>/../src/$1';

  if (!moduleNameMapper[srcMapperKey]) {
    moduleNameMapper[srcMapperKey] = srcMapperValue;
    jestConfig.moduleNameMapper = moduleNameMapper;
    writeJsonFile(jestConfigPath, jestConfig);
  }

}

function defaultJestE2EConfig(): Record<string, unknown> {
  return {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    testEnvironment: 'node',
    testRegex: '.e2e-spec.ts$',
    transform: {
      '^.+\\.(t|j)s$': 'ts-jest',
    },
  };
}

function upsertGeneratedTestScript(
  projectRoot: string,
  outputDirectory: string,
  testFileName: string,
  jestConfigPath: string,
): string {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = readJsonFile<Record<string, unknown>>(packageJsonPath);
  const scripts = ensureObjectRecord(packageJson.scripts);
  const scriptName = 'test:e2e:generated';

  const relativeSpecPath = toPosix(path.relative(projectRoot, path.join(outputDirectory, testFileName)));
  const relativeJestConfigPath = toPosix(path.relative(projectRoot, jestConfigPath));
  scripts[scriptName] = `jest ${relativeSpecPath} --config ./${relativeJestConfigPath} --runInBand`;
  packageJson.scripts = scripts;

  writeJsonFile(packageJsonPath, packageJson);
  return scriptName;
}

function installMissingTestDependencies(projectRoot: string, logger: Logger): string[] {
  const missingDeps = getMissingTestDependencies(projectRoot);
  if (missingDeps.length === 0) {
    logger('All required test dependencies are already installed.');
    return [];
  }

  const command = `npm install --save-dev ${missingDeps.join(' ')}`;
  logger(`Installing missing test dependencies: ${missingDeps.join(', ')}`);
  execSync(command, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  return missingDeps;
}

function getMissingTestDependencies(projectRoot: string): string[] {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = readJsonFile<Record<string, unknown>>(packageJsonPath);
  const dependencies = ensureObjectRecord(packageJson.dependencies);
  const devDependencies = ensureObjectRecord(packageJson.devDependencies);
  const requiredDeps = [
    '@nestjs/testing',
    'jest',
    'ts-jest',
    '@types/jest',
    'supertest',
    '@types/supertest',
  ];

  return requiredDeps.filter((dep) => !dependencies[dep] && !devDependencies[dep]);
}

function runGeneratedTests(projectRoot: string, logger: Logger): void {
  const command = 'npm run test:e2e:generated';
  logger(`Running generated tests: ${command}`);
  execSync(command, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

function extractJestConfigPathFromScript(script: string | undefined): string | undefined {
  if (!script) {
    return undefined;
  }

  const configRegex = /--config\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/;
  const match = script.match(configRegex);
  return match ? match[1] || match[2] || match[3] : undefined;
}

function ensureObjectRecord(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, string>) };
  }
  return {};
}

function sortObjectByKey(value: Record<string, string>): Record<string, string> {
  return Object.keys(value)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = value[key];
      return acc;
    }, {});
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  const formatted = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, formatted, 'utf8');
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function getSelfVersion(): string {
  try {
    const selfPackageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const selfPackageJson = readJsonFile<{ version?: string }>(selfPackageJsonPath);
    return selfPackageJson.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function parseControllerFile(sourceFile: SourceFile, project: Project): EndpointInfo[] {
  const controllers = sourceFile.getClasses().filter((cls) => cls.getDecorator('Controller'));
  return controllers.flatMap((controller) => parseControllerClass(controller, project));
}

function parseControllerClass(controller: ClassDeclaration, project: Project): EndpointInfo[] {
  const controllerDecorator = controller.getDecorator('Controller');
  const controllerRoute = controllerDecorator ? getStringValue(controllerDecorator.getArguments()[0]) : '';

  return controller.getMethods().flatMap((method) => {
    const routeDecorator = method.getDecorators().find((decorator) => {
      const name = decorator.getName();
      return ['Get', 'Post', 'Patch', 'Put', 'Delete'].includes(name);
    });

    if (!routeDecorator) {
      return [];
    }

    const verb = routeDecorator.getName().toLowerCase();
    const methodRoute = getStringValue(routeDecorator.getArguments()[0]);
    const fullRoute = normalizeRoute(controllerRoute, methodRoute);
    const resolvedRoute = replaceRouteParams(fullRoute);

    const bodyParameter = method.getParameters().find((param) => param.getDecorator('Body'));
    const bodyExample = bodyParameter ? buildBodyExample(bodyParameter, project) : null;

    return [
      {
        controllerName: controller.getName() || 'UnknownController',
        verb,
        route: fullRoute,
        fullPath: resolvedRoute,
        bodyExample,
      },
    ];
  });
}

function getStringValue(node: Node | undefined): string {
  if (!node) {
    return '';
  }

  const text = node.getText().trim();
  if (text.startsWith('`') && text.endsWith('`')) {
    return text.slice(1, -1);
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }

  return '';
}

function normalizeRoute(baseRoute: string, methodRoute: string): string {
  const route = path.posix.join('/', baseRoute || '', methodRoute || '');
  const cleaned = route.replace(/\\/g, '/').replace(/\\/g, '/');
  return cleaned === '/' ? '/' : cleaned.replace(/\\/g, '/');
}

function replaceRouteParams(route: string): string {
  return route.replace(/:([^/]+)/g, '1');
}

function buildBodyExample(parameter: import('ts-morph').ParameterDeclaration, project: Project): Record<string, unknown> | null {
  const typeNode = parameter.getTypeNode();
  if (!typeNode) {
    return null;
  }

  const rawType = typeNode.getText();
  const cleanedType = extractTypeName(rawType);
  if (!cleanedType) {
    return null;
  }

  return createExampleObjectForType(cleanedType, project, new Set<string>());
}

function extractTypeName(typeText: string): string {
  const normalized = typeText.replace(/\s/g, '');
  const genericMatch = normalized.match(/^(?:Partial|Required|Readonly|Omit|Pick)<(.+)>$/i);
  if (genericMatch) {
    return extractTypeName(genericMatch[1]);
  }

  if (normalized.endsWith('[]')) {
    return extractTypeName(normalized.slice(0, -2));
  }

  const unionIndex = normalized.indexOf('|');
  if (unionIndex >= 0) {
    return extractTypeName(normalized.slice(0, unionIndex));
  }

  return normalized;
}

function createExampleObjectForType(typeName: string, project: Project, visited: Set<string>): Record<string, unknown> {
  if (visited.has(typeName)) {
    return {};
  }

  visited.add(typeName);
  const declaration = findTypeDeclaration(typeName, project);
  if (!declaration) {
    return {};
  }

  const properties = declaration.getProperties();
  const result: Record<string, unknown> = {};

  for (const property of properties) {
    const propName = property.getName();
    const propType = property.getType();
    result[propName] = exampleValueForType(propName, propType, project, visited);
  }

  return result;
}

function findTypeDeclaration(typeName: string, project: Project): import('ts-morph').ClassDeclaration | import('ts-morph').InterfaceDeclaration | undefined {
  const allDeclarations = project
    .getSourceFiles()
    .flatMap((sourceFile) => [
      ...sourceFile.getClasses().filter((declaration) => declaration.getName() === typeName),
      ...sourceFile.getInterfaces().filter((declaration) => declaration.getName() === typeName),
    ]);

  return allDeclarations[0];
}

function exampleValueForType(name: string, type: Type, project: Project, visited: Set<string>): unknown {
  const typeText = type.getText();

  if (type.isString() || typeText === 'string') {
    return exampleStringForName(name);
  }

  if (type.isNumber() || typeText === 'number') {
    return exampleNumberForName(name);
  }

  if (type.isBoolean() || typeText === 'boolean') {
    return true;
  }

  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      const example = exampleValueForType(name, elementType, project, visited);
      return [example];
    }
    return ['example'];
  }

  if (type.isEnum() || type.isEnumLiteral()) {
    const values = type.getUnionTypes();
    if (values.length > 0) {
      return exampleValueForType(name, values[0], project, visited);
    }
  }

  const symbol = type.getSymbol();
  const nestedName = symbol?.getName();
  if (nestedName && nestedName !== typeText && nestedName !== 'Object') {
    return createExampleObjectForType(extractTypeName(nestedName), project, visited);
  }

  if (typeText.startsWith('{') || typeText.includes('{')) {
    return {};
  }

  return exampleStringForName(name);
}

function exampleStringForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('email')) {
    return 'test@example.com';
  }
  if (lower.includes('password')) {
    return 'SecurePassword123!';
  }
  if (lower.includes('callingcode')) {
    return '+92';
  }
  if (lower.includes('phonenumber')) {
    return '3001234567';
  }
  if (lower.includes('otp')) {
    return '123456';
  }
  if (lower.includes('date')) {
    return '2025-01-01T00:00:00.000Z';
  }
  if (lower.includes('name')) {
    return `${name}-example`;
  }
  return 'example';
}

function exampleNumberForName(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes('otp')) {
    return 123456;
  }
  if (lower.includes('id')) {
    return 1;
  }
  return 42;
}

function buildTestFile(projectRoot: string, outputFile: string, endpoints: EndpointInfo[]): string {
  const appModuleImport = getAppModuleImportPath(projectRoot, outputFile);
  const endpointBlocks = endpoints
    .map((endpoint) => {
      const bodyPayload = endpoint.bodyExample ? JSON.stringify(endpoint.bodyExample, null, 2) : null;
      const bodySetup = bodyPayload ? `const body = ${bodyPayload};\n
        ` : '';
      const sendCall = bodyPayload && ['post', 'put', 'patch'].includes(endpoint.verb) ? `.send(body)` : '';

      return `  describe('${endpoint.verb.toUpperCase()} ${endpoint.route}', () => {
    it('should ${endpoint.verb} ${endpoint.route}', async () => {
      ${bodySetup}const response = await request(app.getHttpServer())
        .${endpoint.verb}('${endpoint.fullPath}')${sendCall};

      expect([200, 400, 401]).toContain(response.status);
    });
  });`;
    })
    .join('\n\n');

  return `import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '${appModuleImport}';

describe('Generated NestJS endpoint tests', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

${endpointBlocks}
});
`;
}

function getAppModuleImportPath(projectRoot: string, outputFile: string): string {
  const relativePath = path.relative(path.dirname(outputFile), path.join(projectRoot, 'src', 'app.module.ts'));
  const normalized = relativePath.replace(/\\/g, '/').replace(/\.ts$/, '');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}
