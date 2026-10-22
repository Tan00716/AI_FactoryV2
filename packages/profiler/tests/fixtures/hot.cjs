/**
 * CPU hotspot fixture: burns real CPU inside a NAMED function (`hotLoop`)
 * so the profiler test can assert the hotspot shows up in the top-N.
 * Runs ~1.8s of wall clock.
 */
function hotLoop(iterations) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc += Math.sqrt(i) * Math.sin(i);
  }
  return acc;
}

function main() {
  const t0 = Date.now();
  let total = 0;
  while (Date.now() - t0 < 1800) {
    total += hotLoop(200000);
  }
  if (process.env.AIF_PRINT) console.log(total);
}

main();
