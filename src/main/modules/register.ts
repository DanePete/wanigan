import { registerModule } from '../module-registry';
import { relayModule } from './relay';
import { scoutModule } from './scout';
import { suggestModule } from './suggest';

/**
 * Every module Wanigan ships, registered in one place.
 *
 * Imported first by index.ts as a convention, not a requirement: the registry
 * migrates a module that arrives after the database's own pass, so nothing
 * here depends on evaluation order. What this file is for is the list — the
 * main-process counterpart of src/shared/view-registry.ts's VIEWS, so "which
 * modules does this build carry" is one file rather than a grep.
 */
registerModule(scoutModule);
registerModule(suggestModule);
registerModule(relayModule);
