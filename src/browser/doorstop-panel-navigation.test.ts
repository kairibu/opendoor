// Unit tests for the panel deep-link navigation module (plan Phase C step
// C2): the key constants the controller writes / render applies, and
// readPanelNavigationQuery's normalization of the host query shape (values
// `string | readonly string[]` → first string; arrays beyond the first entry,
// non-strings, and empty strings dropped; absent navigation → {}). The
// controller-side apply/write choreography lives in doorstop-panel.test.ts;
// the render wiring in doorstop-contributions.test.ts.

import { describe, expect, it } from "vitest";
import {
  DOORSTOP_NAV_DOC,
  DOORSTOP_NAV_FILE,
  DOORSTOP_NAV_FILTER,
  DOORSTOP_NAV_SEARCH,
  DOORSTOP_NAV_UID,
  readPanelNavigationQuery,
} from "./doorstop-panel-navigation.js";
import { navigationHarness } from "../test-fixtures.js";

describe("deep-link key constants", () => {
  it("uses the documented short keys", () => {
    expect(DOORSTOP_NAV_UID).toBe("uid");
    expect(DOORSTOP_NAV_DOC).toBe("doc");
    expect(DOORSTOP_NAV_FILTER).toBe("filter");
    expect(DOORSTOP_NAV_SEARCH).toBe("search");
    // C3: the chat file-link key (host-written, see DOORSTOP_NAV_FILE).
    expect(DOORSTOP_NAV_FILE).toBe("file");
  });
});

describe("readPanelNavigationQuery", () => {
  it("reads the harness query strings", () => {
    const navigation = navigationHarness({ uid: "REQ0001", filter: "unreviewed" });
    expect(readPanelNavigationQuery(navigation)).toEqual({ uid: "REQ0001", filter: "unreviewed" });
  });

  it("takes the first string of arrays and drops non-string and empty values", () => {
    const navigation = navigationHarness({});
    navigation.backingQuery["uid"] = ["REQ0001", "REQ0002"] as unknown as readonly string[];
    navigation.backingQuery["doc"] = 42 as unknown as readonly string[];
    navigation.backingQuery["search"] = "";
    navigation.backingQuery["filter"] = "suspect-link";
    expect(readPanelNavigationQuery(navigation)).toEqual({ uid: "REQ0001", filter: "suspect-link" });
  });

  it("returns {} for absent navigation (older hosts)", () => {
    expect(readPanelNavigationQuery(undefined)).toEqual({});
  });

  it("the harness set() mirrors the record: values write, undefined clears", () => {
    const navigation = navigationHarness({});
    navigation.set("uid", "REQ0001");
    expect(readPanelNavigationQuery(navigation)).toEqual({ uid: "REQ0001" });
    navigation.set("uid", undefined);
    expect(readPanelNavigationQuery(navigation)).toEqual({});
    expect(navigation.setCalls).toEqual([
      { key: "uid", value: "REQ0001", replace: undefined },
      { key: "uid", value: undefined, replace: undefined },
    ]);
  });
});
