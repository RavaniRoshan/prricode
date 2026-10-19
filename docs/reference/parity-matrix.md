# Parity Matrix

Generated from the reference inventory. Status values: `implemented`, `partial`, `missing`, `not-planned`.

## Current implemented commands (TUI)

- help
- clear
- compact
- context
- cost
- status
- model
- sessions
- new
- resume
- approval
- permission-mode
- provider
- concept
- spec
- plan
- build
- ship
- deploy
- operate
- dossier
- theme
- vim
- voice
- hooks
- yolo
- goal
- compact
- message
- research
- pricing
- landing
- quit
- exit
- q

## Current implemented tools (agent registry)

Real (behavior implemented, tested):
- ShellTool
- ReadFileTool
- WriteFileTool
- EditFileTool
- ListDirTool
- GlobTool
- GrepTool
- WebFetchTool
- WebSearchTool
- ComputerTool
- GoalCompleteTool
- TaskTool / AgentTool / CoordinatorTool (subagent orchestration)
- McpTool, ListMcpResourcesTool, ReadMcpResourceTool (stdio + http transports)
- WorkflowTool
- TodoTool
- BriefTool
- SleepTool
- ConfigTool
- NotebookEditTool
- EnterPlanModeTool / ExitPlanModeTool
- EnterWorktreeTool / ExitWorktreeTool
- TeamCreateTool / TeamDeleteTool
- SendMessageTool
- ScheduleCronTool
- RemoteTriggerTool
- AskUserQuestionTool
- ToolSearchTool

Honest stubs (report `unsupported`): tool-search fallbacks, mcp_auth, repl —
see `crates/prricode-agent/src/tools/stubs.rs`. lsp is real now:
diagnostics/hover/definition via a framed JSON-RPC client over a discovered
language server (extension map + PATH); honest `unsupported` when none is
installed (`crates/prricode-agent/src/tools/lsp.rs`).

## Server surface deltas since the audit

- hook/list returns real registered hooks; hook dispatch runs concurrently
- session/compact plus a turn-start auto-compaction trigger
  (token-estimate threshold)
- plugin/list reads `plugin.toml` manifests (name/version/description/enabled)
- mcp.toml accepts `type = "http"` servers; resource list/read over stdio
- mcp.toml expands `${VAR}` in command/args/url values and supports an
  `[servers.env]` table passed to stdio children
- http bridge: `POST /jsonrpc` via `prricode serve --http <addr>`
- skill/setActivation persists; skills parse model/allowed-tools/context
- `skill` tool in the registry: load instructions by name, honest listing

## Reference Inventory

# Reference Inventory

Source root: local recovered reference tree (research only, not shipped)

## commands

Count: 101

- add-dir
- advisor.ts
- agents
- ant-trace
- autofix-pr
- backfill-sessions
- branch
- break-cache
- bridge
- bridge-kick.ts
- brief.ts
- btw
- bughunter
- chrome
- clear
- color
- commit-push-pr.ts
- commit.ts
- compact
- config
- context
- copy
- cost
- createMovedToPluginCommand.ts
- ctx_viz
- debug-tool-call
- desktop
- diff
- doctor
- effort
- env
- exit
- export
- extra-usage
- fast
- feedback
- files
- good-docs
- heapdump
- help
- hooks
- ide
- init-verifiers.ts
- init.ts
- insights.ts
- install-github-app
- install-slack-app
- install.tsx
- issue
- keybindings
- login
- logout
- mcp
- memory
- mobile
- mock-limits
- model
- oauth-refresh
- onboarding
- output-style
- passes
- perf-issue
- permissions
- plan
- plugin
- pr_comments
- privacy-settings
- rate-limit-options
- release-notes
- reload-plugins
- remote-env
- remote-setup
- rename
- reset-limits
- resume
- review
- review.ts
- rewind
- sandbox-toggle
- security-review.ts
- session
- share
- skills
- stats
- status
- statusline.tsx
- stickers
- summary
- tag
- tasks
- teleport
- terminalSetup
- theme
- thinkback
- thinkback-play
- ultraplan.tsx
- upgrade
- usage
- version.ts
- vim
- voice

## tools

Count: 43

- AgentTool
- AskUserQuestionTool
- BashTool
- BriefTool
- ConfigTool
- EnterPlanModeTool
- EnterWorktreeTool
- ExitPlanModeTool
- ExitWorktreeTool
- FileEditTool
- FileReadTool
- FileWriteTool
- GlobTool
- GrepTool
- LSPTool
- ListMcpResourcesTool
- MCPTool
- McpAuthTool
- NotebookEditTool
- PowerShellTool
- REPLTool
- ReadMcpResourceTool
- RemoteTriggerTool
- ScheduleCronTool
- SendMessageTool
- SkillTool
- SleepTool
- SyntheticOutputTool
- TaskCreateTool
- TaskGetTool
- TaskListTool
- TaskOutputTool
- TaskStopTool
- TaskUpdateTool
- TeamCreateTool
- TeamDeleteTool
- TodoWriteTool
- ToolSearchTool
- WebFetchTool
- WebSearchTool
- shared
- testing
- utils.ts

## services

Count: 36

- AgentSummary
- MagicDocs
- PromptSuggestion
- SessionMemory
- analytics
- api
- autoDream
- awaySummary.ts
- referenceAiLimits.ts
- referenceAiLimitsHook.ts
- compact
- diagnosticTracking.ts
- extractMemories
- internalLogging.ts
- lsp
- mcp
- mcpServerApproval.tsx
- mockRateLimits.ts
- notifier.ts
- oauth
- plugins
- policyLimits
- preventSleep.ts
- rateLimitMessages.ts
- rateLimitMocking.ts
- remoteManagedSettings
- settingsSync
- teamMemorySync
- tips
- tokenEstimation.ts
- toolUseSummary
- tools
- vcr.ts
- voice.ts
- voiceKeyterms.ts
- voiceStreamSTT.ts

## hooks

Count: 85

- fileSuggestions.ts
- notifs
- renderPlaceholder.ts
- toolPermission
- unifiedSuggestions.ts
- useAfterFirstRender.ts
- useApiKeyVerification.ts
- useArrowKeyHistory.tsx
- useAssistantHistory.ts
- useAwaySummary.ts
- useBackgroundTaskNavigation.ts
- useBlink.ts
- useCanUseTool.tsx
- useCancelRequest.ts
- useChromeExtensionNotification.tsx
- usereferenceCodeHintRecommendation.tsx
- useClipboardImageHint.ts
- useCommandKeybindings.tsx
- useCommandQueue.ts
- useCopyOnSelect.ts
- useDeferredHookMessages.ts
- useDiffData.ts
- useDiffInIDE.ts
- useDirectConnect.ts
- useDoublePress.ts
- useDynamicConfig.ts
- useElapsedTime.ts
- useExitOnCtrlCD.ts
- useExitOnCtrlCDWithKeybindings.ts
- useFileHistorySnapshotInit.ts
- useGlobalKeybindings.tsx
- useHistorySearch.ts
- useIDEIntegration.tsx
- useIdeAtMentioned.ts
- useIdeConnectionStatus.ts
- useIdeLogging.ts
- useIdeSelection.ts
- useInboxPoller.ts
- useInputBuffer.ts
- useIssueFlagBanner.ts
- useLogMessages.ts
- useLspPluginRecommendation.tsx
- useMailboxBridge.ts
- useMainLoopModel.ts
- useManagePlugins.ts
- useMemoryUsage.ts
- useMergedClients.ts
- useMergedCommands.ts
- useMergedTools.ts
- useMinDisplayTime.ts
- useNotifyAfterTimeout.ts
- useOfficialMarketplaceNotification.tsx
- usePasteHandler.ts
- usePluginRecommendationBase.tsx
- usePrStatus.ts
- usePromptSuggestion.ts
- usePromptsFromReferenceInChrome.tsx
- useQueueProcessor.ts
- useRemoteSession.ts
- useReplBridge.tsx
- useSSHSession.ts
- useScheduledTasks.ts
- useSearchInput.ts
- useSessionBackgrounding.ts
- useSettings.ts
- useSettingsChange.ts
- useSkillImprovementSurvey.ts
- useSkillsChange.ts
- useSwarmInitialization.ts
- useSwarmPermissionPoller.ts
- useTaskListWatcher.ts
- useTasksV2.ts
- useTeammateViewAutoExit.ts
- useTeleportResume.tsx
- useTerminalSize.ts
- useTextInput.ts
- useTimeout.ts
- useTurnDiffs.ts
- useTypeahead.tsx
- useUpdateNotification.ts
- useVimInput.ts
- useVirtualScroll.ts
- useVoice.ts
- useVoiceEnabled.ts
- useVoiceIntegration.tsx

## components

Count: 144

- AgentProgressLine.tsx
- App.tsx
- ApproveApiKey.tsx
- AutoModeOptInDialog.tsx
- AutoUpdater.tsx
- AutoUpdaterWrapper.tsx
- AwsAuthStatusBox.tsx
- BaseTextInput.tsx
- BashModeProgress.tsx
- BridgeDialog.tsx
- BypassPermissionsModeDialog.tsx
- ChannelDowngradeDialog.tsx
- referenceCodeHint
- InChromeOnboarding.tsx
- AgentMdExternalIncludesDialog.tsx
- ClickableImageRef.tsx
- CompactSummary.tsx
- ConfigurableShortcutHint.tsx
- ConsoleOAuthFlow.tsx
- ContextSuggestions.tsx
- ContextVisualization.tsx
- CoordinatorAgentStatus.tsx
- CostThresholdDialog.tsx
- CtrlOToExpand.tsx
- CustomSelect
- DesktopHandoff.tsx
- DesktopUpsell
- DevBar.tsx
- DevChannelsDialog.tsx
- DiagnosticsDisplay.tsx
- EffortCallout.tsx
- EffortIndicator.ts
- ExitFlow.tsx
- ExportDialog.tsx
- FallbackToolUseErrorMessage.tsx
- FallbackToolUseRejectedMessage.tsx
- FastIcon.tsx
- Feedback.tsx
- FeedbackSurvey
- FileEditToolDiff.tsx
- FileEditToolUpdatedMessage.tsx
- FileEditToolUseRejectedMessage.tsx
- FilePathLink.tsx
- FullscreenLayout.tsx
- GlobalSearchDialog.tsx
- HelpV2
- HighlightedCode
- HighlightedCode.tsx
- HistorySearchDialog.tsx
- IdeAutoConnectDialog.tsx
- IdeOnboardingDialog.tsx
- IdeStatusIndicator.tsx
- IdleReturnDialog.tsx
- InterruptedByUser.tsx
- InvalidConfigDialog.tsx
- InvalidSettingsDialog.tsx
- KeybindingWarnings.tsx
- LanguagePicker.tsx
- LogSelector.tsx
- LogoV2
- LspRecommendation
- MCPServerApprovalDialog.tsx
- MCPServerDesktopImportDialog.tsx
- MCPServerDialogCopy.tsx
- MCPServerMultiselectDialog.tsx
- ManagedSettingsSecurityDialog
- Markdown.tsx
- MarkdownTable.tsx
- MemoryUsageIndicator.tsx
- Message.tsx
- MessageModel.tsx
- MessageResponse.tsx
- MessageRow.tsx
- MessageSelector.tsx
- MessageTimestamp.tsx
- Messages.tsx
- ModelPicker.tsx
- NativeAutoUpdater.tsx
- NotebookEditToolUseRejectedMessage.tsx
- OffscreenFreeze.tsx
- Onboarding.tsx
- OutputStylePicker.tsx
- PackageManagerAutoUpdater.tsx
- Passes
- PrBadge.tsx
- PressEnterToContinue.tsx
- PromptInput
- QuickOpenDialog.tsx
- RemoteCallout.tsx
- RemoteEnvironmentDialog.tsx
- ResumeTask.tsx
- SandboxViolationExpandedView.tsx
- ScrollKeybindingHandler.tsx
- SearchBox.tsx
- SentryErrorBoundary.ts
- SessionBackgroundHint.tsx
- SessionPreview.tsx
- Settings
- ShowInIDEPrompt.tsx
- SkillImprovementSurvey.tsx
- Spinner
- Spinner.tsx
- Stats.tsx
- StatusLine.tsx
- StatusNotices.tsx
- StructuredDiff
- StructuredDiff.tsx
- StructuredDiffList.tsx
- TagTabs.tsx
- TaskListV2.tsx
- TeammateViewHeader.tsx
- TeleportError.tsx
- TeleportProgress.tsx
- TeleportRepoMismatchDialog.tsx
- TeleportResumeWrapper.tsx
- TeleportStash.tsx
- TextInput.tsx
- ThemePicker.tsx
- ThinkingToggle.tsx
- TokenWarning.tsx
- ToolUseLoader.tsx
- TrustDialog
- ValidationErrorsList.tsx
- VimTextInput.tsx
- VirtualMessageList.tsx
- WorkflowMultiselectDialog.tsx
- WorktreeExitDialog.tsx
- agents
- design-system
- diff
- grove
- hooks
- mcp
- memory
- messageActions.tsx
- messages
- permissions
- sandbox
- shell
- skills
- tasks
- teams
- ui
- wizard

## screens

Count: 3

- Doctor.tsx
- REPL.tsx
- ResumeConversation.tsx

## keybindings

Count: 14

- KeybindingContext.tsx
- KeybindingProviderSetup.tsx
- defaultBindings.ts
- loadUserBindings.ts
- match.ts
- parser.ts
- reservedShortcuts.ts
- resolver.ts
- schema.ts
- shortcutFormat.ts
- template.ts
- useKeybinding.ts
- useShortcutDisplay.ts
- validate.ts

## migrations

Count: 11

- migrateAutoUpdatesToSettings.ts
- migrateBypassPermissionsAcceptedToSettings.ts
- migrateEnableAllProjectMcpServersToSettings.ts
- migrateFennecToOpus.ts
- migrateLegacyOpusToCurrent.ts
- migrateOpusToOpus1m.ts
- migrateReplBridgeEnabledToRemoteControlAtStartup.ts
- migrateSonnet1mToSonnet45.ts
- migrateSonnet45ToSonnet46.ts
- resetAutoModeOptInForDefaultOffer.ts
- resetProToOpusDefault.ts

## plugins

Count: 2

- builtinPlugins.ts
- bundled

## skills

Count: 4

- bundled
- bundledSkills.ts
- loadSkillsDir.ts
- mcpSkillBuilders.ts

## outputStyles

Count: 1

- loadOutputStylesDir.ts

## Top-level src files

- QueryEngine.ts
- Task.ts
- Tool.ts
- commands.ts
- context.ts
- cost-tracker.ts
- costHook.ts
- dialogLaunchers.tsx
- history.ts
- ink.ts
- interactiveHelpers.tsx
- main.tsx
- projectOnboardingState.ts
- query.ts
- replLauncher.tsx
- setup.ts
- tasks.ts
- tools.ts
