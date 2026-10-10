// The Drupal helper's Paragraphs adapters (site adapters: docs/design/2026-10-10-site-adapters.md): words inside a
// paragraph, saved through the root host that holds it, as Paragraphs' own widget and Layout Paragraphs' builder save
// them. A paragraph is a composite (Entity Reference Revisions): its host pins one revision of it, every new host
// revision forks a new one, and a draft of the host keeps its own copy; so a paragraph saved alone changes the page
// but is put back by the next publish of a draft, skips the host's workflow (Paragraphs takes the moderation handler
// off paragraphs), its revision log, changed time and concurrent-edit check, and can reach another page that pins the
// same revision. Three adapters, one per module, so each module's own calls are declared where the compatibility
// watch reads them and a site without one of the optional modules is not refused for it: Paragraphs (the save),
// Paragraphs Library (a library item is a root every page using it shows) and Layout Paragraphs (an open builder's
// copy writes over a save). Read from Paragraphs 8.x-1.23, Entity Reference Revisions 8.x-1.14 and Layout Paragraphs
// 3.0.0. PHP source. Called by LiveController's save (POST /_wanigan/save, live-helper-drupal.ts) for a field the page
// marked on a composite, and by anything else that changes words in one (Paragraphs::save() takes the change as a
// callback).

const PARAGRAPHS = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityChangedInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\Plugin\Validation\Constraint\EntityChangedConstraint;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\Core\Entity\TranslatableRevisionableInterface;
use Drupal\entity_reference_revisions\EntityNeedsSaveInterface;
use Drupal\wanigan_live\Save\Words;
use Drupal\wanigan_live\Trace\Identity;

/**
 * Words inside a paragraph (any composite), saved through its root host.
 *
 * A composite is an entity type whose definition names the field that points
 * back at its parent (entity_revision_parent_id_field: Paragraphs declares it,
 * and so may any other Entity Reference Revisions composite), never one known
 * by its type id. Its host's field pins one revision of it (target_id and
 * target_revision_id) and the page shows exactly that one.
 *
 * So the change is made where the host's own save will carry it, as
 * Paragraphs' widget (ParagraphsWidget::massageFormValues()) and Layout
 * Paragraphs' builder (LayoutParagraphsBuilderForm::submitForm()) do: walk up
 * the parent fields to the first entity that is not a composite (the root),
 * refuse on the root's state, go down the root's default revision through each
 * pinned item to the one pinning the revision the page showed (anything else
 * means the page is stale), change that very paragraph object, mark it and
 * every paragraph above it as needing a save, and save the root as a new
 * revision with its log, user and changed time after its own validation. Entity
 * Reference Revisions' item save (EntityReferenceRevisionsItem::preSave())
 * then saves each paragraph as a new revision of its own and pins it. Access is
 * the root's update access, as Paragraphs' own access handler defers to it.
 *
 * Only the symmetric translation setup Paragraphs supports is saved (the host's
 * paragraphs field untranslatable, the paragraphs' fields translatable), and
 * never into a language the paragraph has no translation in: it shows its own
 * language's words there, and saving them would change those.
 */
final class Paragraphs implements AdapterInterface {

  /**
   * How deep paragraphs may nest before the walk up calls it a loop.
   */
  private const DEPTH = 20;

  /**
   * The keys of a composite's entity type that name its parent fields.
   */
  private const PARENT = ['entity_revision_parent_type_field', 'entity_revision_parent_id_field', 'entity_revision_parent_field_name_field'];

  public static function id(): string {
    return 'paragraphs';
  }

  public static function module(): string {
    return 'paragraphs';
  }

  public static function requires(): array {
    return [
      // The paragraph entity type, whose definition names its parent fields
      // (entity_revision_parent_type_field, _id_field, _field_name_field: the
      // walk up refuses by name when one is gone).
      'entity_type:paragraph',
      'class:\Drupal\paragraphs\Entity\Paragraph',
      'class:\Drupal\paragraphs\ParagraphInterface',
      // Entity Reference Revisions, which Paragraphs requires: the field type
      // whose items pin a revision (target_id, target_revision_id, entity),
      // its item save that saves each marked paragraph as a new revision and
      // pins it, and the flag that marks one as needing it.
      'class:\Drupal\entity_reference_revisions\Plugin\Field\FieldType\EntityReferenceRevisionsItem',
      'method:\Drupal\entity_reference_revisions\Plugin\Field\FieldType\EntityReferenceRevisionsItem::preSave',
      'class:\Drupal\entity_reference_revisions\EntityNeedsSaveInterface',
      'method:\Drupal\entity_reference_revisions\EntityNeedsSaveInterface::setNeedsSave',
      'method:\Drupal\paragraphs\Entity\Paragraph::setNeedsSave',
      // The paragraph template the helper marks (wanigan_live_preprocess_paragraph()).
      'hook:preprocess_paragraph',
    ];
  }

  public static function verified(): array {
    return ['from' => '1.23', 'through' => '1.23'];
  }

  /**
   * Saves a change inside a composite through its root host: [HTTP status,
   * answer].
   *
   * @param string $type
   *   The composite's entity type, as the page marked it.
   * @param string $id
   *   Its id.
   * @param string $shown
   *   The revision of it the page showed: the one its host pins.
   * @param string $langcode
   *   The translation of it the page showed.
   * @param string|null $page
   *   The language the page's content was rendered in, when the page said.
   * @param callable $edit
   *   Makes the change in the composite: given that translation of it, the
   *   very object the root's save carries, it returns NULL once the change is
   *   made, or why not as [HTTP status, words].
   * @param string $fingerprint
   *   What is changed (the old and new words): a confirmation is for this
   *   change only.
   * @param string|null $confirm
   *   The token a first answer gave, when it asked first (a library item).
   *
   * @return array
   *   [HTTP status, answer]: on a save, the root's label, its new revision,
   *   its workflow state and its address after the save and before it
   *   ('url', 'was'); on a refusal, why ('error'), and a 'confirm' token when
   *   asking again saves it. Each carries this adapter's state ('adapter').
   */
  public static function save(string $type, string $id, string $shown, string $langcode, ?string $page, callable $edit, string $fingerprint, ?string $confirm): array {
    $status = Adapters::status(self::class);
    if ($status['status'] === 'absent') {
      // Never saved on its own: that is the defect this adapter exists for.
      return [409, self::refusal('This is inside a ' . $type . ', which Drupal saves only through the content that holds it, and Wanigan saves through that only with Paragraphs, which this site does not have. Nothing is saved: change it in Drupal’s form.')];
    }
    if ($status['status'] === 'broken') {
      return [409, self::refusal(Adapters::refusal($status))];
    }
    [$code, $answer] = self::through($type, $id, $shown, $langcode, $page, $edit, $fingerprint, $confirm);
    $answer['adapter'] = ['id' => $status['id'], 'name' => $status['name'], 'version' => $status['version'], 'status' => $status['status']];
    return [$code, $answer];
  }

  /**
   * The save, once the adapter may run.
   */
  private static function through(string $type, string $id, string $shown, string $langcode, ?string $page, callable $edit, string $fingerprint, ?string $confirm): array {
    if ($shown === '') {
      return [409, self::refusal('The page did not say which version of this paragraph it showed, so nothing is saved. Reload, and try again.')];
    }
    $types = \Drupal::entityTypeManager();
    // The revision the page showed: the one its host pins, which is where its
    // parent fields are read.
    $shownChild = $types->hasDefinition($type) ? $types->getStorage($type)->loadRevision($shown) : NULL;
    if (!$shownChild instanceof ContentEntityInterface || (string) $shownChild->id() !== $id || !Identity::composite($shownChild->getEntityType())) {
      return [409, self::refusal('This paragraph changed since the page loaded. Reload, and try again.')];
    }
    $what = self::what($shownChild);
    [$chain, $refused] = self::chain($shownChild, $what);
    if ($refused) {
      return $refused;
    }
    $root = $chain[count($chain) - 1][0];
    $named = self::named($root);

    // The translation. A paragraph with no translation in the page's language
    // shows its own language's words there (ERR's formatter falls back,
    // EntityRepository::getTranslationFromContext()): saving them would change
    // those, on every page in that language.
    if ($page !== NULL && $page !== $langcode && $root->hasTranslation($page) && !$shownChild->hasTranslation($page)) {
      return [409, self::refusal('This ' . $what . ' has no ' . self::language($page) . ' translation, so the page shows its ' . self::language($langcode) . ' words, and saving them here would change the ' . self::language($langcode) . ' ones. Nothing is saved: translate it in Drupal first.')];
    }
    if ($root->hasTranslation($langcode)) {
      $root = $root->getTranslation($langcode);
    }
    elseif (count($root->getTranslationLanguages()) > 1) {
      return [409, self::refusal($named . ', which this ' . $what . ' is in, has no ' . self::language($langcode) . ' translation, so Wanigan cannot tell which of its translations to save. Change it in Drupal’s form.')];
    }

    // A block placed only in a layout shows the revision of it the layout
    // keeps: a save of the block would change nothing on the page.
    if ($root->getEntityTypeId() === 'block_content' && method_exists($root, 'isReusable') && !$root->isReusable()) {
      return [409, self::refusal('This ' . $what . ' is inside a block placed only in a layout, which shows the version of the block it keeps, and Wanigan does not save through both yet. Nothing is saved: change it in Layout Builder.')];
    }

    // A newer revision of the root than the one visitors see: any, not only
    // one that changed this translation. Every host revision forks its own
    // revision of each paragraph its untranslatable field holds
    // (EntityReferenceRevisionsItem::preSave()), whatever it changed, so
    // publishing that draft would bring this paragraph's old words back.
    $storage = $types->getStorage($root->getEntityTypeId());
    if ($root->getEntityType()->isRevisionable()) {
      $latest = $storage->getLatestRevisionId($root->id());
      if ($latest !== NULL && (int) $latest > (int) $root->getRevisionId()) {
        return [409, self::refusal($named . ' has a newer draft than the version visitors see, and that draft keeps its own copy of this ' . $what . ': publishing it would bring the old words back. Nothing is saved: change it in Drupal’s form, which edits the draft.')];
      }
    }
    if (!$root->access('update')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change ' . $named . ', which this ' . $what . ' is saved through. Log in there as someone who may.')];
    }

    // Down from the root's default revision, through the revision each level
    // pins, to the item pinning the revision the page showed.
    $host = $root;
    $above = [];
    for ($i = count($chain) - 1; $i >= 0; $i--) {
      [, $field, $below] = $chain[$i];
      $items = $host->get($field);
      $definition = $items->getFieldDefinition();
      if ($definition->getType() !== 'entity_reference_revisions') {
        return [409, self::refusal('This ' . $what . ' is held by a field (' . $field . ') that does not keep which version of it is shown, so Wanigan cannot tell that the page showed the version saved. Nothing is saved: change it in Drupal’s form.')];
      }
      if ($definition->isTranslatable() && $host->isTranslatable()) {
        return [409, self::refusal('The field holding this ' . $what . ' (' . $field . ') is translatable, so each translation keeps its own paragraphs, a setup Paragraphs does not support and Wanigan does not save. Nothing is saved: change it in Drupal’s form.')];
      }
      $leaf = $i === 0;
      $found = [];
      $there = FALSE;
      foreach ($items as $item) {
        if ((string) $item->target_id !== $below) {
          continue;
        }
        $there = TRUE;
        if (!$leaf || (string) $item->target_revision_id === $shown) {
          $found[] = $item;
        }
      }
      if (count($found) > 1) {
        return [409, self::refusal($named . ' holds this ' . $what . ' more than once, so which one the page showed is not clear. Nothing is saved: change it in Drupal’s form.')];
      }
      $next = $found ? $found[0]->entity : NULL;
      if (!$next instanceof ContentEntityInterface) {
        return [409, self::refusal($leaf && $there
          ? 'The page showed a version of this ' . $what . ' that ' . $named . ' does not show now: it was saved again since the page loaded, or the page shows a version visitors do not see. Reload, and try again.'
          : 'This ' . $what . ' is no longer in ' . $named . ': it changed since the page loaded. Reload, and try again.')];
      }
      if ($next->hasTranslation($langcode)) {
        $next = $next->getTranslation($langcode);
      }
      elseif ($leaf) {
        return [409, self::refusal('This ' . $what . ' has no ' . self::language($langcode) . ' translation now: it changed since the page loaded. Reload, and try again.')];
      }
      if (!$leaf) {
        $above[] = $next;
      }
      $host = $next;
    }
    $child = $host;

    // What else holds a copy that would write over the save, and whether the
    // root shows beyond this page.
    $lp = Adapters::status(LayoutParagraphs::class);
    if ($lp['status'] === 'broken') {
      return [409, self::refusal(Adapters::refusal($lp))];
    }
    $hosts = [$root->getEntityTypeId() . ':' . $root->id() => TRUE];
    foreach ($above as $paragraph) {
      $hosts[$paragraph->getEntityTypeId() . ':' . $paragraph->id()] = TRUE;
    }
    if ($lp['status'] !== 'absent' && ($open = LayoutParagraphs::open($hosts, $root instanceof EntityChangedInterface))) {
      return [409, self::refusal($open)];
    }
    $library = Adapters::status(ParagraphsLibrary::class);
    if ($library['status'] === 'broken') {
      return [409, self::refusal(Adapters::refusal($library))];
    }
    $shared = $library['status'] !== 'absent' && ParagraphsLibrary::is($root);

    // The change, in the paragraph object the root's save carries.
    if ($refusal = $edit($child)) {
      return [$refusal[0], self::refusal($refusal[1])];
    }
    // The paragraph's own violations (its fields' constraints, which the host's
    // validation does not reach); that it is older than its newest revision is
    // not one, since the host pins this one.
    $problems = [];
    foreach ($child->validate() as $violation) {
      if (!(method_exists($violation, 'getConstraint') && $violation->getConstraint() instanceof EntityChangedConstraint)) {
        $problems[] = self::said($violation);
      }
    }
    if ($problems) {
      return [422, self::refusal('Drupal would not save it. ' . implode(' ', array_slice($problems, 0, 3)))];
    }
    if ($shared) {
      // A library item: every page using it shows it. Said first, with how
      // far it reaches; saved when asked again with this token.
      $token = substr(hash('sha256', implode("\n", [$root->getEntityTypeId(), (string) $root->id(), (string) $child->uuid(), $shown, $fingerprint, (string) \Drupal::currentUser()->id()])), 0, 32);
      if ($confirm !== $token) {
        $reach = ParagraphsLibrary::reach($root);
        return [409, self::refusal('These words are in the library item ' . $named . ', which every page using it shows' . ($reach !== NULL ? ' (' . $reach . ($reach === 1 ? ' use' : ' uses') . ' now)' : '') . ', so saving them changes them on all of those pages.') + ['confirm' => $token]];
      }
    }

    // Marked, so each is saved even where the root keeps no revisions; then
    // the root, as a new revision where it keeps them.
    foreach (array_merge([$child], $above) as $paragraph) {
      if ($paragraph instanceof EntityNeedsSaveInterface) {
        $paragraph->setNeedsSave(TRUE);
      }
    }
    $now = \Drupal::time()->getRequestTime();
    if ($root->getEntityType()->isRevisionable()) {
      $root->setNewRevision(TRUE);
      if ($root instanceof RevisionLogInterface) {
        $root->setRevisionLogMessage('Words in a ' . $what . ' changed by hand in Wanigan’s live view.');
        $root->setRevisionUserId((int) \Drupal::currentUser()->id());
        $root->setRevisionCreationTime($now);
      }
      // This translation changed, though none of the root's own fields did.
      if ($root instanceof TranslatableRevisionableInterface) {
        $root->setRevisionTranslationAffected(TRUE);
      }
    }
    if ($root instanceof EntityChangedInterface) {
      $root->setChangedTime($now);
    }
    // Every violation of the root refuses it: one on another field, on the
    // content as a whole, or on its workflow's state (which a paragraph's own
    // validation never sees).
    $problems = [];
    foreach ($root->validate() as $violation) {
      $path = (string) $violation->getPropertyPath();
      if ($path === 'moderation_state' || str_starts_with($path, 'moderation_state.')) {
        return [403, self::refusal('Its workflow does not let the user you are logged in as in the live view save ' . $named . ', which this ' . $what . ' is saved through, as it is (' . trim(strip_tags((string) $violation->getMessage())) . '): a save here keeps its state, and nothing is made a draft instead. Change it in Drupal’s form.')];
      }
      $problems[] = self::said($violation);
    }
    if ($problems) {
      return [422, self::refusal('Drupal would not save ' . $named . ', which this ' . $what . ' is saved through. ' . implode(' ', array_slice($problems, 0, 3)))];
    }
    $was = Words::url($root);
    $root->save();
    $state = $root->hasField('moderation_state') ? $root->get('moderation_state')->value : NULL;
    return [200, [
      'ok' => TRUE,
      'label' => (string) $root->label(),
      'revision' => $root->getEntityType()->isRevisionable() ? (string) $root->getRevisionId() : NULL,
      'state' => is_string($state) ? $state : NULL,
      'url' => Words::url($root),
      'was' => $was,
    ]];
  }

  /**
   * The hosts above a composite, nearest first, each as [host (its default
   * revision), the field holding the one below, that one's id], the last
   * being the root: the first that is not itself a composite. Or a refusal.
   */
  private static function chain(ContentEntityInterface $child, string $what): array {
    $types = \Drupal::entityTypeManager();
    $chain = [];
    $seen = [];
    $at = $child;
    while (Identity::composite($at->getEntityType())) {
      $key = $at->getEntityTypeId() . ':' . $at->id();
      if (isset($seen[$key]) || count($chain) >= self::DEPTH) {
        return [NULL, [409, self::refusal('This ' . $what . ' is nested in a loop, or deeper than Wanigan follows, so what holds it is not clear. Nothing is saved: change it in Drupal’s form.')]];
      }
      $seen[$key] = TRUE;
      $definition = $at->getEntityType();
      $values = [];
      foreach (self::PARENT as $parent) {
        $name = (string) $definition->get($parent);
        if ($name === '' || !$at->hasField($name)) {
          return [NULL, [409, self::refusal('Wanigan cannot tell what holds this ' . $what . ': its kind of content does not say (' . $parent . '), and it is saved only through what holds it, never on its own. Nothing is saved: change it in Drupal’s form.')]];
        }
        $values[] = (string) $at->get($name)->value;
      }
      [$parentType, $parentId, $field] = $values;
      $parent = ($parentType !== '' && $parentId !== '' && $types->hasDefinition($parentType)) ? $types->getStorage($parentType)->load($parentId) : NULL;
      if (!$parent instanceof ContentEntityInterface || $field === '' || !$parent->hasField($field)) {
        return [NULL, [409, self::refusal('This ' . $what . ' belongs to nothing Drupal can load: the content that held it is gone, or no longer has the field that held it. A ' . $what . ' like that shows on no page Wanigan can save it through, and it is never saved on its own, so nothing is saved.')]];
      }
      $chain[] = [$parent, $field, (string) $at->id()];
      $at = $parent;
    }
    return [$chain, NULL];
  }

  /**
   * What a composite is called: its type's singular label ("paragraph").
   */
  private static function what(EntityInterface $entity): string {
    $type = $entity->getEntityType();
    $label = method_exists($type, 'getSingularLabel') ? trim((string) $type->getSingularLabel()) : '';
    return $label !== '' ? mb_strtolower($label) : $entity->getEntityTypeId();
  }

  /**
   * The root, by its label: “About us”.
   */
  private static function named(EntityInterface $entity): string {
    $label = trim((string) $entity->label());
    return $label !== '' ? '“' . $label . '”' : 'the ' . $entity->getEntityTypeId() . ' ' . $entity->id();
  }

  /**
   * A language's name, as the site calls it, or its code.
   */
  private static function language(string $code): string {
    try {
      $language = \Drupal::languageManager()->getLanguage($code);
      return $language ? (string) $language->getName() : $code;
    }
    catch (\Throwable) {
      return $code;
    }
  }

  private static function said(object $violation): string {
    $path = (string) $violation->getPropertyPath();
    return ($path !== '' ? $path . ': ' : '') . trim(strip_tags((string) $violation->getMessage()));
  }

  private static function refusal(string $message): array {
    return ['ok' => FALSE, 'error' => $message];
  }

}
`;

const LIBRARY = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

use Drupal\Core\Entity\EntityInterface;

/**
 * Paragraphs Library: a library item is a root every page using it shows.
 *
 * A library item (paragraphs_library_item) holds its paragraphs in an Entity
 * Reference Revisions field, so a paragraph in one walks up to the item as its
 * root (Paragraphs::save()). A "From library" paragraph on a page refers to the
 * item (field_reusable_paragraph, a plain reference: the item's default
 * revision), and the library's preprocess shows the item's paragraphs in its
 * place (ParagraphsLibraryHooks::preprocessParagraph()). So a save of the item
 * changes every page using it: said first, with how many uses there are.
 */
final class ParagraphsLibrary implements AdapterInterface {

  public static function id(): string {
    return 'paragraphs_library';
  }

  public static function module(): string {
    return 'paragraphs_library';
  }

  public static function requires(): array {
    return [
      'entity_type:paragraphs_library_item',
      // How a root is known to be a library item.
      'class:\Drupal\paragraphs_library\LibraryItemInterface',
      // What refers to an item, counted for its reach.
      'config:field.storage.paragraph.field_reusable_paragraph',
      'config:paragraphs.paragraphs_type.from_library',
      // What shows an item's paragraphs on each page using it.
      'hook:preprocess_paragraph',
    ];
  }

  public static function verified(): array {
    return ['from' => '1.23', 'through' => '1.23'];
  }

  /**
   * Whether a root is a library item.
   */
  public static function is(EntityInterface $root): bool {
    return is_a($root, 'Drupal\paragraphs_library\LibraryItemInterface');
  }

  /**
   * How many paragraphs use a library item now, or NULL when that cannot be
   * counted.
   */
  public static function reach(EntityInterface $item): ?int {
    try {
      $fields = \Drupal::service('entity_field.manager')->getFieldStorageDefinitions('paragraph');
      if (!isset($fields['field_reusable_paragraph'])) {
        return NULL;
      }
      return (int) \Drupal::entityTypeManager()->getStorage('paragraph')->getQuery()->accessCheck(FALSE)->condition('field_reusable_paragraph', $item->id())->count()->execute();
    }
    catch (\Throwable) {
      return NULL;
    }
  }

}
`;

const LAYOUT = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

use Drupal\Core\Entity\EntityInterface;

/**
 * Layout Paragraphs: an open builder's copy of a host writes over a save.
 *
 * Layout Paragraphs keeps each open layout in its private tempstore
 * ('layout_paragraphs', LayoutParagraphsLayoutTempstoreRepository), keyed by a
 * random id (LayoutParagraphsLayout::id()), not by its host. Its builder's
 * save (LayoutParagraphsBuilderForm::submitForm()) loads the host revision
 * the builder was opened on and sets the paragraphs field to its copy, with no
 * check of what was saved since: so a save made while a builder is open is
 * lost when the builder is saved. The copies are read through core's
 * key-value store, every user's (a private tempstore keeps each under its
 * owner), and any copy of a host the save goes through refuses it. An entity
 * form's copy (the field widget's, whose settings carry button_labels and no
 * reference_field_view_mode) is saved only through that form, which core's
 * changed-time check refuses once the host has changed since it was opened
 * (EntityChangedConstraint), so where the root keeps a changed time it is
 * not counted.
 */
final class LayoutParagraphs implements AdapterInterface {

  public static function id(): string {
    return 'layout_paragraphs';
  }

  public static function module(): string {
    return 'layout_paragraphs';
  }

  public static function requires(): array {
    return [
      // Core's store the tempstore keeps its copies in.
      'service:keyvalue.expirable',
      'service:layout_paragraphs.tempstore_repository',
      'class:\Drupal\layout_paragraphs\LayoutParagraphsLayoutTempstoreRepository',
      'method:\Drupal\layout_paragraphs\LayoutParagraphsLayoutTempstoreRepository::getWithStorageKey',
      'class:\Drupal\layout_paragraphs\LayoutParagraphsLayout',
      'method:\Drupal\layout_paragraphs\LayoutParagraphsLayout::getEntity',
      'method:\Drupal\layout_paragraphs\LayoutParagraphsLayout::getSettings',
      // The save this guards against: never called, read so a release that
      // changes it is looked at.
      'method:\Drupal\layout_paragraphs\Form\LayoutParagraphsBuilderForm::submitForm',
    ];
  }

  public static function verified(): array {
    return ['from' => '3.0.0', 'through' => '3.0.0'];
  }

  /**
   * Why an open layout of one of these hosts ('type:id' => TRUE) would write
   * over a save, or NULL. $changed: the root keeps a changed time, so an
   * entity form opened before the save cannot save over it.
   */
  public static function open(array $hosts, bool $changed): ?string {
    try {
      $copies = \Drupal::service('keyvalue.expirable')->get('tempstore.private.layout_paragraphs')->getAll();
    }
    catch (\Throwable) {
      return 'Wanigan could not read the layouts Layout Paragraphs has open, so it cannot tell whether one would write over these words. Nothing is saved: change them in Layout Paragraphs.';
    }
    foreach ($copies as $copy) {
      $layout = is_object($copy) && isset($copy->data) && is_object($copy->data) ? $copy->data : NULL;
      $entity = $layout !== NULL && method_exists($layout, 'getEntity') ? $layout->getEntity() : NULL;
      if (!$entity instanceof EntityInterface || !isset($hosts[$entity->getEntityTypeId() . ':' . $entity->id()])) {
        continue;
      }
      $settings = method_exists($layout, 'getSettings') ? (array) $layout->getSettings() : [];
      if ($changed && array_key_exists('button_labels', $settings) && !array_key_exists('reference_field_view_mode', $settings)) {
        continue;
      }
      return 'Layout Paragraphs has this layout open in its builder, and saving the builder would put its own copy back over these words. Nothing is saved: save or close the builder first, then make it real again.';
    }
    return NULL;
  }

}
`;

/** The Paragraphs adapters' files, by their path inside the module's folder. */
export const DRUPAL_PARAGRAPHS_FILES: Readonly<Record<string, string>> = {
  'src/Adapter/Paragraphs.php': PARAGRAPHS,
  'src/Adapter/ParagraphsLibrary.php': LIBRARY,
  'src/Adapter/LayoutParagraphs.php': LAYOUT,
};
