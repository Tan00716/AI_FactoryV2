// Real debug target for node-adapter end-to-end tests.
// Keep line numbers stable — tests assert on them.
function compute(n) {
  const doubled = n * 2; // LINE 4: breakpoint here
  return doubled + 1; // LINE 5: step lands here
}
const out = compute(21); // LINE 7
console.log('out=', out); // LINE 8
