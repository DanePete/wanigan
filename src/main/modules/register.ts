import { registerModule } from '../module-registry';
import { sessionsModule } from './sessions';
import { worktreesModule } from './worktrees';
import { checkpointsModule } from './checkpoints';
import { controlModule } from './control';
import { relayModule } from './relay';
import { reviewModule } from './review';
import { scoutModule } from './scout';
import { suggestModule } from './suggest';
import { usageModule } from './usage';
import { promptImproveModule } from './prompt-improve';

/**
 * Every module Wanigan ships, registered in one place.
 *
 * Imported first by index.ts as a convention, not a requirement: the registry
 * migrates a module that arrives after the database's own pass, so nothing
 * here depends on evaluation order. What this file is for is the list — the
 * main-process counterpart of src/shared/view-registry.ts's VIEWS, so "which
 * modules does this build carry" is one file rather than a grep.
 */
registerModule(sessionsModule);
registerModule(worktreesModule);
registerModule(checkpointsModule);
registerModule(controlModule);
registerModule(reviewModule);
registerModule(usageModule);
registerModule(scoutModule);
registerModule(suggestModule);
registerModule(relayModule);
registerModule(promptImproveModule);
