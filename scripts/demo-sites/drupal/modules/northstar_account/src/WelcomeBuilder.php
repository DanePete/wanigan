<?php

namespace Drupal\northstar_account;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Security\TrustedCallbackInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\Url;

/**
 * Builds the welcome for the person signed in: their name, and how many of
 * the pieces they wrote are waiting as drafts.
 *
 * It is personal (cached per user) and slower than the rest of the page, so
 * the block hands it over as a lazy builder with a placeholder, and BigPipe
 * streams it in after the page has been sent.
 */
final class WelcomeBuilder implements TrustedCallbackInterface {

  use StringTranslationTrait;

  public function __construct(
    private readonly AccountInterface $currentUser,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function trustedCallbacks(): array {
    return ['build'];
  }

  /**
   * Lazy builder callback.
   */
  public function build(): array {
    // Drafts are the newest revisions in the draft state; they are this
    // person's when they wrote that revision.
    $drafts = 0;
    if ($this->entityTypeManager->hasDefinition('content_moderation_state')) {
      $states = $this->entityTypeManager->getStorage('content_moderation_state');
      $ids = $states->getQuery()
        ->accessCheck(FALSE)
        ->latestRevision()
        ->condition('moderation_state', 'draft')
        ->condition('content_entity_type_id', 'node')
        ->execute();
      $nodes = $this->entityTypeManager->getStorage('node');
      foreach ($states->loadMultiple($ids) as $state) {
        $revision = $nodes->loadRevision($state->get('content_entity_revision_id')->value);
        if ($revision && (int) $revision->getRevisionUserId() === (int) $this->currentUser->id()) {
          $drafts++;
        }
      }
    }
    return [
      '#type' => 'component',
      '#component' => 'northstar:welcome',
      '#props' => [
        // First names in the header: it is a small chip.
        'name' => explode(' ', (string) $this->currentUser->getDisplayName())[0],
        'drafts' => $drafts,
        'drafts_label' => (string) $this->formatPlural($drafts, '1 draft of yours is waiting', '@count drafts of yours are waiting'),
        'drafts_url' => Url::fromRoute('content_moderation.admin_moderated_content')->toString(),
        'account_url' => Url::fromRoute('user.page')->toString(),
      ],
      '#cache' => [
        'contexts' => ['user'],
        'tags' => ['node_list', 'content_moderation_state_list'],
      ],
    ];
  }

}
