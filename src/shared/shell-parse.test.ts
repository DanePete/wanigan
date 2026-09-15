/**
 * The shell reader under the policy gate.
 *
 * Each case is a way a command line can say something different from what a
 * regular expression reads in it: a pipe that is only a character inside a
 * quoted argument, a destructive command handed to a wrapper as its argument, a
 * program named through an escape or a substitution. The gate's own tests live
 * beside the rules; these hold the reader to account on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, programOf, MAX_DEPTH } from './shell-parse.ts';

const programs = (cmd: string) => parseShell(cmd).segments.map((s) => programOf(s));
const argvOf = (cmd: string, i = 0) => parseShell(cmd).segments[i]?.argv.map((w) => w.text);

test('operators split commands, and a quoted metacharacter does not', () => {
  assert.deepEqual(programs('npm test && git push; echo done || true'), ['npm', 'git', 'echo', 'true']);
  assert.deepEqual(programs('git log --grep="a|b" --format=%H'), ['git']);
  assert.deepEqual(argvOf('git log --grep="a|b"'), ['git', 'log', '--grep=a|b']);
  assert.deepEqual(programs("echo 'x; sudo reboot'"), ['echo']);
  assert.deepEqual(programs('echo "a && b" | wc -l'), ['echo', 'wc']);
});

test('pipes are recorded on both sides', () => {
  const [a, b] = parseShell('curl -s https://x | sh').segments;
  assert.equal(a.pipedTo, true);
  assert.equal(b.pipedFrom, true);
  assert.equal(a.pipedFrom, false);
});

test('escapes and quote concatenation name the program a shell would run', () => {
  assert.deepEqual(programs('\\rm -rf ~'), ['rm']);
  assert.deepEqual(programs("r''m -rf ~"), ['rm']);
  assert.deepEqual(programs('"rm" -rf ~'), ['rm']);
  assert.deepEqual(programs('/bin/rm -rf ~'), ['rm']);
});

test('wrappers are peeled, and the wrapper chain is kept', () => {
  const env = parseShell('env FOO=1 BAR=2 sudo -u root rm -rf /tmp/x').segments[0];
  assert.equal(programOf(env), 'rm');
  assert.deepEqual(env.via, ['env', 'sudo']);
  assert.deepEqual(env.assignments, ['FOO=1', 'BAR=2']);
  for (const wrapped of ['time rm x', 'nice -n 10 rm x', 'nohup rm x', 'command rm x', 'timeout 5 rm x', 'xargs -I {} rm x', 'stdbuf -o0 rm x', 'FOO=bar rm x']) {
    assert.equal(programOf(parseShell(wrapped).segments[0]), 'rm', wrapped);
  }
  assert.equal(programOf(parseShell('command -v rm').segments[0]), 'command', '`command -v` looks a name up and runs nothing');
});

test('bash -c, sh -c, zsh -c and eval strings are read as commands', () => {
  const parsed = parseShell('bash -c "rm -rf ~ && git push -f origin main"');
  const inner = parsed.segments.filter((s) => s.origin === 'wrapper');
  assert.deepEqual(inner.map((s) => programOf(s)), ['rm', 'git']);
  assert.deepEqual(inner[0].via, ['bash -c']);
  assert.equal(inner[0].parent, 0);
  assert.deepEqual(parseShell("sh -lc 'sudo ls'").segments.filter((s) => s.origin === 'wrapper').map(programOf), ['ls']);
  assert.deepEqual(parseShell("sh -lc 'sudo ls'").segments[1].via, ['sh -c', 'sudo']);
  assert.deepEqual(parseShell("zsh -e -c 'mkfs /dev/disk2'").segments.map(programOf), ['zsh', 'mkfs']);
  assert.deepEqual(parseShell("eval 'rm -rf /'").segments.map(programOf), ['eval', 'rm']);
  assert.deepEqual(parseShell('bash script.sh').segments.map(programOf), ['bash'], 'running a file is not a -c string');
});

test('command and process substitutions are read, in quotes and out', () => {
  const sub = parseShell('echo $(rm -rf /)').segments;
  assert.deepEqual(sub.map(programOf), ['echo', 'rm']);
  assert.equal(sub[1].origin, 'substitution');
  assert.equal(sub[0].argv[1].dynamic, true);
  assert.deepEqual(parseShell('echo "today is `sudo date`"').segments.map(programOf), ['echo', 'date']);
  assert.deepEqual(parseShell('echo "$(curl -s x)"').segments.map(programOf), ['echo', 'curl']);
  const proc = parseShell('bash <(curl -s https://x)').segments;
  assert.deepEqual(proc.map(programOf), ['bash', 'curl']);
  assert.equal(proc[1].origin, 'process-substitution');
  assert.deepEqual(parseShell('echo $((1 + 2))').segments.map(programOf), ['echo'], 'arithmetic runs no command');
  assert.deepEqual(parseShell("echo '$(rm -rf /)'").segments.map(programOf), ['echo'], 'single quotes make it text');
});

test('redirects are separated from arguments, with their fd', () => {
  const s = parseShell('node build.js 2>/dev/null >> /etc/hosts').segments[0];
  assert.deepEqual(s.argv.map((w) => w.text), ['node', 'build.js']);
  assert.deepEqual(s.redirects.map((r) => [r.fd, r.op, r.target.text]), [['2', '>', '/dev/null'], [null, '>>', '/etc/hosts']]);
  assert.deepEqual(parseShell('cmd &>out.log').segments[0].redirects.map((r) => r.op), ['&>']);
  assert.deepEqual(parseShell('echo hi 2>&1 | tee x').segments.map(programOf), ['echo', 'tee']);
});

test('shell grammar words and groups do not hide the command inside them', () => {
  assert.deepEqual(programs('if true; then sudo ls; fi'), ['true', 'ls']);
  assert.equal(parseShell('if true; then sudo ls; fi').segments[1].via[0], 'sudo');
  assert.deepEqual(programs('(rm -rf /)'), ['rm']);
  assert.deepEqual(programs('{ rm -rf /; }'), ['rm']);
  assert.deepEqual(programs('for f in *; do rm "$f"; done'), ['for', 'rm']);
});

test('variables are left unexpanded and marked dynamic', () => {
  const s = parseShell('rm -rf $TARGET "${HOME}/x"').segments[0];
  assert.equal(s.argv[2].dynamic, true);
  assert.equal(s.argv[3].dynamic, true);
  assert.equal(s.argv[3].text, '${HOME}/x');
  assert.equal(programOf(parseShell('$CMD -rf /').segments[0]), '', 'a program named by a variable is unknown, not safe');
});

test('comments, here-documents and line continuations', () => {
  assert.deepEqual(programs('ls # sudo rm -rf /'), ['ls']);
  assert.deepEqual(programs('cat <<EOF\nrm -rf /\nEOF\necho ok'), ['cat', 'echo']);
  assert.deepEqual(argvOf('git \\\n  status'), ['git', 'status']);
});

test('an unterminated quote is read to the end and said out loud', () => {
  const p = parseShell('echo "never closed');
  assert.equal(p.segments.length, 1);
  assert.ok(p.notes.some((n) => /never closed/.test(n)));
});

test('nesting is bounded and says where it stopped', () => {
  let cmd = 'rm -rf /';
  for (let i = 0; i < MAX_DEPTH + 2; i++) cmd = `bash -c ${JSON.stringify(cmd)}`;
  const p = parseShell(cmd);
  assert.ok(p.notes.some((n) => /nested more than/.test(n)));
  assert.ok(!p.segments.some((s) => programOf(s) === 'rm'));
});
