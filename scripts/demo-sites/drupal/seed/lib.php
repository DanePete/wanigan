<?php

/**
 * @file
 * Helpers for the Northstar seed: everything is "make sure it is like this",
 * so the seed can run again without duplicating anything.
 */

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\File\FileExists;
use Drupal\Core\File\FileSystemInterface;
use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\file\Entity\File;
use Drupal\image\Entity\ImageStyle;

function ns_say(string $what): void {
  echo "  · $what\n";
}

/** A UUID that is always the same for the same name. */
function ns_uuid(string $name): string {
  $h = md5('northstar-demo:' . $name);
  return sprintf('%s-%s-4%s-a%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 13, 3), substr($h, 17, 3), substr($h, 20, 12));
}

/** The content entity a name stands for, or NULL. */
function ns_find(string $type, string $name): ?ContentEntityInterface {
  $found = \Drupal::entityTypeManager()->getStorage($type)->loadByProperties(['uuid' => ns_uuid("$type:$name")]);
  return $found ? reset($found) : NULL;
}

/**
 * Loads a content entity by the UUID its name gives, or creates it; sets the
 * values; saves only when something changed (so a rerun adds no revisions).
 */
function ns_content(string $type, string $name, array $values): ContentEntityInterface {
  $storage = \Drupal::entityTypeManager()->getStorage($type);
  $entity = ns_find($type, $name) ?? $storage->create(['uuid' => ns_uuid("$type:$name")] + $values);
  if (!$entity->isNew()) {
    foreach ($values as $field => $value) {
      if ($field !== 'moderation_state') {
        $entity->set($field, $value);
      }
    }
  }
  if ($entity->isNew() || $entity->hasTranslationChanges()) {
    if (isset($values['moderation_state'])) {
      $entity->set('moderation_state', $values['moderation_state']);
    }
    $entity->save();
  }
  return $entity;
}

/** Makes sure a translation exists with these values; saves only on a change. */
function ns_translate(ContentEntityInterface $entity, string $langcode, array $values): void {
  $state = $values['moderation_state'] ?? NULL;
  unset($values['moderation_state']);
  if (!$entity->hasTranslation($langcode)) {
    // Fields that are not translatable are shared with the original.
    $translation = $entity->addTranslation($langcode, $values);
  }
  else {
    $translation = $entity->getTranslation($langcode);
    foreach ($values as $field => $value) {
      $translation->set($field, $value);
    }
  }
  if ($translation->isNewTranslation() || $translation->hasTranslationChanges()) {
    if ($state) {
      $translation->set('moderation_state', $state);
    }
    $translation->save();
  }
}

/** Loads a config entity or creates it, then sets the values and saves. */
function ns_config(string $type, string $id, array $values) {
  $storage = \Drupal::entityTypeManager()->getStorage($type);
  $entity = $storage->load($id) ?: $storage->create([$storage->getEntityType()->getKey('id') => $id] + $values);
  foreach ($values as $key => $value) {
    $entity->set($key, $value);
  }
  $entity->save();
  return $entity;
}

/** Makes sure a field exists on a bundle, with this label and these settings. */
function ns_field(string $entity_type, string $bundle, string $name, string $type, string $label, array $options = []): void {
  $storage = FieldStorageConfig::loadByName($entity_type, $name);
  if (!$storage) {
    FieldStorageConfig::create([
      'entity_type' => $entity_type,
      'field_name' => $name,
      'type' => $type,
      'cardinality' => $options['cardinality'] ?? 1,
      'settings' => $options['storage'] ?? [],
    ])->save();
  }
  elseif (isset($options['storage']['allowed_values'])) {
    $storage->setSetting('allowed_values', $options['storage']['allowed_values'])->save();
  }
  $field = FieldConfig::loadByName($entity_type, $bundle, $name) ?: FieldConfig::create([
    'entity_type' => $entity_type,
    'bundle' => $bundle,
    'field_name' => $name,
  ]);
  $field->set('label', $label);
  $field->set('required', $options['required'] ?? FALSE);
  $field->set('description', $options['description'] ?? '');
  $field->set('translatable', $options['translatable'] ?? TRUE);
  foreach ($options['settings'] ?? [] as $key => $value) {
    $field->setSetting($key, $value);
  }
  $field->save();
}

/** Sets a display's components to exactly these, hiding the rest. */
function ns_display(string $kind, string $entity_type, string $bundle, string $mode, array $components): void {
  $repo = \Drupal::service('entity_display.repository');
  $display = $kind === 'view' ? $repo->getViewDisplay($entity_type, $bundle, $mode) : $repo->getFormDisplay($entity_type, $bundle, $mode);
  $display->setStatus(TRUE);
  foreach (array_keys($display->getComponents()) as $name) {
    if (!isset($components[$name]) && $name !== 'layout_builder__layout') {
      $display->removeComponent($name);
    }
  }
  $weight = 0;
  foreach ($components as $name => $options) {
    $display->setComponent($name, $options + ['weight' => $weight++]);
  }
  $display->save();
}

/** A picture as a permanent file in public://northstar/, copied in again only when it changed. */
function ns_file(string $name): File {
  $images = getenv('DEMO_IMAGES') ?: '/var/www/html/.demo-images';
  $source = "$images/$name";
  if (!file_exists($source)) {
    throw new \RuntimeException("Missing picture $source: build.sh draws them first.");
  }
  $dir = 'public://northstar';
  $fs = \Drupal::service('file_system');
  $fs->prepareDirectory($dir, FileSystemInterface::CREATE_DIRECTORY);
  $uri = "$dir/$name";
  if (!file_exists($uri) || md5_file($uri) !== md5_file($source)) {
    $fs->copy($source, $uri, FileExists::Replace);
    foreach (ImageStyle::loadMultiple() as $style) {
      $style->flush($uri);
    }
  }
  $files = \Drupal::entityTypeManager()->getStorage('file')->loadByProperties(['uri' => $uri]);
  $file = $files ? reset($files) : File::create(['uri' => $uri, 'uid' => 1]);
  $file->setPermanent();
  $file->setFilename($name);
  if ($file->isNew() || $file->hasTranslationChanges()) {
    $file->save();
  }
  return $file;
}

/** An image field value for a picture. */
function ns_image(string $name, string $alt): array {
  $file = ns_file($name);
  [$w, $h] = getimagesize($file->getFileUri());
  return ['target_id' => $file->id(), 'alt' => $alt, 'width' => $w, 'height' => $h];
}

/** An image media item for a picture, made once. */
function ns_media(string $name, string $alt, string $label = ''): ContentEntityInterface {
  return ns_content('media', "image:$name", [
    'bundle' => 'image',
    'name' => $label ?: $alt,
    'uid' => 1,
    'status' => 1,
    'field_media_image' => ns_image($name, $alt),
  ]);
}

function ns_text(string $html, string $format = 'basic_html'): array {
  return ['value' => trim($html), 'format' => $format];
}

/** Only the permissions this site has, so a role never names one that does not exist. */
function ns_permissions(array $wanted): array {
  $known = array_keys(\Drupal::service('user.permissions')->getPermissions());
  return array_values(array_intersect($wanted, $known));
}
