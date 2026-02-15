import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swaggerSpec } from '../src/config/swagger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, '../openapi/openapi.json');

async function run() {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(swaggerSpec, null, 2), 'utf8');
  console.log(`OpenAPI spec exported: ${outputPath}`);
}

run().catch((error) => {
  console.error('Failed to export OpenAPI spec:', error);
  process.exitCode = 1;
});

