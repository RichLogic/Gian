const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
const CHAR_COLON = 58;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;

/**
 * Browser-safe predicate used by Session / Runtime path fields.
 *
 * A value is accepted only when it is already a Node-canonical absolute path
 * on POSIX or Win32, and has no `.` / `..` segments on either separator.
 * Shared is imported by Web, so this must not touch `node:path`.
 */
export function isCanonicalAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false;
  if (value.split(/[\\/]/).some((part) => part === '.' || part === '..')) return false;
  return isNormalizedPosixAbsolute(value) || isNormalizedWin32Absolute(value);
}

function isNormalizedPosixAbsolute(value: string): boolean {
  return value.charCodeAt(0) === CHAR_FORWARD_SLASH && posixNormalize(value) === value;
}

function isNormalizedWin32Absolute(value: string): boolean {
  return win32IsAbsolute(value) && win32Normalize(value) === value;
}

function isPosixSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH;
}

function isWin32Separator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isWindowsDeviceRoot(code: number): boolean {
  return (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z)
    || (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z);
}

function posixNormalize(path: string): string {
  if (path.length === 0) return '.';
  const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
  let normalized = normalizeString(path, !isAbsolute, '/', isPosixSeparator);
  if (normalized.length === 0) {
    if (isAbsolute) return '/';
    return trailingSeparator ? './' : '.';
  }
  if (trailingSeparator) normalized += '/';
  return isAbsolute ? `/${normalized}` : normalized;
}

function win32IsAbsolute(path: string): boolean {
  const length = path.length;
  if (length === 0) return false;
  const code = path.charCodeAt(0);
  if (isWin32Separator(code)) return true;
  return length > 2
    && isWindowsDeviceRoot(code)
    && path.charCodeAt(1) === CHAR_COLON
    && isWin32Separator(path.charCodeAt(2));
}

function win32Normalize(path: string): string {
  const length = path.length;
  if (length === 0) return '.';

  let rootEnd = 0;
  let device: string | undefined;
  let isAbsolute = false;
  const code = path.charCodeAt(0);

  if (length > 1) {
    if (isWin32Separator(code)) {
      isAbsolute = true;
      if (isWin32Separator(path.charCodeAt(1))) {
        let cursor = 2;
        let last = cursor;
        while (cursor < length && !isWin32Separator(path.charCodeAt(cursor))) cursor += 1;
        if (cursor < length && cursor !== last) {
          const firstPart = path.slice(2, cursor);
          last = cursor;
          while (cursor < length && isWin32Separator(path.charCodeAt(cursor))) cursor += 1;
          if (cursor < length && cursor !== last) {
            last = cursor;
            while (cursor < length && !isWin32Separator(path.charCodeAt(cursor))) cursor += 1;
            if (cursor === length) {
              return `\\\\${firstPart}\\${path.slice(last)}\\`;
            }
            if (cursor !== last) {
              device = `\\\\${firstPart}\\${path.slice(last, cursor)}`;
              rootEnd = cursor;
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      device = path.slice(0, 2);
      rootEnd = 2;
      if (length > 2 && isWin32Separator(path.charCodeAt(2))) {
        isAbsolute = true;
        rootEnd = 3;
      }
    }
  } else if (isWin32Separator(code)) {
    return '\\';
  }

  let tail = rootEnd < length
    ? normalizeString(path.slice(rootEnd), !isAbsolute, '\\', isWin32Separator)
    : '';
  if (tail.length === 0 && !isAbsolute) tail = '.';
  if (tail.length > 0 && isWin32Separator(path.charCodeAt(length - 1))) tail += '\\';
  if (device === undefined) {
    return isAbsolute ? `\\${tail}` : tail;
  }
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

function normalizeString(
  path: string,
  allowAboveRoot: boolean,
  separator: string,
  isSeparator: (code: number) => boolean,
): string {
  let result = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index < path.length) {
      code = path.charCodeAt(index);
    } else if (isSeparator(code)) {
      break;
    } else {
      code = CHAR_FORWARD_SLASH;
    }

    if (isSeparator(code)) {
      if (lastSlash === index - 1 || dots === 1) {
        // matched a separator or a `.` segment
      } else if (dots === 2) {
        if (result.length < 2 || lastSegmentLength !== 2 || !endsWithDotDot(result, separator)) {
          if (result.length > 2) {
            const lastSlashIndex = result.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              result = '';
              lastSegmentLength = 0;
            } else {
              result = result.slice(0, lastSlashIndex);
              lastSegmentLength = result.length - 1 - result.lastIndexOf(separator);
            }
            lastSlash = index;
            dots = 0;
            continue;
          }
          if (result.length > 0) {
            result = '';
            lastSegmentLength = 0;
            lastSlash = index;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          result += result.length > 0 ? `${separator}..` : '..';
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, index);
        result = result.length > 0 ? `${result}${separator}${segment}` : segment;
        lastSegmentLength = index - lastSlash - 1;
      }
      lastSlash = index;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      dots += 1;
    } else {
      dots = -1;
    }
  }
  return result;
}

function endsWithDotDot(value: string, separator: string): boolean {
  return value === '..' || value.endsWith(`${separator}..`);
}
