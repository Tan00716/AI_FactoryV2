#!/usr/bin/env node
/**
 * ai-factory — headless CLI entry point (W-D).
 *
 * Reads a piped prompt from stdin when stdin is not a TTY (so
 * `echo "do X" | ai-factory exec` works); --prompt always wins.
 * Prints human lines by default, raw JSON with --json, and exits
 * 0/1/2 per the contract in index.ts.
 */
import {
  parseArgs,
  usage,
  createHttpClient,
  resolveToken,
  execCommand,
  sessionsList,
  sessionsCreate,
  sessionsAttach,
  resumeSession,
  checkpointCreate,
  checkpointList,
  checkpointRestore,
  DEFAULT_API,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  EXIT_OK,
  EXIT_USAGE,
} from './index.ts';

function opt(o: Record<string, string | boolean>, name: string): string | undefined {
  const v = o[name];
  return typeof v === 'string' ? v : undefined;
}

function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolvePromise(null));
  });
}

function print(result: { exitCode: number; output: unknown }, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
  } else if (Array.isArray(result.output)) {
    for (const line of result.output) process.stdout.write(String(line) + '\n');
  } else {
    process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`error: ${parsed.error}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }
  const { command, sub, positionals, opts } = parsed;
  const asJson = opts['json'] === true;
  if (opts['help'] === true || command === '' || command === 'help') {
    process.stdout.write(usage() + '\n');
    return EXIT_OK;
  }

  const api = opt(opts, 'api') ?? process.env.AI_FACTORY_API ?? DEFAULT_API;
  const token = resolveToken(opt(opts, 'token'));
  const http = createHttpClient(api, token);
  const num = (name: string, dflt: number): number => {
    const v = opt(opts, name);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  try {
    switch (command) {
      case 'exec': {
        const piped = await readStdinIfPiped();
        const prompt = opt(opts, 'prompt') ?? opt(opts, 'p') ?? (piped ?? '');
        const result = await execCommand(
          {
            prompt,
            projectId: opt(opts, 'project'),
            agentId: opt(opts, 'agent'),
            json: asJson,
            timeoutMs: num('timeout-ms', DEFAULT_TIMEOUT_MS),
            pollMs: num('poll-ms', DEFAULT_POLL_MS),
          },
          http,
        );
        print(result, asJson);
        return result.exitCode;
      }
      case 'sessions': {
        if (sub === 'list' || sub === null) {
          const r = await sessionsList(http, asJson);
          print(r, asJson);
          return r.exitCode;
        }
        if (sub === 'create') {
          const r = await sessionsCreate(http, opt(opts, 'title') ?? '', opt(opts, 'project'), asJson);
          print(r, asJson);
          return r.exitCode;
        }
        if (sub === 'attach') {
          const r = await sessionsAttach(
            http,
            opt(opts, 'session') ?? '',
            opt(opts, 'run'),
            opt(opts, 'task'),
            asJson,
          );
          print(r, asJson);
          return r.exitCode;
        }
        process.stderr.write(`error: unknown sessions subcommand "${sub}"\n\n${usage()}\n`);
        return EXIT_USAGE;
      }
      case 'resume': {
        const r = await resumeSession(http, positionals[0] ?? '', asJson);
        print(r, asJson);
        return r.exitCode;
      }
      case 'checkpoint': {
        const sessionId = opt(opts, 'session') ?? '';
        if (sub === 'create') {
          const r = await checkpointCreate(http, sessionId, opt(opts, 'label'), opt(opts, 'code-root'), asJson);
          print(r, asJson);
          return r.exitCode;
        }
        if (sub === 'list') {
          const r = await checkpointList(http, sessionId, asJson);
          print(r, asJson);
          return r.exitCode;
        }
        if (sub === 'restore') {
          const r = await checkpointRestore(http, sessionId, opt(opts, 'id'), asJson);
          print(r, asJson);
          return r.exitCode;
        }
        process.stderr.write(`error: unknown checkpoint subcommand "${sub}"\n\n${usage()}\n`);
        return EXIT_USAGE;
      }
      default:
        process.stderr.write(`error: unknown command "${command}"\n\n${usage()}\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
