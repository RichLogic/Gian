module.exports = async function () {
  const { assertExecutionAllowed } = await import('../../scripts/execution-policy.mjs');
  assertExecutionAllowed('package');
};
