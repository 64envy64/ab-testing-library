import type { RemoteConfig } from 'ab-testing-library'

/** Demo backend (run `npm run server`). These are local demo defaults, not secrets. */
export const API_BASE = 'http://localhost:8787'
export const WS_URL = 'ws://localhost:8787/config/stream'

/**
 * Demo admin token. This is the SDK's clearly-named dev fallback — it is NOT a
 * production secret and is labelled as a demo token in the UI. In production the
 * server reads `AB_ADMIN_TOKEN` from the environment.
 */
export const DEMO_ADMIN_TOKEN = 'dev-only-admin-token'

export const APP_KEY = 'ab-demo'

export const CHECKOUT_EXPERIMENT = 'checkout-copy'
export const TREATMENT_VARIANT = 'variant-b'
export const CHECKOUT_FLAG = 'newCheckoutFlow'

/** Offline bootstrap config — used until the live config arrives over WebSocket. */
export const DEFAULT_CONFIG: RemoteConfig = {
  experiments: {
    [CHECKOUT_EXPERIMENT]: {
      key: CHECKOUT_EXPERIMENT,
      seed: 'checkout-copy.v1',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 50 },
        { key: TREATMENT_VARIANT, weight: 50 },
      ],
    },
  },
  flags: {
    [CHECKOUT_FLAG]: { key: CHECKOUT_FLAG, seed: 'newCheckoutFlow.v1', enabled: true, rollout: 50 },
  },
}
