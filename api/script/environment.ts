// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function getTempDirectory(): string | undefined {
  return process.env.TEMP || process.env.TMPDIR;
}
