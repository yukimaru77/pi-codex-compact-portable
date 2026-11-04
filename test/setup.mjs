import { registerHooks } from 'node:module';
// Pi's real loader aliases these host peer dependencies. Mirror that in tests
// without installing/modifying dependencies in the user's npm package directory.
const host = (process.env.PI_HOST_DIR ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent').replace(/\/?$/, '/');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-coding-agent') return next('file://' + host + 'dist/index.js', context);
  if (specifier === '@earendil-works/pi-tui') return next('file://' + host + 'node_modules/@earendil-works/pi-tui/dist/index.js', context);
  return next(specifier, context);
} });