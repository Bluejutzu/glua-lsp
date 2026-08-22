// The rule catalogue, for `glua rules`.
//
// Codes appear in diagnostics and in `-- glua-ignore`; settings keys appear in
// .glua.json and VS Code settings. Keeping the mapping in one place is what
// stops the docs claiming a key that does not exist.

export interface RuleInfo {
  code: string;
  settingsKey: string;
  summary: string;
}

export const RULES: RuleInfo[] = [
  {
    code: 'syntax',
    settingsKey: '(always error)',
    summary: 'The file does not parse.',
  },
  {
    code: 'compound-assignment',
    settingsKey: '(always error)',
    summary: 'x += 1 is not valid Lua.',
  },
  {
    code: 'undefined-global',
    settingsKey: 'undefinedGlobal',
    summary: 'A global defined neither in the GMod API nor anywhere in the workspace.',
  },
  {
    code: 'global-write',
    settingsKey: 'globalWrite',
    summary: 'Writing to a global instead of declaring a local.',
  },
  {
    code: 'unused-local',
    settingsKey: 'unusedLocal',
    summary: 'A local that is declared but never read.',
  },
  {
    code: 'realm-violation',
    settingsKey: 'realmViolation',
    summary: 'Calling API that cannot exist in this file’s realm.',
  },
  {
    code: 'deprecated',
    settingsKey: 'deprecated',
    summary: 'API the wiki marks deprecated or removed.',
  },
  {
    code: 'argument-count',
    settingsKey: 'argumentCount',
    summary: 'Wrong number of arguments for a documented function.',
  },
  {
    code: 'argument-type',
    settingsKey: 'argumentType',
    summary: 'An argument whose type cannot match the documented parameter.',
  },
  {
    code: 'unknown-hook',
    settingsKey: 'unknownHook',
    summary: 'A hook name that is neither documented nor fired in this workspace.',
  },
  {
    code: 'duplicate-hook-identifier',
    settingsKey: 'duplicateIdentifier',
    summary: 'Two hook.Add calls sharing an event and identifier; the second wins.',
  },
  {
    code: 'duplicate-timer-name',
    settingsKey: 'duplicateIdentifier',
    summary: 'Two timer.Create calls sharing a name; the second replaces the first.',
  },
  {
    code: 'net-unregistered',
    settingsKey: 'netMessage',
    summary: 'net.Start on a message never passed to util.AddNetworkString.',
  },
  {
    code: 'net-never-dispatched',
    settingsKey: 'netMessage',
    summary: 'net.Start with no following Send, Broadcast or SendToServer.',
  },
  {
    code: 'net-never-received',
    settingsKey: 'netMessage',
    summary: 'A message that is sent but has no handler.',
  },
  {
    code: 'net-never-sent',
    settingsKey: 'netMessage',
    summary: 'A handler for a message nothing sends.',
  },
  {
    code: 'net-payload-mismatch',
    settingsKey: 'netReadWriteMismatch',
    summary: 'The write sequence does not match the read sequence in the handler.',
  },
  {
    code: 'missing-addcsluafile',
    settingsKey: 'missingAddCSLuaFile',
    summary: 'A clientside file that is included but never sent with AddCSLuaFile.',
  },
];
