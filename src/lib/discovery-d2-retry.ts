import type { DiscoveryRunRecord } from '../discovery/run-service.js';

/** D2 retry is a distinct queue transition, never a general-purpose Run reset. */
export function canRetryDiscoveryD2(
  run: Pick<
    DiscoveryRunRecord,
    | 'runType'
    | 'status'
    | 'windowStartDate'
    | 'windowEndDate'
    | 'inputContentIds'
    | 'selectionOutput'
    | 'executionState'
    | 'configSnapshot'
  >,
  hasCandidates: boolean,
): boolean {
  const version = (run.configSnapshot?.promptVersions as Record<string, unknown> | undefined)?.[
    'discovery.d2.topic_selection'
  ];
  return (
    run.runType === 'regular' &&
    run.status === 'failed' &&
    run.executionState.d2?.status === 'failed' &&
    !run.selectionOutput &&
    Boolean(
      run.windowStartDate &&
      run.windowEndDate &&
      run.inputContentIds &&
      ['event', 'digest', 'longForm'].every((key) =>
        Array.isArray(
          run.inputContentIds?.[key as keyof NonNullable<DiscoveryRunRecord['inputContentIds']>],
        ),
      ) &&
      typeof version === 'string' &&
      version,
    ) &&
    !hasCandidates &&
    !(['d3', 'd4', 'd5'] as const).some((stage) => Boolean(run.executionState[stage]))
  );
}
