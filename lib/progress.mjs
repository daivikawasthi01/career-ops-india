/**
 * progress.mjs: machine-readable progress lines for tools/mine.py.
 *
 * Scanners call progress() and fail() as they work. Nothing is printed unless
 * MINE_PROGRESS=1 is set (tools/mine.py sets it), so ordinary runs stay quiet.
 * Lines go to stderr as "@@PROGRESS done/total label" and "@@FAIL label<TAB>message".
 */
const ON = process.env.MINE_PROGRESS === '1';

export function progress(done, total, label) {
  if (ON) console.error(`@@PROGRESS ${done}/${total} ${label}`);
}

export function fail(label, message) {
  if (ON) console.error(`@@FAIL ${label}\t${String(message).replace(/\s+/g, ' ').slice(0, 300)}`);
}
