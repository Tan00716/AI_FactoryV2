/**
 * Demo: build a repo map for a tiny fixture tree and print it.
 *
 * Run: npm run build -w @ai-factory/repomap && node packages/repomap/dist/demo/repomap.demo.js
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepoMapService } from '../src/index.js';

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-demo-'));
  try {
    await fs.writeFile(
      path.join(tmp, 'service.ts'),
      'export class UserService {\n  async getUser(id: string) { return { id }; }\n}\n' +
        'export function createService() { return new UserService(); }\n',
    );
    await fs.writeFile(
      path.join(tmp, 'main.ts'),
      "import { createService } from './service';\n" +
        'const svc = createService();\n' +
        'console.log(svc);\n',
    );
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'UserService is referenced here too.\n');
    const svc = new RepoMapService({
      cacheDir: path.join(tmp, 'cache'),
      roots: [tmp],
    });
    const { markdown, stats } = await svc.buildMap(tmp, { maxTokens: 4000 });
    console.log(`files=${stats.files} symbols=${stats.symbols} totalRefs=${stats.totalRefs} truncated=${stats.truncated}`);
    console.log(markdown);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
