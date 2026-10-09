// `wanigan` — the board, from a terminal. Inside a session Wanigan started, it acts
// as that session (WANIGAN_TOKEN); outside, it acts as the owner (--project,
// --data-dir or WANIGAN_DATA_DIR).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CoreClient } from '../client/client.ts';
import { CARD_TYPES, type CardSummary, type CardType } from '../shared/model.ts';
import type { EvidenceInput } from '../shared/protocol.ts';

const HELP = `wanigan — your project's board

  wanigan status                         your card, cards sent back to you, the top of Ready
  wanigan list [--status ready]          cards on this project's board
  wanigan show KEY                       one card in full
  wanigan claim KEY [--note "..."]       take a card before working on it
  wanigan note KEY "progress"            add a note (and keep your claim)
  wanigan review KEY --evidence X [--evidence Y] [--note "..."]
                                         submit for the owner's review; X is a file, a URL or a sentence
  wanigan release KEY [--note "..."]     give a card back
  wanigan file TYPE "title" [--body "..."] [--priority 0-3]
                                         file a new card (task, bug, feature, idea) into the Inbox
  wanigan ask KEY "question"             ask the owner; it shows up in their Needs you
  wanigan criteria KEY "criterion"       add an acceptance criterion
  wanigan decisions                      this project's decisions in force

  --json                                 machine-readable output

  Inside a session Wanigan started, wanigan acts as that session. Outside one it
  acts as you: --project KEY says which project, and --data-dir (or
  WANIGAN_DATA_DIR) which Wanigan, if not the usual one.
`;

interface Parsed { positional: string[]; flags: Map<string, string[]>; json: boolean }

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') { json = true; continue; }
    if (a === '--help') { flags.set('help', []); continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const value = argv[i + 1];
      // A flag without its value is a mistake, never an empty value: `--evidence --note x` would file "--note" as evidence.
      if (value === undefined || value === '' || /^--[A-Za-z][\w-]*$/.test(value)) throw new Error(`--${name} needs a value.`);
      i++;
      flags.set(name, [...(flags.get(name) ?? []), value]);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, json };
}

const inSession = (): boolean => Boolean(process.env.WANIGAN_SOCKET && process.env.WANIGAN_TOKEN);

async function connectClient(flags: Map<string, string[]>): Promise<CoreClient> {
  if (inSession()) return CoreClient.connect(process.env.WANIGAN_SOCKET as string, process.env.WANIGAN_TOKEN as string);
  const dataDir = flags.get('data-dir')?.[0] ?? process.env.WANIGAN_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Wanigan 2');
  const notRunning = new Error(`Wanigan is not running for ${dataDir}. Open the app, then try again.`);
  const tokenFile = join(dataDir, 'owner.token');
  const infoFile = join(dataDir, 'core.json');
  if (!existsSync(tokenFile) || !existsSync(infoFile)) throw notRunning;
  let socket: string;
  try { socket = (JSON.parse(readFileSync(infoFile, 'utf8')) as { socket: string }).socket; } catch { throw notRunning; }
  // A core that has stopped leaves its files behind; its socket is what says it is gone.
  return CoreClient.connect(socket, readFileSync(tokenFile, 'utf8').trim()).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? notRunning : error;
  });
}

/** The project a command is about: a session's own, or, outside one, the one --project names. */
async function projectOf(client: CoreClient, flags: Map<string, string[]>): Promise<string> {
  if (inSession()) return '';
  const key = flags.get('project')?.[0];
  if (!key) throw new Error('Outside a session, say which project: --project KEY.');
  const project = (await client.call('projects.list', {})).find((p) => p.key === key.toUpperCase());
  if (!project) throw new Error(`No open project has the key ${key.toUpperCase()}.`);
  return project.id;
}

function evidenceFrom(value: string): EvidenceInput {
  if (/^https?:\/\//i.test(value)) return { kind: 'link', value };
  const path = resolve(process.cwd(), value);
  if (!value.includes('\n') && value.length < 1024 && existsSync(path)) return { kind: 'file', value: path };
  return { kind: 'note', value };
}

const line = (c: CardSummary): string => {
  const claim = c.claim ? `  [held by session ${c.claim.sessionId.slice(0, 8)}]` : '';
  const flags = [c.sentBack && 'sent back', c.reopened && 'reopened'].filter(Boolean).join(', ');
  return `${c.key.padEnd(8)} P${c.priority} ${c.type.padEnd(7)} ${c.status.padEnd(7)} ${c.title}${flags ? `  (${flags})` : ''}${claim}`;
};

async function run(argv: string[]): Promise<number> {
  const { positional, flags, json } = parse(argv);
  const [command, ...rest] = positional;
  if (!command || command === 'help' || flags.has('help')) { process.stdout.write(HELP); return 0; }
  const out = (value: unknown, text: () => string): void => {
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
  };
  const note = flags.get('note')?.[0];
  const client = await connectClient(flags);
  try {
    switch (command) {
      case 'status': {
        const s = await client.call('agent.status', {});
        // What the owner asked of a card, said once: under "Sent back to you" when
        // it is there, otherwise under the first place the card is listed.
        const told = new Set<string>();
        const item = (c: CardSummary, section?: 'card'): string => {
          const later = section === 'card' && s.sentBack.some((b) => b.id === c.id);
          const asked = told.has(c.id) || later ? null : s.asked?.[c.id];
          if (!later) told.add(c.id);
          return [`  ${line(c)}`, asked?.note ? `      The owner: “${asked.note}”` : '', asked?.stillWrong ? `      Still wrong: “${asked.stillWrong}”` : '']
            .filter(Boolean).join('\n');
        };
        // Every other card it holds, whether or not it still holds its own.
        const others = s.claimed.filter((c) => c.id !== s.card?.id);
        out(s, () => [
          `${s.project.name} (${s.project.key}) · session ${s.session.id.slice(0, 8)} · ${s.session.state}`,
          s.paused ? '\nTHE OWNER HAS PAUSED THIS PROJECT. Finish the step you are on, note where things stand (`wanigan note KEY "..."`), and stop. Claims are blocked until it resumes.' : '',
          s.card ? `\nYour card:\n${item(s.card, 'card')}` : '\nNo card yet. Claim one from Ready, or file one.',
          s.sentBack.length ? `\nSent back to you (fix these first):\n${s.sentBack.map((c) => item(c)).join('\n')}` : '',
          others.length ? `\nYou also hold:\n${others.map((c) => item(c)).join('\n')}` : '',
          s.ready.length ? `\nTop of Ready:\n${s.ready.map((c) => item(c)).join('\n')}` : '\nReady is empty.',
          s.decisions.length ? `\nDecisions in force:\n${s.decisions.map((d) => `  - ${d.title}`).join('\n')}` : '',
        ].filter(Boolean).join('\n'));
        return 0;
      }
      case 'list': {
        const status = flags.get('status')?.[0];
        const cards = (await client.call('cards.list', { projectId: await projectOf(client, flags) })).filter((c) => !status || c.status === status);
        out(cards, () => cards.length ? cards.map(line).join('\n') : 'No cards.');
        return 0;
      }
      case 'show': {
        const card = await client.call('cards.get', { id: need(rest[0], 'KEY') });
        out(card, () => [
          line(card),
          card.body ? `\n${card.body}` : '',
          card.criteria.length ? `\nAcceptance criteria:\n${card.criteria.map((c) => `  [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}` : '',
          card.comments.length ? `\nComments:\n${card.comments.map((c) => `  ${c.author}: ${c.body}`).join('\n')}` : '',
          card.evidence.length ? `\nEvidence:\n${card.evidence.map((e) => `  ${e.kind}: ${e.value}`).join('\n')}` : '',
        ].filter(Boolean).join('\n'));
        return 0;
      }
      case 'claim': {
        const card = await client.call('cards.claim', { id: need(rest[0], 'KEY'), ...(note ? { note } : {}) });
        out(card, () => `Claimed ${card.key}. Your claim renews while this session is alive.`);
        return 0;
      }
      case 'note': {
        const card = await client.call('cards.heartbeat', { id: need(rest[0], 'KEY'), note: need(rest[1] ?? note, '"note"') });
        out(card, () => `Noted on ${card.key}.`);
        return 0;
      }
      case 'review': {
        const evidence = (flags.get('evidence') ?? []).map(evidenceFrom);
        const card = await client.call('cards.submit', { id: need(rest[0], 'KEY'), evidence, ...(note ? { note } : {}) });
        out(card, () => `${card.key} is in review. The owner approves it or sends it back; \`wanigan status\` shows which.`);
        return 0;
      }
      case 'release': {
        const card = await client.call('cards.release', { id: need(rest[0], 'KEY'), ...(note ? { note } : {}) });
        out(card, () => `Released ${card.key}.`);
        return 0;
      }
      case 'file': {
        const type = need(rest[0], 'TYPE') as CardType;
        if (!CARD_TYPES.includes(type)) throw new Error(`TYPE is one of ${CARD_TYPES.join(', ')}.`);
        const priority = flags.get('priority')?.[0];
        const body = flags.get('body')?.[0];
        const projectId = await projectOf(client, flags);
        const card = await client.call('cards.create', {
          ...(projectId ? { projectId } : {}),
          type, title: need(rest[1], '"title"'),
          ...(body ? { body } : {}),
          ...(priority !== undefined ? { priority: Number(priority) as 0 | 1 | 2 | 3 } : {}),
        });
        out(card, () => `Filed ${card.key} in ${card.status === 'inbox' ? 'the Inbox' : 'Ready'}.`);
        return 0;
      }
      case 'ask': {
        await client.call('cards.ask', { id: need(rest[0], 'KEY'), question: need(rest[1], '"question"') });
        out({ ok: true }, () => 'Asked. The owner sees it in Needs you; their reply lands on the card.');
        return 0;
      }
      case 'criteria': {
        await client.call('criteria.add', { cardId: need(rest[0], 'KEY'), text: need(rest[1], '"criterion"') });
        out({ ok: true }, () => 'Added.');
        return 0;
      }
      case 'decisions': {
        const decisions = await client.call('decisions.list', { projectId: await projectOf(client, flags) });
        out(decisions, () => decisions.length ? decisions.map((d) => `- ${d.title}${d.body ? `\n  ${d.body}` : ''}`).join('\n') : 'No decisions recorded.');
        return 0;
      }
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } finally {
    client.close();
  }
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}. Run \`wanigan help\`.`);
  return value;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    process.stderr.write(`wanigan: ${error.message}\n`);
    process.exit(1);
  },
);
