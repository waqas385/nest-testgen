import fs from 'fs';
import path from 'path';
import { sync as globSync } from 'glob';
import { Project, SourceFile, ClassDeclaration, SyntaxKind, Type, Node } from 'ts-morph';

interface GenerateOptions {
  projectRoot: string;
  outputDir: string;
  controllerGlob: string;
  testFileName: string;
  overwrite: boolean;
}

interface EndpointInfo {
  controllerName: string;
  verb: string;
  route: string;
  fullPath: string;
  bodyExample: Record<string, unknown> | null;
}

export async function generateTests(options: GenerateOptions): Promise<void> {
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
  fs.mkdirSync(outputDirectory, { recursive: true });

  const outputFile = path.join(outputDirectory, options.testFileName);
  if (fs.existsSync(outputFile) && !options.overwrite) {
    throw new Error(`Output file already exists. Use --overwrite to replace it: ${outputFile}`);
  }

  const contents = buildTestFile(projectRoot, outputFile, endpoints);
  fs.writeFileSync(outputFile, contents, 'utf8');
  console.log(`Generated ${outputFile} with ${endpoints.length} endpoint templates.`);
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
import request from 'supertest';
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
