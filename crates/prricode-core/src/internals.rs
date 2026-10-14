//! Internal-type inventory: the disposition of every internal struct family
//! found in the engine surface (364 Debug-visible names).
//!
//! Every family is either IMPLEMENTED (the concept exists in prricode,
//! under our own naming — the wire protocol never carried these) or
//! FLAGGED (present here with a future-work note; not implemented).
//! Queryable via `inventory()`; conformance evidence for the goal.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Implemented,
    /// future work: recorded here, not implemented
    Flagged,
}

#[derive(Debug, Clone)]
pub struct InternalSurface {
    pub family: &'static str,
    pub members: usize,
    pub disposition: Disposition,
    /// Where it lives in prricode (Implemented) or the future-work note (Flagged).
    pub location: &'static str,
}

// future work: AddMemory internals — not implemented
pub const ADDMEMORY: InternalSurface = InternalSurface { family: "AddMemory", members: 1, disposition: Disposition::Flagged, location: "future work: AddMemory internals (e.g. AddMemoryArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AgentContext internals — not implemented
pub const AGENTCONTEXT: InternalSurface = InternalSurface { family: "AgentContext", members: 1, disposition: Disposition::Flagged, location: "future work: AgentContext internals (e.g. AgentContextBlockDiagnostic) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AgentInbox internals — not implemented
pub const AGENTINBOX: InternalSurface = InternalSurface { family: "AgentInbox", members: 3, disposition: Disposition::Flagged, location: "future work: AgentInbox internals (e.g. AgentInboxDeliveryAnomaly) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AgentLineage internals — not implemented
pub const AGENTLINEAGE: InternalSurface = InternalSurface { family: "AgentLineage", members: 1, disposition: Disposition::Flagged, location: "future work: AgentLineage internals (e.g. AgentLineageAdmissionV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AgentReminder internals — not implemented
pub const AGENTREMINDER: InternalSurface = InternalSurface { family: "AgentReminder", members: 2, disposition: Disposition::Flagged, location: "future work: AgentReminder internals (e.g. AgentReminderAgentRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AgentRequest internals — not implemented
pub const AGENTREQUEST: InternalSurface = InternalSurface { family: "AgentRequest", members: 1, disposition: Disposition::Flagged, location: "future work: AgentRequest internals (e.g. AgentRequestToolset) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-agent/src/loop_runner.rs
const AGENTRUN_IMPL: &str = "crates/prricode-agent/src/loop_runner.rs";
pub const AGENTRUN: InternalSurface = InternalSurface {
    family: "AgentRun",
    members: 2,
    disposition: Disposition::Implemented,
    location: AGENTRUN_IMPL,
};
/// IMPLEMENTED: crates/prricode-agent/src/tools/task.rs
const AGENTSPAWN_IMPL: &str = "crates/prricode-agent/src/tools/task.rs";
pub const AGENTSPAWN: InternalSurface = InternalSurface {
    family: "AgentSpawn",
    members: 6,
    disposition: Disposition::Implemented,
    location: AGENTSPAWN_IMPL,
};
// future work: AgentTree internals — not implemented
pub const AGENTTREE: InternalSurface = InternalSurface { family: "AgentTree", members: 1, disposition: Disposition::Flagged, location: "future work: AgentTree internals (e.g. AgentTreeInitializedV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ApiError internals — not implemented
pub const APIERROR: InternalSurface = InternalSurface { family: "ApiError", members: 1, disposition: Disposition::Flagged, location: "future work: ApiError internals (e.g. ApiErrorBody) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-agent/src/approval.rs + prricode-tui PolicyAmendment
const APPROVALPOLICY_IMPL: &str =
    "crates/prricode-agent/src/approval.rs + prricode-tui PolicyAmendment";
pub const APPROVALPOLICY: InternalSurface = InternalSurface {
    family: "ApprovalPolicy",
    members: 2,
    disposition: Disposition::Implemented,
    location: APPROVALPOLICY_IMPL,
};
// future work: ApprovalReconfigure internals — not implemented
pub const APPROVALRECONFIGURE: InternalSurface = InternalSurface { family: "ApprovalReconfigure", members: 1, disposition: Disposition::Flagged, location: "future work: ApprovalReconfigure internals (e.g. ApprovalReconfigureRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ApprovalRequirement internals — not implemented
pub const APPROVALREQUIREMENT: InternalSurface = InternalSurface { family: "ApprovalRequirement", members: 1, disposition: Disposition::Flagged, location: "future work: ApprovalRequirement internals (e.g. ApprovalRequirementId) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ApprovalWait internals — not implemented
pub const APPROVALWAIT: InternalSurface = InternalSurface { family: "ApprovalWait", members: 2, disposition: Disposition::Flagged, location: "future work: ApprovalWait internals (e.g. ApprovalWaitEffectStart) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AsyncOwner internals — not implemented
pub const ASYNCOWNER: InternalSurface = InternalSurface { family: "AsyncOwner", members: 3, disposition: Disposition::Flagged, location: "future work: AsyncOwner internals (e.g. AsyncOwnerAttemptLink) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AuditEffective internals — not implemented
pub const AUDITEFFECTIVE: InternalSurface = InternalSurface { family: "AuditEffective", members: 1, disposition: Disposition::Flagged, location: "future work: AuditEffective internals (e.g. AuditEffectiveGrantWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AuditResolution internals — not implemented
pub const AUDITRESOLUTION: InternalSurface = InternalSurface { family: "AuditResolution", members: 1, disposition: Disposition::Flagged, location: "future work: AuditResolution internals (e.g. AuditResolutionSummaryWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AuditSource internals — not implemented
pub const AUDITSOURCE: InternalSurface = InternalSurface { family: "AuditSource", members: 1, disposition: Disposition::Flagged, location: "future work: AuditSource internals (e.g. AuditSourceWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AuditWire internals — not implemented
pub const AUDITWIRE: InternalSurface = InternalSurface { family: "AuditWire", members: 1, disposition: Disposition::Flagged, location: "future work: AuditWire internals (e.g. AuditWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: AuthFile internals — not implemented
pub const AUTHFILE: InternalSurface = InternalSurface { family: "AuthFile", members: 1, disposition: Disposition::Flagged, location: "future work: AuthFile internals (e.g. AuthFile) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: BodyTemplate internals — not implemented
pub const BODYTEMPLATE: InternalSurface = InternalSurface { family: "BodyTemplate", members: 1, disposition: Disposition::Flagged, location: "future work: BodyTemplate internals (e.g. BodyTemplateDeclaration) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: BranchSeed internals — not implemented
pub const BRANCHSEED: InternalSurface = InternalSurface { family: "BranchSeed", members: 4, disposition: Disposition::Flagged, location: "future work: BranchSeed internals (e.g. BranchSeedCheckpointDiagnostics) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: BuildStamp internals — not implemented
pub const BUILDSTAMP: InternalSurface = InternalSurface { family: "BuildStamp", members: 1, disposition: Disposition::Flagged, location: "future work: BuildStamp internals (e.g. BuildStamp) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: BundledTheme internals — not implemented
pub const BUNDLEDTHEME: InternalSurface = InternalSurface { family: "BundledTheme", members: 1, disposition: Disposition::Flagged, location: "future work: BundledTheme internals (e.g. BundledThemeSource) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CapacitySnapshot internals — not implemented
pub const CAPACITYSNAPSHOT: InternalSurface = InternalSurface { family: "CapacitySnapshot", members: 1, disposition: Disposition::Flagged, location: "future work: CapacitySnapshot internals (e.g. CapacitySnapshotV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CatalogV1 internals — not implemented
pub const CATALOGV1: InternalSurface = InternalSurface { family: "CatalogV1", members: 1, disposition: Disposition::Flagged, location: "future work: CatalogV1 internals (e.g. CatalogV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CheckpointSession internals — not implemented
pub const CHECKPOINTSESSION: InternalSurface = InternalSurface { family: "CheckpointSession", members: 1, disposition: Disposition::Flagged, location: "future work: CheckpointSession internals (e.g. CheckpointSessionPayloadProbe) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ClientWeb internals — not implemented
pub const CLIENTWEB: InternalSurface = InternalSurface { family: "ClientWeb", members: 1, disposition: Disposition::Flagged, location: "future work: ClientWeb internals (e.g. ClientWebSearchOutput) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CodeMode internals — not implemented
pub const CODEMODE: InternalSurface = InternalSurface { family: "CodeMode", members: 2, disposition: Disposition::Flagged, location: "future work: CodeMode internals (e.g. CodeModeCellGrantRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CommandArgs internals — not implemented
pub const COMMANDARGS: InternalSurface = InternalSurface { family: "CommandArgs", members: 1, disposition: Disposition::Flagged, location: "future work: CommandArgs internals (e.g. CommandArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CommandGrammar internals — not implemented
pub const COMMANDGRAMMAR: InternalSurface = InternalSurface { family: "CommandGrammar", members: 1, disposition: Disposition::Flagged, location: "future work: CommandGrammar internals (e.g. CommandGrammar) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CommandInvoked internals — not implemented
pub const COMMANDINVOKED: InternalSurface = InternalSurface { family: "CommandInvoked", members: 1, disposition: Disposition::Flagged, location: "future work: CommandInvoked internals (e.g. CommandInvokedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CommandKey internals — not implemented
pub const COMMANDKEY: InternalSurface = InternalSurface { family: "CommandKey", members: 1, disposition: Disposition::Flagged, location: "future work: CommandKey internals (e.g. CommandKeyV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CommandSpec internals — not implemented
pub const COMMANDSPEC: InternalSurface = InternalSurface { family: "CommandSpec", members: 1, disposition: Disposition::Flagged, location: "future work: CommandSpec internals (e.g. CommandSpec) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionCandidate internals — not implemented
pub const COMPACTIONCANDIDATE: InternalSurface = InternalSurface { family: "CompactionCandidate", members: 1, disposition: Disposition::Flagged, location: "future work: CompactionCandidate internals (e.g. CompactionCandidatePayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionCursor internals — not implemented
pub const COMPACTIONCURSOR: InternalSurface = InternalSurface { family: "CompactionCursor", members: 1, disposition: Disposition::Flagged, location: "future work: CompactionCursor internals (e.g. CompactionCursor) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionFallback internals — not implemented
pub const COMPACTIONFALLBACK: InternalSurface = InternalSurface { family: "CompactionFallback", members: 1, disposition: Disposition::Flagged, location: "future work: CompactionFallback internals (e.g. CompactionFallbackPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionInstalled internals — not implemented
pub const COMPACTIONINSTALLED: InternalSurface = InternalSurface { family: "CompactionInstalled", members: 1, disposition: Disposition::Flagged, location: "future work: CompactionInstalled internals (e.g. CompactionInstalledPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionPreserved internals — not implemented
pub const COMPACTIONPRESERVED: InternalSurface = InternalSurface { family: "CompactionPreserved", members: 2, disposition: Disposition::Flagged, location: "future work: CompactionPreserved internals (e.g. CompactionPreservedSegment) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CompactionSummarizer internals — not implemented
pub const COMPACTIONSUMMARIZER: InternalSurface = InternalSurface { family: "CompactionSummarizer", members: 1, disposition: Disposition::Flagged, location: "future work: CompactionSummarizer internals (e.g. CompactionSummarizerUsage) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ConfigCatalog internals — not implemented
pub const CONFIGCATALOG: InternalSurface = InternalSurface { family: "ConfigCatalog", members: 1, disposition: Disposition::Flagged, location: "future work: ConfigCatalog internals (e.g. ConfigCatalogRow) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ContentPart internals — not implemented
pub const CONTENTPART: InternalSurface = InternalSurface { family: "ContentPart", members: 1, disposition: Disposition::Flagged, location: "future work: ContentPart internals (e.g. ContentPartEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: Context internals — not implemented
pub const CONTEXT: InternalSurface = InternalSurface { family: "Context", members: 1, disposition: Disposition::Flagged, location: "future work: Context internals (e.g. Context) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ContextBudget internals — not implemented
pub const CONTEXTBUDGET: InternalSurface = InternalSurface { family: "ContextBudget", members: 1, disposition: Disposition::Flagged, location: "future work: ContextBudget internals (e.g. ContextBudgetDiagnostic) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-server + load_history summary handling
const CONTEXTCHECKPOINT_IMPL: &str = "crates/prricode-server + load_history summary handling";
pub const CONTEXTCHECKPOINT: InternalSurface = InternalSurface {
    family: "ContextCheckpoint",
    members: 7,
    disposition: Disposition::Implemented,
    location: CONTEXTCHECKPOINT_IMPL,
};
// future work: ContextProjection internals — not implemented
pub const CONTEXTPROJECTION: InternalSurface = InternalSurface { family: "ContextProjection", members: 1, disposition: Disposition::Flagged, location: "future work: ContextProjection internals (e.g. ContextProjectionCheckpointPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CountsWire internals — not implemented
pub const COUNTSWIRE: InternalSurface = InternalSurface { family: "CountsWire", members: 1, disposition: Disposition::Flagged, location: "future work: CountsWire internals (e.g. CountsWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CronCreate internals — not implemented
pub const CRONCREATE: InternalSurface = InternalSurface { family: "CronCreate", members: 1, disposition: Disposition::Flagged, location: "future work: CronCreate internals (e.g. CronCreateArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CronDelete internals — not implemented
pub const CRONDELETE: InternalSurface = InternalSurface { family: "CronDelete", members: 1, disposition: Disposition::Flagged, location: "future work: CronDelete internals (e.g. CronDeleteArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CronList internals — not implemented
pub const CRONLIST: InternalSurface = InternalSurface { family: "CronList", members: 1, disposition: Disposition::Flagged, location: "future work: CronList internals (e.g. CronListResult) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: CustomProducer internals — not implemented
pub const CUSTOMPRODUCER: InternalSurface = InternalSurface { family: "CustomProducer", members: 1, disposition: Disposition::Flagged, location: "future work: CustomProducer internals (e.g. CustomProducerStatusDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DecisionBranch internals — not implemented
pub const DECISIONBRANCH: InternalSurface = InternalSurface { family: "DecisionBranch", members: 1, disposition: Disposition::Flagged, location: "future work: DecisionBranch internals (e.g. DecisionBranchMappings) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DecisionField internals — not implemented
pub const DECISIONFIELD: InternalSurface = InternalSurface { family: "DecisionField", members: 1, disposition: Disposition::Flagged, location: "future work: DecisionField internals (e.g. DecisionFieldDeclaration) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DecisionLimits internals — not implemented
pub const DECISIONLIMITS: InternalSurface = InternalSurface { family: "DecisionLimits", members: 1, disposition: Disposition::Flagged, location: "future work: DecisionLimits internals (e.g. DecisionLimits) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DecisionProposal internals — not implemented
pub const DECISIONPROPOSAL: InternalSurface = InternalSurface { family: "DecisionProposal", members: 1, disposition: Disposition::Flagged, location: "future work: DecisionProposal internals (e.g. DecisionProposalMapping) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DeviceAuthorization internals — not implemented
pub const DEVICEAUTHORIZATION: InternalSurface = InternalSurface { family: "DeviceAuthorization", members: 1, disposition: Disposition::Flagged, location: "future work: DeviceAuthorization internals (e.g. DeviceAuthorization) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: DuplexInbound internals — not implemented
pub const DUPLEXINBOUND: InternalSurface = InternalSurface { family: "DuplexInbound", members: 1, disposition: Disposition::Flagged, location: "future work: DuplexInbound internals (e.g. DuplexInbound) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-workflow/src/lib.rs
const DYNAMICWORKFLOW_IMPL: &str = "crates/prricode-workflow/src/lib.rs";
pub const DYNAMICWORKFLOW: InternalSurface = InternalSurface {
    family: "DynamicWorkflow",
    members: 8,
    disposition: Disposition::Implemented,
    location: DYNAMICWORKFLOW_IMPL,
};
// future work: EditArgs internals — not implemented
pub const EDITARGS: InternalSurface = InternalSurface { family: "EditArgs", members: 1, disposition: Disposition::Flagged, location: "future work: EditArgs internals (e.g. EditArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: EditMemory internals — not implemented
pub const EDITMEMORY: InternalSurface = InternalSurface { family: "EditMemory", members: 1, disposition: Disposition::Flagged, location: "future work: EditMemory internals (e.g. EditMemoryArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: EffectiveModel internals — not implemented
pub const EFFECTIVEMODEL: InternalSurface = InternalSurface { family: "EffectiveModel", members: 1, disposition: Disposition::Flagged, location: "future work: EffectiveModel internals (e.g. EffectiveModelState) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: EventPosition internals — not implemented
pub const EVENTPOSITION: InternalSurface = InternalSurface { family: "EventPosition", members: 1, disposition: Disposition::Flagged, location: "future work: EventPosition internals (e.g. EventPosition) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: EventStream internals — not implemented
pub const EVENTSTREAM: InternalSurface = InternalSurface { family: "EventStream", members: 1, disposition: Disposition::Flagged, location: "future work: EventStream internals (e.g. EventStream) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ExecCommand internals — not implemented
pub const EXECCOMMAND: InternalSurface = InternalSurface { family: "ExecCommand", members: 1, disposition: Disposition::Flagged, location: "future work: ExecCommand internals (e.g. ExecCommandArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ExpectedMessage internals — not implemented
pub const EXPECTEDMESSAGE: InternalSurface = InternalSurface { family: "ExpectedMessage", members: 1, disposition: Disposition::Flagged, location: "future work: ExpectedMessage internals (e.g. ExpectedMessage) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ExpectedModel internals — not implemented
pub const EXPECTEDMODEL: InternalSurface = InternalSurface { family: "ExpectedModel", members: 1, disposition: Disposition::Flagged, location: "future work: ExpectedModel internals (e.g. ExpectedModelContext) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ExpectedTask internals — not implemented
pub const EXPECTEDTASK: InternalSurface = InternalSurface { family: "ExpectedTask", members: 1, disposition: Disposition::Flagged, location: "future work: ExpectedTask internals (e.g. ExpectedTaskSummary) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: FieldValue internals — not implemented
pub const FIELDVALUE: InternalSurface = InternalSurface { family: "FieldValue", members: 1, disposition: Disposition::Flagged, location: "future work: FieldValue internals (e.g. FieldValueSource) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: FileSystem internals — not implemented
pub const FILESYSTEM: InternalSurface = InternalSurface { family: "FileSystem", members: 2, disposition: Disposition::Flagged, location: "future work: FileSystem internals (e.g. FileSystemSandboxEntry) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: FilesystemSubject internals — not implemented
pub const FILESYSTEMSUBJECT: InternalSurface = InternalSurface { family: "FilesystemSubject", members: 1, disposition: Disposition::Flagged, location: "future work: FilesystemSubject internals (e.g. FilesystemSubject) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ForegroundExec internals — not implemented
pub const FOREGROUNDEXEC: InternalSurface = InternalSurface { family: "ForegroundExec", members: 1, disposition: Disposition::Flagged, location: "future work: ForegroundExec internals (e.g. ForegroundExecCommandArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ForkProvenance internals — not implemented
pub const FORKPROVENANCE: InternalSurface = InternalSurface { family: "ForkProvenance", members: 1, disposition: Disposition::Flagged, location: "future work: ForkProvenance internals (e.g. ForkProvenance) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: FunctionCall internals — not implemented
pub const FUNCTIONCALL: InternalSurface = InternalSurface { family: "FunctionCall", members: 2, disposition: Disposition::Flagged, location: "future work: FunctionCall internals (e.g. FunctionCallArgumentsDelta) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: FutureCode internals — not implemented
pub const FUTURECODE: InternalSurface = InternalSurface { family: "FutureCode", members: 2, disposition: Disposition::Flagged, location: "future work: FutureCode internals (e.g. FutureCodeModeEvidenceCarrier) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalDescendant internals — not implemented
pub const GOALDESCENDANT: InternalSurface = InternalSurface { family: "GoalDescendant", members: 2, disposition: Disposition::Flagged, location: "future work: GoalDescendant internals (e.g. GoalDescendantLaunchAcceptedWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalFork internals — not implemented
pub const GOALFORK: InternalSurface = InternalSurface { family: "GoalFork", members: 1, disposition: Disposition::Flagged, location: "future work: GoalFork internals (e.g. GoalForkSnapshotManifestRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalHandoff internals — not implemented
pub const GOALHANDOFF: InternalSurface = InternalSurface { family: "GoalHandoff", members: 1, disposition: Disposition::Flagged, location: "future work: GoalHandoff internals (e.g. GoalHandoffSafetyVerdictWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalProgress internals — not implemented
pub const GOALPROGRESS: InternalSurface = InternalSurface { family: "GoalProgress", members: 1, disposition: Disposition::Flagged, location: "future work: GoalProgress internals (e.g. GoalProgressNudgeFiredPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalRun internals — not implemented
pub const GOALRUN: InternalSurface = InternalSurface { family: "GoalRun", members: 1, disposition: Disposition::Flagged, location: "future work: GoalRun internals (e.g. GoalRunBindingV1Wire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoalUsage internals — not implemented
pub const GOALUSAGE: InternalSurface = InternalSurface { family: "GoalUsage", members: 2, disposition: Disposition::Flagged, location: "future work: GoalUsage internals (e.g. GoalUsageAttributionFactWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GoldenTrace internals — not implemented
pub const GOLDENTRACE: InternalSurface = InternalSurface { family: "GoldenTrace", members: 1, disposition: Disposition::Flagged, location: "future work: GoldenTrace internals (e.g. GoldenTraceFixture) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: GrammarSource internals — not implemented
pub const GRAMMARSOURCE: InternalSurface = InternalSurface { family: "GrammarSource", members: 1, disposition: Disposition::Flagged, location: "future work: GrammarSource internals (e.g. GrammarSource) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-server hook/list
const HOOKRUN_IMPL: &str = "crates/prricode-server hook/list";
pub const HOOKRUN: InternalSurface = InternalSurface {
    family: "HookRun",
    members: 3,
    disposition: Disposition::Implemented,
    location: HOOKRUN_IMPL,
};
// future work: InitialWork internals — not implemented
pub const INITIALWORK: InternalSurface = InternalSurface { family: "InitialWork", members: 2, disposition: Disposition::Flagged, location: "future work: InitialWork internals (e.g. InitialWorkToolMembershipAudit) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: InputError internals — not implemented
pub const INPUTERROR: InternalSurface = InternalSurface { family: "InputError", members: 1, disposition: Disposition::Flagged, location: "future work: InputError internals (e.g. InputErrorValueSource) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: InventoryWire internals — not implemented
pub const INVENTORYWIRE: InternalSurface = InternalSurface { family: "InventoryWire", members: 1, disposition: Disposition::Flagged, location: "future work: InventoryWire internals (e.g. InventoryWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LazyContexts internals — not implemented
pub const LAZYCONTEXTS: InternalSurface = InternalSurface { family: "LazyContexts", members: 1, disposition: Disposition::Flagged, location: "future work: LazyContexts internals (e.g. LazyContexts) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LegacySpawn internals — not implemented
pub const LEGACYSPAWN: InternalSurface = InternalSurface { family: "LegacySpawn", members: 1, disposition: Disposition::Flagged, location: "future work: LegacySpawn internals (e.g. LegacySpawnProjectionV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: Limits internals — not implemented
pub const LIMITS: InternalSurface = InternalSurface { family: "Limits", members: 1, disposition: Disposition::Flagged, location: "future work: Limits internals (e.g. Limits) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ListEnvelope internals — not implemented
pub const LISTENVELOPE: InternalSurface = InternalSurface { family: "ListEnvelope", members: 1, disposition: Disposition::Flagged, location: "future work: ListEnvelope internals (e.g. ListEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-server + CLI
const LOCALSESSION_IMPL: &str = "crates/prricode-server + CLI";
pub const LOCALSESSION: InternalSurface = InternalSurface {
    family: "LocalSession",
    members: 6,
    disposition: Disposition::Implemented,
    location: LOCALSESSION_IMPL,
};
// future work: LockFile internals — not implemented
pub const LOCKFILE: InternalSurface = InternalSurface { family: "LockFile", members: 1, disposition: Disposition::Flagged, location: "future work: LockFile internals (e.g. LockFileRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LockMarketplace internals — not implemented
pub const LOCKMARKETPLACE: InternalSurface = InternalSurface { family: "LockMarketplace", members: 2, disposition: Disposition::Flagged, location: "future work: LockMarketplace internals (e.g. LockMarketplaceRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LockPlugin internals — not implemented
pub const LOCKPLUGIN: InternalSurface = InternalSurface { family: "LockPlugin", members: 1, disposition: Disposition::Flagged, location: "future work: LockPlugin internals (e.g. LockPluginRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LockScan internals — not implemented
pub const LOCKSCAN: InternalSurface = InternalSurface { family: "LockScan", members: 1, disposition: Disposition::Flagged, location: "future work: LockScan internals (e.g. LockScan) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LockSkill internals — not implemented
pub const LOCKSKILL: InternalSurface = InternalSurface { family: "LockSkill", members: 1, disposition: Disposition::Flagged, location: "future work: LockSkill internals (e.g. LockSkillRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: LockSource internals — not implemented
pub const LOCKSOURCE: InternalSurface = InternalSurface { family: "LockSource", members: 2, disposition: Disposition::Flagged, location: "future work: LockSource internals (e.g. LockSource) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: Lockfile internals — not implemented
pub const LOCKFILE__2: InternalSurface = InternalSurface { family: "Lockfile", members: 1, disposition: Disposition::Flagged, location: "future work: Lockfile internals (e.g. Lockfile) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MarketplaceLockfile internals — not implemented
pub const MARKETPLACELOCKFILE: InternalSurface = InternalSurface { family: "MarketplaceLockfile", members: 1, disposition: Disposition::Flagged, location: "future work: MarketplaceLockfile internals (e.g. MarketplaceLockfile) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MatchPattern internals — not implemented
pub const MATCHPATTERN: InternalSurface = InternalSurface { family: "MatchPattern", members: 1, disposition: Disposition::Flagged, location: "future work: MatchPattern internals (e.g. MatchPattern) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MemoryReminder internals — not implemented
pub const MEMORYREMINDER: InternalSurface = InternalSurface { family: "MemoryReminder", members: 2, disposition: Disposition::Flagged, location: "future work: MemoryReminder internals (e.g. MemoryReminderChildSessionLinkedPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MetadataWire internals — not implemented
pub const METADATAWIRE: InternalSurface = InternalSurface { family: "MetadataWire", members: 1, disposition: Disposition::Flagged, location: "future work: MetadataWire internals (e.g. MetadataWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MintedKey internals — not implemented
pub const MINTEDKEY: InternalSurface = InternalSurface { family: "MintedKey", members: 1, disposition: Disposition::Flagged, location: "future work: MintedKey internals (e.g. MintedKey) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-provider
const MODEL_IMPL: &str = "crates/prricode-provider";
pub const MODEL: InternalSurface = InternalSurface {
    family: "Model",
    members: 1,
    disposition: Disposition::Implemented,
    location: MODEL_IMPL,
};
/// IMPLEMENTED: crates/prricode-server model/list + prricode-provider
const MODELCATALOG_IMPL: &str = "crates/prricode-server model/list + prricode-provider";
pub const MODELCATALOG: InternalSurface = InternalSurface {
    family: "ModelCatalog",
    members: 3,
    disposition: Disposition::Implemented,
    location: MODELCATALOG_IMPL,
};
/// IMPLEMENTED: crates/prricode-core/src/types.rs
const MODELINPUT_IMPL: &str = "crates/prricode-core/src/types.rs";
pub const MODELINPUT: InternalSurface = InternalSurface {
    family: "ModelInput",
    members: 5,
    disposition: Disposition::Implemented,
    location: MODELINPUT_IMPL,
};
// future work: ModelList internals — not implemented
pub const MODELLIST: InternalSurface = InternalSurface { family: "ModelList", members: 1, disposition: Disposition::Flagged, location: "future work: ModelList internals (e.g. ModelList) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ModelReconfigure internals — not implemented
pub const MODELRECONFIGURE: InternalSurface = InternalSurface { family: "ModelReconfigure", members: 2, disposition: Disposition::Flagged, location: "future work: ModelReconfigure internals (e.g. ModelReconfigureFailure) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: MonitorManual internals — not implemented
pub const MONITORMANUAL: InternalSurface = InternalSurface { family: "MonitorManual", members: 1, disposition: Disposition::Flagged, location: "future work: MonitorManual internals (e.g. MonitorManualStoppedTerminalV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: NetworkProxy internals — not implemented
pub const NETWORKPROXY: InternalSurface = InternalSurface { family: "NetworkProxy", members: 1, disposition: Disposition::Flagged, location: "future work: NetworkProxy internals (e.g. NetworkProxyBinding) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: NetworkSandbox internals — not implemented
pub const NETWORKSANDBOX: InternalSurface = InternalSurface { family: "NetworkSandbox", members: 1, disposition: Disposition::Flagged, location: "future work: NetworkSandbox internals (e.g. NetworkSandboxPolicy) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: NetworkSubject internals — not implemented
pub const NETWORKSUBJECT: InternalSurface = InternalSurface { family: "NetworkSubject", members: 1, disposition: Disposition::Flagged, location: "future work: NetworkSubject internals (e.g. NetworkSubject) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OAuthErr internals — not implemented
pub const OAUTHERR: InternalSurface = InternalSurface { family: "OAuthErr", members: 1, disposition: Disposition::Flagged, location: "future work: OAuthErr internals (e.g. OAuthErrorBody) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OmissionWire internals — not implemented
pub const OMISSIONWIRE: InternalSurface = InternalSurface { family: "OmissionWire", members: 1, disposition: Disposition::Flagged, location: "future work: OmissionWire internals (e.g. OmissionWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OmittedRecord internals — not implemented
pub const OMITTEDRECORD: InternalSurface = InternalSurface { family: "OmittedRecord", members: 1, disposition: Disposition::Flagged, location: "future work: OmittedRecord internals (e.g. OmittedRecordClassification) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OptionSpec internals — not implemented
pub const OPTIONSPEC: InternalSurface = InternalSurface { family: "OptionSpec", members: 1, disposition: Disposition::Flagged, location: "future work: OptionSpec internals (e.g. OptionSpec) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OutputItem internals — not implemented
pub const OUTPUTITEM: InternalSurface = InternalSurface { family: "OutputItem", members: 1, disposition: Disposition::Flagged, location: "future work: OutputItem internals (e.g. OutputItemEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: OwnerIdentity internals — not implemented
pub const OWNERIDENTITY: InternalSurface = InternalSurface { family: "OwnerIdentity", members: 1, disposition: Disposition::Flagged, location: "future work: OwnerIdentity internals (e.g. OwnerIdentityWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PaymentBanner internals — not implemented
pub const PAYMENTBANNER: InternalSurface = InternalSurface { family: "PaymentBanner", members: 1, disposition: Disposition::Flagged, location: "future work: PaymentBanner internals (e.g. PaymentBannerShownRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PaymentUnresolved internals — not implemented
pub const PAYMENTUNRESOLVED: InternalSurface = InternalSurface { family: "PaymentUnresolved", members: 1, disposition: Disposition::Flagged, location: "future work: PaymentUnresolved internals (e.g. PaymentUnresolvedAtPollCapRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PeerAdmission internals — not implemented
pub const PEERADMISSION: InternalSurface = InternalSurface { family: "PeerAdmission", members: 6, disposition: Disposition::Flagged, location: "future work: PeerAdmission internals (e.g. PeerAdmissionConnectedGrantEvidenceV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PeerRequest internals — not implemented
pub const PEERREQUEST: InternalSurface = InternalSurface { family: "PeerRequest", members: 1, disposition: Disposition::Flagged, location: "future work: PeerRequest internals (e.g. PeerRequestRefPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PeerRetirement internals — not implemented
pub const PEERRETIREMENT: InternalSurface = InternalSurface { family: "PeerRetirement", members: 1, disposition: Disposition::Flagged, location: "future work: PeerRetirement internals (e.g. PeerRetirementPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PeerSubmit internals — not implemented
pub const PEERSUBMIT: InternalSurface = InternalSurface { family: "PeerSubmit", members: 1, disposition: Disposition::Flagged, location: "future work: PeerSubmit internals (e.g. PeerSubmitPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PermissionProfile internals — not implemented
pub const PERMISSIONPROFILE: InternalSurface = InternalSurface { family: "PermissionProfile", members: 1, disposition: Disposition::Flagged, location: "future work: PermissionProfile internals (e.g. PermissionProfile) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PolicyAmendment internals — not implemented
pub const POLICYAMENDMENT: InternalSurface = InternalSurface { family: "PolicyAmendment", members: 1, disposition: Disposition::Flagged, location: "future work: PolicyAmendment internals (e.g. PolicyAmendment) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ProcessSubject internals — not implemented
pub const PROCESSSUBJECT: InternalSurface = InternalSurface { family: "ProcessSubject", members: 1, disposition: Disposition::Flagged, location: "future work: ProcessSubject internals (e.g. ProcessSubject) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-pipeline
const PRODUCTIONWORKFLOW_IMPL: &str = "crates/prricode-pipeline";
pub const PRODUCTIONWORKFLOW: InternalSurface = InternalSurface {
    family: "ProductionWorkflow",
    members: 5,
    disposition: Disposition::Implemented,
    location: PRODUCTIONWORKFLOW_IMPL,
};
// future work: ProjectTrust internals — not implemented
pub const PROJECTTRUST: InternalSurface = InternalSurface { family: "ProjectTrust", members: 2, disposition: Disposition::Flagged, location: "future work: ProjectTrust internals (e.g. ProjectTrustEntry) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: PromptCache internals — not implemented
pub const PROMPTCACHE: InternalSurface = InternalSurface { family: "PromptCache", members: 1, disposition: Disposition::Flagged, location: "future work: PromptCache internals (e.g. PromptCacheBoundary) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ProviderStatus internals — not implemented
pub const PROVIDERSTATUS: InternalSurface = InternalSurface { family: "ProviderStatus", members: 1, disposition: Disposition::Flagged, location: "future work: ProviderStatus internals (e.g. ProviderStatusDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ProviderStream internals — not implemented
pub const PROVIDERSTREAM: InternalSurface = InternalSurface { family: "ProviderStream", members: 1, disposition: Disposition::Flagged, location: "future work: ProviderStream internals (e.g. ProviderStreamDiagnosticDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RageshakeSubmitted internals — not implemented
pub const RAGESHAKESUBMITTED: InternalSurface = InternalSurface { family: "RageshakeSubmitted", members: 1, disposition: Disposition::Flagged, location: "future work: RageshakeSubmitted internals (e.g. RageshakeSubmittedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RawEnvelope internals — not implemented
pub const RAWENVELOPE: InternalSurface = InternalSurface { family: "RawEnvelope", members: 1, disposition: Disposition::Flagged, location: "future work: RawEnvelope internals (e.g. RawEnvelopeProbe) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RawLog internals — not implemented
pub const RAWLOG: InternalSurface = InternalSurface { family: "RawLog", members: 1, disposition: Disposition::Flagged, location: "future work: RawLog internals (e.g. RawLogRecordEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RawOperation internals — not implemented
pub const RAWOPERATION: InternalSurface = InternalSurface { family: "RawOperation", members: 1, disposition: Disposition::Flagged, location: "future work: RawOperation internals (e.g. RawOperationHeader) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RawRequest internals — not implemented
pub const RAWREQUEST: InternalSurface = InternalSurface { family: "RawRequest", members: 1, disposition: Disposition::Flagged, location: "future work: RawRequest internals (e.g. RawRequestIdProbe) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReadFile internals — not implemented
pub const READFILE: InternalSurface = InternalSurface { family: "ReadFile", members: 1, disposition: Disposition::Flagged, location: "future work: ReadFile internals (e.g. ReadFileArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReadMemory internals — not implemented
pub const READMEMORY: InternalSurface = InternalSurface { family: "ReadMemory", members: 1, disposition: Disposition::Flagged, location: "future work: ReadMemory internals (e.g. ReadMemoryArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RemainingWork internals — not implemented
pub const REMAININGWORK: InternalSurface = InternalSurface { family: "RemainingWork", members: 1, disposition: Disposition::Flagged, location: "future work: RemainingWork internals (e.g. RemainingWorkInventory) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderAgent internals — not implemented
pub const REMINDERAGENT: InternalSurface = InternalSurface { family: "ReminderAgent", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderAgent internals (e.g. ReminderAgentSettings) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderCleanup internals — not implemented
pub const REMINDERCLEANUP: InternalSurface = InternalSurface { family: "ReminderCleanup", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderCleanup internals (e.g. ReminderCleanupEffectTaskTarget) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderDecision internals — not implemented
pub const REMINDERDECISION: InternalSurface = InternalSurface { family: "ReminderDecision", members: 2, disposition: Disposition::Flagged, location: "future work: ReminderDecision internals (e.g. ReminderDecisionDeclarationV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderEnvelope internals — not implemented
pub const REMINDERENVELOPE: InternalSurface = InternalSurface { family: "ReminderEnvelope", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderEnvelope internals (e.g. ReminderEnvelopeDeclarationV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderInstalled internals — not implemented
pub const REMINDERINSTALLED: InternalSurface = InternalSurface { family: "ReminderInstalled", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderInstalled internals (e.g. ReminderInstalledPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderProposal internals — not implemented
pub const REMINDERPROPOSAL: InternalSurface = InternalSurface { family: "ReminderProposal", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderProposal internals (e.g. ReminderProposalPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderReconciler internals — not implemented
pub const REMINDERRECONCILER: InternalSurface = InternalSurface { family: "ReminderReconciler", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderReconciler internals (e.g. ReminderReconcilerOutcomePayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReminderSnoozed internals — not implemented
pub const REMINDERSNOOZED: InternalSurface = InternalSurface { family: "ReminderSnoozed", members: 1, disposition: Disposition::Flagged, location: "future work: ReminderSnoozed internals (e.g. ReminderSnoozedPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RemoteFeature internals — not implemented
pub const REMOTEFEATURE: InternalSurface = InternalSurface { family: "RemoteFeature", members: 1, disposition: Disposition::Flagged, location: "future work: RemoteFeature internals (e.g. RemoteFeatureConfig) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReportProgress internals — not implemented
pub const REPORTPROGRESS: InternalSurface = InternalSurface { family: "ReportProgress", members: 1, disposition: Disposition::Flagged, location: "future work: ReportProgress internals (e.g. ReportProgressArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RequestFingerprint internals — not implemented
pub const REQUESTFINGERPRINT: InternalSurface = InternalSurface { family: "RequestFingerprint", members: 1, disposition: Disposition::Flagged, location: "future work: RequestFingerprint internals (e.g. RequestFingerprintV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ResourcePressure internals — not implemented
pub const RESOURCEPRESSURE: InternalSurface = InternalSurface { family: "ResourcePressure", members: 1, disposition: Disposition::Flagged, location: "future work: ResourcePressure internals (e.g. ResourcePressureRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: Response internals — not implemented
pub const RESPONSE: InternalSurface = InternalSurface { family: "Response", members: 1, disposition: Disposition::Flagged, location: "future work: Response internals (e.g. Response) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ResponseError internals — not implemented
pub const RESPONSEERROR: InternalSurface = InternalSurface { family: "ResponseError", members: 1, disposition: Disposition::Flagged, location: "future work: ResponseError internals (e.g. ResponseError) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ResponseSnapshot internals — not implemented
pub const RESPONSESNAPSHOT: InternalSurface = InternalSurface { family: "ResponseSnapshot", members: 1, disposition: Disposition::Flagged, location: "future work: ResponseSnapshot internals (e.g. ResponseSnapshot) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RetainedGap internals — not implemented
pub const RETAINEDGAP: InternalSurface = InternalSurface { family: "RetainedGap", members: 1, disposition: Disposition::Flagged, location: "future work: RetainedGap internals (e.g. RetainedGapEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReviewCandidate internals — not implemented
pub const REVIEWCANDIDATE: InternalSurface = InternalSurface { family: "ReviewCandidate", members: 1, disposition: Disposition::Flagged, location: "future work: ReviewCandidate internals (e.g. ReviewCandidate) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ReviewChoice internals — not implemented
pub const REVIEWCHOICE: InternalSurface = InternalSurface { family: "ReviewChoice", members: 1, disposition: Disposition::Flagged, location: "future work: ReviewChoice internals (e.g. ReviewChoice) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RouteMutation internals — not implemented
pub const ROUTEMUTATION: InternalSurface = InternalSurface { family: "RouteMutation", members: 1, disposition: Disposition::Flagged, location: "future work: RouteMutation internals (e.g. RouteMutationEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: RunModel internals — not implemented
pub const RUNMODEL: InternalSurface = InternalSurface { family: "RunModel", members: 1, disposition: Disposition::Flagged, location: "future work: RunModel internals (e.g. RunModelEvidenceRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ScheduledSkill internals — not implemented
pub const SCHEDULEDSKILL: InternalSurface = InternalSurface { family: "ScheduledSkill", members: 1, disposition: Disposition::Flagged, location: "future work: ScheduledSkill internals (e.g. ScheduledSkillShortcutEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SearchArgs internals — not implemented
pub const SEARCHARGS: InternalSurface = InternalSurface { family: "SearchArgs", members: 1, disposition: Disposition::Flagged, location: "future work: SearchArgs internals (e.g. SearchArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SendSession internals — not implemented
pub const SENDSESSION: InternalSurface = InternalSurface { family: "SendSession", members: 1, disposition: Disposition::Flagged, location: "future work: SendSession internals (e.g. SendSessionMessageToolArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionChannel internals — not implemented
pub const SESSIONCHANNEL: InternalSurface = InternalSurface { family: "SessionChannel", members: 1, disposition: Disposition::Flagged, location: "future work: SessionChannel internals (e.g. SessionChannelHello) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionEnd internals — not implemented
pub const SESSIONEND: InternalSurface = InternalSurface { family: "SessionEnd", members: 1, disposition: Disposition::Flagged, location: "future work: SessionEnd internals (e.g. SessionEndRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-server/src/lib.rs `session/fork`
const SESSIONFORK_IMPL: &str = "crates/prricode-server/src/lib.rs `session/fork`";
pub const SESSIONFORK: InternalSurface = InternalSurface {
    family: "SessionFork",
    members: 9,
    disposition: Disposition::Implemented,
    location: SESSIONFORK_IMPL,
};
// future work: SessionOpened internals — not implemented
pub const SESSIONOPENED: InternalSurface = InternalSurface { family: "SessionOpened", members: 1, disposition: Disposition::Flagged, location: "future work: SessionOpened internals (e.g. SessionOpenedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionResumed internals — not implemented
pub const SESSIONRESUMED: InternalSurface = InternalSurface { family: "SessionResumed", members: 1, disposition: Disposition::Flagged, location: "future work: SessionResumed internals (e.g. SessionResumedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionRetained internals — not implemented
pub const SESSIONRETAINED: InternalSurface = InternalSurface { family: "SessionRetained", members: 1, disposition: Disposition::Flagged, location: "future work: SessionRetained internals (e.g. SessionRetainedRuntimeFactRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionSecurity internals — not implemented
pub const SESSIONSECURITY: InternalSurface = InternalSurface { family: "SessionSecurity", members: 1, disposition: Disposition::Flagged, location: "future work: SessionSecurity internals (e.g. SessionSecurityModeEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionStart internals — not implemented
pub const SESSIONSTART: InternalSurface = InternalSurface { family: "SessionStart", members: 1, disposition: Disposition::Flagged, location: "future work: SessionStart internals (e.g. SessionStartCommandPayloadWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SessionWorkspace internals — not implemented
pub const SESSIONWORKSPACE: InternalSurface = InternalSurface { family: "SessionWorkspace", members: 1, disposition: Disposition::Flagged, location: "future work: SessionWorkspace internals (e.g. SessionWorkspaceScopeActivated) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-pipeline/src/ship.rs prepare_worktree
const SESSIONWORKTREE_IMPL: &str = "crates/prricode-pipeline/src/ship.rs prepare_worktree";
pub const SESSIONWORKTREE: InternalSurface = InternalSurface {
    family: "SessionWorktree",
    members: 3,
    disposition: Disposition::Implemented,
    location: SESSIONWORKTREE_IMPL,
};
// future work: SettingsFile internals — not implemented
pub const SETTINGSFILE: InternalSurface = InternalSurface { family: "SettingsFile", members: 1, disposition: Disposition::Flagged, location: "future work: SettingsFile internals (e.g. SettingsFile) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ShellPrefix internals — not implemented
pub const SHELLPREFIX: InternalSurface = InternalSurface { family: "ShellPrefix", members: 1, disposition: Disposition::Flagged, location: "future work: ShellPrefix internals (e.g. ShellPrefixSuggestion) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ShellStage internals — not implemented
pub const SHELLSTAGE: InternalSurface = InternalSurface { family: "ShellStage", members: 2, disposition: Disposition::Flagged, location: "future work: ShellStage internals (e.g. ShellStage) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-server
const SIDECHAT_IMPL: &str = "crates/prricode-server";
pub const SIDECHAT: InternalSurface = InternalSurface {
    family: "SideChat",
    members: 5,
    disposition: Disposition::Implemented,
    location: SIDECHAT_IMPL,
};
// future work: SideGoal internals — not implemented
pub const SIDEGOAL: InternalSurface = InternalSurface { family: "SideGoal", members: 2, disposition: Disposition::Flagged, location: "future work: SideGoal internals (e.g. SideGoalDescendantAuthorityWire) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SkillRead internals — not implemented
pub const SKILLREAD: InternalSurface = InternalSurface { family: "SkillRead", members: 1, disposition: Disposition::Flagged, location: "future work: SkillRead internals (e.g. SkillReadObservedPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SkillReminder internals — not implemented
pub const SKILLREMINDER: InternalSurface = InternalSurface { family: "SkillReminder", members: 1, disposition: Disposition::Flagged, location: "future work: SkillReminder internals (e.g. SkillReminderDecisionPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SourceDirty internals — not implemented
pub const SOURCEDIRTY: InternalSurface = InternalSurface { family: "SourceDirty", members: 1, disposition: Disposition::Flagged, location: "future work: SourceDirty internals (e.g. SourceDirtyExcluded) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SourceScope internals — not implemented
pub const SOURCESCOPE: InternalSurface = InternalSurface { family: "SourceScope", members: 1, disposition: Disposition::Flagged, location: "future work: SourceScope internals (e.g. SourceScopeStyle) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SpawnCommit internals — not implemented
pub const SPAWNCOMMIT: InternalSurface = InternalSurface { family: "SpawnCommit", members: 1, disposition: Disposition::Flagged, location: "future work: SpawnCommit internals (e.g. SpawnCommitPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SpawnDecision internals — not implemented
pub const SPAWNDECISION: InternalSurface = InternalSurface { family: "SpawnDecision", members: 1, disposition: Disposition::Flagged, location: "future work: SpawnDecision internals (e.g. SpawnDecisionV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StartupPhase internals — not implemented
pub const STARTUPPHASE: InternalSurface = InternalSurface { family: "StartupPhase", members: 1, disposition: Disposition::Flagged, location: "future work: StartupPhase internals (e.g. StartupPhaseSpan) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StartupPhases internals — not implemented
pub const STARTUPPHASES: InternalSurface = InternalSurface { family: "StartupPhases", members: 1, disposition: Disposition::Flagged, location: "future work: StartupPhases internals (e.g. StartupPhasesRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StatusDetails internals — not implemented
pub const STATUSDETAILS: InternalSurface = InternalSurface { family: "StatusDetails", members: 1, disposition: Disposition::Flagged, location: "future work: StatusDetails internals (e.g. StatusDetails) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StoredSession internals — not implemented
pub const STOREDSESSION: InternalSurface = InternalSurface { family: "StoredSession", members: 2, disposition: Disposition::Flagged, location: "future work: StoredSession internals (e.g. StoredSessionData) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StoredTool internals — not implemented
pub const STOREDTOOL: InternalSurface = InternalSurface { family: "StoredTool", members: 1, disposition: Disposition::Flagged, location: "future work: StoredTool internals (e.g. StoredToolCall) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: StrictEvent internals — not implemented
pub const STRICTEVENT: InternalSurface = InternalSurface { family: "StrictEvent", members: 1, disposition: Disposition::Flagged, location: "future work: StrictEvent internals (e.g. StrictEventPosition) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentAttempt internals — not implemented
pub const SUBAGENTATTEMPT: InternalSurface = InternalSurface { family: "SubagentAttempt", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentAttempt internals (e.g. SubagentAttemptAdmittedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentCancel internals — not implemented
pub const SUBAGENTCANCEL: InternalSurface = InternalSurface { family: "SubagentCancel", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentCancel internals (e.g. SubagentCancelOutcome) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentClose internals — not implemented
pub const SUBAGENTCLOSE: InternalSurface = InternalSurface { family: "SubagentClose", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentClose internals (e.g. SubagentCloseOutcome) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentControl internals — not implemented
pub const SUBAGENTCONTROL: InternalSurface = InternalSurface { family: "SubagentControl", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentControl internals (e.g. SubagentControlActor) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentInput internals — not implemented
pub const SUBAGENTINPUT: InternalSurface = InternalSurface { family: "SubagentInput", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentInput internals (e.g. SubagentInputCommandSettlement) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentKilled internals — not implemented
pub const SUBAGENTKILLED: InternalSurface = InternalSurface { family: "SubagentKilled", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentKilled internals (e.g. SubagentKilledTaskDisclosure) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentOwner internals — not implemented
pub const SUBAGENTOWNER: InternalSurface = InternalSurface { family: "SubagentOwner", members: 2, disposition: Disposition::Flagged, location: "future work: SubagentOwner internals (e.g. SubagentOwnerCommandRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentRecovery internals — not implemented
pub const SUBAGENTRECOVERY: InternalSurface = InternalSurface { family: "SubagentRecovery", members: 2, disposition: Disposition::Flagged, location: "future work: SubagentRecovery internals (e.g. SubagentRecoveryAvailableRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentRedirect internals — not implemented
pub const SUBAGENTREDIRECT: InternalSurface = InternalSurface { family: "SubagentRedirect", members: 2, disposition: Disposition::Flagged, location: "future work: SubagentRedirect internals (e.g. SubagentRedirectPendingRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentResume internals — not implemented
pub const SUBAGENTRESUME: InternalSurface = InternalSurface { family: "SubagentResume", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentResume internals (e.g. SubagentResumeContextRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentRuntime internals — not implemented
pub const SUBAGENTRUNTIME: InternalSurface = InternalSurface { family: "SubagentRuntime", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentRuntime internals (e.g. SubagentRuntimeMetrics) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentTask internals — not implemented
pub const SUBAGENTTASK: InternalSurface = InternalSurface { family: "SubagentTask", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentTask internals (e.g. SubagentTaskTerminalRef) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SubagentWork internals — not implemented
pub const SUBAGENTWORK: InternalSurface = InternalSurface { family: "SubagentWork", members: 1, disposition: Disposition::Flagged, location: "future work: SubagentWork internals (e.g. SubagentWorkStopMetadataV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-pipeline ship + prricode-agent
const SUBAGENTWORKTREE_IMPL: &str = "crates/prricode-pipeline ship + prricode-agent";
pub const SUBAGENTWORKTREE: InternalSurface = InternalSurface {
    family: "SubagentWorktree",
    members: 4,
    disposition: Disposition::Implemented,
    location: SUBAGENTWORKTREE_IMPL,
};
// future work: SummaryText internals — not implemented
pub const SUMMARYTEXT: InternalSurface = InternalSurface { family: "SummaryText", members: 1, disposition: Disposition::Flagged, location: "future work: SummaryText internals (e.g. SummaryTextDeltaEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SyntaxReference internals — not implemented
pub const SYNTAXREFERENCE: InternalSurface = InternalSurface { family: "SyntaxReference", members: 1, disposition: Disposition::Flagged, location: "future work: SyntaxReference internals (e.g. SyntaxReference) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: SyntaxSet internals — not implemented
pub const SYNTAXSET: InternalSurface = InternalSurface { family: "SyntaxSet", members: 1, disposition: Disposition::Flagged, location: "future work: SyntaxSet internals (e.g. SyntaxSet) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskActive internals — not implemented
pub const TASKACTIVE: InternalSurface = InternalSurface { family: "TaskActive", members: 1, disposition: Disposition::Flagged, location: "future work: TaskActive internals (e.g. TaskActiveStepDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskChild internals — not implemented
pub const TASKCHILD: InternalSurface = InternalSurface { family: "TaskChild", members: 1, disposition: Disposition::Flagged, location: "future work: TaskChild internals (e.g. TaskChildSummaryDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskExternal internals — not implemented
pub const TASKEXTERNAL: InternalSurface = InternalSurface { family: "TaskExternal", members: 1, disposition: Disposition::Flagged, location: "future work: TaskExternal internals (e.g. TaskExternalAttemptDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskHealth internals — not implemented
pub const TASKHEALTH: InternalSurface = InternalSurface { family: "TaskHealth", members: 1, disposition: Disposition::Flagged, location: "future work: TaskHealth internals (e.g. TaskHealthDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskLive internals — not implemented
pub const TASKLIVE: InternalSurface = InternalSurface { family: "TaskLive", members: 1, disposition: Disposition::Flagged, location: "future work: TaskLive internals (e.g. TaskLiveProcessDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TaskProgress internals — not implemented
pub const TASKPROGRESS: InternalSurface = InternalSurface { family: "TaskProgress", members: 1, disposition: Disposition::Flagged, location: "future work: TaskProgress internals (e.g. TaskProgressDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TbhCost internals — not implemented
pub const TBHCOST: InternalSurface = InternalSurface { family: "TbhCost", members: 1, disposition: Disposition::Flagged, location: "future work: TbhCost internals (e.g. TbhCost) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TemplateSlot internals — not implemented
pub const TEMPLATESLOT: InternalSurface = InternalSurface { family: "TemplateSlot", members: 1, disposition: Disposition::Flagged, location: "future work: TemplateSlot internals (e.g. TemplateSlot) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TextDelta internals — not implemented
pub const TEXTDELTA: InternalSurface = InternalSurface { family: "TextDelta", members: 1, disposition: Disposition::Flagged, location: "future work: TextDelta internals (e.g. TextDeltaEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TextDone internals — not implemented
pub const TEXTDONE: InternalSurface = InternalSurface { family: "TextDone", members: 1, disposition: Disposition::Flagged, location: "future work: TextDone internals (e.g. TextDoneEvent) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TextFormat internals — not implemented
pub const TEXTFORMAT: InternalSurface = InternalSurface { family: "TextFormat", members: 1, disposition: Disposition::Flagged, location: "future work: TextFormat internals (e.g. TextFormatType) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TodoItem internals — not implemented
pub const TODOITEM: InternalSurface = InternalSurface { family: "TodoItem", members: 1, disposition: Disposition::Flagged, location: "future work: TodoItem internals (e.g. TodoItem) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TokenGrant internals — not implemented
pub const TOKENGRANT: InternalSurface = InternalSurface { family: "TokenGrant", members: 1, disposition: Disposition::Flagged, location: "future work: TokenGrant internals (e.g. TokenGrant) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ToolBatch internals — not implemented
pub const TOOLBATCH: InternalSurface = InternalSurface { family: "ToolBatch", members: 2, disposition: Disposition::Flagged, location: "future work: ToolBatch internals (e.g. ToolBatchEffectStart) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ToolCall internals — not implemented
pub const TOOLCALL: InternalSurface = InternalSurface { family: "ToolCall", members: 1, disposition: Disposition::Flagged, location: "future work: ToolCall internals (e.g. ToolCall) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ToolOutput internals — not implemented
pub const TOOLOUTPUT: InternalSurface = InternalSurface { family: "ToolOutput", members: 1, disposition: Disposition::Flagged, location: "future work: ToolOutput internals (e.g. ToolOutputRef) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-agent loop + TUI
const TOOLRESULT_IMPL: &str = "crates/prricode-agent loop + TUI";
pub const TOOLRESULT: InternalSurface = InternalSurface {
    family: "ToolResult",
    members: 3,
    disposition: Disposition::Implemented,
    location: TOOLRESULT_IMPL,
};
// future work: ToolResults internals — not implemented
pub const TOOLRESULTS: InternalSurface = InternalSurface { family: "ToolResults", members: 1, disposition: Disposition::Flagged, location: "future work: ToolResults internals (e.g. ToolResultsClearedPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ToolSearch internals — not implemented
pub const TOOLSEARCH: InternalSurface = InternalSurface { family: "ToolSearch", members: 1, disposition: Disposition::Flagged, location: "future work: ToolSearch internals (e.g. ToolSearchArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ToolStatus internals — not implemented
pub const TOOLSTATUS: InternalSurface = InternalSurface { family: "ToolStatus", members: 1, disposition: Disposition::Flagged, location: "future work: ToolStatus internals (e.g. ToolStatusDetail) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TranscriptMember internals — not implemented
pub const TRANSCRIPTMEMBER: InternalSurface = InternalSurface { family: "TranscriptMember", members: 1, disposition: Disposition::Flagged, location: "future work: TranscriptMember internals (e.g. TranscriptMember) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: TurnSubmit internals — not implemented
pub const TURNSUBMIT: InternalSurface = InternalSurface { family: "TurnSubmit", members: 1, disposition: Disposition::Flagged, location: "future work: TurnSubmit internals (e.g. TurnSubmitPayload) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: UnregisterEnvelope internals — not implemented
pub const UNREGISTERENVELOPE: InternalSurface = InternalSurface { family: "UnregisterEnvelope", members: 1, disposition: Disposition::Flagged, location: "future work: UnregisterEnvelope internals (e.g. UnregisterEnvelope) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: UpdateGoal internals — not implemented
pub const UPDATEGOAL: InternalSurface = InternalSurface { family: "UpdateGoal", members: 1, disposition: Disposition::Flagged, location: "future work: UpdateGoal internals (e.g. UpdateGoalArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-persistence usage_records
const USAGE_IMPL: &str = "crates/prricode-persistence usage_records";
pub const USAGE: InternalSurface = InternalSurface {
    family: "Usage",
    members: 1,
    disposition: Disposition::Implemented,
    location: USAGE_IMPL,
};
/// IMPLEMENTED: crates/prricode-server + prricode-pipeline/src/clarify.rs
const USERINPUT_IMPL: &str = "crates/prricode-server + prricode-pipeline/src/clarify.rs";
pub const USERINPUT: InternalSurface = InternalSurface {
    family: "UserInput",
    members: 9,
    disposition: Disposition::Implemented,
    location: USERINPUT_IMPL,
};
// future work: UserShell internals — not implemented
pub const USERSHELL: InternalSurface = InternalSurface { family: "UserShell", members: 2, disposition: Disposition::Flagged, location: "future work: UserShell internals (e.g. UserShellCommandRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: ValidatorBinding internals — not implemented
pub const VALIDATORBINDING: InternalSurface = InternalSurface { family: "ValidatorBinding", members: 1, disposition: Disposition::Flagged, location: "future work: ValidatorBinding internals (e.g. ValidatorBinding) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: VoiceCapture internals — not implemented
pub const VOICECAPTURE: InternalSurface = InternalSurface { family: "VoiceCapture", members: 1, disposition: Disposition::Flagged, location: "future work: VoiceCapture internals (e.g. VoiceCaptureObservedRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WebFetch internals — not implemented
pub const WEBFETCH: InternalSurface = InternalSurface { family: "WebFetch", members: 1, disposition: Disposition::Flagged, location: "future work: WebFetch internals (e.g. WebFetchInput) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WireImage internals — not implemented
pub const WIREIMAGE: InternalSurface = InternalSurface { family: "WireImage", members: 1, disposition: Disposition::Flagged, location: "future work: WireImage internals (e.g. WireImageInput) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WireOwner internals — not implemented
pub const WIREOWNER: InternalSurface = InternalSurface { family: "WireOwner", members: 1, disposition: Disposition::Flagged, location: "future work: WireOwner internals (e.g. WireOwnerRef) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WorkStop internals — not implemented
pub const WORKSTOP: InternalSurface = InternalSurface { family: "WorkStop", members: 1, disposition: Disposition::Flagged, location: "future work: WorkStop internals (e.g. WorkStopSettlementMetadataV1) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-workflow child_control + prricode-agent task tool
const WORKFLOWCHILD_IMPL: &str =
    "crates/prricode-workflow child_control + prricode-agent task tool";
pub const WORKFLOWCHILD: InternalSurface = InternalSurface {
    family: "WorkflowChild",
    members: 7,
    disposition: Disposition::Implemented,
    location: WORKFLOWCHILD_IMPL,
};
/// IMPLEMENTED: crates/prricode-persistence workflow_runs
const WORKFLOWJOURNAL_IMPL: &str = "crates/prricode-persistence workflow_runs";
pub const WORKFLOWJOURNAL: InternalSurface = InternalSurface {
    family: "WorkflowJournal",
    members: 3,
    disposition: Disposition::Implemented,
    location: WORKFLOWJOURNAL_IMPL,
};
// future work: WorkflowLaunch internals — not implemented
pub const WORKFLOWLAUNCH: InternalSurface = InternalSurface { family: "WorkflowLaunch", members: 2, disposition: Disposition::Flagged, location: "future work: WorkflowLaunch internals (e.g. WorkflowLaunchReconciledOutputSummary) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WorkflowOwner internals — not implemented
pub const WORKFLOWOWNER: InternalSurface = InternalSurface { family: "WorkflowOwner", members: 1, disposition: Disposition::Flagged, location: "future work: WorkflowOwner internals (e.g. WorkflowOwnerWakeResultReadyRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-workflow
const WORKFLOWRECOVERY_IMPL: &str = "crates/prricode-workflow";
pub const WORKFLOWRECOVERY: InternalSurface = InternalSurface {
    family: "WorkflowRecovery",
    members: 3,
    disposition: Disposition::Implemented,
    location: WORKFLOWRECOVERY_IMPL,
};
// future work: WorkflowRun internals — not implemented
pub const WORKFLOWRUN: InternalSurface = InternalSurface { family: "WorkflowRun", members: 1, disposition: Disposition::Flagged, location: "future work: WorkflowRun internals (e.g. WorkflowRunLaunchedFact) — runtime concept with no protocol wire presence; not implemented in prricode" };
/// IMPLEMENTED: crates/prricode-skills
const WORKFLOWSCRIPT_IMPL: &str = "crates/prricode-skills";
pub const WORKFLOWSCRIPT: InternalSurface = InternalSurface {
    family: "WorkflowScript",
    members: 3,
    disposition: Disposition::Implemented,
    location: WORKFLOWSCRIPT_IMPL,
};
// future work: WorkspaceBranch internals — not implemented
pub const WORKSPACEBRANCH: InternalSurface = InternalSurface { family: "WorkspaceBranch", members: 1, disposition: Disposition::Flagged, location: "future work: WorkspaceBranch internals (e.g. WorkspaceBranchRecord) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WorktreeCleanup internals — not implemented
pub const WORKTREECLEANUP: InternalSurface = InternalSurface { family: "WorktreeCleanup", members: 1, disposition: Disposition::Flagged, location: "future work: WorktreeCleanup internals (e.g. WorktreeCleanupOutcome) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WriteArgs internals — not implemented
pub const WRITEARGS: InternalSurface = InternalSurface { family: "WriteArgs", members: 1, disposition: Disposition::Flagged, location: "future work: WriteArgs internals (e.g. WriteArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };
// future work: WriteStdin internals — not implemented
pub const WRITESTDIN: InternalSurface = InternalSurface { family: "WriteStdin", members: 1, disposition: Disposition::Flagged, location: "future work: WriteStdin internals (e.g. WriteStdinArgs) — runtime concept with no protocol wire presence; not implemented in prricode" };

/// The full inventory, sorted by family name.
pub fn inventory() -> Vec<InternalSurface> {
    let mut all = vec![
        ADDMEMORY,
        AGENTCONTEXT,
        AGENTINBOX,
        AGENTLINEAGE,
        AGENTREMINDER,
        AGENTREQUEST,
        AGENTRUN,
        AGENTSPAWN,
        AGENTTREE,
        APIERROR,
        APPROVALPOLICY,
        APPROVALRECONFIGURE,
        APPROVALREQUIREMENT,
        APPROVALWAIT,
        ASYNCOWNER,
        AUDITEFFECTIVE,
        AUDITRESOLUTION,
        AUDITSOURCE,
        AUDITWIRE,
        AUTHFILE,
        BODYTEMPLATE,
        BRANCHSEED,
        BUILDSTAMP,
        BUNDLEDTHEME,
        CAPACITYSNAPSHOT,
        CATALOGV1,
        CHECKPOINTSESSION,
        CLIENTWEB,
        CODEMODE,
        COMMANDARGS,
        COMMANDGRAMMAR,
        COMMANDINVOKED,
        COMMANDKEY,
        COMMANDSPEC,
        COMPACTIONCANDIDATE,
        COMPACTIONCURSOR,
        COMPACTIONFALLBACK,
        COMPACTIONINSTALLED,
        COMPACTIONPRESERVED,
        COMPACTIONSUMMARIZER,
        CONFIGCATALOG,
        CONTENTPART,
        CONTEXT,
        CONTEXTBUDGET,
        CONTEXTCHECKPOINT,
        CONTEXTPROJECTION,
        COUNTSWIRE,
        CRONCREATE,
        CRONDELETE,
        CRONLIST,
        CUSTOMPRODUCER,
        DECISIONBRANCH,
        DECISIONFIELD,
        DECISIONLIMITS,
        DECISIONPROPOSAL,
        DEVICEAUTHORIZATION,
        DUPLEXINBOUND,
        DYNAMICWORKFLOW,
        EDITARGS,
        EDITMEMORY,
        EFFECTIVEMODEL,
        EVENTPOSITION,
        EVENTSTREAM,
        EXECCOMMAND,
        EXPECTEDMESSAGE,
        EXPECTEDMODEL,
        EXPECTEDTASK,
        FIELDVALUE,
        FILESYSTEM,
        FILESYSTEMSUBJECT,
        FOREGROUNDEXEC,
        FORKPROVENANCE,
        FUNCTIONCALL,
        FUTURECODE,
        GOALDESCENDANT,
        GOALFORK,
        GOALHANDOFF,
        GOALPROGRESS,
        GOALRUN,
        GOALUSAGE,
        GOLDENTRACE,
        GRAMMARSOURCE,
        HOOKRUN,
        INITIALWORK,
        INPUTERROR,
        INVENTORYWIRE,
        LAZYCONTEXTS,
        LEGACYSPAWN,
        LIMITS,
        LISTENVELOPE,
        LOCALSESSION,
        LOCKFILE,
        LOCKMARKETPLACE,
        LOCKPLUGIN,
        LOCKSCAN,
        LOCKSKILL,
        LOCKSOURCE,
        LOCKFILE__2,
        MARKETPLACELOCKFILE,
        MATCHPATTERN,
        MEMORYREMINDER,
        METADATAWIRE,
        MINTEDKEY,
        MODEL,
        MODELCATALOG,
        MODELINPUT,
        MODELLIST,
        MODELRECONFIGURE,
        MONITORMANUAL,
        NETWORKPROXY,
        NETWORKSANDBOX,
        NETWORKSUBJECT,
        OAUTHERR,
        OMISSIONWIRE,
        OMITTEDRECORD,
        OPTIONSPEC,
        OUTPUTITEM,
        OWNERIDENTITY,
        PAYMENTBANNER,
        PAYMENTUNRESOLVED,
        PEERADMISSION,
        PEERREQUEST,
        PEERRETIREMENT,
        PEERSUBMIT,
        PERMISSIONPROFILE,
        POLICYAMENDMENT,
        PROCESSSUBJECT,
        PRODUCTIONWORKFLOW,
        PROJECTTRUST,
        PROMPTCACHE,
        PROVIDERSTATUS,
        PROVIDERSTREAM,
        RAGESHAKESUBMITTED,
        RAWENVELOPE,
        RAWLOG,
        RAWOPERATION,
        RAWREQUEST,
        READFILE,
        READMEMORY,
        REMAININGWORK,
        REMINDERAGENT,
        REMINDERCLEANUP,
        REMINDERDECISION,
        REMINDERENVELOPE,
        REMINDERINSTALLED,
        REMINDERPROPOSAL,
        REMINDERRECONCILER,
        REMINDERSNOOZED,
        REMOTEFEATURE,
        REPORTPROGRESS,
        REQUESTFINGERPRINT,
        RESOURCEPRESSURE,
        RESPONSE,
        RESPONSEERROR,
        RESPONSESNAPSHOT,
        RETAINEDGAP,
        REVIEWCANDIDATE,
        REVIEWCHOICE,
        ROUTEMUTATION,
        RUNMODEL,
        SCHEDULEDSKILL,
        SEARCHARGS,
        SENDSESSION,
        SESSIONCHANNEL,
        SESSIONEND,
        SESSIONFORK,
        SESSIONOPENED,
        SESSIONRESUMED,
        SESSIONRETAINED,
        SESSIONSECURITY,
        SESSIONSTART,
        SESSIONWORKSPACE,
        SESSIONWORKTREE,
        SETTINGSFILE,
        SHELLPREFIX,
        SHELLSTAGE,
        SIDECHAT,
        SIDEGOAL,
        SKILLREAD,
        SKILLREMINDER,
        SOURCEDIRTY,
        SOURCESCOPE,
        SPAWNCOMMIT,
        SPAWNDECISION,
        STARTUPPHASE,
        STARTUPPHASES,
        STATUSDETAILS,
        STOREDSESSION,
        STOREDTOOL,
        STRICTEVENT,
        SUBAGENTATTEMPT,
        SUBAGENTCANCEL,
        SUBAGENTCLOSE,
        SUBAGENTCONTROL,
        SUBAGENTINPUT,
        SUBAGENTKILLED,
        SUBAGENTOWNER,
        SUBAGENTRECOVERY,
        SUBAGENTREDIRECT,
        SUBAGENTRESUME,
        SUBAGENTRUNTIME,
        SUBAGENTTASK,
        SUBAGENTWORK,
        SUBAGENTWORKTREE,
        SUMMARYTEXT,
        SYNTAXREFERENCE,
        SYNTAXSET,
        TASKACTIVE,
        TASKCHILD,
        TASKEXTERNAL,
        TASKHEALTH,
        TASKLIVE,
        TASKPROGRESS,
        TBHCOST,
        TEMPLATESLOT,
        TEXTDELTA,
        TEXTDONE,
        TEXTFORMAT,
        TODOITEM,
        TOKENGRANT,
        TOOLBATCH,
        TOOLCALL,
        TOOLOUTPUT,
        TOOLRESULT,
        TOOLRESULTS,
        TOOLSEARCH,
        TOOLSTATUS,
        TRANSCRIPTMEMBER,
        TURNSUBMIT,
        UNREGISTERENVELOPE,
        UPDATEGOAL,
        USAGE,
        USERINPUT,
        USERSHELL,
        VALIDATORBINDING,
        VOICECAPTURE,
        WEBFETCH,
        WIREIMAGE,
        WIREOWNER,
        WORKSTOP,
        WORKFLOWCHILD,
        WORKFLOWJOURNAL,
        WORKFLOWLAUNCH,
        WORKFLOWOWNER,
        WORKFLOWRECOVERY,
        WORKFLOWRUN,
        WORKFLOWSCRIPT,
        WORKSPACEBRANCH,
        WORKTREECLEANUP,
        WRITEARGS,
        WRITESTDIN,
    ];
    all.sort_by_key(|s| s.family);
    all
}

/// Counts by disposition.
pub fn counts() -> (usize, usize) {
    let inventory = inventory();
    let implemented = inventory
        .iter()
        .filter(|s| s.disposition == Disposition::Implemented)
        .count();
    let flagged = inventory
        .iter()
        .filter(|s| s.disposition == Disposition::Flagged)
        .count();
    (implemented, flagged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_family_has_an_explicit_disposition() {
        let inventory = inventory();
        assert!(
            inventory.len() >= 100,
            "inventory covers the binary families"
        );
        for surface in &inventory {
            match surface.disposition {
                Disposition::Implemented => assert!(!surface.location.is_empty()),
                Disposition::Flagged => assert!(
                    surface.location.starts_with("future work:"),
                    "flagged entries must name their future work"
                ),
            }
        }
    }

    #[test]
    fn counts_partition_the_inventory() {
        let (implemented, flagged) = counts();
        assert_eq!(implemented + flagged, inventory().len());
        assert!(implemented >= 22);
    }
}
