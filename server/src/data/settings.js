// Settings are global today: one key/value table shared by every workspace,
// including the Anthropic API key.
//
// NOTE FOR PHASE 1: these become per-user (a user_settings table keyed on
// user_id, plus an app_settings table for instance-wide configuration). The
// scope is already threaded through every caller, so that change lands here
// rather than in the routes.
export { getSettings, setSetting, deleteSetting } from '../db.js';
