import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const templatePath = resolve(root, 'Dockerfile.base');
const template = readFileSync(templatePath, 'utf8');

const targets = [
  {
    name: 'api',
    entrypoint: 'dist/server.js',
    devScript: 'dev:api',
  },
  {
    name: 'worker',
    entrypoint: 'dist/workers/main.js',
    devScript: 'dev:worker',
  },
  {
    name: 'bot',
    entrypoint: 'dist/workers/telegram-bot.js',
    devScript: 'dev:bot',
  },
];

for (const target of targets) {
  const filePath = resolve(root, `Dockerfile.${target.name}`);
  const rendered = template
    .replaceAll('__ENTRYPOINT__', target.entrypoint)
    .replaceAll('__DEV_SCRIPT__', target.devScript);

  writeFileSync(
    filePath,
    `# Generated from Dockerfile.base. Do not edit directly.\n${rendered}`,
    'utf8',
  );

  console.log(`Generated ${filePath}`);
}
