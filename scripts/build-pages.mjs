import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const output = 'dist';
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) await cp(file, `${output}/${file}`);
const apiBase = process.env.WEATHER_API_BASE || '';
await writeFile(`${output}/config.js`, `window.WEATHER_API_BASE = ${JSON.stringify(apiBase)};\n`);
console.log(`Built Pages assets with ${apiBase ? 'the configured Worker API' : 'no Worker API URL'}.`);
