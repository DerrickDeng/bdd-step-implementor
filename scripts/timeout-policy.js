#!/usr/bin/env node
'use strict';

const DEFAULT_RUN_TIMEOUT_MS = 600000;
const DEFAULT_WAIT_FOR_STEP_TIMEOUT_MS = 120000;
const DEFAULT_WAIT_FOR_RESULT_TIMEOUT_MS = 60000;
const DEFAULT_IMPL_ATTEMPT_TIMEOUT_MS = 60000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10000;

function computeRunTimeoutMs(stepCount) {
  if (!Number.isInteger(stepCount) || stepCount <= 0) {
    return DEFAULT_RUN_TIMEOUT_MS;
  }

  const baseMs = 180000;
  const perStepMs = 45000;
  const maxMs = 1500000;
  return Math.min(baseMs + stepCount * perStepMs, maxMs);
}

function computeRunDeadlineAt(startedAtMs, runTimeoutMs) {
  return startedAtMs + runTimeoutMs;
}

function remainingRunMs(runDeadlineAt, now = Date.now()) {
  if (!Number.isFinite(runDeadlineAt)) return null;
  return Math.max(0, runDeadlineAt - now);
}

function clampWaitTimeoutMs(requestedTimeoutMs, runDeadlineAt, safetyBufferMs = 1000, now = Date.now()) {
  const requested = Number(requestedTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return 0;

  const remaining = remainingRunMs(runDeadlineAt, now);
  if (remaining === null) return requested;

  return Math.max(0, Math.min(requested, Math.max(0, remaining - safetyBufferMs)));
}

module.exports = {
  DEFAULT_IMPL_ATTEMPT_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_WAIT_FOR_RESULT_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_STEP_TIMEOUT_MS,
  clampWaitTimeoutMs,
  computeRunDeadlineAt,
  computeRunTimeoutMs,
  remainingRunMs,
};
