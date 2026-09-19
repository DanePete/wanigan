import { registerModule } from '../module-registry';
import { storageModule } from './storage';
import { recoveryModule } from './recovery';
import { sessionsModule } from './sessions';
import { queueModule } from './queue';
import { headlessModule } from './headless';
import { worktreesModule } from './worktrees';
import { checkpointsModule } from './checkpoints';
import { backupModule } from './backup';
import { controlModule } from './control';
import { relayModule } from './relay';
import { reviewModule } from './review';
import { scoutModule } from './scout';
import { suggestModule } from './suggest';
import { usageModule } from './usage';
import { accountEligibilityModule } from './account-eligibility';
import { learningModelAssistModule } from './learning-model-assist';
import { promptImproveModule } from './prompt-improve';
import { companionModule } from './companion';
import { interviewModule } from './interview';
import { modelEconomicsModule } from './model-economics';
import { openRouterConnectionModule } from './openrouter-connection';

/**
 * Every module Wanigan ships, registered in one place.
 *
 * Imported first by index.ts as a convention, not a requirement: the registry
 * migrates a module that arrives after the database's own pass, so nothing
 * here depends on evaluation order. What this file is for is the list — the
 * main-process counterpart of src/shared/view-registry.ts's VIEWS, so "which
 * modules does this build carry" is one file rather than a grep.
 */
registerModule(storageModule);
registerModule(recoveryModule);
registerModule(sessionsModule);
registerModule(queueModule);
registerModule(headlessModule);
registerModule(worktreesModule);
registerModule(checkpointsModule);
registerModule(backupModule);
registerModule(controlModule);
registerModule(reviewModule);
registerModule(usageModule);
registerModule(accountEligibilityModule);
registerModule(learningModelAssistModule);
registerModule(scoutModule);
registerModule(suggestModule);
registerModule(relayModule);
registerModule(promptImproveModule);
registerModule(companionModule);
registerModule(interviewModule);
registerModule(modelEconomicsModule);
registerModule(openRouterConnectionModule);
