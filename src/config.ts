export type CandidateCount = 3 | 5;

export interface RuntimeConfig {
  readonly candidateProfile: string;
  readonly credentialRef: string;
  readonly verifierModel: string;
  readonly nEvaluations: number;
  readonly maxVerifierWorkers: number;
  readonly verifierEffort: "low" | "high" | "max";
  readonly verifierMaxTokens: number;
  readonly candidateTimeoutMs: number;
  readonly validationTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly maxVerifierTraceBytes: number;
  readonly stateDirectory: string;
  readonly dshExecutable: string;
  readonly dshHomeDirectory?: string;
}

export function normalizeCandidateCount(
  requestedCandidateCount: number | undefined,
  defaultCandidateCount: CandidateCount,
): CandidateCount {
  const candidateCount = requestedCandidateCount ?? defaultCandidateCount;
  if (candidateCount !== 3 && candidateCount !== 5) {
    throw new Error(
      `invalid candidateCount: expected 3 or 5, got ${JSON.stringify(candidateCount)}`,
    );
  }
  return candidateCount;
}
