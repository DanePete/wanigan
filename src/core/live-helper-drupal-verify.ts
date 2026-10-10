// The Drupal helper's part in the design layer's verification (src/main/live-layer.ts, "Verifying"): what holds a
// verification's renders still, for Wanigan's token requests that carry X-Wanigan-Steady and no others. PHP source,
// added to the module's files, services and .module (live-helper-drupal.ts). The research behind it, with core's
// file and line for each claim: docs/research/2026-10-09-core-limits.md, "Masking can be per part, and some noise can
// be removed instead".

const STEADY = String.raw`<?php

namespace Drupal\wanigan_live\Verify;

use Drupal\Core\Database\Query\AlterableInterface;
use Drupal\Core\Database\Query\SelectInterface;
use Drupal\wanigan_live\Token;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\Event\TerminateEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Holds a verification's render still, for Wanigan's token requests only.
 *
 * Wanigan's verification renders a page several times (the design and the
 * result, each twice, and the page as it was kept before an edit was made
 * real, maybe days before) and compares them pixel for pixel. Each of those
 * requests carries the view's token and X-Wanigan-Steady:
 * t=<a time, never later than now>;s=<a seed>. For that request alone:
 * - Its request time is that time, from an early request listener to a late
 *   response listener. Core's date formatter measures "3 days ago" from the
 *   request's REQUEST_TIME (core/lib/Drupal/Core/Datetime/DateFormatter.php,
 *   formatTimeDiffSince() and formatTimeDiffUntil()), and Time::
 *   getRequestTime() reads it too (core/lib/Drupal/Component/Datetime/
 *   Time.php); $_SERVER's copy is held as well, for code that reads it
 *   directly. Both are put back before the response leaves the kernel, so
 *   what is kept after it (the trace and its expiry, the session's
 *   timestamp, a user's last access, cron) is kept at the real time.
 * - A view's random sort (core/modules/views/src/Plugin/views/sort/
 *   Random.php, through Select::orderRandom(), which adds RAND()) is seeded:
 *   RAND(<seed>) on MySQL and MariaDB, and on SQLite, whose RAND() is core's
 *   PHP function seeded by mt_srand(). PostgreSQL's RANDOM() takes no seed and
 *   is left as it is, so that view stays left out of the comparison.
 * - The response says what was held (X-Wanigan-Steady:
 *   t=…;s=…;views=<view:display,…>), so Wanigan compares only what was held
 *   alike, and leaves out what was not.
 * A later time than now is refused: what core keeps with an expiry while
 * rendering (a view's time-based cache) would then outlive what a visitor
 * should see. A time more than 400 days old is refused too.
 */
final class Steady implements EventSubscriberInterface {

  /**
   * The seed of the request being held, or NULL when none is.
   */
  public static ?int $seed = NULL;

  /**
   * The views whose random order was seeded, as view:display.
   */
  public static array $views = [];

  /**
   * The request's own times, to put back; NULL when nothing is held.
   */
  private ?array $real = NULL;

  /**
   * What was held, as the response says it.
   */
  private string $held = '';

  public function __construct(private readonly Token $token) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [
      KernelEvents::REQUEST => [['hold', 999]],
      // After BigPipe's last response listener (-10000), when the page is
      // rendered whole, and before the trace is stored (TraceSubscriber::
      // finish(), -10050), so the trace's expiry is the real time's.
      KernelEvents::RESPONSE => [['release', -10040]],
      KernelEvents::TERMINATE => [['terminate', 1000]],
    ];
  }

  /**
   * [time, seed] from the header, or NULL: never later than now, nor older
   * than 400 days, and a seed from 1.
   */
  public static function parse(string $header, int $now): ?array {
    if (!preg_match('/^t=(\d{1,12});s=(\d{1,9})$/', $header, $m)) {
      return NULL;
    }
    $t = (int) $m[1];
    $s = (int) $m[2];
    if ($t > $now || $t < $now - 400 * 86400 || $s < 1) {
      return NULL;
    }
    return [$t, $s];
  }

  /**
   * Holds the time of a main GET request that carries the token and a hold.
   */
  public function hold(RequestEvent $event): void {
    if (!$event->isMainRequest() || $this->real !== NULL) {
      return;
    }
    $request = $event->getRequest();
    if (!$request->isMethod('GET') || !$request->headers->has('X-Wanigan-Steady') || !$this->token->carried($request)) {
      return;
    }
    $held = self::parse((string) $request->headers->get('X-Wanigan-Steady', ''), time());
    if ($held === NULL) {
      return;
    }
    [$t, $s] = $held;
    $this->real = [
      $request->server->get('REQUEST_TIME'),
      $request->server->get('REQUEST_TIME_FLOAT'),
      $_SERVER['REQUEST_TIME'] ?? NULL,
      $_SERVER['REQUEST_TIME_FLOAT'] ?? NULL,
    ];
    $request->server->set('REQUEST_TIME', $t);
    $request->server->set('REQUEST_TIME_FLOAT', (float) $t);
    $_SERVER['REQUEST_TIME'] = $t;
    $_SERVER['REQUEST_TIME_FLOAT'] = (float) $t;
    self::$seed = $s;
    self::$views = [];
    $this->held = 't=' . $t . ';s=' . $s;
  }

  /**
   * Puts the real time back, and says what was held.
   */
  public function release(ResponseEvent $event): void {
    if (!$event->isMainRequest() || $this->real === NULL) {
      return;
    }
    $this->restore($event->getRequest());
    $views = implode(',', array_slice(array_values(array_unique(self::$views)), 0, 50));
    $event->getResponse()->headers->set('X-Wanigan-Steady', $this->held . ($views !== '' ? ';views=' . $views : ''));
    self::$seed = NULL;
    self::$views = [];
  }

  /**
   * A request that ended without a response listener running: the real time
   * back all the same.
   */
  public function terminate(TerminateEvent $event): void {
    if ($this->real !== NULL) {
      $this->restore($event->getRequest());
    }
    self::$seed = NULL;
    self::$views = [];
  }

  private function restore(Request $request): void {
    [$time, $float, $server, $server_float] = $this->real;
    $request->server->set('REQUEST_TIME', $time);
    $request->server->set('REQUEST_TIME_FLOAT', $float);
    if ($server === NULL) {
      unset($_SERVER['REQUEST_TIME']);
    }
    else {
      $_SERVER['REQUEST_TIME'] = $server;
    }
    if ($server_float === NULL) {
      unset($_SERVER['REQUEST_TIME_FLOAT']);
    }
    else {
      $_SERVER['REQUEST_TIME_FLOAT'] = $server_float;
    }
    $this->real = NULL;
  }

  /**
   * A view's random order, seeded, while a request is held
   * (wanigan_live_query_views_alter()). Core's Select::orderRandom() adds the
   * expression RAND() under the alias random_field; a driver that writes
   * another (PostgreSQL's RANDOM()) is left as it is.
   */
  public static function seedViews(AlterableInterface $query): void {
    if (self::$seed === NULL || !$query instanceof SelectInterface) {
      return;
    }
    $expressions = &$query->getExpressions();
    $seeded = FALSE;
    foreach ($expressions as &$expression) {
      if (is_array($expression) && ($expression['expression'] ?? NULL) === 'RAND()') {
        $expression['expression'] = 'RAND(' . self::$seed . ')';
        $seeded = TRUE;
      }
    }
    unset($expression);
    if (!$seeded) {
      return;
    }
    $view = $query->getMetaData('view');
    if (is_object($view) && isset($view->storage) && is_object($view->storage) && method_exists($view->storage, 'id')) {
      $id = (string) $view->storage->id() . ':' . (string) ($view->current_display ?? '');
      if (preg_match('/^[a-z0-9_]{1,128}:[a-z0-9_]{1,128}$/', $id)) {
        self::$views[] = $id;
      }
    }
  }

}
`;

/** The service that holds a verification's render still, added to the module's services. */
export const DRUPAL_VERIFY_SERVICES = `  # Holds a verification's render still (its request time, its views' random
  # order), for a token request that carries X-Wanigan-Steady only.
  wanigan_live.steady:
    class: Drupal\\wanigan_live\\Verify\\Steady
    arguments: ['@wanigan_live.token']
    tags:
      - { name: event_subscriber }
`;

/** The hook that seeds a view's random order, added to the end of the .module file. */
export const DRUPAL_VERIFY_MODULE = String.raw`
/**
 * Implements hook_query_TAG_alter() for 'views'.
 *
 * Seeds a view's random order while a verification's render is held, and
 * only then (Verify\Steady).
 */
function wanigan_live_query_views_alter(\Drupal\Core\Database\Query\AlterableInterface $query) {
  \Drupal\wanigan_live\Verify\Steady::seedViews($query);
}
`;

export const DRUPAL_VERIFY_FILES: Readonly<Record<string, string>> = {
  'src/Verify/Steady.php': STEADY,
};
