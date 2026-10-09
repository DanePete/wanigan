// Runtime booleans must be booleans: "false" must not tick a criterion, and
// a malformed preview must not fall through to a filesystem write.
import { CoreError, type Method, type Params } from '../shared/protocol.ts';

type BooleanKeys<T> = { [K in keyof T]-?: [T[K]] extends [never] ? never : NonNullable<T[K]> extends boolean ? K : never }[keyof T];
type BooleanParams = { [M in Method as BooleanKeys<Params<M>> extends never ? never : M]: Record<BooleanKeys<Params<M>>, true> };

// The mapped type requires every boolean parameter in Methods, including any
// added later. These are validation fields, not another authority allowlist.
const FIELDS: BooleanParams = {
  'projects.update': { isolate: true },
  'projects.pause': { wrapUp: true },
  'git.scan': { amend: true },
  'git.commit': { amend: true, agentsAcknowledged: true },
  'git.log': { all: true },
  'git.switch': { remote: true },
  'git.createBranch': { checkout: true },
  'git.deleteBranch': { force: true },
  'git.resolve': { asIs: true, keepMarkers: true, remove: true },
  'git.stashSave': { untracked: true },
  'git.stashApply': { pop: true },
  'git.pull': { merge: true },
  'accounts.refreshUsage': { force: true },
  'cards.merge': { resolve: true },
  'criteria.update': { done: true },
  'sessions.list': { live: true },
  'sessions.start': { isolate: true, remote: true },
  'skills.copy': { preview: true, overwrite: true },
  'mcp.add': { preview: true },
  'mcp.remove': { preview: true },
  'phone.setControl': { control: true },
  'files.write': { anyway: true },
  'files.list': { installed: true },
};

export function validateBooleans(method: Method, params: object): void {
  const fields = (FIELDS as Partial<Record<Method, object>>)[method];
  const values = params as Record<string, unknown>;
  for (const key of Object.keys(fields ?? {})) {
    if (values[key] !== undefined && typeof values[key] !== 'boolean') {
      throw new CoreError('invalid', `${key} must be true or false.`);
    }
  }
}
