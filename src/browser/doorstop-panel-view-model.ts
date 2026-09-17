/**
 * Barrel for the Doorstop panel body element's pure view-model helpers.
 *
 * The implementations live in `view-model/{core,item-list,palette,status-bar,findings}.ts`;
 * this module preserves the historical import path used by the element barrel,
 * the section modules and the tests (`isValidTargetUid` included).
 */
export * from "./view-model/core.js";
export * from "./view-model/item-list.js";
export * from "./view-model/palette.js";
export * from "./view-model/status-bar.js";
export * from "./view-model/findings.js";
