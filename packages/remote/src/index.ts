/**
 * Remote development access (R7-#1) — package entry.
 *
 * Server-only package (CJS single format, like tasktimeline/diagpack):
 * the desktop talks to it over HTTP only, never imports it.
 */
export * from './types';
export * from './store';
export * from './transport';
export * from './forward';
