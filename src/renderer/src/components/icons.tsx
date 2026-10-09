// One small icon set, drawn on a 20px grid with a 1.6 stroke. Icons label
// nothing on their own: every use has text or an aria-label beside it.
import type { SVGProps } from 'react';

const paths = {
  needs: 'M10 3.2c2.7 3.1 4.6 5.6 4.6 8.1a4.6 4.6 0 1 1-9.2 0c0-2.5 1.9-5 4.6-8.1Z',
  running: 'M2.5 10h3l2-5 3.5 10 2-5h4.5',
  board: 'M3.5 4h3.6v12H3.5zM8.2 4h3.6v8.5H8.2zM12.9 4h3.6v5.5h-3.6z',
  list: 'M7 5.5h10M7 10h10M7 14.5h10M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01',
  sessions: 'M3.5 4.5h13v11h-13zM6.5 8.5l2 1.8-2 1.8M10.5 12.5h3',
  decisions: 'M5 3.5h10v13l-5-3-5 3z',
  activity: 'M3 10h2.5M7 6.5h2.5M7 13.5h2.5M11 10h6M5.5 10a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z',
  plus: 'M10 4.5v11M4.5 10h11',
  search: 'M8.7 14a5.3 5.3 0 1 0 0-10.6 5.3 5.3 0 0 0 0 10.6ZM12.6 12.6 16.5 16.5',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  play: 'M6.5 4.5v11l9-5.5z',
  stop: 'M5.5 5.5h9v9h-9z',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  folder: 'M3 5.5h4.5l1.5 1.8H17v8.2H3z',
  file: 'M5.5 3h6l3.5 3.5V17h-9.5zM11.5 3v3.5H15',
  link: 'M8.5 11.5l3-3M7.3 9.2l-1.7 1.7a2.6 2.6 0 0 0 3.7 3.7l1.7-1.7M12.7 10.8l1.7-1.7a2.6 2.6 0 0 0-3.7-3.7l-1.7 1.7',
  note: 'M4.5 4.5h11v8l-3.5 3.5h-7.5zM15.5 12.5H12V16',
  chevron: 'M8 5.5l4.5 4.5L8 14.5',
  back: 'M12 5.5L7.5 10l4.5 4.5',
  send: 'M3.5 10l13-6-4.5 13-2.5-5.5z',
  reply: 'M8 6 4 10l4 4M4.5 10H12a4 4 0 0 1 4 4v1.5',
  terminal: 'M3.5 4.5h13v11h-13zM6.5 8.5l2 1.8-2 1.8M10.5 12.5h3',
  pin: 'M7 3.5h6M8 3.5v4.2l-2.5 2.8h9L12 7.7V3.5M10 10.5v6',
  open: 'M11.5 4h4.5v4.5M16 4l-6.5 6.5M14 11.5V16H4V6h4.5',
  promote: 'M10 15.5v-9M6 10l4-4 4 4M4.5 4h11',
  reopen: 'M4.5 10a5.5 5.5 0 1 0 1.7-4M4.5 4v3.5H8',
  sun: 'M10 13.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3',
  moon: 'M15.5 12.4A6 6 0 0 1 7.6 4.5a6 6 0 1 0 7.9 7.9Z',
  auto: 'M10 16.5a6.5 6.5 0 1 0 0-13zM10 3.5a6.5 6.5 0 1 0 0 13',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  question: 'M7.7 7.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.5M10 14.5h.01',
  alert: 'M10 3.5l7 12.5H3zM10 8.5v3.5M10 14h.01',
  pause: 'M7.5 5v10M12.5 5v10',
  resume: 'M7 5l8 5-8 5z',
  settings: 'M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7M12.5 4v4M7.5 12v4',
  account: 'M10 10a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM4 16.5c.9-2.6 3.2-4 6-4s5.1 1.4 6 4',
  history: 'M3 10a7 7 0 1 0 7-7 7.6 7.6 0 0 0-5.25 2.13L3 6.9M3 3.1v3.8h3.8M10 6.3V10l3 1.5',
  claude: 'M10 3.5v13M4.4 6.75l11.2 6.5M15.6 6.75l-11.2 6.5',
  codex: 'M10 3.2l5.9 3.4v6.8L10 16.8l-5.9-3.4V6.6zM7.7 8.4l2.1 1.6-2.1 1.6M10.9 11.7h1.6',
  refresh: 'M15.5 8A5.7 5.7 0 0 0 5 6.2M4.5 12a5.7 5.7 0 0 0 10.5 1.8M15.8 3.8V8h-4.2M4.2 16.2V12h4.2',
  skill: 'M4.5 4h8.5l2.5 2.5V16h-11zM7.5 8.5h5M7.5 11h5M7.5 13.5h3',
  copy: 'M7 7h9v9.5H7zM13 7V3.5H4V13h3',
  plug: 'M7.5 3v3.5M12.5 3v3.5M5 6.5h10v3a5 5 0 0 1-10 0zM10 14.5V17',
  sidebar: 'M3.5 4.5h13v11h-13zM8 4.5v11',
  attach: 'M14.5 9.2l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-5.8 5.8a1 1 0 0 1-1.5-1.5L11.7 6',
  image: 'M3.5 4.5h13v11h-13zM3.5 13l4-4 3.5 3.5 2-2 3.5 3.5M12.5 8h.01',
  gemini: 'M10 2.5c.6 4 3.5 6.9 7.5 7.5-4 .6-6.9 3.5-7.5 7.5-.6-4-3.5-6.9-7.5-7.5 4-.6 6.9-3.5 7.5-7.5z',
  local: 'M4 5h12v8H4zM2.5 15.5h15M8.5 13v2.5M11.5 13v2.5',
  remote: 'M10 11v5.5M7.5 16.5h5M7.2 8.2a3.9 3.9 0 0 1 5.6 0M4.7 5.7a7.5 7.5 0 0 1 10.6 0M10 11h.01',
  phone: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM9 15h2',
  // git: a branch, a merge, a commit, a pull request, the stash, push and pull, discard.
  branch: 'M6 6.3v7.4M7.8 4.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM7.8 15.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM15.8 6.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM14 8.3c0 3.8-8 2.4-8 5.4',
  merge: 'M6 6.3v7.4M7.8 4.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM7.8 15.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM15.8 11a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM6 6.3c0 2.8 2.6 4.7 6.2 4.7',
  commit: 'M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 10H7M13 10h4.5',
  pr: 'M6 6.3v7.4M7.8 4.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM7.8 15.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM15.8 15.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM14 13.7V9a2.5 2.5 0 0 0-2.5-2.5H9M10.8 4.7 9 6.5l1.8 1.8',
  stash: 'M3.5 11.5h3.6l1 2h3.8l1-2h3.6V16h-13zM3.5 11.5l2-6.5h9l2 6.5M7.5 8.3h5',
  push: 'M10 14.5V4.5M6 8.5l4-4 4 4M4.5 16.5h11',
  pull: 'M10 3.5v10M6 9.5l4 4 4-4M4.5 16.5h11',
  trash: 'M4.5 6h11M8 6V4.3h4V6M6 6l.8 10.2h6.4L14 6',
  // the live view: a page, picking an element, a screenshot, pieces of a page.
  live: 'M3 4.5h14v11H3zM3 7.5h14M5.3 6h.01M7.3 6h.01',
  pick: 'M10 2.8v3M10 14.2v3M2.8 10h3M14.2 10h3M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  camera: 'M3.5 6.5h3l1.5-2h4l1.5 2h3v9h-13zM10 13.2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  pieces: 'M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z',
  // what made a part of a live page, and what can be done to it by hand.
  layers: 'M10 3.5 17 7l-7 3.5L3 7zM3 10.5l7 3.5 7-3.5M3 14l7 3.5 7-3.5',
  region: 'M3.5 4h13v12h-13zM3.5 8h13M3.5 12.5h13',
  block: 'M4 4.5h12v11H4zM7 8h6M7 11h4',
  field: 'M3.5 7h13v6h-13zM6.2 9v2',
  menu: 'M4 6h12M4 10h12M4 14h12',
  form: 'M3.5 5h13v4h-13zM3.5 11h13v4h-13z',
  content: 'M5 3h10v14H5zM7.5 6.5h5M7.5 9.5h5M7.5 12.5h3',
  pencil: 'M12.5 4.5l3 3L8 15H5v-3zM11 6l3 3',
  brush: 'M14.5 3.5c1 1-3.8 7-5.3 8.5l-1.7-1.7C9 8.8 13.5 2.5 14.5 3.5ZM7.5 10.3c-2 0-3.2 1.4-3.2 3.2 0 1.2-.6 2-1.3 2.5 3.4.6 6.2-.7 6.2-3.9',
  desktop: 'M3 4.5h14v9H3zM7.5 16.5h5M10 13.5v3',
  tablet: 'M5.5 3h9v14h-9zM9 14.5h2',
  eye: 'M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5ZM10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  undo: 'M7.5 6 4 9.5 7.5 13M4.5 9.5H12a4 4 0 0 1 0 8h-2',
  code: 'M7 6 3 10l4 4M13 6l4 4-4 4M11.2 4.5l-2.4 11',
  save: 'M4 3.5h9.5l2.5 2.5v10.5H4zM7 3.5v4h6v-4M7 16.5v-5h6v5',
  forward: 'M8 5.5l4.5 4.5L8 14.5',
  down: 'M5.5 8l4.5 4.5L14.5 8',
  up: 'M5.5 12l4.5-4.5 4.5 4.5',
  dockBottom: 'M3.5 4h13v12h-13zM3.5 11.5h13',
  dockRight: 'M3.5 4h13v12h-13zM11.5 4v12',
  wrap: 'M3.5 5h13M3.5 10h11a2.5 2.5 0 0 1 0 5H10M11.5 13l-2 2 2 2M3.5 15h3',
  symbol: 'M6 4.5c-1.5 0-2 .8-2 2v1.8c0 .9-.5 1.7-1.5 1.7 1 0 1.5.8 1.5 1.7v1.8c0 1.2.5 2 2 2M14 4.5c1.5 0 2 .8 2 2v1.8c0 .9.5 1.7 1.5 1.7-1 0-1.5.8-1.5 1.7v1.8c0 1.2-.5 2-2 2',
  clock: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM10 6.5V10l2.5 1.5',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
