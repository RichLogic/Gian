const { assertLocalDevPackageContext } = require('../../scripts/local-dev-package-guard.cjs');

module.exports = async function (context) {
  const { assertExecutionAllowed } = await import('../../scripts/execution-policy.mjs');
  if (process.env.GIAN_ALLOW_LOCAL_DEV_PACKAGE === '1') {
    assertLocalDevPackageContext(context);
    assertExecutionAllowed('dev-package-local');
  } else {
    assertExecutionAllowed('package');
  }
};
