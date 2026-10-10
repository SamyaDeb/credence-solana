import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
copyFileSync(new URL('../src/style.css', import.meta.url), new URL('../dist/style.css', import.meta.url));
