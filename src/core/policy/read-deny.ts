// D-DU-DENY-1: the Read (or one-file shell dump) deny over OUTPUT_CAP, impl/08 §6.1 step 6.
// One line from src/prompt/hooks/read-deny.md (inlined by build/build.mjs, lint-covered by build/prompt-lint.mjs):
// the exact ctx_execute call for this file. A ranged Read stays allowed (decide.ts); the text no longer lists it.
import { READ_DENY_RANGE_TEMPLATE, READ_DENY_TEMPLATE } from "../../prompt/_generated.ts";
import { DENY_PREFIX, READ_DENY_HEAD_MAX, prefixToolNames } from "../contracts/constants.ts";

export { READ_DENY_RANGE_TEMPLATE, READ_DENY_TEMPLATE };
const SIZE = "{size}";
const PATH = "{path}";

/** Size first, path last: the path is never re-scanned for a placeholder. */
/** D-HL-NAMES-1: tool names take the host prefix before the path goes in, so the path is never rewritten. */
export function READ_DENY_MESSAGE(path: string, size: number | string, prefix = ""): string {
  return prefixToolNames(READ_DENY_TEMPLATE, prefix).split(SIZE).join(String(size)).split(PATH).join(path);
}

/** D-R48-DENY-ROUTE-1 (#1326): a file ctx_execute(file=) cannot open (outside the project) gets the route that works
 *  for it: the host's own ranged read, or a bounded sed range, both of which the hooks always allow. */
export function READ_DENY_RANGE_MESSAGE(path: string, size: number | string): string {
  return READ_DENY_RANGE_TEMPLATE.split(SIZE).join(String(size)).split(PATH).join(path);
}

/** kaovilai/context-mode#11: both deny texts share this mark (pinned by test in tests/0027). */
export const READ_DENY_MARK = "over the one-read limit";
const READ_DENY_HEAD_SUFFIX = "-byte file, " + READ_DENY_MARK;
/** #11 + Copilot review: a read-deny is classified by its fixed first sentence —
 *  "context-mode: <digits>-byte file, over the one-read limit." — never by a substring anywhere in
 *  the reason. denyMessage embeds the caller's command and description later in its text, so a
 *  curl call described as "inspect the file over the one-read limit" must not re-classify a
 *  size-guess deny as a read-deny (it would then keep the dead ctx_execute route instead of failing
 *  open). Plain string walk, no regex. */
export function isReadDeny(reason: string): boolean {
  if (!reason.startsWith(DENY_PREFIX)) return false;
  const head = reason.slice(DENY_PREFIX.length, DENY_PREFIX.length + READ_DENY_HEAD_MAX);
  const dot = head.indexOf(".");
  if (dot < 0) return false;
  const sentence = head.slice(0, dot);
  if (!sentence.endsWith(READ_DENY_HEAD_SUFFIX)) return false;
  const size = sentence.slice(0, sentence.length - READ_DENY_HEAD_SUFFIX.length);
  return size.length > 0 && [...size].every((ch) => ch >= "0" && ch <= "9");
}
