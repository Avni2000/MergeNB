/**
 * @file vscodeRegression.test.ts
 * @description Combined VS Code extension host regression suite.
 *
 * Runs all requiresVSCode regression tests sequentially in a single VS Code
 * launch to minimize the number of slow sequential extension-host invocations.
 *
 * Order is meaningful: statusIndicators must run first because it asserts on
 * the startup conflict state created by repoSetup.  The remaining tests
 * manipulate the git index independently and tolerate any prior repo state.
 */

import { run as runStatusIndicators } from './statusIndicatorsRegression.test';
import { run as runUnmergedStatusMatrix } from './unmergedStatusMatrix.test';
import { run as runDuUdPickOne } from './duUdPickOneRegression.test';
import { run as runAuUaPickOne } from './auUaPickOneRegression.test';
import { run as runLogicRegression } from './logicRegression.test';

export async function run(): Promise<void> {
    await runStatusIndicators();
    await runUnmergedStatusMatrix();
    await runDuUdPickOne();
    await runAuUaPickOne();
    await runLogicRegression();
}
