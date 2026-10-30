// Sample extension: provider-only contributions run inside the vm sandbox
// (see sandbox.ts): only the `api` global is available — no require,
// no process, no fs.
api.registerContextProvider('demo.notes', function (args) {
  var q = typeof args.query === 'string' ? args.query : '';
  return [{ label: 'note:' + q, text: 'note body for ' + q }];
});
