// Foundry for bb: compiled by `bb plugin build` into dist/app.js. React and @get-bb/plugin-sdk/app come from the host.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { FoundryPanel } from "./src/panel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "foundry",
    title: "Foundry",
    icon: "Mountain",
    path: "foundry",
    component: () => <FoundryPanel />,
  });
});
