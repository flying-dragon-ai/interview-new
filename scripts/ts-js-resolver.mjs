/** Resolve emitted .js import specifiers back to their TypeScript source files
 * when Node runs the source-level test suite. Vercel deploys the emitted .js. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
