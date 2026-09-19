/**
 * Finding and starting a program on a platform that is not this one.
 *
 * Every case below is written so it runs identically on macOS, Linux and
 * Windows: the platform is an argument, never a read of `process.platform`.
 * That is the point of the module and the point of this file. A Windows port
 * whose Windows behaviour is only exercised on Windows is a port that regresses
 * the first time somebody refactors provider resolution from a Mac.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asPlatform,
  commandLine,
  executableCandidates,
  executableExtensions,
  extraSearchDirs,
  hasExecutableExtension,
  joinPath,
  loginShellProbe,
  needsCommandInterpreter,
  pathDelimiter,
  quoteForCmd,
  spawnPlan,
  splitPath,
  unquotableForCmd,
} from './platform.ts';

test('a Windows PATH splits on semicolons, so a drive letter is not a directory', () => {
  const value = 'C:\\Users\\dane\\AppData\\Roaming\\npm;C:\\Windows\\system32';
  assert.deepEqual(splitPath(value, 'win32'), [
    'C:\\Users\\dane\\AppData\\Roaming\\npm',
    'C:\\Windows\\system32',
  ]);
  // The bug this module exists for: the POSIX split turns one PATH into three
  // directories, none of which exist, and the CLI is reported as not installed.
  assert.deepEqual(splitPath(value, 'darwin'), ['C', '\\Users\\dane\\AppData\\Roaming\\npm;C', '\\Windows\\system32']);
});

test('PATH round-trips through split and join on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const dirs = platform === 'win32' ? ['C:\\a', 'D:\\b'] : ['/a', '/b'];
    assert.equal(joinPath(dirs, platform), dirs.join(pathDelimiter(platform)));
    assert.deepEqual(splitPath(joinPath(dirs, platform), platform), dirs);
  }
});

test('empty PATH entries are dropped rather than becoming the current directory', () => {
  // A trailing `;` is extremely common on Windows, and an empty entry means
  // "the current directory" to cmd.exe — which is the repository a session is
  // about to run in.
  assert.deepEqual(splitPath('C:\\a;;C:\\b;', 'win32'), ['C:\\a', 'C:\\b']);
  assert.deepEqual(splitPath('/a::/b:', 'linux'), ['/a', '/b']);
  assert.deepEqual(splitPath(undefined, 'win32'), []);
});

test('PATHEXT decides the probe order, and the empty extension comes last', () => {
  assert.deepEqual(executableExtensions('linux'), ['']);
  assert.deepEqual(executableExtensions('darwin'), ['']);
  assert.deepEqual(
    executableExtensions('win32', '.COM;.EXE;.BAT;.CMD'),
    ['.com', '.exe', '.bat', '.cmd', ''],
  );
  // Unset or junk falls back rather than yielding nothing to probe.
  assert.deepEqual(executableExtensions('win32', ''), ['.com', '.exe', '.bat', '.cmd', '']);
  assert.deepEqual(executableExtensions('win32', 'EXE;;.'), ['.com', '.exe', '.bat', '.cmd', '']);
});

test('an .exe is preferred over a .cmd shim, because that is what typing the name would run', () => {
  const candidates = executableCandidates('claude', {
    platform: 'win32',
    path: 'C:\\shims;C:\\real',
    pathext: '.EXE;.CMD',
  });
  // Extension-major: every directory is tried for .exe before any is tried for
  // .cmd. A wrapper shim early on PATH must not shadow the real program later.
  assert.deepEqual(candidates, [
    'C:\\shims\\claude.exe',
    'C:\\real\\claude.exe',
    'C:\\shims\\claude.cmd',
    'C:\\real\\claude.cmd',
    'C:\\shims\\claude',
    'C:\\real\\claude',
  ]);
});

test('the current directory is never a candidate', () => {
  // cmd.exe searches `.` first and a POSIX shell does not. Inheriting that
  // would let a repository containing claude.cmd decide what a session runs.
  for (const candidate of executableCandidates('claude', { platform: 'win32', path: 'C:\\bin', pathext: '.EXE' })) {
    assert.ok(candidate.startsWith('C:\\bin\\'), candidate);
  }
  assert.deepEqual(executableCandidates('claude', { platform: 'win32', path: '', pathext: '.EXE' }), []);
});

test('a name that already carries an executable extension is not permuted again', () => {
  assert.ok(hasExecutableExtension('claude.cmd', 'win32', '.EXE;.CMD'));
  assert.ok(!hasExecutableExtension('claude', 'win32', '.EXE;.CMD'));
  // `.ps1` is not in PATHEXT here, so it is not treated as already-executable.
  assert.ok(!hasExecutableExtension('claude.ps1', 'win32', '.EXE;.CMD'));
  assert.ok(!hasExecutableExtension('claude.cmd', 'darwin'));

  assert.deepEqual(
    executableCandidates('claude.cmd', { platform: 'win32', path: 'C:\\bin', pathext: '.EXE;.CMD' }),
    ['C:\\bin\\claude.cmd'],
  );
});

test('an absolute or path-bearing bin names one file and is never searched for on PATH', () => {
  assert.deepEqual(
    executableCandidates('C:\\tools\\agent.exe', { platform: 'win32', path: 'C:\\bin', pathext: '.EXE' }),
    ['C:\\tools\\agent.exe'],
  );
  assert.deepEqual(
    executableCandidates('/usr/local/bin/claude', { platform: 'darwin', path: '/bin' }),
    ['/usr/local/bin/claude'],
  );
  // A relative path is still a path: PATH must not be able to win over it.
  assert.deepEqual(
    executableCandidates('./tools/agent', { platform: 'darwin', path: '/bin' }),
    ['./tools/agent'],
  );
});

test('duplicate candidates collapse, case-insensitively on Windows only', () => {
  assert.deepEqual(
    executableCandidates('claude', { platform: 'win32', path: 'C:\\Bin;c:\\bin', pathext: '.EXE' }),
    ['C:\\Bin\\claude.exe', 'C:\\Bin\\claude'],
  );
  // A case-sensitive filesystem has two real directories here, not one.
  assert.deepEqual(
    executableCandidates('claude', { platform: 'linux', path: '/Bin:/bin' }),
    ['/Bin/claude', '/bin/claude'],
  );
});

test('extra search dirs are appended after PATH, in PATH order', () => {
  const candidates = executableCandidates('claude', {
    platform: 'win32',
    path: 'C:\\first',
    pathext: '.EXE',
    extraDirs: ['C:\\fallback'],
  });
  assert.deepEqual(candidates, [
    'C:\\first\\claude.exe',
    'C:\\fallback\\claude.exe',
    // The extensionless tail is the last resort, and it is still PATH-ordered.
    // On Windows it usually finds npm's bash shim, which CreateProcess cannot
    // start — so it is probed only when nothing in PATHEXT matched anywhere.
    'C:\\first\\claude',
    'C:\\fallback\\claude',
  ]);
});

/* ── starting it ──────────────────────────────────────────────────────── */

test('only .cmd and .bat need cmd.exe', () => {
  assert.ok(needsCommandInterpreter('C:\\bin\\claude.cmd', 'win32'));
  assert.ok(needsCommandInterpreter('C:\\bin\\claude.BAT', 'win32'));
  assert.ok(!needsCommandInterpreter('C:\\bin\\claude.exe', 'win32'));
  // The same filename on macOS is just a file with a confusing name.
  assert.ok(!needsCommandInterpreter('/usr/local/bin/claude.cmd', 'darwin'));
});

test('an .exe is started directly, with its argv untouched', () => {
  const plan = spawnPlan('C:\\bin\\claude.exe', ['--resume', 'abc'], 'win32');
  assert.deepEqual(plan, { kind: 'direct', file: 'C:\\bin\\claude.exe', args: ['--resume', 'abc'] });
});

test('a .cmd shim is wrapped in cmd.exe with AutoRun and delayed expansion off', () => {
  const plan = spawnPlan('C:\\npm\\claude.cmd', ['--print', 'fix the build'], 'win32');
  assert.equal(plan.kind, 'interpreter');
  assert.equal(plan.kind === 'interpreter' && plan.file, 'cmd.exe');
  assert.deepEqual(plan.kind === 'interpreter' && plan.args, [
    '/d', '/s', '/v:off', '/c',
    // The outer pair is not redundant. `/s` strips the first character when it
    // is a quote and removes the last quote character; without it the CLI path
    // would lose its own closing quote and never start.
    '""C:\\npm\\claude.cmd" "--print" "fix the build""',
  ]);
});

test('a goal containing a shell separator crosses cmd.exe as text, not as a command', () => {
  // The argument is the prompt a person typed. Before this, `&` in it started
  // a second command with the operator's credentials in scope.
  const plan = spawnPlan('C:\\npm\\claude.cmd', ['--print', 'build & deploy (fast) | tee log'], 'win32');
  assert.equal(plan.kind, 'interpreter');
  assert.equal(
    plan.kind === 'interpreter' ? plan.args[4] : '',
    '""C:\\npm\\claude.cmd" "--print" "build & deploy (fast) | tee log""',
  );
  // No caret escaping: inside quotes cmd.exe passes these through literally,
  // and a caret here would arrive as part of the prompt.
  assert.ok(plan.kind === 'interpreter' && !plan.args[4].includes('^'));
});

test('what cmd.exe cannot carry is refused by name rather than mangled', () => {
  assert.equal(unquotableForCmd('plain text'), null);
  assert.equal(unquotableForCmd('50% done'), null, 'a lone % is not an expansion');
  assert.match(unquotableForCmd('say "hi"') ?? '', /double quote/);
  assert.match(unquotableForCmd('cd %USERPROFILE%') ?? '', /%VARIABLE%/);
  assert.match(unquotableForCmd('line\nbreak') ?? '', /line break/);
  assert.match(unquotableForCmd('nul\0byte') ?? '', /NUL/);

  const plan = spawnPlan('C:\\npm\\claude.cmd', ['--print', 'echo %PATH%'], 'win32');
  assert.equal(plan.kind, 'refused');
  assert.match(plan.kind === 'refused' ? plan.reason : '', /%VARIABLE%/);
  assert.match(plan.kind === 'refused' ? plan.reason : '', /\.exe build/);
});

test('the same arguments are refused nowhere else', () => {
  // A quote or a %VAR% in a prompt is ordinary text to an .exe and to POSIX.
  for (const [file, platform] of [['C:\\bin\\claude.exe', 'win32'], ['/usr/local/bin/claude', 'darwin']] as const) {
    const plan = spawnPlan(file, ['--print', 'say "hi" about %PATH%'], platform);
    assert.equal(plan.kind, 'direct', `${file} should not route through a shell`);
  }
});

test('the interpreter plan survives node-pty as a string, never as an array', () => {
  // node-pty's array path escapes every `"` as `\"`, which would rewrite the
  // quoting above into one argument full of backslashes. Its string path is
  // appended verbatim, so this is the form that has to be correct.
  const plan = spawnPlan('C:\\npm\\claude.cmd', ['--print', 'ship it'], 'win32');
  assert.equal(commandLine(plan), '/d /s /v:off /c ""C:\\npm\\claude.cmd" "--print" "ship it""');

  // Stripping the first character and the last quote, as cmd /s does, must
  // leave exactly the line we meant to run.
  const after = commandLine(plan).slice('/d /s /v:off /c '.length);
  const stripped = after.slice(1, after.lastIndexOf('"'));
  assert.equal(stripped, '"C:\\npm\\claude.cmd" "--print" "ship it"');
});

test('a refused plan has no command line to hand anybody', () => {
  const plan = spawnPlan('C:\\npm\\claude.cmd', ['--print', 'echo %PATH%'], 'win32');
  assert.throws(() => commandLine(plan), /%VARIABLE%/);
});

test('a trailing backslash does not escape the closing quote', () => {
  // `"C:\repo\"` would be read by the target's CreateProcess parser as an
  // escaped quote, swallowing the argument boundary and merging two arguments.
  assert.equal(quoteForCmd('C:\\repo\\'), '"C:\\repo\\\\"');
  assert.equal(quoteForCmd('C:\\repo'), '"C:\\repo"');
});

/* ── the environment around it ────────────────────────────────────────── */

test('Windows has no login shell to ask for a PATH', () => {
  assert.equal(loginShellProbe('win32'), null);
  assert.equal(loginShellProbe('win32', 'C:\\Windows\\system32\\cmd.exe'), null);
  assert.deepEqual(loginShellProbe('darwin'), { file: '/bin/zsh', args: ['-lic', 'printf %s "$PATH"'] });
  assert.deepEqual(loginShellProbe('linux'), { file: '/bin/sh', args: ['-lic', 'printf %s "$PATH"'] });
  assert.deepEqual(loginShellProbe('darwin', '/opt/homebrew/bin/fish'), {
    file: '/opt/homebrew/bin/fish',
    args: ['-lic', 'printf %s "$PATH"'],
  });
});

test('the Windows fallback dirs are where the supported installers actually write', () => {
  const dirs = extraSearchDirs('win32', { APPDATA: 'C:\\Users\\dane\\AppData\\Roaming' }, 'C:\\Users\\dane');
  // npm's global prefix is added to the *user* PATH by its installer, which an
  // already-running explorer.exe has not re-read, so it is missing exactly when
  // somebody has just installed the CLI and is trying it for the first time.
  assert.ok(dirs.includes('C:\\Users\\dane\\AppData\\Roaming\\npm'));
  assert.ok(dirs.every((d) => d.includes('\\') && !d.includes('/')), dirs.join(', '));
});

test('an absent APPDATA falls back to its conventional location rather than to undefined', () => {
  const dirs = extraSearchDirs('win32', {}, 'C:\\Users\\dane');
  assert.ok(dirs.includes('C:\\Users\\dane\\AppData\\Roaming\\npm'));
  assert.ok(!dirs.some((d) => d.includes('undefined')), dirs.join(', '));
});

test('macOS keeps the homebrew prefixes it already relied on', () => {
  const dirs = extraSearchDirs('darwin', {}, '/Users/dane');
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes('/Users/dane/.local/bin'));
});

test('an unfamiliar platform is treated as POSIX, never as Windows', () => {
  // Being wrong towards POSIX degrades discovery; being wrong towards Windows
  // would route arguments through a cmd.exe that is not there.
  assert.equal(asPlatform('freebsd'), 'linux');
  assert.equal(asPlatform('win32'), 'win32');
  assert.equal(asPlatform('darwin'), 'darwin');
  assert.equal(pathDelimiter(asPlatform('sunos')), ':');
});
