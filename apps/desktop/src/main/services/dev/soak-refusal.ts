/**
 * Why a DEV soak knob (or the setup) refuses to run. One class for the plan, the data root, the real
 * writer and the Decisions admission, so an unpackaged app that is asked for a soak it may not run
 * says so with a code a test can name (F3 T62, F4 T89).
 */
export type SoakKnobRefusalCode =
  | "packaged"
  | "outsideProfiles"
  | "invalidPlan"
  | "unknownProfile"
  | "conflictingKnob"
  | "needsFakeRemote"
  | "needsRealWriter"
  | "catalogHeadersOff"
  | "invalidValue"
  | "dataRoot"
  | "realWriter"
  | "decisions"
  | "lock";

export class SoakKnobRefusal extends Error {
  public constructor(
    public readonly code: SoakKnobRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "SoakKnobRefusal";
  }
}
