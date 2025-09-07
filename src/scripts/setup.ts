import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mappings from '../mappings.js';
import { defaultConfig } from '../config.js';
const { noir, rename } = mappings;

const noirDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'noir');

for (const file of fs.readdirSync(noirDir, { recursive: true })) {
  if (typeof file === 'string' && file.endsWith('.template')) {
    let libTemplate = fs.readFileSync(path.join(noirDir, file), 'utf8');

    for (const [key, value] of Object.entries(noir)) {
      // @ts-expect-error
      libTemplate = libTemplate.replaceAll(`{{${key}}}`, value[defaultConfig[rename[key] ?? key]]);
    }

    if (!libTemplate.includes('{{'))
      fs.writeFileSync(path.join(noirDir, file.replace('.template', '')), libTemplate);
  }
}
