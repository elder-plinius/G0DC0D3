import { createHash } from 'node:crypto';

const blob = text => {
  if (text === null) return '0'.repeat(40);
  const bytes = Buffer.from(text);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
function lines(text) {
  if (!text) return [];
  const result = text.split('\n');
  if (text.endsWith('\n')) result.pop();
  return result;
}

/** Whole-file unified hunks deliberately require the imported base to match.
 * Export only; the controller never applies this patch to the original project.
 */
export function createGitPatch(diff) {
  return diff.map(({ path, before, after }) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
      || /[\x00-\x1f\x7f]/.test(path)) throw new Error('This filename cannot be exported as a safe Git patch.');
    if (![before, after].every(text => text === null || typeof text === 'string' && !text.includes('\0')))
      throw new Error('Patch export supports UTF-8 text changes only.');
    if (before === after) return '';
    const a = JSON.stringify('a/' + path), b = JSON.stringify('b/' + path);
    let patch = `diff --git ${a} ${b}\n`;
    if (before === null) patch += 'new file mode 100644\n';
    if (after === null) patch += 'deleted file mode 100644\n';
    patch += `index ${blob(before)}..${blob(after)}\n`;
    const oldLines = lines(before), newLines = lines(after);
    // Empty-file additions/deletions are fully represented by the mode and index.
    if (!oldLines.length && !newLines.length) return patch;
    patch += `--- ${before === null ? '/dev/null' : a}\n+++ ${after === null ? '/dev/null' : b}\n`;
    patch += `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`;
    for (const [text, list, prefix] of [[before, oldLines, '-'], [after, newLines, '+']]) {
      list.forEach((line, index) => {
        patch += prefix + line + '\n';
        if (index === list.length - 1 && !text.endsWith('\n')) patch += '\\ No newline at end of file\n';
      });
    }
    return patch;
  }).join('');
}
