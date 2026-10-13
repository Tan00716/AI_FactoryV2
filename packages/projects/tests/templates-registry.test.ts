/**
 * Template registry — SPEC v2 §6.1 "模板不是全部内置，必须可扩展" (Batch 33).
 *
 * Pinned:
 *  - the five builtins stay pinned (register cannot shadow them,
 *    unregister refuses them with TEMPLATE_BUILTIN);
 *  - register/unregister/list round-trip; unknown names are loud;
 *  - validation rejects path-traversal file keys, absolute paths,
 *    empty file maps, bad slugs;
 *  - createProject resolves against the injected registry, so a
 *    registered template scaffolds real files on disk.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectTemplateRegistry,
  TemplateRegistrationError,
  createProject,
  getTemplate,
  listTemplates,
} from '../src/index';

const GOOD_DEF = {
  name: 'godot-2d',
  description: 'Godot 2D game skeleton',
  language: 'gdscript',
  framework: 'godot',
  packageManager: 'none',
  files: {
    'project.godot': '[application]\nname="Demo"\n',
    'main.gd': 'extends Node2D\n',
  },
};

describe('template registry (Batch 33)', () => {
  it('defaults to the five builtins, marked builtin', () => {
    const r = new ProjectTemplateRegistry();
    const list = r.list();
    assert.equal(list.length, 5);
    assert.ok(list.every((e) => e.builtin));
    assert.deepEqual(
      list.map((e) => e.name).sort(),
      ['electron', 'nextjs-saas', 'node-api', 'python-api', 'react'],
    );
    // legacy helpers delegate to the default registry
    assert.equal(getTemplate('react').framework, 'react');
    assert.equal(listTemplates().length, 5);
  });

  it('register/list/get round-trip; registered entries are not builtin', () => {
    const r = new ProjectTemplateRegistry();
    r.register(GOOD_DEF);
    const list = r.list();
    assert.equal(list.length, 6);
    const added = list.find((e) => e.name === 'godot-2d')!;
    assert.equal(added.builtin, false);
    assert.ok(!('files' in added), 'list() must not leak file contents');
    const full = r.get('godot-2d');
    assert.equal(full.files['main.gd'], 'extends Node2D\n');
    // mutating the returned copy must not corrupt the registry
    full.files['main.gd'] = 'MUTATED';
    assert.equal(r.get('godot-2d').files['main.gd'], 'extends Node2D\n');
  });

  it('builtin names cannot be shadowed or unregistered', () => {
    const r = new ProjectTemplateRegistry();
    assert.throws(
      () => r.register({ ...GOOD_DEF, name: 'react' }),
      (e: unknown) =>
        e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_EXISTS',
    );
    assert.throws(
      () => r.unregister('react'),
      (e: unknown) =>
        e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_BUILTIN',
    );
    // the builtin is still there
    assert.equal(r.get('react').framework, 'react');
  });

  it('duplicate registration is rejected; unregister works', () => {
    const r = new ProjectTemplateRegistry();
    r.register(GOOD_DEF);
    assert.throws(
      () => r.register(GOOD_DEF),
      (e: unknown) =>
        e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_EXISTS',
    );
    r.unregister('godot-2d');
    assert.equal(r.list().length, 5);
    assert.throws(
      () => r.unregister('godot-2d'),
      (e: unknown) =>
        e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_NOT_FOUND',
    );
  });

  it('unknown template names are loud', () => {
    const r = new ProjectTemplateRegistry();
    assert.throws(
      () => r.get('nope'),
      (e: unknown) =>
        e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_NOT_FOUND',
    );
  });

  it('validation rejects bad slugs, traversal paths, absolute paths', () => {
    const r = new ProjectTemplateRegistry();
    const bad = [
      { ...GOOD_DEF, name: 'Bad_Name' },
      { ...GOOD_DEF, name: '../evil' },
      { ...GOOD_DEF, name: '' },
      { ...GOOD_DEF, files: {} },
      { ...GOOD_DEF, files: { '../evil.txt': 'x' } },
      { ...GOOD_DEF, files: { '/abs/path.txt': 'x' } },
      { ...GOOD_DEF, files: { 'a/../../b.txt': 'x' } },
      { ...GOOD_DEF, files: { 'win\\sep.txt': 'x' } },
      { ...GOOD_DEF, files: { 'ok.txt': 42 } },
      { ...GOOD_DEF, description: '' },
    ];
    for (const def of bad) {
      assert.throws(
        () => r.register(def as never),
        (e: unknown) =>
          e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_INVALID',
        JSON.stringify(def.name ?? def.files),
      );
    }
    assert.equal(r.list().length, 5, 'no invalid template may stick');
  });

  it('createProject resolves against the injected registry', () => {
    const r = new ProjectTemplateRegistry();
    r.register(GOOD_DEF);
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'));
    try {
      const created = createProject({ name: 'demo', template: 'godot-2d', dir, registry: r });
      assert.equal(created.template, 'godot-2d');
      // createProject nests under dir when dir's basename !== name
      assert.ok(existsSync(join(dir, 'demo', 'main.gd')));
      assert.equal(readFileSync(join(dir, 'demo', 'main.gd'), 'utf8'), 'extends Node2D\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createProject with an unknown template name is loud', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'));
    try {
      assert.throws(
        () => createProject({ name: 'demo', template: 'nope', dir }),
        (e: unknown) =>
          e instanceof TemplateRegistrationError && e.code === 'TEMPLATE_NOT_FOUND',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
