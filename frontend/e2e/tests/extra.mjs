// The e2e registry: what features add to the suite. This build has none.
//
//   extraTests   their tests, run after the shared ones
//   extraRoutes  rows for routes.mjs's ROUTES
//   extraTabs    their tabs for tabs.mjs: { label, after, devices? }
//   extraPrims   their tabs for navigation.mjs's tap tour: { label, id, after?, devices? }

export const extraTests = () => []
export const extraRoutes = []
export const extraTabs = []
export const extraPrims = []
