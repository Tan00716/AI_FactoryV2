/**
 * parseUnifiedDiff tests (W-F).
 * Run: node --test packages/git/dist/tests/diff.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/index.js';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 changed
+line3 added
 line4
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/img.png b/img.png
index 5555555..6666666 100644
Binary files a/img.png and b/img.png differ
diff --git a/r1.ts b/r2.ts
similarity index 90%
rename from r1.ts
rename to r2.ts
index 7777777..8888888 100644
--- a/r1.ts
+++ b/r2.ts
@@ -1 +1 @@
-same
+same!
`;

describe('parseUnifiedDiff', () => {
  it('parses modified file with correct line numbers', () => {
    const { files } = parseUnifiedDiff(SAMPLE);
    const f = files.find((x) => x.to === 'src/a.ts')!;
    assert.equal(f.change, 'modified');
    assert.equal(f.hunks.length, 1);
    const lines = f.hunks[0].lines;
    assert.deepEqual(
      lines.map((l) => [l.type, l.oldNo, l.newNo]),
      [
        ['context', 1, 1],
        ['del', 2, null],
        ['add', null, 2],
        ['add', null, 3],
        ['context', 3, 4],
      ],
    );
    assert.equal(lines[1].text, 'line2');
  });

  it('classifies added / deleted / binary / renamed files', () => {
    const { files } = parseUnifiedDiff(SAMPLE);
    assert.equal(files.find((x) => x.to === 'new.txt')!.change, 'added');
    assert.equal(files.find((x) => x.from === 'old.txt')!.change, 'deleted');
    const bin = files.find((x) => x.to === 'img.png')!;
    assert.equal(bin.binary, true);
    assert.equal(bin.hunks.length, 0);
    const ren = files.find((x) => x.to === 'r2.ts')!;
    assert.equal(ren.change, 'renamed');
    assert.equal(ren.from, 'r1.ts');
  });

  it('handles empty and garbage input without throwing', () => {
    assert.deepEqual(parseUnifiedDiff(''), { files: [] });
    assert.deepEqual(parseUnifiedDiff('not a diff\nat all\n'), { files: [] });
  });

  it('keeps hunk headers verbatim', () => {
    const { files } = parseUnifiedDiff(SAMPLE);
    assert.ok(files[0].hunks[0].header.startsWith('@@ -1,3 +1,4 @@'));
  });
});
