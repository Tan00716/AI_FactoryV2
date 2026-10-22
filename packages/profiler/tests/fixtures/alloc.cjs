/**
 * Heap fixture: retains 30000 instances of a NAMED class (`LeakWidget`)
 * in a global so the exit-hook snapshot must contain them.
 */
class LeakWidget {
  constructor(i) {
    this.id = i;
    this.payload = 'x'.repeat(64);
    this.tags = [i, i + 1];
  }
}

const keep = [];
for (let i = 0; i < 30000; i++) {
  keep.push(new LeakWidget(i));
}
// Must stay reachable at process exit, when the preload writes the snapshot.
globalThis.__aifKeep = keep;
