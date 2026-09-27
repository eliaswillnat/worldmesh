import { onRequestOptions as __api_notify_ts_onRequestOptions } from "/Users/elias/Projects/worldmesh/functions/api/notify.ts"
import { onRequestPost as __api_notify_ts_onRequestPost } from "/Users/elias/Projects/worldmesh/functions/api/notify.ts"

export const routes = [
    {
      routePath: "/api/notify",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_notify_ts_onRequestOptions],
    },
  {
      routePath: "/api/notify",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_notify_ts_onRequestPost],
    },
  ]