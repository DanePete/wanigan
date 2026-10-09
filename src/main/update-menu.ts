import type { MessageBoxOptions } from 'electron';
import type { UpdateStatus } from '../shared/updates.ts';

interface Options {
  check: () => Promise<UpdateStatus | null>;
  show: (options: MessageBoxOptions) => Promise<{ response: number }>;
  version: () => string;
  open: (which: 'download' | 'notes') => void;
}

/** The native menu owns the complete check-and-dialog interaction. */
export function createUpdateMenu(options: Options): () => Promise<void> {
  let running: Promise<void> | null = null;
  const showResult = async (): Promise<void> => {
    const status = await options.check();
    if (!status) return;
    const show = options.show;
    if (status.state === 'available') {
      const { release } = status;
      const { response } = await show({
        type: 'info',
        message: `Wanigan ${release.version} is available`,
        detail: [
          `You have ${options.version()}. ${release.name}`,
          'To install it, quit Wanigan, open the disk image and drag Wanigan 2 into Applications, replacing this one. Your projects, boards and history stay. If sessions are running when the new version opens, it asks before restarting them.',
          'We are working with Apple so that Wanigan can soon update itself from inside the app.',
        ].join('\n\n'),
        buttons: ['Download', 'Release Notes', 'Later'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) options.open('download');
      else if (response === 1) options.open('notes');
      return;
    }
    if (status.state === 'failed') {
      await show({ type: 'warning', message: 'Could not check for updates', detail: status.message, buttons: ['OK'] });
      return;
    }
    await show({ type: 'info', message: 'Wanigan is up to date', detail: `${options.version()} is the newest version.`, buttons: ['OK'] });
  };
  return () => running ??= showResult().finally(() => { running = null; });
}
