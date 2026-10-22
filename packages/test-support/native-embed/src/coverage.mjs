/** Read the package admission table from scriptc 0.3 coverage output. */
export function parseNpmStatic(output) {
  const section = output.split('npm package compilation:')[1]?.split('\n\n')[0]
  const staticHits = [...(section ?? '').matchAll(/^\s+(\S+)\s+static\s*$/gm)].map(match => match[1])
  const refusedHits = [...(section ?? '').matchAll(/^\s+(\S+)\s+refused(?:\s+\((.*)\))?\s*$/gm)]
    .map(match => [match[1], match[2] ?? ''])
  return { staticHits, refusedHits, hasSection: section !== undefined }
}
