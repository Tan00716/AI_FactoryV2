// Sample extension: one command. Runs inside the vm sandbox (see sandbox.ts):
// only the `api` global is available — no require, no process, no fs.
api.registerCommand('hello.echo', function (args) {
  const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : 'world';
  api.log('hello.echo called for ' + name);
  return { greeting: 'hello ' + name };
});
