# @ai-factory/remote — Remote development access (R7-#1)

v1 scope (per the round-7 report): SSH remote file/terminal/task access.
WSL and container transports share the same command/file surface; a
`local` loopback transport exists for development and testing.

## What it is NOT

- Not a fallback: a failed probe on ssh/wsl/container never degrades to
  local execution. Exec/file ops on a non-online connection are refused
  (409 NOT_CONNECTED). `local` is a kind you choose explicitly.
- Not remote debugging or remote LSP — those are later deepenings.
- Not a credential store: there is no password/passphrase/privateKey
  field anywhere. `keyPath` is a path reference passed to the local
  `ssh` binary as `-i <path>`; the key file is never opened, logged,
  or audited by this code.
- Not persistent tunnels: port forwards are child processes tracked in
  memory. A server restart drops them; `listForwards` then reports
  nothing, honestly.

## Transports

All spawns use argv arrays with no shell. For ssh the remote side runs
through the remote shell, so remote arguments are single-quote escaped
(`shellQuote`) before joining. ssh runs with `BatchMode=yes`
(never prompts), `ConnectTimeout=10`, and `StrictHostKeyChecking=
accept-new` (new hosts are recorded, changed keys are refused).

- `probe`: runs `true` remotely; reports `{ online, latencyMs,
  reason }` and never throws for a failed probe.
- `listDir` / `readFile` / `writeFile`: paths are jailed to the
  connection's `remoteRoot` (`resolveRemotePath` rejects absolute
  paths and `..` escapes). Reads/writes cap at 512KB.
- `startForward` / `stopForward` / `listForwards`: ssh-only `-N -L`
  tunnels; a tunnel that exits within 500ms is reported as a failed
  start, not a phantom running forward.

## Store

`RemoteConnectionStore` persists to a JSON file with temp+rename
atomic writes. A corrupt file throws `STORE_CORRUPT` and is never
silently overwritten.
