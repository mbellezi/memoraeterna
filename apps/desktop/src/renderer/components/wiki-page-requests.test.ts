import { expect, it } from "vitest";
import { createWikiPageRequests } from "./wiki-page-requests";

it("rejects an in-flight current refresh and dialog-close refresh after historical navigation to the same page", async () => {
  const requests = createWikiPageRequests();
  const currentRefresh = requests.capture(), dialogCloseRefresh = requests.capture();
  let completeCurrent!: (value: string) => void, completeDialog!: (value: string) => void;
  let shown = "current";
  const current = new Promise<string>(resolve => { completeCurrent = resolve; }).then(value => { if (currentRefresh()) shown = value; });
  const dialog = new Promise<string>(resolve => { completeDialog = resolve; }).then(value => { if (dialogCloseRefresh()) shown = value; });
  const historical = requests.begin();
  if (historical()) shown = "same-page:historical-revision";
  completeCurrent("same-page:current-revision");
  completeDialog("same-page:current-from-dialog-close");
  await Promise.all([current, dialog]);
  expect(shown).toBe("same-page:historical-revision");
});

it("invalidates pending reads when entering a draft, and permits new refreshes after subsequent navigation", () => {
  const requests = createWikiPageRequests(), old = requests.capture();
  requests.invalidate();
  expect(old()).toBe(false);
  const firstNavigation = requests.begin(), latestNavigation = requests.begin();
  expect(firstNavigation()).toBe(false);
  expect(latestNavigation()).toBe(true);
  expect(requests.capture()()).toBe(true);
});
