/**
 * Barrel for the Doorstop workspace panel body element.
 *
 * The implementation lives in sibling modules (`doorstop-panel-element.ts`
 * for the custom element class and registration, `doorstop-panel-view-model.ts`
 * for the pure helpers, `doorstop-panel-styles.ts`, `doorstop-panel-icons.ts`);
 * this module preserves the historical import path so consumers and tests
 * keep importing from one place.
 */
export * from "./doorstop-panel-view-model.js";
export {
  bodyElementTag,
  defineDoorstopPanelElements,
  type DoorstopPanelBodyElement,
} from "./doorstop-panel-element.js";
