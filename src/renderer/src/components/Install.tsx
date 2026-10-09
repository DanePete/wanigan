// How to install a missing CLI, from the one table the core's refusals use too.
import { Fragment } from 'react';
import { INSTALL, type Cli } from '@shared/clis';

/** "Install it with `…`, or `…`." The commands are code, to copy into a terminal. */
export function InstallHint({ cli }: { cli: Cli }) {
  return (
    <span className="install-hint">
      Install it with {INSTALL[cli].map((command, i) => (
        <Fragment key={command}>{i ? ', or ' : null}<code>{command}</code></Fragment>
      ))}.
    </span>
  );
}
