// What each kind of need is called, and what it asks of the owner: the same
// words on the Mac's Needs you and on the phone.
import type { NeedKind } from '@shared/model';

export const NEED_GROUP: Record<NeedKind, { title: string; hint: string }> = {
  permission: { title: 'Asking permission', hint: 'An agent is stopped until you answer in its terminal.' },
  starting: { title: 'Has not started', hint: 'An agent has not reported starting. A new folder makes it ask whether to trust it.' },
  overlap: { title: 'Two sessions, one file', hint: 'Live sessions in the same folder edited the same file. Give one its own branch, or stop one.' },
  limit: { title: 'Hit a usage limit', hint: 'Carry on with another account, or wait for the reset.' },
  review: { title: 'Ready for review', hint: 'Submitted with evidence. Approve it or send it back.' },
  question: { title: 'Questions', hint: 'An agent asked you something on its card.' },
  failed: { title: 'Failed', hint: 'The process exited with an error.' },
  interrupted: { title: 'Interrupted', hint: 'The process was lost, for example when the Mac restarted.' },
  quiet: { title: 'Gone quiet', hint: 'Working, but nothing has happened for a while.' },
  waiting: { title: 'Finished a turn', hint: 'Waiting at its prompt for what to do next.' },
};
