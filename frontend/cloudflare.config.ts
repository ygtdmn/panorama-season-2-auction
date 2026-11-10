import { bindings, defineConfig, defineWorker } from "cf/config";

// Client-only dapp: no route handlers, no ISR, no next/image, so no KV cache or
// Images binding. Every value the app needs is a NEXT_PUBLIC_* build constant.
export default defineConfig({
  worker: defineWorker({
    name: "panorama-season-2-auction",
    // workers.dev only for now. Deploys enforce these fields, so a toggle flipped
    // in the dashboard comes back on the next push unless it is set here.
    domains: [],
    workersDev: true,
    previewUrls: false,
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-08",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    observability: { enabled: true },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
});
