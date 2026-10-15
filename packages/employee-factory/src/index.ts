/**
 * @ai-factory/employee-factory — dynamic AI employee factory (spec §18, §19, §59).
 *
 * Modules:
 *  - factory     specialty templates + createEmployee        [§18]
 *  - governance  policy enforcement before creation           [§19]
 *  - proposals   self-modification proposal decisions         [§59]
 *  - project-policy  default policies + minimal policy store   [§19/INV-08]
 */
export * from './factory';
export * from './governance';
export * from './proposals';
export * from './project-policy';
