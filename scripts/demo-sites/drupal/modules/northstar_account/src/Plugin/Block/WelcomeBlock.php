<?php

namespace Drupal\northstar_account\Plugin\Block;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Block\Attribute\Block;
use Drupal\Core\Block\BlockBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;

/**
 * Welcome back, for signed-in people only, built late by a lazy builder.
 */
#[Block(
  id: 'northstar_welcome',
  admin_label: new TranslatableMarkup('Welcome back (signed-in people)'),
  category: new TranslatableMarkup('Northstar'),
)]
final class WelcomeBlock extends BlockBase {

  /**
   * {@inheritdoc}
   */
  public function build(): array {
    return [
      '#lazy_builder' => ['northstar_account.welcome:build', []],
      '#create_placeholder' => TRUE,
    ];
  }

  /**
   * {@inheritdoc}
   */
  protected function blockAccess(AccountInterface $account) {
    return AccessResult::allowedIf($account->isAuthenticated())->addCacheContexts(['user.roles:authenticated']);
  }

}
