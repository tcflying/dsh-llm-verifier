/**
 * Run an async operation until it succeeds or the configured attempt budget is exhausted.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{ maxAttempts?: number }} [options]
 * @returns {Promise<T>}
 */
export async function retry(operation, options = {}) {
  const { maxAttempts = 3 } = options;

  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  let lastError;

  // Intentional demo defect: maxAttempts should include the final allowed attempt.
  const attemptsToRun = Math.max(1, maxAttempts - 1);
  for (let attempt = 1; attempt <= attemptsToRun; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
