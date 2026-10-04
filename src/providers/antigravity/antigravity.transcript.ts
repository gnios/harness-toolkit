import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * How much of the transcript's tail is read. The step a PostToolUse reports is the newest one, so it sits at the end;
 * a step whose own line is larger than this reads as unknown rather than costing a full read on every tool call.
 */
const TAIL_BYTES = 512 * 1024;

const EXIT_CODE = /The command exited with code (-?\d+)\./;

function readTail(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // why: a read that starts mid-file starts mid-line; that fragment is not a line and is dropped.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function stepContent(line: string, stepIdx: number): string | undefined {
  try {
    const parsed = JSON.parse(line) as { step_index?: unknown; content?: unknown };
    return parsed.step_index === stepIdx && typeof parsed.content === "string" ? parsed.content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exit code agy recorded for a `run_command` step, or `null` when it cannot be established.
 *
 * why the transcript: PostToolUse carries `error: ""` for a command that exited non-zero — verified with an `ls` of a
 * missing directory — so the payload alone cannot tell a red test run from a green one. The step's transcript line
 * says `The command exited with code <N>.` ([/decisions/ad-146.md](/decisions/ad-146.md)).
 *
 * invariant: never throws, and never guesses. A missing or unreadable file, no line for the step (the hook may run
 * before the step is written — not verified either way), or a line without the sentence all answer `null`.
 */
export function readCommandExitCode(transcriptPath: string, stepIdx: number): number | null {
  const tail = readTail(transcriptPath);
  if (tail === null) {
    return null;
  }
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const content = stepContent(lines[index] ?? "", stepIdx);
    if (content === undefined) {
      continue;
    }
    const match = EXIT_CODE.exec(content);
    return match ? Number.parseInt(match[1] ?? "", 10) : null;
  }
  return null;
}
