// The Drupal helper's hold for a verification's renders (live-helper-drupal-verify.ts), run under PHP with stand-ins
// for the few Symfony and Drupal classes it touches, when PHP is on this Mac: which requests are held, the request
// time held and put back before anything is kept, a view's random order seeded, and what the response says. Nothing
// here runs Drupal; the view and times are made up.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { which } from './environment.ts';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';

const files = DRUPAL_HELPER_FILES;

test('the hold is a service of the module, its hook is in the .module file, and it lets go after the page is whole and before the trace is kept', () => {
  assert.match(files['wanigan_live.services.yml'] ?? '', /\n {2}wanigan_live\.steady:\n {4}class: Drupal\\wanigan_live\\Verify\\Steady\n {4}arguments: \['@wanigan_live\.token'\]\n {4}tags:\n {6}- \{ name: event_subscriber \}\n/);
  assert.match(files['wanigan_live.module'] ?? '', /\nfunction wanigan_live_query_views_alter\(\\Drupal\\Core\\Database\\Query\\AlterableInterface \$query\) \{\n {2}\\Drupal\\wanigan_live\\Verify\\Steady::seedViews\(\$query\);\n\}\n$/);
  const steady = files['src/Verify/Steady.php'] ?? '';
  const release = Number(/\[\['release', (-?\d+)\]\]/.exec(steady)?.[1]);
  const finish = Number(/\[\['finish', (-?\d+)\]\]/.exec(files['src/Trace/TraceSubscriber.php'] ?? '')?.[1]);
  assert.ok(release < -10000, 'after BigPipe’s last response listener (-10000): the page is rendered whole at the held time');
  assert.ok(release > finish, 'before the trace is stored, so its expiry is the real time’s');
});

test('held for a token GET with a hold only: the request time is the hold’s until the response, a view’s random order is seeded, and the response says so', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-steady-'));
  try {
    writeFileSync(join(folder, 'Steady.php'), files['src/Verify/Steady.php'] ?? '');
    writeFileSync(join(folder, 'check.php'), `<?php
namespace Symfony\\Component\\EventDispatcher { interface EventSubscriberInterface { public static function getSubscribedEvents(); } }
namespace Symfony\\Component\\HttpFoundation {
  class Bag { public function __construct(public array $all = []) {} public function get($k, $d = null) { return $this->all[$k] ?? $d; } public function set($k, $v) { $this->all[$k] = $v; } public function has($k) { return array_key_exists($k, $this->all); } }
  class Request { public Bag $server; public Bag $headers; public function __construct(public string $method, array $headers, array $server) { $this->headers = new Bag($headers); $this->server = new Bag($server); } public function isMethod($m) { return strtoupper($this->method) === $m; } }
  class Response { public Bag $headers; public function __construct() { $this->headers = new Bag(); } }
}
namespace Symfony\\Component\\HttpKernel { final class KernelEvents { const REQUEST = 'kernel.request'; const RESPONSE = 'kernel.response'; const TERMINATE = 'kernel.terminate'; } }
namespace Symfony\\Component\\HttpKernel\\Event {
  class RequestEvent { public function __construct(private $r, private bool $main = true) {} public function getRequest() { return $this->r; } public function isMainRequest() { return $this->main; } }
  class ResponseEvent extends RequestEvent { public function __construct($r, private $response, bool $main = true) { parent::__construct($r, $main); } public function getResponse() { return $this->response; } }
  class TerminateEvent extends RequestEvent {}
}
namespace Drupal\\wanigan_live { class Token { public function __construct(private bool $ok) {} public function carried($request = NULL): bool { return $this->ok; } } }
namespace Drupal\\Core\\Database\\Query {
  interface AlterableInterface {}
  interface SelectInterface extends AlterableInterface { public function &getExpressions(); public function getMetaData($key); }
  class Stand implements SelectInterface { public function __construct(public array $expressions, public array $meta = []) {} public function &getExpressions() { return $this->expressions; } public function getMetaData($key) { return $this->meta[$key] ?? NULL; } }
  class Other implements AlterableInterface {}
}
namespace {
  require ${JSON.stringify(join(folder, 'Steady.php'))};
  use Drupal\\wanigan_live\\Verify\\Steady;
  use Drupal\\wanigan_live\\Token;
  use Symfony\\Component\\HttpFoundation\\{Request, Response};
  use Symfony\\Component\\HttpKernel\\Event\\{RequestEvent, ResponseEvent, TerminateEvent};
  use Drupal\\Core\\Database\\Query\\{Stand, Other};
  $now = time();
  $held = $now - 86400 * 3;
  $real = $now - 1;
  $view = (object) ['storage' => new class { public function id() { return 'picks'; } }, 'current_display' => 'block_1'];
  $rand = fn () => new Stand(['random_field' => ['expression' => 'RAND()', 'alias' => 'random_field', 'arguments' => []], 'n' => ['expression' => 'COUNT(*)', 'alias' => 'n', 'arguments' => []]], ['view' => $view]);
  $request = fn (string $method = 'GET', ?string $hold = NULL) => new Request($method, $hold === NULL ? [] : ['X-Wanigan-Steady' => $hold], ['REQUEST_TIME' => $real, 'REQUEST_TIME_FLOAT' => $real + 0.25]);
  $_SERVER['REQUEST_TIME'] = $real;
  $_SERVER['REQUEST_TIME_FLOAT'] = $real + 0.25;
  $out = ['parse' => array_map(fn ($h) => Steady::parse($h, 1700000000), ['t=1699999940;s=42', 't=1700000001;s=42', 't=' . (1700000000 - 401 * 86400) . ';s=42', 't=1699999940;s=0', 'x', 't=1699999940;s=42;views=a:b'])];

  // Held: the request time, $_SERVER's copy, and the seed, until the response.
  $steady = new Steady(new Token(TRUE));
  $r = $request('GET', "t=$held;s=42");
  $steady->hold(new RequestEvent($r));
  $q = $rand();
  Steady::seedViews($q);
  $pg = new Stand(['random_field' => ['expression' => 'RANDOM()', 'alias' => 'random_field', 'arguments' => []]], ['view' => $view]);
  Steady::seedViews($pg);
  Steady::seedViews(new Other());
  $out['during'] = [$r->server->get('REQUEST_TIME'), $r->server->get('REQUEST_TIME_FLOAT'), $_SERVER['REQUEST_TIME'], $q->expressions['random_field']['expression'], $q->expressions['n']['expression'], $pg->expressions['random_field']['expression']];
  $response = new Response();
  $steady->release(new ResponseEvent($r, $response));
  $out['after'] = [$r->server->get('REQUEST_TIME') === $real, $r->server->get('REQUEST_TIME_FLOAT') === $real + 0.25, $_SERVER['REQUEST_TIME'] === $real, Steady::$seed, $response->headers->get('X-Wanigan-Steady')];
  $later = $rand();
  Steady::seedViews($later);
  $out['seededAfter'] = $later->expressions['random_field']['expression'];

  // A request that ends without a response listener: the real time back all the same.
  $steady = new Steady(new Token(TRUE));
  $r = $request('GET', "t=$held;s=7");
  $steady->hold(new RequestEvent($r));
  $steady->terminate(new TerminateEvent($r));
  $out['terminated'] = [$r->server->get('REQUEST_TIME') === $real, $_SERVER['REQUEST_TIME'] === $real, Steady::$seed];

  // Never held: no token, not a GET, a sub-request, no hold, a hold later than now.
  $never = [];
  foreach ([[FALSE, 'GET', "t=$held;s=42", TRUE], [TRUE, 'POST', "t=$held;s=42", TRUE], [TRUE, 'GET', "t=$held;s=42", FALSE], [TRUE, 'GET', NULL, TRUE], [TRUE, 'GET', 't=' . ($now + 3600) . ';s=42', TRUE]] as [$token, $method, $hold, $main]) {
    $steady = new Steady(new Token($token));
    $r = $request($method, $hold);
    $steady->hold(new RequestEvent($r, $main));
    $q = $rand();
    Steady::seedViews($q);
    $response = new Response();
    $steady->release(new ResponseEvent($r, $response));
    $never[] = [$r->server->get('REQUEST_TIME') === $real, $_SERVER['REQUEST_TIME'] === $real, $q->expressions['random_field']['expression'], $response->headers->has('X-Wanigan-Steady')];
  }
  $out['never'] = $never;
  echo json_encode($out);
}
`);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8' })) as Record<string, unknown>;
    assert.deepEqual(out.parse, [[1_699_999_940, 42], null, null, null, null, null], 'a time no later than now nor 400 days before it, and a seed from 1');
    const during = out.during as unknown[];
    assert.ok(typeof during[0] === 'number' && during[0] < Date.now() / 1000 - 86_000, 'held three days back');
    assert.deepEqual(during.slice(1), [during[0], during[0], 'RAND(42)', 'COUNT(*)', 'RANDOM()'],
      'the float and $_SERVER’s copy too; RAND() seeded, nothing else; PostgreSQL’s RANDOM() takes no seed and is left');
    assert.deepEqual(out.after, [true, true, true, null, `t=${during[0]};s=42;views=picks:block_1`], 'put back, and the response says what was held, the view seeded among it');
    assert.equal(out.seededAfter, 'RAND()', 'nothing is seeded once the request is let go');
    assert.deepEqual(out.terminated, [true, true, null]);
    assert.deepEqual(out.never, Array.from({ length: 5 }, () => [true, true, 'RAND()', false]), 'no token, not a GET, a sub-request, no hold, a later time: nothing held, nothing said');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
