import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mappings from './mappings.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const file of fs.readdirSync(path.join(__dirname, 'noir'), { recursive: true })) {
  if (file.endsWith('.nr.template')) {
    let libTemplate = fs.readFileSync(path.join(__dirname, 'noir', file), 'utf8');

    for (const [key, value] of Object.entries(mappings)) {
      libTemplate = libTemplate.replace(`{{${key}}}`, value);
    }

    fs.writeFileSync(path.join(__dirname, 'noir', file.replace('.nr.template', '.nr')), libTemplate);
  }
}
