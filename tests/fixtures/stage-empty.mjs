/**
 * A package that exports no stage.
 *
 * The loader must refuse it **with a reason** rather than register something
 * that does not work — so the fixture carries an export that is not a stage.
 */

export const notAStage = 'this module carries no stage';
