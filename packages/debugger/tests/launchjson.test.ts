/**
 * launch.json parsing tests — comments, selection, normalization, and the
 * honest "unsupported type" rejections.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchJson, selectConfig, normalizeConfig, LaunchConfigError } from '../src/index';

const resolvePath = (p: string): string => `/root/${p}`;

describe('parseLaunchJson', () => {
  it('parses a normal launch.json', () => {
    const configs = parseLaunchJson(JSON.stringify({
      version: '0.2.0',
      configurations: [{ name: 'run', type: 'node', request: 'launch', program: 'app.js' }],
    }));
    assert.equal(configs.length, 1);
    assert.equal(configs[0].name, 'run');
  });

  it('strips // and /* */ comments', () => {
    const text = `{
      // launch the app
      "version": "0.2.0",
      /* multi
         line */
      "configurations": [ { "name": "a", "type": "node", "request": "launch", "program": "x.js" } ]
    }`;
    const configs = parseLaunchJson(text);
    assert.equal(configs.length, 1);
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseLaunchJson('{nope'), LaunchConfigError);
  });

  it('rejects a missing configurations array', () => {
    assert.throws(() => parseLaunchJson('{"version":"0.2.0"}'), LaunchConfigError);
  });
});

describe('selectConfig', () => {
  const configs = [
    { name: 'one', type: 'node', request: 'launch', program: 'a.js' },
    { name: 'two', type: 'node', request: 'attach', port: 9229 },
  ];
  it('selects by exact name', () => {
    assert.equal(selectConfig(configs, 'two').request, 'attach');
  });
  it('throws on unknown name, listing what exists', () => {
    assert.throws(() => selectConfig(configs, 'three'), /one, two/);
  });
});

describe('normalizeConfig', () => {
  it('normalizes a node launch config', () => {
    const n = normalizeConfig(
      { name: 'run', type: 'node', request: 'launch', program: 'app.js', args: ['--x'], env: { A: '1' }, stopOnEntry: true },
      resolvePath,
    );
    assert.equal(n.request, 'launch');
    assert.equal(n.adapter, 'node');
    assert.equal(n.program, '/root/app.js');
    assert.deepEqual(n.args, ['--x']);
    assert.deepEqual(n.env, { A: '1' });
    assert.equal(n.stopOnEntry, true);
  });

  it('accepts pwa-node and attach with port', () => {
    const n = normalizeConfig({ name: 'att', type: 'pwa-node', request: 'attach', port: 9230 }, resolvePath);
    assert.equal(n.request, 'attach');
    assert.equal(n.port, 9230);
    assert.equal(n.address, '127.0.0.1');
  });

  it('accepts debugpy as the python adapter placeholder (R7-#7 multi-language)', () => {
    const n = normalizeConfig({ name: 'py', type: 'debugpy', request: 'launch', program: 'a.py' }, resolvePath);
    assert.equal(n.adapter, 'python');
  });

  it('rejects unknown debug types honestly', () => {
    assert.throws(
      () => normalizeConfig({ name: 'rb', type: 'ruby', request: 'launch', program: 'a.rb' }, resolvePath),
      /not supported/,
    );
  });

  it('rejects launch without program', () => {
    assert.throws(
      () => normalizeConfig({ name: 'x', type: 'node', request: 'launch' }, resolvePath),
      /program/,
    );
  });

  it('rejects attach without port', () => {
    assert.throws(
      () => normalizeConfig({ name: 'x', type: 'node', request: 'attach' }, resolvePath),
      /port/,
    );
  });

  it('rejects unsupported console targets', () => {
    assert.throws(
      () => normalizeConfig({ name: 'x', type: 'node', request: 'launch', program: 'a.js', console: 'externalTerminal' }, resolvePath),
      /console/,
    );
  });

  it('rejects unknown request kinds', () => {
    assert.throws(
      () => normalizeConfig({ name: 'x', type: 'node', request: 'test', program: 'a.js' }, resolvePath),
      /launch.*attach/,
    );
  });
});
